const assert = require('node:assert/strict');
const test = require('node:test');

const RadarExport = require('../js/radar-export.js');

function canvas() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return {
    getContext() { return {}; },
    captureStream() { return { getTracks() { return tracks; } }; },
    tracks
  };
}

class FakeRecorder {
  static isTypeSupported(type) { return type === 'video/webm;codecs=vp8'; }

  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }

  start() { this.state = 'recording'; }

  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob(['radar-frame']) });
    if (this.onstop) this.onstop();
  }
}

class OversizedRecorder extends FakeRecorder {
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(2048)]) });
    if (this.onstop) this.onstop();
  }
}

test('radar export bounds frames, dimensions, and encoder selection', () => {
  assert.deepEqual(RadarExport.frameIndices(20), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(RadarExport.frameIndices(20, 4, 2), [0, 1, 2, 3]);
  assert.deepEqual(RadarExport.frameIndices(3, 12), [0, 1, 2]);
  assert.deepEqual(RadarExport.boundedDimensions(1920, 1080), { width: 512, height: 288 });
  assert.deepEqual(RadarExport.boundedDimensions(320, 720), { width: 128, height: 288 });
  assert.equal(RadarExport.boundedDimensions(0, 720), null);
  assert.equal(RadarExport.supportedMimeType(FakeRecorder), 'video/webm;codecs=vp8');
  assert.equal(RadarExport.supportedMimeType(function Unsupported() { }), 'video/webm');
});

test('radar export eligibility honors opt-in, motion, data, visibility, and capability gates', () => {
  const base = { optIn: true, frameCount: 3, width: 1024, height: 576, MediaRecorder: FakeRecorder };
  assert.equal(RadarExport.eligibility({ ...base, optIn: false }).reason, 'disabled');
  assert.equal(RadarExport.eligibility({ ...base, lowData: true }).reason, 'low-data');
  assert.equal(RadarExport.eligibility({ ...base, reducedMotion: true }).reason, 'reduced-motion');
  assert.equal(RadarExport.eligibility({ ...base, visible: false }).reason, 'hidden');
  assert.equal(RadarExport.eligibility({ ...base, frameCount: 1 }).reason, 'frames');
  assert.equal(RadarExport.eligibility({ ...base, MediaRecorder: null }).reason, 'encoder');
  assert.equal(RadarExport.eligibility({ ...base, captureStreamSupported: false }).reason, 'capture-stream');
  const ready = RadarExport.eligibility({ ...base, canvas: canvas() });
  assert.equal(ready.enabled, true);
  assert.deepEqual({ width: ready.width, height: ready.height }, { width: 512, height: 288 });
  assert.equal(ready.maxFrames, 12);
  assert.equal(ready.maxBytes, 8 * 1024 * 1024);
});

test('radar export encodes locally, reports progress, and stops its capture tracks', async () => {
  const target = canvas();
  const progress = [];
  const result = await RadarExport.encode({
    canvas: target,
    MediaRecorder: FakeRecorder,
    mimeType: 'video/webm;codecs=vp8',
    frameIndices: [2, 3, 4],
    frameDurationMs: 100,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    drawFrame: async (index, context, outputCanvas, current, total) => {
      assert.ok(outputCanvas === target);
      assert.equal(typeof context, 'object');
      assert.equal(index, current + 2);
      assert.equal(total, 3);
    },
    onProgress: (value) => progress.push(value.current)
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.frameCount, 3);
  assert.equal(result.mimeType, 'video/webm;codecs=vp8');
  assert.ok(result.blob.size > 0);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(target.tracks[0].stopped, true);
});

test('radar export reports bounded-size and canvas fallbacks', async () => {
  const oversized = await RadarExport.encode({
    canvas: canvas(),
    MediaRecorder: OversizedRecorder,
    frameIndices: [0, 1],
    maxBytes: 1024,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    drawFrame: () => {}
  });
  assert.equal(oversized.status, 'fallback');
  assert.equal(oversized.reason, 'size');

  const failed = await RadarExport.encode({
    canvas: canvas(),
    MediaRecorder: FakeRecorder,
    frameIndices: [0, 1],
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    drawFrame: () => { const error = new Error('tainted'); error.reason = 'canvas'; throw error; }
  });
  assert.equal(failed.status, 'fallback');
  assert.equal(failed.reason, 'canvas');
});
