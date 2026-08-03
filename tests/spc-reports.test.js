const assert = require('node:assert/strict');
const test = require('node:test');

const Reports = require('../js/spc-reports.js');

function polygon() {
  return { type: 'Polygon', coordinates: [[[-101, 37], [-97, 37], [-97, 41], [-101, 41], [-101, 37]]] };
}

function reportPoint() {
  return { type: 'Point', coordinates: [-98, 39] };
}

test('query URLs use the current official vector services and bounded windows', () => {
  const mesoscale = Reports.queryUrl('mesoscale', null, 0, { west: -105, south: 30, east: -90, north: 45 });
  assert.match(mesoscale, /outlooks\/spc_mesoscale_discussion\/MapServer\/0\/query/);
  assert.match(mesoscale, /geometry=-105%2C30%2C-90%2C45/);
  assert.match(Reports.queryUrl('reports', 24, 0), /nws_local_storm_reports\/MapServer\/0\/query/);
  assert.match(Reports.queryUrl('reports', 72, 500), /MapServer\/2\/query/);
  assert.throws(() => Reports.queryUrl('reports', 12, 0), /window is invalid/);
  assert.throws(() => Reports.queryUrl('unknown', 24, 0), /kind is invalid/);
});

test('normalizes mesoscale discussion polygons with bounded official links', () => {
  const result = Reports.normalizeMesoscale({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: polygon(), properties: {
      objectid: 7, name: 'MD 1234', folderpath: 'Short-fuse severe potential',
      popupinfo: 'https://www.spc.noaa.gov/products/md/md1234.html', idp_filedate: 1780000000000
    } }]
  });
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.discussionNumber, 'MD 1234');
  assert.equal(result.features[0].properties.issuedAt, '2026-05-28T20:26:40.000Z');
  assert.equal(result.features[0].properties.officialUrl, 'https://www.spc.noaa.gov/products/md/md1234.html');
  assert.throws(() => Reports.normalizeMesoscale({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }
  ] }), /Invalid SPC mesoscale feature/);
});

test('normalizes local storm reports as safe points and constrains the selected window', () => {
  const result = Reports.normalizeReports({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: reportPoint(), properties: {
      objectid: 9, wfo_id: 'TOP', wfo: 'Topeka', descript: 'Hail', loc_desc: '<b>Fixture</b>', state: 'KS',
      magnitude: '1.25', units: 'inch', remarks: '<img src=x onerror=bad>', lsr_validtime: 1780000000000
    } }]
  }, 48);
  const properties = result.features[0].properties;
  assert.equal(properties.reportType, 'Hail');
  assert.equal(properties.location, '<b>Fixture</b>');
  assert.equal(properties.reportWindowHours, 48);
  assert.equal(properties.reportedAt, '2026-05-28T20:26:40.000Z');
  assert.equal(properties.officialUrl, 'https://www.weather.gov/top');
  assert.throws(() => Reports.normalizeReports({ type: 'FeatureCollection', features: [] }, 36), /window is invalid/);
  assert.throws(() => Reports.normalizeReports({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: polygon(), properties: {} }
  ] }, 24), /Invalid NWS local storm report feature/);
});

test('fetchAllPages follows transfer limits, deduplicates split bounds, and reports latest time', async () => {
  let calls = 0;
  const result = await Reports.fetchAllPages(async (url) => {
    calls += 1;
    const query = new URL(url).searchParams;
    const offset = Number(query.get('resultOffset'));
    const isWestPart = query.get('geometry')?.startsWith('-180');
    const features = offset === 0 ? [{ type: 'Feature', geometry: reportPoint(), properties: {
      objectid: isWestPart ? 1 : 2, descript: 'Wind', lsr_validtime: 1780000000000
    } }] : [];
    return { ok: true, json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit: false }) };
  }, 'reports', 24, { west: 170, south: -10, east: -170, north: 10 });
  assert.equal(calls, 2);
  assert.equal(result.collection.features.length, 2);
  assert.equal(result.latestAt, 1780000000000);
});

test('styles and freshness distinguish report categories and stale data', () => {
  assert.match(Reports.reportStyle('Tornado').className, /storm-report-tornado/);
  assert.match(Reports.reportStyle('Hail').className, /storm-report-hail/);
  assert.match(Reports.reportStyle('Thunderstorm Wind').className, /storm-report-wind/);
  assert.equal(Reports.mesoscaleStyle().fillColor, '#e879f9');
  const now = 2_000_000_000_000;
  assert.equal(Reports.freshness(now - 60_000, 10 * 60 * 1000, now).state, 'fresh');
  assert.equal(Reports.freshness(now - 60 * 60 * 1000, 10 * 60 * 1000, now).state, 'stale');
  assert.equal(Reports.freshness(null, 1000, now).state, 'unknown');
});
