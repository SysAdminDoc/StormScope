const assert = require('node:assert/strict');
const test = require('node:test');

const Earthquakes = require('../js/earthquakes.js');

test('buildFeedUrl validates magnitude and period against the keyless summary feeds', () => {
  assert.equal(
    Earthquakes.buildFeedUrl('2.5', 'day'),
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'
  );
  assert.equal(
    Earthquakes.buildFeedUrl('SIGNIFICANT', 'WEEK'),
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson'
  );
  assert.throws(() => Earthquakes.buildFeedUrl('3.0', 'day'), /magnitude is unsupported/);
  assert.throws(() => Earthquakes.buildFeedUrl('2.5', 'year'), /period is unsupported/);
  assert.throws(() => Earthquakes.buildFeedUrl(null, null), /magnitude is unsupported/);
});

test('normalizeCollection keeps valid points, dedupes, and extracts fields', () => {
  const payload = {
    type: 'FeatureCollection',
    metadata: { generated: 1_700_000_000_000 },
    features: [
      { type: 'Feature', id: 'a', geometry: { type: 'Point', coordinates: [-122.3, 47.6, 12] },
        properties: { mag: 4.2, place: '10km N of Seattle', time: 1_699_999_000_000, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/a' } },
      { type: 'Feature', id: 'a', geometry: { type: 'Point', coordinates: [-122.3, 47.6, 12] },
        properties: { mag: 4.2 } }, // duplicate id → dropped
      { type: 'Feature', id: 'b', geometry: { type: 'Point', coordinates: [200, 99, 5] },
        properties: { mag: 3.1 } }, // out of range → dropped
      { type: 'Feature', id: 'c', geometry: { type: 'Polygon', coordinates: [] },
        properties: { mag: 5 } }, // non-point → dropped
      { type: 'Feature', id: 'd', geometry: { type: 'Point', coordinates: [10, 10] },
        properties: { mag: 'x' } } // non-finite mag → dropped
    ]
  };
  const result = Earthquakes.normalizeCollection(payload);
  assert.equal(result.count, 1);
  assert.equal(result.generatedAt, 1_700_000_000_000);
  const feature = result.collection.features[0];
  assert.equal(feature.properties.mag, 4.2);
  assert.equal(feature.properties.place, '10km N of Seattle');
  assert.equal(feature.properties.depthKm, 12);
  assert.equal(feature.properties.time, 1_699_999_000_000);
  assert.deepEqual(feature.geometry.coordinates, [-122.3, 47.6]);
});

test('normalizeCollection rejects non-GeoJSON payloads', () => {
  assert.throws(() => Earthquakes.normalizeCollection(null), /not GeoJSON/);
  assert.throws(() => Earthquakes.normalizeCollection({ type: 'Feature' }), /not GeoJSON/);
});

test('marker radius and color scale monotonically with magnitude', () => {
  assert.ok(Earthquakes.markerRadius(1) < Earthquakes.markerRadius(5));
  assert.equal(Earthquakes.markerRadius(100), 18); // clamped
  assert.equal(Earthquakes.markerRadius(-10), 3); // clamped
  assert.equal(Earthquakes.markerColor(6.5), '#d6336c');
  assert.equal(Earthquakes.markerColor(1.0), '#74b816');
});

test('freshness compares snapshot age against the stale threshold', () => {
  const now = 2_000_000_000_000;
  assert.equal(Earthquakes.freshness(now - 60_000, 15 * 60 * 1000, now).state, 'fresh');
  assert.equal(Earthquakes.freshness(now - 60 * 60 * 1000, 15 * 60 * 1000, now).state, 'stale');
  assert.equal(Earthquakes.freshness(null, 1000, now).state, 'unknown');
});
