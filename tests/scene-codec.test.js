'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const codec = require('../js/scene-codec.js');

function scene(overrides = {}) {
  return Object.assign({
    map: { lat: 39.123456, lon: -98.654321, zoom: 7 },
    layers: {
      radar: true, cameras: true, coverage: false, alerts: true,
      lightning: false, wildfires: true, satellite: false, terminator: false, snow: false, surfaceObservations: false, tropical: true, wpcOutlooks: true, wssi: false, usgsGauges: false, earthquakes: false, convective: false, fireWeather: false, watches: false, mesoscale: false, stormReports: false, spaceWeather: false, marineBuoys: false
    },
    radar: { opacity: 0.72, palette: 'colorblind', speed: 400, frameTime: 1783796400000 },
    alertSeverity: 'severe',
    cameraFilters: { query: 'río', state: 'New Mexico', source: 'dot', type: 'image', sort: 'distance', healthy: true },
    activeCameraId: 31415,
    outlookDay: 2,
    convectiveDay: 3, fireWeatherDay: 6, stormReportWindow: 48,
    earthquake: { magnitude: '4.5', period: 'week' }
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
      lightning: false, wildfires: true, satellite: false, terminator: false, snow: false, surfaceObservations: false, tropical: true, wpcOutlooks: true, wssi: false, usgsGauges: false, earthquakes: false, convective: false, fireWeather: false, watches: false, mesoscale: false, stormReports: false, spaceWeather: false, marineBuoys: false
    },
    radar: { opacity: 0.72, palette: 'colorblind', speed: 400, frameTime: 1783796400000 },
    alertSeverity: 'severe',
    cameraFilters: { query: 'río', state: 'New Mexico', source: 'dot', type: 'image', sort: 'distance', healthy: true },
    activeCameraId: '31415',
    outlookDay: 2,
    convectiveDay: 3, fireWeatherDay: 6, stormReportWindow: 48,
    earthquake: { magnitude: '4.5', period: 'week' }
  });
  assert.deepEqual(codec.fromHash('#' + codec.toHash(scene())), codec.decode(token));
});

test('scene layer bit positions are pinned and independent of registry order', () => {
  // Locking these values guards every previously shared scene link: changing a bit position
  // (e.g. by reordering the layer registry) must be a deliberate, VERSION-bumping change that
  // fails this test first.
  assert.deepEqual(codec.layerBits, [
    { id: 'radar', bit: 0, legacyRequired: true },
    { id: 'cameras', bit: 1, legacyRequired: true },
    { id: 'coverage', bit: 2, legacyRequired: true },
    { id: 'alerts', bit: 3, legacyRequired: true },
    { id: 'lightning', bit: 4, legacyRequired: true },
    { id: 'wildfires', bit: 5, legacyRequired: true },
    { id: 'satellite', bit: 6, legacyRequired: true },
    { id: 'tropical', bit: 7, legacyRequired: false },
    { id: 'wpcOutlooks', bit: 8, legacyRequired: false },
    { id: 'usgsGauges', bit: 9, legacyRequired: false },
    { id: 'earthquakes', bit: 10, legacyRequired: false },
    { id: 'convective', bit: 11, legacyRequired: false },
    { id: 'watches', bit: 12, legacyRequired: false },
    { id: 'mesoscale', bit: 13, legacyRequired: false },
    { id: 'stormReports', bit: 14, legacyRequired: false },
    { id: 'terminator', bit: 15, legacyRequired: false },
    { id: 'snow', bit: 16, legacyRequired: false },
    { id: 'surfaceObservations', bit: 17, legacyRequired: false },
    { id: 'fireWeather', bit: 18, legacyRequired: false },
    { id: 'wssi', bit: 19, legacyRequired: false },
    { id: 'spaceWeather', bit: 20, legacyRequired: false },
    { id: 'marineBuoys', bit: 21, legacyRequired: false }
  ]);

  // Enabling exactly one layer must set exactly its pinned bit in the wire payload `l`.
  codec.layerBits.forEach((entry) => {
    const onlyThis = {};
    codec.layerBits.forEach((other) => { onlyThis[other.id] = other.id === entry.id; });
    const token = codec.encode(scene({ layers: onlyThis }));
    const payload = JSON.parse(Buffer.from(token.slice(2), 'base64url').toString('utf8'));
    assert.equal(payload.l, 1 << entry.bit, entry.id + ' encodes to the wrong scene bit');
  });
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
  assert.equal(decoded.layers.earthquakes, false);
  assert.equal(decoded.layers.convective, false);
  assert.equal(decoded.layers.watches, false);
  assert.equal(decoded.layers.mesoscale, false);
  assert.equal(decoded.layers.stormReports, false);
  assert.equal(decoded.layers.terminator, false);
  assert.equal(decoded.layers.snow, false);
  assert.equal(decoded.layers.surfaceObservations, false);
  assert.equal(decoded.layers.fireWeather, false);
  assert.equal(decoded.layers.wssi, false);
  assert.equal(decoded.layers.wildfires, true);
  assert.equal(decoded.outlookDay, 1);
  assert.equal(decoded.convectiveDay, 1);
  assert.equal(decoded.fireWeatherDay, 1);
  assert.equal(decoded.stormReportWindow, 24);
  assert.deepEqual(decoded.earthquake, { magnitude: '2.5', period: 'day' });
});

test('invalid, oversized, future, and old scene URLs fail closed', () => {
  assert.throws(() => codec.decode('0.e30'), /version/);
  assert.throws(() => codec.decode('2.e30'), /version/);
  assert.throws(() => codec.decode('1.%%%'), /encoding/);
  assert.throws(() => codec.decode('1.' + 'a'.repeat(codec.MAX_TOKEN_LENGTH)), /length/);
  assert.throws(() => codec.encode(scene({ map: { lat: 91, lon: 0, zoom: 1 } })), /latitude/);
  assert.throws(() => codec.encode(scene({ radar: { opacity: 1, palette: 'animated', speed: 800, frameTime: null } })), /palette/);
  assert.throws(() => codec.encode(scene({ radar: { opacity: 1, palette: 'standard', speed: 123, frameTime: null } })), /speed/);
  assert.throws(() => codec.encode(scene({ convectiveDay: 4 })), /convective day/);
  assert.throws(() => codec.encode(scene({ fireWeatherDay: 9 })), /fire-weather day/);
  assert.throws(() => codec.encode(scene({ stormReportWindow: 36 })), /storm report window/);
  assert.throws(() => codec.encode(scene({ earthquake: { magnitude: '3.0', period: 'day' } })), /magnitude/);
  assert.throws(() => codec.encode(scene({ earthquake: { magnitude: '2.5', period: 'year' } })), /period/);
  const excessiveLayerBits = Buffer.from(JSON.stringify({
    v: 1, m: [0, 0, 1], l: 4194304, r: [50, 0, 0, null], a: 0, f: ['', '', 0, 0, 0, 0], c: null
  }), 'utf8').toString('base64url');
  assert.throws(() => codec.decode('1.' + excessiveLayerBits), /shape/);
  assert.equal(codec.fromHash('#unrelated=value'), null);
});
