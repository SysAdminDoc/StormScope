'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const terminator = require('../js/solar-terminator.js');

test('solar position tracks equinox and solstice subsolar latitude', () => {
  const equinox = terminator.solarPosition(Date.parse('2024-03-20T03:06:00Z'));
  assert.ok(Math.abs(equinox.latitude) < 0.2);
  assert.ok(Math.abs(equinox.longitude - 135) < 2);

  const northernSolstice = terminator.solarPosition(Date.parse('2024-06-21T12:00:00Z'));
  const southernSolstice = terminator.solarPosition(Date.parse('2024-12-21T12:00:00Z'));
  assert.ok(northernSolstice.latitude > 23);
  assert.ok(southernSolstice.latitude < -23);
  assert.ok(terminator.illuminationCosine(northernSolstice.latitude, northernSolstice.longitude, northernSolstice) > 0.99);
  assert.ok(terminator.illuminationCosine(-northernSolstice.latitude, northernSolstice.longitude + 180, northernSolstice) < -0.99);
});

test('night polygon is bounded, finite, and resolution capped', () => {
  const timestamp = Date.parse('2026-08-03T12:00:00Z');
  const ring = terminator.buildTerminatorRing(timestamp, { segments: 72 }).ring;
  const polygon = terminator.buildNightPolygon(timestamp, { segments: 999 });
  assert.equal(ring.length, 73);
  assert.ok(polygon.length <= terminator.MAX_SEGMENTS + 3);
  assert.ok(polygon.every(([latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180));
  assert.throws(() => terminator.solarPosition('not-a-time'), /finite/);
  assert.throws(() => terminator.buildTerminatorRing(timestamp, { segments: Infinity }), /finite/);
});

test('night polygon follows the illuminated hemisphere at both solstices', () => {
  function contains(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [latitude, longitude] = ring[index];
      const [previousLatitude, previousLongitude] = ring[previous];
      if (((longitude > point.longitude) !== (previousLongitude > point.longitude)) &&
          point.latitude < (previousLatitude - latitude) * (point.longitude - longitude) /
            (previousLongitude - longitude) + latitude) inside = !inside;
    }
    return inside;
  }

  for (const timestamp of [Date.parse('2024-06-21T12:00:00Z'), Date.parse('2024-12-21T12:00:00Z')]) {
    const position = terminator.solarPosition(timestamp);
    const polygon = terminator.buildNightPolygon(timestamp, { segments: 180 });
    for (let latitude = -80; latitude <= 80; latitude += 20) {
      for (let longitude = -160; longitude <= 160; longitude += 20) {
        const expected = terminator.illuminationCosine(latitude, longitude, position) < 0;
        assert.equal(contains({ latitude, longitude }, polygon), expected,
          `night geometry mismatch at ${latitude},${longitude}`);
      }
    }
  }
});
