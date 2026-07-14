/* Official SPC/NWS severe & tornado WATCH polygon contract — keyless NOAA ArcGIS.
 * These are watch AREAS (a region under threat), distinct from the CAP warnings
 * already shown from api.weather.gov. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSevereWatches = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var LAYER = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1';
  var FIELDS = 'objectid,prod_type,phenom,sig,event,url,expiration,onset,ends,issuance,wfo';
  var WATCH_TYPES = ['Tornado Watch', 'Severe Thunderstorm Watch'];
  var PAGE_SIZE = 500;
  var MAX_PAGES = 4;

  function queryUrl(offset) {
    var params = new URLSearchParams({
      where: "prod_type IN ('Tornado Watch','Severe Thunderstorm Watch')",
      outFields: FIELDS, returnGeometry: 'true', outSR: '4326', f: 'geojson',
      orderByFields: 'objectid ASC', resultOffset: String(Number(offset || 0)), resultRecordCount: String(PAGE_SIZE)
    });
    return LAYER + '/query?' + params.toString();
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

  function kind(prodType) {
    var text = String(prodType || '').trim().toLowerCase();
    if (text === 'tornado watch') return 'tornado';
    if (text === 'severe thunderstorm watch') return 'severe';
    return null;
  }

  function isHttpsUrl(value) {
    try { return new URL(String(value)).protocol === 'https:'; } catch (e) { return false; }
  }

  function normalizeCollection(value, now) {
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) ||
        value.features.length > PAGE_SIZE * MAX_PAGES) {
      throw new TypeError('Invalid severe watch GeoJSON');
    }
    var current = Number(now == null ? Date.now() : now);
    var features = [];
    value.features.forEach(function (feature) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry ||
          ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) === -1 ||
          !coordinateValid(feature.geometry.coordinates, 0) ||
          !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
        throw new TypeError('Invalid severe watch feature');
      }
      var watchKind = kind(feature.properties.prod_type);
      if (!watchKind) return;
      var expiresAt = parseUtc(feature.properties.expiration) || parseUtc(feature.properties.ends);
      // Drop already-expired watches rather than imply an active threat.
      if (expiresAt && Date.parse(expiresAt) < current) return;
      var properties = Object.assign({}, feature.properties);
      properties.watchKind = watchKind;
      properties.issuedAt = parseUtc(properties.issuance) || parseUtc(properties.onset);
      properties.expiresAt = expiresAt;
      properties.officialUrl = isHttpsUrl(properties.url) ? String(properties.url) : null;
      features.push({ type: 'Feature', geometry: feature.geometry, properties: properties });
    });
    // Tornado watches render above severe-thunderstorm watches.
    features.sort(function (a, b) {
      var order = { severe: 0, tornado: 1 };
      return order[a.properties.watchKind] - order[b.properties.watchKind];
    });
    return { type: 'FeatureCollection', features: features };
  }

  function transferLimitExceeded(payload) {
    return Boolean(payload && (payload.exceededTransferLimit ||
      payload.properties && payload.properties.exceededTransferLimit));
  }

  async function fetchAllPages(fetcher, signal, now) {
    var features = [];
    var seen = Object.create(null);
    var offset = 0;
    for (var page = 0; page < MAX_PAGES; page++) {
      var response = await fetcher(queryUrl(offset), { cache: 'no-store', signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var payload = await response.json();
      var normalized = normalizeCollection(payload, now);
      var added = 0;
      normalized.features.forEach(function (feature) {
        var id = String(feature.properties.objectid == null
          ? feature.properties.watchKind + ':' + JSON.stringify(feature.geometry.coordinates).length
          : feature.properties.objectid);
        if (seen[id]) return;
        seen[id] = true;
        features.push(feature);
        added += 1;
      });
      if (!transferLimitExceeded(payload)) {
        features.sort(function (a, b) {
          var order = { severe: 0, tornado: 1 };
          return order[a.properties.watchKind] - order[b.properties.watchKind];
        });
        return { type: 'FeatureCollection', features: features };
      }
      if (added === 0) throw new Error('Severe watch pagination made no progress');
      offset += payload.features.length;
    }
    throw new Error('Severe watch pagination exceeded cap');
  }

  // Tornado watches red, severe-thunderstorm watches amber; hollow so radar and
  // warnings below remain readable.
  function style(watchKind) {
    if (watchKind === 'tornado') return { color: '#d6006e', weight: 2, dashArray: '6 4', fillColor: '#d6006e', fillOpacity: 0.06 };
    if (watchKind === 'severe') return { color: '#e69500', weight: 2, dashArray: '6 4', fillColor: '#e69500', fillOpacity: 0.06 };
    throw new TypeError('Severe watch style is invalid');
  }

  function freshness(fetchedAt, staleMs, now) {
    if (fetchedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(fetchedAt);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var age = Math.max(0, Number(now == null ? Date.now() : now) - timestamp);
    return { state: age > Number(staleMs || 10 * 60 * 1000) ? 'stale' : 'fresh', ageMs: age };
  }

  return Object.freeze({
    LAYER: LAYER, WATCH_TYPES: Object.freeze(WATCH_TYPES.slice()),
    provider: Object.freeze({
      id: 'watches', defaultVisible: false, refreshMs: 2 * 60 * 1000, staleMs: 10 * 60 * 1000,
      attribution: Object.freeze({ text: 'NOAA/NWS SPC', url: 'https://www.spc.noaa.gov/products/watch/' })
    }),
    queryUrl: queryUrl, normalizeCollection: normalizeCollection, fetchAllPages: fetchAllPages,
    transferLimitExceeded: transferLimitExceeded, style: style, kind: kind, freshness: freshness
  });
});
