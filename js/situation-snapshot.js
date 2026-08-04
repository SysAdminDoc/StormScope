/* Privacy-bounded, versioned situation snapshot serializer. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSituationSnapshot = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VERSION = 1;
  var COORDINATE_DECIMALS = 2;
  var MAX_SOURCES = 24;
  var MAX_HAZARDS = 16;
  var MAX_TEXT = 1200;
  var FRESHNESS = ['fresh', 'stale', 'unknown', 'unavailable', 'not-visible'];
  var CAMERA_TYPES = ['embed', 'hls', 'image', 'mjpeg', 'youtube', 'unknown'];
  var CAMERA_HEALTH = ['healthy', 'degraded', 'offline', 'unknown'];

  function boundedText(value, maximum) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maximum || MAX_TEXT);
  }

  function finite(value, minimum, maximum, fallback) {
    var number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
  }

  function rounded(value, decimals) {
    if (value == null || value === '') return null;
    var number = finite(value, -Infinity, Infinity, null);
    if (number == null) return null;
    var factor = Math.pow(10, decimals);
    return Math.round(number * factor) / factor;
  }

  function timestamp(value) {
    if (value == null || value === '') return null;
    var number = Number(value);
    if (Number.isFinite(number)) {
      if (number > 0 && number < 100000000000) number *= 1000;
      return number > 0 ? new Date(number).toISOString() : null;
    }
    var parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  function safeHttpsUrl(value) {
    if (value == null || String(value).length > 2048) return null;
    try {
      var url = new URL(String(value));
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      return url.toString();
    } catch (error) {
      return null;
    }
  }

  function safePublicUrl(value) {
    if (value == null || String(value).length > 2048) return null;
    try {
      var url = new URL(String(value));
      if (['https:', 'http:'].indexOf(url.protocol) === -1 || url.username || url.password) return null;
      return url.toString();
    } catch (error) {
      return null;
    }
  }

  function freshness(value) {
    var normalized = String(value == null ? 'unknown' : value).toLowerCase();
    return FRESHNESS.indexOf(normalized) === -1 ? 'unknown' : normalized;
  }

  function normalizeSource(source) {
    source = source && typeof source === 'object' ? source : {};
    var id = boundedText(source.id, 48).toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) return null;
    return {
      id: id,
      source: boundedText(source.source, 160) || 'Unknown source',
      issue_at: timestamp(source.issueAt),
      freshness: freshness(source.freshness)
    };
  }

  function count(value) {
    var number = Math.floor(Number(value));
    return Number.isSafeInteger(number) && number >= 0 && number <= 1000000 ? number : 0;
  }

  function normalizeHazards(hazards) {
    var output = {};
    var source = hazards && typeof hazards === 'object' ? hazards : {};
    Object.keys(source).slice(0, MAX_HAZARDS).forEach(function (id) {
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) return;
      var item = source[id] && typeof source[id] === 'object' ? source[id] : {};
      output[id] = {
        label: boundedText(item.label, 120) || id,
        visible: Boolean(item.visible),
        count: count(item.count),
        source_id: boundedText(item.sourceId, 48).toLowerCase() || null
      };
    });
    return output;
  }

  function normalizeCamera(camera) {
    if (!camera || typeof camera !== 'object') return null;
    var type = boundedText(camera.type, 16).toLowerCase();
    if (CAMERA_TYPES.indexOf(type) === -1) type = 'unknown';
    var health = boundedText(camera.health, 16).toLowerCase();
    if (CAMERA_HEALTH.indexOf(health) === -1) health = 'unknown';
    var result = {
      name: boundedText(camera.name, 160) || 'Selected camera',
      source: boundedText(camera.source, 64).toLowerCase() || 'unknown',
      type: type,
      health: health,
      last_verified: timestamp(camera.lastVerified),
      source_url: safeHttpsUrl(camera.sourceUrl)
    };
    return result;
  }

  function normalize(value, options) {
    value = value && typeof value === 'object' ? value : {};
    options = options || {};
    var center = value.map && value.map.center && typeof value.map.center === 'object'
      ? value.map.center : value.map || {};
    var latitude = rounded(finite(center.latitude != null ? center.latitude : center.lat, -90, 90, null), COORDINATE_DECIMALS);
    var longitude = rounded(finite(center.longitude != null ? center.longitude : center.lon, -180, 180, null), COORDINATE_DECIMALS);
    if (latitude == null || longitude == null) throw new TypeError('snapshot map center is invalid');
    var zoom = Math.round(finite(value.map && value.map.zoom, 0, 24, 0));
    var sources = (Array.isArray(value.sources) ? value.sources : []).map(normalizeSource).filter(Boolean).slice(0, MAX_SOURCES);
    var publicSceneUrl = options.includeSceneUrl ? safePublicUrl(value.publicSceneUrl) : null;
    var result = {
      schema: VERSION,
      exported_at: timestamp(value.exportedAt) || new Date().toISOString(),
      app_version: boundedText(value.appVersion, 32) || 'unknown',
      locale: boundedText(value.locale, 16) || 'en',
      privacy: { map_precision_decimals: COORDINATE_DECIMALS, private_state_included: false },
      map: { center: { latitude: latitude, longitude: longitude }, zoom: zoom },
      sources: sources,
      hazards: normalizeHazards(value.hazards),
      selected_camera: normalizeCamera(value.selectedCamera)
    };
    if (publicSceneUrl) result.public_scene_url = publicSceneUrl;
    return result;
  }

  function defaultNumber(value) {
    return Number(value).toFixed(COORDINATE_DECIMALS);
  }

  function defaultTime(value) {
    return value || 'unknown';
  }

  function defaultCoordinate(value) {
    return defaultNumber(value);
  }

  function text(snapshot, options) {
    options = options || {};
    var translate = typeof options.translate === 'function' ? options.translate : function (key) { return key; };
    var formatNumber = typeof options.formatNumber === 'function' ? options.formatNumber : defaultNumber;
    var formatTime = typeof options.formatTime === 'function' ? options.formatTime : defaultTime;
    var formatCoordinate = typeof options.formatCoordinate === 'function' ? options.formatCoordinate : defaultCoordinate;
    var freshnessLabel = typeof options.freshnessLabel === 'function'
      ? options.freshnessLabel
      : function (value) { return translate('snapshot.' + value); };
    var lines = [
      translate('snapshot.title'),
      translate('snapshot.generated', { time: formatTime(snapshot.exported_at) }),
      translate('snapshot.map', {
        coordinate: formatCoordinate(snapshot.map.center.latitude, snapshot.map.center.longitude),
        zoom: formatNumber(snapshot.map.zoom)
      }),
      translate('snapshot.privacy', { decimals: formatNumber(snapshot.privacy.map_precision_decimals) }),
      '',
      translate('snapshot.sourcesHeading')
    ];
    if (!snapshot.sources.length) lines.push('- ' + translate('snapshot.noSources'));
    snapshot.sources.forEach(function (source) {
      lines.push('- ' + translate('snapshot.sourceLine', {
        source: source.source,
        issue: source.issue_at ? formatTime(source.issue_at) : translate('snapshot.unknown'),
        freshness: freshnessLabel(source.freshness)
      }));
    });
    lines.push('', translate('snapshot.hazardsHeading'));
    var hazardIds = Object.keys(snapshot.hazards);
    if (!hazardIds.length) lines.push('- ' + translate('snapshot.noHazards'));
    hazardIds.forEach(function (id) {
      var hazard = snapshot.hazards[id];
      lines.push('- ' + translate('snapshot.hazardLine', {
        label: hazard.label,
        count: formatNumber(hazard.count),
        visibility: translate(hazard.visible ? 'snapshot.visible' : 'snapshot.off')
      }));
    });
    lines.push('', translate('snapshot.selectedCameraHeading'));
    if (!snapshot.selected_camera) {
      lines.push(translate('snapshot.noSelectedCamera'));
    } else {
      lines.push(translate('snapshot.cameraLine', {
        name: snapshot.selected_camera.name,
        source: snapshot.selected_camera.source,
        type: snapshot.selected_camera.type,
        health: snapshot.selected_camera.health,
        verified: snapshot.selected_camera.last_verified
          ? formatTime(snapshot.selected_camera.last_verified) : translate('snapshot.unknown')
      }));
      if (snapshot.selected_camera.source_url) lines.push(snapshot.selected_camera.source_url);
    }
    if (snapshot.public_scene_url) {
      lines.push('', translate('snapshot.publicScene', { url: snapshot.public_scene_url }));
    }
    return lines.join('\n').slice(0, 30000);
  }

  function build(value, options) {
    options = options || {};
    var snapshot = normalize(value, options);
    return Object.freeze({ json: snapshot, text: text(snapshot, options) });
  }

  return Object.freeze({
    VERSION: VERSION,
    COORDINATE_DECIMALS: COORDINATE_DECIMALS,
    normalize: normalize,
    build: build,
    safeHttpsUrl: safeHttpsUrl,
    safePublicUrl: safePublicUrl
  });
});
