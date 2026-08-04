'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const snapshot = require('../js/situation-snapshot.js');

test('normalizes a privacy-bounded public snapshot and excludes private or precise state', () => {
  const result = snapshot.build({
    exportedAt: '2026-08-03T12:00:00Z', appVersion: '0.124.0', locale: 'es',
    map: { center: { latitude: 39.123456, longitude: -98.654321 }, zoom: 5.4 },
    sources: [
      { id: 'radar', source: 'RainViewer', issueAt: 1785758400000, freshness: 'fresh' },
      { id: 'unsafe id!', source: '<img src=x>', issueAt: 'bad', freshness: 'bad' }
    ],
    hazards: {
      alerts: { label: 'Alertas activas', visible: true, count: 3, sourceId: 'nws' },
      wildfires: { label: 'Incendios', visible: false, count: 0, sourceId: 'nifc' }
    },
    selectedCamera: {
      id: 123, name: 'Fixture camera', lat: 39.123456, lon: -98.654321,
      source: 'noaa', type: 'image', health: 'healthy', lastVerified: '2026-08-03T11:55:00Z',
      sourceUrl: 'https://weather.gov/fixture', url: 'https://camera.example/private-token'
    },
    favorites: ['private'], savedViews: [{ name: 'private' }], localOverlays: [{ geometry: 'private' }],
    publicSceneUrl: 'https://stormscope.example/#scene=1.e30'
  }, {
    includeSceneUrl: true,
    translate: (key, values) => key + (values ? ':' + Object.values(values).join('|') : ''),
    formatNumber: (value) => String(value),
    formatTime: (value) => String(value),
    formatCoordinate: (lat, lon) => lat.toFixed(2) + ',' + lon.toFixed(2),
    freshnessLabel: (value) => value
  });
  const data = result.json;
  assert.equal(data.schema, 1);
  assert.deepEqual(data.map, { center: { latitude: 39.12, longitude: -98.65 }, zoom: 5 });
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].freshness, 'fresh');
  assert.deepEqual(data.hazards.alerts, {
    label: 'Alertas activas', visible: true, count: 3, source_id: 'nws'
  });
  assert.equal(data.selected_camera.name, 'Fixture camera');
  assert.equal(data.selected_camera.source_url, 'https://weather.gov/fixture');
  assert.equal(Object.hasOwn(data.selected_camera, 'id'), false);
  assert.equal(Object.hasOwn(data.selected_camera, 'latitude'), false);
  assert.equal(Object.hasOwn(data, 'favorites'), false);
  assert.equal(Object.hasOwn(data, 'savedViews'), false);
  assert.equal(data.public_scene_url, 'https://stormscope.example/#scene=1.e30');
  assert.match(result.text, /snapshot\.title/);
  assert.match(result.text, /39\.12,-98\.65/);
});

test('omits optional scene URLs unless explicitly requested and rejects unsafe links', () => {
  const input = { map: { lat: 0, lon: 0, zoom: 1 }, publicSceneUrl: 'javascript:alert(1)' };
  assert.equal(Object.hasOwn(snapshot.normalize(input, { includeSceneUrl: true }), 'public_scene_url'), false);
  assert.equal(Object.hasOwn(snapshot.normalize({ ...input, publicSceneUrl: 'https://stormscope.example/#scene=1.e30' }), 'public_scene_url'), false);
  const normalized = snapshot.normalize({ ...input, publicSceneUrl: 'https://stormscope.example/#scene=1.e30' }, { includeSceneUrl: true });
  assert.equal(normalized.public_scene_url, 'https://stormscope.example/#scene=1.e30');
  assert.throws(() => snapshot.normalize({ map: { lat: 91, lon: 0, zoom: 1 } }), /map center/);
});
