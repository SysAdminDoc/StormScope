(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StormScopeDiagnostics = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'stormscope-diagnostics-v1';
  var MAX_ERRORS = 50;
  var MAX_STARTUP_MS = 10 * 60 * 1000;

  function redact(value) {
    return String(value == null ? '' : value)
      .replace(/https?:\/\/[^\s)\]}>'"]+/gi, '[url]')
      .replace(/-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, '[coordinates]')
      .slice(0, 2000);
  }

  function diagnosticCount(value) {
    var count = Math.floor(Number(value));
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  function boundedMilliseconds(value) {
    var milliseconds = Number(value);
    return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_STARTUP_MS
      ? Math.round(milliseconds) : null;
  }

  function allowedValue(value, allowed, fallback) {
    return allowed.indexOf(value) === -1 ? fallback : value;
  }

  function startupSummary(value) {
    var source = value && typeof value === 'object' ? value : {};
    var entries = Array.isArray(source.navigationEntries) ? source.navigationEntries : [];
    var navigation = null;
    for (var index = 0; index < entries.length && !navigation; index += 1) {
      var entry = entries[index];
      if (!entry || typeof entry !== 'object') continue;
      var responseStart = boundedMilliseconds(entry.responseStart);
      var domContentLoaded = boundedMilliseconds(entry.domContentLoadedEventEnd);
      var loadEvent = boundedMilliseconds(entry.loadEventEnd);
      var duration = boundedMilliseconds(entry.duration);
      if ([responseStart, domContentLoaded, loadEvent, duration].every(function (timing) { return timing == null; })) continue;
      navigation = {
        available: true,
        type: allowedValue(entry.type, ['navigate', 'reload', 'back_forward', 'prerender'], 'unknown'),
        response_start_ms: responseStart,
        dom_content_loaded_ms: domContentLoaded,
        load_event_ms: loadEvent,
        duration_ms: duration
      };
    }
    var camera = source.camera && typeof source.camera === 'object' ? source.camera : {};
    var dataMode = source.dataMode && typeof source.dataMode === 'object' ? source.dataMode : {};
    var worker = source.serviceWorker && typeof source.serviceWorker === 'object' ? source.serviceWorker : {};
    var preload = worker.navigationPreload && typeof worker.navigationPreload === 'object'
      ? worker.navigationPreload : {};
    return {
      navigation: navigation || { available: false },
      camera: {
        first_batch_ms: boundedMilliseconds(camera.firstBatchMs),
        complete_ms: boundedMilliseconds(camera.completeMs),
        source: allowedValue(camera.source, ['shards', 'monolith', 'index-only'], null),
        deferred: Boolean(camera.deferred)
      },
      data_mode: {
        preference: allowedValue(dataMode.preference, ['auto', 'standard', 'low'], 'auto'),
        effective: dataMode.enabled ? 'low' : 'standard',
        source: allowedValue(dataMode.source, ['standard', 'manual', 'save-data'], 'standard')
      },
      service_worker: {
        supported: Boolean(worker.supported),
        controlled: Boolean(worker.controlled),
        state: allowedValue(worker.state, ['installing', 'installed', 'activating', 'activated', 'redundant'], null),
        navigation_preload: { supported: Boolean(preload.supported), enabled: Boolean(preload.enabled) }
      },
      dropped_navigation_entries: diagnosticCount(entries.length - (navigation ? 1 : 0))
    };
  }

  function cameraIngestionSummary(value) {
    if (!value || value.schema_version !== 1 || !Array.isArray(value.providers)) {
      return { available: false };
    }
    var statuses = ['fresh', 'retained', 'failed', 'unknown'];
    var failures = [
      'authentication_required', 'confirmed_dead', 'empty_snapshot', 'incomplete_snapshot',
      'location_ambiguous', 'placeholder', 'provider_error', 'rate_limited',
      'scheduled_offline', 'transient_network', 'unsupported_embed'
    ];
    var providers = value.providers.slice(0, 256).map(function (record) {
      record = record || {};
      return {
        name: redact(record.name).slice(0, 160),
        family: redact(record.family).slice(0, 64),
        status: statuses.indexOf(record.status) === -1 ? 'unknown' : record.status,
        last_attempt_at: typeof record.last_attempt_at === 'string' && Number.isFinite(Date.parse(record.last_attempt_at))
          ? record.last_attempt_at : null,
        last_success_at: typeof record.last_success_at === 'string' && Number.isFinite(Date.parse(record.last_success_at))
          ? record.last_success_at : null,
        fetched_count: diagnosticCount(record.fetched_count),
        retained_count: diagnosticCount(record.retained_count),
        replaced_count: diagnosticCount(record.replaced_count),
        previous_count: diagnosticCount(record.previous_count),
        final_count: diagnosticCount(record.final_count),
        coverage_delta: Number.isSafeInteger(record.coverage_delta) ? record.coverage_delta : 0,
        failure_class: failures.indexOf(record.failure_class) === -1 ? null : record.failure_class
      };
    });
    return {
      available: true,
      schema_version: 1,
      generated_at: typeof value.generated_at === 'string' && Number.isFinite(Date.parse(value.generated_at))
        ? value.generated_at : null,
      providers: providers
    };
  }

  function create(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    var errors = [];
    var droppedErrors = 0;
    try {
      var saved = JSON.parse(storage && storage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) {
        droppedErrors = Math.max(0, saved.length - MAX_ERRORS);
        errors = saved.slice(-MAX_ERRORS);
      }
    } catch (_error) { errors = []; }

    function persist() {
      try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(errors)); } catch (_error) { /* optional */ }
    }

    function capture(error, type) {
      var source = error instanceof Error ? error : new Error(String(error == null ? 'Unknown error' : error));
      var record = {
        timestamp: new Date().toISOString(),
        type: type || 'error',
        name: redact(source.name || 'Error'),
        message: redact(source.message),
        stack: redact(source.stack || '')
      };
      errors.push(record);
      if (errors.length > MAX_ERRORS) droppedErrors += errors.length - MAX_ERRORS;
      errors = errors.slice(-MAX_ERRORS);
      persist();
      return record;
    }

    function install(target, onFatal) {
      target.addEventListener('error', function (event) {
        var record = capture(event.error || event.message, 'error');
        if (onFatal) onFatal(record);
      });
      target.addEventListener('unhandledrejection', function (event) {
        var record = capture(event.reason, 'unhandledrejection');
        if (onFatal) onFatal(record);
      });
    }

    function report(context) {
      context = context || {};
      var ingestion = cameraIngestionSummary(context.cameraIngestion);
      var startup = startupSummary(context.startup);
      return {
        schema: 1,
        exported_at: new Date().toISOString(),
        app_version: String(context.appVersion || 'unknown'),
        corpus_generation: context.corpusGeneration || null,
        camera_ingestion: ingestion,
        startup: startup,
        providers: context.providers || {},
        local_overlays: {
          count: Math.max(0, Math.floor(Number(context.localOverlays && context.localOverlays.count) || 0)),
          bytes: Math.max(0, Math.floor(Number(context.localOverlays && context.localOverlays.bytes) || 0))
        },
        cache: context.cache || null,
        dropped_entries: {
          errors: droppedErrors,
          navigation: startup.dropped_navigation_entries,
          camera_ingestion_providers: ingestion.available
            ? diagnosticCount(context.cameraIngestion.providers.length - ingestion.providers.length) : 0
        },
        errors: errors.slice()
      };
    }

    return Object.freeze({ capture: capture, getErrors: function () { return errors.slice(); }, install: install, report: report });
  }

  return Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    MAX_ERRORS: MAX_ERRORS,
    MAX_STARTUP_MS: MAX_STARTUP_MS,
    cameraIngestionSummary: cameraIngestionSummary,
    create: create,
    redact: redact,
    startupSummary: startupSummary
  });
}));
