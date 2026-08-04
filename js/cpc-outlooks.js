/* Keyless NOAA CPC drought and extended-range outlook polygon layer contract. */
'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeCpcOutlooks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var DROUGHT_ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_drought_outlk/MapServer';
  var SIX_TEN_ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_6_10_day_outlk/MapServer';
  var EIGHT_FOURTEEN_ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_8_14_day_outlk/MapServer';
  var OFFICIAL_URL = 'https://www.cpc.ncep.noaa.gov/';
  var ATTRIBUTION = '<a href="https://www.cpc.ncep.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA CPC outlooks</a>';
  var MIN_ZOOM = 3;
  var REFRESH_MS = 6 * 60 * 60 * 1000;
  var MOVE_REFRESH_MS = 900;
  var STALE_MS = 12 * 60 * 60 * 1000;
  var MAX_RECORDS = 200;
  var MAX_FEATURES = 2000;
  var DROUGHT_FIELDS = 'objectid,outlook,fcst_date,target,idp_filedate,idp_ingestdate';
  var EXTENDED_FIELDS = 'objectid,fcst_date,start_date,end_date,prob,cat,inpoly_fid,smopgnflag,idp_ingestdate,idp_filedate,idp_source';

  var FEEDS = [
    { id: 'droughtMonthly', root: DROUGHT_ROOT, layerId: 1, kind: 'drought', horizon: 'monthly', label: 'CPC monthly drought outlook', fields: DROUGHT_FIELDS },
    { id: 'droughtSeasonal', root: DROUGHT_ROOT, layerId: 4, kind: 'drought', horizon: 'seasonal', label: 'CPC seasonal drought outlook', fields: DROUGHT_FIELDS },
    { id: 'sixTenTemperature', root: SIX_TEN_ROOT, layerId: 0, kind: 'temperature', horizon: '6-10', label: 'CPC 6–10 day temperature outlook', fields: EXTENDED_FIELDS },
    { id: 'sixTenPrecipitation', root: SIX_TEN_ROOT, layerId: 1, kind: 'precipitation', horizon: '6-10', label: 'CPC 6–10 day precipitation outlook', fields: EXTENDED_FIELDS },
    { id: 'eightFourteenTemperature', root: EIGHT_FOURTEEN_ROOT, layerId: 0, kind: 'temperature', horizon: '8-14', label: 'CPC 8–14 day temperature outlook', fields: EXTENDED_FIELDS },
    { id: 'eightFourteenPrecipitation', root: EIGHT_FOURTEEN_ROOT, layerId: 1, kind: 'precipitation', horizon: '8-14', label: 'CPC 8–14 day precipitation outlook', fields: EXTENDED_FIELDS }
  ];
  var FEED_BY_ID = Object.create(null);
  FEEDS.forEach(function (feed) { FEED_BY_ID[feed.id] = feed; });

  var provider = Object.freeze({
    id: 'cpcOutlooks',
    label: 'NOAA CPC drought and extended-range outlooks',
    defaultVisible: false,
    minZoom: MIN_ZOOM,
    refreshMs: REFRESH_MS,
    moveRefreshMs: MOVE_REFRESH_MS,
    staleMs: STALE_MS,
    maxRecords: MAX_RECORDS,
    maxFeatures: MAX_FEATURES,
    attribution: Object.freeze({ text: 'NOAA CPC outlooks', url: OFFICIAL_URL }),
    officialUrl: OFFICIAL_URL
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
    var text = boundedText(value, 80);
    if (!text || /^n\/?a$/i.test(text)) return null;
    var dateOnly = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (dateOnly) text = dateOnly[3] + '-' + dateOnly[1].padStart(2, '0') + '-' + dateOnly[2].padStart(2, '0') + 'T00:00:00Z';
    else {
      text = text.replace(' ', 'T');
      if (!/[zZ]|[+-]\d\d:?\d\d$/.test(text)) text += 'Z';
    }
    var parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
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
    if (!normalized) return [];
    if (normalized.west <= normalized.east) return [normalized];
    return [
      { west: normalized.west, south: normalized.south, east: 180, north: normalized.north },
      { west: -180, south: normalized.south, east: normalized.east, north: normalized.north }
    ];
  }

  function resolveFeed(feed) {
    var resolved = typeof feed === 'string' ? FEED_BY_ID[feed] : feed;
    if (!resolved || !FEED_BY_ID[resolved.id]) throw new TypeError('CPC feed is unsupported');
    return FEED_BY_ID[resolved.id];
  }

  function queryUrl(feed, bounds) {
    var resolved = resolveFeed(feed);
    var normalized = normalizeBounds(bounds);
    if (!normalized) throw new TypeError('CPC bounds are invalid');
    var params = new URLSearchParams({
      where: '1=1', outFields: resolved.fields, returnGeometry: 'true', outSR: '4326',
      geometry: [normalized.west, normalized.south, normalized.east, normalized.north].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      orderByFields: 'objectid ASC', resultRecordCount: String(MAX_RECORDS), f: 'geojson'
    });
    return resolved.root + '/' + resolved.layerId + '/query?' + params.toString();
  }

  function buildQueries(bounds, zoom) {
    var numericZoom = Number(zoom);
    if (!Number.isFinite(numericZoom) || numericZoom < MIN_ZOOM) return [];
    var queries = [];
    boundsParts(bounds).forEach(function (part) {
      FEEDS.forEach(function (feed) {
        queries.push({ feed: feed.id, bounds: part, url: queryUrl(feed, part) });
      });
    });
    return queries;
  }

  function coordinateValid(value, depth) {
    if (!Array.isArray(value) || !value.length || depth > 4) return false;
    if (typeof value[0] === 'number') {
      return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
        value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
    }
    return value.every(function (child) { return coordinateValid(child, depth + 1); });
  }

  function objectId(properties, feature, index) {
    var value = properties && (properties.objectid != null ? properties.objectid : properties.OBJECTID);
    if (value == null && feature && feature.id != null) value = feature.id;
    var id = boundedText(value == null ? 'feature-' + index : value, 80);
    return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : 'feature-' + index;
  }

  function droughtCategory(value) {
    var normalized = boundedText(value, 64).toLowerCase().replace(/[\s_-]+/g, '-');
    return ['no-drought', 'development', 'improvement', 'persistence', 'removal'].indexOf(normalized) >= 0
      ? normalized : 'unknown';
  }

  function extendedCategory(value) {
    var normalized = boundedText(value, 64).toLowerCase().replace(/[\s_-]+/g, '-');
    return ['above', 'normal', 'below'].indexOf(normalized) >= 0 ? normalized : 'unknown';
  }

  function feedCategory(feed, properties) {
    return feed.kind === 'drought' ? droughtCategory(properties.outlook) : extendedCategory(properties.cat);
  }

  function normalizeFeature(feature, feed, index) {
    var resolved = resolveFeed(feed);
    if (!feature || feature.type !== 'Feature' || !feature.geometry ||
        ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) === -1 ||
        !coordinateValid(feature.geometry.coordinates, 0) || !feature.properties ||
        typeof feature.properties !== 'object' || Array.isArray(feature.properties)) return null;
    var source = feature.properties;
    var category = feedCategory(resolved, source);
    var issuedAt = timestampMs(source.idp_filedate) || timestampMs(source.idp_ingestdate);
    var startsAt = resolved.kind === 'drought' ? timestampMs(source.fcst_date) : timestampMs(source.start_date);
    var endsAt = resolved.kind === 'drought' ? null : timestampMs(source.end_date);
    var probability = resolved.kind === 'drought' ? null : finiteNumber(source.prob, 0, 100);
    var id = resolved.id + '-' + objectId(source, feature, index);
    return {
      type: 'Feature',
      id: id,
      geometry: feature.geometry,
      properties: {
        cpcFeed: resolved.id,
        cpcKind: resolved.kind,
        cpcHorizon: resolved.horizon,
        cpcCategory: category,
        category: category,
        outlook: resolved.kind === 'drought' ? boundedText(source.outlook, 64) : '',
        target: resolved.kind === 'drought' ? boundedText(source.target, 80) : '',
        probability: probability,
        issuedAt: issuedAt,
        validAt: startsAt,
        startsAt: startsAt,
        endsAt: endsAt,
        forecastAt: resolved.kind === 'drought' ? startsAt : timestampMs(source.fcst_date),
        sourceLabel: resolved.label,
        officialUrl: OFFICIAL_URL
      }
    };
  }

  function latestTimestamp(features) {
    var latest = null;
    (features || []).forEach(function (feature) {
      var properties = feature && feature.properties || {};
      [properties.issuedAt, properties.validAt, properties.startsAt, properties.endsAt].forEach(function (value) {
        var timestamp = Number(value);
        if (Number.isFinite(timestamp) && (latest == null || timestamp > latest)) latest = timestamp;
      });
    });
    return latest;
  }

  function normalizeCollection(value, feed) {
    var resolved = resolveFeed(feed);
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > MAX_RECORDS) {
      throw new TypeError('Invalid NOAA CPC GeoJSON');
    }
    var features = value.features.map(function (feature, index) {
      return normalizeFeature(feature, resolved, index);
    }).filter(Boolean);
    var byId = Object.create(null);
    features.forEach(function (feature) { byId[feature.id] = feature; });
    features = Object.keys(byId).map(function (id) { return byId[id]; });
    features.sort(function (left, right) { return String(left.id).localeCompare(String(right.id)); });
    var truncated = Boolean(value.exceededTransferLimit || value.properties && value.properties.exceededTransferLimit);
    return {
      feed: resolved.id,
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      truncated: truncated,
      updatedAt: latestTimestamp(features)
    };
  }

  function mergeCollections(results) {
    var byId = Object.create(null);
    (results || []).forEach(function (result) {
      var features = result && result.collection && result.collection.features;
      if (!Array.isArray(features)) return;
      features.forEach(function (feature) {
        if (feature && feature.id && !byId[feature.id]) byId[feature.id] = feature;
      });
    });
    var features = Object.keys(byId).map(function (id) { return byId[id]; });
    features.sort(function (left, right) { return String(left.id).localeCompare(String(right.id)); });
    var truncated = (results || []).some(function (result) { return result && result.truncated; });
    if (features.length > MAX_FEATURES) {
      features = features.slice(0, MAX_FEATURES);
      truncated = true;
    }
    var droughtCount = features.filter(function (feature) { return feature.properties.cpcKind === 'drought'; }).length;
    return {
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      droughtCount: droughtCount,
      outlookCount: features.length - droughtCount,
      truncated: truncated,
      updatedAt: latestTimestamp(features)
    };
  }

  function freshness(updatedAt, staleMs, now) {
    if (updatedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(updatedAt);
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(timestamp) || !Number.isFinite(current)) return { state: 'unknown', ageMs: null };
    var ageMs = Math.max(0, current - timestamp);
    return { state: ageMs > (staleMs == null ? STALE_MS : staleMs) ? 'stale' : 'fresh', ageMs: ageMs };
  }

  function style(properties) {
    properties = properties || {};
    var category = properties.cpcCategory || properties.category || 'unknown';
    var styles = {
      'no-drought': { color: '#477a4b', fillColor: '#cfe8cf' },
      development: { color: '#d97904', fillColor: '#f5b642' },
      improvement: { color: '#2673a8', fillColor: '#77b7d9' },
      persistence: { color: '#7b6f62', fillColor: '#c6b9a9' },
      removal: { color: '#158f83', fillColor: '#74d3be' },
      above: { color: '#c2410c', fillColor: '#fb923c' },
      normal: { color: '#6b7280', fillColor: '#cbd5e1' },
      below: { color: '#1769aa', fillColor: '#60a5fa' },
      unknown: { color: '#6b7280', fillColor: '#cbd5e1' }
    };
    var output = Object.assign({}, styles[category] || styles.unknown);
    if (properties.cpcKind === 'precipitation' && category === 'above') {
      output.color = '#166534';
      output.fillColor = '#4ade80';
    }
    if (properties.cpcKind === 'precipitation' && category === 'below') {
      output.color = '#7c3aed';
      output.fillColor = '#c4b5fd';
    }
    output.weight = 1;
    output.fillOpacity = 0.3;
    return output;
  }

  function create(options) {
    options = options || {};
    var documentObject = options.document || (typeof document !== 'undefined' ? document : null);
    var leaflet = options.L || (root && root.L);
    var getMap = typeof options.getMap === 'function' ? options.getMap : function () { return null; };
    var fetcher = options.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : null) : null);
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var translate = typeof options.translate === 'function' ? options.translate : function (key) { return key; };
    var localNumber = typeof options.localNumber === 'function' ? options.localNumber : function (value) { return String(value); };
    var contextTimestamp = typeof options.contextTimestamp === 'function' ? options.contextTimestamp : function (value) { return new Date(value).toISOString(); };
    var formatAge = typeof options.formatAge === 'function' ? options.formatAge : function (minutes) { return Math.round(minutes) + ' min'; };
    var isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : function () { return true; };
    var isHidden = typeof options.isDocumentHidden === 'function' ? options.isDocumentHidden : function () { return false; };
    var setStatus = typeof options.setStatus === 'function' ? options.setStatus : function () {};
    var safeExternalUrl = typeof options.safeExternalUrl === 'function' ? options.safeExternalUrl : function (value) { return value; };
    var destroyed = false;
    var generation = 0;
    var requestAbort = null;
    var refreshTimer = null;
    var moveTimer = null;
    var attributionAdded = false;
    var state = {
      status: 'off', count: 0, droughtCount: 0, outlookCount: 0, updatedAt: null,
      layer: null, zoom: null, lastGood: false, partial: false
    };

    function enabled() { return !destroyed && Boolean(isEnabled()); }

    function renderStatus() {
      var key = state.status === 'off' ? 'context.cpcOff'
        : state.status === 'loading' ? 'context.cpcLoading'
          : state.status === 'zoomed-out' ? 'context.cpcZoom'
            : state.status === 'none' ? 'context.cpcNone'
              : state.status === 'partial' || state.status === 'error' ? 'context.cpcPartial'
                : 'context.cpcStatus';
      var fresh = freshness(state.updatedAt, STALE_MS, Date.now());
      var freshnessLabel = fresh.state === 'fresh' || fresh.state === 'stale'
        ? translate('context.' + fresh.state) : translate('weather.unknown');
      setStatus(translate(key, {
        count: localNumber(state.count), drought: localNumber(state.droughtCount), outlooks: localNumber(state.outlookCount),
        freshness: freshnessLabel, time: state.updatedAt == null ? translate('weather.unknown') : contextTimestamp(state.updatedAt)
      }), state.status === 'partial' || state.status === 'error' ? 'error' : fresh.state);
    }

    function mapBounds() {
      var map = getMap();
      if (!map || typeof map.getBounds !== 'function') return null;
      var bounds = map.getBounds();
      return {
        west: Math.max(-180, bounds.getWest()), south: Math.max(-90, bounds.getSouth()),
        east: Math.min(180, bounds.getEast()), north: Math.min(90, bounds.getNorth())
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

    function appendRow(container, text) {
      var row = documentObject.createElement('span');
      row.textContent = text;
      container.appendChild(row);
    }

    function categoryLabel(properties) {
      var category = properties.cpcCategory || 'unknown';
      var key = 'context.cpcCategory.' + category;
      return translate(key);
    }

    function timeText(value) {
      return value == null ? translate('weather.unknown') : contextTimestamp(value);
    }

    function popup(feature) {
      var properties = feature.properties || {};
      var container = documentObject.createElement('div');
      container.className = 'context-popup cpc-outlook-popup';
      var heading = documentObject.createElement('strong');
      heading.textContent = translate('context.cpcFeature', { product: properties.sourceLabel || 'NOAA CPC' });
      container.appendChild(heading);
      appendRow(container, translate('context.cpcCategory', { category: categoryLabel(properties) }));
      if (properties.probability != null) appendRow(container, translate('context.cpcProbability', { value: localNumber(properties.probability) }));
      if (properties.target) appendRow(container, translate('context.cpcTarget', { target: properties.target }));
      appendRow(container, translate('context.cpcIssued', { time: timeText(properties.issuedAt) }));
      appendRow(container, translate('context.cpcValid', { start: timeText(properties.startsAt), end: timeText(properties.endsAt) }));
      appendRow(container, translate('context.cpcSource', { source: properties.sourceLabel || provider.label }));
      var link = documentObject.createElement('a');
      link.href = safeExternalUrl(properties.officialUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = translate('context.cpcOfficial');
      container.appendChild(link);
      return container;
    }

    function createLayer(collection) {
      var map = getMap();
      if (!map || !leaflet || typeof leaflet.geoJSON !== 'function') throw new Error('Leaflet is unavailable');
      return leaflet.geoJSON(collection, {
        pane: 'contextVectorPane',
        style: function (feature) { return style(feature.properties); },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return popup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 440 });
        }
      }).addTo(map);
    }

    async function fetchQuery(query, signal) {
      if (!fetcher) throw new Error('fetch is unavailable');
      var response = await fetcher(query.url, { cache: 'no-store', signal: signal });
      if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status || 0));
      return normalizeCollection(await response.json(), query.feed);
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
        state.droughtCount = 0;
        state.outlookCount = 0;
        state.updatedAt = null;
        state.lastGood = false;
        state.partial = false;
        removeLayer();
        removeAttribution();
        renderStatus();
        return undefined;
      }
      if (requestAbort) requestAbort.abort();
      var AbortCtor = typeof AbortController === 'function' ? AbortController : root && root.AbortController;
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
          state.status = 'error';
          state.lastGood = Boolean(state.layer);
          renderStatus();
          return getState();
        }
        var merged = mergeCollections(successful);
        var nextLayer = createLayer(merged.collection);
        removeLayer();
        state.layer = nextLayer;
        state.count = merged.count;
        state.droughtCount = merged.droughtCount;
        state.outlookCount = merged.outlookCount;
        state.updatedAt = merged.updatedAt;
        state.partial = failed || merged.truncated;
        state.status = state.partial ? 'partial' : (merged.count ? 'ready' : 'none');
        state.lastGood = true;
        addAttribution();
        renderStatus();
        return getState();
      } catch (error) {
        if (error && error.name === 'AbortError') return undefined;
        if (!destroyed && token === generation) {
          state.status = 'error';
          state.lastGood = Boolean(state.layer);
          renderStatus();
        }
        return getState();
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
      if (enabled()) moveTimer = setTimer(function () { refresh(); }, MOVE_REFRESH_MS);
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
      state.droughtCount = 0;
      state.outlookCount = 0;
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
        droughtCount: state.droughtCount, outlookCount: state.outlookCount,
        updatedAt: state.updatedAt, layer: state.layer, zoom: state.zoom,
        lastGood: state.lastGood, partial: state.partial
      };
    }

    renderStatus();
    return Object.freeze({
      id: 'cpcOutlooks', refresh: refresh, disable: disable, destroy: destroy,
      renderStatus: renderStatus, scheduleMoveRefresh: scheduleMoveRefresh,
      getAbort: function () { return requestAbort; },
      getTimers: function () { return [refreshTimer, moveTimer]; }, getState: getState
    });
  }

  return Object.freeze({
    provider: provider,
    DROUGHT_ROOT: DROUGHT_ROOT, SIX_TEN_ROOT: SIX_TEN_ROOT, EIGHT_FOURTEEN_ROOT: EIGHT_FOURTEEN_ROOT,
    OFFICIAL_URL: OFFICIAL_URL, MIN_ZOOM: MIN_ZOOM, REFRESH_MS: REFRESH_MS, MOVE_REFRESH_MS: MOVE_REFRESH_MS,
    STALE_MS: STALE_MS, MAX_RECORDS: MAX_RECORDS, MAX_FEATURES: MAX_FEATURES,
    DROUGHT_FIELDS: DROUGHT_FIELDS, EXTENDED_FIELDS: EXTENDED_FIELDS,
    feeds: Object.freeze(FEEDS.map(function (feed) { return Object.freeze(Object.assign({}, feed)); })),
    queryUrl: queryUrl, buildQueries: buildQueries, normalizeBounds: normalizeBounds, boundsParts: boundsParts,
    timestampMs: timestampMs, droughtCategory: droughtCategory, extendedCategory: extendedCategory,
    normalizeFeature: normalizeFeature, normalizeCollection: normalizeCollection, mergeCollections: mergeCollections,
    freshness: freshness, style: style, create: create
  });
});
