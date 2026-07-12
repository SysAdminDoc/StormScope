'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const spatial = require('../js/spatial-query.js');

const polygon = {
  type: 'Polygon',
  coordinates: [[[-100, 39], [-98, 39], [-98, 41], [-100, 41], [-100, 39]]]
};

function camera(id, overrides) {
  return Object.assign({
    id, name: `Camera ${id}`, lat: 40, lon: -99, health: 'healthy',
    last_verified: '2026-07-12T20:00:00Z', type: 'image'
  }, overrides);
}

test('polygon queries distinguish inside, boundary, nearby, holes, and bounds', () => {
  const withHole = {
    type: 'Polygon',
    coordinates: [polygon.coordinates[0], [[-99.2, 39.8], [-98.8, 39.8], [-98.8, 40.2], [-99.2, 40.2], [-99.2, 39.8]]]
  };
  const results = spatial.queryCameras([
    camera(1, { lat: 40.5, lon: -99 }),
    camera(2, { lat: 40, lon: -100 }),
    camera(3, { lat: 40, lon: -99 }),
    camera(4, { lat: 40, lon: -97.8 }),
    camera(5, { lat: 40, lon: -90 })
  ], withHole, { maxDistanceKm: 50, limit: 10 });
  assert.deepEqual(results.map(result => result.camera.id), [1, 2, 3, 4]);
  assert.equal(results[0].relation, 'inside');
  assert.equal(results[1].relation, 'inside');
  assert.equal(results[2].relation, 'nearby');
  assert.ok(results[2].distanceKm > 15 && results[2].distanceKm < 20);
  assert.ok(results[3].distanceKm > 15 && results[3].distanceKm < 20);
});

test('multipolygon and antimeridian geometry use boundary distance instead of centroid distance', () => {
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [
      [[[179, 10], [-179, 10], [-179, 12], [179, 12], [179, 10]]],
      [[[-101, 39], [-100, 39], [-100, 40], [-101, 40], [-101, 39]]]
    ]
  };
  const results = spatial.queryCameras([
    camera(1, { lat: 11, lon: 179.5 }),
    camera(2, { lat: 39.5, lon: -99.9 })
  ], geometry, { maxDistanceKm: 20 });
  assert.equal(results[0].camera.id, 1);
  assert.equal(results[0].inside, true);
  assert.ok(results[1].distanceKm < 10, 'distance should use the near polygon edge, not its centroid');
});

test('verified feeds rank before degraded and unknown while offline feeds are excluded', () => {
  const results = spatial.queryCameras([
    camera(1, { name: 'Unknown close', lon: -99, health: 'unknown', last_verified: null }),
    camera(2, { name: 'Degraded', lon: -99.5, health: 'degraded' }),
    camera(3, { name: 'Verified', lon: -99.8 }),
    camera(4, { name: 'Offline', health: 'offline' }),
    camera(5, { name: 'Link only', lon: -99.7, type: 'embed' })
  ], polygon, { limit: 10 });
  assert.deepEqual(results.map(result => result.camera.id), [5, 3, 2, 1]);
  assert.deepEqual(results.map(result => result.verification), ['verified', 'verified', 'degraded', 'unknown']);
  assert.deepEqual(spatial.monitorCandidates(results, 2, 4).map(item => item.id), [3, 2, 1]);
});

test('point and line queries expose bounded distance and deterministic bearing', () => {
  const point = { type: 'Point', coordinates: [-100, 40] };
  const east = spatial.queryCameras([camera(1, { lon: -99.9 })], point, { maxDistanceKm: 20 })[0];
  assert.ok(east.distanceKm > 8 && east.distanceKm < 9);
  assert.ok(east.bearing > 89 && east.bearing < 91);
  assert.deepEqual(spatial.queryCameras([camera(2, { lon: -90 })], point, { maxDistanceKm: 20 }), []);
  assert.equal(spatial.nearestGeometryPoint({ type: 'Unsupported', coordinates: [] }, { lat: 0, lon: 0 }), null);
});
