'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cameraFeed = require('../js/camera-feed.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.src = '';
    this.style = {};
  }

  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  pause() { this.paused = true; }
  load() { this.loaded = true; }
  querySelector() { return null; }
  querySelectorAll(tagName) {
    const expected = tagName.toUpperCase();
    const matches = [];
    function visit(node) {
      if (node.tagName === expected) matches.push(node);
      node.children.forEach(visit);
    }
    this.children.forEach(visit);
    return matches;
  }
}

test('embed allowlist is exact and HTTPS-only', () => {
  assert.equal(cameraFeed.hostMatchesSuffix('earthcam.com', 'earthcam.com'), true);
  assert.equal(cameraFeed.hostMatchesSuffix('www.earthcam.com', 'earthcam.com'), true);
  assert.equal(cameraFeed.hostMatchesSuffix('earthcam.com.attacker.test', 'earthcam.com'), false);
  assert.equal(cameraFeed.isAllowedEmbedUrl('https://www.earthcam.com/live'), true);
  assert.equal(cameraFeed.isAllowedEmbedUrl('http://www.earthcam.com/live'), false);
  assert.equal(cameraFeed.isAllowedEmbedUrl('https://notearthcam.com/live'), false);
});

test('still-frame heuristic flags bounded flat pixels without mutating feed health', () => {
  const flat = new Uint8ClampedArray(32 * 24 * 4);
  for (let index = 0; index < flat.length; index += 4) {
    flat[index] = 8;
    flat[index + 1] = 8;
    flat[index + 2] = 8;
    flat[index + 3] = 255;
  }
  const flatResult = cameraFeed.analyzeFramePixels(flat, 32, 24);
  assert.equal(flatResult.state, 'ready');
  assert.equal(flatResult.likelyOutage, true);
  assert.equal(flatResult.reason, cameraFeed.REASON_FLAT_FRAME);
  assert.ok(flatResult.samples <= 4096);

  const varied = new Uint8ClampedArray(32 * 24 * 4);
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const offset = (y * 32 + x) * 4;
      varied[offset] = x * 8;
      varied[offset + 1] = y * 10;
      varied[offset + 2] = (x * 13 + y * 7) % 256;
      varied[offset + 3] = 255;
    }
  }
  assert.equal(cameraFeed.analyzeFramePixels(varied, 32, 24).likelyOutage, false);
});

test('still-frame detector flags repeated pixels only after the bounded threshold', () => {
  const detector = cameraFeed.createFrameDetector({ stalledFrameThreshold: 3 });
  const frame = { state: 'ready', likelyOutage: false, reason: null, signature: 'same-frame' };
  assert.equal(detector.observe(frame).likelyOutage, false);
  assert.equal(detector.observe(frame).likelyOutage, false);
  const stalled = detector.observe(frame);
  assert.equal(stalled.likelyOutage, true);
  assert.equal(stalled.reason, cameraFeed.REASON_STALLED_FRAME);
  assert.equal(stalled.stalledFrames, 3);
  detector.reset();
  assert.equal(detector.observe({ state: 'unavailable', likelyOutage: false }).likelyOutage, false);
});

test('opt-in image analysis records a visible outage observation without changing catalog health', () => {
  const observations = [];
  const document = { createElement: tagName => new FakeElement(tagName) };
  const player = cameraFeed.create({
    document,
    Hls: null,
    origin: 'https://stormscope.example',
    translate: key => key,
    localNumber: String,
    imageRefreshInterval: () => 15000,
    isActive: () => true,
    recordObservation: (camera, outcome, reason) => observations.push({ camera, outcome, reason }),
    analyzeImage: () => ({ state: 'ready', likelyOutage: true, reason: cameraFeed.REASON_FLAT_FRAME, signature: 'flat' }),
    setTimeout: () => 41,
    clearTimeout: () => {},
    now: () => 123
  });
  const camera = { type: 'image', url: 'https://camera.example/frame.jpg', name: 'Test', health: 'healthy' };
  const container = new FakeElement('div');
  player.load(camera, container);
  container.querySelectorAll('img')[0].onload();
  assert.deepEqual(observations.map(({ outcome, reason }) => ({ outcome, reason })), [
    { outcome: cameraFeed.OUTAGE_OUTCOME, reason: cameraFeed.REASON_FLAT_FRAME }
  ]);
  assert.equal(camera.health, 'healthy');
});

test('YouTube URL binds the embedder origin and player destroy owns frame cleanup', () => {
  const cancelled = [];
  const document = { createElement: tagName => new FakeElement(tagName) };
  const player = cameraFeed.create({
    document,
    Hls: null,
    origin: 'https://stormscope.example',
    translate: key => key,
    localNumber: String,
    imageRefreshInterval: () => 15000,
    isActive: () => true,
    recordObservation: () => {},
    setTimeout: () => 41,
    clearTimeout: timer => cancelled.push(timer),
    now: () => 123
  });
  const container = new FakeElement('div');
  player.load({ type: 'youtube', url: 'abcdefghijk', name: 'Test camera' }, container);
  const frame = container.querySelectorAll('iframe')[0];
  assert.match(frame.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/abcdefghijk\?/);
  assert.match(frame.src, /origin=https%3A%2F%2Fstormscope\.example/);
  assert.equal(typeof player.destroy, 'function');

  player.destroy();
  player.destroy();
  assert.equal(frame.src, 'about:blank');
  assert.deepEqual(cancelled, [41]);
});
