/* StormScope NWS alert adapter.
 * Browser global: window.StormScopeNwsAlerts
 * API contract: https://api.weather.gov/alerts/active (GeoJSON / CAP fields)
 */
'use strict';

(function (root) {
  var API_URL = 'https://api.weather.gov/alerts/active';
  var WEATHER_URL = 'https://www.weather.gov/';
  var MIN_REFRESH_MS = 30000;
  var MAX_BACKOFF_MS = 15 * 60 * 1000;
  var SEVERITY_ORDER = Object.freeze({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 });
  var URGENCY_ORDER = Object.freeze({ Immediate: 0, Expected: 1, Future: 2, Past: 3, Unknown: 4 });
  var CERTAINTY_ORDER = Object.freeze({ Observed: 0, Likely: 1, Possible: 2, Unlikely: 3, Unknown: 4 });

  function finiteNumber(value, label) {
    var number = Number(value);
    if (!isFinite(number)) throw new TypeError(label + ' must be a finite number');
    return number;
  }

  function pointValue(latitude, longitude) {
    var lat = finiteNumber(latitude, 'latitude');
    var lon = finiteNumber(longitude, 'longitude');
    if (lat < -90 || lat > 90) throw new RangeError('latitude must be between -90 and 90');
    if (lon < -180 || lon > 180) throw new RangeError('longitude must be between -180 and 180');
    return lat.toFixed(4) + ',' + lon.toFixed(4);
  }

  function appendList(search, name, value) {
    if (value == null || value === '') return;
    var values = Array.isArray(value) ? value : [value];
    var cleaned = values.map(function (item) { return String(item).trim().toLowerCase(); }).filter(Boolean);
    if (cleaned.length) search.set(name, cleaned.join(','));
  }

  function appendFilters(search, options) {
    var filters = options || {};
    appendList(search, 'status', filters.status || 'actual');
    appendList(search, 'message_type', filters.messageTypes);
    appendList(search, 'event', filters.events);
    appendList(search, 'severity', filters.severities);
    appendList(search, 'urgency', filters.urgencies);
    appendList(search, 'certainty', filters.certainties);
  }

  function buildPointQuery(latitude, longitude, options) {
    var url = new URL(API_URL);
    url.searchParams.set('point', pointValue(latitude, longitude));
    appendFilters(url.searchParams, options);
    return url.toString();
  }

  function normalizeBounds(bounds) {
    if (!bounds) throw new TypeError('bounds are required');
    var south = finiteNumber(typeof bounds.getSouth === 'function' ? bounds.getSouth() : bounds.south, 'south');
    var west = finiteNumber(typeof bounds.getWest === 'function' ? bounds.getWest() : bounds.west, 'west');
    var north = finiteNumber(typeof bounds.getNorth === 'function' ? bounds.getNorth() : bounds.north, 'north');
    var east = finiteNumber(typeof bounds.getEast === 'function' ? bounds.getEast() : bounds.east, 'east');
    if (south < -90 || north > 90 || south > north) throw new RangeError('invalid latitude bounds');
    if (west < -180 || west > 180 || east < -180 || east > 180) throw new RangeError('invalid longitude bounds');
    return Object.freeze({ south: south, west: west, north: north, east: east });
  }

  function buildViewportQuery(bounds, options) {
    var url = new URL(API_URL);
    var normalized = normalizeBounds(bounds);
    // The NWS API has no bbox parameter. Fetch active land alerts once, then
    // use filterToViewport() on returned GeoJSON instead of issuing a point grid.
    url.searchParams.set('region_type', 'land');
    appendFilters(url.searchParams, options);
    return Object.freeze({
      url: url.toString(),
      bounds: normalized,
      requiresClientFilter: true
    });
  }

  function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function canonical(value, allowed) {
    var input = cleanString(value).toLowerCase();
    for (var index = 0; index < allowed.length; index += 1) {
      if (allowed[index].toLowerCase() === input) return allowed[index];
    }
    return 'Unknown';
  }

  function timestamp(value) {
    var text = cleanString(value);
    if (!text) return { iso: null, ms: null };
    var milliseconds = Date.parse(text);
    if (!isFinite(milliseconds)) return { iso: null, ms: null };
    return { iso: new Date(milliseconds).toISOString(), ms: milliseconds };
  }

  function trustedWeatherUrl(value) {
    var text = cleanString(value);
    if (!text) return null;
    try {
      var url = new URL(text);
      var hostname = url.hostname.toLowerCase();
      if (hostname !== 'weather.gov' && !hostname.endsWith('.weather.gov')) return null;
      url.protocol = 'https:';
      url.username = '';
      url.password = '';
      return url.toString();
    } catch (error) {
      return null;
    }
  }

  function firstParameter(parameters, name) {
    var values = parameters && parameters[name];
    if (!Array.isArray(values) || !values.length) return '';
    return cleanString(values[0]);
  }

  function vtecSeries(parameters) {
    var vtec = firstParameter(parameters, 'VTEC');
    if (!vtec) return '';
    var match = vtec.match(/^\/[A-Z]\.[A-Z]{3}\.([A-Z0-9]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./i);
    return match ? [match[1], match[2], match[3], match[4]].join('.').toUpperCase() : '';
  }

  function alertKind(eventName) {
    var event = cleanString(eventName);
    if (/\bwarning\b/i.test(event)) return 'warning';
    if (/\bwatch\b/i.test(event)) return 'watch';
    if (/\badvisory\b/i.test(event)) return 'advisory';
    return 'statement';
  }

  function normalizeAlert(feature) {
    if (!feature || typeof feature !== 'object') return null;
    var properties = feature.properties && typeof feature.properties === 'object' ? feature.properties : feature;
    var id = cleanString(properties.id || properties['@id'] || feature.id);
    if (!id) return null;

    var sent = timestamp(properties.sent);
    var effective = timestamp(properties.effective);
    var onset = timestamp(properties.onset);
    var expires = timestamp(properties.expires);
    var ends = timestamp(properties.ends || firstParameter(properties.parameters, 'eventEndingTime'));
    var apiUrl = trustedWeatherUrl(properties['@id']) || trustedWeatherUrl(feature.id) || trustedWeatherUrl(id);
    var weatherUrl = trustedWeatherUrl(properties.web) || WEATHER_URL;
    var sourceUrl = apiUrl || weatherUrl;
    var severity = canonical(properties.severity, ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']);
    var urgency = canonical(properties.urgency, ['Immediate', 'Expected', 'Future', 'Past', 'Unknown']);
    var certainty = canonical(properties.certainty, ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']);
    var status = canonical(properties.status, ['Actual', 'Exercise', 'System', 'Test', 'Draft', 'Unknown']);
    var messageType = canonical(properties.messageType, ['Alert', 'Update', 'Cancel', 'Ack', 'Error', 'Unknown']);
    var series = vtecSeries(properties.parameters);

    return Object.freeze({
      id: id,
      dedupeKey: series ? 'vtec:' + series : 'id:' + id,
      apiUrl: apiUrl,
      sourceUrl: sourceUrl,
      weatherUrl: weatherUrl,
      event: cleanString(properties.event),
      kind: alertKind(properties.event),
      headline: cleanString(properties.headline) || cleanString(properties.event),
      description: cleanString(properties.description),
      instruction: cleanString(properties.instruction),
      areaDescription: cleanString(properties.areaDesc),
      senderName: cleanString(properties.senderName),
      response: cleanString(properties.response),
      status: status,
      messageType: messageType,
      severity: severity,
      severityRank: SEVERITY_ORDER[severity],
      urgency: urgency,
      urgencyRank: URGENCY_ORDER[urgency],
      certainty: certainty,
      certaintyRank: CERTAINTY_ORDER[certainty],
      sent: sent.iso,
      sentMs: sent.ms,
      effective: effective.iso,
      effectiveMs: effective.ms,
      onset: onset.iso,
      onsetMs: onset.ms,
      expires: expires.iso,
      expiresMs: expires.ms,
      ends: ends.iso,
      endsMs: ends.ms,
      affectedZones: Array.isArray(properties.affectedZones) ? properties.affectedZones.slice() : [],
      geometry: feature.geometry || properties.geometry || null,
      references: Array.isArray(properties.references) ? properties.references.slice() : [],
      parameters: properties.parameters && typeof properties.parameters === 'object' ? properties.parameters : {},
      vtecSeries: series
    });
  }

  function newerAlert(left, right) {
    var leftTime = left.sentMs == null ? (left.effectiveMs || 0) : left.sentMs;
    var rightTime = right.sentMs == null ? (right.effectiveMs || 0) : right.sentMs;
    if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
    if (left.messageType === 'Cancel' && right.messageType !== 'Cancel') return left;
    if (right.messageType === 'Cancel' && left.messageType !== 'Cancel') return right;
    return left.id > right.id ? left : right;
  }

  function dedupeAlerts(alerts) {
    var byKey = Object.create(null);
    (alerts || []).forEach(function (alert) {
      if (!alert || !alert.dedupeKey) return;
      byKey[alert.dedupeKey] = byKey[alert.dedupeKey] ? newerAlert(byKey[alert.dedupeKey], alert) : alert;
    });
    return Object.keys(byKey).map(function (key) { return byKey[key]; });
  }

  function isExpired(alert, now) {
    var nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
    if (!isFinite(nowMs)) throw new TypeError('now must be a Date or epoch milliseconds');
    return alert.messageType === 'Cancel' || alert.urgency === 'Past' ||
      (alert.expiresMs != null && alert.expiresMs <= nowMs);
  }

  function compareAlerts(left, right) {
    return left.severityRank - right.severityRank ||
      left.urgencyRank - right.urgencyRank ||
      left.certaintyRank - right.certaintyRank ||
      (right.sentMs || 0) - (left.sentMs || 0) ||
      left.event.localeCompare(right.event);
  }

  function filterAlerts(alerts, filters) {
    var options = filters || {};
    var now = options.now == null ? Date.now() : options.now;
    var severitySet = options.severities ? new Set(options.severities.map(function (value) { return canonical(value, Object.keys(SEVERITY_ORDER)); })) : null;
    var urgencySet = options.urgencies ? new Set(options.urgencies.map(function (value) { return canonical(value, Object.keys(URGENCY_ORDER)); })) : null;
    var kindSet = options.kinds ? new Set(options.kinds.map(function (value) { return String(value).toLowerCase(); })) : null;
    var minimumRank = options.minimumSeverity ? SEVERITY_ORDER[canonical(options.minimumSeverity, Object.keys(SEVERITY_ORDER))] : null;
    return (alerts || []).filter(function (alert) {
      if (!alert) return false;
      if (!options.includeExpired && isExpired(alert, now)) return false;
      if (!options.includeNonActual && alert.status !== 'Actual') return false;
      if (severitySet && !severitySet.has(alert.severity)) return false;
      if (urgencySet && !urgencySet.has(alert.urgency)) return false;
      if (kindSet && !kindSet.has(alert.kind)) return false;
      if (minimumRank != null && alert.severityRank > minimumRank) return false;
      return true;
    }).sort(compareAlerts);
  }

  function geometryBounds(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return null;
    var result = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
    function visit(value) {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
        result.west = Math.min(result.west, value[0]);
        result.east = Math.max(result.east, value[0]);
        result.south = Math.min(result.south, value[1]);
        result.north = Math.max(result.north, value[1]);
        return;
      }
      value.forEach(visit);
    }
    visit(geometry.coordinates);
    return isFinite(result.south) ? result : null;
  }

  function longitudeIntersects(leftWest, leftEast, rightWest, rightEast) {
    function intervals(west, east) {
      return west <= east ? [[west, east]] : [[west, 180], [-180, east]];
    }
    return intervals(leftWest, leftEast).some(function (left) {
      return intervals(rightWest, rightEast).some(function (right) {
        return left[0] <= right[1] && left[1] >= right[0];
      });
    });
  }

  function filterToViewport(alerts, bounds, options) {
    var viewport = normalizeBounds(bounds);
    var includeWithoutGeometry = options && options.includeWithoutGeometry;
    return (alerts || []).filter(function (alert) {
      var alertBounds = geometryBounds(alert && alert.geometry);
      if (!alertBounds) return Boolean(includeWithoutGeometry);
      return alertBounds.south <= viewport.north && alertBounds.north >= viewport.south &&
        longitudeIntersects(alertBounds.west, alertBounds.east, viewport.west, viewport.east);
    });
  }

  function normalizeCollection(payload, options) {
    var features = payload && Array.isArray(payload.features) ? payload.features : [];
    var normalized = features.map(normalizeAlert).filter(Boolean);
    var unique = dedupeAlerts(normalized);
    if (options && options.bounds) unique = filterToViewport(unique, options.bounds, options);
    return filterAlerts(unique, options);
  }

  function parseRetryAfter(value, nowMs) {
    var text = cleanString(value);
    if (!text) return 0;
    if (/^\d+$/.test(text)) return Number(text) * 1000;
    var date = Date.parse(text);
    return isFinite(date) ? Math.max(0, date - nowMs) : 0;
  }

  function shouldRetryStatus(status) {
    return status == null || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function nextRetryMetadata(previous, failure, options) {
    var settings = options || {};
    var nowMs = settings.now == null ? Date.now() : Number(settings.now);
    var attempt = ((previous && previous.attempt) || 0) + 1;
    var status = failure && failure.status != null ? Number(failure.status) : null;
    var retryable = shouldRetryStatus(status);
    var retryAfter = parseRetryAfter(failure && failure.retryAfter, nowMs);
    var exponential = Math.min(settings.maxMs || MAX_BACKOFF_MS, (settings.baseMs || MIN_REFRESH_MS) * Math.pow(2, attempt - 1));
    var random = typeof settings.random === 'function' ? settings.random() : Math.random();
    var jitterRatio = settings.jitterRatio == null ? 0.2 : Number(settings.jitterRatio);
    var jittered = Math.round(exponential * (1 - jitterRatio + (2 * jitterRatio * random)));
    var delayMs = retryable ? Math.max(MIN_REFRESH_MS, retryAfter, jittered) : null;
    return Object.freeze({
      attempt: attempt,
      retryable: retryable,
      status: status,
      delayMs: delayMs,
      nextRetryAt: delayMs == null ? null : new Date(nowMs + delayMs).toISOString(),
      lastError: cleanString(failure && (failure.message || failure.title)) || 'NWS alert request failed'
    });
  }

  function successMetadata(now) {
    var nowMs = now == null ? Date.now() : Number(now);
    return Object.freeze({
      attempt: 0,
      retryable: true,
      status: 200,
      delayMs: MIN_REFRESH_MS,
      nextRetryAt: new Date(nowMs + MIN_REFRESH_MS).toISOString(),
      lastError: null
    });
  }

  root.StormScopeNwsAlerts = Object.freeze({
    API_URL: API_URL,
    MIN_REFRESH_MS: MIN_REFRESH_MS,
    SEVERITY_ORDER: SEVERITY_ORDER,
    buildPointQuery: buildPointQuery,
    buildViewportQuery: buildViewportQuery,
    normalizeBounds: normalizeBounds,
    normalizeAlert: normalizeAlert,
    normalizeCollection: normalizeCollection,
    dedupeAlerts: dedupeAlerts,
    isExpired: isExpired,
    compareAlerts: compareAlerts,
    filterAlerts: filterAlerts,
    geometryBounds: geometryBounds,
    filterToViewport: filterToViewport,
    parseRetryAfter: parseRetryAfter,
    shouldRetryStatus: shouldRetryStatus,
    nextRetryMetadata: nextRetryMetadata,
    successMetadata: successMetadata
  });
})(typeof self !== 'undefined' ? self : window);
