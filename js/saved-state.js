/* StormScope local favorites and saved-view persistence.
 * Browser global: window.StormScopeSavedState
 * CommonJS: require('./saved-state.js')
 */
'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSavedState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var SCHEMA = 'stormscope-saved-state';
  var VERSION = 3;
  var DEFAULT_KEY = 'stormscope.saved-state';
  var MAX_FAVORITES = 10000;
  var MAX_VIEWS = 200;
  var MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  var LAYER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function decodeImportBytes(value) {
    var bytes;
    if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else throw new TypeError('saved-state import must be binary data');
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new RangeError('saved-state import exceeds the size limit');
    var text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_error) {
      throw new TypeError('saved-state import is not valid UTF-8');
    }
    if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
      throw new RangeError('saved-state import exceeds the UTF-8 size limit');
    }
    return text;
  }

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function objectValue(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(label + ' must be an object');
    }
    return value;
  }

  function finiteNumber(value, label, legacy) {
    var number = legacy ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new TypeError(label + ' must be a finite number');
    return number;
  }

  function normalizeCameraId(value) {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('camera ID must be a non-negative integer or string');
      return String(value);
    }
    if (typeof value !== 'string') throw new TypeError('camera ID must be a non-negative integer or string');
    var id = value.trim();
    if (!id || id.length > 128 || /[\u0000-\u001f]/.test(id)) throw new TypeError('camera ID is invalid');
    return id;
  }

  function normalizeFavorites(value, legacy) {
    var source;
    if (legacy && value == null) source = [];
    else if (Array.isArray(value)) source = value;
    else if (legacy && typeof value === 'object') {
      source = Object.keys(value).filter(function (key) { return Boolean(value[key]); });
    } else throw new TypeError('favorites must be an array or object');
    if (source.length > MAX_FAVORITES) throw new RangeError('favorites exceed the supported limit');
    var seen = Object.create(null);
    var result = [];
    source.forEach(function (value) {
      if (!legacy && typeof value !== 'string') throw new TypeError('current-schema favorite IDs must be strings');
      var id = normalizeCameraId(value);
      if (!seen[id]) {
        seen[id] = true;
        result.push(id);
      }
    });
    return result;
  }

  function normalizeCenter(value, fallback, legacy) {
    var source = value || fallback;
    objectValue(source, 'view center');
    var latitude = finiteNumber(own(source, 'lat') ? source.lat : source.latitude, 'latitude', legacy);
    var longitude = finiteNumber(own(source, 'lon') ? source.lon : (own(source, 'lng') ? source.lng : source.longitude), 'longitude', legacy);
    if (latitude < -90 || latitude > 90) throw new RangeError('latitude must be between -90 and 90');
    if (longitude < -180 || longitude > 180) throw new RangeError('longitude must be between -180 and 180');
    return { lat: latitude, lon: longitude };
  }

  function normalizeBooleanMap(value, label) {
    if (value == null) return {};
    var source = objectValue(value, label);
    var result = {};
    Object.keys(source).sort().forEach(function (key) {
      if (!LAYER_PATTERN.test(key)) throw new TypeError(label + ' contains an invalid key');
      if (typeof source[key] !== 'boolean') throw new TypeError(label + '.' + key + ' must be boolean');
      result[key] = source[key];
    });
    return result;
  }

  function normalizeOpacityMap(value, legacy) {
    if (value == null) return {};
    var source = objectValue(value, 'view opacity');
    var result = {};
    Object.keys(source).sort().forEach(function (key) {
      if (!LAYER_PATTERN.test(key)) throw new TypeError('view opacity contains an invalid key');
      var opacity = finiteNumber(source[key], 'view opacity.' + key, legacy);
      if (opacity < 0 || opacity > 1) throw new RangeError('view opacity.' + key + ' must be between 0 and 1');
      result[key] = opacity;
    });
    return result;
  }

  function boundedString(value, label, maximum) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
      throw new TypeError(label + ' is invalid');
    }
    return value;
  }

  function normalizeWorkflow(source, snapshot, legacy) {
    if (source.radar != null) {
      var radar = objectValue(source.radar, 'view radar');
      var palette = boundedString(radar.palette, 'view radar palette', 20);
      var speed = finiteNumber(radar.speed, 'view radar speed', legacy);
      if (['standard', 'colorblind', 'contrast'].indexOf(palette) === -1) throw new TypeError('view radar palette is invalid');
      if ([0, 400, 800, 1600].indexOf(speed) === -1) throw new TypeError('view radar speed is invalid');
      snapshot.radar = { palette: palette, speed: speed };
    }
    if (source.alertSeverity != null) {
      var severity = boundedString(source.alertSeverity, 'view alert severity', 12);
      if (['all', 'minor', 'moderate', 'severe', 'extreme'].indexOf(severity) === -1) {
        throw new TypeError('view alert severity is invalid');
      }
      snapshot.alertSeverity = severity;
    }
    if (source.cameraFilters != null) {
      var filters = objectValue(source.cameraFilters, 'view camera filters');
      var sort = boundedString(filters.sort, 'view camera sort', 12);
      if (['name', 'distance'].indexOf(sort) === -1) throw new TypeError('view camera sort is invalid');
      if (typeof filters.healthy !== 'boolean') throw new TypeError('view camera healthy filter must be boolean');
      if (typeof filters.favorites !== 'boolean') throw new TypeError('view camera favorites filter must be boolean');
      snapshot.cameraFilters = {
        query: boundedString(filters.query, 'view camera query', 160),
        state: boundedString(filters.state, 'view camera state', 80),
        source: boundedString(filters.source, 'view camera source', 40),
        type: boundedString(filters.type, 'view camera type', 20),
        sort: sort,
        healthy: filters.healthy,
        favorites: filters.favorites
      };
    }
    if (source.dataMode != null) {
      var dataMode = boundedString(source.dataMode, 'view data mode', 12);
      if (['auto', 'standard', 'low'].indexOf(dataMode) === -1) throw new TypeError('view data mode is invalid');
      snapshot.dataMode = dataMode;
    }
    if (source.weatherUnits != null) {
      var units = boundedString(source.weatherUnits, 'view weather units', 12);
      if (['us', 'metric'].indexOf(units) === -1) throw new TypeError('view weather units are invalid');
      snapshot.weatherUnits = units;
    }
    if (source.outlookDay != null) {
      var outlookDay = finiteNumber(source.outlookDay, 'view outlook day', legacy);
      if (!Number.isInteger(outlookDay) || outlookDay < 1 || outlookDay > 3) {
        throw new TypeError('view outlook day is invalid');
      }
      snapshot.outlookDay = outlookDay;
    }
    if (source.convectiveDay != null) {
      var convectiveDay = finiteNumber(source.convectiveDay, 'view convective day', legacy);
      if (!Number.isInteger(convectiveDay) || convectiveDay < 1 || convectiveDay > 3) {
        throw new TypeError('view convective day is invalid');
      }
      snapshot.convectiveDay = convectiveDay;
    }
    if (source.earthquake != null) {
      var earthquake = objectValue(source.earthquake, 'view earthquake');
      var magnitude = boundedString(earthquake.magnitude, 'view earthquake magnitude', 12);
      var period = boundedString(earthquake.period, 'view earthquake period', 8);
      if (['significant', '4.5', '2.5', '1.0', 'all'].indexOf(magnitude) === -1) {
        throw new TypeError('view earthquake magnitude is invalid');
      }
      if (['hour', 'day', 'week', 'month'].indexOf(period) === -1) {
        throw new TypeError('view earthquake period is invalid');
      }
      snapshot.earthquake = { magnitude: magnitude, period: period };
    }
    return snapshot;
  }

  function legacyLayers(source) {
    var layers = source.layers && typeof source.layers === 'object' ? source.layers : {};
    var result = Object.create(null);
    Object.keys(layers).forEach(function (key) { result[key] = layers[key]; });
    ['radar', 'cameras', 'coverage', 'alerts'].forEach(function (key) {
      var legacyKey = key + 'Visible';
      if (own(source, legacyKey) && !own(result, key)) result[key] = Boolean(source[legacyKey]);
    });
    return result;
  }

  function legacyOpacity(source) {
    var opacity = source.opacity && typeof source.opacity === 'object' ? source.opacity : {};
    var result = Object.create(null);
    Object.keys(opacity).forEach(function (key) { result[key] = opacity[key]; });
    if (own(source, 'radarOpacity') && !own(result, 'radar')) result.radar = source.radarOpacity;
    return result;
  }

  function normalizeSnapshot(value, options) {
    var legacy = Boolean(options && options.legacy);
    var source = objectValue(value, 'view');
    var map = legacy && source.map && typeof source.map === 'object' ? source.map : source;
    var center = normalizeCenter(legacy ? (source.center || map.center) : source.center, legacy ? map : null, legacy);
    var zoom = finiteNumber(legacy ? (own(source, 'zoom') ? source.zoom : map.zoom) : source.zoom, 'zoom', legacy);
    if (zoom < 0 || zoom > 24) throw new RangeError('zoom must be between 0 and 24');
    return normalizeWorkflow(source, {
      center: center,
      zoom: zoom,
      layers: normalizeBooleanMap(legacy ? legacyLayers(source) : source.layers, 'view layers'),
      opacity: normalizeOpacityMap(legacy ? legacyOpacity(source) : source.opacity, legacy)
    }, legacy);
  }

  function normalizeName(value) {
    if (typeof value !== 'string') throw new TypeError('view name must be a string');
    var name = value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new TypeError('view name is invalid');
    return name;
  }

  function normalizeViewId(value) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new TypeError('view ID is invalid');
    return value;
  }

  function normalizeIso(value, label, fallback, legacy) {
    if (typeof value === 'string' && value.length <= 40 &&
        /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))) {
      return new Date(Date.parse(value)).toISOString();
    }
    if (legacy) return fallback;
    throw new TypeError(label + ' must be an ISO timestamp');
  }

  function normalizeView(value, index, nowIso, legacy) {
    var source = objectValue(value, 'saved view');
    var id = source.id == null && legacy ? 'migrated-' + (index + 1) : normalizeViewId(source.id);
    var createdAt = normalizeIso(source.createdAt, 'saved view createdAt', nowIso, legacy);
    var snapshot = legacy ? (source.snapshot || source.view || source) : source.snapshot;
    return {
      id: id,
      name: normalizeName(source.name),
      snapshot: normalizeSnapshot(snapshot, { legacy: legacy }),
      createdAt: createdAt,
      updatedAt: normalizeIso(source.updatedAt, 'saved view updatedAt', createdAt, legacy)
    };
  }

  function emptyState(nowIso) {
    return {
      schema: SCHEMA,
      version: VERSION,
      favorites: [],
      views: [],
      lastView: null,
      updatedAt: nowIso
    };
  }

  function migratePayload(input, options) {
    var settings = options || {};
    var nowIso = settings.nowIso || new Date().toISOString();
    var parsed = typeof input === 'string' ? JSON.parse(input) : input;
    var source = objectValue(parsed, 'saved state');
    var version;
    if (source.version == null) version = 0;
    else if (typeof source.version === 'number') version = source.version;
    else if (typeof source.version === 'string' && /^(?:0|1|2)$/.test(source.version)) version = Number(source.version);
    else throw new TypeError('saved-state version is invalid');
    if (!Number.isInteger(version) || version < 0) throw new TypeError('saved-state version is invalid');
    if (version > VERSION) throw new RangeError('saved-state version is newer than this app supports');
    if (version === VERSION && source.schema !== SCHEMA) throw new TypeError('saved-state schema is invalid');
    var legacy = version < VERSION;
    if (!legacy && ['favorites', 'views', 'lastView', 'updatedAt'].some(function (key) { return !own(source, key); })) {
      throw new TypeError('current saved-state payload is incomplete');
    }

    var favorites = source.favorites;
    if (legacy && favorites == null) favorites = source.favoriteCameraIds;
    var viewSource = source.views;
    if (legacy && viewSource == null) viewSource = source.savedViews;
    if (legacy && viewSource == null) viewSource = [];
    if (!Array.isArray(viewSource)) throw new TypeError('views must be an array');
    if (viewSource.length > MAX_VIEWS) throw new RangeError('views exceed the supported limit');

    var ids = new Set();
    var names = new Set();
    var views = [];
    viewSource.forEach(function (view, index) {
      var normalized = normalizeView(view, index, nowIso, legacy);
      var foldedName = normalized.name.toLowerCase();
      if (ids.has(normalized.id)) throw new TypeError('saved view IDs must be unique');
      if (names.has(foldedName)) throw new TypeError('saved view names must be unique ignoring case');
      ids.add(normalized.id);
      names.add(foldedName);
      views.push(normalized);
    });

    return {
      schema: SCHEMA,
      version: VERSION,
      favorites: normalizeFavorites(favorites, legacy),
      views: views,
      lastView: source.lastView == null ? null : normalizeSnapshot(
        legacy ? (source.lastView.snapshot || source.lastView) : source.lastView,
        { legacy: legacy }
      ),
      updatedAt: normalizeIso(source.updatedAt, 'saved state updatedAt', nowIso, legacy)
    };
  }

  function validatePayload(input, options) {
    return migratePayload(input, options);
  }

  function memoryStorage() {
    var values = Object.create(null);
    return {
      getItem: function (key) { return own(values, key) ? values[key] : null; },
      setItem: function (key, value) { values[key] = String(value); },
      removeItem: function (key) { delete values[key]; }
    };
  }

  function defaultStorage() {
    try {
      if (root && root.localStorage) return root.localStorage;
    } catch (error) { /* localStorage may be blocked */ }
    return memoryStorage();
  }

  function createStore(options) {
    var settings = options || {};
    var storage = settings.storage || defaultStorage();
    var key = settings.key || DEFAULT_KEY;
    var backupKey = key + '.backup';
    var now = typeof settings.now === 'function' ? settings.now : Date.now;
    var random = typeof settings.random === 'function' ? settings.random : Math.random;
    var persistent = Boolean(settings.storage);
    if (!persistent) {
      try { persistent = Boolean(root && root.localStorage === storage); } catch (error) { persistent = false; }
    }
    var loadError = null;
    var recoveredFromBackup = false;

    function nowIso() {
      var value = now();
      var milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
      if (!isFinite(milliseconds)) milliseconds = Number(value);
      if (!isFinite(milliseconds)) throw new TypeError('clock returned an invalid time');
      return new Date(milliseconds).toISOString();
    }

    function readRaw(name) {
      try { return storage.getItem(name); } catch (error) { loadError = error; return null; }
    }

    function parseRaw(raw) {
      if (raw == null || raw === '') return null;
      return migratePayload(raw, { nowIso: nowIso() });
    }

    var state;
    var primaryRaw = readRaw(key);
    try {
      state = parseRaw(primaryRaw);
    } catch (error) {
      loadError = error;
      state = null;
    }
    if (!state && primaryRaw != null) {
      try {
        state = parseRaw(readRaw(backupKey));
        recoveredFromBackup = Boolean(state);
      } catch (error) {
        if (!loadError) loadError = error;
      }
    }
    if (!state) state = emptyState(nowIso());

    function stageCandidate(candidate, preserveUpdatedAt) {
      var next = migratePayload(candidate, { nowIso: nowIso() });
      if (!preserveUpdatedAt) next.updatedAt = nowIso();
      return { state: next, serialized: JSON.stringify(next) };
    }

    function commitStaged(staged) {
      var currentRaw = readRaw(key);
      if (currentRaw != null) {
        try {
          parseRaw(currentRaw);
          storage.setItem(backupKey, currentRaw);
        } catch (error) {
          // Never replace a valid backup with corrupt primary data.
        }
      }
      storage.setItem(key, staged.serialized);
      state = staged.state;
      loadError = null;
      recoveredFromBackup = false;
      return clone(state);
    }

    function commit(candidate) {
      return commitStaged(stageCandidate(candidate));
    }

    function getState() { return clone(state); }

    function setFavorite(cameraId, favorite) {
      var id = normalizeCameraId(cameraId);
      var next = getState();
      var index = next.favorites.indexOf(id);
      if (favorite && index === -1) next.favorites.push(id);
      if (!favorite && index !== -1) next.favorites.splice(index, 1);
      return commit(next);
    }

    function makeViewId(existingViews) {
      var base = 'view-' + Date.parse(nowIso()).toString(36) + '-' + Math.floor(random() * 0xFFFFFF).toString(36);
      var candidate = base;
      var suffix = 1;
      while (existingViews.some(function (view) { return view.id === candidate; })) {
        candidate = base + '-' + suffix;
        suffix += 1;
      }
      return candidate;
    }

    function saveView(name, snapshot, viewOptions) {
      var normalizedName = normalizeName(name);
      var next = getState();
      var requestedId = viewOptions && viewOptions.id ? normalizeViewId(viewOptions.id) : null;
      var index = next.views.findIndex(function (view) {
        return requestedId ? view.id === requestedId : view.name.toLowerCase() === normalizedName.toLowerCase();
      });
      var timestamp = nowIso();
      if (index === -1) {
        if (next.views.length >= MAX_VIEWS) throw new RangeError('views exceed the supported limit');
        next.views.push({
          id: requestedId || makeViewId(next.views),
          name: normalizedName,
          snapshot: normalizeSnapshot(snapshot),
          createdAt: timestamp,
          updatedAt: timestamp
        });
      } else {
        next.views[index].name = normalizedName;
        next.views[index].snapshot = normalizeSnapshot(snapshot);
        next.views[index].updatedAt = timestamp;
      }
      return commit(next);
    }

    function deleteView(viewId) {
      var id = normalizeViewId(viewId);
      var next = getState();
      next.views = next.views.filter(function (view) { return view.id !== id; });
      return commit(next);
    }

    function restoreView(value) {
      var next = getState();
      var restored = normalizeView(value, next.views.length, nowIso());
      if (next.views.some(function (view) {
        return view.id === restored.id || view.name.toLowerCase() === restored.name.toLowerCase();
      })) throw new Error('saved view conflicts with current state');
      if (next.views.length >= MAX_VIEWS) throw new RangeError('views exceed the supported limit');
      next.views.push(restored);
      return commit(next);
    }

    return Object.freeze({
      getState: getState,
      getStatus: function () {
        return { persistent: persistent, loadError: loadError, recoveredFromBackup: recoveredFromBackup };
      },
      listFavorites: function () { return state.favorites.slice(); },
      isFavorite: function (cameraId) { return state.favorites.indexOf(normalizeCameraId(cameraId)) !== -1; },
      setFavorite: setFavorite,
      toggleFavorite: function (cameraId) {
        var id = normalizeCameraId(cameraId);
        var favorite = state.favorites.indexOf(id) === -1;
        setFavorite(id, favorite);
        return favorite;
      },
      clearFavorites: function () { var next = getState(); next.favorites = []; return commit(next); },
      listViews: function () { return clone(state.views); },
      getView: function (viewId) {
        var id = normalizeViewId(viewId);
        var found = state.views.find(function (view) { return view.id === id; });
        return found ? clone(found) : null;
      },
      saveView: saveView,
      deleteView: deleteView,
      restoreView: restoreView,
      setLastView: function (snapshot) {
        var next = getState();
        // Runtime captures may still use the pre-v3 map/visibility aliases. Keep
        // that compatibility at the trusted local API boundary; imports remain
        // strict unless they explicitly pass through a v0-v2 migration.
        next.lastView = normalizeSnapshot(snapshot, { legacy: true });
        return commit(next);
      },
      getLastView: function () { return state.lastView ? clone(state.lastView) : null; },
      clearLastView: function () { var next = getState(); next.lastView = null; return commit(next); },
      exportJson: function (space) { return JSON.stringify(state, null, space == null ? 2 : space); },
      importJson: function (json) {
        var previous = getState();
        var imported = migratePayload(json, { nowIso: nowIso() });
        var staged = stageCandidate(imported);
        return { state: commitStaged(staged), previous: previous };
      },
      replaceState: function (value) { return commitStaged(stageCandidate(value, true)); },
      reset: function () { return commit(emptyState(nowIso())); }
    });
  }

  return Object.freeze({
    SCHEMA: SCHEMA,
    VERSION: VERSION,
    DEFAULT_KEY: DEFAULT_KEY,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    createStore: createStore,
    memoryStorage: memoryStorage,
    normalizeCameraId: normalizeCameraId,
    decodeImportBytes: decodeImportBytes,
    normalizeSnapshot: normalizeSnapshot,
    migratePayload: migratePayload,
    validatePayload: validatePayload
  });
});
