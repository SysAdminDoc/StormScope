'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const workerVersion = workerSource.match(/var VERSION = '([^']+)'/)[1];
const runtimeCacheVersion = workerSource.match(/var RUNTIME_CACHE_VERSION = '([^']+)'/)[1];
const shellCache = 'stormscope-shell-' + workerVersion;
const tileCache = 'stormscope-tiles-' + runtimeCacheVersion;
const dataCache = 'stormscope-data-' + runtimeCacheVersion;
const shareCache = 'stormscope-share-target-v1';

function response(options) {
  const config = Object.assign({ ok: true, type: 'basic', size: 0, status: 200 }, options);
  return {
    ok: config.ok,
    status: config.status,
    type: config.type,
    headers: { get: () => config.contentLength == null ? null : String(config.contentLength) },
    clone() { return this; },
    blob() { return Promise.resolve({ size: config.size }); }
  };
}

function request(url, mode) {
  return { url, mode: mode || 'cors', method: 'GET', cache: 'default' };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function memoryCache(initialEntries) {
  const entries = new Map(initialEntries || []);
  const key = value => typeof value === 'string' ? value : value.url;
  return {
    entries,
    add(value, cachedResponse) { entries.set(key(value), cachedResponse); },
    match(value) {
      const cached = entries.get(key(value));
      return Promise.resolve(cached && typeof cached.clone === 'function' ? cached.clone() : cached);
    },
    put(value, cachedResponse) {
      entries.set(key(value), cachedResponse && typeof cachedResponse.clone === 'function'
        ? cachedResponse.clone() : cachedResponse);
      return Promise.resolve();
    },
    keys() { return Promise.resolve(Array.from(entries.keys()).map(url => request(url))); },
    delete(value) { return Promise.resolve(entries.delete(key(value))); }
  };
}

function loadWorker(options) {
  const settings = options || {};
  const handlers = {};
  const deleted = [];
  const cacheNames = settings.cacheNames || [];
  const defaultCache = {
    addAll: () => Promise.resolve(),
    match: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true)
  };
  const cacheStorage = {
    open(name) {
      return Promise.resolve((settings.cachesByName && settings.cachesByName[name]) || defaultCache);
    },
    keys() { return Promise.resolve(cacheNames.slice()); },
    delete(name) {
      deleted.push(name);
      return Promise.resolve(true);
    },
    match: settings.cacheMatch || (() => Promise.resolve(undefined))
  };
  class TestRequest {
    constructor(url, init) {
      this.url = url;
      Object.assign(this, init);
    }
  }
  const clientMessages = [];
  const sandbox = {
    URL,
    Request: settings.Request || TestRequest,
    Response: settings.Response || Response,
    Promise,
    Object,
    Number,
    isFinite,
    console,
    caches: cacheStorage,
    fetch: settings.fetch || (() => Promise.reject(new Error('Unexpected fetch'))),
    self: {
      location: { origin: 'https://example.test' },
      navigator: settings.navigator || {},
      registration: settings.registration || {},
      addEventListener(type, handler) { handlers[type] = handler; },
      skipWaiting: settings.skipWaiting || (() => Promise.resolve()),
      clients: {
        claim: settings.claim || (() => Promise.resolve()),
        matchAll: () => Promise.resolve([{ postMessage(message) { clientMessages.push(message); } }])
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(workerSource, sandbox, { filename: 'sw.js' });
  return { context: sandbox, handlers, deleted, clientMessages };
}

test('activation deletes only stale StormScope caches', async () => {
  let preloadEnabled = 0;
  const worker = loadWorker({
    cacheNames: [
      'stormscope-shell-v0',
      shellCache,
      tileCache,
      dataCache,
      'another-app-cache'
    ],
    registration: { navigationPreload: { enable() { preloadEnabled += 1; return Promise.resolve(); } } }
  });
  let lifetime;
  worker.handlers.activate({ waitUntil(promise) { lifetime = promise; } });
  await lifetime;
  assert.deepEqual(worker.deleted, ['stormscope-shell-v0']);
  assert.equal(preloadEnabled, 1);
});

test('activation tolerates unavailable or rejected navigation preload', async () => {
  for (const registration of [{}, { navigationPreload: { enable: () => Promise.reject(new Error('unsupported')) } }]) {
    const worker = loadWorker({ registration });
    let lifetime;
    worker.handlers.activate({ waitUntil(promise) { lifetime = promise; } });
    await lifetime;
  }
});

test('share target stores a bounded local artifact, redirects into the app, and consumes it once', async () => {
  const gpx = '<?xml version="1.0"?><gpx version="1.1"></gpx>';
  const bytes = new TextEncoder().encode(gpx).buffer;
  const cache = memoryCache();
  let networkCalls = 0;
  const worker = loadWorker({
    cachesByName: { [shareCache]: cache },
    fetch: () => { networkCalls += 1; return Promise.reject(new Error('share target must not upload')); }
  });
  const file = {
    name: 'route plan.gpx', type: 'application/gpx+xml', size: bytes.byteLength,
    arrayBuffer: () => Promise.resolve(bytes)
  };
  const postRequest = {
    url: 'https://example.test/share-target', method: 'POST',
    formData: () => Promise.resolve({ get: name => name === 'file' ? file : null })
  };
  let routed;
  worker.handlers.fetch({ request: postRequest, respondWith(promise) { routed = promise; } });
  const redirect = await routed;
  assert.equal(redirect.status, 303);
  assert.equal(networkCalls, 0);
  const redirectUrl = new URL(redirect.headers.get('location'));
  const token = redirectUrl.searchParams.get('share_target');
  assert.match(token, /^[A-Za-z0-9_-]{8,80}$/);
  assert.equal(cache.entries.size, 1);

  let artifactResponse;
  worker.handlers.fetch({
    request: { url: `https://example.test/__stormscope-share-target__/${token}`, method: 'GET' },
    respondWith(promise) { artifactResponse = promise; }
  });
  const artifact = await artifactResponse;
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), gpx);
  assert.equal(artifact.headers.get('x-stormscope-share-name'), encodeURIComponent('route plan.gpx'));

  let consumed;
  worker.handlers.message({
    data: { type: 'STORMSCOPE_CONSUME_SHARE_TARGET', token },
    waitUntil(promise) { consumed = promise; }
  });
  await consumed;
  assert.equal(cache.entries.size, 0);
});

test('share target rejects unsupported files, oversized files, and malformed form data without network fallback', async () => {
  let networkCalls = 0;
  const cache = memoryCache();
  const worker = loadWorker({
    cachesByName: { [shareCache]: cache },
    fetch: () => { networkCalls += 1; return Promise.reject(new Error('share target must not upload')); }
  });
  const cases = [
    { name: 'notes.txt', type: 'text/plain', size: 4, bytes: 'text', reason: 'unsupported' },
    { name: 'huge.geojson', type: 'application/geo+json', size: 5 * 1024 * 1024 + 1, bytes: '{}', reason: 'size' },
    { name: null, type: '', size: 0, bytes: '', reason: 'missing' }
  ];
  for (const item of cases) {
    const bytes = new TextEncoder().encode(item.bytes).buffer;
    const file = item.name == null ? null : {
      name: item.name, type: item.type, size: item.size,
      arrayBuffer: () => Promise.resolve(bytes)
    };
    let routed;
    worker.handlers.fetch({
      request: {
        url: 'https://example.test/share-target', method: 'POST',
        formData: () => Promise.resolve({ get: name => name === 'file' ? file : null })
      },
      respondWith(promise) { routed = promise; }
    });
    const redirect = await routed;
    assert.equal(redirect.status, 303);
    assert.equal(new URL(redirect.headers.get('location')).searchParams.get('share_target_error'), item.reason);
  }
  assert.equal(cache.entries.size, 0);
  assert.equal(networkCalls, 0);
});

test('tile caching rejects lookalike provider hosts', () => {
  const worker = loadWorker();
  assert.equal(worker.context.isTileRequest(new URL('https://tilecache.rainviewer.com/a.png')), true);
  assert.equal(worker.context.isTileRequest(new URL('https://a.basemaps.cartocdn.com/tile.png')), true);
  assert.equal(worker.context.isTileRequest(new URL('https://rainviewer.com.attacker.example/a.png')), false);
  assert.equal(worker.context.isTileRequest(new URL('https://basemaps.cartocdn.com.attacker.example/tile.png')), false);
});

test('shell upgrade retains stable offline tile and camera data caches', async () => {
  const previousShell = 'stormscope-shell-previous';
  const worker = loadWorker({
    cacheNames: [previousShell, shellCache, tileCache, dataCache]
  });
  let lifetime;
  worker.handlers.activate({ waitUntil(promise) { lifetime = promise; } });
  await lifetime;
  assert.deepEqual(worker.deleted, [previousShell]);
});

test('install fails when a required shell asset cannot be cached', async () => {
  const missing = new Error('missing shell asset');
  let skipped = false;
  const worker = loadWorker({
    cachesByName: {
      [shellCache]: {
        addAll() { return Promise.reject(missing); }
      }
    },
    skipWaiting() {
      skipped = true;
      return Promise.resolve();
    }
  });
  let lifetime;
  worker.handlers.install({ waitUntil(promise) { lifetime = promise; } });
  await assert.rejects(lifetime, missing);
  assert.equal(skipped, false);
});

test('successful update install waits for explicit activation', async () => {
  let skipped = false;
  const worker = loadWorker({
    skipWaiting() {
      skipped = true;
      return Promise.resolve();
    }
  });
  let lifetime;
  worker.handlers.install({ waitUntil(promise) { lifetime = promise; } });
  await lifetime;
  assert.equal(skipped, false);

  worker.handlers.message({
    data: { type: 'STORMSCOPE_SKIP_WAITING' },
    waitUntil(promise) { lifetime = promise; }
  });
  await lifetime;
  assert.equal(skipped, true);
});

test('cache-first waits for its write and bounded trim', async () => {
  const write = deferred();
  let deleteCount = 0;
  const cache = {
    match: () => Promise.resolve(undefined),
    put: () => write.promise,
    keys: () => Promise.resolve(Array.from({ length: 601 }, (_, index) => 'tile-' + index)),
    delete: () => {
      deleteCount += 1;
      return Promise.resolve(true);
    }
  };
  const networkResponse = response();
  const worker = loadWorker({
    cachesByName: { [tileCache]: cache },
    fetch: () => Promise.resolve(networkResponse)
  });
  let settled = false;
  const result = worker.context.cacheFirst(
    request('https://basemaps.cartocdn.com/dark_all/1/2/3.png'),
    tileCache,
    600
  ).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  write.resolve();
  assert.equal(await result, networkResponse);
  assert.equal(deleteCount, 1);
});

test('concurrent trims for one cache are serialized', async () => {
  let active = 0;
  let maxActive = 0;
  const cache = {
    keys() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => setImmediate(() => {
        active -= 1;
        resolve([]);
      }));
    }
  };
  const worker = loadWorker({ cachesByName: { [tileCache]: cache } });
  await Promise.all([
    worker.context.trimCache(tileCache, 600),
    worker.context.trimCache(tileCache, 600),
    worker.context.trimCache(tileCache, 600)
  ]);
  assert.equal(maxActive, 1);
});

