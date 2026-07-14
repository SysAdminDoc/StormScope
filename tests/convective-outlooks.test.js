const assert = require('node:assert/strict');
const test = require('node:test');

const SPC = require('../js/convective-outlooks.js');

function polygon() {
  return { type: 'Polygon', coordinates: [[[-100, 38], [-98, 38], [-98, 40], [-100, 40], [-100, 38]]] };
}

test('queryUrl maps days to the categorical layer IDs and rejects bad days', () => {
  assert.match(SPC.queryUrl(1, 0), /SPC_wx_outlks\/MapServer\/1\/query/);
  assert.match(SPC.queryUrl(2, 0), /MapServer\/9\/query/);
  assert.match(SPC.queryUrl(3, 500), /MapServer\/17\/query/);
  assert.match(SPC.queryUrl(3, 500), /resultOffset=500/);
  assert.throws(() => SPC.queryUrl(4, 0), /day is invalid/);
});

test('category derives from label first, then dn severity code', () => {
  assert.equal(SPC.category({ label: 'ENH' }), 'enh');
  assert.equal(SPC.category({ label: 'Moderate' }), 'mdt');
  assert.equal(SPC.category({ label: '', dn: 8 }), 'high');
  assert.equal(SPC.category({ label: 'TSTM' }), 'tstm');
  assert.equal(SPC.category({ label: 'unknown', dn: 99 }), null);
});

test('normalizeCollection keeps valid categorical polygons ordered weak→strong', () => {
  const payload = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: polygon(), properties: { objectid: 1, label: 'MDT', dn: 6, issue: '2026-07-14T12:00:00Z', valid: '2026-07-14T13:00:00Z', expire: '2026-07-15T12:00:00Z' } },
      { type: 'Feature', geometry: polygon(), properties: { objectid: 2, label: 'MRGL', dn: 3 } },
      { type: 'Feature', geometry: polygon(), properties: { objectid: 3, label: 'ADMIN', dn: 0 } } // unknown → skipped
    ]
  };
  const result = SPC.normalizeCollection(payload, 1);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features.map((f) => f.properties.outlookCategory), ['mrgl', 'mdt']);
  const mdt = result.features[1].properties;
  assert.equal(mdt.outlookDay, 1);
  assert.equal(mdt.issuedAt, '2026-07-14T12:00:00.000Z');
  assert.equal(mdt.startsAt, '2026-07-14T13:00:00.000Z');
  assert.match(mdt.sourceLabel, /Storm Prediction Center/);
});

test('normalizeCollection rejects non-GeoJSON and invalid geometry', () => {
  assert.throws(() => SPC.normalizeCollection(null, 1), /Invalid SPC outlook GeoJSON/);
  assert.throws(() => SPC.normalizeCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { label: 'SLGT' } }
  ] }, 1), /Invalid SPC outlook feature/);
});

test('fetchAllPages follows the transfer-limit flag and dedupes by objectid', async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls += 1;
    const offset = Number(new URL(url).searchParams.get('resultOffset'));
    return {
      ok: true,
      json: async () => ({
        type: 'FeatureCollection',
        exceededTransferLimit: offset === 0,
        features: [{ type: 'Feature', geometry: polygon(), properties: { objectid: offset + 1, label: 'SLGT' } }]
      })
    };
  };
  const result = await SPC.fetchAllPages(fetcher, 1, undefined);
  assert.equal(calls, 2);
  assert.equal(result.features.length, 2);
});

test('style returns official category colors and freshness compares age', () => {
  assert.equal(SPC.style('high').fillColor, '#ff73ff');
  assert.throws(() => SPC.style('nope'), /style is invalid/);
  const now = 2_000_000_000_000;
  assert.equal(SPC.freshness(now - 60_000, 8 * 60 * 60 * 1000, now).state, 'fresh');
  assert.equal(SPC.freshness(now - 20 * 60 * 60 * 1000, 8 * 60 * 60 * 1000, now).state, 'stale');
  assert.equal(SPC.freshness(null, 1000, now).state, 'unknown');
});
