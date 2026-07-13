const assert = require('node:assert/strict');
const test = require('node:test');

const comparison = require('../js/map-comparison.js');

test('comparison exposes bounded sources, requests, tiles, memory, and sync thresholds', () => {
  assert.deepEqual(comparison.sources, ['radar', 'satellite', 'hazards']);
  assert.deepEqual(comparison.limits, {
    requestsPerMinute: 72,
    tileNodesPerPane: 64,
    maxEstimatedMemoryBytes: 32 * 1024 * 1024,
    desktopSyncBudgetMs: 20,
    mobileSyncBudgetMs: 32
  });
  assert.ok(Object.isFrozen(comparison.sources));
  assert.ok(Object.isFrozen(comparison.limits));
});

test('comparison rolling request budget has an exact one-minute window', () => {
  let now = 0;
  const budget = comparison.createRollingBudget(() => now);
  for (let index = 0; index < 72; index += 1) assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), false);
  assert.deepEqual(budget.snapshot(), { limit: 72, used: 72, remaining: 0 });
  now = 60000;
  assert.equal(budget.consume(), true);
  assert.deepEqual(budget.snapshot(), { limit: 72, used: 1, remaining: 71 });
});

test('comparison percentile reports deterministic performance gates', () => {
  assert.equal(comparison.percentile([], 0.95), 0);
  assert.equal(comparison.percentile([8, 1, 4, 2, 16], 0.95), 16);
  assert.equal(comparison.percentile([8, 1, 4, 2, 16], 0.5), 4);
});

test('comparison controller rejects incomplete application wiring', () => {
  assert.throws(() => comparison.create(), /requires Leaflet/);
  assert.throws(() => comparison.create({ L: {}, modal: {}, mainMap: {} }), /layer factory/);
});
