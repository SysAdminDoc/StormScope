'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const observations = require('../js/surface-observations.js');

test('builds bounded AWC queries and suppresses requests when zoomed out', () => {
  assert.deepEqual(observations.buildQueries({ west: -100, south: 35, east: -96, north: 42 }, 3), []);
  const urls = observations.buildQueries({ west: 170, south: -10, east: -170, north: 20 }, 5);
  assert.equal(urls.length, 2);
  urls.forEach((value) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://mapservices.weather.noaa.gov');
    assert.equal(url.pathname, '/vector/rest/services/aviation/awc_aviation_weather/MapServer/12/query');
    assert.equal(url.searchParams.get('resultRecordCount'), '2000');
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('f'), 'geojson');
    assert.ok(url.searchParams.get('outFields').includes('raw_text'));
  });
  assert.throws(() => observations.queryUrl({ west: -181, south: 0, east: 1, north: 1 }), /bounds/);
});

test('normalizes multipoint AWC features, keeps the newest station report, and strips controls', () => {
  const now = Date.now();
  const result = observations.normalizeCollection({
    type: 'FeatureCollection',
    exceededTransferLimit: false,
    features: [
      { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[-98, 39]] }, properties: {
        objectid: 1, station_id: 'kfix', raw_text: '<img src=x onerror=bad>\u0000',
        observation_time: now - 600000, latitude: 39, longitude: -98, temp_c: 20,
        dewpoint_c: 12, winddir: 180, wind_speed_kt: 12, wind_gust_kt: 22,
        visibility_statute_mi: '10+', wx_string: '-RA', sky_cover: 'BKN',
        flight_category: 'MVFR', cloud_base_ft_agl: 2200, ceiling_ft: 2200
      } },
      { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[-98, 39]] }, properties: {
        objectid: 2, station_id: 'KFIX', raw_text: 'METAR KFIX newer', observation_time: now - 300000,
        latitude: 39, longitude: -98, temp_c: 21, flight_category: 'VFR'
      } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-97, 38] }, properties: {
        objectid: 3, station_id: 'KCLEAR', raw_text: 'METAR KCLEAR', observation_time: now - 120000,
        flight_category: 'LIFR'
      } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 999] }, properties: {
        objectid: 4, station_id: 'BAD', observation_time: now
      } }
    ]
  });
  assert.equal(result.count, 2);
  assert.equal(result.latestAt, now - 120000);
  const fix = result.collection.features.find((feature) => feature.properties.stationId === 'KFIX');
  assert.equal(fix.properties.tempC, 21);
  assert.equal(fix.properties.flightCategory, 'VFR');
  assert.equal(fix.geometry.type, 'Point');
  assert.doesNotMatch(result.collection.features[0].properties.rawText, /\u0000/);
  assert.match(fix.properties.officialUrl, /^https:\/\/aviationweather\.gov\/metar\/data\?ids=KFIX/);
  assert.equal(observations.markerClass('MVFR'), 'metar-station-marker metar-mvfr');
  assert.equal(observations.markerClass('provider-injected'), 'metar-station-marker metar-unknown');
});

test('merges dateline query results, caps combined records, and reports partial data', () => {
  const feature = (station, time) => ({
    type: 'Feature', id: station,
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { stationId: station, observationTime: time }
  });
  const merged = observations.mergeCollections([
    { collection: { type: 'FeatureCollection', features: [feature('DUP', 1)] }, latestAt: 1, count: 1, truncated: true },
    { collection: { type: 'FeatureCollection', features: [feature('DUP', 2), feature('NEW', 3)] }, latestAt: 3, count: 2, truncated: false }
  ]);
  assert.equal(merged.count, 2);
  assert.equal(merged.latestAt, 3);
  assert.equal(merged.truncated, true);
  assert.equal(merged.collection.features.find((item) => item.id === 'DUP').properties.observationTime, 2);

  const many = Array.from({ length: observations.MAX_FEATURES + 1 }, (_, index) => feature('S' + index, index));
  const capped = observations.mergeCollections([{ collection: { type: 'FeatureCollection', features: many }, truncated: false }]);
  assert.equal(capped.count, observations.MAX_FEATURES);
  assert.equal(capped.truncated, true);
});

test('classifies observation freshness with a deterministic stale boundary', () => {
  assert.deepEqual(observations.freshness(1000, 60000, 61000), { state: 'fresh', ageMs: 60000 });
  assert.deepEqual(observations.freshness(1000, 60000, 61001), { state: 'stale', ageMs: 60001 });
  assert.deepEqual(observations.freshness(null, 60000, 61001), { state: 'unknown', ageMs: null });
});
