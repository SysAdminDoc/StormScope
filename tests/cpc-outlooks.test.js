'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cpc = require('../js/cpc-outlooks.js');

const now = Date.UTC(2026, 7, 1, 12, 0, 0);

function polygonFeature(objectid, properties = {}, coordinates = [[[-100, 35], [-96, 35], [-96, 39], [-100, 39], [-100, 35]]]) {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates },
    properties: { objectid, ...properties }
  };
}

function feedPayload(feed, feature) {
  return { type: 'FeatureCollection', features: [feature], properties: { exceededTransferLimit: false }, feed };
}

test('builds six bounded CPC feed queries and splits dateline views', () => {
  assert.deepEqual(cpc.buildQueries({ west: -100, south: 20, east: -60, north: 55 }, 2), []);
  const queries = cpc.buildQueries({ west: 170, south: -20, east: -160, north: 30 }, 5);
  assert.equal(queries.length, 12);
  assert.deepEqual([...new Set(queries.map((query) => query.feed))], cpc.feeds.map((feed) => feed.id));
  for (const query of queries) {
    const url = new URL(query.url);
    assert.equal(url.hostname, 'mapservices.weather.noaa.gov');
    assert.match(url.pathname, /\/vector\/rest\/services\/outlooks\/cpc_/);
    assert.equal(url.searchParams.get('where'), '1=1');
    assert.equal(url.searchParams.get('f'), 'geojson');
    assert.equal(url.searchParams.get('resultRecordCount'), String(cpc.MAX_RECORDS));
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('geometryType'), 'esriGeometryEnvelope');
  }
  assert.throws(() => cpc.queryUrl('droughtMonthly', { west: -181, south: 0, east: 1, north: 1 }), /bounds/);
  assert.throws(() => cpc.queryUrl('missing', { west: -1, south: 0, east: 1, north: 1 }), /feed/);
});

test('normalizes drought and extended-range polygons with bounded safe fields', () => {
  const monthly = cpc.normalizeCollection(feedPayload('droughtMonthly', polygonFeature(7, {
    outlook: 'Development', target: 'Aug 2026', fcst_date: '07/31/2026',
    idp_filedate: now - 60000, idp_ingestdate: now
  })), 'droughtMonthly');
  assert.equal(monthly.count, 1);
  assert.equal(monthly.collection.features[0].properties.cpcCategory, 'development');
  assert.equal(monthly.collection.features[0].properties.target, 'Aug 2026');
  assert.equal(monthly.collection.features[0].properties.validAt, Date.UTC(2026, 6, 31));
  assert.equal(monthly.collection.features[0].properties.officialUrl, cpc.OFFICIAL_URL);

  const extended = cpc.normalizeCollection(feedPayload('sixTenTemperature', polygonFeature(11, {
    fcst_date: now, start_date: now + 86400000, end_date: now + 5 * 86400000,
    prob: 36, cat: 'Above', idp_filedate: now - 120000, idp_source: '<script>alert(1)</script>'
  })), 'sixTenTemperature');
  const properties = extended.collection.features[0].properties;
  assert.equal(properties.cpcKind, 'temperature');
  assert.equal(properties.cpcHorizon, '6-10');
  assert.equal(properties.cpcCategory, 'above');
  assert.equal(properties.probability, 36);
  assert.equal(properties.startsAt, now + 86400000);
  assert.equal(properties.endsAt, now + 5 * 86400000);
  assert.equal(properties.sourceLabel, 'CPC 6–10 day temperature outlook');
  assert.equal(Object.hasOwn(properties, 'idp_source'), false);

  const invalid = cpc.normalizeCollection({ type: 'FeatureCollection', features: [
    polygonFeature(1, { outlook: 'Removal' }, [[['bad', 0], [-1, 0], [-1, 1], ['bad', 0]]]),
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
    polygonFeature(2, { outlook: 'No_Drought' })
  ] }, 'droughtSeasonal');
  assert.equal(invalid.count, 1);
  assert.equal(invalid.collection.features[0].properties.cpcCategory, 'no-drought');
});

