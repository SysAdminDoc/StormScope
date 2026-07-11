'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const context = require('../js/context-layers.js');

test('official context providers are keyless, attributed, and off by default', () => {
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
  const dateline = context.buildWildfireQueries({ west: 170, south: 45, east: 190, north: 70 });
  assert.equal(dateline.length, 2);
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
