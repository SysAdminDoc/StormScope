/* StormScope service worker — offline app shell + radar/tile/data caching.
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/vendor/icons): precached, cache-first.
 *   - Navigations: network-first, fall back to cached index.html when offline.
 *   - Radar tiles (RainViewer) + basemap tiles (CARTO): cache-first with a
 *     bounded LRU cache so repeat visits reuse already-fetched frames offline.
 *   - Camera index/source health: network-first with last-known-good fallback;
 *     immutable generation shards are cache-first; the migration monolith is
 *     stale-while-revalidate.
 *   - RainViewer's small frame manifest: network-first with last-known-good
 *     fallback so already-cached radar tiles can initialize offline.
 *   - Live weather APIs (NWS, Open-Meteo): browser-network only, never cached.
 *   - Web Share Target GPX/GeoJSON files use a transient same-origin cache
 *     handoff into the existing bounded local-overlay importer; they are
 *     never uploaded or retained after consumption.
 *   - Other cross-origin context APIs fall through to the browser network and
 *     are likewise never persisted by this worker.
 */
'use strict';

var VERSION = 'v116';
var RUNTIME_CACHE_VERSION = 'v2';
var SHELL_CACHE = 'stormscope-shell-' + VERSION;
var TILE_CACHE = 'stormscope-tiles-' + RUNTIME_CACHE_VERSION;
var DATA_CACHE = 'stormscope-data-' + RUNTIME_CACHE_VERSION;
var SHARE_CACHE = 'stormscope-share-target-v1';

var TILE_CACHE_LIMIT = 600; // ~radar frames + visible basemap tiles
var CAMERA_INDEX_MAX_BYTES = 256 * 1024;
var CAMERA_SHARD_MAX_BYTES = 2 * 1024 * 1024;
var CAMERA_MONOLITH_MAX_BYTES = 32 * 1024 * 1024;
var CAMERA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
var CAMERA_GENERATION_STATE_PATH = '/__stormscope-camera-generations__';
var CAMERA_GENERATIONS_TO_KEEP = 2;
var SHARE_TARGET_PATH = '/share-target';
var SHARE_ARTIFACT_PREFIX = '/__stormscope-share-target__/';
var SHARE_ARTIFACT_MAX_ENTRIES = 2;
var SHARE_TARGET_MAX_BYTES = 5 * 1024 * 1024; // Must match local-overlays.js.
var CACHE_PREFIX = 'stormscope-';
var trimQueues = Object.create(null);
var runtimeWrites = [];
var runtimeClearing = false;
var runtimeCachingPaused = false;

var SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './css/style.css',
  './js/weather.js',
  './js/nws-alerts.js',
  './js/radar-build-config.js',
  './js/radar-providers.js',
  './js/i18n.js',
  './js/data-mode.js',
  './js/camera-record.js',
  './js/camera-store.js',
  './js/camera-quarantine.js',
  './js/layer-registry.js',
  './js/saved-state.js',
  './js/scene-codec.js',
  './js/multi-camera.js',
  './js/camera-feed.js',
  './js/map-comparison.js',
  './js/context-layers.js',
  './js/solar-terminator.js',
  './js/context-layer-controllers.js',
  './js/surface-observations.js',
  './js/tropical-cyclones.js',
  './js/flood-outlooks.js',
  './js/winter-outlooks.js',
  './js/river-gauges.js',
  './js/convective-outlooks.js',
  './js/fire-weather.js',
  './js/severe-watches.js',
  './js/spc-reports.js',
  './js/geocode.js',
  './js/local-overlays.js',
  './js/private-annotations.js',
  './js/earthquakes.js',
  './js/diagnostics.js',
  './js/spatial-query.js',
  './js/wake-lock.js',
  './js/situation-snapshot.js',
  './js/space-weather.js',
  './js/marine-buoys.js',
  './js/cpc-outlooks.js',
  './js/radar-motion.js',
  './js/radar-motion-worker.js',
  './js/radar-export.js',
  './js/radar-controller.js',
  './js/app.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/markercluster/MarkerCluster.css',
  './vendor/markercluster/MarkerCluster.Default.css',
  './vendor/markercluster/leaflet.markercluster.js',
  './vendor/hls/hls.min.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/apple-touch-icon.png',
  './assets/screenshot-wide.png',
  './assets/screenshot-narrow.png'
];