test('cached camera response keeps revalidation alive until cache put completes', async () => {
  const cached = response({ size: 1 });
  const fresh = response({ size: 2 });
  const write = deferred();
  const cache = {
    match: () => Promise.resolve(cached),
    put: () => write.promise
  };
  const worker = loadWorker({
    cachesByName: { [dataCache]: cache },
    fetch: () => Promise.resolve(fresh)
  });
  let background;
  const resultPromise = worker.context.staleWhileRevalidate(
    request('https://example.test/data/cameras.json'),
    dataCache,
    { waitUntil(promise) { background = promise; } }
  );
  assert.ok(background, 'waitUntil must be registered synchronously');
  const result = await resultPromise;
  assert.equal(result, cached);
  let settled = false;
  background.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  write.resolve();
  assert.equal(await background, fresh);
});

test('generation-keyed camera shards are immutable cache-first entries', async () => {
  const cached = response({ size: 2 });
  let networkCalls = 0;
  const worker = loadWorker({
    cachesByName: {
      [dataCache]: { match: () => Promise.resolve(cached) }
    },
    fetch: () => {
      networkCalls += 1;
      return Promise.reject(new Error('generation shard must not revalidate'));
    }
  });
  const shardUrl = 'https://example.test/data/camera-shards/0001.json?generation=' + 'a'.repeat(64);

  assert.equal(worker.context.isCameraShard(new URL(shardUrl)), true);
  assert.equal(await worker.context.cacheFirst(request(shardUrl), dataCache), cached);
  assert.equal(networkCalls, 0);
});

