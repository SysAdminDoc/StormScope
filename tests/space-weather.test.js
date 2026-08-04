'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const spaceWeather = require('../js/space-weather.js');

const now = Date.UTC(2026, 0, 2, 0, 0, 0);

function noaaTimestamp(value) {
  const date = new Date(value);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getUTCFullYear()} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ` +
    `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function auroraPayload(observationAt = new Date(now - 5 * 60 * 1000).toISOString()) {
  return {
    type: 'MultiPoint',
    'Observation Time': observationAt,
    'Forecast Time': new Date(now + 30 * 60 * 1000).toISOString(),
    coordinates: [[0, 90, 70], [180, -90, 30], [359, 0, 100], [12, 10, 101], [12, 10, 55]]
  };
}

function kpPayload(time = new Date(now - 10 * 60 * 1000).toISOString()) {
  return [{ time_tag: time, Kp: '4.33', a_running: '12', station_count: '18' }];
}

function alertPayload(baseNow = now) {
  return [{
    product_id: 'K04W',
    issue_datetime: new Date(baseNow - 20 * 60 * 1000).toISOString(),
    message: `WARNING: Geomagnetic K-index of 4\nValid To: ${noaaTimestamp(baseNow + 4 * 60 * 60 * 1000)}`
  }, {
    product_id: 'K04W',
    issue_datetime: new Date(baseNow - 40 * 60 * 1000).toISOString(),
    message: `Older duplicate\nValid To: ${noaaTimestamp(baseNow + 4 * 60 * 60 * 1000)}`
  }, {
    product_id: 'EXPIRED',
    issue_datetime: new Date(baseNow - 60 * 60 * 1000).toISOString(),
    message: `ALERT: expired\nValid To: ${noaaTimestamp(baseNow - 60 * 60 * 1000)}`
  }];
}

test('Ovation normalization is bounded, north-up, and hostile-value tolerant', () => {
  const normalized = spaceWeather.normalizeAurora(auroraPayload());
  assert.equal(normalized.width, 360);
  assert.equal(normalized.height, 181);
  assert.equal(normalized.activeCount, 4);
  assert.equal(normalized.maxProbability, 100);
  assert.equal(normalized.values[180], 70, 'longitude 0 at latitude 90 belongs at the north edge');
  assert.equal(normalized.values[(90 * 360) + 179], 100, 'longitude 359 at the equator is retained');
  assert.ok(Number.isFinite(normalized.observationAt));
  assert.throws(() => spaceWeather.normalizeAurora({ type: 'FeatureCollection', coordinates: [] }), /Invalid/);
  assert.throws(() => spaceWeather.normalizeAurora({ type: 'MultiPoint', coordinates: [[0, 0, 101]] }), /no valid/);
});

test('aurora raster has transparent empty cells and visible probability cells', () => {
  const normalized = spaceWeather.normalizeAurora(auroraPayload());
  const raster = spaceWeather.buildRaster(normalized);
  assert.equal(raster.pixels.length, 360 * 181 * 4);
  assert.equal(raster.pixels[0 * 4 + 3], 0);
  const activeOffset = 90 * 360 + 179;
  assert.ok(raster.pixels[activeOffset * 4 + 3] > 0);
  assert.deepEqual(spaceWeather.auroraColor(0), [0, 0, 0, 0]);
});

test('K-index, alerts, and freshness normalize time-bounded feed records', () => {
  const kp = spaceWeather.normalizeKp([
    ...kpPayload(new Date(now - 2 * 60 * 1000).toISOString()),
    ...kpPayload(new Date(now - 10 * 60 * 1000).toISOString()),
    { time_tag: 'invalid', Kp: 4 }, { time_tag: new Date(now).toISOString(), Kp: 12 }
  ]);
  assert.equal(kp.length, 2);
  assert.equal(kp.at(-1).kp, 4.33);
  assert.equal(kp.at(-1).stationCount, 18);

  const alerts = spaceWeather.normalizeAlerts(alertPayload(), now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].productId, 'K04W');
  assert.equal(alerts[0].severity, 'G0');
  assert.match(alerts[0].title, /WARNING/);
  assert.equal(spaceWeather.freshness(now - 1000, 1000, now).state, 'fresh');
  assert.equal(spaceWeather.freshness(now - 1001, 1000, now).state, 'stale');
});

test('controller preserves last-good feeds while independently recovering a failed feed', async () => {
  let enabled = true;
  let failKp = false;
  const statuses = [];
  const map = {
    layers: [],
    attributionControl: {
      added: [],
      addAttribution(value) { this.added.push(value); },
      removeAttribution(value) { this.added = this.added.filter((item) => item !== value); }
    },
    removeLayer(layer) { this.layers = this.layers.filter((item) => item !== layer); }
  };
  const leaflet = {
    imageOverlay(source, bounds, options) {
      return {
        source, bounds, options,
        addTo(target) { target.layers.push(this); return this; }
      };
    }
  };
  const fetcher = async (url) => {
    if (failKp && url === spaceWeather.KP_URL) return { ok: false, status: 503 };
    if (url === spaceWeather.AURORA_URL) return { ok: true, json: async () => auroraPayload() };
    if (url === spaceWeather.KP_URL) return { ok: true, json: async () => kpPayload() };
    if (url === spaceWeather.ALERTS_URL) return { ok: true, json: async () => alertPayload(Date.now()) };
    throw new Error('unexpected URL');
  };
  const controller = spaceWeather.create({
    L: leaflet, fetch: fetcher, getMap: () => map, isEnabled: () => enabled,
    isDocumentHidden: () => false, renderRaster: () => 'data:image/png;base64,fixture',
    setStatus: (message, state) => statuses.push({ message, state }),
    setTimeout: () => 1, clearTimeout: () => {}
  });

  const ready = await controller.refresh();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.enabled, true);
  assert.equal(ready.auroraCount, 4);
  assert.equal(ready.alertCount, 1);
  assert.equal(map.layers.length, 1);

  failKp = true;
  const partial = await controller.refresh();
  assert.equal(partial.status, 'partial');
  assert.equal(partial.partial, true);
  assert.equal(partial.kp, ready.kp, 'last-good K-index remains available during an independent outage');
  assert.equal(partial.auroraCount, ready.auroraCount);
  assert.equal(partial.alertCount, ready.alertCount);
  assert.ok(statuses.some((entry) => entry.state === 'error'));

  enabled = false;
  controller.disable();
  assert.deepEqual(controller.getState(), {
    enabled: false, status: 'off', auroraCount: 0, auroraMaxProbability: 0,
    auroraObservationAt: null, kp: null, kpTime: null, alerts: [], alertCount: 0,
    updatedAt: null, lastGood: false, partial: false
  });
  assert.equal(map.layers.length, 0);
  assert.equal(map.attributionControl.added.length, 0);
});