// ── Install: precache the app shell ──
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // The shell is an all-or-nothing offline contract. A missing required
      // asset must fail this install instead of activating a broken worker.
      return cache.addAll(SHELL_ASSETS);
    })
  );
});

// ── Activate: drop stale caches ──
self.addEventListener('activate', function (event) {
  var keep = [SHELL_CACHE, TILE_CACHE, DATA_CACHE, SHARE_CACHE];
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name.indexOf(CACHE_PREFIX) === 0 && keep.indexOf(name) === -1) {
          return caches.delete(name);
        }
        return null;
      }));
    }).then(function () {
      var preload = self.registration && self.registration.navigationPreload;
      var enablePreload = preload && typeof preload.enable === 'function'
        ? preload.enable().catch(function () { return null; })
        : Promise.resolve(null);
      return Promise.all([self.clients.claim(), enablePreload]);
    })
  );
});

// ── Helpers ──

function hostMatchesSuffix(hostname, suffix) {
  return hostname === suffix || hostname.slice(-(suffix.length + 1)) === '.' + suffix;
}

function isTileRequest(url) {
  var hostname = url.hostname.toLowerCase();
  return hostMatchesSuffix(hostname, 'rainviewer.com') && url.pathname.indexOf('.png') !== -1 ||
    hostMatchesSuffix(hostname, 'basemaps.cartocdn.com');
}

function isRadarManifest(url) {
  return url.hostname === 'api.rainviewer.com' && url.pathname === '/public/weather-maps.json';
}

function isLiveApiRequest(url) {
  return url.hostname === 'api.weather.gov' ||
    url.hostname === 'api.open-meteo.com';
}

function isCameraIndex(url) {
  return url.origin === self.location.origin && /\/data\/cameras\.index\.json$/.test(url.pathname);
}

function isCameraSourceHealth(url) {
  return url.origin === self.location.origin && /\/data\/source-health\.json$/.test(url.pathname);
}

function isCameraShard(url) {
  return url.origin === self.location.origin && /\/data\/camera-shards\/\d{4}\.json$/.test(url.pathname) &&
    /^[a-f0-9]{64}$/.test(url.searchParams.get('generation') || '');
}

function isCameraMonolith(url) {
  return url.origin === self.location.origin && /\/data\/cameras\.json$/.test(url.pathname);
}

function isShareTargetRequest(url) {
  return url.origin === self.location.origin && url.pathname === SHARE_TARGET_PATH;
}

function shareTargetTokenIsValid(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(token);
}

function shareTargetArtifactToken(url) {
  if (!url || url.origin !== self.location.origin || url.pathname.indexOf(SHARE_ARTIFACT_PREFIX) !== 0) return null;
  var token = url.pathname.slice(SHARE_ARTIFACT_PREFIX.length);
  return shareTargetTokenIsValid(token) ? token : null;
}

function shareTargetArtifactRequest(token) {
  return new Request(self.location.origin + SHARE_ARTIFACT_PREFIX + token, { method: 'GET' });
}

function shareTargetRedirect(request, reason, token) {
  var url = new URL('./index.html', request.url);
  if (reason) url.searchParams.set('share_target_error', reason);
  if (token) url.searchParams.set('share_target', token);
  var location = url.toString();
  return new Response('', {
    status: 303,
    headers: { 'cache-control': 'no-store', location: location }
  });
}

function shareTargetName(value) {
  var name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 100);
}

function shareTargetFormat(name, type) {
  var extension = String(name || '').toLowerCase().match(/\.(geojson|json|gpx)$/);
  if (!extension) return null;
  var mime = String(type || '').toLowerCase();
  var allowed = extension[1] === 'gpx'
    ? ['application/gpx+xml', 'application/xml', 'text/xml', 'application/octet-stream', '']
    : ['application/geo+json', 'application/json', 'text/json', 'application/octet-stream', ''];
  if (allowed.indexOf(mime) === -1) return null;
  return extension[1] === 'gpx' ? 'application/gpx+xml' : 'application/geo+json';
}