test('oversized camera artifacts are returned but never persisted', async () => {
  let puts = 0;
  const cache = {
    match: () => Promise.resolve(undefined),
    put: () => { puts += 1; return Promise.resolve(); }
  };
  const oversizedShard = response({
    size: 2 * 1024 * 1024 + 1,
    contentLength: 2 * 1024 * 1024 + 1
  });
  const worker = loadWorker({
    cachesByName: { [dataCache]: cache },
    fetch: () => Promise.resolve(oversizedShard)
  });
  const shardRequest = request('https://example.test/data/camera-shards/0001.json?generation=' + 'a'.repeat(64));
  assert.equal(await worker.context.cacheFirst(shardRequest, dataCache), oversizedShard);
  assert.equal(puts, 0);
  assert.equal(worker.context.runtimeResponseLimit(dataCache, shardRequest), 2 * 1024 * 1024);
  assert.equal(worker.context.runtimeResponseLimit(dataCache,
    request('https://example.test/data/cameras.index.json')), 256 * 1024);
  assert.equal(worker.context.runtimeResponseLimit(dataCache,
    request('https://example.test/data/cameras.json')), 32 * 1024 * 1024);
});

test('camera index is distinct from immutable shards and monolith recovery', () => {
  const worker = loadWorker();
  assert.equal(worker.context.isCameraIndex(new URL('https://example.test/data/cameras.index.json')), true);
  assert.equal(worker.context.isCameraSourceHealth(new URL('https://example.test/data/source-health.json')), true);
  assert.equal(worker.context.isCameraMonolith(new URL('https://example.test/data/cameras.json')), true);
  assert.equal(worker.context.isCameraShard(new URL('https://example.test/data/camera-shards/0001.json')), false);
});

