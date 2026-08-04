/* Bounded, client-only radar loop encoding helpers. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeRadarExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAX_FRAMES = 12;
  var MAX_WIDTH = 512;
  var MAX_HEIGHT = 288;
  var FRAME_DURATION_MS = 350;
  var MAX_BYTES = 8 * 1024 * 1024;
  var MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  function finitePositive(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
  }

  function boundedDimensions(width, height) {
    width = Number(width);
    height = Number(height);
    if (!finitePositive(width) || !finitePositive(height)) return null;
    var scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
    var boundedWidth = Math.max(1, Math.round(width * scale));
    var boundedHeight = Math.max(1, Math.round(height * scale));
    if (boundedWidth > MAX_WIDTH || boundedHeight > MAX_HEIGHT) return null;
    return { width: boundedWidth, height: boundedHeight };
  }

  function frameIndices(frameCount, maxFrames, currentIndex) {
    var count = Math.max(0, Math.floor(Number(frameCount) || 0));
    var limit = Math.max(1, Math.min(MAX_FRAMES, Math.floor(Number(maxFrames) || MAX_FRAMES)));
    if (!count) return [];
    var end = count - 1;
    if (Number.isInteger(currentIndex)) end = Math.max(0, Math.min(end, currentIndex));
    var start = Math.max(0, end - limit + 1);
    if (end < count - 1 && end - start + 1 < limit) {
      end = Math.min(count - 1, start + limit - 1);
      start = Math.max(0, end - limit + 1);
    }
    var result = [];
    for (var index = start; index <= end; index += 1) result.push(index);
    return result;
  }

  function supportedMimeType(MediaRecorderConstructor) {
    if (typeof MediaRecorderConstructor !== 'function') return null;
    if (typeof MediaRecorderConstructor.isTypeSupported !== 'function') return MIME_TYPES[MIME_TYPES.length - 1];
    for (var index = 0; index < MIME_TYPES.length; index += 1) {
      try {
        if (MediaRecorderConstructor.isTypeSupported(MIME_TYPES[index])) return MIME_TYPES[index];
      } catch (error) { /* try the next browser-supported format */ }
    }
    return null;
  }

  function eligibility(options) {
    options = options || {};
    if (!options.optIn) return { enabled: false, reason: 'disabled' };
    if (options.lowData) return { enabled: false, reason: 'low-data' };
    if (options.reducedMotion) return { enabled: false, reason: 'reduced-motion' };
    if (options.visible === false) return { enabled: false, reason: 'hidden' };
    if (Math.floor(Number(options.frameCount) || 0) < 2) return { enabled: false, reason: 'frames' };
    var dimensions = boundedDimensions(options.width, options.height);
    if (!dimensions) return { enabled: false, reason: 'bounds' };
    var mimeType = supportedMimeType(options.MediaRecorder);
    if (!mimeType) return { enabled: false, reason: 'encoder', width: dimensions.width, height: dimensions.height };
    if (options.canvas && typeof options.canvas.captureStream !== 'function') {
      return { enabled: false, reason: 'capture-stream', mimeType: mimeType, width: dimensions.width, height: dimensions.height };
    }
    if (options.captureStreamSupported === false) {
      return { enabled: false, reason: 'capture-stream', mimeType: mimeType, width: dimensions.width, height: dimensions.height };
    }
    return {
      enabled: true,
      reason: null,
      mimeType: mimeType,
      width: dimensions.width,
      height: dimensions.height,
      frameDurationMs: FRAME_DURATION_MS,
      maxFrames: MAX_FRAMES,
      maxBytes: MAX_BYTES
    };
  }

  function delay(setTimeoutFunction, delayMs) {
    return new Promise(function (resolve) {
      setTimeoutFunction(resolve, delayMs);
    });
  }

  function encode(options) {
    options = options || {};
    var canvas = options.canvas;
    var MediaRecorderConstructor = options.MediaRecorder;
    var indices = Array.isArray(options.frameIndices) ? options.frameIndices.slice(0, MAX_FRAMES) : [];
    var frameDurationMs = Math.max(100, Math.floor(Number(options.frameDurationMs) || FRAME_DURATION_MS));
    var maxBytes = Math.max(1024, Math.floor(Number(options.maxBytes) || MAX_BYTES));
    var setTimeoutFunction = options.setTimeout || function (callback, delayMs) { return setTimeout(callback, delayMs); };
    var clearTimeoutFunction = options.clearTimeout || function (timer) { return clearTimeout(timer); };
    var drawFrame = options.drawFrame;
    var reportProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};

    if (!canvas || typeof canvas.captureStream !== 'function') {
      return Promise.resolve({ status: 'fallback', reason: 'capture-stream' });
    }
    if (typeof MediaRecorderConstructor !== 'function') {
      return Promise.resolve({ status: 'fallback', reason: 'encoder' });
    }
    if (!indices.length || typeof drawFrame !== 'function') {
      return Promise.resolve({ status: 'fallback', reason: 'frames' });
    }

    var context;
    try {
      context = options.context || canvas.getContext('2d', { alpha: false });
      if (!context) return Promise.resolve({ status: 'fallback', reason: 'canvas' });
    } catch (error) {
      return Promise.resolve({ status: 'fallback', reason: 'canvas' });
    }

    var mimeType = options.mimeType || supportedMimeType(MediaRecorderConstructor);
    if (!mimeType) return Promise.resolve({ status: 'fallback', reason: 'encoder' });

    var stream;
    var recorder;
    var chunks = [];
    var byteLength = 0;
    var overflow = false;
    var renderFailure = null;
    var stopped = false;
    var stopTimer = null;

    function stopTracks() {
      if (!stream || typeof stream.getTracks !== 'function') return;
      stream.getTracks().forEach(function (track) {
        if (track && typeof track.stop === 'function') track.stop();
      });
    }

    function stopRecorder() {
      if (!recorder || recorder.state === 'inactive') return;
      try { recorder.stop(); } catch (error) { /* onstop/onerror settles the export */ }
    }

    return new Promise(function (resolve) {
      function finish(result) {
        if (stopped) return;
        stopped = true;
        if (stopTimer !== null) clearTimeoutFunction(stopTimer);
        stopTracks();
        resolve(result);
      }

      try {
        stream = canvas.captureStream(Math.max(1, Math.round(1000 / frameDurationMs)));
        recorder = new MediaRecorderConstructor(stream, { mimeType: mimeType });
        recorder.ondataavailable = function (event) {
          var data = event && event.data;
          if (!data || !data.size) return;
          byteLength += Number(data.size) || 0;
          if (byteLength > maxBytes) {
            overflow = true;
            stopRecorder();
            return;
          }
          chunks.push(data);
        };
        recorder.onerror = function () { finish({ status: 'fallback', reason: 'encoder' }); };
        recorder.onstop = function () {
          if (renderFailure) {
            finish(renderFailure);
            return;
          }
          if (overflow) {
            finish({ status: 'fallback', reason: 'size', frameCount: indices.length, mimeType: mimeType });
            return;
          }
          try {
            var blob = new Blob(chunks, { type: mimeType });
            if (!blob.size || blob.size > maxBytes) {
              finish({ status: 'fallback', reason: 'size', frameCount: indices.length, mimeType: mimeType });
              return;
            }
            finish({ status: 'ready', blob: blob, frameCount: indices.length, mimeType: mimeType });
          } catch (error) {
            finish({ status: 'fallback', reason: 'encoder', frameCount: indices.length, mimeType: mimeType });
          }
        };
        recorder.start();
      } catch (error) {
        finish({ status: 'fallback', reason: 'encoder' });
        return;
      }

      (async function renderFrames() {
        try {
          for (var index = 0; index < indices.length; index += 1) {
            await drawFrame(indices[index], context, canvas, index, indices.length);
            reportProgress({ current: index + 1, total: indices.length });
            if (index + 1 < indices.length) await delay(setTimeoutFunction, frameDurationMs);
          }
          stopTimer = setTimeoutFunction(stopRecorder, frameDurationMs);
        } catch (error) {
          renderFailure = { status: 'fallback', reason: error && error.reason || 'canvas', frameCount: index, mimeType: mimeType };
          stopRecorder();
          finish(renderFailure);
        }
      })();
    });
  }

  return Object.freeze({
    FRAME_DURATION_MS: FRAME_DURATION_MS,
    MAX_BYTES: MAX_BYTES,
    MAX_FRAMES: MAX_FRAMES,
    MAX_HEIGHT: MAX_HEIGHT,
    MAX_WIDTH: MAX_WIDTH,
    boundedDimensions: boundedDimensions,
    encode: encode,
    eligibility: eligibility,
    frameIndices: frameIndices,
    supportedMimeType: supportedMimeType
  });
});
