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
  assert.equal(weather.formatTime('invalid', 'es', 'Desconocido'), 'Desconocido');
  assert.match(weather.formatTime('2026-07-11T18:00:00Z', 'en-US'), /Jul 11/);
  assert.match(weather.formatOpenMeteoTime('2026-07-11T14:00', -14400, 'en-US'), /Jul 11/);
  assert.equal(weather.formatOpenMeteoTime('invalid', -14400, 'en-US'), 'Unknown');
  assert.equal(weather.formatOpenMeteoTime('invalid', -14400, 'es', 'Desconocido'), 'Desconocido');
});

test('NWS quantitative values convert explicitly to selected display units', () => {
  assert.equal(weather.temperatureFromCelsius(20, 'us'), '68°F');
  assert.equal(weather.temperatureFromCelsius(20, 'metric'), '20°C');
  assert.equal(weather.temperatureFromCelsius(null, 'us'), null);
  assert.equal(weather.windFromKmh(16.09344, 'us'), '10 mph');
  assert.equal(weather.windFromKmh(16, 'metric'), '16 km/h');
  assert.equal(weather.distanceFromKm(16.09344, 'us'), '10 mi');
  assert.equal(weather.distanceFromKm(16, 'metric'), '16 km');
});

test('observation stations are trusted, distance-ranked, and bounded', () => {
  const stations = weather.rankObservationStations({ features: [
    {
      id: 'https://api.weather.gov/stations/KFAR', geometry: { coordinates: [-96.8, 46.9] },
      properties: { stationIdentifier: 'KFAR', name: 'Fargo', distance: { value: 12000 } }
    },
    {
      id: 'https://api.weather.gov/stations/KBLI', geometry: { coordinates: [-122.5, 48.8] },
      properties: { stationIdentifier: 'KBLI', name: 'Bellingham', distance: { value: 2000 } }
    },
    {
      id: 'https://api.weather.gov.attacker.example/stations/EVIL', geometry: { coordinates: [-122.4, 48.7] },
      properties: { stationIdentifier: 'EVIL', distance: { value: 1 } }
    }
  ] }, { lat: 47, lon: -122 }, 2);
  assert.deepEqual(stations.map((station) => station.id), ['KBLI', 'KFAR']);
  assert.equal(stations[0].name, 'Bellingham');
  assert.equal(stations[0].distanceKm, 2);
  assert.equal(weather.trustedNwsUrl('https://api.weather.gov/gridpoints/TOP/31,80/stations') !== null, true);
  assert.equal(weather.trustedNwsUrl('https://api.weather.gov.attacker.example/stations/EVIL'), null);
});

test('NWS observation normalization rejects empty, invalid, and future reports', () => {
  const station = { id: 'KBLI', name: 'Bellingham', distanceKm: 2 };
  const valid = weather.normalizeNwsObservation({ properties: {
    timestamp: '2026-07-12T20:00:00Z', textDescription: 'Mostly Clear',
    temperature: { value: 20, unitCode: 'wmoUnit:degC' },
    windSpeed: { value: 16, unitCode: 'wmoUnit:km_h-1' },
    windDirection: { value: 0, unitCode: 'wmoUnit:degree_(angle)' },
    relativeHumidity: { value: 45, unitCode: 'wmoUnit:percent' }
  } }, station);
  assert.equal(valid.temperatureC, 20);
  assert.equal(valid.windDirection, 0);
  assert.equal(valid.station, station);
  assert.equal(weather.normalizeNwsObservation({ properties: {
    timestamp: '2026-07-12T20:00:00Z', textDescription: '',
    temperature: { value: 68, unitCode: 'wmoUnit:degF' },
    windSpeed: { value: 10, unitCode: 'wmoUnit:mi_h-1' }
  } }, station).temperatureC, 20);
  assert.equal(weather.normalizeNwsObservation({ properties: {
    timestamp: '2026-07-12T20:00:00Z', textDescription: '', temperature: { value: null }
  } }, station), null);
  assert.equal(weather.normalizeNwsObservation({ properties: {
    timestamp: '2026-07-12T20:00:00Z', textDescription: '', temperature: { value: 20, unitCode: 'bad:unit' }
  } }, station), null);
  assert.equal(weather.normalizeNwsObservation({ properties: {
    timestamp: new Date(Date.now() + 60 * 60 * 1000).toISOString(), textDescription: 'Future'
  } }, station), null);
});
