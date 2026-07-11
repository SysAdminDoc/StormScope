(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StormScopeCameraStore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var HEALTH_RANK = { healthy: 0, unknown: 1, degraded: 2, offline: 3 };
  var globalObject = typeof globalThis !== 'undefined' ? globalThis : {};

  function abortError() {
    var error = new Error('Camera loading was cancelled');
    error.name = 'AbortError';
    return error;
  }

  function lower(value) {
    return String(value == null ? '' : value).toLocaleLowerCase();
  }

  function matches(value, expected) {
    var needle = lower(expected).trim();
    return !needle || lower(value).indexOf(needle) !== -1;
  }

  function valueSet(value) {
    if (value == null || value === '') return null;
    var values = Array.isArray(value) ? value : [value];
    return new Set(values.map(lower));
  }

  function filterCameras(cameras, filters) {
    filters = filters || {};
    var sources = valueSet(filters.source);
    var types = valueSet(filters.type);
    var query = lower(filters.query).trim();
    return cameras.filter(function (camera) {
      var road = camera.road || camera.name || '';
      if (!matches(camera.name, filters.name)) return false;
      if (!matches(road, filters.road)) return false;
      if (!matches(camera.state, filters.state)) return false;
      if (!matches(camera.county, filters.county)) return false;
      if (sources && !sources.has(lower(camera.source))) return false;
      if (types && !types.has(lower(camera.type))) return false;
      if (filters.healthy === true && camera.health !== 'healthy') return false;
      if (query) {
        var searchable = [
          camera.name,
          road,
          camera.state,
          camera.county,
          camera.source,
          camera.type
        ].map(lower).join('\n');
        if (searchable.indexOf(query) === -1) return false;
      }
      return true;
    });
  }

  function distanceKm(origin, camera) {
    if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) return Infinity;
    if (!Number.isFinite(Number(camera.lat)) || !Number.isFinite(Number(camera.lon))) return Infinity;
    var radians = Math.PI / 180;
    var lat1 = origin.lat * radians;
    var lat2 = Number(camera.lat) * radians;
    var deltaLat = (Number(camera.lat) - origin.lat) * radians;
    var deltaLon = (Number(camera.lon) - origin.lon) * radians;
    var a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function sortCameras(cameras, options) {
    options = options || {};
    var sortBy = options.sortBy || 'name';
    var healthFirst = options.healthFirst !== false;
    return cameras.slice().sort(function (left, right) {
      if (healthFirst) {
        var healthDifference = (HEALTH_RANK[left.health] == null ? 4 : HEALTH_RANK[left.health]) -
          (HEALTH_RANK[right.health] == null ? 4 : HEALTH_RANK[right.health]);
        if (healthDifference) return healthDifference;
      }
      if (sortBy === 'distance') {
        var leftDistance = distanceKm(options.origin, left);
        var rightDistance = distanceKm(options.origin, right);
        if (leftDistance < rightDistance) return -1;
        if (leftDistance > rightDistance) return 1;
      }
      var nameDifference = String(left.name || '').localeCompare(String(right.name || ''), undefined, {
        sensitivity: 'base', numeric: true
      });
      if (nameDifference) return nameDifference;
      return Number(left.id || 0) - Number(right.id || 0);
    });
  }

  function searchCameras(cameras, filters, sortOptions) {
    return sortCameras(filterCameras(cameras, filters), sortOptions);
  }

  function calculateVirtualWindow(options) {
    options = options || {};
    var total = Math.max(0, Math.floor(Number(options.total) || 0));
    var itemHeight = Number(options.itemHeight);
    if (!(itemHeight > 0)) throw new RangeError('itemHeight must be greater than zero');
    var viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
    var maximumScroll = Math.max(0, total * itemHeight - viewportHeight);
    var scrollTop = Math.min(maximumScroll, Math.max(0, Number(options.scrollTop) || 0));
    var overscan = Math.max(0, Math.floor(Number(options.overscan) || 0));
    var visibleStart = Math.min(total, Math.floor(scrollTop / itemHeight));
    var visibleEnd = Math.min(total, Math.ceil((scrollTop + viewportHeight) / itemHeight));
    var start = Math.max(0, visibleStart - overscan);
    var end = Math.min(total, visibleEnd + overscan);
    return {
      start: start,
      end: end,
      visibleStart: visibleStart,
      visibleEnd: visibleEnd,
      offsetTop: start * itemHeight,
      offsetBottom: (total - end) * itemHeight,
      totalHeight: total * itemHeight
    };
  }

  function virtualize(items, options) {
    var window = calculateVirtualWindow(Object.assign({}, options, { total: items.length }));
    return Object.assign({ items: items.slice(window.start, window.end) }, window);
  }

  function relativeUrl(base, path) {
    if (/^(?:[a-z]+:)?\/\//i.test(path) || path.charAt(0) === '/') return path;
    var separator = base.lastIndexOf('/');
    return (separator === -1 ? '' : base.slice(0, separator + 1)) + path;
  }

  function responseJson(response, url) {
    if (!response || response.ok === false || typeof response.json !== 'function') {
      throw new Error('Unable to load camera data: ' + url);
    }
    return response.json();
  }

  function CameraStore(options) {
    options = options || {};
    this.fetch = options.fetch || (
      typeof globalObject.fetch === 'function' ? globalObject.fetch.bind(globalObject) : null
    );
    if (!this.fetch) throw new Error('CameraStore requires fetch');
    this.indexUrl = options.indexUrl || 'data/cameras.index.json';
    this.monolithUrl = options.monolithUrl || 'data/cameras.json';
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this._cameras = [];
    this._controller = null;
    this._requestId = 0;
  }

  CameraStore.prototype.cancel = function () {
    this._requestId += 1;
    if (this._controller) this._controller.abort();
    this._controller = null;
  };

  CameraStore.prototype._assertActive = function (requestId, signal) {
    if (requestId !== this._requestId || signal.aborted) throw abortError();
  };

  CameraStore.prototype._progress = function (callback, detail) {
    [this.onProgress, callback].forEach(function (listener, index, listeners) {
      if (typeof listener !== 'function' || (index && listener === listeners[0])) return;
      try { listener(detail); } catch (_error) { /* progress observers cannot break loading */ }
    });
  };

  CameraStore.prototype._fetchJson = async function (url, signal) {
    var response = await this.fetch(url, { signal: signal });
    return responseJson(response, url);
  };

  CameraStore.prototype._loadMonolith = async function (requestId, signal, callback, cause) {
    this._assertActive(requestId, signal);
    var cameras = await this._fetchJson(this.monolithUrl, signal);
    this._assertActive(requestId, signal);
    if (!Array.isArray(cameras)) throw new Error('Camera monolith must be an array');
    this._cameras = cameras.slice();
    this._progress(callback, {
      source: 'monolith', loaded: cameras.length, total: cameras.length,
      shardsLoaded: 0, shardsTotal: 0, complete: true, fallbackCause: cause || null
    });
    return { cameras: this.getCameras(), source: 'monolith', index: null };
  };

  CameraStore.prototype.load = async function (options) {
    options = options || {};
    this.cancel();
    var requestId = this._requestId;
    var controller = new AbortController();
    var signal = controller.signal;
    this._controller = controller;
    this._cameras = [];
    try {
      var index = await this._fetchJson(this.indexUrl, signal);
      this._assertActive(requestId, signal);
      if (!index || !Array.isArray(index.shards) || !Number.isInteger(index.total)) {
        throw new Error('Camera index is invalid');
      }
      var seenIds = new Set();
      for (var shardIndex = 0; shardIndex < index.shards.length; shardIndex += 1) {
        this._assertActive(requestId, signal);
        var descriptor = index.shards[shardIndex];
        var shardUrl = relativeUrl(this.indexUrl, descriptor.path);
        var shard = await this._fetchJson(shardUrl, signal);
        this._assertActive(requestId, signal);
        if (!Array.isArray(shard) || shard.length !== descriptor.count) {
          throw new Error('Camera shard is invalid: ' + descriptor.id);
        }
        shard.forEach(function (camera) {
          if (seenIds.has(camera.id)) throw new Error('Duplicate camera ID across shards: ' + camera.id);
          seenIds.add(camera.id);
        });
        this._cameras.push.apply(this._cameras, shard);
        this._progress(options.onProgress, {
          source: 'shards', loaded: this._cameras.length, total: index.total,
          shardsLoaded: shardIndex + 1, shardsTotal: index.shards.length, complete: false
        });
      }
      if (this._cameras.length !== index.total) throw new Error('Camera shard total does not match index');
      this._progress(options.onProgress, {
        source: 'shards', loaded: this._cameras.length, total: index.total,
        shardsLoaded: index.shards.length, shardsTotal: index.shards.length, complete: true
      });
      this._assertActive(requestId, signal);
      return { cameras: this.getCameras(), source: 'shards', index: index };
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      this._assertActive(requestId, signal);
      if (options.fallback === false) throw error;
      this._cameras = [];
      return this._loadMonolith(requestId, signal, options.onProgress, String(error && error.message || error));
    } finally {
      if (requestId === this._requestId) this._controller = null;
    }
  };

  CameraStore.prototype.getCameras = function () {
    return this._cameras.slice();
  };

  CameraStore.prototype.search = function (filters, sortOptions) {
    return searchCameras(this._cameras, filters, sortOptions);
  };

  return {
    CameraStore: CameraStore,
    HEALTH_RANK: HEALTH_RANK,
    calculateVirtualWindow: calculateVirtualWindow,
    distanceKm: distanceKm,
    filterCameras: filterCameras,
    searchCameras: searchCameras,
    sortCameras: sortCameras,
    virtualize: virtualize
  };
}));
