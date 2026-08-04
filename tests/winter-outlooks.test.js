'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wssi = require('../js/winter-outlooks.js');

function polygon(properties) {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[-100, 35], [-99, 35], [-99, 36], [-100, 35]]] },
    properties
  };
}

test('builds the bounded aggregate WSSI ArcGIS GeoJSON query', () => {
  const url = new URL(wssi.queryUrl(500));
  assert.match(url.pathname, /wpc_wssi\/MapServer\/4\/query$/);
  assert.equal(url.searchParams.get('resultOffset'), '500');
  assert.equal(url.searchParams.get('resultRecordCount'), '500');
  assert.equal(url.searchParams.get('orderByFields'), 'objectid ASC');
  assert.doesNotMatch(url.searchParams.get('outFields'), /\*/);
  assert.match(url.searchParams.get('outFields'), /impact/);
});

test('normalizes official impact categories, issue/valid periods, and source metadata', () => {
  const result = wssi.normalizeCollection({ type: 'FeatureCollection', features: [
    polygon({ objectid: 3, impact: 'EXTREME', issue_time: '2026-01-13 01:03:00', start_time: '2026-01-14 00:00:00', end_time: '2026-01-17 00:00:00', idp_source: 'WPC fixture' }),
    polygon({ objectid: 1, impact: 'WINTER WEATHER AREA', issue_time: '2026-01-13T01:03:00Z', start_time: '2026-01-14T00:00:00Z', end_time: '2026-01-15T00:00:00Z' }),
    polygon({ objectid: 2, impact: 'MODERATE', issue_time: '2026-01-13T01:03:00Z', start_time: '2026-01-14T00:00:00Z', end_time: '2026-01-16T00:00:00Z' })
  ] });
  assert.deepEqual(result.features.map((feature) => feature.properties.wssiCategory), ['winter', 'moderate', 'extreme']);
  assert.equal(result.features[0].properties.sourceLabel, 'NOAA/NWS/WPC WSSI');
  assert.equal(result.features[2].properties.sourceLabel, 'WPC fixture');
  assert.equal(result.features[2].properties.issuedAt, '2026-01-13T01:03:00.000Z');
  assert.equal(result.features[2].properties.startsAt, '2026-01-14T00:00:00.000Z');
  assert.equal(result.features[2].properties.endsAt, '2026-01-17T00:00:00.000Z');
  assert.deepEqual(wssi.style('extreme'), { color: '#6e6e6e', fillColor: '#7853a1', weight: 1, fillOpacity: 0.35 });
});

test('rejects unsupported impact classes and non-polygon geometry', () => {
  assert.throws(() => wssi.normalizeCollection({ type: 'FeatureCollection', features: [
    polygon({ impact: 'UNKNOWN' })
  ] }), /Unsupported WSSI impact/);
  assert.throws(() => wssi.normalizeCollection({ type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'Point', coordinates: [-90, 38] }, properties: { impact: 'MINOR' }
  }] }), /Invalid WSSI feature/);
});

test('pagination follows transfer limits, deduplicates, and fails on no progress', async () => {
  let calls = 0;
  const fetcher = async () => ({ ok: true, json: async () => {
    calls += 1;
    return { type: 'FeatureCollection', features: [polygon({ objectid: 1, impact: 'MINOR' })],
      properties: { exceededTransferLimit: true } };
  } });
  await assert.rejects(wssi.fetchAllPages(fetcher), /no progress/);
  assert.equal(calls, 2);
});