test('completed-generation signals retain only current and previous while incomplete shards remain untouched', async () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const c = 'c'.repeat(64);
  const shard = generation => `https://example.test/data/camera-shards/0001.json?generation=${generation}`;
  const cache = memoryCache([[shard(a), response({ size: 10, contentLength: 10 })]]);
  const worker = loadWorker({ cachesByName: { [dataCache]: cache } });

  await worker.context.rememberCompleteCameraGeneration(a);
  cache.add(shard(b), response({ size: 10, contentLength: 10 }));
  await worker.context.rememberCompleteCameraGeneration(b);
  cache.add(shard(c), response({ size: 10, contentLength: 10 }));
  assert.ok(cache.entries.has(shard(a)) && cache.entries.has(shard(b)) && cache.entries.has(shard(c)),
    'an incomplete generation must not trigger pruning');

  const result = await worker.context.rememberCompleteCameraGeneration(c);
  assert.deepEqual(Array.from(result.retained), [b, c]);
  assert.equal(cache.entries.has(shard(a)), false);
  assert.equal(cache.entries.has(shard(b)), true);
  assert.equal(cache.entries.has(shard(c)), true);
  const stateResponse = await cache.match('https://example.test/__stormscope-camera-generations__');
  assert.deepEqual((await stateResponse.json()).completed, [b, c]);
});

test('camera metadata budget evicts the previous generation before the current generation or monolith', async () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const shard = generation => `https://example.test/data/camera-shards/0001.json?generation=${generation}`;
  const cache = memoryCache([
    ['https://example.test/data/cameras.json', response({ size: 32 * 1024 * 1024, contentLength: 32 * 1024 * 1024 })],
    [shard(a), response({ size: 20 * 1024 * 1024, contentLength: 20 * 1024 * 1024 })]
  ]);
  const worker = loadWorker({ cachesByName: { [dataCache]: cache } });
  await worker.context.rememberCompleteCameraGeneration(a);
  cache.add(shard(b), response({ size: 20 * 1024 * 1024, contentLength: 20 * 1024 * 1024 }));
  const result = await worker.context.rememberCompleteCameraGeneration(b);

  assert.ok(result.bytes <= 64 * 1024 * 1024);
  assert.deepEqual(Array.from(result.retained), [b]);
  assert.equal(cache.entries.has(shard(a)), false);
  assert.equal(cache.entries.has(shard(b)), true);
  assert.equal(cache.entries.has('https://example.test/data/cameras.json'), true);
});

test('manual cache clear drains an in-flight generation prune before deleting runtime storage', async () => {
  const gate = deferred();
  let keyReads = 0;
  const cache = memoryCache();
  cache.keys = () => {
    keyReads += 1;
    return keyReads === 1 ? gate.promise : Promise.resolve([]);
  };
  const worker = loadWorker({
    cacheNames: [dataCache],
    cachesByName: { [dataCache]: cache }
  });
  const remembering = worker.context.rememberCompleteCameraGeneration('a'.repeat(64));
  await new Promise(resolve => setImmediate(resolve));
  const clearing = worker.context.clearStormScopeCaches();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(worker.deleted, []);
  gate.resolve([]);
  await remembering;
  await clearing;
  assert.deepEqual(worker.deleted, [dataCache]);
  assert.equal(worker.context.runtimeCachingPaused, true);
});

