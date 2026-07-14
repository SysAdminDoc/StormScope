/* Official SPC convective (categorical) outlook contract — keyless NOAA ArcGIS. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeConvectiveOutlooks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer';
  // Categorical outlook layer IDs by day (verified against the SPC service).
  var DAY_LAYERS = { 1: 1, 2: 9, 3: 17 };
  var FIELDS = 'objectid,dn,label,label2,valid,expire,issue,idp_source,idp_filedate';
  var PAGE_SIZE = 500;
  var MAX_PAGES = 4;
  // SPC categorical risk ranking, weakest → strongest.
  var CATEGORIES = ['tstm', 'mrgl', 'slgt', 'enh', 'mdt', 'high'];
  // SPC "dn" severity codes → category.
  var DN_TO_CATEGORY = { 2: 'tstm', 3: 'mrgl', 4: 'slgt', 5: 'enh', 6: 'mdt', 8: 'high' };
  var LABEL_TO_CATEGORY = {
    tstm: 'tstm', mrgl: 'mrgl', slgt: 'slgt', enh: 'enh', mdt: 'mdt', high: 'high',
    marginal: 'mrgl', slight: 'slgt', enhanced: 'enh', moderate: 'mdt'
  };

  function queryUrl(day, offset) {
    var layer = DAY_LAYERS[Number(day)];
    if (layer == null) throw new TypeError('SPC outlook day is invalid');
    var params = new URLSearchParams({
      where: '1=1', outFields: FIELDS, returnGeometry: 'true', outSR: '4326', f: 'geojson',
      orderByFields: 'objectid ASC', resultOffset: String(Number(offset || 0)), resultRecordCount: String(PAGE_SIZE)
    });
    return ROOT + '/' + layer + '/query?' + params.toString();
  }

  function metadataUrl(day) {
    var layer = DAY_LAYERS[Number(day)];
    if (layer == null) throw new TypeError('SPC outlook day is invalid');
    return ROOT + '/' + layer + '?f=json';
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
    var label = String(properties.label || properties.label2 || '').trim().toLowerCase();
    if (LABEL_TO_CATEGORY[label]) return LABEL_TO_CATEGORY[label];
    var dn = Number(properties.dn);
    if (DN_TO_CATEGORY[dn]) return DN_TO_CATEGORY[dn];
    return null;
  }

  function normalizeCollection(value, day) {
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) ||
        value.features.length > PAGE_SIZE * MAX_PAGES) {
      throw new TypeError('Invalid SPC outlook GeoJSON');
    }
    var features = [];
    value.features.forEach(function (feature) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry ||
          ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) === -1 ||
          !coordinateValid(feature.geometry.coordinates, 0) ||
          !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
        throw new TypeError('Invalid SPC outlook feature');
      }
      var normalizedCategory = category(feature.properties);
      if (!normalizedCategory) return; // skip unknown/administrative rows rather than fail closed on the whole set
      var properties = Object.assign({}, feature.properties);
      properties.outlookDay = Number(day);
      properties.outlookCategory = normalizedCategory;
      properties.issuedAt = parseUtc(properties.issue) || parseUtc(properties.idp_filedate);
      properties.startsAt = parseUtc(properties.valid);
      properties.endsAt = parseUtc(properties.expire);
      properties.sourceLabel = String(properties.idp_source || 'NOAA/NWS Storm Prediction Center');
      features.push({ type: 'Feature', geometry: feature.geometry, properties: properties });
    });
    features.sort(function (a, b) {
      return CATEGORIES.indexOf(a.properties.outlookCategory) - CATEGORIES.indexOf(b.properties.outlookCategory);
    });
    return { type: 'FeatureCollection', features: features };
  }

  function transferLimitExceeded(payload) {
    return Boolean(payload && (payload.exceededTransferLimit ||
      payload.properties && payload.properties.exceededTransferLimit));
  }

  async function fetchAllPages(fetcher, day, signal) {
    var features = [];
    var seen = Object.create(null);
    var offset = 0;
    for (var page = 0; page < MAX_PAGES; page++) {
      var response = await fetcher(queryUrl(day, offset), { cache: 'no-store', signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var payload = await response.json();
      var normalized = normalizeCollection(payload, day);
      var added = 0;
      normalized.features.forEach(function (feature) {
        var id = String(feature.properties.objectid == null
          ? feature.properties.outlookCategory + ':' + JSON.stringify(feature.geometry.coordinates).length
          : feature.properties.objectid);
        if (seen[id]) return;
        seen[id] = true;
        features.push(feature);
        added += 1;
      });
      if (!transferLimitExceeded(payload)) {
        return normalizeCollection({ type: 'FeatureCollection', features: features }, day);
      }
      if (added === 0) throw new Error('SPC outlook pagination made no progress');
      offset += payload.features.length;
    }
    throw new Error('SPC outlook pagination exceeded cap');
  }

  function parseMetadata(payload) {
    var timestamp = Number(payload && payload.editingInfo &&
      (payload.editingInfo.dataLastEditDate || payload.editingInfo.lastEditDate));
    return { updatedAt: Number.isFinite(timestamp) ? timestamp : null };
  }

  // Official SPC categorical colors.
  function style(name) {
    var styles = {
      tstm: { color: '#55a555', fillColor: '#c1e9c1' },
      mrgl: { color: '#3c7a3c', fillColor: '#7fc57f' },
      slgt: { color: '#c9a400', fillColor: '#f6f67f' },
      enh: { color: '#c07a00', fillColor: '#e8c26e' },
      mdt: { color: '#a30000', fillColor: '#e6706e' },
      high: { color: '#a300a3', fillColor: '#ff73ff' }
    };
    var output = Object.assign({}, styles[name]);
    if (!output.color) throw new TypeError('SPC outlook style is invalid');
    output.weight = 2;
    output.fillOpacity = 0.2;
    return output;
  }

  function freshness(updatedAt, staleMs, now) {
    if (updatedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(updatedAt);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var age = Math.max(0, Number(now == null ? Date.now() : now) - timestamp);
    return { state: age > Number(staleMs || 8 * 60 * 60 * 1000) ? 'stale' : 'fresh', ageMs: age };
  }

  return Object.freeze({
    ROOT: ROOT, DAY_LAYERS: DAY_LAYERS, CATEGORIES: Object.freeze(CATEGORIES.slice()),
    provider: Object.freeze({
      id: 'convective', defaultVisible: false, refreshMs: 10 * 60 * 1000, staleMs: 8 * 60 * 60 * 1000,
      attribution: Object.freeze({ text: 'NOAA/NWS SPC', url: 'https://www.spc.noaa.gov/products/outlook/' })
    }),
    queryUrl: queryUrl, metadataUrl: metadataUrl, normalizeCollection: normalizeCollection,
    fetchAllPages: fetchAllPages, transferLimitExceeded: transferLimitExceeded,
    parseMetadata: parseMetadata, style: style, freshness: freshness, category: category
  });
});
