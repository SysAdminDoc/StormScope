/* Opt-in, bounded radar motion-compensation prototype. */
'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeRadarMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var DEFAULT_WIDTH = 128;
  var DEFAULT_HEIGHT = 72;
  var MAX_PIXELS = 128 * 72;
  var MAX_JOB_MS = 120;
  var DEFAULT_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
  var DEFAULT_WORKER_URL = 'js/radar-motion-worker.js';

  function fallback(reason, extra) {
    return Object.assign({}, extra || {}, { status: 'fallback', mode: 'crossfade', reason: reason });
  }

  function boundedDimension(value, fallbackValue) {
    var number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallbackValue;
  }

  function eligibility(input) {
    input = input || {};
    var width = boundedDimension(input.width, DEFAULT_WIDTH);
    var height = boundedDimension(input.height, DEFAULT_HEIGHT);
    var pixels = width * height;
    if (!input.optIn) return { enabled: false, reason: 'disabled', width: width, height: height };
    if (input.reducedMotion) return { enabled: false, reason: 'reduced-motion', width: width, height: height };
    if (input.lowData) return { enabled: false, reason: 'low-data', width: width, height: height };
    if (input.hidden) return { enabled: false, reason: 'hidden', width: width, height: height };
    if (input.comparisonOpen) return { enabled: false, reason: 'comparison', width: width, height: height };
    if (input.workerSupported === false) return { enabled: false, reason: 'worker', width: width, height: height };
    if (input.providerKind !== 'xyz') return { enabled: false, reason: 'provider', width: width, height: height };
    if (input.observedFrames !== true || input.isForecast) {
      return { enabled: false, reason: 'observed-only', width: width, height: height };
    }
    if (!Number.isFinite(input.previousFrameTime) || !Number.isFinite(input.nextFrameTime) ||
        input.nextFrameTime <= input.previousFrameTime) {
      return { enabled: false, reason: 'adjacent-frames', width: width, height: height };
    }
    if (Number.isFinite(input.now) && input.nextFrameTime > input.now + 2 * 60 * 1000) {
      return { enabled: false, reason: 'forecast-frame', width: width, height: height };
    }
    if (pixels > MAX_PIXELS) return { enabled: false, reason: 'bounds', width: width, height: height };
    var estimatedMemoryBytes = Number(input.estimatedMemoryBytes);
    var memoryBudgetBytes = Number(input.memoryBudgetBytes);
    if (!Number.isFinite(memoryBudgetBytes) || memoryBudgetBytes <= 0) memoryBudgetBytes = DEFAULT_MEMORY_BUDGET_BYTES;
    if (Number.isFinite(estimatedMemoryBytes) && estimatedMemoryBytes + pixels * 12 > memoryBudgetBytes) {
      return { enabled: false, reason: 'memory', width: width, height: height };
    }
    return { enabled: true, reason: 'ready', width: width, height: height, pixels: pixels,
      memoryBudgetBytes: memoryBudgetBytes, maxJobMs: MAX_JOB_MS };
  }

  function bufferLength(value) {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return 0;
  }

  function create(options) {
    options = options || {};
    var workerUrl = options.workerUrl || DEFAULT_WORKER_URL;
    var workerFactory = options.workerFactory || function () {
      if (!root || typeof root.Worker !== 'function') throw new Error('motion worker unavailable');
      return new root.Worker(workerUrl);
    };
    var setTimeoutFunction = options.setTimeout || function (callback, delay) { return root.setTimeout(callback, delay); };
    var clearTimeoutFunction = options.clearTimeout || function (timer) { return root.clearTimeout(timer); };
    var nowFunction = options.now || Date.now;
    var workerSupported = options.workerSupported == null
      ? Boolean(root && typeof root.Worker === 'function') : Boolean(options.workerSupported);
    var activeJob = null;
    var requestId = 0;
    var destroyed = false;

    function resolveJob(job, result) {
      if (!job || job.settled) return;
      job.settled = true;
      clearTimeoutFunction(job.timer);
      if (activeJob === job) activeJob = null;
      try { job.worker.terminate(); } catch (error) { /* best effort */ }
      job.resolve(result);
    }

    function cancel(reason) {
      if (!activeJob) return false;
      var job = activeJob;
      resolveJob(job, fallback(reason || 'cancelled'));
      return true;
    }

    function run(request) {
      request = request || {};
      if (destroyed) return Promise.resolve(fallback('destroyed'));
      var dimensions = eligibility(Object.assign({}, request, { workerSupported: workerSupported && request.workerSupported !== false }));
      if (!dimensions.enabled) return Promise.resolve(fallback(dimensions.reason, dimensions));
      var expectedBytes = dimensions.pixels * 4;
      if (bufferLength(request.previous) !== expectedBytes || bufferLength(request.next) !== expectedBytes) {
        return Promise.resolve(fallback('input', dimensions));
      }
      cancel('stale');
      var id = ++requestId;
      return new Promise(function (resolve) {
        var worker;
        try { worker = workerFactory(); } catch (error) {
          resolve(fallback('worker', Object.assign({}, dimensions, { error: String(error && error.message || error) })));
          return;
        }
        var job = { id: id, worker: worker, resolve: resolve, settled: false, timer: null };
        activeJob = job;
        var startedAt = nowFunction();
        job.timer = setTimeoutFunction(function () {
          resolveJob(job, fallback('timeout', Object.assign({}, dimensions, {
            durationMs: Math.max(0, nowFunction() - startedAt)
          })));
        }, MAX_JOB_MS + 30);
        worker.onmessage = function (event) {
          if (activeJob !== job || job.id !== id) return;
          var data = event && event.data || {};
          var durationMs = Number(data.durationMs);
          if (!data.ok || bufferLength(data.pixels) !== expectedBytes) {
            resolveJob(job, fallback(data.reason || 'worker', dimensions));
            return;
          }
          if (!Number.isFinite(durationMs)) durationMs = Math.max(0, nowFunction() - startedAt);
          if (durationMs > MAX_JOB_MS) {
            resolveJob(job, fallback('budget', Object.assign({}, dimensions, { durationMs: durationMs })));
            return;
          }
          resolveJob(job, {
            status: 'ready', mode: 'motion-compensated', reason: 'ready',
            width: dimensions.width, height: dimensions.height, pixels: data.pixels,
            durationMs: durationMs, algorithm: 'bounded-block-flow', searchRadius: 3,
            maxJobMs: MAX_JOB_MS
          });
        };
        worker.onerror = function (event) {
          resolveJob(job, fallback('worker', Object.assign({}, dimensions, {
            error: event && event.message ? String(event.message) : 'worker error'
          })));
        };
        try {
          var previous = request.previous instanceof Uint8ClampedArray
            ? request.previous : new Uint8ClampedArray(request.previous);
          var next = request.next instanceof Uint8ClampedArray
            ? request.next : new Uint8ClampedArray(request.next);
          worker.postMessage({
            type: 'interpolate', id: id, width: dimensions.width, height: dimensions.height,
            progress: 0.5, previous: previous.buffer, next: next.buffer
          }, [previous.buffer, next.buffer]);
        } catch (error) {
          resolveJob(job, fallback('input', Object.assign({}, dimensions, {
            error: String(error && error.message || error)
          })));
        }
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel('destroyed');
    }

    return Object.freeze({
      cancel: cancel,
      destroy: destroy,
      eligibility: eligibility,
      isSupported: function () { return workerSupported; },
      run: run,
      constants: Object.freeze({
        width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maxPixels: MAX_PIXELS,
        maxJobMs: MAX_JOB_MS, memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES
      })
    });
  }

  return Object.freeze({
    DEFAULT_HEIGHT: DEFAULT_HEIGHT,
    DEFAULT_MEMORY_BUDGET_BYTES: DEFAULT_MEMORY_BUDGET_BYTES,
    DEFAULT_WIDTH: DEFAULT_WIDTH,
    MAX_JOB_MS: MAX_JOB_MS,
    MAX_PIXELS: MAX_PIXELS,
    create: create,
    eligibility: eligibility
  });
});
