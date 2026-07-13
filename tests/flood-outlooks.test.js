'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const outlooks = require('../js/flood-outlooks.js');

function polygon(properties) {
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-100, 35], [-99, 35], [-99, 36], [-100, 35]]] }, properties };
}

test('builds allowlisted complete WPC queries', () => {
  const ero = new URL(outlooks.queryUrl('ero', 2, 500));
  assert.match(ero.pathname, /MapServer\/1\/query$/);
  assert.equal(ero.searchParams.get('resultOffset'), '500');
  assert.equal(ero.searchParams.get('orderByFields'), 'objectid ASC');
  assert.doesNotMatch(ero.searchParams.get('outFields'), /\*/);
  assert.match(outlooks.queryUrl('flood'), /sig_riv_fld_outlk/);
});

test('normalizes UTC issue and exact short valid periods with category ordering', () => {
  const result = outlooks.normalizeCollection({ type: 'FeatureCollection', features: [
    polygon({ objectid: 2, dn: 3, outlook: 'Moderate (At Least 40%)', issue_time: '2026-07-13 01:03:00', start_time: '2026-07-13 01:00:00', end_time: '2026-07-13 12:00:00' }),
    polygon({ objectid: 1, dn: 1, outlook: 'Marginal (At Least 5%)', issue_time: '2026-07-13 01:03:00', start_time: '2026-07-13 01:00:00', end_time: '2026-07-13 12:00:00' })
  ] }, 'ero', 1);
  assert.equal(result.features[0].properties.outlookCategory, 'marginal');
  assert.equal(result.features[1].properties.outlookCategory, 'moderate');
  assert.equal(result.features[0].properties.issuedAt, '2026-07-13T01:03:00.000Z');
  assert.equal(Date.parse(result.features[0].properties.endsAt) - Date.parse(result.features[0].properties.startsAt), 11 * 3600000);
  assert.notEqual(outlooks.style('ero', 'marginal').dashArray, outlooks.style('ero', 'moderate').dashArray);
});

test('pagination follows transfer flags and fails on no progress', async () => {
  let calls = 0;
  const fetcher = async () => ({ ok: true, json: async () => {
    calls += 1;
    return { type: 'FeatureCollection', features: [polygon({ objectid: 1, dn: 1, outlook: 'Marginal' })],
      properties: { exceededTransferLimit: true } };
  } });
  await assert.rejects(outlooks.fetchAllPages(fetcher, 'ero', 1), /no progress/);
  assert.equal(calls, 2);
});

test('gauge join requires matching IDs, units, current observation, and finite official thresholds', () => {
  const candidates = outlooks.gaugeCandidates({ type: 'FeatureCollection', features: [{ type: 'Feature',
    geometry: { type: 'Point', coordinates: [-90.18, 38.63] }, properties: {
      monitoring_location_id: 'USGS-07010000', value: '17.63', unit_of_measure: 'ft', time: '2026-07-13T01:00:00Z'
    } }] });
  assert.equal(candidates.length, 1);
  const detail = { usgsId: '07010000', name: 'Mississippi River at St. Louis',
    status: { observed: { primary: 31, primaryUnit: 'ft', validTime: '2026-07-13T01:00:00Z' } },
    flood: { stageUnits: 'ft', categories: { action: { stage: 28 }, minor: { stage: 30 }, moderate: { stage: 35 }, major: { stage: -9999 } } } };
  const gauge = outlooks.normalizeGauge(candidates[0], detail, Date.parse('2026-07-13T02:00:00Z'));
  assert.equal(gauge.properties.category, 'minor');
  assert.equal(outlooks.normalizeGauge(candidates[0], { ...detail, usgsId: '99999999' }), null);
  assert.equal(outlooks.normalizeGauge(candidates[0], { ...detail, flood: { ...detail.flood, stageUnits: 'm' } }), null);
  assert.equal(outlooks.normalizeGauge(candidates[0], { ...detail, flood: { stageUnits: 'ft', categories: { major: { stage: -9999 } } } }), null);
});

test('rejects unsafe geometry and incomplete capped gauge responses', () => {
  assert.throws(() => outlooks.normalizeCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-90, 38] }, properties: { dn: 1, outlook: 'Marginal' } }
  ] }, 'ero', 1), /Invalid outlook/);
  assert.throws(() => outlooks.gaugeCandidates({ type: 'FeatureCollection', features: [], links: [{ rel: 'next' }] }), /incomplete/);
});
