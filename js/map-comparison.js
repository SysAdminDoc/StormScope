(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeMapComparison = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SIDES = Object.freeze(['left', 'right']);
  var SOURCES = Object.freeze(['radar', 'satellite', 'hazards']);
  var REQUEST_LIMIT = 72;
  var REQUEST_WINDOW_MS = 60000;
  var MAX_TILE_NODES_PER_PANE = 64;
  var BYTES_PER_DECODED_TILE = 256 * 256 * 4;
  var MAX_ESTIMATED_MEMORY_BYTES = 32 * 1024 * 1024;

  function percentile(values, ratio) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (left, right) { return left - right; });
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  }

  function createRollingBudget(now) {
    var timestamps = [];
    function prune(time) {
      while (timestamps.length && timestamps[0] <= time - REQUEST_WINDOW_MS) timestamps.shift();
    }
    return {
      consume: function () {
        var time = now();
        prune(time);
        if (timestamps.length >= REQUEST_LIMIT) return false;
        timestamps.push(time);
        return true;
      },
      snapshot: function () {
        var time = now();
        prune(time);
        return { limit: REQUEST_LIMIT, used: timestamps.length, remaining: REQUEST_LIMIT - timestamps.length };
      }
    };
  }

  function create(options) {
    if (!options || !options.L || !options.modal || !options.mainMap || typeof options.layerFactory !== 'function') {
      throw new TypeError('Comparison requires Leaflet, modal, main map, and layer factory.');
    }
    var L = options.L;
    var now = options.now || Date.now;
    var clock = options.performanceNow || function () { return performance.now(); };
    var budget = createRollingBudget(now);
    var panes = Object.create(null);
    var active = false;
    var syncing = false;
    var syncDurations = [];
    var peakTileNodes = 0;
    var priorFocus = null;

    function paneElements(side) {
      return {
        map: options.modal.querySelector('[data-comparison-map="' + side + '"]'),
        source: options.modal.querySelector('[data-comparison-source="' + side + '"]'),
        time: options.modal.querySelector('[data-comparison-time="' + side + '"]'),
        timeLabel: options.modal.querySelector('[data-comparison-time-label="' + side + '"]'),
        status: options.modal.querySelector('[data-comparison-status="' + side + '"]')
      };
    }

    function tileCount(pane) {
      return pane.elements.map.querySelectorAll('.leaflet-tile').length;
    }

    function updatePeakTiles() {
      var total = SIDES.reduce(function (sum, side) {
        return sum + (panes[side] ? tileCount(panes[side]) : 0);
      }, 0);
      peakTileNodes = Math.max(peakTileNodes, total);
    }

    function guardTileLayer(layer, side) {
      if (!layer || typeof layer.createTile !== 'function') return layer;
      var original = layer.createTile;
      layer.createTile = function (coords, done) {
        var pane = panes[side];
        updatePeakTiles();
        if (!active || !pane || tileCount(pane) >= MAX_TILE_NODES_PER_PANE || !budget.consume()) {
          var blank = document.createElement('img');
          blank.alt = '';
          blank.setAttribute('role', 'presentation');
          setTimeout(function () { done(null, blank); }, 0);
          return blank;
        }
        return original.call(this, coords, done);
      };
      return layer;
    }

    function setPaneStatus(side, message, error) {
      var element = panes[side] && panes[side].elements.status;
      if (!element) return;
      element.textContent = message || '';
      element.classList.toggle('error', !!error);
    }

    function refreshPane(side) {
      var pane = panes[side];
      if (!active || !pane) return Promise.resolve();
      pane.generation += 1;
      var generation = pane.generation;
      if (pane.layer) {
        pane.map.removeLayer(pane.layer);
        pane.layer = null;
      }
      var other = panes[side === 'left' ? 'right' : 'left'];
      var networkSource = pane.source === 'radar' || pane.source === 'satellite';
      var otherNetworkSource = other && (other.source === 'radar' || other.source === 'satellite');
      if (options.isLowData && options.isLowData() && side === 'right' && networkSource && otherNetworkSource) {
        setPaneStatus(side, options.lowDataSuspendedLabel || 'Paused by low-data mode', false);
        return Promise.resolve();
      }
      setPaneStatus(side, options.loadingLabel || 'Loading…', false);
      return Promise.resolve(options.layerFactory({
        side: side,
        map: pane.map,
        source: pane.source,
        timeIndex: pane.timeIndex,
        guardTileLayer: function (layer) { return guardTileLayer(layer, side); },
        consumeRequest: budget.consume
      })).then(function (result) {
        if (!active || !panes[side] || generation !== pane.generation) return;
        if (!result || !result.layer) throw new Error(result && result.message || 'Source unavailable');
        pane.layer = result.layer;
        pane.layer.addTo(pane.map);
        setPaneStatus(side, result.message || '', false);
        updatePeakTiles();
      }).catch(function (error) {
        if (active && panes[side] && generation === pane.generation) {
          setPaneStatus(side, error.message || String(error), true);
        }
      });
    }

    function syncFrom(side) {
      if (!active || syncing) return;
      var otherSide = side === 'left' ? 'right' : 'left';
      var source = panes[side];
      var target = panes[otherSide];
      if (!source || !target) return;
      syncing = true;
      var started = clock();
      target.map.setView(source.map.getCenter(), source.map.getZoom(), { animate: false, reset: true });
      syncDurations.push(Math.max(0, clock() - started));
      if (syncDurations.length > 100) syncDurations.shift();
      syncing = false;
      if (source.source === 'satellite') scheduleSatelliteRefresh(side);
      if (target.source === 'satellite') scheduleSatelliteRefresh(otherSide);
    }

    function scheduleSatelliteRefresh(side) {
      var pane = panes[side];
      if (!pane) return;
      clearTimeout(pane.refreshTimer);
      pane.refreshTimer = setTimeout(function () {
        pane.refreshTimer = null;
        refreshPane(side);
      }, 300);
    }

    function initializePane(side, source) {
      var elements = paneElements(side);
      var map = L.map(elements.map, {
        zoomControl: true,
        attributionControl: true,
        fadeAnimation: false,
        markerZoomAnimation: false,
        zoomAnimation: false
      }).setView(options.mainMap.getCenter(), options.mainMap.getZoom());
      panes[side] = {
        map: map,
        basemap: null,
        layer: null,
        source: source,
        timeIndex: Math.max(0, Number(elements.time.value) || 0),
        generation: 0,
        refreshTimer: null,
        elements: elements,
        sourceHandler: null,
        timeHandler: null
      };
      var basemap = L.tileLayer(options.basemapUrl(), {
        maxZoom: 19,
        keepBuffer: 1,
        updateWhenIdle: true,
        attribution: '&copy; OpenStreetMap &copy; CARTO'
      });
      panes[side].basemap = guardTileLayer(basemap, side).addTo(map);
      elements.source.value = source;
      map.on('moveend zoomend', function () { syncFrom(side); });
      panes[side].sourceHandler = function () {
        if (SOURCES.indexOf(elements.source.value) === -1) return;
        panes[side].source = elements.source.value;
        elements.time.disabled = panes[side].source !== 'radar';
        Promise.all(SIDES.map(refreshPane));
      };
      elements.source.addEventListener('change', panes[side].sourceHandler);
      panes[side].timeHandler = function () {
        panes[side].timeIndex = Math.max(0, Number(elements.time.value) || 0);
        if (typeof options.formatTimeLabel === 'function') {
          elements.timeLabel.textContent = options.formatTimeLabel(panes[side].timeIndex);
        }
        refreshPane(side);
      };
      elements.time.addEventListener('input', panes[side].timeHandler);
      elements.time.disabled = source !== 'radar';
      if (typeof options.formatTimeLabel === 'function') {
        elements.timeLabel.textContent = options.formatTimeLabel(panes[side].timeIndex);
      }
    }

    function open(trigger) {
      if (active) return true;
      active = true;
      priorFocus = trigger || document.activeElement;
      options.modal.classList.remove('hidden');
      initializePane('left', 'radar');
      initializePane('right', 'satellite');
      if (typeof options.onOpen === 'function') options.onOpen();
      options.modal.querySelector('[data-comparison-close]').focus();
      Promise.all(SIDES.map(refreshPane));
      return true;
    }

    function close(restoreFocus) {
      if (!active) return;
      active = false;
      SIDES.forEach(function (side) {
        var pane = panes[side];
        if (!pane) return;
        pane.generation += 1;
        clearTimeout(pane.refreshTimer);
        if (pane.layer) pane.map.removeLayer(pane.layer);
        pane.elements.source.removeEventListener('change', pane.sourceHandler);
        pane.elements.time.removeEventListener('input', pane.timeHandler);
        pane.map.off();
        pane.map.remove();
        pane.elements.map.replaceChildren();
        pane.elements.map.className = 'comparison-map';
        pane.elements.map.removeAttribute('tabindex');
        pane.elements.map.removeAttribute('style');
      });
      panes = Object.create(null);
      options.modal.classList.add('hidden');
      if (typeof options.onClose === 'function') options.onClose();
      if (restoreFocus !== false && priorFocus && priorFocus.isConnected) priorFocus.focus();
      priorFocus = null;
    }

    function metrics() {
      updatePeakTiles();
      var activeTiles = SIDES.reduce(function (sum, side) {
        return sum + (panes[side] ? tileCount(panes[side]) : 0);
      }, 0);
      return {
        active: active,
        paneCount: active ? SIDES.length : 0,
        activeTileNodes: activeTiles,
        peakTileNodes: peakTileNodes,
        estimatedDecodedBytes: activeTiles * BYTES_PER_DECODED_TILE,
        maxEstimatedMemoryBytes: MAX_ESTIMATED_MEMORY_BYTES,
        requestBudget: budget.snapshot(),
        syncSamples: syncDurations.length,
        syncP95Ms: percentile(syncDurations, 0.95),
        desktopSyncBudgetMs: 20,
        mobileSyncBudgetMs: 32
      };
    }

    return Object.freeze({
      open: open,
      close: close,
      isOpen: function () { return active; },
      setDocumentHidden: function (hidden) { if (hidden) close(false); },
      setView: function (side, center, zoom) {
        if (!active || !panes[side]) return false;
        panes[side].map.setView(center, zoom, { animate: false, reset: true });
        return true;
      },
      setBasemapUrl: function (url) {
        SIDES.forEach(function (side) {
          if (panes[side] && panes[side].basemap) panes[side].basemap.setUrl(url);
        });
      },
      refresh: function () { if (active) return Promise.all(SIDES.map(refreshPane)); return Promise.resolve(); },
      metrics: metrics
    });
  }

  return Object.freeze({
    create: create,
    createRollingBudget: createRollingBudget,
    percentile: percentile,
    sources: SOURCES,
    limits: Object.freeze({
      requestsPerMinute: REQUEST_LIMIT,
      tileNodesPerPane: MAX_TILE_NODES_PER_PANE,
      maxEstimatedMemoryBytes: MAX_ESTIMATED_MEMORY_BYTES,
      desktopSyncBudgetMs: 20,
      mobileSyncBudgetMs: 32
    })
  });
});
