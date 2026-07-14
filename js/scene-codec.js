/* Versioned, bounded, URL-safe StormScope scene codec. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSceneCodec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VERSION = 1;
  var PREFIX = VERSION + '.';
  var MAX_TOKEN_LENGTH = 2048;
  var LAYERS = ['radar', 'cameras', 'coverage', 'alerts', 'lightning', 'wildfires', 'satellite', 'tropical', 'wpcOutlooks', 'usgsGauges', 'earthquakes', 'convective', 'watches'];
  var MAX_LAYER_BITS = (1 << LAYERS.length) - 1;
  var PALETTES = ['standard', 'colorblind', 'contrast'];
  var SPEEDS = [0, 400, 800, 1600];
  var SEVERITIES = ['all', 'minor', 'moderate', 'severe', 'extreme'];
  var EARTHQUAKE_MAGNITUDES = ['significant', '4.5', '2.5', '1.0', 'all'];
  var EARTHQUAKE_PERIODS = ['hour', 'day', 'week', 'month'];
  var SOURCES = ['', 'angelcam', 'dot', 'earthcam', 'faa', 'hazcams', 'ipcamlive', 'livebeaches',
    'mwra', 'noaa', 'nps', 'nrao', 'rtspme', 'smithsonian', 'state_park', 'university', 'usgs', 'youtube'];
  var FEED_TYPES = ['', 'image', 'hls', 'mjpeg', 'embed', 'youtube'];
  var SORTS = ['name', 'distance'];

  function objectValue(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object');
    return value;
  }

  function finite(value, label, minimum, maximum) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new RangeError(label + ' is outside the supported range');
    }
    return number;
  }

  function boundedString(value, label, maximum) {
    var text = String(value == null ? '' : value).trim();
    if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) throw new TypeError(label + ' is invalid');
    return text;
  }

  function choice(value, allowed, label) {
    var text = boundedString(value, label, 32).toLowerCase();
    if (allowed.indexOf(text) === -1) throw new TypeError(label + ' is unsupported');
    return text;
  }

  function normalizeScene(value) {
    var source = objectValue(value, 'scene');
    var map = objectValue(source.map, 'scene map');
    var layers = objectValue(source.layers, 'scene layers');
    var radar = objectValue(source.radar, 'scene radar');
    var filters = objectValue(source.cameraFilters, 'scene camera filters');
    var normalizedLayers = {};
    LAYERS.forEach(function (name, index) {
      if (index >= 7 && layers[name] == null) {
        normalizedLayers[name] = false;
        return;
      }
      if (typeof layers[name] !== 'boolean') throw new TypeError('scene layer ' + name + ' must be boolean');
      normalizedLayers[name] = layers[name];
    });
    var activeCameraId = source.activeCameraId == null ? null : boundedString(source.activeCameraId, 'active camera ID', 128);
    if (activeCameraId === '') activeCameraId = null;
    var frameTime = radar.frameTime == null ? null : Math.round(finite(
      radar.frameTime, 'radar frame time', Date.UTC(2000, 0, 1), Date.UTC(2100, 0, 1)
    ));
    var speed = Number(radar.speed);
    if (SPEEDS.indexOf(speed) === -1) throw new TypeError('radar speed is unsupported');
    var outlookDay = source.outlookDay == null ? 1 : finite(source.outlookDay, 'outlook day', 1, 3);
    if (!Number.isInteger(outlookDay)) throw new TypeError('outlook day is invalid');
    var convectiveDay = source.convectiveDay == null ? 1 : finite(source.convectiveDay, 'convective day', 1, 3);
    if (!Number.isInteger(convectiveDay)) throw new TypeError('convective day is invalid');
    var earthquake = source.earthquake == null ? { magnitude: '2.5', period: 'day' }
      : objectValue(source.earthquake, 'scene earthquake');
    return {
      map: {
        lat: Math.round(finite(map.lat, 'latitude', -90, 90) * 100000) / 100000,
        lon: Math.round(finite(map.lon, 'longitude', -180, 180) * 100000) / 100000,
        zoom: Math.round(finite(map.zoom, 'zoom', 0, 24) * 100) / 100
      },
      layers: normalizedLayers,
      radar: {
        opacity: Math.round(finite(radar.opacity, 'radar opacity', 0, 1) * 100) / 100,
        palette: choice(radar.palette, PALETTES, 'radar palette'),
        speed: speed,
        frameTime: frameTime
      },
      alertSeverity: choice(source.alertSeverity, SEVERITIES, 'alert severity'),
      cameraFilters: {
        query: boundedString(filters.query, 'camera query', 120),
        state: boundedString(filters.state, 'camera state', 80),
        source: choice(filters.source, SOURCES, 'camera source'),
        type: choice(filters.type, FEED_TYPES, 'camera feed type'),
        sort: choice(filters.sort, SORTS, 'camera sort'),
        healthy: Boolean(filters.healthy)
      },
      activeCameraId: activeCameraId,
      outlookDay: outlookDay,
      convectiveDay: convectiveDay,
      earthquake: {
        magnitude: choice(earthquake.magnitude, EARTHQUAKE_MAGNITUDES, 'earthquake magnitude'),
        period: choice(earthquake.period, EARTHQUAKE_PERIODS, 'earthquake period')
      }
    };
  }

  function compact(scene) {
    var layerBits = 0;
    LAYERS.forEach(function (name, index) { if (scene.layers[name]) layerBits |= (1 << index); });
    return {
      v: VERSION,
      m: [scene.map.lat, scene.map.lon, scene.map.zoom],
      l: layerBits,
      r: [Math.round(scene.radar.opacity * 100), PALETTES.indexOf(scene.radar.palette),
        SPEEDS.indexOf(scene.radar.speed), scene.radar.frameTime],
      a: SEVERITIES.indexOf(scene.alertSeverity),
      f: [scene.cameraFilters.query, scene.cameraFilters.state, SOURCES.indexOf(scene.cameraFilters.source),
        FEED_TYPES.indexOf(scene.cameraFilters.type), SORTS.indexOf(scene.cameraFilters.sort), scene.cameraFilters.healthy ? 1 : 0],
      c: scene.activeCameraId,
      o: scene.outlookDay,
      d: scene.convectiveDay,
      e: [EARTHQUAKE_MAGNITUDES.indexOf(scene.earthquake.magnitude), EARTHQUAKE_PERIODS.indexOf(scene.earthquake.period)]
    };
  }

  function expand(value) {
    var source = objectValue(value, 'scene payload');
    if (source.v !== VERSION) throw new RangeError('scene version is unsupported');
    if (!Array.isArray(source.m) || source.m.length !== 3 || !Number.isInteger(source.l) || source.l < 0 || source.l > MAX_LAYER_BITS ||
        !Array.isArray(source.r) || source.r.length !== 4 || !Array.isArray(source.f) || source.f.length !== 6) {
      throw new TypeError('scene payload shape is invalid');
    }
    var layers = {};
    LAYERS.forEach(function (name, index) { layers[name] = Boolean(source.l & (1 << index)); });
    if (!Number.isInteger(source.r[1]) || !PALETTES[source.r[1]] || !Number.isInteger(source.r[2]) ||
        SPEEDS[source.r[2]] == null || !Number.isInteger(source.a) || !SEVERITIES[source.a] ||
        !Number.isInteger(source.f[2]) || SOURCES[source.f[2]] == null || !Number.isInteger(source.f[3]) ||
        FEED_TYPES[source.f[3]] == null || !Number.isInteger(source.f[4]) || !SORTS[source.f[4]] ||
        (source.f[5] !== 0 && source.f[5] !== 1) || (source.e != null && (!Array.isArray(source.e) || source.e.length !== 2 ||
          !Number.isInteger(source.e[0]) || EARTHQUAKE_MAGNITUDES[source.e[0]] == null ||
          !Number.isInteger(source.e[1]) || EARTHQUAKE_PERIODS[source.e[1]] == null))) {
      throw new TypeError('scene payload enum is invalid');
    }
    return normalizeScene({
      map: { lat: source.m[0], lon: source.m[1], zoom: source.m[2] },
      layers: layers,
      radar: { opacity: source.r[0] / 100, palette: PALETTES[source.r[1]], speed: SPEEDS[source.r[2]], frameTime: source.r[3] },
      alertSeverity: SEVERITIES[source.a],
      cameraFilters: {
        query: source.f[0], state: source.f[1], source: SOURCES[source.f[2]], type: FEED_TYPES[source.f[3]],
        sort: SORTS[source.f[4]], healthy: Boolean(source.f[5])
      },
      activeCameraId: source.c,
      outlookDay: source.o == null ? 1 : source.o,
      convectiveDay: source.d == null ? 1 : source.d,
      earthquake: source.e == null ? { magnitude: '2.5', period: 'day' } : {
        magnitude: EARTHQUAKE_MAGNITUDES[source.e[0]], period: EARTHQUAKE_PERIODS[source.e[1]]
      }
    });
  }

  function base64UrlEncode(text) {
    if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64url');
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    for (var index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlDecode(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('scene token encoding is invalid');
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64url').toString('utf8');
    var padded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function encode(value) {
    var token = PREFIX + base64UrlEncode(JSON.stringify(compact(normalizeScene(value))));
    if (token.length > MAX_TOKEN_LENGTH) throw new RangeError('scene URL exceeds the supported length');
    return token;
  }

  function decode(token) {
    var text = String(token || '');
    if (text.length > MAX_TOKEN_LENGTH) throw new RangeError('scene URL exceeds the supported length');
    if (text.slice(0, PREFIX.length) !== PREFIX) throw new RangeError('scene version is unsupported');
    var json = base64UrlDecode(text.slice(PREFIX.length));
    if (json.length > 4096) throw new RangeError('scene payload exceeds the supported length');
    return expand(JSON.parse(json));
  }

  function fromHash(hash) {
    var params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    var token = params.get('scene');
    return token == null ? null : decode(token);
  }

  function toHash(value) {
    return 'scene=' + encodeURIComponent(encode(value));
  }

  return Object.freeze({
    VERSION: VERSION,
    MAX_TOKEN_LENGTH: MAX_TOKEN_LENGTH,
    encode: encode,
    decode: decode,
    fromHash: fromHash,
    normalizeScene: normalizeScene,
    toHash: toHash
  });
});
