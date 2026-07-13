/* Official WPC flood outlook and threshold-authoritative gauge contracts. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeFloodOutlooks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ERO_ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer';
  var FLOOD_ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/sig_riv_fld_outlk/MapServer/0';
  var USGS_ROOT = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items';
  var NWPS_ROOT = 'https://api.water.noaa.gov/nwps/v1/gauges';
  var OUTLOOK_FIELDS = 'objectid,product,valid_time,outlook,issue_time,start_time,end_time,idp_source,idp_filedate,idp_ingestdate,dn,snippet';
  var FLOOD_FIELDS = 'objectid,id,product,valid_time,outlook,issue_time,start_time,end_time,idp_source,idp_filedate,idp_ingestdate';
  var PAGE_SIZE = 500;
  var MAX_PAGES = 5;
  var MAX_GAUGES = 25;

  function queryUrl(kind, day, offset) {
    var root;
    var fields;
    if (kind === 'ero') {
      var number = Number(day);
      if (!Number.isInteger(number) || number < 1 || number > 3) throw new TypeError('ERO day is invalid');
      root = ERO_ROOT + '/' + (number - 1);
      fields = OUTLOOK_FIELDS;
    } else if (kind === 'flood') {
      root = FLOOD_ROOT;
      fields = FLOOD_FIELDS;
    } else throw new TypeError('Outlook kind is invalid');
    var params = new URLSearchParams({
      where: '1=1', outFields: fields, returnGeometry: 'true', outSR: '4326', f: 'geojson',
      orderByFields: 'objectid ASC', resultOffset: String(Number(offset || 0)), resultRecordCount: String(PAGE_SIZE)
    });
    return root + '/query?' + params.toString();
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

  function category(kind, properties) {
    var text = String(properties.outlook || '').toLowerCase();
    if (kind === 'ero') {
      var byDn = { 1: 'marginal', 2: 'slight', 3: 'moderate', 4: 'high' };
      return byDn[Number(properties.dn)] || ['marginal', 'slight', 'moderate', 'high'].find(function (name) { return text.indexOf(name) !== -1; }) || null;
    }
    return ['possible', 'likely', 'occurring'].find(function (name) { return text.indexOf(name) !== -1; }) || null;
  }

  function normalizeCollection(value, kind, day) {
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > PAGE_SIZE * MAX_PAGES) {
      throw new TypeError('Invalid outlook GeoJSON');
    }
    var features = value.features.map(function (feature) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry ||
          ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) === -1 || !coordinateValid(feature.geometry.coordinates, 0) ||
          !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
        throw new TypeError('Invalid outlook feature');
      }
      var properties = Object.assign({}, feature.properties);
      var normalizedCategory = category(kind, properties);
      if (!normalizedCategory) throw new TypeError('Unsupported outlook category');
      Object.assign(properties, {
        outlookKind: kind, outlookDay: kind === 'ero' ? Number(day) : null, outlookCategory: normalizedCategory,
        issuedAt: parseUtc(properties.issue_time) || parseUtc(properties.idp_filedate),
        startsAt: parseUtc(properties.start_time), endsAt: parseUtc(properties.end_time),
        sourceLabel: String(properties.idp_source || (kind === 'ero' ? 'NOAA WPC ERO' : 'NOAA Significant River Flood Outlook'))
      });
      return { type: 'Feature', geometry: feature.geometry, properties: properties };
    });
    features.sort(function (a, b) {
      var order = kind === 'ero' ? ['marginal', 'slight', 'moderate', 'high'] : ['possible', 'likely', 'occurring'];
      return order.indexOf(a.properties.outlookCategory) - order.indexOf(b.properties.outlookCategory);
    });
    return { type: 'FeatureCollection', features: features };
  }

  async function fetchAllPages(fetcher, kind, day, signal) {
    var features = [];
    var offset = 0;
    for (var page = 0; page < MAX_PAGES; page++) {
      var response = await fetcher(queryUrl(kind, day, offset), { cache: 'no-store', signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var value = await response.json();
      var normalized = normalizeCollection(value, kind, day);
      if (normalized.features.length && normalized.features.every(function (feature) {
        return features.some(function (existing) { return existing.properties.objectid === feature.properties.objectid; });
      })) throw new Error('Outlook pagination made no progress');
      normalized.features.forEach(function (feature) {
        if (!features.some(function (existing) { return existing.properties.objectid === feature.properties.objectid; })) features.push(feature);
      });
      var exceeded = Boolean(value.exceededTransferLimit || value.properties && value.properties.exceededTransferLimit);
      if (!exceeded) return { type: 'FeatureCollection', features: features };
      if (!normalized.features.length) throw new Error('Outlook pagination made no progress');
      offset += normalized.features.length;
    }
    throw new Error('Outlook pagination exceeded cap');
  }

  function style(kind, name) {
    var styles = {
      marginal: { color: '#00734c', fillColor: '#38a800', dashArray: '2 4' },
      slight: { color: '#e69800', fillColor: '#fffe00', dashArray: '7 4' },
      moderate: { color: '#8a0000', fillColor: '#f50000', dashArray: null },
      high: { color: '#ff00ff', fillColor: '#ff69c5', dashArray: '10 3 2 3' },
      possible: { color: '#111111', fillColor: '#ffff00', dashArray: '2 4' },
      likely: { color: '#111111', fillColor: '#ff6300', dashArray: '7 4' },
      occurring: { color: '#111111', fillColor: '#ff0000', dashArray: null }
    };
    var output = Object.assign({}, styles[name]);
    if (!output.color) throw new TypeError('Outlook style is invalid');
    output.weight = kind === 'ero' ? 2 : 1;
    output.fillOpacity = kind === 'ero' ? 0.18 : 0.22;
    return output;
  }

  function usgsUrl(bounds) {
    if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite) ||
        bounds.west >= bounds.east || bounds.south >= bounds.north || bounds.west < -180 || bounds.east > 180 ||
        bounds.south < -90 || bounds.north > 90) throw new TypeError('Gauge bounds are invalid');
    var params = new URLSearchParams({
      f: 'json', bbox: [bounds.west, bounds.south, bounds.east, bounds.north].join(','),
      parameter_code: '00065', limit: String(MAX_GAUGES)
    });
    return USGS_ROOT + '?' + params.toString();
  }

  function gaugeCandidates(value) {
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > MAX_GAUGES ||
        value.links && value.links.some(function (link) { return link.rel === 'next'; })) throw new TypeError('Gauge response is incomplete');
    return value.features.map(function (feature) {
      var properties = feature && feature.properties || {};
      var id = String(properties.monitoring_location_id || '').toUpperCase();
      var numericId = id.replace(/^USGS-/, '');
      if (!/^\d{8,15}$/.test(numericId) || !feature.geometry || feature.geometry.type !== 'Point' ||
          !coordinateValid(feature.geometry.coordinates, 0) || !Number.isFinite(Number(properties.value)) || !parseUtc(properties.time)) return null;
      return {
        id: id, numericId: numericId, geometry: feature.geometry, value: Number(properties.value),
        unit: String(properties.unit_of_measure || ''), observedAt: parseUtc(properties.time)
      };
    }).filter(Boolean);
  }

  function nwpsUrl(candidate) {
    if (!candidate || !/^\d{8,15}$/.test(String(candidate.numericId || ''))) throw new TypeError('Gauge ID is invalid');
    return NWPS_ROOT + '/' + candidate.numericId;
  }

  function normalizeGauge(candidate, detail, now) {
    if (!candidate || !detail || String(detail.usgsId || '') !== candidate.numericId || !detail.flood || !detail.status || !detail.status.observed) return null;
    var observed = detail.status.observed;
    var unit = String(observed.primaryUnit || '');
    if (!unit || unit !== candidate.unit || String(detail.flood.stageUnits || '') !== unit ||
        !Number.isFinite(Number(observed.primary)) || !parseUtc(observed.validTime) ||
        Math.max(0, Number(now || Date.now()) - Date.parse(observed.validTime)) > 6 * 60 * 60 * 1000) return null;
    var thresholds = {};
    ['action', 'minor', 'moderate', 'major'].forEach(function (name) {
      var value = Number(detail.flood.categories && detail.flood.categories[name] && detail.flood.categories[name].stage);
      if (Number.isFinite(value) && value > -900) thresholds[name] = value;
    });
    if (!Object.keys(thresholds).length) return null;
    var categoryName = ['major', 'moderate', 'minor', 'action'].find(function (name) {
      return thresholds[name] != null && Number(observed.primary) >= thresholds[name];
    }) || 'below';
    return {
      type: 'Feature', geometry: candidate.geometry, properties: {
        gaugeId: candidate.id, name: String(detail.name || candidate.id), value: Number(observed.primary), unit: unit,
        observedAt: parseUtc(observed.validTime), category: categoryName, thresholds: thresholds,
        source: 'USGS / NOAA NWPS', sourceUrl: 'https://waterdata.usgs.gov/monitoring-location/' + candidate.numericId + '/'
      }
    };
  }

  function freshness(value, now, staleMs) {
    var time = Date.parse(value || '');
    if (!Number.isFinite(time)) return { state: 'unknown', ageMs: null };
    var age = Math.max(0, Number(now || Date.now()) - time);
    return { state: age > Number(staleMs || 2 * 60 * 60 * 1000) ? 'stale' : 'fresh', ageMs: age };
  }

  return Object.freeze({
    ERO_ROOT: ERO_ROOT, FLOOD_ROOT: FLOOD_ROOT, USGS_ROOT: USGS_ROOT, NWPS_ROOT: NWPS_ROOT,
    PAGE_SIZE: PAGE_SIZE, MAX_PAGES: MAX_PAGES, MAX_GAUGES: MAX_GAUGES,
    queryUrl: queryUrl, normalizeCollection: normalizeCollection, fetchAllPages: fetchAllPages,
    style: style, parseUtc: parseUtc, usgsUrl: usgsUrl, gaugeCandidates: gaugeCandidates,
    nwpsUrl: nwpsUrl, normalizeGauge: normalizeGauge, freshness: freshness
  });
});
