(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StormScopeDiagnostics = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'stormscope-diagnostics-v1';
  var MAX_ERRORS = 50;

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
    try {
      var saved = JSON.parse(storage && storage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) errors = saved.slice(-MAX_ERRORS);
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
      return {
        schema: 1,
        exported_at: new Date().toISOString(),
        app_version: String(context.appVersion || 'unknown'),
        corpus_generation: context.corpusGeneration || null,
        camera_ingestion: cameraIngestionSummary(context.cameraIngestion),
        providers: context.providers || {},
        local_overlays: {
          count: Math.max(0, Math.floor(Number(context.localOverlays && context.localOverlays.count) || 0)),
          bytes: Math.max(0, Math.floor(Number(context.localOverlays && context.localOverlays.bytes) || 0))
        },
        cache: context.cache || null,
        errors: errors.slice()
      };
    }

    return Object.freeze({ capture: capture, getErrors: function () { return errors.slice(); }, install: install, report: report });
  }

  return Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    MAX_ERRORS: MAX_ERRORS,
    cameraIngestionSummary: cameraIngestionSummary,
    create: create,
    redact: redact
  });
}));
