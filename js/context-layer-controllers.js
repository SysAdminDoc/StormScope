/* Lifecycle ownership for independently refreshed operational map layers. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeContextLayerControllers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function requireFunction(value, label) {
    if (typeof value !== 'function') throw new TypeError(label + ' callback is required');
    return value;
  }

  function values(callback) {
    if (!callback) return [];
    var result = callback();
    if (result == null) return [];
    return Array.isArray(result) ? result : [result];
  }

  function createController(options) {
    options = options || {};
    var id = String(options.id || '').trim();
    if (!id) throw new TypeError('context controller id is required');
    var isEnabled = requireFunction(options.isEnabled, id + ' isEnabled');
    var refresh = requireFunction(options.refresh, id + ' refresh');
    var cancelTimer = requireFunction(options.cancelTimer, id + ' cancelTimer');
    var destroyed = false;

    function suspend() {
      if (destroyed) return;
      values(options.aborts).forEach(function (abort) {
        if (abort && typeof abort.abort === 'function') abort.abort();
      });
      values(options.timers).forEach(function (timer) {
        if (timer != null) cancelTimer(timer);
      });
    }

    function refreshIfEnabled() {
      if (destroyed || !isEnabled()) return undefined;
      return refresh();
    }

    function destroy() {
      if (destroyed) return;
      suspend();
      destroyed = true;
    }

    return Object.freeze({
      id: id,
      refreshIfEnabled: refreshIfEnabled,
      suspend: suspend,
      destroy: destroy
    });
  }

  function createControllerSet(controllers) {
    if (!Array.isArray(controllers) || !controllers.length) {
      throw new TypeError('at least one context controller is required');
    }
    var owned = controllers.slice();
    var ids = new Set();
    owned.forEach(function (controller) {
      if (!controller || typeof controller.id !== 'string' ||
          typeof controller.refreshIfEnabled !== 'function' ||
          typeof controller.suspend !== 'function' || typeof controller.destroy !== 'function') {
        throw new TypeError('invalid context controller');
      }
      if (ids.has(controller.id)) throw new TypeError('duplicate context controller: ' + controller.id);
      ids.add(controller.id);
    });
    var destroyed = false;

    function refreshEnabled() {
      if (destroyed) return;
      owned.forEach(function (controller) { controller.refreshIfEnabled(); });
    }

    function suspend() {
      if (destroyed) return;
      owned.forEach(function (controller) { controller.suspend(); });
    }

    function destroy() {
      if (destroyed) return;
      owned.forEach(function (controller) { controller.destroy(); });
      destroyed = true;
    }

    return Object.freeze({
      ids: Object.freeze(Array.from(ids)),
      refreshEnabled: refreshEnabled,
      suspend: suspend,
      destroy: destroy
    });
  }

  return Object.freeze({
    createController: createController,
    createControllerSet: createControllerSet
  });
});