test('merges feeds, styles categories, and reports freshness', () => {
  const monthly = cpc.normalizeCollection(feedPayload('droughtMonthly', polygonFeature(1, {
    outlook: 'Persistence', fcst_date: now, idp_filedate: now
  })), 'droughtMonthly');
  const sixTen = cpc.normalizeCollection(feedPayload('sixTenPrecipitation', polygonFeature(1, {
    start_date: now, end_date: now + 86400000, fcst_date: now, prob: 44, cat: 'Below', idp_filedate: now
  })), 'sixTenPrecipitation');
  const merged = cpc.mergeCollections([monthly, sixTen]);
  assert.equal(merged.count, 2);
  assert.equal(merged.droughtCount, 1);
  assert.equal(merged.outlookCount, 1);
  assert.equal(cpc.style({ cpcCategory: 'development' }).fillColor, '#f5b642');
  assert.equal(cpc.style({ cpcKind: 'precipitation', cpcCategory: 'below' }).fillColor, '#c4b5fd');
  assert.equal(cpc.freshness(now, 60 * 60 * 1000, now).state, 'fresh');
  assert.equal(cpc.freshness(now - 60 * 60 * 1000 - 1, 60 * 60 * 1000, now).state, 'stale');
});

test('controller keeps its last good CPC layer on total outage and tears down cleanly', async () => {
  let enabled = true;
  let fail = false;
  const statuses = [];
  const map = {
    layers: [], zoom: 5,
    attributionControl: {
      added: [],
      addAttribution(value) { this.added.push(value); },
      removeAttribution(value) { this.added = this.added.filter((item) => item !== value); }
    },
    getZoom() { return this.zoom; },
    getBounds() {
      return { getWest: () => -110, getSouth: () => 25, getEast: () => -70, getNorth: () => 50 };
    },
    removeLayer(layer) { this.layers = this.layers.filter((item) => item !== layer); }
  };
  const leaflet = {
    geoJSON(collection, options) {
      return { collection, options, addTo(target) { target.layers.push(this); return this; } };
    }
  };
  const fetcher = async (url) => {
    if (fail) return { ok: false, status: 503 };
    const query = new URL(url);
    const path = query.pathname;
    const feed = path.includes('cpc_drought_outlk') && path.endsWith('/1/query') ? 'droughtMonthly'
      : path.includes('cpc_drought_outlk') ? 'droughtSeasonal'
        : path.includes('cpc_6_10_day_outlk') && path.endsWith('/0/query') ? 'sixTenTemperature'
          : path.includes('cpc_6_10_day_outlk') ? 'sixTenPrecipitation'
            : path.includes('cpc_8_14_day_outlk') && path.endsWith('/0/query') ? 'eightFourteenTemperature'
              : 'eightFourteenPrecipitation';
    const feature = feed.startsWith('drought')
      ? polygonFeature(feed === 'droughtMonthly' ? 1 : 2, { outlook: 'Development', fcst_date: now, idp_filedate: now })
      : polygonFeature(feed.length, { fcst_date: now, start_date: now, end_date: now + 86400000, prob: 30, cat: 'Normal', idp_filedate: now });
    return { ok: true, json: async () => feedPayload(feed, feature) };
  };
  const controller = cpc.create({
    L: leaflet, fetch: fetcher, getMap: () => map, isEnabled: () => enabled,
    isDocumentHidden: () => false, translate: (key, values) => values ? `${key}:${values.count || ''}` : key,
    setStatus: (message, state) => statuses.push({ message, state }), setTimeout: () => 1, clearTimeout: () => {}
  });

  const ready = await controller.refresh();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.count, 6);
  assert.equal(ready.droughtCount, 2);
  assert.equal(ready.outlookCount, 4);
  assert.equal(map.layers.length, 1);
  assert.equal(map.attributionControl.added.length, 1);

  fail = true;
  const failed = await controller.refresh();
  assert.equal(failed.status, 'error');
  assert.equal(failed.enabled, true);
  assert.equal(failed.count, 6);
  assert.equal(failed.lastGood, true);
  assert.equal(map.layers.length, 1);
  assert.ok(statuses.some((entry) => entry.state === 'error'));

  enabled = false;
  controller.disable();
  assert.deepEqual(controller.getState(), {
    enabled: false, status: 'off', count: 0, droughtCount: 0, outlookCount: 0,
    updatedAt: null, layer: null, zoom: null, lastGood: false, partial: false
  });
  assert.equal(map.layers.length, 0);
  assert.equal(map.attributionControl.added.length, 0);
});
