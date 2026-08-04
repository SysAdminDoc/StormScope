/* Bounded NOAA SWPC aurora, planetary K-index, and alert contracts. */
'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSpaceWeather = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var AURORA_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
  var ALERTS_URL = 'https://services.swpc.noaa.gov/products/alerts.json';
  var KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
  var OFFICIAL_URL = 'https://www.swpc.noaa.gov/';
  var AURORA_WIDTH = 360;
  var AURORA_HEIGHT = 181;
  var MAX_COORDINATES = AURORA_WIDTH * AURORA_HEIGHT + AURORA_WIDTH;
  var MAX_ALERTS = 8;
  var MAX_ALERT_MESSAGE = 2400;
  var MAX_KP_ROWS = 48;
  var MAX_TEXT = 180;
  var REFRESH_MS = 15 * 60 * 1000;
  var AURORA_STALE_MS = 90 * 60 * 1000;
  var KP_STALE_MS = 12 * 60 * 60 * 1000;
  var ALERT_STALE_MS = 12 * 60 * 60 * 1000;
  var WORLD_BOUNDS = [[-90, -180], [90, 180]];
  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  function finite(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function boundedText(value, limit) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
  }

  function boundedMessage(value, limit) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .trim().slice(0, limit);
  }

  function parseTimestamp(value) {
    if (typeof value === 'string' && !value.trim()) return null;
    var numeric = finite(value);
    if (numeric != null) {
      if (Math.abs(numeric) < 100000000000) numeric *= 1000;
      var numericDate = new Date(numeric);
      return Number.isNaN(numericDate.getTime()) ? null : numericDate.getTime();
    }
    var text = boundedText(value, 80);
    if (!text) return null;
    var spaceWeatherDate = text.match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2})(\d{2})\s+UTC$/i);
    if (spaceWeatherDate) {
      var month = MONTHS[spaceWeatherDate[2].toLowerCase()];
      if (month == null) return null;
      return Date.UTC(Number(spaceWeatherDate[1]), month, Number(spaceWeatherDate[3]),
        Number(spaceWeatherDate[4]), Number(spaceWeatherDate[5]));
    }
    if (/^\d{4}-\d\d-\d\d\s/.test(text)) text = text.replace(' ', 'T');
    if (/\sUTC$/i.test(text)) text = text.replace(/\sUTC$/i, 'Z');
    var date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }

  function longitudeColumn(value) {
    var longitude = finite(value);
    if (longitude == null || longitude < -180 || longitude > 360) return null;
    if (longitude < 0) longitude += 360;
    longitude = Math.round(longitude) % 360;
    return (longitude + 180) % 360;
  }

  function latitudeRow(value) {
    var latitude = finite(value);
    if (latitude == null || latitude < -90 || latitude > 90) return null;
    return AURORA_HEIGHT - 1 - Math.max(0, Math.min(AURORA_HEIGHT - 1, Math.round(latitude + 90)));
  }

  function normalizeAurora(payload) {
    if (!payload || payload.type !== 'MultiPoint' || !Array.isArray(payload.coordinates) ||
        payload.coordinates.length > MAX_COORDINATES) {
      throw new TypeError('Invalid NOAA SWPC Ovation payload');
    }
    var values = new Uint8Array(AURORA_WIDTH * AURORA_HEIGHT);
    var validCoordinates = 0;
    var activeCount = 0;
    var maxProbability = 0;
    payload.coordinates.forEach(function (coordinate) {
      if (!Array.isArray(coordinate) || coordinate.length < 3) return;
      var column = longitudeColumn(coordinate[0]);
      var row = latitudeRow(coordinate[1]);
      var probability = finite(coordinate[2]);
      if (column == null || row == null || probability == null || probability < 0 || probability > 100) return;
      validCoordinates += 1;
      var index = row * AURORA_WIDTH + column;
      var value = Math.round(probability);
      if (!values[index] && value > 0) activeCount += 1;
      if (value > values[index]) values[index] = value;
      if (value > maxProbability) maxProbability = value;
    });
    if (!validCoordinates) throw new TypeError('NOAA SWPC Ovation grid has no valid coordinates');
    return {
      width: AURORA_WIDTH,
      height: AURORA_HEIGHT,
      values: values,
      activeCount: activeCount,
      maxProbability: maxProbability,
      observationAt: parseTimestamp(payload['Observation Time'] || payload.observationTime),
      forecastAt: parseTimestamp(payload['Forecast Time'] || payload.forecastTime),
      validCoordinates: validCoordinates
    };
  }

  function alertExpiry(message) {
    var lines = String(message || '').split(/\r?\n/);
    for (var index = 0; index < lines.length; index += 1) {
      var match = lines[index].trim().match(/^(?:Now )?Valid (?:Until|To):\s*(.+)$/i);
      if (match) return parseTimestamp(match[1].trim());
    }
    return null;
  }

  function alertTitle(productId, message) {
    var lines = String(message || '').split(/\r?\n/).map(function (line) { return line.trim(); })
      .filter(Boolean);
    var headline = lines.find(function (line) {
      return /^(?:ALERT|WARNING|EXTENDED WARNING):/i.test(line);
    }) || lines[0] || productId;
    return boundedText(headline, MAX_TEXT);
  }

  function alertSeverity(productId, message) {
    var text = String(productId || '') + ' ' + String(message || '');
    var match = text.match(/\b([GSR])(\d)\b/i);
    var kpMatch = text.match(/\bK(\d\d)[AW]\b/i);
    if (!match && kpMatch) return 'G' + Math.max(0, Math.min(9, Number(kpMatch[1]) - 4));
    if (!match) return null;
    return match[1].toUpperCase() + match[2];
  }

  function normalizeAlerts(payload, now) {
    if (!Array.isArray(payload) || payload.length > 200) throw new TypeError('Invalid NOAA SWPC alerts payload');
    var current = Number(now == null ? Date.now() : now);
    var normalized = payload.map(function (item) {
      if (!item || typeof item !== 'object') return null;
      var productId = boundedText(item.product_id || item.productId, 40);
      var rawMessage = String(item.message == null ? '' : item.message);
      var message = boundedMessage(rawMessage, MAX_ALERT_MESSAGE);
      if (!productId || !message) return null;
      var issuedAt = parseTimestamp(item.issue_datetime || item.issueDatetime);
      var expiresAt = alertExpiry(message);
      if (expiresAt != null && expiresAt <= current) return null;
      return {
        productId: productId,
        issuedAt: issuedAt,
        expiresAt: expiresAt,
        title: alertTitle(productId, message),
        severity: alertSeverity(productId, message),
        message: message
      };
    }).filter(Boolean);
    normalized.sort(function (left, right) { return Number(right.issuedAt || 0) - Number(left.issuedAt || 0); });
    var byProduct = Object.create(null);
    normalized.forEach(function (item) {
      if (!byProduct[item.productId]) byProduct[item.productId] = item;
    });
    return Object.keys(byProduct).map(function (key) { return byProduct[key]; }).slice(0, MAX_ALERTS);
  }

  function normalizeKp(payload) {
    if (!Array.isArray(payload) || payload.length > 200) throw new TypeError('Invalid NOAA SWPC K-index payload');
    var rows = payload.map(function (item) {
      if (!item || typeof item !== 'object') return null;
      var time = parseTimestamp(item.time_tag || item.timeTag || item.time);
      var kp = finite(item.Kp != null ? item.Kp : item.kp);
      if (time == null || kp == null || kp < 0 || kp > 9) return null;
      return {
        time: time,
        kp: Math.round(kp * 100) / 100,
        aRunning: finite(item.a_running != null ? item.a_running : item.aRunning),
        stationCount: finite(item.station_count != null ? item.station_count : item.stationCount)
      };
    }).filter(Boolean);
    rows.sort(function (left, right) { return left.time - right.time; });
    var byTime = Object.create(null);
    rows.forEach(function (row) { byTime[row.time] = row; });
    return Object.keys(byTime).sort(function (left, right) { return Number(left) - Number(right); })
      .map(function (key) { return byTime[key]; }).slice(-MAX_KP_ROWS);
  }

  function freshness(timestamp, staleMs, now) {
    if (timestamp == null) return { state: 'unknown', ageMs: null };
    var current = Number(now == null ? Date.now() : now);
    var value = Number(timestamp);
    if (!Number.isFinite(value) || !Number.isFinite(current)) return { state: 'unknown', ageMs: null };
    var ageMs = Math.max(0, current - value);
    return { state: ageMs > staleMs ? 'stale' : 'fresh', ageMs: ageMs };
  }

  function auroraColor(value) {
    var strength = Math.max(0, Math.min(1, Number(value) / 100));
    if (!strength) return [0, 0, 0, 0];
    var red = Math.round(35 + strength * 185);
    var green = Math.round(225 - strength * 80);
    var blue = Math.round(155 + strength * 100);
    var alpha = Math.round(35 + strength * 200);
    return [red, green, blue, alpha];
  }

  function buildRaster(normalized) {
    if (!normalized || normalized.width !== AURORA_WIDTH || normalized.height !== AURORA_HEIGHT ||
        !normalized.values || normalized.values.length !== AURORA_WIDTH * AURORA_HEIGHT) {
      throw new TypeError('Aurora raster dimensions are invalid');
    }
    var pixels = new Uint8ClampedArray(normalized.values.length * 4);
    normalized.values.forEach(function (value, index) {
      var color = auroraColor(value);
      var offset = index * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    });
    return { width: AURORA_WIDTH, height: AURORA_HEIGHT, pixels: pixels };
  }

  function rasterDataUrl(normalized, documentObject) {
    if (!documentObject || typeof documentObject.createElement !== 'function') {
      throw new Error('document is unavailable for aurora raster');
    }
    var raster = buildRaster(normalized);
    var canvas = documentObject.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    var imageData = context.createImageData(raster.width, raster.height);
    imageData.data.set(raster.pixels);
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  function create(options) {
    options = options || {};
    var documentObject = options.document || root && root.document;
    var leaflet = options.L || root && root.L;
    var fetcher = options.fetch || root && root.fetch && root.fetch.bind(root);
    var getMap = options.getMap || function () { return null; };
    var isEnabled = options.isEnabled || function () { return true; };
    var isHidden = options.isDocumentHidden || function () { return false; };
    var translate = options.translate || function (key) { return key; };
    var localNumber = options.localNumber || function (value) { return String(value); };
    var setStatus = options.setStatus || function () {};
    var onStateChange = options.onStateChange || function () {};
    var renderRaster = options.renderRaster || function (value) { return rasterDataUrl(value, documentObject); };
    var setTimer = options.setTimeout || function (callback, delay) { return root.setTimeout(callback, delay); };
    var clearTimer = options.clearTimeout || function (timer) { return root.clearTimeout(timer); };
    var destroyed = false;
    var generation = 0;
    var requestAbort = null;
    var refreshTimer = null;
    var attributionAdded = false;
    var state = {
      status: 'off', layer: null, aurora: null, kp: [], alerts: [],
      updatedAt: null, lastGood: false, partial: false
    };

    function enabled() { return !destroyed && Boolean(isEnabled()); }

    function latestKp() { return state.kp.length ? state.kp[state.kp.length - 1] : null; }

    function latestUpdatedAt() {
      var values = [state.aurora && state.aurora.observationAt, latestKp() && latestKp().time,
        state.alerts.length && state.alerts[0].issuedAt];
      return values.filter(function (value) { return Number.isFinite(Number(value)); })
        .reduce(function (latest, value) { return Math.max(latest, Number(value)); }, 0) || null;
    }

    function hasData() { return Boolean(state.aurora || state.kp.length || state.alerts.length); }

    function snapshot() {
      var kp = latestKp();
      return {
        enabled: Boolean(state.layer), status: state.status,
        auroraCount: state.aurora ? state.aurora.activeCount : 0,
        auroraMaxProbability: state.aurora ? state.aurora.maxProbability : 0,
        auroraObservationAt: state.aurora ? state.aurora.observationAt : null,
        kp: kp ? kp.kp : null, kpTime: kp ? kp.time : null,
        alerts: state.alerts.map(function (item) {
          return { productId: item.productId, title: item.title, severity: item.severity,
            issuedAt: item.issuedAt, expiresAt: item.expiresAt };
        }),
        alertCount: state.alerts.length, updatedAt: state.updatedAt,
        lastGood: state.lastGood, partial: state.partial
      };
    }

    function renderStatus() {
      var kp = latestKp();
      var now = Date.now();
      var auroraFreshness = freshness(state.aurora && state.aurora.observationAt, AURORA_STALE_MS, now);
      var kpFreshness = freshness(kp && kp.time, KP_STALE_MS, now);
      var alertFreshness = freshness(state.alerts.length && state.alerts[0].issuedAt, ALERT_STALE_MS, now);
      var key;
      if (state.status === 'off') key = 'context.spaceWeatherOff';
      else if (state.status === 'loading') key = 'context.spaceWeatherLoading';
      else if (state.status === 'error') key = 'context.spaceWeatherUnavailable';
      else if (state.status === 'partial') key = 'context.spaceWeatherPartial';
      else if (!hasData()) key = 'context.spaceWeatherNone';
      else key = 'context.spaceWeatherStatus';
      var freshnessState = [auroraFreshness, kpFreshness, alertFreshness].some(function (item) {
        return item.state === 'stale';
      }) ? 'stale' : state.status;
      setStatus(translate(key, {
        aurora: localNumber(state.aurora ? state.aurora.activeCount : 0),
        kp: kp ? localNumber(kp.kp) : translate('context.spaceWeatherNoKp'),
        alerts: localNumber(state.alerts.length),
        freshness: translate('context.' + (freshnessState === 'stale' ? 'stale' : 'fresh'))
      }), state.status === 'error' || state.status === 'partial' ? 'error' : freshnessState);
      onStateChange(snapshot());
    }

    function removeLayer() {
      var map = getMap();
      if (state.layer && map && typeof map.removeLayer === 'function') map.removeLayer(state.layer);
      state.layer = null;
    }

    function addAttribution() {
      var map = getMap();
      if (!attributionAdded && map && map.attributionControl && typeof map.attributionControl.addAttribution === 'function') {
        map.attributionControl.addAttribution('<a href="' + OFFICIAL_URL + '" target="_blank" rel="noopener noreferrer">NOAA SWPC</a>');
        attributionAdded = true;
      }
    }

    function removeAttribution() {
      var map = getMap();
      if (attributionAdded && map && map.attributionControl && typeof map.attributionControl.removeAttribution === 'function') {
        map.attributionControl.removeAttribution('<a href="' + OFFICIAL_URL + '" target="_blank" rel="noopener noreferrer">NOAA SWPC</a>');
      }
      attributionAdded = false;
    }

    function createLayer(aurora) {
      var map = getMap();
      if (!map || !leaflet || typeof leaflet.imageOverlay !== 'function') throw new Error('Leaflet is unavailable');
      var layer = leaflet.imageOverlay(renderRaster(aurora), WORLD_BOUNDS, {
        pane: 'contextRasterPane', opacity: 0.5, interactive: false
      });
      return layer.addTo(map);
    }

    function scheduleRefresh() {
      clearTimer(refreshTimer);
      refreshTimer = null;
      if (enabled()) refreshTimer = setTimer(function () { refresh(); }, REFRESH_MS);
    }

    async function fetchJson(url, signal) {
      if (typeof fetcher !== 'function') throw new Error('fetch is unavailable');
      var response = await fetcher(url, { cache: 'no-store', signal: signal });
      if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status || 0));
      return response.json();
    }

    async function refresh() {
      if (!enabled() || isHidden()) return undefined;
      var AbortCtor = typeof AbortController === 'function' ? AbortController : root && root.AbortController;
      if (!AbortCtor) throw new Error('AbortController is unavailable');
      if (requestAbort) requestAbort.abort();
      requestAbort = new AbortCtor();
      var signal = requestAbort.signal;
      var token = ++generation;
      state.status = 'loading';
      renderStatus();
      var results = await Promise.allSettled([
        fetchJson(AURORA_URL, signal), fetchJson(KP_URL, signal), fetchJson(ALERTS_URL, signal)
      ]);
      if (signal.aborted || destroyed || token !== generation || !enabled()) return undefined;
      var failures = 0;
      var auroraResult = results[0];
      if (auroraResult.status === 'fulfilled') {
        try {
          var normalizedAurora = normalizeAurora(auroraResult.value);
          var nextLayer = createLayer(normalizedAurora);
          removeLayer();
          state.layer = nextLayer;
          state.aurora = normalizedAurora;
        } catch (error) { failures += 1; }
      } else failures += 1;
      var kpResult = results[1];
      if (kpResult.status === 'fulfilled') {
        try { state.kp = normalizeKp(kpResult.value); } catch (error) { failures += 1; }
      } else failures += 1;
      var alertResult = results[2];
      if (alertResult.status === 'fulfilled') {
        try { state.alerts = normalizeAlerts(alertResult.value, Date.now()); } catch (error) { failures += 1; }
      } else failures += 1;
      state.updatedAt = latestUpdatedAt();
      state.lastGood = hasData();
      state.partial = failures > 0;
      state.status = !hasData() ? (failures ? 'error' : 'none') : failures ? 'partial' : 'ready';
      if (hasData()) addAttribution();
      renderStatus();
      return snapshot();
    }

    function disable() {
      generation += 1;
      if (requestAbort) requestAbort.abort();
      requestAbort = null;
      clearTimer(refreshTimer);
      refreshTimer = null;
      removeLayer();
      removeAttribution();
      state.aurora = null;
      state.kp = [];
      state.alerts = [];
      state.updatedAt = null;
      state.lastGood = false;
      state.partial = false;
      state.status = 'off';
      renderStatus();
    }

    function destroy() {
      if (destroyed) return;
      disable();
      destroyed = true;
    }

    renderStatus();
    return Object.freeze({
      id: 'spaceWeather', refresh: refresh, disable: disable, destroy: destroy,
      renderStatus: renderStatus, getAbort: function () { return requestAbort; },
      getTimers: function () { return refreshTimer; }, getState: snapshot
    });
  }

  return Object.freeze({
    AURORA_URL: AURORA_URL, ALERTS_URL: ALERTS_URL, KP_URL: KP_URL, OFFICIAL_URL: OFFICIAL_URL,
    AURORA_WIDTH: AURORA_WIDTH, AURORA_HEIGHT: AURORA_HEIGHT, MAX_ALERTS: MAX_ALERTS,
    REFRESH_MS: REFRESH_MS, AURORA_STALE_MS: AURORA_STALE_MS, KP_STALE_MS: KP_STALE_MS,
    normalizeAurora: normalizeAurora, normalizeAlerts: normalizeAlerts, normalizeKp: normalizeKp,
    freshness: freshness, auroraColor: auroraColor, buildRaster: buildRaster,
    rasterDataUrl: rasterDataUrl, create: create
  });
});
