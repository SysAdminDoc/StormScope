/* Bounded multi-camera selection and visibility-aware player lifecycle. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeMultiCamera = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var PLAYABLE_TYPES = Object.freeze(['hls', 'image', 'mjpeg', 'youtube']);

  function cameraId(camera) {
    if (!camera || camera.id == null) throw new TypeError('camera ID is required');
    return String(camera.id);
  }

  function capability(camera) {
    var type = String(camera && camera.type || '').toLowerCase();
    return {
      type: type,
      playable: PLAYABLE_TYPES.indexOf(type) !== -1,
      mode: PLAYABLE_TYPES.indexOf(type) !== -1 ? type : 'link'
    };
  }

  function Selection(options) {
    options = options || {};
    this.minimum = Number.isInteger(options.minimum) ? options.minimum : 2;
    this.maximum = Number.isInteger(options.maximum) ? options.maximum : 4;
    if (this.minimum < 1 || this.maximum < this.minimum) throw new RangeError('invalid selection bounds');
    this._cameras = [];
  }

  Selection.prototype.has = function (camera) {
    var id = cameraId(camera);
    return this._cameras.some(function (item) { return cameraId(item) === id; });
  };

  Selection.prototype.add = function (camera) {
    if (this.has(camera)) return false;
    if (this._cameras.length >= this.maximum) throw new RangeError('maximum camera selection reached');
    this._cameras.push(camera);
    return true;
  };

  Selection.prototype.remove = function (camera) {
    var id = cameraId(camera);
    var before = this._cameras.length;
    this._cameras = this._cameras.filter(function (item) { return cameraId(item) !== id; });
    return this._cameras.length !== before;
  };

  Selection.prototype.toggle = function (camera) {
    if (this.has(camera)) {
      this.remove(camera);
      return false;
    }
    this.add(camera);
    return true;
  };

  Selection.prototype.clear = function () { this._cameras = []; };
  Selection.prototype.replace = function (cameras) {
    if (!Array.isArray(cameras)) throw new TypeError('camera selection must be an array');
    var unique = [];
    var ids = Object.create(null);
    cameras.forEach(function (camera) {
      var id = cameraId(camera);
      if (!ids[id]) {
        ids[id] = true;
        unique.push(camera);
      }
    });
    if (unique.length < this.minimum || unique.length > this.maximum) {
      throw new RangeError('replacement camera selection is outside bounds');
    }
    this._cameras = unique;
    return this.list();
  };
  Selection.prototype.list = function () { return this._cameras.slice(); };
  Selection.prototype.count = function () { return this._cameras.length; };
  Selection.prototype.canStart = function () {
    return this._cameras.length >= this.minimum && this._cameras.length <= this.maximum;
  };

  function PlayerRegistry() {
    this._entries = [];
    this._documentHidden = false;
  }

  PlayerRegistry.prototype.register = function (element, player) {
    if (!element || !player || typeof player.pause !== 'function' || typeof player.resume !== 'function' || typeof player.destroy !== 'function') {
      throw new TypeError('player must provide pause, resume, and destroy');
    }
    var entry = { element: element, player: player, visible: true, destroyed: false };
    this._entries.push(entry);
    return entry;
  };

  PlayerRegistry.prototype.setVisible = function (element, visible) {
    var entry = this._entries.find(function (candidate) { return candidate.element === element; });
    if (!entry || entry.destroyed) return false;
    entry.visible = Boolean(visible);
    if (this._documentHidden || !entry.visible) entry.player.pause();
    else entry.player.resume();
    return true;
  };

  PlayerRegistry.prototype.setDocumentHidden = function (hidden) {
    this._documentHidden = Boolean(hidden);
    this._entries.forEach(function (entry) {
      if (entry.destroyed) return;
      if (hidden || !entry.visible) entry.player.pause();
      else entry.player.resume();
    });
  };

  PlayerRegistry.prototype.destroyAll = function () {
    this._entries.forEach(function (entry) {
      if (entry.destroyed) return;
      entry.destroyed = true;
      entry.player.destroy();
    });
    this._entries = [];
  };

  PlayerRegistry.prototype.count = function () { return this._entries.length; };

  return Object.freeze({
    PLAYABLE_TYPES: PLAYABLE_TYPES,
    Selection: Selection,
    PlayerRegistry: PlayerRegistry,
    capability: capability
  });
});
