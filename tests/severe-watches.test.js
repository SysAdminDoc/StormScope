const assert = require('node:assert/strict');
const test = require('node:test');

const Watches = require('../js/severe-watches.js');

function polygon(shift = 0) {
  return { type: 'Polygon', coordinates: [[[-100 + shift, 37], [-96 + shift, 37], [-96 + shift, 41], [-100 + shift, 41], [-100 + shift, 37]]] };
}

const FUTURE = Date.now() + 3 * 60 * 60 * 1000;
const PAST = Date.now() - 60 * 60 * 1000;

test('queryUrl filters to tornado and severe-thunderstorm watches', () => {
  const url = Watches.queryUrl(0);
  assert.match(decodeURIComponent(url).replace(/\+/g, ' '), /prod_type IN \('Tornado Watch','Severe Thunderstorm Watch'\)/);
  assert.match(url, /watch_warn_adv\/MapServer\/1\/query/);
});

test('kind maps product types and rejects others', () => {
  assert.equal(Watches.kind('Tornado Watch'), 'tornado');
  assert.equal(Watches.kind('Severe Thunderstorm Watch'), 'severe');
  assert.equal(Watches.kind('Flood Warning'), null);
});

test('normalizeCollection keeps active watches, drops expired, orders severe→tornado', () => {
  const payload = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: polygon(0), properties: { objectid: 1, prod_type: 'Tornado Watch', expiration: FUTURE, issuance: PAST, url: 'https://www.spc.noaa.gov/products/watch/ww0123.html' } },
      { type: 'Feature', geometry: polygon(5), properties: { objectid: 2, prod_type: 'Severe Thunderstorm Watch', expiration: FUTURE } },
      { type: 'Feature', geometry: polygon(10), properties: { objectid: 3, prod_type: 'Tornado Watch', expiration: PAST } }, // expired → dropped
      { type: 'Feature', geometry: polygon(15), properties: { objectid: 4, prod_type: 'Flood Watch', expiration: FUTURE } } // not severe/tornado → dropped
    ]
  };
  const result = Watches.normalizeCollection(payload);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features.map((f) => f.properties.watchKind), ['severe', 'tornado']);
  const tornado = result.features[1].properties;
  assert.match(tornado.officialUrl, /spc\.noaa\.gov/);
  assert.ok(tornado.issuedAt);
});

test('normalizeCollection nulls non-https official URLs and rejects bad geometry', () => {
  const result = Watches.normalizeCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: polygon(), properties: { objectid: 9, prod_type: 'Tornado Watch', expiration: FUTURE, url: 'http://insecure.example/x' } }
  ] });
  assert.equal(result.features[0].properties.officialUrl, null);
  assert.throws(() => Watches.normalizeCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { prod_type: 'Tornado Watch' } }
  ] }), /Invalid severe watch feature/);
});

test('fetchAllPages follows the transfer-limit flag and dedupes', async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls += 1;
    const offset = Number(new URL(url).searchParams.get('resultOffset'));
    return { ok: true, json: async () => ({
      type: 'FeatureCollection', exceededTransferLimit: offset === 0,
      features: [{ type: 'Feature', geometry: polygon(offset), properties: { objectid: offset + 1, prod_type: 'Severe Thunderstorm Watch', expiration: FUTURE } }]
    }) };
  };
  const result = await Watches.fetchAllPages(fetcher, undefined);
  assert.equal(calls, 2);
  assert.equal(result.features.length, 2);
});

test('style and freshness are deterministic', () => {
  assert.equal(Watches.style('tornado').color, '#d6006e');
  assert.equal(Watches.style('severe').color, '#e69500');
  assert.throws(() => Watches.style('flood'), /style is invalid/);
  const now = 2_000_000_000_000;
  assert.equal(Watches.freshness(now - 30_000, 10 * 60 * 1000, now).state, 'fresh');
  assert.equal(Watches.freshness(now - 20 * 60 * 1000, 10 * 60 * 1000, now).state, 'stale');
  assert.equal(Watches.freshness(null, 1000, now).state, 'unknown');
});
