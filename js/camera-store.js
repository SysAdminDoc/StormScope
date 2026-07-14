(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StormScopeCameraStore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var HEALTH_RANK = { healthy: 0, unknown: 1, degraded: 2, offline: 3 };
  var SOURCE_HEALTH_STATUSES = ['fresh', 'retained', 'failed', 'unknown'];
  var SOURCE_HEALTH_FAILURE_CLASSES = new Set([
    'authentication_required', 'confirmed_dead', 'empty_snapshot', 'incomplete_snapshot',
    'location_ambiguous', 'placeholder', 'provider_error', 'rate_limited',
    'scheduled_offline', 'transient_network', 'unsupported_embed'
  ]);
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

  function bearingDegrees(origin, camera) {
    var radians = Math.PI / 180;
    var lat1 = Number(origin.lat) * radians;
    var lat2 = Number(camera.lat) * radians;
    var deltaLon = (Number(camera.lon) - Number(origin.lon)) * radians;
    var y = Math.sin(deltaLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return (Math.atan2(y, x) / radians + 360) % 360;
  }

  function nearestVerifiedCameras(cameras, origin, limit) {
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) return [];
    var maximum = Math.max(1, Math.min(20, Number(limit) || 3));
    return (cameras || []).filter(function (camera) {
      return camera && camera.health === 'healthy' && !Number.isNaN(Date.parse(camera.last_verified)) &&
        Number.isFinite(Number(camera.lat)) && Number.isFinite(Number(camera.lon));
    }).map(function (camera) {
      return { camera: camera, distanceKm: distanceKm(origin, camera), bearing: bearingDegrees(origin, camera) };
    }).sort(function (left, right) {
      return left.distanceKm - right.distanceKm ||
        Date.parse(right.camera.last_verified) - Date.parse(left.camera.last_verified) ||
        String(left.camera.name || '').localeCompare(String(right.camera.name || ''), undefined, { sensitivity: 'base' }) ||
        Number(left.camera.id || 0) - Number(right.camera.id || 0);
    }).slice(0, maximum);
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

  function sourceHealthTimestamp(value, nullable) {
    if (nullable && value == null) return null;
    if (typeof value !== 'string' || !value || value.length > 40 ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error('Camera source-health timestamp is invalid');
    }
    return value;
  }

  function sourceHealthCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Camera source-health count is invalid: ' + label);
    }
    return value;
  }

  function validateSourceHealth(value) {
    if (!value || value.schema_version !== 1 || !Array.isArray(value.providers) || value.providers.length > 256) {
      throw new Error('Camera source-health artifact is invalid');
    }
    var generatedAt = sourceHealthTimestamp(value.generated_at, false);
    var names = new Set();
    var totals = { fresh: 0, retained: 0, failed: 0, unknown: 0 };
    var providers = value.providers.map(function (record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Camera source-health provider is invalid');
      }
      var name = typeof record.name === 'string' ? record.name.trim() : '';
      var family = typeof record.family === 'string' ? record.family.trim() : '';
      if (!name || name.length > 160 || names.has(name) || !family || family.length > 64 ||
          SOURCE_HEALTH_STATUSES.indexOf(record.status) === -1) {
        throw new Error('Camera source-health provider metadata is invalid');
      }
      names.add(name);
      var cameraSources = Array.isArray(record.camera_sources) ? record.camera_sources.slice() : [];
      if (cameraSources.length > 32 || cameraSources.some(function (source) {
        return typeof source !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(source);
      }) || cameraSources.join('\n') !== Array.from(new Set(cameraSources)).sort().join('\n')) {
        throw new Error('Camera source-health source taxonomy is invalid');
      }
      function sourceCounts(field) {
        var raw = record[field];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(function (source) {
          return cameraSources.indexOf(source) === -1 || !Number.isSafeInteger(raw[source]) || raw[source] < 0;
        })) {
          throw new Error('Camera source-health source counts are invalid');
        }
        return Object.freeze(Object.keys(raw).sort().reduce(function (result, source) {
          result[source] = raw[source];
          return result;
        }, {}));
      }
      var previousCameraSourceCounts = sourceCounts('previous_camera_source_counts');
      var cameraSourceCounts = sourceCounts('camera_source_counts');
      if (cameraSources.some(function (source) {
        return !Object.hasOwn(previousCameraSourceCounts, source) && !Object.hasOwn(cameraSourceCounts, source);
      })) {
        throw new Error('Camera source-health taxonomy does not match source counts');
      }
      var previousCount = sourceHealthCount(record.previous_count, name + '.previous_count');
      var finalCount = sourceHealthCount(record.final_count, name + '.final_count');
      var fetchedCount = sourceHealthCount(record.fetched_count, name + '.fetched_count');
      var retainedCount = sourceHealthCount(record.retained_count, name + '.retained_count');
      var replacedCount = sourceHealthCount(record.replaced_count, name + '.replaced_count');
      var coverageDelta = record.coverage_delta;
      if (!Number.isSafeInteger(coverageDelta) || coverageDelta !== finalCount - previousCount ||
          retainedCount > finalCount || replacedCount > previousCount) {
        throw new Error('Camera source-health coverage counts are inconsistent');
      }
      if (Object.values(previousCameraSourceCounts).reduce(function (sum, count) { return sum + count; }, 0) !== previousCount ||
          Object.values(cameraSourceCounts).reduce(function (sum, count) { return sum + count; }, 0) !== finalCount) {
        throw new Error('Camera source-health source counts do not match provider totals');
      }
      var expectedPercent = previousCount ? Math.round(coverageDelta * 10000 / previousCount) / 100 : null;
      if (record.coverage_delta_percent !== expectedPercent) {
        throw new Error('Camera source-health coverage percentage is inconsistent');
      }
      var failureClass = record.failure_class == null ? null : record.failure_class;
      if (failureClass !== null && !SOURCE_HEALTH_FAILURE_CLASSES.has(failureClass)) {
        throw new Error('Camera source-health failure class is invalid');
      }
      if ((record.status === 'fresh' && failureClass !== null) ||
          ((record.status === 'retained' || record.status === 'failed') && failureClass === null) ||
          (record.status === 'retained' && (!finalCount || retainedCount !== finalCount)) ||
          (record.status === 'failed' && (finalCount || retainedCount))) {
        throw new Error('Camera source-health status is inconsistent');
      }
      var lastAttemptAt = sourceHealthTimestamp(record.last_attempt_at, true);
      var lastSuccessAt = sourceHealthTimestamp(record.last_success_at, true);
      if (record.status === 'unknown' && (lastAttemptAt !== null || lastSuccessAt !== null || fetchedCount ||
          retainedCount || replacedCount || failureClass !== null)) {
        throw new Error('Camera source-health unknown status implies refresh history');
      }
      totals[record.status] += 1;
      return Object.freeze({
        name: name,
        family: family,
        status: record.status,
        camera_sources: Object.freeze(cameraSources),
        previous_camera_source_counts: previousCameraSourceCounts,
        camera_source_counts: cameraSourceCounts,
        last_attempt_at: lastAttemptAt,
        last_success_at: lastSuccessAt,
        fetched_count: fetchedCount,
        retained_count: retainedCount,
        replaced_count: replacedCount,
        previous_count: previousCount,
        final_count: finalCount,
        coverage_delta: coverageDelta,
        coverage_delta_percent: expectedPercent,
        failure_class: failureClass
      });
    });
    if (providers.map(function (record) { return record.name; }).join('\n') !==
        providers.map(function (record) { return record.name; }).sort(function (left, right) {
          return left.localeCompare(right, undefined, { sensitivity: 'base' });
        }).join('\n')) {
      throw new Error('Camera source-health providers are not sorted');
    }
    var rawTotals = value.totals;
    if (!rawTotals || typeof rawTotals !== 'object' || Array.isArray(rawTotals)) {
      throw new Error('Camera source-health totals are invalid');
    }
    SOURCE_HEALTH_STATUSES.forEach(function (status) {
      if (rawTotals[status] !== totals[status]) throw new Error('Camera source-health status totals are inconsistent');
    });
    var cameras = sourceHealthCount(rawTotals.cameras, 'totals.cameras');
    var retainedCameras = sourceHealthCount(rawTotals.retained_cameras, 'totals.retained_cameras');
    if (!Number.isSafeInteger(rawTotals.coverage_delta) ||
        cameras !== providers.reduce(function (sum, record) { return sum + record.final_count; }, 0) ||
        retainedCameras !== providers.reduce(function (sum, record) { return sum + record.retained_count; }, 0) ||
        rawTotals.coverage_delta !== providers.reduce(function (sum, record) { return sum + record.coverage_delta; }, 0)) {
      throw new Error('Camera source-health totals do not match providers');
    }
    return Object.freeze({
      schema_version: 1,
      generated_at: generatedAt,
      providers: Object.freeze(providers),
      totals: Object.freeze(Object.assign({}, totals, {
        cameras: cameras,
        retained_cameras: retainedCameras,
        coverage_delta: rawTotals.coverage_delta
      }))
    });
  }

  function summarizeSourceHealth(value, source) {
    if (!value || !Array.isArray(value.providers)) return null;
    var selected = lower(source).trim();
    var providers = value.providers.filter(function (record) {
      return !selected || record.camera_sources.indexOf(selected) !== -1;
    });
    if (!providers.length) return null;
    var summary = {
      providerCount: providers.length,
      fresh: 0,
      retained: 0,
      failed: 0,
      unknown: 0,
      cameras: 0,
      retainedCameras: 0,
      coverageDelta: 0,
      lastAttemptAt: null
    };
    providers.forEach(function (record) {
      summary[record.status] += 1;
      var finalCount = selected ? record.camera_source_counts[selected] || 0 : record.final_count;
      var previousCount = selected ? record.previous_camera_source_counts[selected] || 0 : record.previous_count;
      summary.cameras += finalCount;
      summary.retainedCameras += record.status === 'retained' ? finalCount : 0;
      summary.coverageDelta += finalCount - previousCount;
      if (record.last_attempt_at && (!summary.lastAttemptAt || record.last_attempt_at > summary.lastAttemptAt)) {
        summary.lastAttemptAt = record.last_attempt_at;
      }
    });
    return summary;
  }

  function isSha256(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  function hexBytes(value) {
    var bytes = new Uint8Array(value.length / 2);
    for (var index = 0; index < bytes.length; index += 1) {
      bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function sumTotals(totals) {
    if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return NaN;
    return Object.keys(totals).reduce(function (sum, key) {
      var value = totals[key];
      return sum + (Number.isInteger(value) && value >= 0 ? value : NaN);
    }, 0);
  }

  function totalsEqual(actual, expected) {
    var actualKeys = Object.keys(actual).sort();
    var expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length && actualKeys.every(function (key, index) {
      return key === expectedKeys[index] && actual[key] === expected[key];
    });
  }

  async function defaultSha256(bytes) {
    if (!globalObject.crypto || !globalObject.crypto.subtle) {
      throw new Error('SHA-256 validation is unavailable');
    }
    var digest = new Uint8Array(await globalObject.crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest).map(function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }

  function CameraStore(options) {
    options = options || {};
    this.fetch = options.fetch || (
      typeof globalObject.fetch === 'function' ? globalObject.fetch.bind(globalObject) : null
    );
    if (!this.fetch) throw new Error('CameraStore requires fetch');
    this.indexUrl = options.indexUrl || 'data/cameras.index.json';
    this.monolithUrl = options.monolithUrl || 'data/cameras.json';
    this.sourceHealthUrl = options.sourceHealthUrl || 'data/source-health.json';
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this.sha256 = options.sha256 || defaultSha256;
    this._cameras = [];
    this._index = null;
    this._controller = null;
    this._sourceHealthController = null;
    this._sourceHealth = null;
    this._requestId = 0;
  }

  CameraStore.prototype.cancel = function () {
    this._requestId += 1;
    if (this._controller) this._controller.abort();
    if (this._sourceHealthController) this._sourceHealthController.abort();
    this._controller = null;
    this._sourceHealthController = null;
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

  CameraStore.prototype._fetchText = async function (url, signal) {
    var response = await this.fetch(url, { signal: signal });
    if (!response || response.ok === false || typeof response.text !== 'function') {
      throw new Error('Unable to load camera data: ' + url);
    }
    return response.text();
  };

  CameraStore.prototype._validateIndex = function (index) {
    if (!index || index.index_version !== 2 || index.camera_schema_version !== 2 ||
        !Number.isInteger(index.total) || index.total < 0 || !Array.isArray(index.shards) ||
        !isSha256(index.dataset_sha256) ||
        index.dataset_hash_algorithm !== 'sha256-concat-shard-digests-v1' ||
        typeof index.generated_at !== 'string' || !Number.isFinite(Date.parse(index.generated_at)) ||
        sumTotals(index.health_totals) !== index.total ||
        sumTotals(index.provider_totals) !== index.total ||
        !Number.isInteger(index.verified_total) || index.verified_total < 0 ||
        index.verified_total > index.total) {
      throw new Error('Camera index is invalid');
    }
    var describedTotal = 0;
    var previousLastId = 0;
    index.shards.forEach(function (descriptor, position) {
      if (!descriptor || descriptor.id !== String(position + 1).padStart(4, '0') ||
          typeof descriptor.path !== 'string' ||
          descriptor.path.indexOf('?generation=' + index.dataset_sha256) === -1 ||
          !Number.isInteger(descriptor.count) || descriptor.count <= 0 ||
          !Number.isInteger(descriptor.first_id) || !Number.isInteger(descriptor.last_id) ||
          descriptor.first_id <= previousLastId || descriptor.last_id < descriptor.first_id ||
          !isSha256(descriptor.sha256)) {
        throw new Error('Camera shard descriptor is invalid: ' + (descriptor && descriptor.id || position));
      }
      describedTotal += descriptor.count;
      previousLastId = descriptor.last_id;
    });
    if (describedTotal !== index.total) throw new Error('Camera shard descriptors do not match index total');
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
    return { cameras: this.getCameras(), source: 'monolith', index: null, complete: true };
  };

  CameraStore.prototype._loadShards = async function (index, requestId, signal, options) {
    var seenIds = new Set();
    var healthTotals = {};
    var providerTotals = {};
    var verifiedTotal = 0;
    var shardHashes = [];
    var previousId = 0;
    for (var shardIndex = 0; shardIndex < index.shards.length; shardIndex += 1) {
      this._assertActive(requestId, signal);
      var descriptor = index.shards[shardIndex];
      var shardUrl = relativeUrl(this.indexUrl, descriptor.path);
      var shardText = await this._fetchText(shardUrl, signal);
      this._assertActive(requestId, signal);
      var shardHash = await this.sha256(new TextEncoder().encode(shardText));
      this._assertActive(requestId, signal);
      if (shardHash !== descriptor.sha256) throw new Error('Camera shard hash mismatch: ' + descriptor.id);
      var shard = JSON.parse(shardText);
      if (!Array.isArray(shard) || shard.length !== descriptor.count) {
        throw new Error('Camera shard is invalid: ' + descriptor.id);
      }
      shard.forEach(function (camera) {
        if (!Number.isInteger(camera.id) || camera.id <= previousId || seenIds.has(camera.id)) {
          throw new Error('Camera IDs are not strictly increasing: ' + camera.id);
        }
        previousId = camera.id;
        seenIds.add(camera.id);
        var health = String(camera.health || 'unknown');
        var provider = String(camera.provider || 'unattributed');
        healthTotals[health] = (healthTotals[health] || 0) + 1;
        providerTotals[provider] = (providerTotals[provider] || 0) + 1;
        if (camera.last_verified != null) verifiedTotal += 1;
      });
      if (shard[0].id !== descriptor.first_id || shard[shard.length - 1].id !== descriptor.last_id) {
        throw new Error('Camera shard ID range mismatch: ' + descriptor.id);
      }
      shardHashes.push(hexBytes(shardHash));
      this._cameras.push.apply(this._cameras, shard);
      this._progress(options.onProgress, {
        source: 'shards', loaded: this._cameras.length, total: index.total,
        shardsLoaded: shardIndex + 1, shardsTotal: index.shards.length, complete: false
      });
    }
    if (this._cameras.length !== index.total) throw new Error('Camera shard total does not match index');
    var aggregateBytes = new Uint8Array(shardHashes.length * 32);
    shardHashes.forEach(function (hash, position) { aggregateBytes.set(hash, position * 32); });
    if (await this.sha256(aggregateBytes) !== index.dataset_sha256) throw new Error('Camera dataset hash mismatch');
    if (!totalsEqual(healthTotals, index.health_totals) ||
        !totalsEqual(providerTotals, index.provider_totals) || verifiedTotal !== index.verified_total) {
      throw new Error('Camera verification summaries do not match the generation');
    }
    this._progress(options.onProgress, {
      source: 'shards', loaded: this._cameras.length, total: index.total,
      shardsLoaded: index.shards.length, shardsTotal: index.shards.length, complete: true
    });
    this._assertActive(requestId, signal);
    return { cameras: this.getCameras(), source: 'shards', index: index, complete: true };
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
      this._validateIndex(index);
      this._index = index;
      if (options.deferShards) {
        return { cameras: [], source: 'index-only', index: index, complete: false };
      }
      return await this._loadShards(index, requestId, signal, options);
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

  CameraStore.prototype.resume = async function (options) {
    options = options || {};
    if (!this._index) return this.load(options);
    this.cancel();
    var requestId = this._requestId;
    var controller = new AbortController();
    var signal = controller.signal;
    this._controller = controller;
    this._cameras = [];
    try {
      return await this._loadShards(this._index, requestId, signal, options);
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

  CameraStore.prototype.loadCameraById = async function (id) {
    id = Number(id);
    if (!Number.isInteger(id) || !this._index) return null;
    var descriptor = this._index.shards.find(function (item) {
      return id >= item.first_id && id <= item.last_id;
    });
    if (!descriptor) return null;
    var controller = new AbortController();
    var text = await this._fetchText(relativeUrl(this.indexUrl, descriptor.path), controller.signal);
    var hash = await this.sha256(new TextEncoder().encode(text));
    if (hash !== descriptor.sha256) throw new Error('Camera shard hash mismatch: ' + descriptor.id);
    var shard = JSON.parse(text);
    if (!Array.isArray(shard) || shard.length !== descriptor.count ||
        shard[0].id !== descriptor.first_id || shard[shard.length - 1].id !== descriptor.last_id) {
      throw new Error('Camera shard is invalid: ' + descriptor.id);
    }
    var camera = shard.find(function (item) { return item.id === id; }) || null;
    if (camera && !this._cameras.some(function (item) { return item.id === id; })) this._cameras.push(camera);
    return camera;
  };

  CameraStore.prototype.getCameras = function () {
    return this._cameras.slice();
  };

  CameraStore.prototype.loadSourceHealth = async function () {
    if (this._sourceHealthController) this._sourceHealthController.abort();
    var controller = new AbortController();
    this._sourceHealthController = controller;
    try {
      var value = await this._fetchJson(this.sourceHealthUrl, controller.signal);
      if (controller.signal.aborted) throw abortError();
      this._sourceHealth = validateSourceHealth(value);
      return this._sourceHealth;
    } finally {
      if (this._sourceHealthController === controller) this._sourceHealthController = null;
    }
  };

  CameraStore.prototype.getSourceHealth = function () {
    return this._sourceHealth;
  };

  CameraStore.prototype.search = function (filters, sortOptions) {
    return searchCameras(this._cameras, filters, sortOptions);
  };

  return {
    CameraStore: CameraStore,
    HEALTH_RANK: HEALTH_RANK,
    calculateVirtualWindow: calculateVirtualWindow,
    distanceKm: distanceKm,
    nearestVerifiedCameras: nearestVerifiedCameras,
    summarizeSourceHealth: summarizeSourceHealth,
    validateSourceHealth: validateSourceHealth,
    filterCameras: filterCameras,
    searchCameras: searchCameras,
    sortCameras: sortCameras,
    virtualize: virtualize
  };
}));