function shareTargetEncodedName(name) {
  try { return encodeURIComponent(name); } catch (error) { return ''; }
}

function trimShareTargetCache() {
  return caches.open(SHARE_CACHE).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= SHARE_ARTIFACT_MAX_ENTRIES) return null;
      return Promise.all(keys.slice(0, keys.length - SHARE_ARTIFACT_MAX_ENTRIES).map(function (key) {
        return cache.delete(key);
      }));
    });
  });
}

function handleShareTarget(request) {
  return request.formData().then(function (formData) {
    var file = formData && formData.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return shareTargetRedirect(request, 'missing');
    var size = Number(file.size);
    var name = shareTargetName(file.name);
    var mime = shareTargetFormat(name, file.type);
    if (!name || !mime) return shareTargetRedirect(request, 'unsupported');
    if (!Number.isFinite(size) || size < 1 || size > SHARE_TARGET_MAX_BYTES) {
      return shareTargetRedirect(request, 'size');
    }
    return file.arrayBuffer().then(function (buffer) {
      if (!buffer || buffer.byteLength < 1 || buffer.byteLength > SHARE_TARGET_MAX_BYTES) {
        return shareTargetRedirect(request, 'size');
      }
      var token = (self.crypto && typeof self.crypto.randomUUID === 'function')
        ? self.crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      var artifact = new URL(SHARE_ARTIFACT_PREFIX + token, request.url);
      var encodedName = shareTargetEncodedName(name);
      if (!encodedName) return shareTargetRedirect(request, 'read');
      return caches.open(SHARE_CACHE).then(function (cache) {
        return cache.put(artifact.toString(), new Response(buffer, {
          headers: {
            'cache-control': 'no-store',
            'content-type': mime,
            'x-stormscope-share-name': encodedName
          }
        })).then(trimShareTargetCache).then(function () {
          return shareTargetRedirect(request, null, token);
        });
      });
    });
  }).catch(function () {
    return shareTargetRedirect(request, 'read');
  });
}

function readShareTargetArtifact(request) {
  var token = shareTargetArtifactToken(new URL(request.url));
  if (!token) return Promise.resolve(new Response('Not found', { status: 404 }));
  return caches.open(SHARE_CACHE).then(function (cache) {
    return cache.match(shareTargetArtifactRequest(token)).then(function (response) {
      return response || new Response('Not found', { status: 404 });
    });
  });
}

function consumeShareTarget(token) {
  if (!shareTargetTokenIsValid(token)) {
    return Promise.resolve({ type: 'STORMSCOPE_SHARE_TARGET_ERROR', reason: 'invalid-token' });
  }
  return caches.open(SHARE_CACHE).then(function (cache) {
    return cache.delete(shareTargetArtifactRequest(token)).then(function (deleted) {
      return { type: 'STORMSCOPE_SHARE_TARGET_CONSUMED', token: token, deleted: deleted };
    });
  });
}

function isTransientHttpResponse(response) {
  return response && (response.status === 408 || response.status === 429 || response.status >= 500);
}

// Bound a cache to a max entry count (approximate LRU via insertion order).
function trimCache(cacheName, maxEntries) {
  var previous = trimQueues[cacheName] || Promise.resolve();
  var next = previous.catch(function () { return null; }).then(function () {
    return caches.open(cacheName).then(function (cache) {
      return cache.keys().then(function (keys) {
        if (keys.length <= maxEntries) return null;
        return Promise.all(
          keys.slice(0, keys.length - maxEntries).map(function (key) {
            return cache.delete(key);
          })
        );
      });
    });
  });

  trimQueues[cacheName] = next.then(function () { return null; }, function () { return null; });
  return next;
}

function isQuotaError(error) {
  return error && (error.name === 'QuotaExceededError' || error.code === 22 || error.code === 1014);
}

function notifyCacheError(cacheName, error) {
  if (!self.clients || !self.clients.matchAll) return Promise.resolve();
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) {
      client.postMessage({
        type: 'STORMSCOPE_CACHE_ERROR',
        cache: cacheName,
        reason: isQuotaError(error) ? 'quota-exceeded' : 'write-failed'
      });
    });
  }).catch(function () { return null; });
}

