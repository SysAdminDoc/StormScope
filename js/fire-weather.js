/* Official SPC fire-weather outlook contract — keyless NOAA ArcGIS. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeFireWeather = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/SPC_firewx/MapServer';
  var OFFICIAL_URL = 'https://www.spc.noaa.gov/products/fire_wx/overview.html';
  var PAGE_SIZE = 2000;
  var MAX_PAGES = 4;
  var KINDS = ['windRh', 'dryThunderstorm'];
  var DAY_LAYERS = {
    1: { windRh: 1, dryThunderstorm: 2 },
    2: { windRh: 4, dryThunderstorm: 5 },
    3: { windRh: 8, dryThunderstorm: 7 },
    4: { windRh: 11, dryThunderstorm: 10 },
    5: { windRh: 14, dryThunderstorm: 13 },
    6: { windRh: 17, dryThunderstorm: 16 },
    7: { windRh: 20, dryThunderstorm: 19 },
    8: { windRh: 23, dryThunderstorm: 22 }
  };
  var CATEGORIES = ['marginal', 'elevated', 'isolatedDry', 'scatteredDry', 'critical', 'extreme'];
  var CATEGORY_ORDER = {
    marginal: 0, elevated: 1, isolatedDry: 1, scatteredDry: 2, critical: 3, extreme: 4
  };
  var DN_TO_CATEGORY = {
    windRh: { 5: 'elevated', 8: 'critical', 10: 'extreme' },
    dryThunderstorm: { 5: 'isolatedDry', 8: 'scatteredDry' }
  };
  var FIELDS = 'objectid,dn,valid,expire,issue,label,label2,stroke,fill,idp_source,idp_filedate,idp_ingestdate';

  function validDay(day) {
    var value = Number(day);
    if (!Number.isInteger(value) || !DAY_LAYERS[value]) throw new TypeError('SPC fire-weather day is invalid');
    return value;
  }

  function validKind(kind) {
    var value = String(kind || '');
    if (KINDS.indexOf(value) === -1) throw new TypeError('SPC fire-weather kind is invalid');
    return value;
  }

  function normalizeLongitude(value) {
    var longitude = Number(value);
    while (longitude < -180) longitude += 360;
    while (longitude > 180) longitude -= 360;
    return longitude;
  }

  function envelopeSegments(bounds) {
    if (!bounds) throw new TypeError('SPC fire-weather bounds are required');
    var south = Math.max(-90, Number(bounds.south));
    var north = Math.min(90, Number(bounds.north));
    var rawWest = Number(bounds.west);
    var rawEast = Number(bounds.east);
    if (![south, north, rawWest, rawEast].every(Number.isFinite) || south >= north) {
      throw new TypeError('SPC fire-weather bounds are invalid');
    }
    if (rawEast - rawWest >= 360) return [{ west: -180, south: south, east: 180, north: north }];
    var west = normalizeLongitude(rawWest);
    var east = normalizeLongitude(rawEast);
    if (east >= west && rawWest >= -180 && rawEast <= 180) {
      return [{ west: west, south: south, east: east, north: north }];
    }
    return [
      { west: west, south: south, east: 180, north: north },
      { west: -180, south: south, east: east, north: north }
    ];
  }

  function queryUrl(day, kind, bounds, offset) {
    var normalizedDay = validDay(day);
    var normalizedKind = validKind(kind);
    var segments = envelopeSegments(bounds);
    if (segments.length !== 1) throw new TypeError('SPC fire-weather query bounds must be one envelope');
    var segment = segments[0];
    var params = new URLSearchParams({
      where: '1=1', geometry: [segment.west, segment.south, segment.east, segment.north].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: FIELDS, returnGeometry: 'true', outSR: '4326', f: 'geojson',
      orderByFields: 'objectid ASC', resultOffset: String(Number(offset || 0)),
      resultRecordCount: String(PAGE_SIZE)
    });
    return ROOT + '/' + DAY_LAYERS[normalizedDay][normalizedKind] + '/query?' + params.toString();
  }

  function buildQueries(day, bounds) {
    var normalizedDay = validDay(day);
    return envelopeSegments(bounds).reduce(function (queries, segment) {
      KINDS.forEach(function (kind) {
        queries.push({
          day: normalizedDay, kind: kind, layerId: DAY_LAYERS[normalizedDay][kind], bounds: segment,
          url: queryUrl(normalizedDay, kind, segment, 0)
        });
      });
      return queries;
    }, []);
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

  function category(properties, kind) {
    var normalizedKind = validKind(kind);
    var label = [properties && properties.label, properties && properties.label2]
      .map(function (value) { return String(value || '').trim().toLowerCase(); }).join(' ');
    if (/extreme/.test(label)) return 'extreme';
    if (/critical/.test(label)) return 'critical';
    if (/elevated/.test(label)) return 'elevated';
    if (/scattered|sctdryt/.test(label)) return 'scatteredDry';
    if (/isolated|isodryt/.test(label)) return 'isolatedDry';
    if (/marginal/.test(label)) return 'marginal';
    return DN_TO_CATEGORY[normalizedKind][Number(properties && properties.dn)] || null;
  }

  function safeColor(value) {
    var text = String(value || '').trim();
    if (/^#[0-9a-f]{3,8}$/i.test(text)) return text;
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(text)) return text;
    return null;
  }

  function normalizeCollection(value, day, kind, now) {
    var normalizedDay = validDay(day);
    var normalizedKind = validKind(kind);
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) ||
        value.features.length > PAGE_SIZE * MAX_PAGES) {
      throw new TypeError('Invalid SPC fire-weather GeoJSON');
    }
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(current)) current = Date.now();
    var features = [];
    value.features.forEach(function (feature) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry ||
          ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) === -1 ||
          !coordinateValid(feature.geometry.coordinates, 0) ||
          !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
        throw new TypeError('Invalid SPC fire-weather feature');
      }
      var normalizedCategory = category(feature.properties, normalizedKind);
      if (!normalizedCategory) return;
      var properties = Object.assign({}, feature.properties);
      var endsAt = parseUtc(properties.expire);
      if (endsAt && Date.parse(endsAt) < current) return;
      properties.outlookDay = normalizedDay;
      properties.fireWeatherKind = normalizedKind;
      properties.fireWeatherCategory = normalizedCategory;
      properties.riskLabel = String(properties.label || properties.label2 || normalizedCategory);
      properties.issuedAt = parseUtc(properties.issue) || parseUtc(properties.idp_filedate);
      properties.startsAt = parseUtc(properties.valid);
      properties.endsAt = endsAt;
      properties.sourceLabel = String(properties.idp_source || 'NOAA/NWS Storm Prediction Center');
      properties.officialUrl = OFFICIAL_URL;
      properties.strokeColor = safeColor(properties.stroke);
      properties.fillColor = safeColor(properties.fill);
      features.push({ type: 'Feature', geometry: feature.geometry, properties: properties });
    });
    features.sort(function (left, right) {
      return CATEGORY_ORDER[left.properties.fireWeatherCategory] - CATEGORY_ORDER[right.properties.fireWeatherCategory];
    });
    return { type: 'FeatureCollection', features: features };
  }

  function transferLimitExceeded(payload) {
    return Boolean(payload && (payload.exceededTransferLimit ||
      payload.properties && payload.properties.exceededTransferLimit));
  }

  function featureKey(feature, kind) {
    var properties = feature.properties || {};
    return String(kind + ':' + (properties.objectid == null
      ? JSON.stringify(feature.geometry && feature.geometry.coordinates)
      : properties.objectid));
  }

  async function fetchAllPages(fetcher, request, signal, now) {
    if (!request || !Number.isInteger(Number(request.day)) || !request.kind ||
        !request.bounds || typeof fetcher !== 'function') {
      throw new TypeError('SPC fire-weather request and fetch callback are required');
    }
    var day = validDay(request.day);
    var kind = validKind(request.kind);
    var features = [];
    var seen = Object.create(null);
    var offset = 0;
    for (var page = 0; page < MAX_PAGES; page++) {
      var response = await fetcher(queryUrl(day, kind, request.bounds, offset), { cache: 'no-store', signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var payload = await response.json();
      var normalized = normalizeCollection(payload, day, kind, now);
      normalized.features.forEach(function (feature) {
        var id = featureKey(feature, kind);
        if (seen[id]) return;
        seen[id] = true;
        features.push(feature);
      });
      if (!transferLimitExceeded(payload)) return { type: 'FeatureCollection', features: features };
      if (!Array.isArray(payload.features) || payload.features.length === 0) {
        throw new Error('SPC fire-weather pagination made no progress');
      }
      offset += payload.features.length;
    }
    throw new Error('SPC fire-weather pagination exceeded cap');
  }

  function mergeCollections(collections) {
    if (!Array.isArray(collections)) throw new TypeError('SPC fire-weather collections are required');
    var features = [];
    var seen = Object.create(null);
    collections.forEach(function (collection) {
      if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new TypeError('Invalid SPC fire-weather collection');
      }
      collection.features.forEach(function (feature) {
        var properties = feature.properties || {};
        var id = featureKey(feature, properties.fireWeatherKind || 'unknown');
        if (seen[id]) return;
        seen[id] = true;
        features.push(feature);
      });
    });
    features.sort(function (left, right) {
      return CATEGORY_ORDER[left.properties && left.properties.fireWeatherCategory] -
        CATEGORY_ORDER[right.properties && right.properties.fireWeatherCategory];
    });
    return { type: 'FeatureCollection', features: features };
  }

  function style(name, properties) {
    var styles = {
      marginal: { color: '#707070', fillColor: '#bdbdbd' },
      elevated: { color: '#9a6100', fillColor: '#e69800' },
      isolatedDry: { color: '#732600', fillColor: '#732600', dashArray: '6 4' },
      scatteredDry: { color: '#b00000', fillColor: '#ff0000', dashArray: '6 4' },
      critical: { color: '#b00000', fillColor: '#ff0000' },
      extreme: { color: '#8f0068', fillColor: '#e600a9' }
    };
    var output = Object.assign({}, styles[name]);
    if (!output.color) throw new TypeError('SPC fire-weather style is invalid');
    var stroke = safeColor(properties && (properties.strokeColor || properties.stroke));
    var fill = safeColor(properties && (properties.fillColor || properties.fill));
    if (stroke) output.color = stroke;
    if (fill) output.fillColor = fill;
    output.weight = 2;
    output.fillOpacity = 0.2;
    return output;
  }

  function freshness(fetchedAt, staleMs, now) {
    if (fetchedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(fetchedAt);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var age = Math.max(0, Number(now == null ? Date.now() : now) - timestamp);
    return { state: age > Number(staleMs || 60 * 60 * 1000) ? 'stale' : 'fresh', ageMs: age };
  }

  return Object.freeze({
    ROOT: ROOT, OFFICIAL_URL: OFFICIAL_URL, PAGE_SIZE: PAGE_SIZE, MAX_PAGES: MAX_PAGES,
    KINDS: Object.freeze(KINDS.slice()), DAY_LAYERS: Object.freeze(Object.keys(DAY_LAYERS).reduce(function (output, day) {
      output[day] = Object.freeze(Object.assign({}, DAY_LAYERS[day]));
      return output;
    }, {})),
    CATEGORIES: Object.freeze(CATEGORIES.slice()),
    provider: Object.freeze({
      id: 'fireWeather', defaultVisible: false, refreshMs: 15 * 60 * 1000, staleMs: 3 * 60 * 60 * 1000,
      attribution: Object.freeze({ text: 'NOAA/NWS SPC', url: OFFICIAL_URL })
    }),
    queryUrl: queryUrl, buildQueries: buildQueries, envelopeSegments: envelopeSegments,
    category: category, normalizeCollection: normalizeCollection, fetchAllPages: fetchAllPages,
    mergeCollections: mergeCollections, transferLimitExceeded: transferLimitExceeded,
    style: style, freshness: freshness, parseUtc: parseUtc
  });
});
