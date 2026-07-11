'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'nws-alerts.js'), 'utf8');

function loadModule() {
  const context = { URL, URLSearchParams, Date, Math, Set, Object, Array, Number, String, Boolean, TypeError, RangeError, isFinite };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'nws-alerts.js' });
  return context.StormScopeNwsAlerts;
}

const alerts = loadModule();

function feature(overrides) {
  const properties = Object.assign({
    id: 'urn:oid:test-1',
    '@id': 'https://api.weather.gov/alerts/urn:oid:test-1',
    web: 'http://www.weather.gov/',
    areaDesc: 'Test County',
    sent: '2026-07-11T16:00:00-04:00',
    effective: '2026-07-11T16:00:00-04:00',
    onset: '2026-07-11T16:05:00-04:00',
    expires: '2026-07-11T17:00:00-04:00',
    ends: '2026-07-11T16:45:00-04:00',
    status: 'Actual',
    messageType: 'Alert',
    severity: 'Severe',
    certainty: 'Observed',
    urgency: 'Immediate',
    event: 'Severe Thunderstorm Warning',
    senderName: 'NWS Test Office',
    headline: 'Severe Thunderstorm Warning for Test County',
    description: 'Damaging winds are possible.',
    instruction: 'Move indoors.',
    response: 'Shelter',
    affectedZones: ['https://api.weather.gov/zones/county/TST001'],
    references: [],
    parameters: { VTEC: ['/O.NEW.KTST.SV.W.0042.260711T2000Z-260711T2100Z/'] }
  }, overrides);
  return {
    id: properties['@id'],
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[-91, 38], [-89, 38], [-89, 40], [-91, 40], [-91, 38]]]
    },
    properties
  };
}

test('exports a frozen browser global', () => {
  assert.equal(typeof alerts.normalizeCollection, 'function');
  assert.equal(Object.isFrozen(alerts), true);
});

test('constructs official point and viewport queries', () => {
  const point = new URL(alerts.buildPointQuery(39.123456, -90.987654, {
    severities: ['Extreme', 'Severe'],
    messageTypes: ['Alert', 'Update']
  }));
  assert.equal(point.origin + point.pathname, 'https://api.weather.gov/alerts/active');
  assert.equal(point.searchParams.get('point'), '39.1235,-90.9877');
  assert.equal(point.searchParams.get('status'), 'actual');
  assert.equal(point.searchParams.get('severity'), 'extreme,severe');
  assert.equal(point.searchParams.get('message_type'), 'alert,update');

  const viewport = alerts.buildViewportQuery({ south: 35, west: -95, north: 42, east: -85 });
  const viewportUrl = new URL(viewport.url);
  assert.equal(viewportUrl.searchParams.get('region_type'), 'land');
  assert.equal(viewport.requiresClientFilter, true);
  assert.deepEqual(JSON.parse(JSON.stringify(viewport.bounds)), { south: 35, west: -95, north: 42, east: -85 });
  assert.throws(() => alerts.buildPointQuery(91, 0), /latitude/);
});

test('normalizes CAP fields, times, VTEC series, and trusted source URLs', () => {
  const alert = alerts.normalizeAlert(feature());
  assert.equal(alert.kind, 'warning');
  assert.equal(alert.severityRank, 1);
  assert.equal(alert.urgencyRank, 0);
  assert.equal(alert.certaintyRank, 0);
  assert.equal(alert.effective, '2026-07-11T20:00:00.000Z');
  assert.equal(alert.expires, '2026-07-11T21:00:00.000Z');
  assert.equal(alert.ends, '2026-07-11T20:45:00.000Z');
  assert.equal(alert.vtecSeries, 'KTST.SV.W.0042');
  assert.equal(alert.dedupeKey, 'vtec:KTST.SV.W.0042');
  assert.match(alert.sourceUrl, /^https:\/\/api\.weather\.gov\/alerts\//);
  assert.equal(alert.weatherUrl, 'https://www.weather.gov/');
  assert.equal(alert.apiUrl, alert.sourceUrl);

  const hostile = alerts.normalizeAlert(feature({ web: 'https://weather.gov.attacker.example/alert' }));
  assert.equal(hostile.weatherUrl, 'https://www.weather.gov/');
});

test('deduplicates an alert series to its latest update and removes expired alerts', () => {
  const first = alerts.normalizeAlert(feature());
  const update = alerts.normalizeAlert(feature({
    id: 'urn:oid:test-2',
    '@id': 'https://api.weather.gov/alerts/urn:oid:test-2',
    sent: '2026-07-11T16:20:00-04:00',
    messageType: 'Update'
  }));
  const unique = alerts.dedupeAlerts([first, update]);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].id, 'urn:oid:test-2');
  assert.equal(alerts.isExpired(unique[0], Date.parse('2026-07-11T20:59:59Z')), false);
  assert.equal(alerts.isExpired(unique[0], Date.parse('2026-07-11T21:00:00Z')), true);

  const cancel = alerts.normalizeAlert(feature({ messageType: 'Cancel' }));
  assert.equal(alerts.isExpired(cancel, Date.parse('2026-07-11T20:10:00Z')), true);
});

