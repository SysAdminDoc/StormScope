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
  assert.equal(Object.hasOwn(report, 'favorites'), false);
  assert.equal(Object.hasOwn(report, 'savedViews'), false);
});
