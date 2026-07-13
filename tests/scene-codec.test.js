'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const codec = require('../js/scene-codec.js');

function scene(overrides = {}) {
  return Object.assign({
    map: { lat: 39.123456, lon: -98.654321, zoom: 7 },
    layers: {
      radar: true, cameras: true, coverage: false, alerts: true,
      lightning: false, wildfires: true, satellite: false, tropical: true, wpcOutlooks: true, usgsGauges: false
    },
    radar: { opacity: 0.72, palette: 'colorblind', speed: 400, frameTime: 1783796400000 },
    alertSeverity: 'severe',
    cameraFilters: { query: 'río', state: 'New Mexico', source: 'dot', type: 'image', sort: 'distance', healthy: true },
    activeCameraId: 31415,
    outlookDay: 2
  }, overrides);
}

test('versioned scene token round-trips every documented public field', () => {
  const token = codec.encode(scene());
  assert.match(token, /^1\.[A-Za-z0-9_-]+$/);
  assert.ok(token.length < 512);
  assert.deepEqual(codec.decode(token), {
    map: { lat: 39.12346, lon: -98.65432, zoom: 7 },
    layers: {
      radar: true, cameras: true, coverage: false, alerts: true,
      lightning: false, wildfires: true, satellite: false, tropical: true, wpcOutlooks: true, usgsGauges: false
    },
    radar: { opacity: 0.72, palette: 'colorblind', speed: 400, frameTime: 1783796400000 },
    alertSeverity: 'severe',
    cameraFilters: { query: 'río', state: 'New Mexico', source: 'dot', type: 'image', sort: 'distance', healthy: true },
    activeCameraId: '31415',
    outlookDay: 2
  });
  assert.deepEqual(codec.fromHash('#' + codec.toHash(scene())), codec.decode(token));
});

test('favorites, saved views, locale, theme, and unknown private fields are never encoded', () => {
  const input = scene({ favorites: ['secret'], savedViews: [{ name: 'private' }], locale: 'es', theme: 'dark', token: 'secret' });
  const token = codec.encode(input);
  const serialized = JSON.stringify(codec.decode(token));
  assert.doesNotMatch(serialized, /favorite|savedViews|locale|theme|secret/);
});

test('decodes legacy scene tokens with appended layers disabled and Day 1 selected', () => {
  const legacyPayload = {
    v: 1,
    m: [39.12346, -98.65432, 7],
    l: 43,
    r: [72, 1, 2, 1783796400000],
    a: 3,
    f: ['río', 'New Mexico', 2, 1, 1, 1],
    c: '31415'
  };
  const token = '1.' + Buffer.from(JSON.stringify(legacyPayload), 'utf8').toString('base64url');
  const decoded = codec.decode(token);
  assert.equal(decoded.layers.satellite, false);
  assert.equal(decoded.layers.tropical, false);
  assert.equal(decoded.layers.wpcOutlooks, false);
  assert.equal(decoded.layers.usgsGauges, false);
  assert.equal(decoded.layers.wildfires, true);
  assert.equal(decoded.outlookDay, 1);
});

test('invalid, oversized, future, and old scene URLs fail closed', () => {
  assert.throws(() => codec.decode('0.e30'), /version/);
  assert.throws(() => codec.decode('2.e30'), /version/);
  assert.throws(() => codec.decode('1.%%%'), /encoding/);
  assert.throws(() => codec.decode('1.' + 'a'.repeat(codec.MAX_TOKEN_LENGTH)), /length/);
  assert.throws(() => codec.encode(scene({ map: { lat: 91, lon: 0, zoom: 1 } })), /latitude/);
  assert.throws(() => codec.encode(scene({ radar: { opacity: 1, palette: 'animated', speed: 800, frameTime: null } })), /palette/);
  assert.throws(() => codec.encode(scene({ radar: { opacity: 1, palette: 'standard', speed: 123, frameTime: null } })), /speed/);
  const excessiveLayerBits = Buffer.from(JSON.stringify({
    v: 1, m: [0, 0, 1], l: 1024, r: [50, 0, 0, null], a: 0, f: ['', '', 0, 0, 0, 0], c: null
  }), 'utf8').toString('base64url');
  assert.throws(() => codec.decode('1.' + excessiveLayerBits), /shape/);
  assert.equal(codec.fromHash('#unrelated=value'), null);
});
