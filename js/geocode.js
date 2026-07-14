/* Keyless client-side place/address geocoding (Photon primary, Nominatim
 * fallback) — both OSM-based. Honors provider rate limits via caller debounce;
 * results are used only for the in-session map view and are never persisted. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeGeocode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var PHOTON = 'https://photon.komoot.io/api';
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var MAX_RESULTS = 5;
  var MIN_QUERY = 3;
  var ATTRIBUTION = '© OpenStreetMap contributors';

  function normalizeQuery(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  function photonUrl(query) {
    var text = normalizeQuery(query);
    if (text.length < MIN_QUERY) throw new RangeError('Query is too short');
    var params = new URLSearchParams({ q: text, limit: String(MAX_RESULTS), lang: 'en' });
    return PHOTON + '?' + params.toString();
  }

  function nominatimUrl(query) {
    var text = normalizeQuery(query);
    if (text.length < MIN_QUERY) throw new RangeError('Query is too short');
    var params = new URLSearchParams({ q: text, format: 'jsonv2', limit: String(MAX_RESULTS), addressdetails: '0' });
    return NOMINATIM + '?' + params.toString();
  }

  function validCoordinate(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  function photonLabel(properties) {
    var parts = [properties.name];
    ['street', 'city', 'state', 'country'].forEach(function (key) {
      if (properties[key] && parts.indexOf(properties[key]) === -1) parts.push(properties[key]);
    });
    return parts.filter(Boolean).join(', ');
  }

  function parsePhoton(payload) {
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new TypeError('Photon response is not GeoJSON');
    }
    var results = [];
    payload.features.forEach(function (feature) {
      var geometry = feature && feature.geometry;
      var properties = feature && feature.properties || {};
      if (!geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return;
      var lon = Number(geometry.coordinates[0]);
      var lat = Number(geometry.coordinates[1]);
      if (!validCoordinate(lat, lon)) return;
      var label = photonLabel(properties);
      if (!label) return;
      results.push({ label: label, lat: lat, lon: lon });
    });
    return results.slice(0, MAX_RESULTS);
  }

  function parseNominatim(payload) {
    if (!Array.isArray(payload)) throw new TypeError('Nominatim response is not an array');
    var results = [];
    payload.forEach(function (row) {
      var lat = Number(row && row.lat);
      var lon = Number(row && row.lon);
      var label = row && (row.display_name || row.name);
      if (!validCoordinate(lat, lon) || !label) return;
      results.push({ label: String(label), lat: lat, lon: lon });
    });
    return results.slice(0, MAX_RESULTS);
  }

  return Object.freeze({
    PHOTON: PHOTON, NOMINATIM: NOMINATIM, MAX_RESULTS: MAX_RESULTS, MIN_QUERY: MIN_QUERY,
    ATTRIBUTION: ATTRIBUTION,
    normalizeQuery: normalizeQuery, photonUrl: photonUrl, nominatimUrl: nominatimUrl,
    parsePhoton: parsePhoton, parseNominatim: parseNominatim
  });
});
