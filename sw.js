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

var VERSION = 'v1';
var SHELL_CACHE = 'stormscope-shell-' + VERSION;
var TILE_CACHE = 'stormscope-tiles-' + VERSION;
var DATA_CACHE = 'stormscope-data-' + VERSION;

var TILE_CACHE_LIMIT = 600; // ~radar frames + visible basemap tiles

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
      // Tolerate individual asset failures so install never wholly fails.
      return Promise.all(SHELL_ASSETS.map(function (url) {
        return cache.add(url).catch(function () { return null; });
      }));
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
        if (keep.indexOf(name) === -1) return caches.delete(name);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ── Helpers ──

function isTileRequest(url) {
  return url.hostname.indexOf('rainviewer.com') !== -1 && url.pathname.indexOf('.png') !== -1 ||
    url.hostname.indexOf('basemaps.cartocdn.com') !== -1;
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
}

// Cache-first for immutable-ish assets (tiles, shell).
function cacheFirst(request, cacheName, limit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        // Cache successful and opaque (cross-origin) responses.
        if (response && (response.ok || response.type === 'opaque')) {
          cache.put(request, response.clone());
          if (limit) trimCache(cacheName, limit);
        }
        return response;
      });
    });
  });
}

// Stale-while-revalidate for the camera dataset.
function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(function () { return cached; });
      return cached || network;
    });
  });
}

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
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // Same-origin app shell / assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
});
