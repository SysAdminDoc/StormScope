/* Official WPC Winter Storm Severity Index polygon contract. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeWinterOutlooks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer';
  var LAYER_ID = 4;
  var OFFICIAL_URL = 'https://www.wpc.ncep.noaa.gov/wwd/wssi/wssi.php';
  var FIELDS = 'objectid,product,valid_time,component,impact,issue_time,start_time,end_time,idp_source,idp_filedate,idp_ingestdate';
  var PAGE_SIZE = 500;
  var MAX_PAGES = 5;
  var MAX_FEATURES = PAGE_SIZE * MAX_PAGES;
  var CATEGORY_ORDER = ['winter', 'minor', 'moderate', 'major', 'extreme'];

  function queryUrl(offset) {
    var params = new URLSearchParams({
      where: '1=1', outFields: FIELDS, returnGeometry: 'true', outSR: '4326', f: 'geojson',
      orderByFields: 'objectid ASC', resultOffset: String(Number(offset || 0)), resultRecordCount: String(PAGE_SIZE)
    });
    return ROOT + '/' + LAYER_ID + '/query?' + params.toString();
  }

  function coordinateValid(value, depth) {
    if (!Array.isArray(value) || !value.length || depth > 4) return false;
    if (typeof value[0] === 'number') return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
      value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
    return value.every(function (child) { return coordinateValid(child, depth + 1); });
  }

  function parseUtc(value) {
    if (value == null || value === '') return null;
    var numeric = Number(value);
    var source = Number.isFinite(numeric) ? numeric : String(value).trim().replace(' ', 'T');
    if (typeof source === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(source)) source += 'Z';
    var date = new Date(source);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function category(properties) {
    var value = String(properties && (properties.impact || properties.Impact) || '').trim().toUpperCase();
    var categories = {
      'WINTER WEATHER AREA': 'winter', MINOR: 'minor', MODERATE: 'moderate', MAJOR: 'major', EXTREME: 'extreme'
    };
    return categories[value] || null;
  }

  function objectId(properties, index) {
    var value = properties && (properties.objectid != null ? properties.objectid : properties.OBJECTID);
    return value == null ? 'feature-' + index : String(value);
  }

  function normalizeCollection(value) {
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > MAX_FEATURES) {
      throw new TypeError('Invalid WSSI GeoJSON');
    }
    var features = value.features.map(function (feature, index) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry ||
          ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) === -1 ||
          !coordinateValid(feature.geometry.coordinates, 0) || !feature.properties ||
          typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
        throw new TypeError('Invalid WSSI feature');
      }
      var properties = Object.assign({}, feature.properties);
      var normalizedCategory = category(properties);
      if (!normalizedCategory) throw new TypeError('Unsupported WSSI impact');
      Object.assign(properties, {
        wssiCategory: normalizedCategory,
        wssiPeriod: 'days-1-3',
        issuedAt: parseUtc(properties.issue_time) || parseUtc(properties.idp_filedate) || parseUtc(properties.idp_ingestdate),
        startsAt: parseUtc(properties.start_time) || parseUtc(properties.valid_time),
        endsAt: parseUtc(properties.end_time),
        sourceLabel: String(properties.idp_source || 'NOAA/NWS/WPC WSSI')
      });
      return { type: 'Feature', geometry: feature.geometry, properties: properties, _wssiObjectId: objectId(properties, index) };
    });
    features.sort(function (a, b) {
      return CATEGORY_ORDER.indexOf(a.properties.wssiCategory) - CATEGORY_ORDER.indexOf(b.properties.wssiCategory);
    });
    features.forEach(function (feature) { delete feature._wssiObjectId; });
    return { type: 'FeatureCollection', features: features };
  }

  function featureId(feature, index) {
    return objectId(feature && feature.properties, index);
  }

  async function fetchAllPages(fetcher, signal) {
    var features = [];
    var offset = 0;
    for (var page = 0; page < MAX_PAGES; page++) {
      var response = await fetcher(queryUrl(offset), { cache: 'no-store', signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var value = await response.json();
      var normalized = normalizeCollection(value);
      if (normalized.features.length && normalized.features.every(function (feature, index) {
        return features.some(function (existing, existingIndex) {
          return featureId(existing, existingIndex) === featureId(feature, index);
        });
      })) throw new Error('WSSI pagination made no progress');
      normalized.features.forEach(function (feature, index) {
        var id = featureId(feature, index);
        if (!features.some(function (existing, existingIndex) { return featureId(existing, existingIndex) === id; })) {
          features.push(feature);
        }
      });
      var exceeded = Boolean(value.exceededTransferLimit || value.properties && value.properties.exceededTransferLimit);
      if (!exceeded) return { type: 'FeatureCollection', features: features };
      if (!normalized.features.length) throw new Error('WSSI pagination made no progress');
      offset += normalized.features.length;
    }
    throw new Error('WSSI pagination exceeded cap');
  }

  function style(name) {
    var styles = {
      winter: { color: '#6e6e6e', fillColor: '#d2dfe7' },
      minor: { color: '#6e6e6e', fillColor: '#faf5a3' },
      moderate: { color: '#6e6e6e', fillColor: '#f7962f' },
      major: { color: '#6e6e6e', fillColor: '#e61f26' },
      extreme: { color: '#6e6e6e', fillColor: '#7853a1' }
    };
    var output = Object.assign({}, styles[name]);
    if (!output.color) throw new TypeError('WSSI style is invalid');
    output.weight = 1;
    output.fillOpacity = 0.35;
    return output;
  }

  return Object.freeze({
    ROOT: ROOT, LAYER_ID: LAYER_ID, OFFICIAL_URL: OFFICIAL_URL, FIELDS: FIELDS,
    PAGE_SIZE: PAGE_SIZE, MAX_PAGES: MAX_PAGES, MAX_FEATURES: MAX_FEATURES,
    queryUrl: queryUrl, normalizeCollection: normalizeCollection, fetchAllPages: fetchAllPages,
    style: style, parseUtc: parseUtc, category: category
  });
});
