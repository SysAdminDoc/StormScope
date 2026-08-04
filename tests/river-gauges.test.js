'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const gauges = require('../js/river-gauges.js');

function feature(kind, overrides = {}) {
  const now = Date.parse('2026-08-04T03:15:00Z');
  const properties = {
    gaugelid: 'USGS-07010000', location: 'Mississippi River at St. Louis', waterbody: 'Mississippi River',
    state: 'MO', units: 'ft', secunit: 'cfs', action: 28, flood: 30, moderate: 35, major: 40,
    latitude: 38.63, longitude: -90.18, idp_ingestdate: now - 30000
  };
  if (kind === 'observed') Object.assign(properties, {
    status: 'minor', observed: 31, secvalue: 100000, obstime: now - 60000,
    url: 'https://water.noaa.gov/gauges/07010000'
  });
  else Object.assign(properties, {
    status: 'moderate', forecast: 36, fcstissunc: now - 120000, fcsttime: now + 3600000,
    url: 'https://water.noaa.gov/gauges/07010000'
  });
  Object.assign(properties, overrides);
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [-90.18, 38.63] }, properties };
}

test('builds viewport and dateline queries below the service record cap', () => {
  assert.deepEqual(gauges.buildQueries({ west: -100, south: 35, east: -96, north: 42 }, 3), []);
  const queries = gauges.buildQueries({ west: 170, south: -10, east: -170, north: 20 }, 5);
  assert.equal(queries.length, 4);
  assert.deepEqual(queries.map((query) => query.kind), ['observed', 'forecast', 'observed', 'forecast']);
  for (const query of queries) {
    const url = new URL(query.url);
    assert.equal(url.origin, 'https://mapservices.weather.noaa.gov');
    assert.match(url.pathname, /\/eventdriven\/rest\/services\/water\/riv_gauges\/MapServer\/[01]\/query$/);
    assert.equal(url.searchParams.get('resultRecordCount'), String(gauges.MAX_RECORDS));
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('f'), 'geojson');
    assert.equal(url.searchParams.get('orderByFields'), 'objectid ASC');
    assert.doesNotMatch(url.searchParams.get('outFields'), /\*/);
  }
  assert.throws(() => gauges.queryUrl('observed', { west: -181, south: 0, east: 1, north: 1 }), /bounds/);
});

test('normalizes observed and forecast records and joins official thresholds', () => {
  const observed = gauges.normalizeCollection({ type: 'FeatureCollection', features: [
    feature('observed'),
    { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 999] }, properties: { gaugelid: 'BAD' } }
  ] }, 'observed');
  const forecast = gauges.normalizeCollection({ type: 'FeatureCollection', features: [feature('forecast')] }, 'forecast');
  const merged = gauges.mergeCollections(observed, forecast, Date.parse('2026-08-04T03:15:00Z'));
  assert.equal(observed.count, 1);
  assert.equal(merged.count, 1);
  const gauge = merged.collection.features[0];
  assert.equal(gauge.properties.gaugeId, 'USGS-07010000');
  assert.equal(gauge.properties.observedStage, 31);
  assert.equal(gauge.properties.observedFlow, 100000);
  assert.equal(gauge.properties.observedCategory, 'minor');
  assert.equal(gauge.properties.forecastStage, 36);
  assert.equal(gauge.properties.forecastCategory, 'moderate');
  assert.equal(gauge.properties.category, 'moderate');
  assert.equal(merged.updatedAt, Date.parse('2026-08-04T03:14:30Z'));
  assert.equal(gauge.properties.thresholds.major, 40);
  assert.equal(gauge.properties.forecastAvailable, true);
  assert.equal(gauge.properties.officialUrl, 'https://water.noaa.gov/gauges/07010000');
  assert.equal(gauges.categoryColor(gauge.properties.category), '#ff2d55');
});

test('retains safe raw-source fallback and classifies missing forecasts explicitly', () => {
  const observed = gauges.normalizeCollection({ type: 'FeatureCollection', features: [
    feature('observed', { url: 'javascript:alert(1)' })
  ] }, 'observed');
  const forecast = gauges.normalizeCollection({ type: 'FeatureCollection', features: [
    feature('forecast', { status: 'no_forecast', forecast: -999, fcsttime: 'N/A', fcstissunc: 'N/A' })
  ] }, 'forecast');
  const merged = gauges.mergeCollections(observed, forecast);
  const properties = merged.collection.features[0].properties;
  assert.equal(properties.officialUrl, 'https://water.noaa.gov/gauges/07010000');
  assert.equal(properties.forecastCategory, 'no-forecast');
  assert.equal(properties.category, 'minor');
  assert.equal(gauges.statusCategory('obs_not_current', 'observed'), 'not-current');
  assert.equal(gauges.statusCategory('no_forecast', 'forecast'), 'no-forecast');
});

test('builds a validated keyless NWPS stageflow URL', () => {
  assert.equal(gauges.stageflowUrl('USGS-07010000'),
    'https://api.water.noaa.gov/nwps/v1/gauges/07010000/stageflow');
  assert.equal(gauges.stageflowUrl('aacs2'),
    'https://api.water.noaa.gov/nwps/v1/gauges/AACS2/stageflow');
  assert.throws(() => gauges.stageflowUrl('../secret'), /identifier/);
  assert.throws(() => gauges.stageflowUrl(''), /identifier/);
});

test('classifies freshness at the exact stale boundary', () => {
  assert.deepEqual(gauges.freshness(1000, 60000, 61000), { state: 'fresh', ageMs: 60000 });
  assert.deepEqual(gauges.freshness(1000, 60000, 61001), { state: 'stale', ageMs: 60001 });
  assert.deepEqual(gauges.freshness(null, 60000, 61001), { state: 'unknown', ageMs: null });
});