test('orders and filters by severity, urgency, kind, status, and expiry', () => {
  const now = Date.parse('2026-07-11T20:30:00Z');
  const extreme = alerts.normalizeAlert(feature({ severity: 'Extreme', event: 'Tornado Watch' }));
  const moderate = alerts.normalizeAlert(feature({
    id: 'moderate', '@id': 'https://api.weather.gov/alerts/moderate',
    severity: 'Moderate', urgency: 'Expected', event: 'Flood Advisory',
    parameters: { VTEC: ['/O.NEW.KTST.FL.Y.0043.260711T2000Z-260711T2200Z/'] }
  }));
  const testAlert = alerts.normalizeAlert(feature({
    id: 'test', '@id': 'https://api.weather.gov/alerts/test', status: 'Test', severity: 'Extreme',
    parameters: { VTEC: ['/O.NEW.KTST.TO.W.0044.260711T2000Z-260711T2200Z/'] }
  }));
  const filtered = alerts.filterAlerts([moderate, testAlert, extreme], {
    now,
    minimumSeverity: 'Moderate',
    kinds: ['watch', 'advisory']
  });
  assert.deepEqual(filtered.map((alert) => alert.kind), ['watch', 'advisory']);
  assert.deepEqual(filtered.map((alert) => alert.severity), ['Extreme', 'Moderate']);
});

test('filters GeoJSON alerts to normal and dateline-crossing viewports', () => {
  const inside = alerts.normalizeAlert(feature());
  const outsideFeature = feature({ id: 'outside', '@id': 'https://api.weather.gov/alerts/outside' });
  outsideFeature.geometry.coordinates = [[[-80, 20], [-79, 20], [-79, 21], [-80, 21], [-80, 20]]];
  const outside = alerts.normalizeAlert(outsideFeature);
  assert.deepEqual(alerts.filterToViewport([inside, outside], { south: 37, west: -92, north: 41, east: -88 }).map((alert) => alert.id), [inside.id]);

  const datelineFeature = feature({ id: 'dateline', '@id': 'https://api.weather.gov/alerts/dateline' });
  datelineFeature.geometry.coordinates = [[[179, 50], [180, 50], [180, 51], [179, 51], [179, 50]]];
  const dateline = alerts.normalizeAlert(datelineFeature);
  assert.equal(alerts.filterToViewport([dateline], { south: 49, west: 170, north: 52, east: -170 }).length, 1);
});

test('normalizes, deduplicates, expires, bounds, and sorts a collection', () => {
  const latest = feature({
    id: 'latest', '@id': 'https://api.weather.gov/alerts/latest', sent: '2026-07-11T16:10:00-04:00', messageType: 'Update'
  });
  const expired = feature({
    id: 'expired', '@id': 'https://api.weather.gov/alerts/expired', expires: '2026-07-11T15:00:00-04:00',
    parameters: { VTEC: ['/O.NEW.KTST.FG.Y.0045.260711T1800Z-260711T1900Z/'] }
  });
  const result = alerts.normalizeCollection({ features: [feature(), latest, expired, { type: 'Feature', properties: {} }] }, {
    now: Date.parse('2026-07-11T20:30:00Z'),
    bounds: { south: 37, west: -92, north: 41, east: -88 }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'latest');
});

test('produces bounded retry/backoff and success metadata', () => {
  const now = Date.parse('2026-07-11T20:00:00Z');
  const first = alerts.nextRetryMetadata(null, { status: 503, message: 'Unavailable' }, {
    now, random: () => 0.5
  });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    attempt: 1,
    retryable: true,
    status: 503,
    delayMs: 30000,
    nextRetryAt: '2026-07-11T20:00:30.000Z',
    lastError: 'Unavailable'
  });
  const rateLimited = alerts.nextRetryMetadata(first, { status: 429, retryAfter: '120' }, {
    now, random: () => 0.5
  });
  assert.equal(rateLimited.delayMs, 120000);
  assert.equal(rateLimited.nextRetryAt, '2026-07-11T20:02:00.000Z');

  const badRequest = alerts.nextRetryMetadata(null, { status: 400, title: 'Bad point' }, { now });
  assert.equal(badRequest.retryable, false);
  assert.equal(badRequest.nextRetryAt, null);
  assert.equal(alerts.parseRetryAfter('Sat, 11 Jul 2026 20:01:00 GMT', now), 60000);
  assert.equal(alerts.successMetadata(now).nextRetryAt, '2026-07-11T20:00:30.000Z');
});
