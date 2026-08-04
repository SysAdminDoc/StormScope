/* Keyless NOAA NDBC marine-buoy observation layer contract. */
'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeMarineBuoys = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var OBSERVATIONS_URL = 'https://coastwatch.pfeg.noaa.gov/erddap/tabledap/cwwcNDBCMet.json';
  var OFFICIAL_URL = 'https://www.ndbc.noaa.gov/';
  var STATION_URL = 'https://www.ndbc.noaa.gov/station_page.php?station=';
  var ATTRIBUTION = '<a href="https://www.ndbc.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA NDBC marine buoys</a>';
  var MIN_ZOOM = 4;
  var REFRESH_MS = 10 * 60 * 1000;
  var MOVE_REFRESH_MS = 900;
  var LOOKBACK_MS = 2 * 60 * 60 * 1000;
  var STALE_MS = 3 * 60 * 60 * 1000;
  var MAX_TABLE_ROWS = 5000;
  var MAX_BUOYS = 300;
  var JSONP_TIMEOUT_MS = 20 * 1000;
  var FIELDS = ['station', 'longitude', 'latitude', 'time', 'wd', 'wspd', 'gst', 'wvht', 'dpd', 'apd', 'mwd', 'wtmp'];

  var provider = Object.freeze({
    id: 'marineBuoys',
    label: 'NOAA NDBC marine buoys',
    defaultVisible: false,
    minZoom: MIN_ZOOM,
    refreshMs: REFRESH_MS,
    moveRefreshMs: MOVE_REFRESH_MS,
    lookbackMs: LOOKBACK_MS,
    staleMs: STALE_MS,
    maxTableRows: MAX_TABLE_ROWS,
    maxBuoys: MAX_BUOYS,
    attribution: Object.freeze({ text: 'NOAA NDBC marine buoys', url: OFFICIAL_URL }),
    observationsUrl: OBSERVATIONS_URL,
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
    if (!Number.isFinite(number) || number === -999 || number === -9999 || number === -9999999 || number === 32767) {
      return null;
    }
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

  function encodedConstraint(field, operator, value) {
    return encodeURIComponent(field + operator + value);
  }

  function queryUrl(bounds, now) {
    var normalized = normalizeBounds(bounds);
    if (!normalized) throw new TypeError('marine-buoy bounds are invalid');
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(current)) current = Date.now();
    var since = new Date(current - LOOKBACK_MS).toISOString();
    var until = new Date(current + 5 * 60 * 1000).toISOString();
    var parts = [
      encodeURIComponent(FIELDS.join(',')),
      encodedConstraint('longitude', '>=', normalized.west),
      encodedConstraint('longitude', '<=', normalized.east),
      encodedConstraint('latitude', '>=', normalized.south),
      encodedConstraint('latitude', '<=', normalized.north),
      encodedConstraint('time', '>=', since),
      encodedConstraint('time', '<=', until),
      '.maxRows=' + MAX_TABLE_ROWS
    ];
    return OBSERVATIONS_URL + '?' + parts.join('&');
  }

  function buildQueries(bounds, zoom, now) {
    var numericZoom = Number(zoom);
    if (!Number.isFinite(numericZoom) || numericZoom < MIN_ZOOM) return [];
    return boundsParts(bounds).map(function (part) {
      return { bounds: part, url: queryUrl(part, now) };
    });
  }

  function stationId(value) {
    var id = boundedText(value, 16).toUpperCase();
    return /^[A-Z0-9]{1,16}$/.test(id) ? id : '';
  }

  function columnIndexes(columnNames) {
    var indexes = Object.create(null);
    (columnNames || []).forEach(function (name, index) {
      indexes[String(name).toLowerCase()] = index;
    });
    return indexes;
  }

  function rowValue(row, indexes, name) {
    var index = indexes[name];
    return index == null ? null : row[index];
  }

  function officialStationUrl(identifier) {
    var id = stationId(identifier);
    return id ? STATION_URL + encodeURIComponent(id) : OFFICIAL_URL;
  }

  function normalizeRow(row, indexes) {
    if (!Array.isArray(row)) return null;
    var id = stationId(rowValue(row, indexes, 'station'));
    var longitude = finiteNumber(rowValue(row, indexes, 'longitude'), -180, 180);
    var latitude = finiteNumber(rowValue(row, indexes, 'latitude'), -90, 90);
    var observedAt = timestampMs(rowValue(row, indexes, 'time'));
    if (!id || longitude == null || latitude == null || observedAt == null) return null;
    return {
      type: 'Feature',
      id: id,
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: {
        stationId: id,
        windDirection: finiteNumber(rowValue(row, indexes, 'wd'), 0, 360),
        windSpeedMps: finiteNumber(rowValue(row, indexes, 'wspd'), 0, 100),
        windGustMps: finiteNumber(rowValue(row, indexes, 'gst'), 0, 100),
        waveHeightM: finiteNumber(rowValue(row, indexes, 'wvht'), 0, 100),
        dominantWavePeriodS: finiteNumber(rowValue(row, indexes, 'dpd'), 0, 120),
        averageWavePeriodS: finiteNumber(rowValue(row, indexes, 'apd'), 0, 120),
        waveDirection: finiteNumber(rowValue(row, indexes, 'mwd'), 0, 360),
        seaSurfaceTemperatureC: finiteNumber(rowValue(row, indexes, 'wtmp'), -100, 100),
        observedAt: observedAt,
        officialUrl: officialStationUrl(id),
        source: provider.label
      }
    };
  }

  function normalizeCollection(payload) {
    var table = payload && payload.table;
    if (!table || !Array.isArray(table.columnNames) || !Array.isArray(table.rows) ||
        table.rows.length > MAX_TABLE_ROWS ||
        ['station', 'longitude', 'latitude', 'time'].some(function (name) {
          return table.columnNames.map(function (value) { return String(value).toLowerCase(); }).indexOf(name) < 0;
        })) {
      throw new TypeError('Invalid NOAA NDBC ERDDAP table');
    }
    var indexes = columnIndexes(table.columnNames);
    var byStation = Object.create(null);
    table.rows.forEach(function (row) {
      var feature = normalizeRow(row, indexes);
      if (!feature) return;
      var id = feature.properties.stationId;
      var prior = byStation[id];
      if (!prior || feature.properties.observedAt >= prior.properties.observedAt) byStation[id] = feature;
    });
    var features = Object.keys(byStation).map(function (id) { return byStation[id]; });
    features.sort(function (left, right) {
      var timeDifference = Number(right.properties.observedAt) - Number(left.properties.observedAt);
      return timeDifference || String(left.properties.stationId).localeCompare(String(right.properties.stationId));
    });
    var truncated = features.length > MAX_BUOYS;
    if (truncated) features = features.slice(0, MAX_BUOYS);
    features.sort(function (left, right) {
      return String(left.properties.stationId).localeCompare(String(right.properties.stationId));
    });
    return {
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      truncated: truncated,
      updatedAt: latestTimestamp(features)
    };
  }

  function mergeCollections(collections) {
    var byStation = Object.create(null);
    (collections || []).forEach(function (result) {
      var features = result && result.collection && result.collection.features;
      if (!Array.isArray(features)) return;
      features.forEach(function (feature) {
        var id = feature && feature.properties && feature.properties.stationId;
        if (!id) return;
        var prior = byStation[id];
        if (!prior || Number(feature.properties.observedAt) >= Number(prior.properties.observedAt)) byStation[id] = feature;
      });
    });
    var features = Object.keys(byStation).map(function (id) { return byStation[id]; });
    features.sort(function (left, right) {
      return String(left.properties.stationId).localeCompare(String(right.properties.stationId));
    });
    var truncated = features.length > MAX_BUOYS;
    if (truncated) {
      features.sort(function (left, right) { return right.properties.observedAt - left.properties.observedAt; });
      features = features.slice(0, MAX_BUOYS);
      features.sort(function (left, right) {
        return String(left.properties.stationId).localeCompare(String(right.properties.stationId));
      });
    }
    return {
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      truncated: truncated || (collections || []).some(function (result) { return result && result.truncated; }),
      updatedAt: latestTimestamp(features)
    };
  }

  function latestTimestamp(features) {
    var latest = null;
    (features || []).forEach(function (feature) {
      var value = feature && feature.properties && Number(feature.properties.observedAt);
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
    return { state: ageMs > (staleMs == null ? STALE_MS : staleMs) ? 'stale' : 'fresh', ageMs: ageMs };
  }

  function jsonpRequest(documentObject, url, signal, setTimer, clearTimer) {
    if (!documentObject || typeof documentObject.createElement !== 'function') {
      return Promise.reject(new Error('JSONP document is unavailable'));
    }
    var host = root || (typeof globalThis !== 'undefined' ? globalThis : null);
    if (!host) return Promise.reject(new Error('JSONP global is unavailable'));
    return new Promise(function (resolve, reject) {
      var callbackName = '__stormscopeMarineBuoys_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      var script = documentObject.createElement('script');
      var timeout = null;
      var settled = false;

      function removeScript() {
        if (script && script.parentNode && typeof script.parentNode.removeChild === 'function') {
          script.parentNode.removeChild(script);
        } else if (script && typeof script.remove === 'function') {
          script.remove();
        }
      }

      function cleanup() {
        clearTimer(timeout);
        timeout = null;
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        try { delete host[callbackName]; } catch (error) { host[callbackName] = undefined; }
        removeScript();
      }

      function finish(error, payload) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(payload);
      }

      function onAbort() { finish(new Error('Aborted')); }

      host[callbackName] = function (payload) { finish(null, payload); };
      script.async = true;
      script.src = url + '&.jsonp=' + encodeURIComponent(callbackName);
      script.onerror = function () { finish(new Error('NDBC JSONP request failed')); };
      script.onload = function () {
        if (!settled) finish(new Error('NDBC JSONP callback was not received'));
      };
      if (signal && signal.aborted) { onAbort(); return; }
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      timeout = setTimer(function () { finish(new Error('NDBC JSONP request timed out')); }, JSONP_TIMEOUT_MS);
      var parent = documentObject.head || documentObject.documentElement || documentObject.body;
      if (!parent || typeof parent.appendChild !== 'function') { finish(new Error('JSONP document has no script parent')); return; }
      parent.appendChild(script);
    });
  }

  function create(options) {
    options = options || {};
    var documentObject = options.document || (typeof document !== 'undefined' ? document : null);
    var leaflet = options.L || (root && root.L);
    var getMap = typeof options.getMap === 'function' ? options.getMap : function () { return null; };
    var fetcher = options.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : null) : null);
    var useJsonp = options.jsonp === true;
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
    var safeExternalUrl = typeof options.safeExternalUrl === 'function' ? options.safeExternalUrl : function (value) { return value; };
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

    function enabled() { return !destroyed && Boolean(isEnabled()); }

    function renderStatus() {
      var key = state.status === 'off' ? 'context.marineBuoysOff'
        : state.status === 'loading' ? 'context.marineBuoysLoading'
          : state.status === 'zoomed-out' ? 'context.marineBuoysZoom'
            : state.status === 'none' ? 'context.marineBuoysNone'
              : state.status === 'partial' || state.status === 'error' ? 'context.marineBuoysPartial'
                : 'context.marineBuoysStatus';
      var freshnessResult = freshness(state.updatedAt, STALE_MS, Date.now());
      setStatus(translate(key, {
        count: localNumber(state.count),
        freshness: translate('context.' + freshnessResult.state),
        time: state.updatedAt == null ? translate('weather.unknown') : contextTimestamp(state.updatedAt)
      }), state.status === 'partial' || state.status === 'error' ? 'error' : freshnessResult.state);
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

    function valueText(value, unit) {
      return value == null ? translate('context.marineBuoyNoData') : formatUnit(value, unit);
    }

    function appendRow(container, text) {
      var row = documentObject.createElement('span');
      row.textContent = text;
      container.appendChild(row);
    }

    function popup(feature) {
      var properties = feature.properties || {};
      var container = documentObject.createElement('div');
      container.className = 'context-popup marine-buoy-popup';
      var heading = documentObject.createElement('strong');
      heading.textContent = translate('context.marineBuoyStation', { station: properties.stationId });
      container.appendChild(heading);
      appendRow(container, translate('context.marineBuoyWave', {
        height: valueText(properties.waveHeightM, 'm'), period: valueText(properties.dominantWavePeriodS || properties.averageWavePeriodS, 's')
      }));
      appendRow(container, translate('context.marineBuoySst', { value: valueText(properties.seaSurfaceTemperatureC, '°C') }));
      appendRow(container, translate('context.marineBuoyWind', {
        speed: valueText(properties.windSpeedMps, 'm/s'), direction: valueText(properties.windDirection, '°')
      }));
      appendRow(container, translate('context.marineBuoyGust', { value: valueText(properties.windGustMps, 'm/s') }));
      appendRow(container, translate('context.marineBuoyObserved', {
        time: properties.observedAt == null ? translate('weather.unknown') : contextTimestamp(properties.observedAt)
      }));
      var freshnessResult = freshness(properties.observedAt, STALE_MS, Date.now());
      appendRow(container, translate('context.marineBuoyFreshness', {
        age: properties.observedAt == null ? translate('context.marineBuoyNoData') : formatAge(freshnessResult.ageMs / 60000),
        freshness: translate('context.' + freshnessResult.state)
      }));
      appendRow(container, translate('context.marineBuoySource', { source: provider.label }));
      var link = documentObject.createElement('a');
      link.href = safeExternalUrl(properties.officialUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = translate('context.marineBuoyOfficial');
      container.appendChild(link);
      appendNearby(container, feature.geometry, translate('incident.camerasNearMarineBuoy'));
      return container;
    }

    function createLayer(collection) {
      var map = getMap();
      if (!map || !leaflet || typeof leaflet.geoJSON !== 'function') throw new Error('Leaflet is unavailable');
      return leaflet.geoJSON(collection, {
        pane: 'contextVectorPane',
        pointToLayer: function (feature, latlng) {
          return leaflet.circleMarker(latlng, {
            pane: 'contextVectorPane', radius: 6, color: '#06283d', weight: 2,
            fillColor: '#36d1a4', fillOpacity: 0.9
          });
        },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return popup(feature); }, { autoPan: false, maxWidth: 360, maxHeight: 440 });
        }
      }).addTo(map);
    }

    async function fetchQuery(query, signal) {
      var payload;
      if (useJsonp) {
        payload = await jsonpRequest(documentObject, query.url, signal, setTimer, clearTimer);
      } else {
        if (!fetcher) throw new Error('fetch is unavailable');
        var response = await fetcher(query.url, { cache: 'no-store', signal: signal });
        if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status || 0));
        payload = await response.json();
      }
      return normalizeCollection(payload);
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
      var queries = buildQueries(mapBounds(), zoom, Date.now());
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
      id: 'marineBuoys', refresh: refresh, disable: disable, destroy: destroy,
      renderStatus: renderStatus, scheduleMoveRefresh: scheduleMoveRefresh,
      getAbort: function () { return requestAbort; },
      getTimers: function () { return [refreshTimer, moveTimer]; }, getState: getState
    });
  }

  return Object.freeze({
    provider: provider,
    OBSERVATIONS_URL: OBSERVATIONS_URL,
    OFFICIAL_URL: OFFICIAL_URL,
    STATION_URL: STATION_URL,
    MIN_ZOOM: MIN_ZOOM,
    REFRESH_MS: REFRESH_MS,
    MOVE_REFRESH_MS: MOVE_REFRESH_MS,
    LOOKBACK_MS: LOOKBACK_MS,
    STALE_MS: STALE_MS,
    MAX_TABLE_ROWS: MAX_TABLE_ROWS,
    MAX_BUOYS: MAX_BUOYS,
    queryUrl: queryUrl,
    buildQueries: buildQueries,
    normalizeRow: normalizeRow,
    normalizeCollection: normalizeCollection,
    mergeCollections: mergeCollections,
    freshness: freshness,
    officialStationUrl: officialStationUrl,
    create: create
  });
});
