/* Keyless USGS earthquake feed contract (static GeoJSON, CORS: *). */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeEarthquakes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
  var MAGNITUDES = ['significant', '4.5', '2.5', '1.0', 'all'];
  var PERIODS = ['hour', 'day', 'week', 'month'];

  var provider = Object.freeze({
    id: 'earthquakes',
    label: 'USGS earthquakes',
    defaultVisible: false,
    defaultMagnitude: '2.5',
    defaultPeriod: 'day',
    magnitudes: Object.freeze(MAGNITUDES.slice()),
    periods: Object.freeze(PERIODS.slice()),
    refreshMs: 5 * 60 * 1000,
    // USGS updates the summary feeds every minute; treat a snapshot older than
    // one refresh interval plus slack as stale.
    staleMs: 15 * 60 * 1000,
    attribution: Object.freeze({
      text: 'USGS Earthquake Hazards Program',
      url: 'https://earthquake.usgs.gov/earthquakes/map/'
    })
  });

  function assertChoice(value, allowed, label) {
    var text = String(value == null ? '' : value).trim().toLowerCase();
    if (allowed.indexOf(text) === -1) throw new TypeError(label + ' is unsupported');
    return text;
  }

  function buildFeedUrl(magnitude, period) {
    var mag = assertChoice(magnitude, MAGNITUDES, 'earthquake magnitude');
    var span = assertChoice(period, PERIODS, 'earthquake period');
    return FEED_BASE + mag + '_' + span + '.geojson';
  }

  function normalizeCollection(payload) {
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new TypeError('USGS earthquake response is not GeoJSON');
    }
    var seen = Object.create(null);
    var features = [];
    payload.features.forEach(function (feature) {
      var geometry = feature && feature.geometry;
      var properties = feature && feature.properties;
      if (!geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return;
      var lon = Number(geometry.coordinates[0]);
      var lat = Number(geometry.coordinates[1]);
      var depthKm = Number(geometry.coordinates[2]);
      var mag = Number(properties && properties.mag);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(mag)) return;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
      var id = String(feature.id == null ? lon + ',' + lat + ',' + mag : feature.id);
      if (seen[id]) return;
      seen[id] = true;
      var time = Number(properties && properties.time);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          id: id,
          mag: mag,
          place: properties && properties.place ? String(properties.place) : '',
          depthKm: Number.isFinite(depthKm) ? depthKm : null,
          time: Number.isFinite(time) ? time : null,
          url: properties && properties.url ? String(properties.url) : ''
        }
      });
    });
    var generatedAt = Number(payload.metadata && payload.metadata.generated);
    return {
      collection: { type: 'FeatureCollection', features: features },
      generatedAt: Number.isFinite(generatedAt) ? generatedAt : null,
      count: features.length
    };
  }

  // Marker radius grows with magnitude but is clamped so a swarm of small
  // quakes stays readable and a great quake does not blanket the map.
  function markerRadius(magnitude) {
    var mag = Number(magnitude);
    if (!Number.isFinite(mag)) return 4;
    return Math.max(3, Math.min(18, 3 + mag * 2));
  }

  // Warmer colors for stronger quakes; deterministic thresholds only.
  function markerColor(magnitude) {
    var mag = Number(magnitude);
    if (mag >= 6) return '#d6336c';
    if (mag >= 4.5) return '#f76707';
    if (mag >= 2.5) return '#f59f00';
    return '#74b816';
  }

  function freshness(generatedAt, staleMs, now) {
    if (generatedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(generatedAt);
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var ageMs = Math.max(0, current - timestamp);
    return { state: ageMs > staleMs ? 'stale' : 'fresh', ageMs: ageMs };
  }

  return Object.freeze({
    provider: provider,
    MAGNITUDES: Object.freeze(MAGNITUDES.slice()),
    PERIODS: Object.freeze(PERIODS.slice()),
    buildFeedUrl: buildFeedUrl,
    normalizeCollection: normalizeCollection,
    markerRadius: markerRadius,
    markerColor: markerColor,
    freshness: freshness
  });
});