function requestUrl(request) {
  try { return new URL(typeof request === 'string' ? request : request.url, self.location.origin); } catch (_error) { return null; }
}

function runtimeResponseLimit(cacheName, request) {
  if (cacheName !== DATA_CACHE) return null;
  var url = requestUrl(request);
  if (!url) return 0;
  if (isCameraIndex(url) || isCameraSourceHealth(url) || isRadarManifest(url)) return CAMERA_INDEX_MAX_BYTES;
  if (isCameraShard(url)) return CAMERA_SHARD_MAX_BYTES;
  if (isCameraMonolith(url)) return CAMERA_MONOLITH_MAX_BYTES;
  return null;
}

function responseFitsRuntimeLimit(cacheName, request, response) {
  var limit = runtimeResponseLimit(cacheName, request);
  if (limit === null) return Promise.resolve(true);
  if (!limit) return Promise.resolve(false);
  return responseSize(response).then(function (size) { return size <= limit; });
}

function putInCache(cache, cacheName, request, response) {
  return responseFitsRuntimeLimit(cacheName, request, response).then(function (allowed) {
    if (!allowed) return false;
    return cache.put(request, response).then(function () {
      return true;
    }).catch(function (error) {
      return notifyCacheError(cacheName, error).then(function () { return false; });
    });
  });
}

function trackRuntimeWrite(promise) {
  runtimeWrites.push(promise);
  function remove() {
    var index = runtimeWrites.indexOf(promise);
    if (index !== -1) runtimeWrites.splice(index, 1);
  }
  promise.then(remove, remove);
  return promise;
}

function fetchTile(request) {
  // Leaflet image requests are commonly no-cors even when the tile provider
  // sends CORS headers. Upgrade the worker's network request where possible so
  // the response can be validated before caching. If CORS fails, return the
  // original opaque response to the page but deliberately do not cache it.
  if (request.mode === 'no-cors' && typeof Request !== 'undefined') {
    var corsRequest = new Request(request.url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      cache: request.cache
    });
    return fetch(corsRequest).catch(function () { return fetch(request); });
  }
  return fetch(request);
}

// Cache-first for immutable-ish assets (tiles, shell).
function cacheFirst(request, cacheName, limit) {
  if ((cacheName === TILE_CACHE || cacheName === DATA_CACHE) &&
      (runtimeClearing || runtimeCachingPaused)) {
    return cacheName === TILE_CACHE ? fetchTile(request) : fetch(request);
  }
  var operation = caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      var network = cacheName === TILE_CACHE ? fetchTile(request) : fetch(request);
      return network.then(function (response) {
        // Opaque responses cannot be validated and may be charged against
        // storage quota at a much larger padding size, so never persist them.
        if (response && response.ok && response.type !== 'opaque') {
          return putInCache(cache, cacheName, request, response.clone()).then(function (stored) {
            if (stored && limit) return trimCache(cacheName, limit);
            return null;
          }).then(function () { return response; });
        }
        return response;
      });
    });
  });
  return cacheName === TILE_CACHE || cacheName === DATA_CACHE ? trackRuntimeWrite(operation) : operation;
}

// Stale-while-revalidate for the camera dataset.
function staleWhileRevalidate(request, cacheName, event) {
  if (cacheName === DATA_CACHE && (runtimeClearing || runtimeCachingPaused)) return fetch(request);
  var revalidation;
  var response = caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      revalidation = trackRuntimeWrite(fetch(request).then(function (networkResponse) {
        if (networkResponse && networkResponse.ok && networkResponse.type !== 'opaque') {
          return putInCache(cache, cacheName, request, networkResponse.clone()).then(function () {
            return networkResponse;
          });
        }
        return networkResponse;
      }).catch(function () { return cached; }));
      return cached || revalidation;
    });
  });

  // Register the lifetime promise synchronously while the fetch event is still
  // active. The chained promise adopts revalidation after the cache lookup.
  if (event && event.waitUntil) {
    event.waitUntil(response.then(function () { return revalidation; }));
  }
  return response;
}

