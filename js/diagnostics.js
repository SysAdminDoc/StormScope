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
        providers: context.providers || {},
        cache: context.cache || null,
        errors: errors.slice()
      };
    }

    return Object.freeze({ capture: capture, getErrors: function () { return errors.slice(); }, install: install, report: report });
  }

  return Object.freeze({ STORAGE_KEY: STORAGE_KEY, MAX_ERRORS: MAX_ERRORS, create: create, redact: redact });
}));
