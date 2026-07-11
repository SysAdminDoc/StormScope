'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const cameraStore = require('../js/camera-store.js');

function response(value, ok = true) {
  return { ok, json: async () => value };
}

function camera(id, overrides) {
  return Object.assign({
    id,
    name: `Camera ${id}`,
    road: '',
    lat: 40,
    lon: -75,
    state: 'Pennsylvania',
    county: 'Test',
    source: 'dot',
    type: 'image',
    health: 'unknown'
  }, overrides || {});
}

test('exports the same camera-store API as a browser global', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'camera-store.js'), 'utf8');
  const context = { globalThis: { fetch: async () => response([]) } };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.globalThis.StormScopeCameraStore.CameraStore, 'function');
  assert.equal(typeof context.globalThis.StormScopeCameraStore.filterCameras, 'function');
  assert.doesNotThrow(() => new context.globalThis.StormScopeCameraStore.CameraStore());
});

test('loads bounded shards progressively and reports cumulative progress', async () => {
  const calls = [];
  const progress = [];
  const payloads = {
    'data/cameras.index.json': {
      total: 3,
      shards: [
        { id: '0001', path: 'camera-shards/0001.json', count: 2 },
        { id: '0002', path: 'camera-shards/0002.json', count: 1 }
      ]
    },
    'data/camera-shards/0001.json': [camera(1), camera(2)],
    'data/camera-shards/0002.json': [camera(3)]
  };
  const store = new cameraStore.CameraStore({
    fetch: async url => {
      calls.push(url);
      return response(payloads[url]);
    },
    onProgress: detail => progress.push(detail)
  });
  const result = await store.load();
  assert.equal(result.source, 'shards');
  assert.deepEqual(result.cameras.map(item => item.id), [1, 2, 3]);
  assert.deepEqual(calls, [
    'data/cameras.index.json',
    'data/camera-shards/0001.json',
    'data/camera-shards/0002.json'
  ]);
  assert.deepEqual(progress.map(item => [item.loaded, item.complete]), [[2, false], [3, false], [3, true]]);
});

test('falls back to the monolith after a shard failure', async () => {
  const monolith = [camera(10), camera(11)];
  const store = new cameraStore.CameraStore({
    fetch: async url => {
      if (url.endsWith('cameras.index.json')) {
        return response({ total: 1, shards: [{ id: '0001', path: 'camera-shards/0001.json', count: 1 }] });
      }
      if (url.includes('camera-shards')) throw new Error('shard unavailable');
      return response(monolith);
    }
  });
  const result = await store.load();
  assert.equal(result.source, 'monolith');
  assert.deepEqual(result.cameras, monolith);
});

test('cancellation rejects without starting monolith fallback', async () => {
  let releaseIndex;
  const calls = [];
  const indexPromise = new Promise(resolve => { releaseIndex = resolve; });
  const store = new cameraStore.CameraStore({
    fetch: async url => {
      calls.push(url);
      if (url.endsWith('cameras.index.json')) return indexPromise;
      return response([]);
    }
  });
  const loading = store.load();
  store.cancel();
  releaseIndex(response({ total: 0, shards: [] }));
  await assert.rejects(loading, error => error.name === 'AbortError');
  assert.deepEqual(calls, ['data/cameras.index.json']);
});

test('shared filters cover name, road, geography, source, type, query, and healthy-only', () => {
  const cameras = [
    camera(1, { name: 'I-95 at Market Street', road: 'I-95', county: 'Philadelphia', health: 'healthy' }),
    camera(2, { name: 'Beach Pier', state: 'Florida', county: 'Monroe', source: 'youtube', type: 'youtube' })
  ];
  assert.deepEqual(cameraStore.filterCameras(cameras, { name: 'market' }).map(item => item.id), [1]);
  assert.deepEqual(cameraStore.filterCameras(cameras, { road: 'i-95' }).map(item => item.id), [1]);
  assert.deepEqual(cameraStore.filterCameras(cameras, { state: 'flor', county: 'mon', source: 'youtube', type: 'youtube' }).map(item => item.id), [2]);
  assert.deepEqual(cameraStore.filterCameras(cameras, { query: 'beach pier' }).map(item => item.id), [2]);
  assert.deepEqual(cameraStore.filterCameras(cameras, { healthy: true }).map(item => item.id), [1]);
});

test('sorting is health-first with distance or name inside each health class', () => {
  const cameras = [
    camera(1, { name: 'Zulu', lat: 40.01, health: 'unknown' }),
    camera(2, { name: 'Bravo', lat: 41, health: 'healthy' }),
    camera(3, { name: 'Alpha', lat: 40.1, health: 'healthy' })
  ];
  const byDistance = cameraStore.sortCameras(cameras, {
    sortBy: 'distance', origin: { lat: 40, lon: -75 }
  });
  assert.deepEqual(byDistance.map(item => item.id), [3, 2, 1]);
  assert.deepEqual(cameraStore.sortCameras(cameras, { sortBy: 'name' }).map(item => item.id), [3, 2, 1]);
});

test('virtual-window calculations clamp bounds and include overscan spacers', () => {
  const window = cameraStore.calculateVirtualWindow({
    total: 100,
    itemHeight: 20,
    scrollTop: 201,
    viewportHeight: 99,
    overscan: 2
  });
  assert.deepEqual(window, {
    start: 8,
    end: 17,
    visibleStart: 10,
    visibleEnd: 15,
    offsetTop: 160,
    offsetBottom: 1660,
    totalHeight: 2000
  });
  const virtual = cameraStore.virtualize([0, 1, 2], {
    itemHeight: 10, scrollTop: 50, viewportHeight: 20, overscan: 1
  });
  assert.deepEqual(virtual.items, [0, 1, 2]);
  assert.equal(virtual.start, 0);
  assert.equal(virtual.end, 3);
});
