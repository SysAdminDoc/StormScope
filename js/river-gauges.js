/* Keyless NOAA NWPS observed and forecast river-gauge layer contract. */
'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeRiverGauges = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var OBSERVED_URL = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0';
  var FORECAST_URL = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/1';
  var STAGEFLOW_URL = 'https://api.water.noaa.gov/nwps/v1/gauges';
  var MAX_RECORDS = 200;
  var MAX_GAUGES = 400;
  var MIN_ZOOM = 4;
  var REFRESH_MS = 5 * 60 * 1000;
  var STALE_MS = 2 * 60 * 60 * 1000;
  var OUT_FIELDS = {
    observed: [
      'objectid', 'gaugelid', 'status', 'location', 'waterbody', 'state', 'obstime', 'wfo', 'url', 'action',
      'units', 'lowthresh', 'lowthreshu', 'secvalue', 'secunit', 'flood', 'moderate', 'major', 'observed',
      'latitude', 'longitude', 'hdatum', 'pedts', 'idp_filedate', 'idp_ingestdate'
    ].join(','),
    forecast: [
      'objectid', 'gaugelid', 'status', 'location', 'waterbody', 'state', 'fcsttime', 'fcstissunc', 'wfo', 'url',
      'action', 'forecast', 'units', 'lowthresh', 'lowthreshu', 'secvalue', 'secunit', 'flood', 'moderate',
      'major', 'latitude', 'longitude', 'idp_filedate', 'idp_ingestdate'
    ].join(',')
  };
  var CATEGORY_COLORS = {
    below: '#4cc9f0', action: '#ffd166', minor: '#ff9f1c', moderate: '#ff2d55', major: '#b5179e',
    'not-current': '#8d99ae', 'out-of-service': '#6c757d', 'no-forecast': '#8d99ae', unknown: '#8d99ae'
  };
  var CATEGORY_NAMES = ['below', 'action', 'minor', 'moderate', 'major'];
  var ATTRIBUTION = '<a href="https://water.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA NWPS river gauges</a>';

  var provider = Object.freeze({
    id: 'riverGauges',
    label: 'NOAA NWPS river gauges',
    defaultVisible: false,
    minZoom: MIN_ZOOM,
    refreshMs: REFRESH_MS,
    staleMs: STALE_MS,
    maxRecords: MAX_RECORDS,
    attribution: Object.freeze({ text: 'NOAA NWPS river gauges', url: 'https://water.noaa.gov/' }),
    observedUrl: OBSERVED_URL,
    forecastUrl: FORECAST_URL,
    stageflowUrl: STAGEFLOW_URL
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
    if (!Number.isFinite(number) || number === -999 || number === -9999 || number === -9999.0) return null;
    return number >= minimum && number <= maximum ? number : null;
  }

  function timestampMs(value) {
    if (value == null || value === '') return null;
    var number = Number(value);
    if (Number.isFinite(number)) {
      if (number > 0 && number < 100000000000) number *= 1000;
      return number > 0 ? number : null;
    }
    var text = String(value).trim();
    if (!text || /^n\/?a$/i.test(text)) return null;
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

  function normalizeKind(kind) {
    var value = String(kind || '').toLowerCase();
    if (value !== 'observed' && value !== 'forecast') throw new TypeError('river-gauge feed is unsupported');
    return value;
  }

  function queryUrl(kind, bounds) {
    var normalizedKind = normalizeKind(kind);
    var normalized = normalizeBounds(bounds);
    if (!normalized) throw new TypeError('river-gauge bounds are invalid');
    var params = new URLSearchParams({
      where: '1=1',
      outFields: OUT_FIELDS[normalizedKind],
      returnGeometry: 'true',
      outSR: '4326',
      geometry: [normalized.west, normalized.south, normalized.east, normalized.north].join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      orderByFields: 'objectid ASC',
      resultRecordCount: String(MAX_RECORDS),
      f: 'geojson'
    });
    return (normalizedKind === 'observed' ? OBSERVED_URL : FORECAST_URL) + '/query?' + params.toString();
  }

  function buildQueries(bounds, zoom) {
    var numericZoom = Number(zoom);
    if (!Number.isFinite(numericZoom) || numericZoom < MIN_ZOOM) return [];
    var queries = [];
    boundsParts(bounds).forEach(function (part) {
      ['observed', 'forecast'].forEach(function (kind) {
        queries.push({ kind: kind, url: queryUrl(kind, part) });
      });
    });
    return queries;
  }

  function gaugeId(value) {
    var id = boundedText(value, 40).toUpperCase();
    if (!/^[A-Z0-9_-]{1,40}$/.test(id)) return '';
    return id;
  }

  function stageflowUrl(identifier) {
    var id = gaugeId(identifier);
    if (!id) throw new TypeError('river-gauge identifier is invalid');
    if (id.indexOf('USGS-') === 0) id = id.slice(5);
    return STAGEFLOW_URL + '/' + encodeURIComponent(id) + '/stageflow';
  }

  function officialUrl(identifier, value) {
    var candidate = boundedText(value, 400);
    if (candidate) {
      try {
        var parsed = new URL(candidate);
        if (parsed.protocol === 'https:' && ['water.noaa.gov', 'api.water.noaa.gov'].indexOf(parsed.hostname) >= 0) {
          return parsed.href;
        }
      } catch (error) { /* fall through to the canonical gauge URL */ }
    }
    var id = gaugeId(identifier);
    if (id.indexOf('USGS-') === 0) id = id.slice(5);
    id = id.toLowerCase();
    return id ? 'https://water.noaa.gov/gauges/' + encodeURIComponent(id) : 'https://water.noaa.gov/';
  }

  function normalizedStatus(value) {
    return boundedText(value, 40).toLowerCase().replace(/[\s-]+/g, '_');
  }

  function statusCategory(value, kind) {
    var status = normalizedStatus(value);
    if (status === 'major' || status === 'moderate' || status === 'minor' || status === 'action') return status;
    if (status === 'no_flooding' || status === 'low_threshold' || status === 'below') return 'below';
    if (status === 'no_forecast') return 'no-forecast';
    if (status === 'obs_not_current' || status === 'not_current') return 'not-current';
    if (status === 'out_of_service') return 'out-of-service';
    if (kind === 'forecast' && !status) return 'no-forecast';
    return 'unknown';
  }

  function thresholds(source) {
    return {
      action: finiteNumber(source.action, -100000, 100000),
      minor: finiteNumber(source.flood, -100000, 100000),
      moderate: finiteNumber(source.moderate, -100000, 100000),
      major: finiteNumber(source.major, -100000, 100000)
    };
  }

  function computedCategory(value, values) {
    if (value == null) return 'unknown';
    if (values.major != null && value >= values.major) return 'major';
    if (values.moderate != null && value >= values.moderate) return 'moderate';
    if (values.minor != null && value >= values.minor) return 'minor';
    if (values.action != null && value >= values.action) return 'action';
    return 'below';
  }

  function coordinate(feature, source) {
    var geometry = feature && feature.geometry;
    var coordinates = geometry && geometry.type === 'Point' ? geometry.coordinates : null;
    var geometryLon = Array.isArray(coordinates) ? finiteNumber(coordinates[0], -180, 180) : null;
    var geometryLat = Array.isArray(coordinates) ? finiteNumber(coordinates[1], -90, 90) : null;
    var lon = finiteNumber(source.longitude, -180, 180);
    var lat = finiteNumber(source.latitude, -90, 90);
    return {
      lon: lon == null ? geometryLon : lon,
      lat: lat == null ? geometryLat : lat
    };
  }

  function normalizeFeature(feature, kind) {
    var normalizedKind = normalizeKind(kind);
    if (!feature || feature.type !== 'Feature' || !feature.properties ||
        typeof feature.properties !== 'object' || Array.isArray(feature.properties)) return null;
    var source = feature.properties;
    var point = coordinate(feature, source);
    if (point.lon == null || point.lat == null) return null;
    var id = gaugeId(source.gaugelid || source.gaugeid || source.usgsid || feature.id);
    if (!id) return null;
    var isObserved = normalizedKind === 'observed';
    var value = finiteNumber(source[isObserved ? 'observed' : 'forecast'], -100000, 100000);
    var flow = finiteNumber(source.secvalue, -100000000, 100000000);
    var thresholdValues = thresholds(source);
    var status = normalizedStatus(source.status);
    var category = statusCategory(status, normalizedKind);
    if (category === 'unknown' || category === 'below') {
      var computed = computedCategory(value, thresholdValues);
      if (computed !== 'unknown' && (category === 'unknown' || category === 'below')) category = computed;
    }
    return {
      type: 'Feature',
      id: id,
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: {
        gaugeId: id,
        name: boundedText(source.location || source.waterbody || id, 180),
        waterbody: boundedText(source.waterbody, 180),
        state: boundedText(source.state, 8),
        status: status || (isObserved ? 'unknown' : 'no_forecast'),
        value: value,
        flow: flow,
        unit: boundedText(source.units || source.lowthreshu, 24),
        flowUnit: boundedText(source.secunit, 24),
        validAt: timestampMs(source[isObserved ? 'obstime' : 'fcsttime']),
        issuedAt: timestampMs(source[isObserved ? 'idp_filedate' : 'fcstissunc']),
        sourceUpdatedAt: timestampMs(source.idp_ingestdate) || timestampMs(source.idp_filedate),
        category: category,
        thresholds: thresholdValues,
        officialUrl: officialUrl(id, source.url),
        wfo: boundedText(source.wfo, 8)
      }
    };
  }

  function transferLimitExceeded(payload) {
    return Boolean(payload && (payload.exceededTransferLimit ||
      payload.properties && payload.properties.exceededTransferLimit));
  }

  function normalizeCollection(payload, kind) {
    var normalizedKind = normalizeKind(kind);
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features) ||
        payload.features.length > MAX_RECORDS) {
      throw new TypeError('Invalid NOAA NWPS river-gauge GeoJSON');
    }
    var byGauge = Object.create(null);
    payload.features.forEach(function (feature) {
      var normalized = normalizeFeature(feature, normalizedKind);
      if (!normalized) return;
      var id = normalized.properties.gaugeId;
      var prior = byGauge[id];
      if (!prior || Number(normalized.properties.validAt || 0) >= Number(prior.properties.validAt || 0)) {
        byGauge[id] = normalized;
      }
    });
    var features = Object.keys(byGauge).map(function (id) { return byGauge[id]; });
    features.sort(function (left, right) {
      return String(left.properties.gaugeId).localeCompare(String(right.properties.gaugeId));
    });
    return {
      kind: normalizedKind,
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      truncated: transferLimitExceeded(payload),
      updatedAt: latestTimestamp(features)
    };
  }

  function mergeThresholds(primary, fallback) {
    var result = {};
    ['action', 'minor', 'moderate', 'major'].forEach(function (key) {
      result[key] = primary && primary[key] != null ? primary[key] : fallback && fallback[key] != null ? fallback[key] : null;
    });
    return result;
  }

  function latestValue(values) {
    var result = null;
    values.forEach(function (value) {
      if (value != null && Number.isFinite(Number(value)) && (result == null || Number(value) > result)) result = Number(value);
    });
    return result;
  }

  function mergeCollections(observedResult, forecastResult, now) {
    var results = [observedResult, forecastResult];
    var byGauge = Object.create(null);
    results.forEach(function (result) {
      if (!result || !result.collection || !Array.isArray(result.collection.features)) return;
      result.collection.features.forEach(function (feature) {
        var id = feature.properties.gaugeId;
        var target = byGauge[id];
        if (!target) {
          target = { id: id, geometry: feature.geometry, observed: null, forecast: null };
          byGauge[id] = target;
        }
        if (result.kind === 'forecast') target.forecast = feature;
        else target.observed = feature;
        if (!target.geometry) target.geometry = feature.geometry;
      });
    });
    var features = Object.keys(byGauge).map(function (id) {
      var item = byGauge[id];
      var observed = item.observed && item.observed.properties;
      var forecast = item.forecast && item.forecast.properties;
      var base = observed || forecast || {};
      var thresholdValues = mergeThresholds(observed && observed.thresholds, forecast && forecast.thresholds);
      var observedCategory = observed ? observed.category : 'unknown';
      var forecastCategory = forecast ? forecast.category : 'no-forecast';
      var hasForecast = Boolean(forecast && (forecast.value != null || forecast.flow != null ||
        CATEGORY_NAMES.indexOf(forecastCategory) >= 0));
      var category = hasForecast ? forecastCategory : observedCategory;
      if (category === 'unknown' && forecast) category = forecastCategory;
      var updatedAt = latestValue([
        observed && observed.sourceUpdatedAt, forecast && forecast.sourceUpdatedAt,
        observed && observed.validAt, forecast && forecast.issuedAt
      ]);
      return {
        type: 'Feature',
        id: id,
        geometry: item.geometry,
        properties: {
          gaugeId: id,
          name: base.name || id,
          waterbody: base.waterbody || '',
          state: base.state || '',
          wfo: base.wfo || '',
          observedStage: observed ? observed.value : null,
          observedFlow: observed ? observed.flow : null,
          observedUnit: observed ? observed.unit : '',
          observedFlowUnit: observed ? observed.flowUnit : '',
          observedAt: observed ? observed.validAt : null,
          observedStatus: observed ? observed.status : 'unavailable',
          observedCategory: observedCategory,
          forecastStage: forecast ? forecast.value : null,
          forecastFlow: forecast ? forecast.flow : null,
          forecastUnit: forecast ? forecast.unit : '',
          forecastFlowUnit: forecast ? forecast.flowUnit : '',
          forecastIssuedAt: forecast ? forecast.issuedAt : null,
          forecastValidAt: forecast ? forecast.validAt : null,
          forecastStatus: forecast ? forecast.status : 'no_forecast',
          forecastCategory: forecastCategory,
          forecastAvailable: hasForecast,
          category: category,
          thresholds: thresholdValues,
          updatedAt: updatedAt,
          officialUrl: (observed && observed.officialUrl) || (forecast && forecast.officialUrl) || officialUrl(id),
          source: provider.label
        }
      };
    });
    features.sort(function (left, right) {
      return String(left.properties.gaugeId).localeCompare(String(right.properties.gaugeId));
    });
    if (features.length > MAX_GAUGES) features = features.slice(0, MAX_GAUGES);
    return {
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      updatedAt: latestTimestamp(features, now)
    };
  }

  function latestTimestamp(features) {
    var latest = null;
    (features || []).forEach(function (feature) {
      var properties = feature.properties || {};
      var values = [properties.updatedAt, properties.observedAt, properties.forecastIssuedAt,
        properties.validAt, properties.issuedAt];
      values.forEach(function (value) {
        var timestamp = Number(value);
        if (Number.isFinite(timestamp) && (latest == null || timestamp > latest)) latest = timestamp;
      });
    });
    return latest;
  }

  function freshness(updatedAt, staleMs, now) {
    if (updatedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(updatedAt);
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var ageMs = Math.max(0, current - timestamp);
    return { state: ageMs > (staleMs == null ? STALE_MS : staleMs) ? 'stale' : 'fresh', ageMs: ageMs };
  }

  function categoryColor(category) {
    return CATEGORY_COLORS[category] || CATEGORY_COLORS.unknown;
  }

  function create(options) {
    options = options || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var leaflet = options.L || root.L;
    var getMap = typeof options.getMap === 'function' ? options.getMap : function () { return null; };
    var fetcher = options.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : null) : null);
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var translate = typeof options.translate === 'function' ? options.translate : function (key) { return key; };
    var localNumber = typeof options.localNumber === 'function' ? options.localNumber : function (value) { return String(value); };
    var formatUnit = typeof options.formatUnit === 'function' ? options.formatUnit : function (value, unit) {
      if (root && root.StormScopeI18n && typeof root.StormScopeI18n.formatUnit === 'function') {
        return root.StormScopeI18n.formatUnit(value, unit);
      }
      return localNumber(value) + (unit ? '\u00a0' + unit : '');
    };
    var contextTimestamp = typeof options.contextTimestamp === 'function' ? options.contextTimestamp : function (value) { return new Date(value).toISOString(); };
    var formatAge = typeof options.formatAge === 'function' ? options.formatAge : function (minutes) {
      return root && root.StormScopeI18n && typeof root.StormScopeI18n.formatAge === 'function'
        ? root.StormScopeI18n.formatAge(minutes) : String(Math.round(minutes)) + ' min';
    };
    var isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : function () { return true; };
    var isHidden = typeof options.isDocumentHidden === 'function' ? options.isDocumentHidden : function () { return false; };
    var setStatus = typeof options.setStatus === 'function' ? options.setStatus : function () {};
    var appendNearby = typeof options.appendNearbyCameraSection === 'function' ? options.appendNearbyCameraSection : function () {};
    var destroyed = false;
    var generation = 0;
    var requestAbort = null;
    var refreshTimer = null;
    var moveTimer = null;
    var attributionAdded = false;
    var state = {
      status: 'off', count: 0, updatedAt: null, layer: null, zoom: null,
      lastGood: false, partial: false
    };

    function enabled() {
      return !destroyed && Boolean(isEnabled());
    }

    function renderStatus() {
      var key = state.status === 'off' ? 'context.gaugesOff'
        : state.status === 'loading' ? 'context.gaugesLoading'
          : state.status === 'zoomed-out' ? 'context.gaugesZoom'
            : state.status === 'none' ? 'context.gaugesNone'
              : state.status === 'partial' || state.status === 'error' ? 'context.gaugesPartial'
                : 'context.gaugesActive';
      setStatus(translate(key, { count: localNumber(state.count) }),
        state.status === 'partial' || state.status === 'error' ? 'error' : state.status);
    }

    function mapBounds() {
      var map = getMap();
      if (!map || typeof map.getBounds !== 'function') return null;
      var bounds = map.getBounds();
      return {
        west: Math.max(-180, bounds.getWest()),
        south: Math.max(-90, bounds.getSouth()),
        east: Math.min(180, bounds.getEast()),
        north: Math.min(90, bounds.getNorth())
      };
    }

    function removeLayer() {
      var map = getMap();
      if (state.layer && map && typeof map.removeLayer === 'function') map.removeLayer(state.layer);
      state.layer = null;
    }

    function addAttribution() {
      var map = getMap();
      if (!attributionAdded && map && map.attributionControl && typeof map.attributionControl.addAttribution === 'function') {
        map.attributionControl.addAttribution(ATTRIBUTION);
        attributionAdded = true;
      }
    }

    function removeAttribution() {
      var map = getMap();
      if (attributionAdded && map && map.attributionControl && typeof map.attributionControl.removeAttribution === 'function') {
        map.attributionControl.removeAttribution(ATTRIBUTION);
      }
      attributionAdded = false;
    }

    function popupRow(container, text) {
      var row = doc.createElement('span');
      row.textContent = text;
      container.appendChild(row);
      return row;
    }

    function categoryLabel(category) {
      var key = category === 'no-forecast' ? 'context.gaugeCategory.noForecast'
        : category === 'not-current' ? 'context.gaugeCategory.notCurrent'
          : category === 'out-of-service' ? 'context.gaugeCategory.outOfService'
            : 'context.gaugeCategory.' + (category || 'unknown');
      return translate(key);
    }

    function valueText(value, unit) {
      if (value == null) return translate('context.gaugeUnavailable');
      return formatUnit(value, unit);
    }

    function timeText(value) {
      return value == null ? translate('context.gaugeUnavailable') : contextTimestamp(value);
    }

    function ageText(updatedAt) {
      if (updatedAt == null) return translate('context.gaugeUnavailable');
      return formatAge(Math.max(0, Date.now() - Number(updatedAt)) / 60000);
    }

    function gaugePopup(feature) {
      var properties = feature.properties || {};
      var container = doc.createElement('div');
      container.className = 'context-popup river-gauge-popup';
      var title = doc.createElement('strong');
      title.textContent = properties.name || properties.gaugeId;
      container.appendChild(title);
      if (properties.waterbody) popupRow(container, properties.waterbody + (properties.state ? ', ' + properties.state : ''));

      var observedHeading = doc.createElement('h4');
      observedHeading.textContent = translate('context.gaugeObserved');
      container.appendChild(observedHeading);
      popupRow(container, translate('context.gaugeStage', {
        value: valueText(properties.observedStage, properties.observedUnit)
      }));
      if (properties.observedFlow != null) popupRow(container, translate('context.gaugeFlow', {
        value: valueText(properties.observedFlow, properties.observedFlowUnit)
      }));
      popupRow(container, translate('context.gaugeCategory', { category: categoryLabel(properties.observedCategory) }));
      popupRow(container, translate('context.gaugeValid', { time: timeText(properties.observedAt) }));

      var forecastHeading = doc.createElement('h4');
      forecastHeading.textContent = translate('context.gaugeForecast');
      container.appendChild(forecastHeading);
      popupRow(container, translate('context.gaugeStage', {
        value: valueText(properties.forecastStage, properties.forecastUnit)
      }));
      if (properties.forecastFlow != null) popupRow(container, translate('context.gaugeFlow', {
        value: valueText(properties.forecastFlow, properties.forecastFlowUnit)
      }));
      popupRow(container, translate('context.gaugeCategory', { category: categoryLabel(properties.forecastCategory) }));
      popupRow(container, translate('context.gaugeIssued', { time: timeText(properties.forecastIssuedAt) }));
      popupRow(container, translate('context.gaugeValid', { time: timeText(properties.forecastValidAt) }));

      var freshnessResult = freshness(properties.updatedAt, STALE_MS, Date.now());
      popupRow(container, translate('context.gaugeFreshness', {
        age: ageText(properties.updatedAt), freshness: translate('context.' + (freshnessResult.state === 'stale' ? 'stale' : 'fresh'))
      }));
      ['action', 'minor', 'moderate', 'major'].forEach(function (name) {
        if (properties.thresholds && properties.thresholds[name] != null) {
          popupRow(container, translate('context.gaugeThreshold', {
            name: translate('context.gaugeCategory.' + name),
            value: valueText(properties.thresholds[name], properties.observedUnit || properties.forecastUnit)
          }));
        }
      });
      popupRow(container, translate('context.gaugeSource', { source: provider.label }));
      var link = doc.createElement('a');
      link.href = typeof options.safeExternalUrl === 'function' ? options.safeExternalUrl(properties.officialUrl) : properties.officialUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = translate('context.gaugeOfficial');
      container.appendChild(link);
      appendNearby(container, feature.geometry, translate('incident.camerasNearGauge'));
      return container;
    }

    function createLayer(collection) {
      var map = getMap();
      if (!map || !leaflet || typeof leaflet.geoJSON !== 'function') throw new Error('Leaflet is unavailable');
      return leaflet.geoJSON(collection, {
        pane: 'contextVectorPane',
        pointToLayer: function (feature, latlng) {
          var category = feature.properties && feature.properties.category;
          return leaflet.circleMarker(latlng, {
            pane: 'contextVectorPane', radius: 6, color: '#111111', weight: 2,
            fillColor: categoryColor(category), fillOpacity: 0.9
          });
        },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return gaugePopup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 520 });
        }
      }).addTo(map);
    }

    async function fetchQuery(query, signal) {
      if (!fetcher) throw new Error('fetch is unavailable');
      var response = await fetcher(query.url, { cache: 'no-store', signal: signal });
      if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status || 0));
      return normalizeCollection(await response.json(), query.kind);
    }

    function scheduleRefresh() {
      clearTimer(refreshTimer);
      refreshTimer = null;
      if (enabled()) refreshTimer = setTimer(function () { refresh(); }, REFRESH_MS);
    }

    async function refresh() {
      if (!enabled() || isHidden()) return undefined;
      var map = getMap();
      if (!map || typeof map.getZoom !== 'function') return undefined;
      var zoom = Number(map.getZoom());
      state.zoom = Number.isFinite(zoom) ? zoom : null;
      if (!Number.isFinite(zoom) || zoom < MIN_ZOOM) {
        if (requestAbort) requestAbort.abort();
        state.status = 'zoomed-out';
        state.count = 0;
        state.updatedAt = null;
        state.lastGood = false;
        removeLayer();
        renderStatus();
        return undefined;
      }
      if (requestAbort) requestAbort.abort();
      var AbortCtor = typeof AbortController === 'function' ? AbortController : root.AbortController;
      if (!AbortCtor) throw new Error('AbortController is unavailable');
      requestAbort = new AbortCtor();
      var signal = requestAbort.signal;
      var token = ++generation;
      state.status = 'loading';
      renderStatus();
      var queries = buildQueries(mapBounds(), zoom);
      try {
        var settled = await Promise.allSettled(queries.map(function (query) { return fetchQuery(query, signal); }));
        if (signal.aborted || destroyed || token !== generation || !enabled()) return undefined;
        var successful = settled.filter(function (result) { return result.status === 'fulfilled'; }).map(function (result) { return result.value; });
        var failed = settled.some(function (result) { return result.status === 'rejected'; });
        if (!successful.length) {
          state.status = state.layer ? 'error' : 'error';
          state.lastGood = Boolean(state.layer);
          renderStatus();
          return undefined;
        }
        var observed = successful.filter(function (result) { return result.kind === 'observed'; })[0] || null;
        var forecast = successful.filter(function (result) { return result.kind === 'forecast'; })[0] || null;
        var merged = mergeCollections(observed, forecast, Date.now());
        if (failed && state.layer) {
          state.status = 'partial';
          state.lastGood = true;
          renderStatus();
          return merged;
        }
        var next = createLayer(merged.collection);
        removeLayer();
        state.layer = next;
        state.count = merged.count;
        state.updatedAt = merged.updatedAt;
        state.partial = failed || Boolean(successful.some(function (result) { return result.truncated; }));
        state.status = state.partial ? 'partial' : (merged.count ? 'ready' : 'none');
        state.lastGood = true;
        addAttribution();
        renderStatus();
        return merged;
      } catch (error) {
        if (error && error.name === 'AbortError') return undefined;
        if (!destroyed && token === generation) {
          state.status = 'error';
          state.lastGood = Boolean(state.layer);
          renderStatus();
        }
        return undefined;
      } finally {
        if (token === generation) {
          requestAbort = null;
          scheduleRefresh();
        }
      }
    }

    function scheduleMoveRefresh() {
      clearTimer(moveTimer);
      moveTimer = null;
      if (enabled()) moveTimer = setTimer(function () { refresh(); }, 900);
    }

    function disable() {
      generation += 1;
      if (requestAbort) requestAbort.abort();
      requestAbort = null;
      clearTimer(refreshTimer);
      clearTimer(moveTimer);
      refreshTimer = null;
      moveTimer = null;
      removeLayer();
      removeAttribution();
      state.status = 'off';
      state.count = 0;
      state.updatedAt = null;
      state.zoom = null;
      state.lastGood = false;
      state.partial = false;
      renderStatus();
    }

    function destroy() {
      if (destroyed) return;
      disable();
      destroyed = true;
    }

    function getState() {
      return {
        enabled: Boolean(state.layer), status: state.status, count: state.count,
        updatedAt: state.updatedAt, layer: state.layer, zoom: state.zoom,
        lastGood: state.lastGood, partial: state.partial
      };
    }

    renderStatus();
    return Object.freeze({
      id: 'riverGauges',
      refresh: refresh,
      disable: disable,
      destroy: destroy,
      renderStatus: renderStatus,
      scheduleMoveRefresh: scheduleMoveRefresh,
      getAbort: function () { return requestAbort; },
      getTimers: function () { return [refreshTimer, moveTimer]; },
      getState: getState
    });
  }

  return Object.freeze({
    provider: provider,
    OBSERVED_URL: OBSERVED_URL,
    FORECAST_URL: FORECAST_URL,
    STAGEFLOW_URL: STAGEFLOW_URL,
    MAX_RECORDS: MAX_RECORDS,
    MAX_GAUGES: MAX_GAUGES,
    MIN_ZOOM: MIN_ZOOM,
    REFRESH_MS: REFRESH_MS,
    STALE_MS: STALE_MS,
    queryUrl: queryUrl,
    buildQueries: buildQueries,
    stageflowUrl: stageflowUrl,
    normalizeFeature: normalizeFeature,
    normalizeCollection: normalizeCollection,
    mergeCollections: mergeCollections,
    freshness: freshness,
    categoryColor: categoryColor,
    statusCategory: statusCategory,
    create: create
  });
});
