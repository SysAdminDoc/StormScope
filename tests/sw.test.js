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

function response(options) {
  const config = Object.assign({ ok: true, type: 'basic', size: 0 }, options);
  return {
    ok: config.ok,
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
  const worker = loadWorker({
    cacheNames: [
      'stormscope-shell-v0',
      shellCache,
      tileCache,
      dataCache,
      'another-app-cache'
    ]
  });
  let lifetime;
  worker.handlers.activate({ waitUntil(promise) { lifetime = promise; } });
  await lifetime;
  assert.deepEqual(worker.deleted, ['stormscope-shell-v0']);
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
