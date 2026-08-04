const assert = require('node:assert/strict');
const test = require('node:test');

const quarantine = require('../js/camera-quarantine.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
    raw: key => values.get(key)
  };
}

test('camera family quarantine aggregates bounded local failures and expires', () => {
  const storage = memoryStorage();
  const camera = { source: 'dot', provider: 'Test DOT', type: 'image', url: 'https://camera.test/a' };
  const sibling = { source: 'dot', provider: 'Test DOT', type: 'hls', url: 'https://camera.test/b' };
  const store = quarantine.create({ storage, now: () => 1000 });

  assert.equal(store.observe(camera, 'retrying', 1000), null);
  store.observe(camera, 'unavailable', 1000);
  store.observe(sibling, 'unsupported', 1100);
  const marked = store.observe(camera, 'unavailable', 1200);
  assert.equal(marked.family, 'Test DOT');
  assert.equal(marked.attempts, 3);
  assert.equal(marked.failures, 3);
  assert.equal(marked.markedForReview, true);
  assert.equal(store.isUnderReview(sibling, 1200), true);
  assert.equal(store.summarize('dot', 1200).markedForReview, 1);

  const recovered = store.observe(camera, 'playable', 1300);
  assert.equal(recovered.markedForReview, true);
  assert.equal(recovered.attempts, 4);
  assert.equal(recovered.failures, 3);
  store.observe(camera, 'playable', 1400);
  const clear = store.observe(camera, 'playable', 1500);
  assert.equal(clear.markedForReview, false);
  assert.equal(clear.attempts, 6);
  assert.equal(clear.failures, 3);

  assert.equal(store.get(camera, 1500 + quarantine.TTL_MS + 1), null);
  assert.equal(store.summarize('dot', 1500 + quarantine.TTL_MS + 1).families, 0);
  assert.deepEqual(JSON.parse(storage.raw(quarantine.STORAGE_KEY)), {});
});

test('camera family quarantine keeps source scope separate and bounds samples', () => {
  const store = quarantine.create({ storage: memoryStorage(), now: () => 5000 });
  const camera = { source: 'dot', provider: 'Shared family', type: 'image' };
  const otherSource = { source: 'noaa', provider: 'Shared family', type: 'image' };
  for (let index = 0; index < quarantine.MAX_SAMPLES_PER_FAMILY + 4; index += 1) {
    store.observe(camera, index % 2 ? 'unavailable' : 'playable', 5000 + index);
  }
  const entry = store.get(camera, 5100);
  assert.equal(entry.attempts, quarantine.MAX_SAMPLES_PER_FAMILY);
  assert.equal(store.get(otherSource, 5100), null);
  assert.equal(store.summarize('noaa', 5100).markedForReview, 0);
});
