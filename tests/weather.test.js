'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const weather = require('../js/weather.js');

test('country and territory metadata overrides rectangular routing', () => {
  assert.equal(weather.shouldUseNws({ state: 'Washington', lat: 47, lon: -122 }), true);
  assert.equal(weather.shouldUseNws({ state: 'Canada', lat: 49, lon: -123 }), false);
  assert.equal(weather.shouldUseNws({ state: 'Mexico', lat: 32.5, lon: -117 }), false);
  assert.equal(weather.shouldUseNws({ state: 'Puerto Rico', lat: 18.2, lon: -66.5 }), true);
  assert.equal(weather.shouldUseNws({ state: '', lat: 44.4, lon: -110.6 }), true);
});

test('weather units default by locale and convert forecast values', () => {
  assert.equal(weather.normalizeUnits(null, 'en-US'), 'us');
  assert.equal(weather.normalizeUnits(null, 'de-DE'), 'metric');
  assert.equal(weather.temperatureFromFahrenheit(68, 'metric'), '20°C');
  assert.equal(weather.temperatureFromFahrenheit(68, 'us'), '68°F');
  assert.equal(weather.windFromMph('5 to 10 mph', 'metric'), '8 to 16 km/h');
});

test('weather timestamps distinguish invalid and locale-formatted values', () => {
  assert.equal(weather.formatTime(null, 'en-US'), 'Unknown');
  assert.equal(weather.formatTime('invalid', 'en-US'), 'Unknown');
  assert.match(weather.formatTime('2026-07-11T18:00:00Z', 'en-US'), /Jul 11/);
});
