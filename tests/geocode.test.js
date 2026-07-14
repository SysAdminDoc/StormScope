const assert = require('node:assert/strict');
const test = require('node:test');

const Geocode = require('../js/geocode.js');

test('query normalization collapses whitespace and enforces a minimum length', () => {
  assert.equal(Geocode.normalizeQuery('  New   York  '), 'New York');
  assert.throws(() => Geocode.photonUrl('ab'), /too short/);
  assert.throws(() => Geocode.nominatimUrl('  '), /too short/);
});

test('provider URLs are keyless, bounded, and target the OSM services', () => {
  const photon = Geocode.photonUrl('Seattle');
  assert.match(photon, /^https:\/\/photon\.komoot\.io\/api\?/);
  assert.match(photon, /q=Seattle/);
  assert.match(photon, /limit=5/);
  const nominatim = Geocode.nominatimUrl('Seattle');
  assert.match(nominatim, /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
  assert.match(nominatim, /format=jsonv2/);
  assert.match(nominatim, /limit=5/);
});

test('parsePhoton keeps valid points, builds labels, and drops invalid coordinates', () => {
  const results = Geocode.parsePhoton({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.33, 47.6] }, properties: { name: 'Seattle', state: 'Washington', country: 'United States' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 0] }, properties: { name: 'Bad' } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { name: 'NotPoint' } }
    ]
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'Seattle, Washington, United States');
  assert.equal(results[0].lat, 47.6);
  assert.equal(results[0].lon, -122.33);
});

test('parseNominatim keeps valid rows and rejects malformed payloads', () => {
  const results = Geocode.parseNominatim([
    { lat: '47.6', lon: '-122.33', display_name: 'Seattle, WA, USA' },
    { lat: 'x', lon: '0', display_name: 'Bad' }
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'Seattle, WA, USA');
  assert.throws(() => Geocode.parseNominatim({}), /not an array/);
});

test('parsePhoton rejects non-GeoJSON payloads', () => {
  assert.throws(() => Geocode.parsePhoton(null), /not GeoJSON/);
  assert.throws(() => Geocode.parsePhoton({ type: 'Feature' }), /not GeoJSON/);
});