function networkFirstWithCache(request, cacheName) {
  if (cacheName === DATA_CACHE && (runtimeClearing || runtimeCachingPaused)) return fetch(request);
  var operation = caches.open(cacheName).then(function (cache) {
    return fetch(request).then(function (response) {
      if (isTransientHttpResponse(response)) {
        return cache.match(request).then(function (cached) { return cached || response; });
      }
      if (!response || !response.ok || response.type === 'opaque') return response;
      return putInCache(cache, cacheName, request, response.clone()).then(function () { return response; });
    }).catch(function (error) {
      return cache.match(request).then(function (cached) {
        if (cached) return cached;
        throw error;
      });
    });
  });
  return cacheName === DATA_CACHE ? trackRuntimeWrite(operation) : operation;
}

function cachedShellFallback() {
  return caches.match('./index.html').then(function (cached) {
    return cached || caches.match('./');
  });
}

function navigationNetworkFirst(request, preloadResponse) {
  var network = preloadResponse ? Promise.resolve(preloadResponse).then(function (response) {
    return response || fetch(request);
  }, function () {
    return fetch(request);
  }) : fetch(request);
  return network.then(function (response) {
    if (!isTransientHttpResponse(response)) return response;
    return cachedShellFallback().then(function (cached) { return cached || response; });
  }).catch(function (error) {
    return cachedShellFallback().then(function (cached) {
      if (cached) return cached;
      throw error;
    });
  });
}

function stormScopeCacheNames() {
  return caches.keys().then(function (names) {
    return names.filter(function (name) { return name.indexOf(CACHE_PREFIX) === 0; });
  });
}

function stormScopeRuntimeCacheNames() {
  return caches.keys().then(function (names) {
    return names.filter(function (name) {
      return name.indexOf('stormscope-tiles-') === 0 || name.indexOf('stormscope-data-') === 0 || name === SHARE_CACHE;
    });
  });
}

function responseSize(response) {
  var header = response.headers && response.headers.get('content-length');
  var parsed = header ? Number(header) : NaN;
  if (isFinite(parsed) && parsed >= 0) return Promise.resolve(parsed);
  if (!response.clone || !response.blob) return Promise.resolve(0);
  return response.clone().blob().then(function (blob) { return blob.size || 0; }).catch(function () {
    return 0;
  });
}

function cameraGenerationStateRequest() {
  return new Request(self.location.origin + CAMERA_GENERATION_STATE_PATH, {
    method: 'GET', credentials: 'same-origin'
  });
}

function readCompletedCameraGenerations(cache) {
  return cache.match(cameraGenerationStateRequest()).then(function (response) {
    if (!response || typeof response.json !== 'function') return [];
    return response.json().catch(function () { return []; });
  }).then(function (state) {
    var values = state && state.schemaVersion === 1 && Array.isArray(state.completed) ? state.completed : state;
    if (!Array.isArray(values)) return [];
    return values.filter(function (value, index, items) {
      return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && items.indexOf(value) === index;
    }).slice(-CAMERA_GENERATIONS_TO_KEEP);
  });
}

function writeCompletedCameraGenerations(cache, completed) {
  var body = JSON.stringify({ schemaVersion: 1, completed: completed });
  var response = new Response(body, {
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) }
  });
  return putInCache(cache, DATA_CACHE, cameraGenerationStateRequest(), response).then(function () { return completed; });
}

function generationFromCacheKey(key) {
  var url = requestUrl(key);
  return url && isCameraShard(url) ? url.searchParams.get('generation') : null;
}

function cameraMetadataEntries(cache) {
  return cache.keys().then(function (keys) {
    var cameraKeys = keys.filter(function (key) {
      var url = requestUrl(key);
      return url && (isCameraIndex(url) || isCameraSourceHealth(url) || isCameraShard(url) || isCameraMonolith(url));
    });
    return Promise.all(cameraKeys.map(function (key) {
      return cache.match(key).then(function (response) {
        if (!response) return { key: key, url: requestUrl(key), generation: generationFromCacheKey(key), bytes: 0 };
        return responseSize(response).then(function (bytes) {
          return { key: key, url: requestUrl(key), generation: generationFromCacheKey(key), bytes: bytes };
        });
      });
    }));
  });
}