test('clearing runtime caches waits for camera revalidation writes', async () => {
  const cached = response({ size: 1 });
  const fresh = response({ size: 2 });
  const write = deferred();
  const worker = loadWorker({
    cacheNames: [shellCache, dataCache],
    cachesByName: {
      [dataCache]: { match: () => Promise.resolve(cached), put: () => write.promise }
    },
    fetch: () => Promise.resolve(fresh)
  });
  const result = await worker.context.staleWhileRevalidate(
    request('https://example.test/data/camera-shards/0001.json'),
    dataCache,
    { waitUntil() {} }
  );
  assert.equal(result, cached);
  const clearing = worker.context.clearStormScopeCaches();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(worker.deleted, []);
  write.resolve();
  await clearing;
  assert.deepEqual(worker.deleted, [dataCache]);
  assert.equal(worker.context.runtimeCachingPaused, true);
});

test('radar manifest uses last-known-good cache when offline', async () => {
  const cached = response({ size: 2 });
  const cache = {
    match: () => Promise.resolve(cached),
    put: () => Promise.resolve()
  };
  const worker = loadWorker({
    cachesByName: { [dataCache]: cache },
    fetch: () => Promise.reject(new Error('offline'))
  });
  const manifestRequest = request('https://api.rainviewer.com/public/weather-maps.json');
  assert.equal(await worker.context.networkFirstWithCache(manifestRequest, dataCache), cached);
  assert.equal(worker.context.isRadarManifest(new URL(manifestRequest.url)), true);
});

test('transient HTTP failures use last-known-good data while non-transient 4xx stays authoritative', async () => {
  const cached = response({ size: 2 });
  const cache = { match: () => Promise.resolve(cached), put: () => Promise.resolve() };
  for (const status of [408, 429, 500, 503]) {
    const transient = response({ ok: false, status });
    const worker = loadWorker({
      cachesByName: { [dataCache]: cache },
      fetch: () => Promise.resolve(transient)
    });
    assert.equal(await worker.context.networkFirstWithCache(
      request('https://example.test/data/cameras.index.json'), dataCache), cached);
  }
  const notFound = response({ ok: false, status: 404 });
  const notFoundWorker = loadWorker({
    cachesByName: { [dataCache]: cache },
    fetch: () => Promise.resolve(notFound)
  });
  assert.equal(await notFoundWorker.context.networkFirstWithCache(
    request('https://example.test/data/cameras.index.json'), dataCache), notFound);
});

test('transient navigation responses fall back to the cached shell without hiding ordinary 4xx', async () => {
  const shell = response({ size: 10 });
  const transient = response({ ok: false, status: 503 });
  const worker = loadWorker({
    cacheMatch: value => Promise.resolve(value === './index.html' ? shell : undefined),
    fetch: () => Promise.resolve(transient)
  });
  assert.equal(await worker.context.navigationNetworkFirst(
    request('https://example.test/', 'navigate')), shell);

  const notFound = response({ ok: false, status: 404 });
  const notFoundWorker = loadWorker({
    cacheMatch: () => Promise.resolve(shell),
    fetch: () => Promise.resolve(notFound)
  });
  assert.equal(await notFoundWorker.context.navigationNetworkFirst(
    request('https://example.test/missing', 'navigate')), notFound);
});

test('navigation preload is consumed once and retains the offline shell fallback', async () => {
  const shell = response({ size: 10 });
  const preloaded = response({ size: 20 });
  let fetches = 0;
  const worker = loadWorker({
    cacheMatch: value => Promise.resolve(value === './index.html' ? shell : undefined),
    fetch: () => { fetches += 1; return Promise.reject(new Error('unexpected fetch')); }
  });
  const navigation = request('https://example.test/', 'navigate');
  assert.equal(await worker.context.navigationNetworkFirst(navigation, Promise.resolve(preloaded)), preloaded);
  assert.equal(fetches, 0);

  const transient = response({ ok: false, status: 503 });
  assert.equal(await worker.context.navigationNetworkFirst(navigation, Promise.resolve(transient)), shell);
  assert.equal(fetches, 0);

  assert.equal(await worker.context.navigationNetworkFirst(navigation, Promise.reject(new Error('preload failed'))), shell);
  assert.equal(fetches, 1);
});

