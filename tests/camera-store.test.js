'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const cameraRecord = require('../js/camera-record.js');
const cameraStore = require('../js/camera-store.js');

function response(value, ok = true, headers = {}) {
  return {
    ok,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    json: async () => value,
    text: async () => typeof value === 'string' ? value : JSON.stringify(value)
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generation(shards) {
  const texts = shards.map(shard => JSON.stringify(shard));
  const hashes = texts.map(text => sha256(Buffer.from(text)));
  const datasetHash = sha256(Buffer.concat(hashes.map(hash => Buffer.from(hash, 'hex'))));
  const cameras = shards.flat();
  const totals = (field, fallback) => cameras.reduce((result, item) => {
    const key = String(item[field] || fallback);
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  return {
    texts,
    index: {
      index_version: 2,
      camera_schema_version: 2,
      generated_at: '2026-07-12T12:00:00Z',
      total: cameras.length,
      verified_total: cameras.filter(item => item.last_verified != null).length,
      health_totals: totals('health', 'unknown'),
      provider_totals: totals('provider', 'unattributed'),
      shard_size: 2,
      dataset_hash_algorithm: 'sha256-concat-shard-digests-v1',
      dataset_sha256: datasetHash,
      shards: shards.map((shard, index) => ({
        id: String(index + 1).padStart(4, '0'),
        path: `camera-shards/${String(index + 1).padStart(4, '0')}.json?generation=${datasetHash}`,
        count: shard.length,
        first_id: shard[0].id,
        last_id: shard[shard.length - 1].id,
        bbox: [-75, 40, -75, 40],
        sha256: hashes[index]
      }))
    }
  };
}

function camera(id, overrides) {
  return Object.assign({
    id,
    name: `Camera ${id}`,
    road: '',
    lat: 40,
    lon: -75,
    url: `https://example.com/camera-${id}.jpg`,
    state: 'Pennsylvania',
    county: 'Test',
    source: 'dot',
    type: 'image',
    health: 'unknown',
    last_verified: null,
    failure_class: null,
    source_url: null,
    refresh_cadence_seconds: null
  }, overrides || {});
}

function sourceHealth(overrides) {
  const provider = Object.assign({
    name: 'Provider A',
    family: 'test',
    status: 'fresh',
    camera_sources: ['dot'],
    previous_camera_source_counts: { dot: 2 },
    camera_source_counts: { dot: 3 },
    last_attempt_at: '2026-07-14T18:00:00Z',
    last_success_at: '2026-07-14T18:00:00Z',
    fetched_count: 3,
    retained_count: 0,
    replaced_count: 2,
    previous_count: 2,
    final_count: 3,
    coverage_delta: 1,
    coverage_delta_percent: 50,
    failure_class: null
  }, overrides || {});
  return {
    schema_version: 1,
    generated_at: '2026-07-14T18:00:00Z',
    providers: [provider],
    totals: {
      fresh: provider.status === 'fresh' ? 1 : 0,
      retained: provider.status === 'retained' ? 1 : 0,
      failed: provider.status === 'failed' ? 1 : 0,
      unknown: provider.status === 'unknown' ? 1 : 0,
      cameras: provider.final_count,
      retained_cameras: provider.retained_count,
      coverage_delta: provider.coverage_delta
    }
  };
}

test('exports the same camera-store API as a browser global', () => {
  const recordSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'camera-record.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'camera-store.js'), 'utf8');
  const context = { globalThis: { fetch: async () => response([]) } };
  vm.runInNewContext(recordSource, context);
  vm.runInNewContext(source, context);
  assert.equal(typeof context.globalThis.StormScopeCameraStore.CameraStore, 'function');
  assert.equal(typeof context.globalThis.StormScopeCameraStore.filterCameras, 'function');
  assert.equal(typeof context.globalThis.StormScopeCameraStore.validateSourceHealth, 'function');
  assert.doesNotThrow(() => new context.globalThis.StormScopeCameraStore.CameraStore());
});

test('source-health validation strips unknown detail and summarizes the selected camera source', () => {
  const fixture = sourceHealth({ debug_url: 'https://secret.example/token' });
  const validated = cameraStore.validateSourceHealth(fixture);
  assert.equal(validated.providers[0].debug_url, undefined);
  assert.deepEqual(cameraStore.summarizeSourceHealth(validated, 'dot'), {
    providerCount: 1,
    fresh: 1,
    retained: 0,
    failed: 0,
    unknown: 0,
    cameras: 3,
    retainedCameras: 0,
    coverageDelta: 1,
    lastAttemptAt: '2026-07-14T18:00:00Z'
  });
  assert.equal(cameraStore.summarizeSourceHealth(validated, 'youtube'), null);

  const invalid = sourceHealth({ coverage_delta: 9 });
  invalid.totals.coverage_delta = 9;
  assert.throws(() => cameraStore.validateSourceHealth(invalid), /coverage counts/);
});

test('source-health loading is independent from camera generation loading and cancellable', async () => {
  let release;
  const fixture = sourceHealth();
  const store = new cameraStore.CameraStore({
    fetch: async url => {
      if (url.endsWith('source-health.json')) return new Promise(resolve => { release = resolve; });
      return response([]);
    }
  });
  const loading = store.loadSourceHealth();
  store.cancel();
  release(response(fixture));
  await assert.rejects(loading, error => error.name === 'AbortError');
  assert.equal(store.getSourceHealth(), null);

  const healthyStore = new cameraStore.CameraStore({ fetch: async () => response(fixture) });
  assert.equal((await healthyStore.loadSourceHealth()).totals.cameras, 3);
  assert.equal(healthyStore.getSourceHealth().providers[0].name, 'Provider A');
});

test('shared camera validator enforces schema types and feed-specific trust', () => {
  assert.equal(cameraRecord.validateCameraRecord(camera(1)).id, 1);
  assert.equal(cameraRecord.validateCameraRecord(camera(2, {
    type: 'youtube', source: 'youtube', url: 'abcDEF_123-'
  })).url, 'abcDEF_123-');
  assert.equal(cameraRecord.validateCameraRecord(camera(3, {
    type: 'embed', source: 'earthcam', url: 'https://www.earthcam.com/player'
  })).type, 'embed');
  assert.throws(() => cameraRecord.validateCameraRecord(camera(4, { lat: '40' })), /latitude/);
  assert.throws(() => cameraRecord.validateCameraRecord(camera(5, { url: 'http://example.com/cam.jpg' })), /HTTPS feed URL/);
  assert.throws(() => cameraRecord.validateCameraRecord(camera(6, {
    type: 'embed', url: 'https://earthcam.com.attacker.example/player'
  })), /trusted embed URL/);
  assert.throws(() => cameraRecord.validateCameraRecord(camera(7, {
    health: 'healthy', last_verified: null
  })), /healthy evidence/);
});

test('loads bounded shards progressively and reports cumulative progress', async () => {
  const calls = [];
  const progress = [];
  const fixture = generation([[camera(1), camera(2)], [camera(3)]]);
  const payloads = {
    'data/cameras.index.json': fixture.index,
    ['data/' + fixture.index.shards[0].path]: fixture.texts[0],
    ['data/' + fixture.index.shards[1].path]: fixture.texts[1]
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
    'data/' + fixture.index.shards[0].path,
    'data/' + fixture.index.shards[1].path
  ]);
  assert.deepEqual(progress.map(item => [item.loaded, item.complete, item.generationValidated]), [
    [2, false, false], [3, false, false], [3, true, true]
  ]);
});

test('rejects oversized indexes before parsing and rejects off-origin shard descriptors', async () => {
  const fixture = generation([[camera(1)]]);
  const oversized = new cameraStore.CameraStore({
    fetch: async () => response(fixture.index, true, {
      'content-length': String(cameraStore.MAX_INDEX_BYTES + 1)
    })
  });
  await assert.rejects(oversized.load({ fallback: false }), /byte limit/);
  assert.deepEqual(oversized.getCameras(), []);

  const oversizedBody = new cameraStore.CameraStore({
    fetch: async () => response(' '.repeat(cameraStore.MAX_INDEX_BYTES + 1))
  });
  await assert.rejects(oversizedBody.load({ fallback: false }), /byte limit/);

  const hostileIndex = structuredClone(fixture.index);
  hostileIndex.shards[0].path = `https://attacker.example/0001.json?generation=${hostileIndex.dataset_sha256}`;
  const hostile = new cameraStore.CameraStore({ fetch: async () => response(hostileIndex) });
  await assert.rejects(hostile.load({ fallback: false }), /path is invalid/);
  assert.deepEqual(hostile.getCameras(), []);
});

test('rejects index count ceilings and malformed camera records without retaining partial state', async () => {
  const overCount = generation([[camera(1)]]);
  overCount.index.total = cameraStore.MAX_CAMERAS + 1;
  const overCountStore = new cameraStore.CameraStore({ fetch: async () => response(overCount.index) });
  await assert.rejects(overCountStore.load({ fallback: false }), /index is invalid/);

  const malformed = generation([[camera(1)], [camera(2, { lon: 'west' })]]);
  const payloads = {
    'data/cameras.index.json': malformed.index,
    ['data/' + malformed.index.shards[0].path]: malformed.texts[0],
    ['data/' + malformed.index.shards[1].path]: malformed.texts[1]
  };
  const store = new cameraStore.CameraStore({ fetch: async url => response(payloads[url]) });
  await assert.rejects(store.load({ fallback: false }), /longitude/);
  assert.deepEqual(store.getCameras(), []);
});

test('manifest-only load fetches no shards and resume verifies the complete generation', async () => {
  const calls = [];
  const fixture = generation([[camera(1), camera(2)], [camera(3)]]);
  const payloads = {
    'data/cameras.index.json': fixture.index,
    ['data/' + fixture.index.shards[0].path]: fixture.texts[0],
    ['data/' + fixture.index.shards[1].path]: fixture.texts[1]
  };
  const store = new cameraStore.CameraStore({ fetch: async url => {
    calls.push(url);
    return response(payloads[url]);
  } });
  const deferred = await store.load({ deferShards: true });
  assert.equal(deferred.source, 'index-only');
  assert.equal(deferred.complete, false);
  assert.deepEqual(calls, ['data/cameras.index.json']);
  const complete = await store.resume();
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.cameras.map(item => item.id), [1, 2, 3]);
});

test('durable-ID lookup fetches and verifies exactly one matching shard', async () => {
  const calls = [];
  const fixture = generation([[camera(1), camera(2)], [camera(3)]]);
  const payloads = {
    'data/cameras.index.json': fixture.index,
    ['data/' + fixture.index.shards[0].path]: fixture.texts[0],
    ['data/' + fixture.index.shards[1].path]: fixture.texts[1]
  };
  const store = new cameraStore.CameraStore({ fetch: async url => {
    calls.push(url);
    return response(payloads[url]);
  } });
  await store.load({ deferShards: true });
  assert.equal((await store.loadCameraById(3)).id, 3);
  assert.deepEqual(calls, ['data/cameras.index.json', 'data/' + fixture.index.shards[1].path]);
  assert.equal(await store.loadCameraById(99), null);
});

test('durable-ID lookup is owned by cancellation and validates fetched records', async () => {
  const fixture = generation([[camera(1)]]);
  let releaseShard;
  const store = new cameraStore.CameraStore({ fetch: async url => {
    if (url.endsWith('cameras.index.json')) return response(fixture.index);
    return new Promise(resolve => { releaseShard = resolve; });
  } });
  await store.load({ deferShards: true });
  const lookup = store.loadCameraById(1);
  store.cancel();
  releaseShard(response(fixture.texts[0]));
  await assert.rejects(lookup, error => error.name === 'AbortError');

  const invalidFixture = generation([[camera(2, { source_url: false })]]);
  const invalidStore = new cameraStore.CameraStore({ fetch: async url => response(
    url.endsWith('cameras.index.json') ? invalidFixture.index : invalidFixture.texts[0]
  ) });
  await invalidStore.load({ deferShards: true });
  await assert.rejects(invalidStore.loadCameraById(2), /source_url/);
});

test('falls back to the monolith after a shard failure', async () => {
  const monolith = [camera(10), camera(11)];
  const fixture = generation([[camera(1)]]);
  const store = new cameraStore.CameraStore({
    fetch: async url => {
      if (url.endsWith('cameras.index.json')) {
        return response(fixture.index);
      }
      if (url.includes('camera-shards')) throw new Error('shard unavailable');
      return response(monolith);
    }
  });
  const result = await store.load();
  assert.equal(result.source, 'monolith');
  assert.deepEqual(result.cameras, monolith);
  assert.equal(await store.loadCameraById(1), null, 'fallback must clear the rejected shard index');
});

test('a byte-corrupt shard discards the generation and loads the monolith once', async () => {
  const monolith = [camera(90)];
  const fixture = generation([[camera(1)], [camera(2)]]);
  let monolithLoads = 0;
  const store = new cameraStore.CameraStore({
    fetch: async url => {
      if (url.endsWith('cameras.index.json')) return response(fixture.index);
      if (url === 'data/' + fixture.index.shards[0].path) return response(fixture.texts[0]);
      if (url === 'data/' + fixture.index.shards[1].path) return response(JSON.stringify([camera(22)]));
      monolithLoads += 1;
      return response(monolith);
    }
  });

  const result = await store.load();

  assert.equal(result.source, 'monolith');
  assert.deepEqual(result.cameras, monolith);
  assert.equal(monolithLoads, 1);
  assert.deepEqual(store.getCameras(), monolith);
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

test('nearest verified cameras ignore local or unverified evidence and use deterministic distance ties', () => {
  const cameras = [
    camera(1, { name: 'Unknown', lat: 40, lon: -75, health: 'unknown', last_verified: null }),
    camera(2, { name: 'Zulu', lat: 40.1, lon: -75, health: 'healthy', last_verified: '2026-07-11T00:00:00Z' }),
    camera(3, { name: 'Alpha', lat: 40.1, lon: -75, health: 'healthy', last_verified: '2026-07-12T00:00:00Z' }),
    camera(4, { name: 'Offline', lat: 40.01, lon: -75, health: 'offline', last_verified: '2026-07-12T00:00:00Z' })
  ];
  const nearest = cameraStore.nearestVerifiedCameras(cameras, { lat: 40, lon: -75 }, 3);
  assert.deepEqual(nearest.map(result => result.camera.id), [3, 2]);
  assert.ok(nearest[0].distanceKm > 11 && nearest[0].distanceKm < 12);
  assert.ok(nearest[0].bearing < 1 || nearest[0].bearing > 359);
  assert.deepEqual(cameraStore.nearestVerifiedCameras(cameras, { lat: NaN, lon: -75 }, 3), []);
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
