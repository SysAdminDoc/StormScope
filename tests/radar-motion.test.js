const assert = require('node:assert/strict');
const test = require('node:test');

const motion = require('../js/radar-motion.js');

function request(overrides) {
  const width = 4;
  const height = 2;
  return Object.assign({
    optIn: true,
    workerSupported: true,
    providerKind: 'xyz',
    observedFrames: true,
    previousFrameTime: 1_000,
    nextFrameTime: 2_000,
    now: 3_000,
    width,
    height,
    previous: new Uint8ClampedArray(width * height * 4),
    next: new Uint8ClampedArray(width * height * 4)
  }, overrides || {});
}

test('motion eligibility is opt-in, observed-only, and budget bounded', () => {
  assert.equal(motion.eligibility(request()).enabled, true);
  assert.equal(motion.eligibility(request({ optIn: false })).reason, 'disabled');
  assert.equal(motion.eligibility(request({ reducedMotion: true })).reason, 'reduced-motion');
  assert.equal(motion.eligibility(request({ lowData: true })).reason, 'low-data');
  assert.equal(motion.eligibility(request({ hidden: true })).reason, 'hidden');
  assert.equal(motion.eligibility(request({ comparisonOpen: true })).reason, 'comparison');
  assert.equal(motion.eligibility(request({ providerKind: 'wms' })).reason, 'provider');
  assert.equal(motion.eligibility(request({ observedFrames: false })).reason, 'observed-only');
  assert.equal(motion.eligibility(request({ nextFrameTime: 200_000, now: 3_000 })).reason, 'forecast-frame');
  assert.equal(motion.eligibility(request({ estimatedMemoryBytes: 100, memoryBudgetBytes: 100 })).reason, 'memory');
  assert.equal(motion.eligibility(request({ width: 129, height: 72 })).reason, 'bounds');
});

class FakeWorker {
  constructor() {
    this.terminated = false;
    this.message = null;
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message) {
    this.message = message;
  }

  terminate() {
    this.terminated = true;
  }
}

test('worker profile returns bounded pixels and stale requests are cancelled', async () => {
  const workers = [];
  const controller = motion.create({
    workerSupported: true,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }
  });
  const firstPromise = controller.run(request());
  const secondPromise = controller.run(request());
  assert.equal((await firstPromise).reason, 'stale');
  assert.equal(workers[0].terminated, true);
  const output = new ArrayBuffer(4 * 2 * 4);
  workers[1].onmessage({ data: { ok: true, pixels: output, durationMs: 12 } });
  const result = await secondPromise;
  assert.deepEqual({ status: result.status, mode: result.mode, width: result.width, height: result.height }, {
    status: 'ready', mode: 'motion-compensated', width: 4, height: 2
  });
  assert.equal(result.algorithm, 'bounded-block-flow');
  assert.equal(result.maxJobMs, motion.MAX_JOB_MS);
  controller.destroy();
});

test('worker failures and cancellation remain explicit crossfade fallbacks', async () => {
  let worker;
  const controller = motion.create({
    workerSupported: true,
    workerFactory: () => {
      worker = new FakeWorker();
      return worker;
    }
  });
  const pending = controller.run(request());
  worker.onerror({ message: 'synthetic failure' });
  const failed = await pending;
  assert.deepEqual({ status: failed.status, mode: failed.mode, reason: failed.reason }, {
    status: 'fallback', mode: 'crossfade', reason: 'worker'
  });
  const next = controller.run(request());
  controller.cancel('hidden');
  assert.equal((await next).reason, 'hidden');
  controller.destroy();
});