function deleteCacheEntries(cache, entries) {
  return Promise.all(entries.map(function (entry) { return cache.delete(entry.key || entry); }));
}

function enforceCameraMetadataBudget(cache, completed) {
  return cameraMetadataEntries(cache).then(function (entries) {
    var retained = completed.slice();
    var total = entries.reduce(function (sum, entry) { return sum + entry.bytes; }, 0);
    var deletions = [];
    function removeWhere(predicate) {
      entries.forEach(function (entry) {
        if (deletions.indexOf(entry) !== -1 || !predicate(entry)) return;
        deletions.push(entry);
        total -= entry.bytes;
      });
    }
    for (var index = 0; total > CAMERA_CACHE_MAX_BYTES && index < retained.length - 1; index += 1) {
      var previous = retained[index];
      removeWhere(function (entry) { return entry.generation === previous; });
      retained[index] = null;
    }
    if (total > CAMERA_CACHE_MAX_BYTES) {
      removeWhere(function (entry) { return entry.url && isCameraMonolith(entry.url); });
    }
    if (total > CAMERA_CACHE_MAX_BYTES && retained.length) {
      var current = retained[retained.length - 1];
      removeWhere(function (entry) { return entry.generation === current; });
      retained[retained.length - 1] = null;
    }
    retained = retained.filter(Boolean);
    return deleteCacheEntries(cache, deletions).then(function () {
      return { completed: retained, bytes: Math.max(0, total), deleted: deletions.length };
    });
  });
}

var cameraGenerationQueue = Promise.resolve();

function rememberCompleteCameraGeneration(generation) {
  var operation = cameraGenerationQueue.catch(function () { return null; }).then(function () {
    if (runtimeClearing || runtimeCachingPaused) {
      return { type: 'STORMSCOPE_CAMERA_GENERATION_RETAINED', generation: generation, retained: [], bytes: 0, skipped: true };
    }
    return caches.open(DATA_CACHE).then(function (cache) {
      return readCompletedCameraGenerations(cache).then(function (completed) {
        completed = completed.filter(function (value) { return value !== generation; });
        completed.push(generation);
        completed = completed.slice(-CAMERA_GENERATIONS_TO_KEEP);
        return cache.keys().then(function (keys) {
          var keep = new Set(completed);
          var stale = keys.filter(function (key) {
            var cachedGeneration = generationFromCacheKey(key);
            return cachedGeneration && !keep.has(cachedGeneration);
          });
          return deleteCacheEntries(cache, stale);
        }).then(function () {
          return enforceCameraMetadataBudget(cache, completed);
        }).then(function (result) {
          return writeCompletedCameraGenerations(cache, result.completed).then(function () {
            return {
              type: 'STORMSCOPE_CAMERA_GENERATION_RETAINED',
              generation: generation,
              retained: result.completed,
              bytes: result.bytes,
              deleted: result.deleted
            };
          });
        });
      });
    });
  });
  cameraGenerationQueue = operation.then(function () { return null; }, function () { return null; });
  return trackRuntimeWrite(operation);
}

function inspectStormScopeCaches() {
  return stormScopeCacheNames().then(function (names) {
    return Promise.all(names.map(function (name) {
      return caches.open(name).then(function (cache) {
        return cache.keys().then(function (keys) {
          return Promise.all(keys.map(function (key) {
            return cache.match(key).then(function (response) {
              return response ? responseSize(response) : 0;
            });
          })).then(function (sizes) {
            return {
              name: name,
              entries: keys.length,
              bytes: sizes.reduce(function (total, size) { return total + size; }, 0)
            };
          });
        });
      });
    })).then(function (details) {
      var result = {
        type: 'STORMSCOPE_CACHE_USAGE',
        caches: details,
        entries: details.reduce(function (total, item) { return total + item.entries; }, 0),
        bytes: details.reduce(function (total, item) { return total + item.bytes; }, 0)
      };
      if (!self.navigator || !self.navigator.storage || !self.navigator.storage.estimate) return result;
      return self.navigator.storage.estimate().then(function (estimate) {
        result.originUsage = estimate.usage;
        result.originQuota = estimate.quota;
        return result;
      }).catch(function () { return result; });
    });
  });
}