test('navigation fetch routing forwards the event preload response', async () => {
  const preloaded = response({ size: 20 });
  let fetches = 0;
  const worker = loadWorker({
    fetch: () => { fetches += 1; return Promise.reject(new Error('unexpected fetch')); }
  });
  let routed;
  worker.handlers.fetch({
    request: request('https://example.test/', 'navigate'),
    preloadResponse: Promise.resolve(preloaded),
    respondWith(promise) { routed = promise; }
  });
  assert.equal(await routed, preloaded);
  assert.equal(fetches, 0);
});

test('opaque tile fallback is returned but never cached', async () => {
  const opaque = response({ ok: false, type: 'opaque' });
  const fetched = [];
  let putCount = 0;
  const cache = {
    match: () => Promise.resolve(undefined),
    put: () => {
      putCount += 1;
      return Promise.resolve();
    }
  };
  const original = request('https://basemaps.cartocdn.com/dark_all/1/2/3.png', 'no-cors');
  const worker = loadWorker({
    cachesByName: { [tileCache]: cache },
    fetch(value) {
      fetched.push(value);
      if (value !== original) return Promise.reject(new TypeError('CORS unavailable'));
      return Promise.resolve(opaque);
    }
  });
  assert.equal(await worker.context.cacheFirst(original, tileCache, 600), opaque);
  assert.equal(fetched[0].mode, 'cors');
  assert.equal(fetched[1], original);
  assert.equal(putCount, 0);
});

test('quota failures preserve the network response and notify clients', async () => {
  const quotaError = new Error('full');
  quotaError.name = 'QuotaExceededError';
  const networkResponse = response();
  const cache = {
    match: () => Promise.resolve(undefined),
    put: () => Promise.reject(quotaError)
  };
  const worker = loadWorker({
    cachesByName: { [tileCache]: cache },
    fetch: () => Promise.resolve(networkResponse)
  });
  assert.equal(
    await worker.context.cacheFirst(
      request('https://basemaps.cartocdn.com/dark_all/1/2/3.png'),
      tileCache,
      600
    ),
    networkResponse
  );
  assert.deepEqual(JSON.parse(JSON.stringify(worker.clientMessages)), [{
    type: 'STORMSCOPE_CACHE_ERROR',
    cache: tileCache,
    reason: 'quota-exceeded'
  }]);
});

test('message operations report StormScope usage and clear runtime caches only', async () => {
  const cache = {
    keys: () => Promise.resolve(['a', 'b']),
    match: () => Promise.resolve(response({ contentLength: 12 }))
  };
  const worker = loadWorker({
    cacheNames: [shellCache, tileCache, dataCache, 'another-app-cache'],
    cachesByName: { [shellCache]: cache, [tileCache]: cache, [dataCache]: cache },
    navigator: { storage: { estimate: () => Promise.resolve({ usage: 50, quota: 500 }) } }
  });
  const replies = [];
  let lifetime;
  worker.handlers.message({
    data: { type: 'STORMSCOPE_GET_CACHE_USAGE' },
    ports: [{ postMessage(message) { replies.push(message); } }],
    waitUntil(promise) { lifetime = promise; }
  });
  await lifetime;
  assert.deepEqual(JSON.parse(JSON.stringify(replies[0])), {
    type: 'STORMSCOPE_CACHE_USAGE',
    caches: [
      { name: shellCache, entries: 2, bytes: 24 },
      { name: tileCache, entries: 2, bytes: 24 },
      { name: dataCache, entries: 2, bytes: 24 }
    ],
    entries: 6,
    bytes: 72,
    originUsage: 50,
    originQuota: 500
  });

  worker.handlers.message({
    data: { type: 'STORMSCOPE_CLEAR_CACHES' },
    ports: [{ postMessage(message) { replies.push(message); } }],
    waitUntil(promise) { lifetime = promise; }
  });
  await lifetime;
  assert.deepEqual(worker.deleted, [tileCache, dataCache]);
  assert.equal(worker.deleted.includes(shellCache), false);
  assert.deepEqual(JSON.parse(JSON.stringify(replies[1])), {
    type: 'STORMSCOPE_CACHES_CLEARED',
    deleted: 2
  });
});
