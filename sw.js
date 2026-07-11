/* StormScope service worker — offline app shell + radar/tile/data caching.
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/vendor/icons): precached, cache-first.
 *   - Navigations: network-first, fall back to cached index.html when offline.
 *   - Radar tiles (RainViewer) + basemap tiles (CARTO): cache-first with a
 *     bounded LRU cache so repeat visits reuse already-fetched frames offline.
 *   - Camera dataset (data/cameras.json): stale-while-revalidate — instant load
 *     from cache, refreshed in the background.
 *   - Live weather/radar-index APIs (NWS, Open-Meteo, RainViewer maps.json):
 *     never cached; always fetched fresh (time-sensitive).
 */
'use strict';

var VERSION = 'v2';
var RUNTIME_CACHE_VERSION = 'v1';
var SHELL_CACHE = 'stormscope-shell-' + VERSION;
var TILE_CACHE = 'stormscope-tiles-' + RUNTIME_CACHE_VERSION;
var DATA_CACHE = 'stormscope-data-' + RUNTIME_CACHE_VERSION;

var TILE_CACHE_LIMIT = 600; // ~radar frames + visible basemap tiles
var CACHE_PREFIX = 'stormscope-';
var trimQueues = Object.create(null);

var SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './css/style.css',
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
  './assets/apple-touch-icon.png'
];

// ── Install: precache the app shell ──
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // The shell is an all-or-nothing offline contract. A missing required
      // asset must fail this install instead of activating a broken worker.
      return cache.addAll(SHELL_ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ── Activate: drop stale caches ──
self.addEventListener('activate', function (event) {
  var keep = [SHELL_CACHE, TILE_CACHE, DATA_CACHE];
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name.indexOf(CACHE_PREFIX) === 0 && keep.indexOf(name) === -1) {
          return caches.delete(name);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
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

function isLiveApiRequest(url) {
  return url.hostname === 'api.rainviewer.com' ||
    url.hostname === 'api.weather.gov' ||
    url.hostname === 'api.open-meteo.com';
}

function isCameraData(url) {
  return url.pathname.indexOf('data/cameras.json') !== -1;
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

function putInCache(cache, cacheName, request, response) {
  return cache.put(request, response).then(function () {
    return true;
  }).catch(function (error) {
    return notifyCacheError(cacheName, error).then(function () { return false; });
  });
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
  return caches.open(cacheName).then(function (cache) {
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
}

// Stale-while-revalidate for the camera dataset.
function staleWhileRevalidate(request, cacheName, event) {
  var revalidation;
  var response = caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      revalidation = fetch(request).then(function (networkResponse) {
        if (networkResponse && networkResponse.ok && networkResponse.type !== 'opaque') {
          return putInCache(cache, cacheName, request, networkResponse.clone()).then(function () {
            return networkResponse;
          });
        }
        return networkResponse;
      }).catch(function () { return cached; });
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

function stormScopeCacheNames() {
  return caches.keys().then(function (names) {
    return names.filter(function (name) { return name.indexOf(CACHE_PREFIX) === 0; });
  });
}

function stormScopeRuntimeCacheNames() {
  return caches.keys().then(function (names) {
    return names.filter(function (name) {
      return name.indexOf('stormscope-tiles-') === 0 || name.indexOf('stormscope-data-') === 0;
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
  // offline launch path. Shell generations are managed by activation.
  return stormScopeRuntimeCacheNames().then(function (names) {
    return Promise.all(names.map(function (name) { return caches.delete(name); })).then(function (results) {
      return {
        type: 'STORMSCOPE_CACHES_CLEARED',
        deleted: results.filter(function (deleted) { return deleted; }).length
      };
    });
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
  var operation;
  if (type === 'STORMSCOPE_GET_CACHE_USAGE') operation = inspectStormScopeCaches();
  if (type === 'STORMSCOPE_CLEAR_CACHES') operation = clearStormScopeCaches();
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
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // Navigations: network-first, offline fallback to cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('./index.html').then(function (cached) {
          return cached || caches.match('./');
        });
      })
    );
    return;
  }

  // Live, time-sensitive APIs: always network (no cache).
  if (isLiveApiRequest(url)) {
    return;
  }

  // Radar + basemap tiles: cache-first, bounded.
  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE, TILE_CACHE_LIMIT));
    return;
  }

  // Camera dataset: stale-while-revalidate.
  if (isCameraData(url)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE, event));
    return;
  }

  // Same-origin app shell / assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
});
