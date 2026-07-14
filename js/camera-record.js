/* Shared runtime camera-record and embed trust contract. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeCameraRecord = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CAMERA_TYPES = Object.freeze(['embed', 'hls', 'image', 'mjpeg', 'youtube']);
  var CAMERA_SOURCES = Object.freeze([
    'angelcam', 'dot', 'earthcam', 'faa', 'hazcams', 'ipcamlive', 'livebeaches',
    'mwra', 'noaa', 'nps', 'nrao', 'rtspme', 'smithsonian', 'state_park',
    'university', 'usgs', 'youtube'
  ]);
  var CAMERA_HEALTH = Object.freeze(['unknown', 'healthy', 'degraded', 'offline']);
  var FAILURE_CLASSES = Object.freeze([
    'transient', 'provider_error', 'confirmed_offline', 'unsupported', 'inactive'
  ]);
  var OFFLINE_FAILURE_CLASSES = Object.freeze(['confirmed_offline', 'unsupported', 'inactive']);
  var CAMERA_STATUSES = Object.freeze(['Active', 'Offline', 'Unknown']);
  var TRUSTED_EMBED_HOST_SUFFIXES = Object.freeze([
    'v.angelcam.com',
    'cdn.jwplayer.com',
    'earthcam.com',
    'myearthcam.com',
    'nps.gov',
    'brownrice.com',
    'abbeyroad.com',
    'esbnyc.com',
    'weathercams.faa.gov',
    'hazcams.com',
    'ipcamlive.com',
    'rtsp.me'
  ]);

  function hostMatchesSuffix(hostname, suffix) {
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }

  function parseHttpsUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) return null;
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  function isAllowedEmbedUrl(url, suffixes) {
    var trusted = suffixes || TRUSTED_EMBED_HOST_SUFFIXES;
    var parsed = parseHttpsUrl(url);
    if (!parsed) return false;
    var hostname = parsed.hostname.toLowerCase();
    for (var i = 0; i < trusted.length; i += 1) {
      if (hostMatchesSuffix(hostname, trusted[i])) return true;
    }
    return false;
  }

  function timestamp(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 40 &&
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
  }

  function boundedString(value, maximum, allowEmpty) {
    return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);
  }

  function invalid(camera, field) {
    var id = camera && Number.isInteger(camera.id) ? ' ' + camera.id : '';
    throw new Error('Camera record' + id + ' has invalid ' + field);
  }

  function validateCameraRecord(camera, options) {
    options = options || {};
    if (!camera || typeof camera !== 'object' || Array.isArray(camera)) invalid(camera, 'object');
    if (!Number.isSafeInteger(camera.id) || camera.id < 1) invalid(camera, 'id');
    if (!boundedString(camera.name, 256, false)) invalid(camera, 'name');
    if (typeof camera.lat !== 'number' || !Number.isFinite(camera.lat) || camera.lat < -90 || camera.lat > 90) {
      invalid(camera, 'latitude');
    }
    if (typeof camera.lon !== 'number' || !Number.isFinite(camera.lon) || camera.lon < -180 || camera.lon > 180) {
      invalid(camera, 'longitude');
    }
    if (CAMERA_TYPES.indexOf(camera.type) === -1) invalid(camera, 'type');
    if (CAMERA_SOURCES.indexOf(camera.source) === -1) invalid(camera, 'source');
    if (CAMERA_HEALTH.indexOf(camera.health) === -1) invalid(camera, 'health');

    if (camera.type === 'youtube') {
      if (typeof camera.url !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(camera.url)) invalid(camera, 'YouTube identifier');
    } else if (!parseHttpsUrl(camera.url)) {
      invalid(camera, 'HTTPS feed URL');
    }
    if (camera.type === 'embed' && !isAllowedEmbedUrl(camera.url, options.trustedEmbedHostSuffixes)) {
      invalid(camera, 'trusted embed URL');
    }

    if (camera.last_verified !== null && !timestamp(camera.last_verified)) invalid(camera, 'last_verified');
    if (camera.failure_class !== null && FAILURE_CLASSES.indexOf(camera.failure_class) === -1) invalid(camera, 'failure_class');
    if (camera.source_url !== null && !parseHttpsUrl(camera.source_url)) invalid(camera, 'source_url');
    if (camera.refresh_cadence_seconds !== null &&
        (!Number.isSafeInteger(camera.refresh_cadence_seconds) || camera.refresh_cadence_seconds < 1)) {
      invalid(camera, 'refresh_cadence_seconds');
    }
    if (camera.health === 'healthy' &&
        (camera.failure_class !== null || !timestamp(camera.last_verified) || !parseHttpsUrl(camera.source_url))) {
      invalid(camera, 'healthy evidence');
    }
    if (camera.health === 'offline' && OFFLINE_FAILURE_CLASSES.indexOf(camera.failure_class) === -1) {
      invalid(camera, 'offline failure_class');
    }

    [['state', 160], ['county', 160], ['direction', 64]].forEach(function (entry) {
      if (Object.hasOwn(camera, entry[0]) && !boundedString(camera[entry[0]], entry[1], true)) invalid(camera, entry[0]);
    });
    if (Object.hasOwn(camera, 'provider') && !boundedString(camera.provider, 160, false)) invalid(camera, 'provider');
    if (Object.hasOwn(camera, 'ingestion_source') && !boundedString(camera.ingestion_source, 160, false)) {
      invalid(camera, 'ingestion_source');
    }
    if (Object.hasOwn(camera, 'status') && CAMERA_STATUSES.indexOf(camera.status) === -1) invalid(camera, 'status');
    return camera;
  }

  return Object.freeze({
    CAMERA_TYPES: CAMERA_TYPES,
    CAMERA_SOURCES: CAMERA_SOURCES,
    CAMERA_HEALTH: CAMERA_HEALTH,
    FAILURE_CLASSES: FAILURE_CLASSES,
    TRUSTED_EMBED_HOST_SUFFIXES: TRUSTED_EMBED_HOST_SUFFIXES,
    hostMatchesSuffix: hostMatchesSuffix,
    isAllowedEmbedUrl: isAllowedEmbedUrl,
    validateCameraRecord: validateCameraRecord
  });
});
