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
        properties: { mag: 4.2, place: '10km N of Seattle', time: 1_699_999_000_000, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/a',
          detail: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/a.geojson' } },
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
  assert.equal(feature.properties.detailUrl, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/a.geojson');
  assert.equal(feature.properties.significant, false);
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

test('detail products select safe ShakeMap and DYFI contour URLs', () => {
  assert.equal(Earthquakes.detailUrl('https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/eq1.geojson'),
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/eq1.geojson');
  assert.equal(Earthquakes.detailUrl('javascript:alert(1)'), '');
  const detail = Earthquakes.normalizeDetail({
    type: 'Feature', id: 'eq1', properties: {
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/eq1', updated: 1700000000000,
      felt: 48, mmi: 6.2, cdi: 5.4,
      products: {
        shakemap: [{ preferredWeight: 1, updateTime: 1699999000000, source: 'us', contents: {
          'download/cont_mmi.json': { url: 'https://earthquake.usgs.gov/pdl/products/fixture/contents/download/cont_mmi.json' }
        } }],
        dyfi: [{ preferredWeight: 2, updateTime: 1699999500000, source: 'us', contents: {
          'dyfi_geo_10km.geojson': { url: 'https://earthquake.usgs.gov/pdl/products/fixture/contents/dyfi_geo_10km.geojson' }
        } }]
      }
    }
  });
  assert.equal(detail.eventId, 'eq1');
  assert.equal(detail.products.length, 2);
  assert.equal(detail.products[0].kind, 'shakemap');
  assert.equal(detail.products[1].kind, 'dyfi');
  assert.equal(Earthquakes.productUrl('https://attacker.example/pdl/products/evil'), '');
});

test('normalizes bounded ShakeMap lines and DYFI polygons without provider markup', () => {
  const shakemap = Earthquakes.normalizeIntensityCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-122, 47], [-121, 48]]] },
      properties: { value: 5, color: '<script>' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 47] }, properties: { value: 8 } }
  ] }, { kind: 'shakemap', eventId: 'eq1', issuedAt: 1700000000000,
    url: 'https://earthquake.usgs.gov/pdl/products/fixture/shake' });
  const dyfi = Earthquakes.normalizeIntensityCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-122, 47], [-121, 47], [-121, 48], [-122, 47]]] },
      properties: { cdi: 6.5, nresp: 12, dist: 9, name: '<b>Safe place</b>' } }
  ] }, { kind: 'dyfi', eventId: 'eq1', issuedAt: 1700000000000,
    url: 'https://earthquake.usgs.gov/pdl/products/fixture/dyfi' });
  assert.equal(shakemap.count, 1);
  assert.equal(shakemap.collection.features[0].properties.intensity, 5);
  assert.equal(shakemap.collection.features[0].properties.sourceLabel, 'USGS ShakeMap');
  assert.equal(dyfi.count, 1);
  assert.equal(dyfi.collection.features[0].properties.intensity, 6.5);
  assert.equal(dyfi.collection.features[0].properties.place, 'Safe place');
  assert.equal(Earthquakes.intensityStyle(dyfi.collection.features[0].properties).fillOpacity, 0.24);
  const merged = Earthquakes.mergeIntensityCollections([shakemap, dyfi]);
  assert.equal(merged.count, 2);
  assert.equal(merged.productCount, 2);
});
