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
