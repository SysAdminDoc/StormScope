/* Device-local camera family failure ledger. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeCameraQuarantine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'stormscope-camera-quarantine-v1';
  var TTL_MS = 6 * 60 * 60 * 1000;
  var MAX_FAMILIES = 256;
  var MAX_SAMPLES_PER_FAMILY = 12;
  var MIN_SAMPLES = 3;
  var MIN_FAILURE_RATE = 0.6;
  var FAILURE_OUTCOMES = Object.freeze(['likely_outage', 'unavailable', 'unsupported']);

  function text(value, maximum, fallback) {
    var result = String(value == null ? '' : value).trim();
    return result && result.length <= maximum ? result : fallback;
  }

  function familyKey(camera) {
    var source = text(camera && camera.source, 64, 'unknown');
    var family = text(camera && camera.provider, 160, source);
    return source + '|' + family;
  }

  function isFailureOutcome(outcome) {
    return FAILURE_OUTCOMES.indexOf(String(outcome || '')) !== -1;
  }

  function markedForReview(samples) {
    var values = Array.isArray(samples) ? samples : [];
    var failures = values.filter(Boolean).length;
    return values.length >= MIN_SAMPLES && failures >= 2 && failures / values.length >= MIN_FAILURE_RATE;
  }

  function summary(key, record) {
    var samples = Array.isArray(record.samples) ? record.samples.slice() : [];
    var failures = samples.filter(Boolean).length;
    return {
      key: key,
      source: record.source,
      family: record.family,
      samples: samples,
      attempts: samples.length,
      failures: failures,
      failureRate: samples.length ? failures / samples.length : 0,
      markedForReview: markedForReview(samples),
      lastObservedAt: record.last_observed_at,
      lastFailureAt: record.last_failure_at,
      expiresAt: record.expires_at
    };
  }

  function sanitizeRecord(key, value, now) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var source = text(value.source, 64, '');
    var family = text(value.family, 160, '');
    var samples = Array.isArray(value.samples) ? value.samples.filter(function (sample) {
      return typeof sample === 'boolean';
    }).slice(-MAX_SAMPLES_PER_FAMILY) : [];
    var expiresAt = Number(value.expires_at);
    var lastObservedAt = Number(value.last_observed_at);
    if (!source || !family || !samples.length || !Number.isFinite(expiresAt) || expiresAt <= now ||
        !Number.isFinite(lastObservedAt) || key !== source + '|' + family) return null;
    var lastFailureAt = value.last_failure_at == null ? null : Number(value.last_failure_at);
    if (lastFailureAt !== null && !Number.isFinite(lastFailureAt)) lastFailureAt = null;
    return {
      source: source,
      family: family,
      samples: samples,
      last_observed_at: lastObservedAt,
      last_failure_at: lastFailureAt,
      expires_at: expiresAt
    };
  }

  function create(options) {
    options = options || {};
    var storage = options.storage || null;
    var clock = typeof options.now === 'function' ? options.now : Date.now;
    var records = Object.create(null);

    function currentTime(value) {
      var time = Number(value);
      return Number.isFinite(time) ? time : Number(clock());
    }

    function save() {
      if (!storage || typeof storage.setItem !== 'function') return;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch (_error) { /* optional */ }
    }

    function prune(now) {
      var changed = false;
      Object.keys(records).forEach(function (key) {
        if (!records[key] || records[key].expires_at <= now) {
          delete records[key];
          changed = true;
        }
      });
      return changed;
    }

    function load() {
      if (!storage || typeof storage.getItem !== 'function') return;
      var now = currentTime();
      try {
        var parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        Object.keys(parsed).slice(0, MAX_FAMILIES).forEach(function (key) {
          var record = sanitizeRecord(key, parsed[key], now);
          if (record) records[key] = record;
        });
      } catch (_error) {
        records = Object.create(null);
      }
      if (prune(now)) save();
    }

    function evictOldest() {
      var keys = Object.keys(records);
      while (keys.length > MAX_FAMILIES) {
        var oldest = keys.reduce(function (candidate, key) {
          return !candidate || records[key].last_observed_at < records[candidate].last_observed_at ? key : candidate;
        }, null);
        delete records[oldest];
        keys = Object.keys(records);
      }
    }

    function get(camera, at) {
      var now = currentTime(at);
      if (prune(now)) save();
      var key = familyKey(camera);
      return records[key] ? summary(key, records[key]) : null;
    }

    function observe(camera, outcome, at) {
      if (!camera || !isFailureOutcome(outcome) && !['loaded', 'playable'].includes(String(outcome || ''))) {
        return get(camera, at);
      }
      var now = currentTime(at);
      if (prune(now)) save();
      var key = familyKey(camera);
      var source = text(camera.source, 64, 'unknown');
      var family = text(camera.provider, 160, source);
      var record = records[key];
      if (!record) {
        record = { source: source, family: family, samples: [], last_observed_at: now, last_failure_at: null, expires_at: now + TTL_MS };
        records[key] = record;
      }
      var failure = isFailureOutcome(outcome);
      record.samples = record.samples.concat(failure).slice(-MAX_SAMPLES_PER_FAMILY);
      record.last_observed_at = now;
      if (failure) record.last_failure_at = now;
      record.expires_at = now + TTL_MS;
      evictOldest();
      save();
      return summary(key, record);
    }

    function summarize(source, at) {
      var now = currentTime(at);
      if (prune(now)) save();
      var selected = String(source || '').trim();
      var values = Object.keys(records).map(function (key) { return summary(key, records[key]); })
        .filter(function (record) { return !selected || record.source === selected; });
      return {
        families: values.length,
        markedForReview: values.filter(function (record) { return record.markedForReview; }).length,
        failures: values.reduce(function (total, record) { return total + record.failures; }, 0),
        records: values
      };
    }

    load();
    return Object.freeze({
      get: get,
      observe: observe,
      summarize: summarize,
      isUnderReview: function (camera, at) {
        var record = get(camera, at);
        return Boolean(record && record.markedForReview);
      }
    });
  }

  return Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    TTL_MS: TTL_MS,
    MAX_FAMILIES: MAX_FAMILIES,
    MAX_SAMPLES_PER_FAMILY: MAX_SAMPLES_PER_FAMILY,
    MIN_SAMPLES: MIN_SAMPLES,
    MIN_FAILURE_RATE: MIN_FAILURE_RATE,
    FAILURE_OUTCOMES: FAILURE_OUTCOMES,
    familyKey: familyKey,
    isFailureOutcome: isFailureOutcome,
    create: create
  });
}));
