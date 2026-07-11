(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeWeather = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var US_REGIONS = new Set([
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
    'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
    'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
    'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
    'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
    'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
    'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
    'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
    'District of Columbia', 'DC', 'Puerto Rico', 'U.S. Virgin Islands',
    'Virgin Islands, U.S.', 'Guam', 'American Samoa', 'Northern Mariana Islands'
  ]);

  function inNwsCoverageBounds(lat, lon) {
    return lat >= 24.3 && lat <= 49.5 && lon >= -125 && lon <= -66.5 ||
      lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129 ||
      lat >= 18.5 && lat <= 22.5 && lon >= -161 && lon <= -154.5 ||
      lat >= 17.5 && lat <= 18.7 && lon >= -67.5 && lon <= -64.5 ||
      lat >= 13.1 && lat <= 13.8 && lon >= 144.5 && lon <= 145 ||
      lat >= 17.6 && lat <= 18.5 && lon >= -65.2 && lon <= -64.5;
  }

  function shouldUseNws(camera) {
    var region = String(camera.state || camera.country || '').trim();
    if (US_REGIONS.has(region)) return true;
    if (region) return false;
    return inNwsCoverageBounds(Number(camera.lat), Number(camera.lon));
  }

  function normalizeUnits(value, locale) {
    if (value === 'metric' || value === 'us') return value;
    return String(locale || '').toLowerCase().startsWith('en-us') ? 'us' : 'metric';
  }

  function temperatureFromFahrenheit(value, units) {
    var number = Number(value);
    return units === 'metric' ? Math.round((number - 32) * 5 / 9) + '°C' : Math.round(number) + '°F';
  }

  function windFromMph(value, units) {
    var text = String(value || '');
    var converted = text.replace(/\d+(?:\.\d+)?/g, function (match) {
      var number = Number(match);
      return String(Math.round(units === 'metric' ? number * 1.609344 : number));
    });
    return converted.replace(/\s*mph\b/i, units === 'metric' ? ' km/h' : ' mph').trim();
  }

  function formatTime(value, locale) {
    if (!value) return 'Unknown';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat(locale || undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(date);
  }

  return {
    formatTime: formatTime,
    inNwsCoverageBounds: inNwsCoverageBounds,
    normalizeUnits: normalizeUnits,
    shouldUseNws: shouldUseNws,
    temperatureFromFahrenheit: temperatureFromFahrenheit,
    windFromMph: windFromMph
  };
});
