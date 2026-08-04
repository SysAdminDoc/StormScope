const assert = require('node:assert/strict');
const test = require('node:test');

const SPC = require('../js/fire-weather.js');

function polygon(offset = 0) {
  return { type: 'Polygon', coordinates: [[[-100 + offset, 38], [-98 + offset, 38], [-98 + offset, 40], [-100 + offset, 40], [-100 + offset, 38]]] };
}

test('Day 1–8 layers map to official wind/RH and dry-thunderstorm services', () => {
  assert.deepEqual(SPC.DAY_LAYERS[1], { windRh: 1, dryThunderstorm: 2 });
  assert.deepEqual(SPC.DAY_LAYERS[3], { windRh: 8, dryThunderstorm: 7 });
  assert.deepEqual(SPC.DAY_LAYERS[8], { windRh: 23, dryThunderstorm: 22 });
  assert.match(SPC.queryUrl(8, 'windRh', { west: -110, south: 30, east: -100, north: 45 }), /SPC_firewx\/MapServer\/23\/query/);
  assert.match(SPC.queryUrl(2, 'dryThunderstorm', { west: -110, south: 30, east: -100, north: 45 }), /geometryType=esriGeometryEnvelope/);
  assert.throws(() => SPC.queryUrl(9, 'windRh', { west: -110, south: 30, east: -100, north: 45 }), /day is invalid/);
  assert.throws(() => SPC.queryUrl(1, 'unknown', { west: -110, south: 30, east: -100, north: 45 }), /kind is invalid/);
});

test('viewport queries split dateline envelopes without broadening the request', () => {
  const queries = SPC.buildQueries(4, { west: 170, south: 20, east: 190, north: 50 });
  assert.equal(queries.length, 4);
  assert.deepEqual(queries.map((query) => [query.kind, query.bounds.west, query.bounds.east]), [
    ['windRh', 170, 180], ['dryThunderstorm', 170, 180],
    ['windRh', -180, -170], ['dryThunderstorm', -180, -170]
  ]);
  queries.forEach((query) => assert.match(query.url, /geometry=170%2C20%2C180%2C50|geometry=-180%2C20%2C-170%2C50/));
});

test('risk category prefers official labels and falls back to day-specific dn values', () => {
  assert.equal(SPC.category({ label: 'Critical (40%)', dn: 5 }, 'windRh'), 'critical');
  assert.equal(SPC.category({ label: 'Scattered DryT' }, 'dryThunderstorm'), 'scatteredDry');
  assert.equal(SPC.category({ label: '', dn: 10 }, 'windRh'), 'extreme');
  assert.equal(SPC.category({ label: '', dn: 5 }, 'dryThunderstorm'), 'isolatedDry');
  assert.equal(SPC.category({ label: 'administrative' }, 'windRh'), null);
});

test('normalization keeps forecast metadata, official colors, and drops expired polygons', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const result = SPC.normalizeCollection({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: polygon(), properties: {
        objectid: 1, label: 'Critical (40%)', issue: '2026-08-03T06:00:00Z', valid: '2026-08-03T12:00:00Z',
        expire: '2026-08-04T12:00:00Z', idp_source: 'SPC fixture', stroke: '#123456', fill: '#abcdef'
      } },
      { type: 'Feature', geometry: polygon(1), properties: { objectid: 2, label: 'Elevated', expire: '2026-08-03T11:59:00Z' } },
      { type: 'Feature', geometry: polygon(2), properties: { objectid: 3, label: 'Unknown' } }
    ]
  }, 1, 'windRh', now);
  assert.equal(result.features.length, 1);
  const properties = result.features[0].properties;
  assert.equal(properties.fireWeatherCategory, 'critical');
  assert.equal(properties.fireWeatherKind, 'windRh');
  assert.equal(properties.outlookDay, 1);
  assert.equal(properties.issuedAt, '2026-08-03T06:00:00.000Z');
  assert.equal(properties.startsAt, '2026-08-03T12:00:00.000Z');
  assert.equal(properties.endsAt, '2026-08-04T12:00:00.000Z');
  assert.equal(properties.strokeColor, '#123456');
  assert.equal(SPC.style(properties.fireWeatherCategory, properties).fillColor, '#abcdef');
  assert.equal(properties.officialUrl, SPC.OFFICIAL_URL);
});

test('pagination follows ArcGIS transfer limits and merges duplicate dateline pages', async () => {
  let calls = 0;
  const result = await SPC.fetchAllPages(async (url) => {
    calls += 1;
    const offset = Number(new URL(url).searchParams.get('resultOffset'));
    return {
      ok: true,
      json: async () => ({
        type: 'FeatureCollection',
        exceededTransferLimit: offset === 0,
        features: [{ type: 'Feature', geometry: polygon(offset), properties: { objectid: offset + 1, label: 'Elevated' } }]
      })
    };
  }, { day: 1, kind: 'windRh', bounds: { west: -110, south: 30, east: -90, north: 45 } });
  assert.equal(calls, 2);
  assert.equal(result.features.length, 2);

  const merged = SPC.mergeCollections([result, { type: 'FeatureCollection', features: [result.features[0]] }]);
  assert.equal(merged.features.length, 2);
});

test('styles and freshness expose bounded operational state', () => {
  assert.equal(SPC.style('extreme').fillColor, '#e600a9');
  assert.equal(SPC.style('isolatedDry').dashArray, '6 4');
  assert.throws(() => SPC.style('unknown'), /style is invalid/);
  const now = 2_000_000_000_000;
  assert.equal(SPC.freshness(now - 30 * 60 * 1000, 3 * 60 * 60 * 1000, now).state, 'fresh');
  assert.equal(SPC.freshness(now - 4 * 60 * 60 * 1000, 3 * 60 * 60 * 1000, now).state, 'stale');
  assert.equal(SPC.freshness(null, 1000, now).state, 'unknown');
});
