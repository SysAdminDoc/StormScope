'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const marineBuoys = require('../js/marine-buoys.js');

const now = Date.UTC(2026, 0, 2, 0, 0, 0);
const columns = ['station', 'longitude', 'latitude', 'time', 'wd', 'wspd', 'gst', 'wvht', 'dpd', 'apd', 'mwd', 'wtmp'];

function payload(rows) {
  return { table: { columnNames: columns, rows } };
}

function row(station, time, overrides = {}) {
  const values = [station, -72.698, 34.675, time, 190, 7, 9, 2.4, 7, 6.4, 211, 27.6];
  const indexes = Object.fromEntries(columns.map((column, index) => [column, index]));
  for (const [key, value] of Object.entries(overrides)) values[indexes[key]] = value;
  return values;
}

test('builds bounded viewport/time queries and splits dateline views', () => {
  assert.deepEqual(marineBuoys.buildQueries({ west: -100, south: 20, east: -60, north: 55 }, 3), []);
  const queries = marineBuoys.buildQueries({ west: 170, south: -20, east: -160, north: 30 }, 5, now);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    const url = new URL(query.url);
    assert.equal(url.origin, 'https://coastwatch.pfeg.noaa.gov');
    assert.match(url.pathname, /\/erddap\/tabledap\/cwwcNDBCMet\.json$/);
    assert.ok(url.searchParams.has('latitude>=' + query.bounds.south));
    assert.ok(url.searchParams.has('latitude<=' + query.bounds.north));
    assert.equal(url.searchParams.get('.maxRows'), String(marineBuoys.MAX_TABLE_ROWS));
    assert.ok([...url.searchParams.keys()].some((key) => key.startsWith('time>=')));
    assert.ok([...url.searchParams.keys()].some((key) => key.startsWith('time<=')));
    assert.match(url.searchParams.get('station,longitude,latitude,time,wd,wspd,gst,wvht,dpd,apd,mwd,wtmp') || '', /^$/);
  }
  assert.throws(() => marineBuoys.queryUrl({ west: -181, south: 0, east: 1, north: 1 }, now), /bounds/);
});

test('normalizes latest station observations, wave fields, and safe official links', () => {
  const normalized = marineBuoys.normalizeCollection(payload([
    row('44060', new Date(now - 30 * 60 * 1000).toISOString()),
    row('44060', new Date(now - 10 * 60 * 1000).toISOString(), { wvht: 3.1, dpd: 8.2, wtmp: 18.4 }),
    row('bad<script>', new Date(now).toISOString()),
    ['44061', -181, 34, new Date(now).toISOString(), 0, 1, 1, 1, 1, 1, 1, 1]
  ]));
  assert.equal(normalized.count, 1);
  const feature = normalized.collection.features[0];
  assert.equal(feature.properties.stationId, '44060');
  assert.equal(feature.properties.waveHeightM, 3.1);
  assert.equal(feature.properties.dominantWavePeriodS, 8.2);
  assert.equal(feature.properties.seaSurfaceTemperatureC, 18.4);
  assert.equal(feature.properties.officialUrl, 'https://www.ndbc.noaa.gov/station_page.php?station=44060');
  assert.equal(normalized.updatedAt, now - 10 * 60 * 1000);
  assert.equal(marineBuoys.freshness(normalized.updatedAt, 60 * 60 * 1000, now).state, 'fresh');
  assert.equal(marineBuoys.freshness(now - 60 * 60 * 1000 - 1, 60 * 60 * 1000, now).state, 'stale');
});

test('controller renders DOM-popup layers and keeps the last good layer on outage', async () => {
  let enabled = true;
  let fail = false;
  const statuses = [];
  const map = {
    layers: [],
    zoom: 5,
    attributionControl: {
      added: [],
      addAttribution(value) { this.added.push(value); },
      removeAttribution(value) { this.added = this.added.filter((item) => item !== value); }
    },
    getZoom() { return this.zoom; },
    getBounds() {
      return { getWest: () => -100, getSouth: () => 25, getEast: () => -60, getNorth: () => 50 };
    },
    removeLayer(layer) { this.layers = this.layers.filter((item) => item !== layer); }
  };
  const leaflet = {
    geoJSON(collection, options) {
      return {
        collection, options,
        addTo(target) { target.layers.push(this); return this; }
      };
    },
    circleMarker() { return {}; }
  };
  const fetcher = async () => {
    if (fail) return { ok: false, status: 503 };
    return { ok: true, json: async () => payload([row('44060', new Date(Date.now() - 10 * 60 * 1000).toISOString())]) };
  };
  const controller = marineBuoys.create({
    L: leaflet, fetch: fetcher, getMap: () => map, isEnabled: () => enabled,
    isDocumentHidden: () => false, translate: (key, values) => values ? `${key}:${values.count || ''}` : key,
    setStatus: (message, state) => statuses.push({ message, state }), setTimeout: () => 1, clearTimeout: () => {}
  });

  const ready = await controller.refresh();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.count, 1);
  assert.equal(map.layers.length, 1);
  assert.equal(map.attributionControl.added.length, 1);
  assert.equal(map.layers[0].options.pane, 'contextVectorPane');

  fail = true;
  const failed = await controller.refresh();
  assert.equal(failed.status, 'error');
  assert.equal(failed.enabled, true);
  assert.equal(failed.count, 1);
  assert.equal(map.layers.length, 1);
  assert.ok(statuses.some((entry) => entry.state === 'error'));

  enabled = false;
  controller.disable();
  assert.deepEqual(controller.getState(), {
    enabled: false, status: 'off', count: 0, updatedAt: null, layer: null, zoom: null,
    lastGood: false, partial: false
  });
  assert.equal(map.layers.length, 0);
  assert.equal(map.attributionControl.added.length, 0);
});
