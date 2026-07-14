/* Opt-in Screen Wake Lock lifecycle for active monitoring sessions. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeWakeLock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function create(options) {
    var settings = options || {};
    var navigatorObject = settings.navigator || {};
    var documentObject = settings.document;
    var onChange = typeof settings.onChange === 'function' ? settings.onChange : function () {};
    var supported = Boolean(navigatorObject.wakeLock && typeof navigatorObject.wakeLock.request === 'function');
    var enabled = false;
    var authorized = false;
    var active = false;
    var sentinel = null;
    var pending = null;
    var generation = 0;
    var destroyed = false;
    var state = supported ? 'off' : 'unsupported';

    function snapshot() {
      return Object.freeze({
        supported: supported,
        enabled: enabled,
        active: active,
        held: Boolean(sentinel),
        state: state
      });
    }

    function notify() {
      var current = snapshot();
      onChange(current);
      return current;
    }

    function visible() {
      return !documentObject || documentObject.visibilityState !== 'hidden';
    }

    function canRequest() {
      return !destroyed && supported && enabled && authorized && active && visible() && !sentinel && !pending;
    }

    function release(nextState) {
      generation += 1;
      pending = null;
      var held = sentinel;
      sentinel = null;
      state = nextState || (enabled ? active ? 'released' : 'ready' : 'off');
      var current = notify();
      if (held && typeof held.release === 'function') {
        Promise.resolve(held.release()).catch(function () { return null; });
      }
      return Promise.resolve(current);
    }

    function request() {
      if (!canRequest()) return Promise.resolve(snapshot());
      var requestGeneration = ++generation;
      state = 'requesting';
      notify();
      var operation;
      try { operation = navigatorObject.wakeLock.request('screen'); } catch (error) { operation = Promise.reject(error); }
      pending = Promise.resolve(operation).then(function (lock) {
        if (requestGeneration !== generation || destroyed || !enabled || !active || !visible()) {
          if (lock && typeof lock.release === 'function') Promise.resolve(lock.release()).catch(function () { return null; });
          return snapshot();
        }
        pending = null;
        sentinel = lock;
        state = 'active';
        if (lock && typeof lock.addEventListener === 'function') {
          lock.addEventListener('release', function () {
            if (sentinel !== lock) return;
            sentinel = null;
            state = enabled && active ? 'released' : enabled ? 'ready' : 'off';
            notify();
          }, { once: true });
        }
        return notify();
      }, function () {
        if (requestGeneration !== generation) return snapshot();
        pending = null;
        state = 'unavailable';
        return notify();
      });
      return pending;
    }

    function setEnabled(value, userInitiated) {
      if (destroyed) return Promise.resolve(snapshot());
      if (!supported) {
        enabled = false;
        authorized = false;
        state = 'unsupported';
        return Promise.resolve(notify());
      }
      enabled = Boolean(value);
      if (!enabled) {
        authorized = false;
        return release('off');
      }
      if (userInitiated) authorized = true;
      state = 'ready';
      notify();
      return request();
    }

    function setActive(value) {
      if (destroyed) return Promise.resolve(snapshot());
      active = Boolean(value);
      if (!active) return release(enabled ? 'ready' : 'off');
      if (!visible()) {
        state = enabled ? 'suspended' : 'off';
        return Promise.resolve(notify());
      }
      if (enabled && !sentinel && !pending) state = 'ready';
      notify();
      return request();
    }

    function handleVisibilityChange() {
      if (!visible()) {
        release(enabled ? 'suspended' : 'off');
        return;
      }
      if (enabled && active) {
        state = 'ready';
        notify();
        request();
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (documentObject && typeof documentObject.removeEventListener === 'function') {
        documentObject.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      enabled = false;
      authorized = false;
      active = false;
      release('off');
    }

    if (documentObject && typeof documentObject.addEventListener === 'function') {
      documentObject.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return Object.freeze({
      destroy: destroy,
      request: request,
      setActive: setActive,
      setEnabled: setEnabled,
      snapshot: snapshot
    });
  }

  return Object.freeze({ create: create });
});
