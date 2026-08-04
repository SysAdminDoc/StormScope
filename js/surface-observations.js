/* Keyless NOAA Aviation Weather Center METAR surface-observation contract. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSurfaceObservations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services';
  var LAYER_URL = ROOT + '/aviation/awc_aviation_weather/MapServer/12';
  var PAGE_SIZE = 2000;
  var MAX_FEATURES = 2000;
  var MIN_ZOOM = 4;
  var OUT_FIELDS = [
    'objectid', 'raw_text', 'station_id', 'observation_time', 'latitude', 'longitude',
    'temp_c', 'dewpoint_c', 'winddir', 'wind_speed_kt', 'wind_gust_kt',
    'visibility_statute_mi', 'wx_string', 'sky_cover', 'flight_category',
    'cloud_base_ft_agl', 'ceiling_ft', 'idp_filedate', 'idp_ingestdate'
  ].join(',');
  var FLIGHT_CATEGORIES = ['VFR', 'MVFR', 'IFR', 'LIFR', 'UNKNOWN'];

  var provider = Object.freeze({
    id: 'surfaceObservations',
    label: 'NOAA Aviation Weather Center METAR observations',
    defaultVisible: false,
    refreshMs: 10 * 60 * 1000,
    staleMs: 35 * 60 * 1000,
    minZoom: MIN_ZOOM,
    maxRecords: MAX_FEATURES,
    attribution: Object.freeze({
      text: 'NOAA Aviation Weather Center',
      url: 'https://aviationweather.gov/'
    })
  });

  function boundedText(value, maximum) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, maximum || 320);
  }

  function finiteNumber(value, minimum, maximum) {
    if (value == null || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
  }

  function timestampMs(value) {
    if (value == null || value === '') return null;
    var number = Number(value);
    if (Number.isFinite(number)) {
      if (number > 0 && number < 100000000000) number *= 1000;
      return number > 0 ? number : null;
    }
    var text = String(value).trim();
    if (!text) return null;
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(text)) text = text.replace(' ', 'T') + 'Z';
    var parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    var west = Number(bounds.west);
    var south = Number(bounds.south);
    var east = Number(bounds.east);
    var north = Number(bounds.north);
    if (![west, south, east, north].every(Number.isFinite) ||
        south < -90 || north > 90 || south > north ||
        west < -180 || west > 180 || east < -180 || east > 180) return null;
    return { west: west, south: south, east: east, north: north };
  }

  function boundsParts(bounds) {
    var normalized = normalizeBounds(bounds);
    if (!normalized) return [];
    if (normalized.west <= normalized.east) return [normalized];
    return [
      { west: normalized.west, south: normalized.south, east: 180, north: normalized.north },
      { west: -180, south: normalized.south, east: normalized.east, north: normalized.north }
    ];
  }

  function queryUrl(bounds) {
    var normalized = normalizeBounds(bounds);
    if (!normalized) throw new TypeError('surface-observation bounds are invalid');
    var params = new URLSearchParams({
      where: '1=1',
      outFields: OUT_FIELDS,
      returnGeometry: 'true',
      outSR: '4326',
      geometry: [normalized.west, normalized.south, normalized.east, normalized.north].join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      resultRecordCount: String(PAGE_SIZE),
      f: 'geojson'
    });
    return LAYER_URL + '/query?' + params.toString();
  }

  function buildQueries(bounds, zoom) {
    var numericZoom = Number(zoom);
    if (!Number.isFinite(numericZoom) || numericZoom < MIN_ZOOM) return [];
    return boundsParts(bounds).map(queryUrl);
  }

  function coordinateFromFeature(feature, properties) {
    var geometry = feature && feature.geometry;
    if (!geometry || ['Point', 'MultiPoint'].indexOf(geometry.type) === -1) return null;
    var coordinates = geometry && geometry.coordinates;
    if (geometry.type === 'MultiPoint' && Array.isArray(coordinates)) coordinates = coordinates[0];
    var geometryLon = Array.isArray(coordinates) ? finiteNumber(coordinates[0], -180, 180) : null;
    var geometryLat = Array.isArray(coordinates) ? finiteNumber(coordinates[1], -90, 90) : null;
    var lon = finiteNumber(properties.longitude, -180, 180);
    var lat = finiteNumber(properties.latitude, -90, 90);
    return {
      lon: lon == null ? geometryLon : lon,
      lat: lat == null ? geometryLat : lat
    };
  }

  function normalizedCategory(value) {
    var category = boundedText(value, 16).toUpperCase();
    return FLIGHT_CATEGORIES.indexOf(category) === -1 ? 'UNKNOWN' : category;
  }

  function normalizeFeature(feature) {
    if (!feature || feature.type !== 'Feature' || !feature.properties ||
        typeof feature.properties !== 'object' || Array.isArray(feature.properties)) return null;
    var source = feature.properties;
    var coordinate = coordinateFromFeature(feature, source);
    if (!coordinate) return null;
    if (coordinate.lon == null || coordinate.lat == null) return null;
    var stationId = boundedText(source.station_id, 16).toUpperCase();
    var objectId = boundedText(source.objectid, 64);
    if (!stationId && !objectId) return null;
    var observationTime = timestampMs(source.observation_time);
    var sourceUpdatedAt = timestampMs(source.idp_ingestdate) || timestampMs(source.idp_filedate);
    var properties = {
      stationId: stationId || objectId,
      rawText: boundedText(source.raw_text, 2048),
      observationTime: observationTime,
      latitude: coordinate.lat,
      longitude: coordinate.lon,
      tempC: finiteNumber(source.temp_c, -100, 80),
      dewpointC: finiteNumber(source.dewpoint_c, -120, 80),
      windDirection: finiteNumber(source.winddir, 0, 360),
      windSpeedKt: finiteNumber(source.wind_speed_kt, 0, 300),
      windGustKt: finiteNumber(source.wind_gust_kt, 0, 300),
      visibility: boundedText(source.visibility_statute_mi, 32),
      weather: boundedText(source.wx_string, 160),
      skyCover: boundedText(source.sky_cover, 160),
      flightCategory: normalizedCategory(source.flight_category),
      cloudBaseFt: finiteNumber(source.cloud_base_ft_agl, 0, 100000),
      ceilingFt: finiteNumber(source.ceiling_ft, 0, 100000),
      sourceUpdatedAt: sourceUpdatedAt,
      sourceLabel: provider.label,
      officialUrl: stationUrl(stationId || objectId)
    };
    return {
      type: 'Feature',
      id: properties.stationId,
      geometry: { type: 'Point', coordinates: [coordinate.lon, coordinate.lat] },
      properties: properties
    };
  }

  function stationUrl(stationId) {
    var station = boundedText(stationId, 16).toUpperCase();
    if (!/^[A-Z0-9_-]{1,16}$/.test(station)) return provider.attribution.url;
    return 'https://aviationweather.gov/metar/data?ids=' + encodeURIComponent(station) +
      '&format=raw&hours=0&taf=off&layout=off&date=0';
  }

  function transferLimitExceeded(payload) {
    return Boolean(payload && (payload.exceededTransferLimit ||
      payload.properties && payload.properties.exceededTransferLimit));
  }

  function observationKey(feature) {
    var properties = feature.properties || {};
    return properties.stationId || String(feature.id || JSON.stringify(feature.geometry.coordinates));
  }

  function preferLatest(left, right) {
    var leftTime = Number(left.properties.observationTime || 0);
    var rightTime = Number(right.properties.observationTime || 0);
    if (rightTime !== leftTime) return rightTime > leftTime ? right : left;
    return String(right.id).localeCompare(String(left.id)) < 0 ? right : left;
  }

  function normalizeCollection(payload) {
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features) ||
        payload.features.length > MAX_FEATURES) {
      throw new TypeError('Invalid NOAA AWC METAR GeoJSON');
    }
    var byStation = Object.create(null);
    payload.features.forEach(function (feature) {
      var normalized = normalizeFeature(feature);
      if (!normalized) return;
      var key = observationKey(normalized);
      byStation[key] = byStation[key] ? preferLatest(byStation[key], normalized) : normalized;
    });
    var features = Object.keys(byStation).map(function (key) { return byStation[key]; });
    features.sort(function (left, right) {
      return String(left.properties.stationId).localeCompare(String(right.properties.stationId));
    });
    return {
      collection: { type: 'FeatureCollection', features: features },
      latestAt: latestTimestamp(features),
      count: features.length,
      truncated: transferLimitExceeded(payload)
    };
  }

  function mergeCollections(results) {
    var byStation = Object.create(null);
    var truncated = false;
    (Array.isArray(results) ? results : []).forEach(function (result) {
      if (!result || !result.collection || !Array.isArray(result.collection.features)) return;
      truncated = truncated || Boolean(result.truncated);
      result.collection.features.forEach(function (feature) {
        var key = observationKey(feature);
        byStation[key] = byStation[key] ? preferLatest(byStation[key], feature) : feature;
      });
    });
    var features = Object.keys(byStation).map(function (key) { return byStation[key]; });
    features.sort(function (left, right) {
      var leftTime = Number(left.properties.observationTime || 0);
      var rightTime = Number(right.properties.observationTime || 0);
      return rightTime - leftTime || String(left.properties.stationId).localeCompare(String(right.properties.stationId));
    });
    if (features.length > MAX_FEATURES) {
      features = features.slice(0, MAX_FEATURES);
      truncated = true;
    }
    features.sort(function (left, right) {
      return String(left.properties.stationId).localeCompare(String(right.properties.stationId));
    });
    return {
      collection: { type: 'FeatureCollection', features: features },
      latestAt: latestTimestamp(features),
      count: features.length,
      truncated: truncated
    };
  }

  function latestTimestamp(features) {
    var latest = null;
    (features || []).forEach(function (feature) {
      var value = Number(feature.properties && feature.properties.observationTime);
      if (Number.isFinite(value) && (latest == null || value > latest)) latest = value;
    });
    return latest;
  }

  function freshness(updatedAt, staleMs, now) {
    if (updatedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(updatedAt);
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(timestamp) || !Number.isFinite(current)) return { state: 'unknown', ageMs: null };
    var ageMs = Math.max(0, current - timestamp);
    return { state: ageMs > Number(staleMs || provider.staleMs) ? 'stale' : 'fresh', ageMs: ageMs };
  }

  function markerClass(category) {
    var normalized = normalizedCategory(category).toLowerCase();
    return 'metar-station-marker metar-' + normalized;
  }

  return Object.freeze({
    ROOT: ROOT,
    LAYER_URL: LAYER_URL,
    OUT_FIELDS: OUT_FIELDS,
    PAGE_SIZE: PAGE_SIZE,
    MAX_FEATURES: MAX_FEATURES,
    MIN_ZOOM: MIN_ZOOM,
    FLIGHT_CATEGORIES: Object.freeze(FLIGHT_CATEGORIES.slice()),
    provider: provider,
    buildQueries: buildQueries,
    queryUrl: queryUrl,
    normalizeBounds: normalizeBounds,
    normalizeCollection: normalizeCollection,
    mergeCollections: mergeCollections,
    freshness: freshness,
    markerClass: markerClass
  });
});
