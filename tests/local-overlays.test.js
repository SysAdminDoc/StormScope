'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const overlays = require('../js/local-overlays.js');

function file(name, type, text) { return { name, type, size: new TextEncoder().encode(text).length }; }

test('normalizes supported GeoJSON roots while retaining hostile values as inert text', () => {
  const input = JSON.stringify({ type: 'Feature', id: 7, properties: {
    name: '<img src=x onerror=alert(1)>', href: 'https://attacker.example/', style: 'url(https://attacker.example/x)'
  }, geometry: { type: 'LineString', coordinates: [[-180, -90, -12000], [180, 90, 100000]] } });
  const record = overlays.createRecord(file('route.geojson', 'application/geo+json', input), input, Date.UTC(2026, 6, 13));
  assert.equal(record.featureCount, 1);
  assert.equal(record.coordinateCount, 2);
  assert.equal(record.data.features[0].properties.name, '<img src=x onerror=alert(1)>');
  assert.deepEqual(overlays.style(record, 'LineString').color, '#4cc9f0');
});

test('rejects unsupported types, unsafe properties, invalid coordinates, and open rings atomically', () => {
  assert.throws(() => overlays.normalizeGeoJson({ type: 'GeometryCollection', geometries: [] }), /unsupported/);
  assert.throws(() => overlays.normalizeGeoJson({ type: 'Point', coordinates: [181, 0] }), /longitude/);
  assert.throws(() => overlays.normalizeGeoJson({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), /closed/);
  assert.throws(() => overlays.normalizeGeoJson({ type: 'Feature', properties: { nested: {} }, geometry: { type: 'Point', coordinates: [0, 0] } }), /nested/);
  const poisoned = JSON.parse('{"type":"Feature","properties":{"__proto__":"bad"},"geometry":{"type":"Point","coordinates":[0,0]}}');
  assert.throws(() => overlays.normalizeGeoJson(poisoned), /unsafe/);
});

test('parses GPX waypoints, routes, and segmented tracks without external entities', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
    <wpt lat="38" lon="-90"><name>Base &amp; Camp</name><ele>120</ele></wpt>
    <rte><name>Evacuation</name><rtept lat="38" lon="-90"></rtept><rtept lat="39" lon="-89"></rtept></rte>
    <trk><name>Survey</name><trkseg><trkpt lat="37" lon="-91"></trkpt><trkpt lat="38" lon="-90"></trkpt></trkseg>
    <trkseg><trkpt lat="39" lon="-89"></trkpt><trkpt lat="40" lon="-88"></trkpt></trkseg></trk></gpx>`;
  const normalized = overlays.parseGpx(gpx);
  assert.deepEqual(normalized.collection.features.map(item => item.geometry.type), ['Point', 'LineString', 'MultiLineString']);
  assert.equal(normalized.collection.features[0].properties.name, 'Base & Camp');
  assert.throws(() => overlays.parseGpx('<!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx></gpx>'), /invalid/);
});

test('validates extension, MIME, byte limits, and deterministic export round trips', () => {
  const text = JSON.stringify({ type: 'Point', coordinates: [-90, 38] });
  assert.throws(() => overlays.createRecord(file('map.exe', '', text), text), /type/);
  assert.throws(() => overlays.createRecord(file('map.gpx', 'application/json', text), text), /MIME/);
  assert.throws(() => overlays.createRecord({ name: 'map.json', type: 'application/json', size: overlays.MAX_FILE_BYTES + 1 }, text), /size/);
  const record = overlays.createRecord(file('plan.json', 'application/json', text), text, Date.UTC(2026, 6, 13));
  assert.deepEqual(overlays.normalizeGeoJson(overlays.exportOverlay(record)).collection, record.data);
  const bundle = overlays.exportBundle([record], Date.UTC(2026, 6, 13));
  assert.deepEqual(overlays.parseBundle(bundle), [record]);
  const future = JSON.parse(bundle); future.version = 2;
  assert.throws(() => overlays.parseBundle(future), /invalid/);
});

test('recovery snapshots are validated, detached, and retain persistence intent', () => {
  const text = JSON.stringify({ type: 'Point', coordinates: [-90, 38] });
  const record = overlays.createRecord(file('plan.json', 'application/json', text), text, Date.UTC(2026, 6, 13));
  record.persisted = true;
  record.layer = { remove() {} };
  const snapshots = overlays.recoverySnapshot([record]);
  assert.equal(snapshots[0].persisted, true);
  assert.equal(snapshots[0].record.id, record.id);
  assert.equal(Object.hasOwn(snapshots[0].record, 'layer'), false);
  snapshots[0].record.name = 'Changed';
  assert.equal(record.name, 'plan');
  assert.throws(() => overlays.recoverySnapshot([]), /recovery/);
  assert.throws(() => overlays.recoverySnapshot([{ id: 'invalid' }]), /record/);
});

test('computes exact bounds and enforces aggregate feature limits', () => {
  const collection = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-179, -10] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [179, 20] } }
  ] };
  assert.deepEqual(overlays.geometryBounds(collection), { west: -179, south: -10, east: 179, north: 20 });
  assert.throws(() => overlays.normalizeGeoJson({ type: 'FeatureCollection', features: Array.from({ length: overlays.MAX_FEATURES + 1 }, () => collection.features[0]) }), /feature limit/);
});
