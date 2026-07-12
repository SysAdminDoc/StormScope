(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeRadarProviders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Primary contracts:
  // https://www.rainviewer.com/api/weather-maps-api.html
  // https://www.rainviewer.com/api/transition-faq.html
  // https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer
  // https://mapservices.weather.noaa.gov/eventdriven/services/radar/radar_base_reflectivity_time/ImageServer/WMSServer?service=WMS&request=GetCapabilities&version=1.3.0

  var MINUTE_MS = 60000;
  var NOAA_SUBSETS = Object.freeze(['ALASKA', 'CARIB', 'CONUS', 'GUAM', 'HAWAII']);
  var RAINVIEWER_ID = 'rainviewer';
  var NOAA_ID = 'noaa-mrms';
  var NOAA_SERVICE_URL = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer';
  var NOAA_WMS_URL = 'https://mapservices.weather.noaa.gov/eventdriven/services/radar/radar_base_reflectivity_time/ImageServer/WMSServer';
  var NOAA_QUERY_FIELDS = 'objectid,idp_subset,idp_validtime,idp_validendtime,idp_filedate,idp_ingestdate';
  var NOAA_QUERY_URL = NOAA_SERVICE_URL + '/query?where=1%3D1' +
    '&outFields=' + encodeURIComponent(NOAA_QUERY_FIELDS) +
    '&returnGeometry=false&orderByFields=idp_filedate%20ASC' +
    '&resultRecordCount=1000&f=pjson';

  var HEALTH = Object.freeze({
    HEALTHY: 'healthy',
    DEGRADED: 'degraded',
    UNAVAILABLE: 'unavailable'
  });

  var RADAR_STATE = Object.freeze({
    AVAILABLE: 'available',
    PRECIPITATION: 'precipitation',
    CLEAR: 'clear',
    NO_COVERAGE: 'no-coverage',
    STALE: 'stale',
    FAILURE: 'failure'
  });

  var PROVIDERS = deepFreeze({
    rainviewer: {
      id: RAINVIEWER_ID,
      label: 'RainViewer',
      role: 'primary',
      priority: 0,
      discovery: {
        kind: 'json-timeline',
        url: 'https://api.rainviewer.com/public/weather-maps.json',
        method: 'GET',
        cors: true
      },
      tile: {
        kind: 'xyz',
        template: '{host}{framePath}/256/{z}/{x}/{y}/2/1_1.png',
        size: 256,
        colorScheme: 2,
        colorSchemeLabel: 'Universal Blue',
        maxNativeZoom: 7,
        crossOrigin: 'anonymous'
      },
      attribution: {
        text: 'RainViewer',
        url: 'https://www.rainviewer.com/',
        required: true
      },
      coverage: {
        kind: 'xyz-mask',
        template: '{host}/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png',
        interpretation: 'Transparent pixels are covered; black pixels are outside coverage.',
        maxNativeZoom: 7
      },
      history: {
        kind: 'past-only',
        windowMinutes: 120,
        nominalStepMinutes: 10,
        supportsFuture: false
      },
      resolution: {
        maxNativeZoom: 7,
        label: 'Public tile pyramid through zoom 7'
      },
      freshness: {
        expectedUpdateMinutes: 10,
        staleAfterMinutes: 20,
        failAfterMinutes: 40
      }
    },
    'noaa-mrms': {
      id: NOAA_ID,
      label: 'NOAA/NWS MRMS',
      role: 'fallback',
      priority: 1,
      discovery: {
        kind: 'arcgis-image-service',
        serviceUrl: NOAA_SERVICE_URL + '?f=pjson',
        framesUrl: NOAA_QUERY_URL,
        method: 'GET',
        cors: true,
        timeField: 'idp_validtime',
        subsetField: 'idp_subset'
      },
      tile: {
        kind: 'wms',
        endpoint: NOAA_WMS_URL,
        layer: 'radar_base_reflectivity_time',
        version: '1.3.0',
        crs: 'EPSG:3857',
        format: 'image/png',
        transparent: true,
        tileSize: 256,
        crossOrigin: 'anonymous'
      },
      attribution: {
        text: 'NOAA/NWS MRMS',
        url: 'https://radar.weather.gov/',
        required: true
      },
      coverage: {
        kind: 'service-extent-and-subsets',
        subsets: NOAA_SUBSETS,
        regions: ['Continental United States', 'Alaska', 'Caribbean', 'Guam', 'Hawaii'],
        exactPointCoverage: false,
        extentSource: NOAA_SERVICE_URL + '?f=pjson'
      },
      history: {
        kind: 'time-enabled-past',
        advertisedWindowMinutes: 240,
        windowFromDiscovery: true,
        advertisedUpdateMinutes: 5,
        supportsFuture: false
      },
      resolution: {
        nominalKilometers: 1,
        label: 'Quality-controlled 1 km composite'
      },
      freshness: {
        expectedUpdateMinutes: 10,
        staleAfterMinutes: 20,
        failAfterMinutes: 40
      }
    }
  });

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function epochMilliseconds(value) {
    if (!finiteNumber(value)) return null;
    return value < 100000000000 ? value * 1000 : value;
  }

  function hostMatchesSuffix(hostname, suffix) {
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }

  function trustedHttpsOrigin(value, suffix) {
    try {
      var parsed = new URL(value);
      var hostname = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || !hostMatchesSuffix(hostname, suffix)) return '';
      return parsed.origin;
    } catch (error) {
      return '';
    }
  }

  function createRollingRequestBudget(options) {
    options = options || {};
    var limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 90;
    var windowMs = Number.isInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : MINUTE_MS;
    var timestamps = [];
    var rateLimitedUntil = null;

    function prune(now) {
      while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
      if (rateLimitedUntil !== null && rateLimitedUntil <= now) rateLimitedUntil = null;
    }

    function snapshot(now) {
      now = finiteNumber(now) ? now : Date.now();
      prune(now);
      return {
        limit: limit,
        windowMs: windowMs,
        used: timestamps.length,
        remaining: Math.max(0, limit - timestamps.length),
        rateLimitedUntil: rateLimitedUntil
      };
    }

    function consume(count, now) {
      count = count == null ? 1 : count;
      now = finiteNumber(now) ? now : Date.now();
      if (!Number.isInteger(count) || count < 1) throw new RangeError('request count must be a positive integer');
      prune(now);
      if (rateLimitedUntil !== null || timestamps.length + count > limit) {
        rateLimitedUntil = timestamps.length ? timestamps[0] + windowMs : now + windowMs;
        return false;
      }
      for (var index = 0; index < count; index += 1) timestamps.push(now);
      return true;
    }

    return Object.freeze({ consume: consume, snapshot: snapshot });
  }

  function parseRainViewerDiscovery(payload, discoveredAt) {
    if (!payload || typeof payload !== 'object') throw new TypeError('RainViewer discovery payload must be an object.');
    var tileHost = trustedHttpsOrigin(payload.host, 'rainviewer.com');
    if (!tileHost) throw new Error('RainViewer returned an untrusted tile host.');

    var sourceFrames = payload.radar && Array.isArray(payload.radar.past) ? payload.radar.past : [];
    var byTime = Object.create(null);
    sourceFrames.forEach(function (frame) {
      if (!frame || !finiteNumber(frame.time) || typeof frame.path !== 'string') return;
      if (!/^\/v2\/radar\/[A-Za-z0-9_-]+$/.test(frame.path)) return;
      var timeMs = frame.time * 1000;
      byTime[timeMs] = {
        id: RAINVIEWER_ID + ':' + frame.time,
        providerId: RAINVIEWER_ID,
        time: timeMs,
        path: frame.path,
        tileHost: tileHost,
        coverageSubsets: null,
        coverageComplete: null
      };
    });

    var frames = Object.keys(byTime).map(function (key) { return byTime[key]; });
    frames.sort(function (left, right) { return left.time - right.time; });
    return {
      providerId: RAINVIEWER_ID,
      discoveredAt: epochMilliseconds(discoveredAt) || Date.now(),
      generatedAt: epochMilliseconds(payload.generated),
      tileHost: tileHost,
      frames: frames,
      latestFrame: frames.length ? frames[frames.length - 1] : null,
      coverage: PROVIDERS.rainviewer.coverage
    };
  }

  function assertTileCoordinate(name, value) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(name + ' must be a non-negative integer.');
  }

  function buildRainViewerTileUrl(frame, z, x, y, options) {
    options = options || {};
    if (!frame || frame.providerId !== RAINVIEWER_ID || typeof frame.path !== 'string') {
      throw new TypeError('A normalized RainViewer frame is required.');
    }
    assertTileCoordinate('z', z);
    assertTileCoordinate('x', x);
    assertTileCoordinate('y', y);
    if (z > PROVIDERS.rainviewer.tile.maxNativeZoom) throw new RangeError('RainViewer native zoom cannot exceed 7.');
    var host = trustedHttpsOrigin(frame.tileHost, 'rainviewer.com');
    if (!host) throw new Error('RainViewer frame has an untrusted tile host.');
    var size = options.size === 512 ? 512 : 256;
    var smooth = options.smooth === false ? 0 : 1;
    var snow = options.snow === false ? 0 : 1;
    return host + frame.path + '/' + size + '/' + z + '/' + x + '/' + y + '/2/' + smooth + '_' + snow + '.png';
  }

  function buildRainViewerCoverageUrl(tileHost, z, x, y, options) {
    options = options || {};
    assertTileCoordinate('z', z);
    assertTileCoordinate('x', x);
    assertTileCoordinate('y', y);
    if (z > PROVIDERS.rainviewer.coverage.maxNativeZoom) throw new RangeError('RainViewer coverage zoom cannot exceed 7.');
    var host = trustedHttpsOrigin(tileHost, 'rainviewer.com');
    if (!host) throw new Error('RainViewer coverage host is not trusted.');
    var size = options.size === 512 ? 512 : 256;
    return host + '/v2/coverage/0/' + size + '/' + z + '/' + x + '/' + y + '/0/0_0.png';
  }

  function normalizeNoaaRecord(feature) {
    var attributes = feature && feature.attributes;
    if (!attributes || NOAA_SUBSETS.indexOf(attributes.idp_subset) === -1) return null;
    var validTime = epochMilliseconds(attributes.idp_validtime);
    var validEndTime = epochMilliseconds(attributes.idp_validendtime);
    var fileDate = epochMilliseconds(attributes.idp_filedate);
    var ingestDate = epochMilliseconds(attributes.idp_ingestdate);
    if (validTime === null || fileDate === null) return null;
    return {
      objectId: attributes.objectid,
      subset: attributes.idp_subset,
      validTime: validTime,
      validEndTime: validEndTime,
      fileDate: fileDate,
      ingestDate: ingestDate
    };
  }

  function groupNoaaRecords(records) {
    var groups = [];
    records.sort(function (left, right) { return left.fileDate - right.fileDate; });
    records.forEach(function (record) {
      var group = groups.length ? groups[groups.length - 1] : null;
      if (!group || record.fileDate - group.firstFileDate > 90 * 1000) {
        group = { firstFileDate: record.fileDate, lastFileDate: record.fileDate, records: Object.create(null) };
        groups.push(group);
      }
      var prior = group.records[record.subset];
      if (!prior || (record.ingestDate || 0) >= (prior.ingestDate || 0)) group.records[record.subset] = record;
      group.lastFileDate = Math.max(group.lastFileDate, record.fileDate);
    });
    return groups;
  }

  function noaaFrameFromGroup(group) {
    var records = Object.keys(group.records).map(function (key) { return group.records[key]; });
    var subsets = records.map(function (record) { return record.subset; }).sort();
    var timeMs = Math.max.apply(Math, records.map(function (record) { return record.validTime; }));
    var commonTime = records.every(function (record) {
      return record.validTime <= timeMs && finiteNumber(record.validEndTime) && record.validEndTime >= timeMs;
    }) ? timeMs : null;
    return {
      id: NOAA_ID + ':' + group.firstFileDate,
      providerId: NOAA_ID,
      time: timeMs,
      generatedAt: group.lastFileDate,
      wmsTime: commonTime,
      coverageSubsets: subsets,
      coverageComplete: NOAA_SUBSETS.every(function (subset) { return subsets.indexOf(subset) !== -1; })
    };
  }

  function parseNoaaDiscovery(servicePayload, queryPayload, discoveredAt) {
    if (!servicePayload || typeof servicePayload !== 'object') throw new TypeError('NOAA service metadata must be an object.');
    if (!queryPayload || !Array.isArray(queryPayload.features)) throw new TypeError('NOAA frame query must contain features.');

    var records = queryPayload.features.map(normalizeNoaaRecord).filter(Boolean);
    var frames = groupNoaaRecords(records).map(noaaFrameFromGroup);
    frames.sort(function (left, right) { return left.time - right.time; });
    frames.forEach(function (frame, index) { frame.isLatest = index === frames.length - 1; });

    var serviceExtent = servicePayload.fullExtent || servicePayload.extent || null;
    var timeExtent = servicePayload.timeInfo && Array.isArray(servicePayload.timeInfo.timeExtent)
      ? servicePayload.timeInfo.timeExtent.map(epochMilliseconds)
      : null;
    var availableHistoryMinutes = timeExtent && timeExtent.every(finiteNumber)
      ? Math.max(0, Math.round((timeExtent[1] - timeExtent[0]) / MINUTE_MS))
      : null;
    return {
      providerId: NOAA_ID,
      discoveredAt: epochMilliseconds(discoveredAt) || Date.now(),
      serviceExtent: serviceExtent,
      serviceTimeExtent: timeExtent,
      availableHistoryMinutes: availableHistoryMinutes,
      frames: frames,
      latestFrame: frames.length ? frames[frames.length - 1] : null,
      coverage: {
        kind: PROVIDERS[NOAA_ID].coverage.kind,
        subsets: PROVIDERS[NOAA_ID].coverage.subsets,
        serviceExtent: serviceExtent,
        exactPointCoverage: false
      }
    };
  }

  function noaaWmsParameters(frame, options) {
    options = options || {};
    var parameters = {
      service: 'WMS',
      request: 'GetMap',
      version: PROVIDERS[NOAA_ID].tile.version,
      layers: PROVIDERS[NOAA_ID].tile.layer,
      styles: '',
      format: PROVIDERS[NOAA_ID].tile.format,
      transparent: 'true',
      crs: PROVIDERS[NOAA_ID].tile.crs
    };
    var requestedTime = epochMilliseconds(options.time);
    if (requestedTime === null && frame && !frame.isLatest) requestedTime = epochMilliseconds(frame.wmsTime);
    if (requestedTime !== null) parameters.time = new Date(requestedTime).toISOString();
    return parameters;
  }

  function buildNoaaWmsUrl(frame, bbox, width, height, options) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(finiteNumber)) {
      throw new TypeError('NOAA WMS bbox must contain four finite EPSG:3857 coordinates.');
    }
    width = width || 256;
    height = height || 256;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
      throw new RangeError('NOAA WMS image dimensions must be integers from 1 through 4096.');
    }
    var parameters = noaaWmsParameters(frame, options);
    parameters.bbox = bbox.join(',');
    parameters.width = String(width);
    parameters.height = String(height);
    var query = Object.keys(parameters).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(parameters[key]);
    }).join('&');
    return NOAA_WMS_URL + '?' + query;
  }

  function getFrameAge(frame, providerId, now) {
    var timeMs = epochMilliseconds(frame && frame.time !== undefined ? frame.time : frame);
    var nowMs = epochMilliseconds(now) || Date.now();
    var provider = PROVIDERS[providerId || (frame && frame.providerId)];
    if (timeMs === null || !provider) {
      return { known: false, ageMs: null, ageMinutes: null, stale: true, failed: true, label: 'age unknown' };
    }
    var rawAge = nowMs - timeMs;
    var ageMs = Math.max(0, rawAge);
    var ageMinutes = Math.floor(ageMs / MINUTE_MS);
    return {
      known: true,
      ageMs: ageMs,
      ageMinutes: ageMinutes,
      futureSkew: rawAge < -2 * MINUTE_MS,
      stale: ageMs >= provider.freshness.staleAfterMinutes * MINUTE_MS,
      failed: ageMs >= provider.freshness.failAfterMinutes * MINUTE_MS,
      label: formatAge(ageMs)
    };
  }

  function formatAge(ageMs) {
    var minutes = Math.floor(Math.max(0, ageMs) / MINUTE_MS);
    if (minutes < 1) return 'less than a minute old';
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute old' : ' minutes old');
    var hours = Math.floor(minutes / 60);
    var remainder = minutes % 60;
    return hours + (hours === 1 ? ' hour' : ' hours') + (remainder ? ' ' + remainder + ' min old' : ' old');
  }

  function assessProviderHealth(providerId, observation, now) {
    observation = observation || {};
    var provider = PROVIDERS[providerId];
    if (!provider) throw new Error('Unknown radar provider: ' + providerId);
    var nowMs = epochMilliseconds(now) || Date.now();
    var age = getFrameAge(observation.latestFrame || observation.latestFrameTime, providerId, nowMs);
    var rateLimitedUntil = epochMilliseconds(observation.rateLimitedUntil);
    var failures = Number.isInteger(observation.consecutiveFailures) ? observation.consecutiveFailures : 0;
    var status = HEALTH.HEALTHY;
    var reason = null;

    if (rateLimitedUntil !== null && rateLimitedUntil > nowMs) {
      status = age.known && !age.failed ? HEALTH.DEGRADED : HEALTH.UNAVAILABLE;
      reason = 'rate-limited';
    } else if (observation.error && (!age.known || age.failed)) {
      status = HEALTH.UNAVAILABLE;
      reason = 'request-failed';
    } else if (!age.known || age.failed) {
      status = HEALTH.UNAVAILABLE;
      reason = age.known ? 'frame-expired' : 'no-successful-frame';
    } else if (age.stale) {
      status = HEALTH.DEGRADED;
      reason = 'stale-frame';
    } else if (observation.latestFrame && observation.latestFrame.coverageComplete === false) {
      status = HEALTH.DEGRADED;
      reason = 'partial-coverage';
    } else if (observation.error || failures > 0) {
      status = HEALTH.DEGRADED;
      reason = 'using-last-success';
    }

    return {
      providerId: providerId,
      status: status,
      reason: reason,
      latestFrameAge: age,
      lastSuccessAt: epochMilliseconds(observation.lastSuccessAt),
      rateLimitedUntil: rateLimitedUntil,
      consecutiveFailures: failures,
      checkedAt: nowMs
    };
  }

  function coverageUnavailable(value) {
    return value === false || value === 'none' || value === RADAR_STATE.NO_COVERAGE;
  }

  function selectProvider(healthByProvider, options) {
    healthByProvider = healthByProvider || {};
    options = options || {};
    var order = Array.isArray(options.order) ? options.order : [RAINVIEWER_ID, NOAA_ID];
    var coverage = options.coverageByProvider || {};
    var candidates = [];
    order.forEach(function (providerId) {
      var provider = PROVIDERS[providerId];
      var health = healthByProvider[providerId];
      if (!provider || !health || coverageUnavailable(coverage[providerId])) return;
      if (health.status === HEALTH.HEALTHY || (options.allowDegraded !== false && health.status === HEALTH.DEGRADED)) {
        candidates.push({ provider: provider, health: health });
      }
    });

    if (!candidates.length) {
      var anyCoverage = order.some(function (providerId) { return !coverageUnavailable(coverage[providerId]); });
      return {
        selectedProviderId: null,
        provider: null,
        primaryProviderId: RAINVIEWER_ID,
        role: null,
        isFallback: false,
        state: anyCoverage ? RADAR_STATE.FAILURE : RADAR_STATE.NO_COVERAGE,
        degradationReason: anyCoverage ? 'all-providers-unavailable' : 'outside-provider-coverage'
      };
    }

    candidates.sort(function (left, right) {
      var healthDelta = (left.health.status === HEALTH.HEALTHY ? 0 : 1) - (right.health.status === HEALTH.HEALTHY ? 0 : 1);
      return healthDelta || left.provider.priority - right.provider.priority;
    });
    var selected = candidates[0];
    var fallback = selected.provider.id !== RAINVIEWER_ID;
    var primaryHealth = healthByProvider[RAINVIEWER_ID];
    return {
      selectedProviderId: selected.provider.id,
      provider: selected.provider,
      primaryProviderId: RAINVIEWER_ID,
      role: fallback ? 'fallback' : 'primary',
      isFallback: fallback,
      state: selected.health.reason === 'stale-frame' ? RADAR_STATE.STALE : RADAR_STATE.AVAILABLE,
      degraded: selected.health.status === HEALTH.DEGRADED,
      degradationReason: fallback
        ? (primaryHealth && primaryHealth.reason) || 'primary-unavailable'
        : selected.health.reason,
      displayLabel: selected.provider.label + (fallback ? ' (fallback)' : '')
    };
  }

  function classifyRadarState(observation) {
    observation = observation || {};
    var providerId = observation.providerId || (observation.frame && observation.frame.providerId);
    var health = observation.health;
    var age = getFrameAge(observation.frame, providerId, observation.now);
    var state;
    var label;
    var canRetry = false;
    var controlsEnabled = true;

    if (observation.error || (health && health.status === HEALTH.UNAVAILABLE) || !age.known || age.failed) {
      state = RADAR_STATE.FAILURE;
      label = 'Radar provider unavailable';
      canRetry = true;
      controlsEnabled = false;
    } else if (coverageUnavailable(observation.coverage)) {
      state = RADAR_STATE.NO_COVERAGE;
      label = 'No radar coverage at this location';
    } else if (age.stale || (health && health.reason === 'stale-frame')) {
      state = RADAR_STATE.STALE;
      label = 'Radar data is stale (' + age.label + ')';
      canRetry = true;
    } else if (observation.hasPrecipitation === false) {
      state = RADAR_STATE.CLEAR;
      label = 'Clear at map center';
    } else if (observation.hasPrecipitation === true) {
      state = RADAR_STATE.PRECIPITATION;
      label = 'Precipitation detected';
    } else {
      state = RADAR_STATE.AVAILABLE;
      label = 'Radar data available';
    }

    return {
      state: state,
      label: label,
      providerId: providerId || null,
      intensity: observation.intensity || null,
      frameAge: age,
      canRetry: canRetry,
      controlsEnabled: controlsEnabled,
      degraded: state === RADAR_STATE.STALE || state === RADAR_STATE.FAILURE ||
        !!(health && health.status === HEALTH.DEGRADED)
    };
  }

  function classifyRainViewerPixel(pixel) {
    if (!Array.isArray(pixel) || pixel.length < 4 || Number(pixel[3]) <= 0) return 'clear';
    var red = Math.round(Number(pixel[0]));
    var green = Math.round(Number(pixel[1]));
    var blue = Math.round(Number(pixel[2]));
    if (![red, green, blue].every(Number.isFinite)) return 'unknown';
    var hex = [red, green, blue].map(function (value) {
      return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
    }).join('');
    var moderate = ['ffaa00', 'ff9f00', 'ff9500', 'ff8b00', 'ff8100',
      'ff4400', 'f23600', 'e62800', 'd91b00', 'cd0d00'];
    if (moderate.indexOf(hex) !== -1) return 'moderate';
    if (red <= 193 && green === 0 && blue === 0 || red >= 240 && blue >= 240 ||
        red <= 20 && green >= 240 && blue <= 20) return 'heavy';
    return 'light';
  }

  return deepFreeze({
    providerIds: { RAINVIEWER: RAINVIEWER_ID, NOAA_MRMS: NOAA_ID },
    healthStatus: HEALTH,
    radarState: RADAR_STATE,
    providers: PROVIDERS,
    parseRainViewerDiscovery: parseRainViewerDiscovery,
    buildRainViewerTileUrl: buildRainViewerTileUrl,
    buildRainViewerCoverageUrl: buildRainViewerCoverageUrl,
    createRollingRequestBudget: createRollingRequestBudget,
    parseNoaaDiscovery: parseNoaaDiscovery,
    noaaWmsParameters: noaaWmsParameters,
    buildNoaaWmsUrl: buildNoaaWmsUrl,
    getFrameAge: getFrameAge,
    assessProviderHealth: assessProviderHealth,
    selectProvider: selectProvider,
    classifyRadarState: classifyRadarState,
    classifyRainViewerPixel: classifyRainViewerPixel
  });
});
