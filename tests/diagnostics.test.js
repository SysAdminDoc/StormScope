'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const diagnostics = require('../js/diagnostics.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value)
  };
}

test('diagnostics bound and redact URLs and coordinates', () => {
  const store = diagnostics.create(memoryStorage());
  for (let index = 0; index < 55; index += 1) {
    store.capture(new Error(`feed https://camera.example/${index}?token=secret at 40.12345,-75.98765`));
  }
  const errors = store.getErrors();
  assert.equal(errors.length, diagnostics.MAX_ERRORS);
  assert.doesNotMatch(JSON.stringify(errors), /camera\.example|token=secret|40\.12345|-75\.98765/);
  assert.match(errors[0].message, /\[url\].*\[coordinates\]/);
  assert.equal(store.report().dropped_entries.errors, 5);
});

test('diagnostic report contains operational summaries but no local saved state', () => {
  const store = diagnostics.create(memoryStorage());
  store.capture(new Error('safe failure'), 'boot');
  const report = store.report({
    appVersion: '1.2.3', corpusGeneration: '2026-07-12T00:00:00Z',
    cameraIngestion: {
      schema_version: 1,
      generated_at: '2026-07-14T18:00:00Z',
      providers: [{
        name: 'Provider A', family: 'test', status: 'retained',
        last_attempt_at: '2026-07-14T18:00:00Z', last_success_at: '2026-07-12T18:00:00Z',
        fetched_count: 1, retained_count: 10, replaced_count: 0,
        previous_count: 10, final_count: 10, coverage_delta: 0,
        failure_class: 'incomplete_snapshot',
        debug_url: 'https://secret.example/token'
      }]
    },
    startup: {
      navigationEntries: [{
        type: 'reload', responseStart: 120.4, domContentLoadedEventEnd: 450.6,
        loadEventEnd: 700.1, duration: 701.2,
        name: 'https://private.example/path?search=secret'
      }, { type: 'navigate', responseStart: 1, duration: 2 }],
      camera: { firstBatchMs: 80.6, completeMs: 900.4, source: 'shards', deferred: false, cameraId: 'private-id' },
      dataMode: { preference: 'auto', enabled: true, source: 'save-data', query: 'private search' },
      serviceWorker: {
        supported: true, controlled: true, state: 'activated', scope: 'https://private.example/',
        navigationPreload: { supported: true, enabled: true, headerValue: 'private-id' }
      }
    },
    providers: { radar: 'noaa-mrms' }, cache: { entries: 4 }, localOverlays: { count: 2, bytes: 4096 }
  });
  assert.equal(report.app_version, '1.2.3');
  assert.equal(report.errors.length, 1);
  assert.deepEqual(report.local_overlays, { count: 2, bytes: 4096 });
  assert.equal(report.camera_ingestion.available, true);
  assert.deepEqual(report.camera_ingestion.providers[0], {
    name: 'Provider A',
    family: 'test',
    status: 'retained',
    last_attempt_at: '2026-07-14T18:00:00Z',
    last_success_at: '2026-07-12T18:00:00Z',
    fetched_count: 1,
    retained_count: 10,
    replaced_count: 0,
    previous_count: 10,
    final_count: 10,
    coverage_delta: 0,
    failure_class: 'incomplete_snapshot'
  });
  assert.doesNotMatch(JSON.stringify(report.camera_ingestion), /secret\.example|token/);
  assert.deepEqual(report.startup, {
    navigation: {
      available: true,
      type: 'reload',
      response_start_ms: 120,
      dom_content_loaded_ms: 451,
      load_event_ms: 700,
      duration_ms: 701
    },
    camera: { first_batch_ms: 81, complete_ms: 900, source: 'shards', deferred: false },
    data_mode: { preference: 'auto', effective: 'low', source: 'save-data' },
    service_worker: {
      supported: true,
      controlled: true,
      state: 'activated',
      navigation_preload: { supported: true, enabled: true }
    },
    dropped_navigation_entries: 1
  });
  assert.equal(report.dropped_entries.navigation, 1);
  assert.doesNotMatch(JSON.stringify(report.startup), /private|search|cameraId|headerValue|scope|https:/);
  assert.equal(Object.hasOwn(report, 'favorites'), false);
  assert.equal(Object.hasOwn(report, 'savedViews'), false);
});

test('startup timings are bounded and ingestion provider truncation is reported', () => {
  const providers = Array.from({ length: 260 }, (_, index) => ({ name: `Provider ${index}`, status: 'fresh' }));
  const report = diagnostics.create(memoryStorage()).report({
    cameraIngestion: { schema_version: 1, providers },
    startup: {
      navigationEntries: [{ type: 'navigate', responseStart: -1, duration: diagnostics.MAX_STARTUP_MS + 1 }],
      camera: { firstBatchMs: Infinity, completeMs: -2, source: 'remote' },
      dataMode: { preference: 'private', enabled: false, source: 'private' },
      serviceWorker: { supported: true, state: 'private', navigationPreload: {} }
    }
  });
  assert.deepEqual(report.startup.navigation, { available: false });
  assert.deepEqual(report.startup.camera, { first_batch_ms: null, complete_ms: null, source: null, deferred: false });
  assert.equal(report.camera_ingestion.providers.length, 256);
  assert.equal(report.dropped_entries.camera_ingestion_providers, 4);
});