function clearStormScopeCaches() {
  // Preserve the active shell so clearing runtime data never destroys the
  // offline launch path. Wait for already-started revalidations so a late
  // camera response cannot recreate a data cache immediately after clearing.
  runtimeClearing = true;
  runtimeCachingPaused = true;
  function drainWrites() {
    var pendingWrites = runtimeWrites.slice();
    if (!pendingWrites.length) return Promise.resolve();
    return Promise.all(pendingWrites.map(function (promise) {
      return promise.catch(function () { return null; });
    })).then(drainWrites);
  }
  var operation = drainWrites().then(stormScopeRuntimeCacheNames).then(function (names) {
    return Promise.all(names.map(function (name) { return caches.delete(name); })).then(function (results) {
      return {
        type: 'STORMSCOPE_CACHES_CLEARED',
        deleted: results.filter(function (deleted) { return deleted; }).length
      };
    });
  });
  return operation.then(function (result) {
    runtimeClearing = false;
    return result;
  }, function (error) {
    runtimeClearing = false;
    throw error;
  });
}

function replyToMessage(event, message) {
  if (event.ports && event.ports[0]) {
    event.ports[0].postMessage(message);
  } else if (event.source && event.source.postMessage) {
    event.source.postMessage(message);
  }
}

self.addEventListener('message', function (event) {
  var type = event.data && event.data.type;
  if (type === 'STORMSCOPE_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  var operation;
  if (type === 'STORMSCOPE_GET_CACHE_USAGE') operation = inspectStormScopeCaches();
  if (type === 'STORMSCOPE_CLEAR_CACHES') operation = clearStormScopeCaches();
  if (type === 'STORMSCOPE_CAMERA_GENERATION_COMPLETE') {
    var generation = event.data && event.data.generation;
    if (typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation)) {
      operation = Promise.resolve({ type: 'STORMSCOPE_CACHE_ERROR', reason: 'invalid-generation' });
    } else {
      operation = rememberCompleteCameraGeneration(generation);
    }
  }
  if (type === 'STORMSCOPE_CONSUME_SHARE_TARGET') {
    operation = consumeShareTarget(event.data && event.data.token);
  }
  if (!operation) return;

  event.waitUntil(operation.then(function (message) {
    replyToMessage(event, message);
  }).catch(function (error) {
    replyToMessage(event, {
      type: 'STORMSCOPE_CACHE_ERROR',
      reason: isQuotaError(error) ? 'quota-exceeded' : 'operation-failed'
    });
  }));
});

// ── Fetch routing ──
self.addEventListener('fetch', function (event) {
  var request = event.request;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  if (request.method === 'POST' && isShareTargetRequest(url)) {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (shareTargetArtifactToken(url)) {
    event.respondWith(readShareTargetArtifact(request));
    return;
  }

  // Navigations: network-first, offline fallback to cached shell.
  if (request.mode === 'navigate') {
    runtimeCachingPaused = false;
    event.respondWith(navigationNetworkFirst(request, event.preloadResponse));
    return;
  }

  // The radar frame manifest can fall back to its last-known-good copy so a
  // cold offline launch can reuse bounded radar tiles already in TILE_CACHE.
  if (isRadarManifest(url)) {
    event.respondWith(networkFirstWithCache(request, DATA_CACHE));
    return;
  }

  // Live, time-sensitive weather APIs: always network (no cache).
  if (isLiveApiRequest(url)) {
    return;
  }

  // Radar + basemap tiles: cache-first, bounded.
  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE, TILE_CACHE_LIMIT));
    return;
  }

  // Camera metadata is current-first with a last-known-good offline fallback.
  if (isCameraIndex(url) || isCameraSourceHealth(url)) {
    event.respondWith(networkFirstWithCache(request, DATA_CACHE));
    return;
  }
  if (isCameraShard(url)) {
    event.respondWith(cacheFirst(request, DATA_CACHE));
    return;
  }
  if (isCameraMonolith(url)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE, event));
    return;
  }

  // Same-origin app shell / assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
});
