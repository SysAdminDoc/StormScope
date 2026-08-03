/* Official SPC mesoscale discussions and NWS local storm reports. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSpcReports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services';
  var MESOSCALE_LAYER = ROOT + '/outlooks/spc_mesoscale_discussion/MapServer/0';
  var REPORT_ROOT = ROOT + '/obs/nws_local_storm_reports/MapServer';
  var REPORT_LAYERS = Object.freeze({ 24: 0, 48: 1, 72: 2 });
  var REPORT_WINDOWS = Object.freeze([24, 48, 72]);
  var PAGE_SIZE = 500;
  var MAX_PAGES = 4;
  var MESOSCALE_FIELDS = 'objectid,name,folderpath,popupinfo,idp_filedate,idp_ingestdate';
  var REPORT_FIELDS = 'objectid,wfo_id,wfo,lsr_validtime,descript,loc_desc,state,magnitude,units,remarks,idp_source,idp_filedate,idp_ingestdate,valid_time';

  function boundedText(value, fallback, maximum) {
    var text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!text) return fallback || '';
    return text.slice(0, maximum || 320);
  }

  function parseUtc(value) {
    if (value == null || value === '') return null;
    var number = Number(value);
    var source = Number.isFinite(number) ? number : String(value).trim().replace(' ', 'T');
    if (typeof source === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(source)) source += 'Z';
    var date = new Date(source);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function coordinateValid(value, depth, point) {
    if (!Array.isArray(value) || !value.length || depth > 4) return false;
    if (typeof value[0] === 'number') {
      return point
        ? value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
            value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90
        : value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
            value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
    }
    return value.every(function (child) { return coordinateValid(child, depth + 1, point); });
  }

  function normalizeBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    var west = Number(bounds.west);
    var south = Number(bounds.south);
    var east = Number(bounds.east);
    var north = Number(bounds.north);
    if (![west, south, east, north].every(Number.isFinite) || south < -90 || north > 90 || south > north ||
        west < -180 || west > 180 || east < -180 || east > 180) return null;
    return { west: west, south: south, east: east, north: north };
  }

  function boundsParts(bounds) {
    var normalized = normalizeBounds(bounds);
    if (!normalized) return [null];
    if (normalized.west <= normalized.east) return [normalized];
    return [
      { west: normalized.west, south: normalized.south, east: 180, north: normalized.north },
      { west: -180, south: normalized.south, east: normalized.east, north: normalized.north }
    ];
  }

  function queryUrl(kind, reportWindow, offset, bounds) {
    var layer;
    var fields;
    if (kind === 'mesoscale') {
      layer = MESOSCALE_LAYER;
      fields = MESOSCALE_FIELDS;
    } else if (kind === 'reports') {
      var key = Number(reportWindow);
      if (REPORT_LAYERS[key] == null) throw new TypeError('local storm report window is invalid');
      layer = REPORT_ROOT + '/' + REPORT_LAYERS[key];
      fields = REPORT_FIELDS;
    } else {
      throw new TypeError('SPC report kind is invalid');
    }
    var params = new URLSearchParams({
      where: '1=1', outFields: fields, returnGeometry: 'true', outSR: '4326', f: 'geojson',
      orderByFields: 'objectid ASC', resultOffset: String(Number(offset || 0)),
      resultRecordCount: String(PAGE_SIZE)
    });
    var normalizedBounds = normalizeBounds(bounds);
    if (normalizedBounds) {
      params.set('geometry', [normalizedBounds.west, normalizedBounds.south,
        normalizedBounds.east, normalizedBounds.north].join(','));
      params.set('geometryType', 'esriGeometryEnvelope');
      params.set('inSR', '4326');
      params.set('spatialRel', 'esriSpatialRelIntersects');
    }
    return layer + '/query?' + params.toString();
  }

  function isHttpsUrl(value) {
    try { return new URL(String(value)).protocol === 'https:'; } catch (error) { return false; }
  }

  function mesoscaleUrl(properties) {
    var popup = boundedText(properties.popupinfo, '', 2048);
    var match = popup.match(/https:\/\/(?:www\.)?spc\.noaa\.gov\/products\/md\/[^\s"'<>]+/i);
    if (match && isHttpsUrl(match[0])) return match[0].replace(/[),.;]+$/, '');
    var name = boundedText(properties.name, '', 80);
    var number = name.match(/\d{3,5}/);
    return number ? 'https://www.spc.noaa.gov/products/md/md' + number[0] + '.html'
      : 'https://www.spc.noaa.gov/products/md/';
  }

  function officeUrl(value) {
    var office = boundedText(value, '', 12).toLowerCase();
    return /^[a-z0-9-]{3,8}$/.test(office) ? 'https://www.weather.gov/' + office : 'https://www.weather.gov/';
  }

  function normalizeMesoscale(value) {
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) ||
        value.features.length > PAGE_SIZE * MAX_PAGES) throw new TypeError('Invalid SPC mesoscale GeoJSON');
    var features = value.features.map(function (feature) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry ||
          ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) === -1 ||
          !coordinateValid(feature.geometry.coordinates, 0, false) ||
          !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
        throw new TypeError('Invalid SPC mesoscale feature');
      }
      var source = feature.properties;
      var properties = Object.assign({}, source);
      properties.discussionNumber = boundedText(source.name, 'Mesoscale Discussion', 80);
      properties.discussionInfo = boundedText(source.folderpath, '', 320);
      properties.issuedAt = parseUtc(source.idp_filedate) || parseUtc(source.idp_ingestdate);
      properties.officialUrl = mesoscaleUrl(source);
      properties.sourceLabel = 'NOAA/NWS Storm Prediction Center';
      return { type: 'Feature', geometry: feature.geometry, properties: properties };
    });
    return { type: 'FeatureCollection', features: features };
  }

  function normalizeReports(value, reportWindow) {
    var windowHours = Number(reportWindow);
    if (REPORT_LAYERS[windowHours] == null) throw new TypeError('local storm report window is invalid');
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) ||
        value.features.length > PAGE_SIZE * MAX_PAGES) throw new TypeError('Invalid NWS local storm reports GeoJSON');
    var features = value.features.map(function (feature) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry || feature.geometry.type !== 'Point' ||
          !coordinateValid(feature.geometry.coordinates, 0, true) ||
          !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
        throw new TypeError('Invalid NWS local storm report feature');
      }
      var source = feature.properties;
      var properties = Object.assign({}, source);
      properties.reportType = boundedText(source.descript, 'Local Storm Report', 80);
      properties.location = boundedText(source.loc_desc, '', 120);
      properties.state = boundedText(source.state, '', 12);
      properties.magnitude = boundedText(source.magnitude, '', 32);
      properties.units = boundedText(source.units, '', 24);
      properties.remarks = boundedText(source.remarks, '', 320);
      properties.reportedAt = parseUtc(source.lsr_validtime) || parseUtc(source.valid_time);
      properties.reportWindowHours = windowHours;
      properties.officialUrl = officeUrl(source.wfo_id);
      properties.sourceLabel = boundedText(source.wfo, source.wfo_id || 'NOAA/NWS', 80);
      return { type: 'Feature', geometry: feature.geometry, properties: properties };
    });
    return { type: 'FeatureCollection', features: features };
  }

  function transferLimitExceeded(payload) {
    return Boolean(payload && (payload.exceededTransferLimit ||
      payload.properties && payload.properties.exceededTransferLimit));
  }

  function featureKey(kind, feature) {
    var properties = feature.properties || {};
    if (properties.objectid != null) return kind + ':' + String(properties.objectid);
    return kind + ':' + JSON.stringify(feature.geometry && feature.geometry.coordinates);
  }

  function latestTimestamp(collection, kind) {
    var latest = null;
    collection.features.forEach(function (feature) {
      var value = kind === 'mesoscale' ? feature.properties.issuedAt : feature.properties.reportedAt;
      var timestamp = value ? Date.parse(value) : NaN;
      if (Number.isFinite(timestamp) && (latest == null || timestamp > latest)) latest = timestamp;
    });
    return latest;
  }

  async function fetchAllPages(fetcher, kind, reportWindow, bounds, signal) {
    var parts = boundsParts(bounds);
    var features = [];
    var seen = Object.create(null);
    for (var partIndex = 0; partIndex < parts.length; partIndex += 1) {
      var offset = 0;
      for (var page = 0; page < MAX_PAGES; page += 1) {
        var response = await fetcher(queryUrl(kind, reportWindow, offset, parts[partIndex]), {
          cache: 'no-store', signal: signal
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var payload = await response.json();
        var normalized = kind === 'mesoscale'
          ? normalizeMesoscale(payload)
          : normalizeReports(payload, reportWindow);
        var added = 0;
        normalized.features.forEach(function (feature) {
          var key = featureKey(kind, feature);
          if (seen[key]) return;
          seen[key] = true;
          features.push(feature);
          added += 1;
        });
        if (!transferLimitExceeded(payload)) break;
        if (added === 0 || !payload.features.length) throw new Error('SPC report pagination made no progress');
        offset += payload.features.length;
        if (page === MAX_PAGES - 1) throw new Error('SPC report pagination exceeded cap');
      }
    }
    var collection = { type: 'FeatureCollection', features: features };
    return {
      collection: kind === 'mesoscale' ? normalizeMesoscale(collection) : normalizeReports(collection, reportWindow),
      latestAt: latestTimestamp(collection, kind)
    };
  }

  function freshness(updatedAt, staleMs, now) {
    if (updatedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(updatedAt);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var age = Math.max(0, Number(now == null ? Date.now() : now) - timestamp);
    return { state: age > Number(staleMs || 10 * 60 * 1000) ? 'stale' : 'fresh', ageMs: age };
  }

  function mesoscaleStyle() {
    return { color: '#a000c8', fillColor: '#e879f9', weight: 2, fillOpacity: 0.16 };
  }

  function reportStyle(reportType) {
    var text = String(reportType || '').toLowerCase();
    if (text.indexOf('tornado') !== -1 || text.indexOf('funnel') !== -1) {
      return { className: 'storm-report-marker storm-report-tornado' };
    }
    if (text.indexOf('hail') !== -1) return { className: 'storm-report-marker storm-report-hail' };
    if (text.indexOf('wind') !== -1 || text.indexOf('gust') !== -1) {
      return { className: 'storm-report-marker storm-report-wind' };
    }
    return { className: 'storm-report-marker storm-report-other' };
  }

  return Object.freeze({
    ROOT: ROOT,
    MESOSCALE_LAYER: MESOSCALE_LAYER,
    REPORT_ROOT: REPORT_ROOT,
    REPORT_LAYERS: REPORT_LAYERS,
    REPORT_WINDOWS: REPORT_WINDOWS,
    PAGE_SIZE: PAGE_SIZE,
    queryUrl: queryUrl,
    normalizeMesoscale: normalizeMesoscale,
    normalizeReports: normalizeReports,
    fetchAllPages: fetchAllPages,
    transferLimitExceeded: transferLimitExceeded,
    latestTimestamp: latestTimestamp,
    freshness: freshness,
    mesoscaleStyle: mesoscaleStyle,
    reportStyle: reportStyle,
    providers: Object.freeze({
      mesoscale: Object.freeze({
        id: 'mesoscale', defaultVisible: false, refreshMs: 10 * 60 * 1000, staleMs: 20 * 60 * 1000,
        attribution: Object.freeze({ text: 'NOAA/NWS SPC', url: 'https://www.spc.noaa.gov/products/md/' })
      }),
      reports: Object.freeze({
        id: 'reports', defaultVisible: false, refreshMs: 10 * 60 * 1000, staleMs: 45 * 60 * 1000,
        attribution: Object.freeze({ text: 'NOAA/NWS Local Storm Reports', url: 'https://www.weather.gov/gis/' })
      })
    })
  });
});
