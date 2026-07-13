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
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  var LAYER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
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

  function finiteNumber(value, label) {
    var number = Number(value);
    if (!isFinite(number)) throw new TypeError(label + ' must be a finite number');
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

  function normalizeFavorites(value) {
    var source;
    if (value == null) source = [];
    else if (Array.isArray(value)) source = value;
    else if (typeof value === 'object') {
      source = Object.keys(value).filter(function (key) { return Boolean(value[key]); });
    } else throw new TypeError('favorites must be an array or object');
    if (source.length > MAX_FAVORITES) throw new RangeError('favorites exceed the supported limit');
    var seen = Object.create(null);
    var result = [];
    source.forEach(function (value) {
      var id = normalizeCameraId(value);
      if (!seen[id]) {
        seen[id] = true;
        result.push(id);
      }
    });
    return result;
  }

  function normalizeCenter(value, fallback) {
    var source = value || fallback;
    objectValue(source, 'view center');
    var latitude = finiteNumber(own(source, 'lat') ? source.lat : source.latitude, 'latitude');
    var longitude = finiteNumber(own(source, 'lon') ? source.lon : (own(source, 'lng') ? source.lng : source.longitude), 'longitude');
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

  function normalizeOpacityMap(value) {
    if (value == null) return {};
    var source = objectValue(value, 'view opacity');
    var result = {};
    Object.keys(source).sort().forEach(function (key) {
      if (!LAYER_PATTERN.test(key)) throw new TypeError('view opacity contains an invalid key');
      var opacity = finiteNumber(source[key], 'view opacity.' + key);
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

  function normalizeWorkflow(source, snapshot) {
    if (source.radar != null) {
      var radar = objectValue(source.radar, 'view radar');
      var palette = boundedString(radar.palette, 'view radar palette', 20);
      var speed = finiteNumber(radar.speed, 'view radar speed');
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
      var outlookDay = finiteNumber(source.outlookDay, 'view outlook day');
      if (!Number.isInteger(outlookDay) || outlookDay < 1 || outlookDay > 3) {
        throw new TypeError('view outlook day is invalid');
      }
      snapshot.outlookDay = outlookDay;
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

  function normalizeSnapshot(value) {
    var source = objectValue(value, 'view');
    var map = source.map && typeof source.map === 'object' ? source.map : source;
    var center = normalizeCenter(source.center || map.center, map);
    var zoom = finiteNumber(own(source, 'zoom') ? source.zoom : map.zoom, 'zoom');
    if (zoom < 0 || zoom > 24) throw new RangeError('zoom must be between 0 and 24');
    return normalizeWorkflow(source, {
      center: center,
      zoom: zoom,
      layers: normalizeBooleanMap(legacyLayers(source), 'view layers'),
      opacity: normalizeOpacityMap(legacyOpacity(source))
    });
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

  function validIso(value, fallback) {
    if (typeof value !== 'string' || !isFinite(Date.parse(value))) return fallback;
    return new Date(Date.parse(value)).toISOString();
  }

  function normalizeView(value, index, nowIso) {
    var source = objectValue(value, 'saved view');
    var id = source.id == null ? 'migrated-' + (index + 1) : normalizeViewId(source.id);
    var createdAt = validIso(source.createdAt, nowIso);
    return {
      id: id,
      name: normalizeName(source.name),
      snapshot: normalizeSnapshot(source.snapshot || source.view || source),
      createdAt: createdAt,
      updatedAt: validIso(source.updatedAt, createdAt)
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
    var version = source.version == null ? 0 : Number(source.version);
    if (!Number.isInteger(version) || version < 0) throw new TypeError('saved-state version is invalid');
    if (version > VERSION) throw new RangeError('saved-state version is newer than this app supports');
    if (version === VERSION && source.schema !== SCHEMA) throw new TypeError('saved-state schema is invalid');

    var favorites = source.favorites;
    if (favorites == null) favorites = source.favoriteCameraIds;
    var viewSource = source.views;
    if (viewSource == null) viewSource = source.savedViews;
    if (viewSource == null) viewSource = [];
    if (!Array.isArray(viewSource)) throw new TypeError('views must be an array');
    if (viewSource.length > MAX_VIEWS) throw new RangeError('views exceed the supported limit');

    var byId = Object.create(null);
    var views = [];
    viewSource.forEach(function (view, index) {
      var normalized = normalizeView(view, index, nowIso);
      if (byId[normalized.id] != null) views[byId[normalized.id]] = normalized;
      else {
        byId[normalized.id] = views.length;
        views.push(normalized);
      }
    });

    return {
      schema: SCHEMA,
      version: VERSION,
      favorites: normalizeFavorites(favorites),
      views: views,
      lastView: source.lastView == null ? null : normalizeSnapshot(source.lastView.snapshot || source.lastView),
      updatedAt: validIso(source.updatedAt, nowIso)
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

    function commit(candidate) {
      var next = migratePayload(candidate, { nowIso: nowIso() });
      next.updatedAt = nowIso();
      var serialized = JSON.stringify(next);
      var currentRaw = readRaw(key);
      if (currentRaw != null) {
        try {
          parseRaw(currentRaw);
          storage.setItem(backupKey, currentRaw);
        } catch (error) {
          // Never replace a valid backup with corrupt primary data.
        }
      }
      storage.setItem(key, serialized);
      state = next;
      loadError = null;
      recoveredFromBackup = false;
      return clone(state);
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
      setLastView: function (snapshot) { var next = getState(); next.lastView = normalizeSnapshot(snapshot); return commit(next); },
      getLastView: function () { return state.lastView ? clone(state.lastView) : null; },
      clearLastView: function () { var next = getState(); next.lastView = null; return commit(next); },
      exportJson: function (space) { return JSON.stringify(state, null, space == null ? 2 : space); },
      importJson: function (json) {
        var imported = migratePayload(json, { nowIso: nowIso() });
        return commit(imported);
      },
      reset: function () { return commit(emptyState(nowIso())); }
    });
  }

  return Object.freeze({
    SCHEMA: SCHEMA,
    VERSION: VERSION,
    DEFAULT_KEY: DEFAULT_KEY,
    createStore: createStore,
    memoryStorage: memoryStorage,
    normalizeCameraId: normalizeCameraId,
    normalizeSnapshot: normalizeSnapshot,
    migratePayload: migratePayload,
    validatePayload: validatePayload
  });
});
