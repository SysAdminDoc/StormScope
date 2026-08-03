'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const context = require('../js/context-layers.js');

test('GOES metadata and export requests are time and viewport bounded', () => {
  const metadata = context.parseGoesMetadata({ timeInfo: { timeExtent: [1000, 2000] } });
  assert.equal(metadata.latestTime, 2000);
  assert.deepEqual(metadata.frameTimes, [1000, 2000]);
  const requests = context.buildGoesExportRequests(
    { west: -125, south: 25, east: -66, north: 50 }, metadata.latestTime, { width: 1400, height: 1000 }
  );
  const url = new URL(requests[0].url);
  assert.equal(requests.length, 1);
  assert.equal(url.hostname, 'satellitemaps.nesdis.noaa.gov');
  assert.equal(url.searchParams.get('bbox'), '-125,25,-66,50');
  assert.equal(url.searchParams.get('size'), '1200,900');
  assert.equal(url.searchParams.get('time'), '2000');
  assert.deepEqual(requests[0].bounds, [[25, -125], [50, -66]]);
  assert.equal(context.buildGoesExportRequests(
    { west: 170, south: -20, east: 190, north: 20 }, 2000, { width: 600, height: 400 }
  ).length, 2);
  assert.throws(() => context.parseGoesMetadata({}), /frame time/);
});

test('GOES frame enumeration is evenly sampled and capped', () => {
  const oneDay = 24 * 60 * 60 * 1000;
  const times = context.buildGoesFrameTimes(0, oneDay, { maxFrames: 12, minFrameIntervalMs: 10 * 60 * 1000 });
  assert.equal(times.length, 12);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), oneDay);
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
  assert.throws(() => context.buildGoesFrameTimes(2000, 1000), /invalid/);
});

test('official context providers are keyless, attributed, and off by default', () => {
  assert.equal(context.providers.satellite.defaultVisible, false);
  assert.equal(context.providers.lightning.defaultVisible, false);
  assert.equal(context.providers.wildfires.defaultVisible, false);
  assert.equal(new URL(context.providers.lightning.wmsUrl).hostname, 'nowcoast.noaa.gov');
  assert.equal(new URL(context.providers.wildfires.layerUrl).hostname, 'services3.arcgis.com');
  assert.match(context.providers.lightning.attribution.text, /NOAA/);
  assert.match(context.providers.wildfires.attribution.text, /NIFC/);
});

test('NOAA capabilities expose a validated latest lightning-density frame', () => {
  const parsed = context.parseLightningCapabilities(`
    <Layer><Name>ldn_lightning_strike_density</Name>
    <Dimension name="time">2026-07-11T21:45:00Z,2026-07-11T22:00:00Z</Dimension></Layer>`);
  assert.equal(parsed.frameCount, 2);
  assert.equal(new Date(parsed.latestTime).toISOString(), '2026-07-11T22:00:00.000Z');
  assert.throws(() => context.parseLightningCapabilities('<Layer/>'), /missing/);
});

test('wildfire queries are viewport bounded and split safely across the dateline', () => {
  const normal = context.buildWildfireQueries({ west: -125, south: 30, east: -65, north: 50 });
  assert.equal(normal.length, 1);
  const query = new URL(normal[0]);
  assert.equal(query.searchParams.get('geometry'), '-125,30,-65,50');
  assert.equal(query.searchParams.get('where'), "attr_IncidentTypeCategory='WF'");
  assert.equal(query.searchParams.get('f'), 'geojson');
  assert.equal(query.searchParams.get('orderByFields'), 'OBJECTID ASC');
  assert.equal(query.searchParams.get('resultOffset'), '0');
  const dateline = context.buildWildfireQueries({ west: 170, south: 45, east: 190, north: 70 });
  assert.equal(dateline.length, 2);
});

test('wildfire pagination follows transfer flags and deduplicates dateline pages', async () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] };
  const urls = context.buildWildfireQueries({ west: 170, south: 45, east: 190, north: 70 });
  const offsets = [];
  const result = await context.fetchWildfirePages({
    urls,
    pageSize: 1,
    fetchPage: async url => {
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get('resultOffset'));
      offsets.push(offset);
      const id = parsed.searchParams.get('geometry').startsWith('170') ? 1 : (offset ? 2 : 1);
      return {
        type: 'FeatureCollection',
        properties: { exceededTransferLimit: !parsed.searchParams.get('geometry').startsWith('170') && offset === 0 },
        features: [{ type: 'Feature', geometry, properties: { OBJECTID: id, attr_IncidentTypeCategory: 'WF' } }]
      };
    }
  });
  assert.deepEqual(offsets, [0, 0, 1]);
  assert.deepEqual(result.collection.features.map(feature => feature.properties.OBJECTID), [1, 2]);
  assert.equal(result.pageCount, 3);
});

test('wildfire pagination rejects no-progress and page-cap responses', async () => {
  const url = context.buildWildfireQueries({ west: -125, south: 30, east: -65, north: 50 });
  await assert.rejects(context.fetchWildfirePages({
    urls: url,
    fetchPage: async () => ({ type: 'FeatureCollection', exceededTransferLimit: true, features: [] })
  }), /no progress/);
  await assert.rejects(context.fetchWildfirePages({
    urls: url,
    maxPages: 1,
    fetchPage: async () => ({
      type: 'FeatureCollection', exceededTransferLimit: true,
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { OBJECTID: 1, attr_IncidentTypeCategory: 'WF' } }]
    })
  }), /page cap/);
});

test('wildfire responses retain unique wildfire polygons and expose metadata freshness', () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] };
  const normalized = context.normalizeWildfireCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry, properties: { OBJECTID: 1, attr_IncidentTypeCategory: 'WF' } },
    { type: 'Feature', geometry, properties: { OBJECTID: 1, attr_IncidentTypeCategory: 'WF' } },
    { type: 'Feature', geometry, properties: { OBJECTID: 2, attr_IncidentTypeCategory: 'RX' } }
  ] });
  assert.equal(normalized.features.length, 1);
  const metadata = context.parseWildfireMetadata({ editingInfo: { dataLastEditDate: 1000 }, maxRecordCount: 2000 });
  assert.deepEqual(metadata, { updatedAt: 1000, maxRecordCount: 2000 });
  assert.equal(context.freshness(1000, 500, 1200).state, 'fresh');
  assert.equal(context.freshness(1000, 500, 1600).state, 'stale');
});
