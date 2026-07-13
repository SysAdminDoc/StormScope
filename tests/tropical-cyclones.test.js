'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tropical = require('../js/tropical-cyclones.js');

function collection(features) { return { type: 'FeatureCollection', features }; }
function feature(geometry, properties) { return { type: 'Feature', geometry, properties }; }
function ok(features) { return { ok: true, collection: collection(features) }; }

test('builds bounded official ArcGIS GeoJSON queries', () => {
  const url = new URL(tropical.buildQueryUrl('cone'));
  assert.equal(url.origin, 'https://mapservices.weather.noaa.gov');
  assert.match(url.pathname, /NHC_tropical_weather_summary\/MapServer\/7\/query$/);
  assert.equal(url.searchParams.get('where'), '1=1');
  assert.equal(url.searchParams.get('returnGeometry'), 'true');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.doesNotMatch(url.searchParams.get('outFields'), /\*/);
});

test('groups matching advisory products and excludes stale advisory geometry', () => {
  const props = { binnumber: 'AT1', stormname: 'ALPHA', stormtype: 'HU', advisnum: '12', tau: 0,
    maxwind: 90, mslp: 970, idp_filedate: '2026-07-12T12:00:00Z' };
  const snapshot = tropical.normalizeSnapshot({
    points: ok([
      feature({ type: 'Point', coordinates: [-70, 25] }, props),
      feature({ type: 'Point', coordinates: [-72, 27] }, { ...props, tau: 12 })
    ]),
    track: ok([feature({ type: 'LineString', coordinates: [[-70, 25], [-72, 27]] }, { ...props })]),
    cone: ok([
      feature({ type: 'Polygon', coordinates: [[[-71, 24], [-69, 24], [-70, 26], [-71, 24]]] }, { ...props }),
      feature({ type: 'Polygon', coordinates: [[[-73, 26], [-71, 26], [-72, 28], [-73, 26]]] }, { ...props, advisnum: '11' })
    ]),
    watches: ok([])
  });
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.storms.length, 1);
  assert.equal(snapshot.storms[0].features.filter(item => item.properties.kind === 'cone').length, 1);
  assert.equal(snapshot.storms[0].currentPoint.properties.kind, 'center');
  assert.match(snapshot.storms[0].links.advisory, /graphics_at1\.shtml$/);
});

test('distinguishes no-active, partial, and unavailable responses', () => {
  const empty = { points: ok([]), track: ok([]), cone: ok([]), watches: ok([]) };
  assert.equal(tropical.normalizeSnapshot(empty).state, 'no-active');
  assert.equal(tropical.normalizeSnapshot({ ...empty, cone: { ok: false } }).state, 'partial');
  assert.equal(tropical.normalizeSnapshot({}).state, 'unavailable');
});

test('rejects malformed or unbounded GeoJSON and exposes watch dash patterns', () => {
  assert.throws(() => tropical.validateCollection(collection([
    feature({ type: 'Point', coordinates: [181, 20] }, {})
  ])), /Invalid NHC/);
  assert.equal(tropical.warningStyle('HWA').dashArray, '8 5');
  assert.equal(tropical.warningStyle('HWR').dashArray, null);
  assert.notEqual(tropical.warningStyle('TWA').weight, tropical.warningStyle('HWA').weight);
});
