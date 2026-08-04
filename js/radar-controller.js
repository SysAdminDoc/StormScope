/* Radar discovery, playback, tile lifecycle, and refresh ownership. */
'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeRadarController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var DEFAULT_SPEED = 800;
  var REFRESH_INTERVAL = 10 * 60 * 1000;
  var COLOR_SCHEME = 2;
  var MAX_NATIVE_ZOOM = 7;
  var PRELOAD_RESERVE = 20;
  var PLAYBACK_SPEEDS = [0, 400, 800, 1600];

  function create(options) {
    options = options || {};
    var documentObject = options.document || root && root.document;
    var leaflet = options.L || root && root.L;
    var providers = options.providers || root && root.StormScopeRadarProviders;
    var navigatorObject = options.navigator || root && root.navigator;
    var fetchFunction = options.fetch || root && root.fetch;
    var imageConstructor = options.Image || root && root.Image;
    var translate = options.translate || function (key) { return key; };
    var localNumber = options.localNumber || function (value) { return String(value); };
    var getLocale = options.getLocale || function () { return 'en'; };
    var formatDateTime = options.formatDateTime || function (value, format) {
      return root.StormScopeI18n.formatDateTime(value, format, getLocale());
    };
    var formatAge = options.formatAge || function (minutes) {
      return root.StormScopeI18n.formatAge(minutes, getLocale());
    };
    var radarReasonLabel = options.radarReasonLabel || function (reason) {
      return tr('radar.reason.' + reason);
    };
    var getMap = options.getMap || function () { return options.map; };
    var isComparisonOpen = options.isComparisonOpen || function () { return false; };
    var onPlayingChange = options.onPlayingChange || function () {};
    var onMotionPreview = options.onMotionPreview || function () {};
    var onSceneFrameExpired = options.onSceneFrameExpired || function () {};
    var isOnline = options.isOnline || function () { return navigatorObject ? navigatorObject.onLine : true; };
    var isDocumentHidden = options.isDocumentHidden || function () { return documentObject ? documentObject.hidden : false; };
    var isReducedMotion = options.isReducedMotion || function () {
      return Boolean(root && root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    };
    var getMotionMemoryBytes = options.getMotionMemoryBytes || function () { return 0; };
    var getMotionMemoryBudgetBytes = options.getMotionMemoryBudgetBytes || function () { return 64 * 1024 * 1024; };
    var motionApi = options.motion || root && root.StormScopeRadarMotion;
    var motionWorkerSupported = options.motionWorkerSupported == null
      ? Boolean(root && typeof root.Worker === 'function') : Boolean(options.motionWorkerSupported);
    var timers = {
      setTimeout: options.setTimeout || function (callback, delay) { return root.setTimeout(callback, delay); },
      clearTimeout: options.clearTimeout || function (timer) { return root.clearTimeout(timer); },
      setInterval: options.setInterval || function (callback, delay) { return root.setInterval(callback, delay); },
      clearInterval: options.clearInterval || function (timer) { return root.clearInterval(timer); },
      now: options.now || Date.now
    };
    var state = {
      frames: [],
      host: '',
      index: 0,
      playing: false,
      animationSpeed: DEFAULT_SPEED,
      preferredAnimationSpeed: DEFAULT_SPEED,
      palette: 'standard',
      animationTimer: null,
      refreshTimer: null,
      preloadTimer: null,
      preloadState: { status: 'idle', durationMs: null },
      abort: null,
      opacity: 0.65,
      visible: true,
      providerId: 'rainviewer',
      providerSelection: null,
      discovery: null,
      layer: null,
      nextLayer: null,
      coverageLayer: null,
      sampleToken: 0,
      semanticState: null,
      budget: providers.createRollingRequestBudget({ limit: 90, windowMs: 60000 }),
      budgetFallbackPending: false,
      lowDataMode: Boolean(options.lowDataMode),
      pendingFrameTime: null,
      preloadingEnabled: true,
      exportSession: null,
      motionEnabled: false,
      motionGeneration: 0,
      motionStatus: 'off',
      motionLastProfile: null,
      generation: 0,
      destroyed: false
    };

    var motionController = motionApi && typeof motionApi.create === 'function'
      ? motionApi.create({
        workerUrl: options.motionWorkerUrl,
        workerSupported: motionWorkerSupported,
        setTimeout: timers && timers.setTimeout,
        clearTimeout: timers && timers.clearTimeout,
        now: timers && timers.now
      }) : null;

    function map() {
      var value = getMap();
      if (!value) throw new Error('radar map is not ready');
      return value;
    }

    function tr(key, variables) {
      return translate(key, variables);
    }

    function reportMotion(result) {
      result = result || { status: 'fallback', mode: 'crossfade', reason: 'worker' };
      state.motionStatus = result.status || 'fallback';
      state.motionLastProfile = result.status === 'ready' ? {
        mode: result.mode, algorithm: result.algorithm, width: result.width, height: result.height,
        durationMs: result.durationMs, searchRadius: result.searchRadius, maxJobMs: result.maxJobMs
      } : null;
      onMotionPreview(Object.assign({ enabled: state.motionEnabled }, result));
    }

    function motionFramePair() {
      if (!state.frames.length) return null;
      if (state.index + 1 < state.frames.length) {
        return { previous: state.frames[state.index], next: state.frames[state.index + 1] };
      }
      if (state.index > 0) {
        return { previous: state.frames[state.index - 1], next: state.frames[state.index] };
      }
      return null;
    }

    function motionEligibility(pair) {
      var provider = providers.providers[state.providerId];
      var previous = pair && pair.previous;
      var next = pair && pair.next;
      return motionController ? motionController.eligibility({
        optIn: state.motionEnabled,
        reducedMotion: Boolean(isReducedMotion()),
        lowData: state.lowDataMode,
        hidden: Boolean(isDocumentHidden()),
        comparisonOpen: Boolean(isComparisonOpen()),
        workerSupported: motionController.isSupported(),
        providerKind: provider && provider.tile.kind,
        observedFrames: Boolean(provider && provider.history && provider.history.supportsFuture === false),
        isForecast: Boolean(previous && (previous.isForecast || previous.forecast) ||
          next && (next.isForecast || next.forecast)),
        previousFrameTime: previous && Number(previous.time),
        nextFrameTime: next && Number(next.time),
        now: timers.now(),
        estimatedMemoryBytes: Number(getMotionMemoryBytes()) || 0,
        memoryBudgetBytes: Number(getMotionMemoryBudgetBytes())
      }) : { enabled: false, reason: 'worker' };
    }

    function loadMotionFrame(frame, width, height) {
      return new Promise(function (resolve) {
        var provider = providers.providers[state.providerId];
        if (!frame || !provider || provider.tile.kind !== 'xyz' || !imageConstructor || !documentObject) {
          resolve(null);
          return;
        }
        var tileZoom;
        var coordinate;
        var image;
        var timer;
        var settled = false;
        try {
          tileZoom = Math.min(Number(provider.tile.maxNativeZoom) || 0, Math.max(0, Math.min(5, map().getZoom())));
          coordinate = centerTileCoordinate(tileZoom);
          image = new imageConstructor();
          timer = timers.setTimeout(function () {
            if (settled) return;
            settled = true;
            resolve(null);
          }, 3500);
          image.crossOrigin = 'anonymous';
          image.referrerPolicy = 'no-referrer';
          image.onload = function () {
            if (settled) return;
            settled = true;
            timers.clearTimeout(timer);
            try {
              var canvas = documentObject.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              var context = canvas.getContext('2d', { willReadFrequently: true });
              context.drawImage(image, 0, 0, width, height);
              resolve(new Uint8ClampedArray(context.getImageData(0, 0, width, height).data));
            } catch (error) { resolve(null); }
          };
          image.onerror = function () {
            if (settled) return;
            settled = true;
            timers.clearTimeout(timer);
            resolve(null);
          };
          image.src = providers.buildXyzRadarTileUrl(frame, tileZoom, coordinate.x, coordinate.y, { size: 256 });
        } catch (error) {
          if (timer) timers.clearTimeout(timer);
          resolve(null);
        }
      });
    }

    async function refreshMotionPrototype() {
      if (!state.motionEnabled) {
        reportMotion({ status: 'off', mode: 'crossfade', reason: 'disabled' });
        return;
      }
      var pair = motionFramePair();
      var check = motionEligibility(pair);
      state.motionGeneration += 1;
      var generation = state.motionGeneration;
      if (!check.enabled || !pair) {
        if (motionController) motionController.cancel(check.reason || 'adjacent-frames');
        reportMotion({ status: 'fallback', mode: 'crossfade', reason: check.reason || 'adjacent-frames' });
        return;
      }
      reportMotion({ status: 'busy', mode: 'crossfade', reason: 'processing', width: check.width, height: check.height });
      var previous = await loadMotionFrame(pair.previous, check.width, check.height);
      if (generation !== state.motionGeneration || !state.motionEnabled) return;
      var next = await loadMotionFrame(pair.next, check.width, check.height);
      if (generation !== state.motionGeneration || !state.motionEnabled) return;
      if (!previous || !next) {
        reportMotion({ status: 'fallback', mode: 'crossfade', reason: 'input', width: check.width, height: check.height });
        return;
      }
      var result = await motionController.run({
        optIn: true, reducedMotion: Boolean(isReducedMotion()), lowData: state.lowDataMode,
        hidden: Boolean(isDocumentHidden()), comparisonOpen: Boolean(isComparisonOpen()),
        workerSupported: motionController.isSupported(), providerKind: 'xyz', observedFrames: true,
        isForecast: Boolean(pair.previous.isForecast || pair.previous.forecast ||
          pair.next.isForecast || pair.next.forecast),
        previousFrameTime: pair.previous.time, nextFrameTime: pair.next.time,
        now: timers.now(), estimatedMemoryBytes: Number(getMotionMemoryBytes()) || 0,
        memoryBudgetBytes: Number(getMotionMemoryBudgetBytes()), width: check.width, height: check.height,
        previous: previous, next: next
      });
      if (generation !== state.motionGeneration || !state.motionEnabled) return;
      reportMotion(result);
    }

    function setMotionPrototypeEnabled(value) {
      state.motionEnabled = Boolean(value);
      state.motionGeneration += 1;
      if (!state.motionEnabled) {
        if (motionController) motionController.cancel('disabled');
        reportMotion({ status: 'off', mode: 'crossfade', reason: 'disabled' });
        return;
      }
      refreshMotionPrototype();
    }

    function fetchJson(url, signal) {
      return fetchFunction(url, { cache: 'no-store', signal: signal }).then(function (response) {
        if (!response.ok) {
          var error = new Error('HTTP ' + response.status);
          error.status = response.status;
          throw error;
        }
        return response.json();
      });
    }

    function fetchText(url, signal) {
      return fetchFunction(url, { cache: 'no-store', signal: signal }).then(function (response) {
        if (!response.ok) {
          var error = new Error('HTTP ' + response.status);
          error.status = response.status;
          throw error;
        }
        return response.text();
      });
    }

    function discoverPrimary(signal) {
      var providerId = providers.primaryProviderId;
      var provider = providers.providers[providerId];
      return fetchJson(provider.discovery.url, signal).then(function (payload) {
        return providers.parseXyzDiscovery(providerId, payload, timers.now());
      });
    }

    function discoverNoaa(signal) {
      var provider = providers.providers['noaa-mrms'];
      return Promise.all([
        fetchJson(provider.discovery.serviceUrl, signal),
        fetchJson(provider.discovery.framesUrl, signal)
      ]).then(function (payloads) {
        return providers.parseNoaaDiscovery(payloads[0], payloads[1], timers.now());
      });
    }

    function discoverRidge(signal) {
      var provider = providers.providers['noaa-ridge'];
      return fetchText(provider.discovery.url, signal).then(function (payload) {
        return providers.parseRidgeDiscovery(payload, timers.now());
      });
    }

    function setStatus(message, canRetry, disabled) {
      if (!documentObject) return;
      documentObject.getElementById('radar-time').textContent = message;
      documentObject.getElementById('radar-retry').classList.toggle('hidden', !canRetry);
      ['radar-prev', 'radar-next', 'radar-scrubber'].forEach(function (id) {
        documentObject.getElementById(id).disabled = Boolean(disabled);
      });
      documentObject.getElementById('radar-play').disabled = Boolean(disabled) || state.animationSpeed === 0;
    }

    function updateScrubber() {
      if (!documentObject) return;
      var scrubber = documentObject.getElementById('radar-scrubber');
      scrubber.max = String(Math.max(0, state.frames.length - 1));
      scrubber.value = String(Math.min(state.index, Math.max(0, state.frames.length - 1)));
      scrubber.disabled = state.frames.length === 0;
      documentObject.getElementById('radar-frame-position').textContent = tr('radar.framePosition', {
        current: state.frames.length ? localNumber(state.index + 1) : '0',
        total: localNumber(state.frames.length)
      });
    }

    function applyPaletteToLayer(layer) {
      if (!layer || !layer.getContainer) return;
      var container = layer.getContainer();
      if (!container) return;
      container.classList.remove('radar-palette-colorblind', 'radar-palette-contrast');
      if (state.palette !== 'standard') container.classList.add('radar-palette-' + state.palette);
    }

    function applyPalette() {
      if (!documentObject) return;
      applyPaletteToLayer(state.layer);
      applyPaletteToLayer(state.nextLayer);
      var legend = documentObject.getElementById('radar-legend');
      legend.classList.remove('palette-standard', 'palette-colorblind', 'palette-contrast');
      legend.classList.add('palette-' + state.palette);
      legend.setAttribute('aria-label', tr('radar.legend.' + state.palette));
    }

    function setPlaying(playing) {
      if (state.destroyed) return;
      state.playing = Boolean(playing && state.animationSpeed > 0 && state.frames.length);
      if (documentObject) {
        documentObject.getElementById('icon-play').classList.toggle('hidden', state.playing);
        documentObject.getElementById('icon-pause').classList.toggle('hidden', !state.playing);
        documentObject.getElementById('radar-play').setAttribute('aria-pressed', String(state.playing));
        documentObject.getElementById('radar-time').setAttribute('aria-live', state.playing ? 'off' : 'polite');
      }
      timers.clearInterval(state.animationTimer);
      state.animationTimer = null;
      if (state.playing) state.animationTimer = timers.setInterval(function () { step(1); }, state.animationSpeed);
      onPlayingChange(state.playing);
    }

    function updateProviderUi() {
      if (!documentObject || !state.providerSelection || !state.frames.length) return;
      var provider = providers.providers[state.providerId];
      var age = providers.getFrameAge(state.frames[state.index], state.providerId);
      var reason = state.providerSelection.degradationReason
        ? ' • ' + tr('radar.degraded', { reason: radarReasonLabel(state.providerSelection.degradationReason) }) : '';
      var resolution = state.providerId === 'build-radar'
        ? provider.resolution.label : tr('radar.resolution.' + state.providerId);
      documentObject.getElementById('radar-meta').textContent = provider.label +
        (state.providerSelection.isFallback ? tr('radar.fallbackSuffix') : '') + ' • ' + resolution + ' • ' +
        formatAge(age.ageMinutes) + reason;
      var source = documentObject.getElementById('radar-source');
      source.textContent = provider.attribution.text;
      source.href = provider.attribution.url;
    }

    function updateTimeDisplay() {
      var frame = state.frames[state.index];
      if (!frame) return;
      var time = formatDateTime(frame.time, {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
      });
      var age = providers.getFrameAge(frame, state.providerId);
      var stateKeys = { clear: 'radar.state.clear', 'no-coverage': 'radar.state.noCoverage', stale: 'radar.state.stale' };
      var label = state.semanticState && stateKeys[state.semanticState.state]
        ? tr(stateKeys[state.semanticState.state], { age: formatAge(age.ageMinutes) })
        : tr('radar.pastFrame', { time: time, age: formatAge(age.ageMinutes) });
      setStatus(label, state.semanticState ? state.semanticState.canRetry : false,
        state.semanticState ? !state.semanticState.controlsEnabled : false);
      updateProviderUi();
    }

    function applyPendingFrame() {
      if (state.pendingFrameTime == null || !state.frames.length) return;
      var nearestIndex = 0;
      var nearestDistance = Infinity;
      state.frames.forEach(function (frame, index) {
        var distance = Math.abs(Number(frame.time) - state.pendingFrameTime);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
      if (nearestDistance <= 30 * 60 * 1000) selectFrame(nearestIndex);
      else onSceneFrameExpired(tr('views.sceneFrameExpired'));
      state.pendingFrameTime = null;
    }

    function applyDiscovery(discovery, selection) {
      state.discovery = discovery;
      state.providerSelection = selection;
      state.providerId = selection.selectedProviderId;
      state.budgetFallbackPending = false;
      state.host = discovery.tileHost || '';
      state.frames = discovery.frames.slice();
      if (!state.frames.length) throw new Error('selected provider returned no frames');
      state.index = state.frames.length - 1;
      applyPendingFrame();
      updateScrubber();
      updateProviderUi();
      updateCoverageLayer();
      showFrame(state.index);
      preloadFrame(state.index > 0 ? state.index - 1 : state.frames.length - 1);
      updateTimeDisplay();
      sampleCenter(state.frames[state.index]);
      if (state.motionEnabled) refreshMotionPrototype();
    }

    function clearDisplay() {
      state.frames = [];
      state.host = '';
      state.index = 0;
      updateScrubber();
      setPlaying(false);
      showFrame(-1);
      if (state.nextLayer) {
        map().removeLayer(state.nextLayer);
        state.nextLayer = null;
      }
      timers.clearTimeout(state.preloadTimer);
      state.preloadTimer = null;
      state.preloadState = { status: 'idle', durationMs: null };
      state.semanticState = null;
      state.discovery = null;
      state.providerSelection = null;
      updateCoverageLayer();
    }

    function selectFrame(index) {
      if (!state.frames.length) return;
      state.index = Math.max(0, Math.min(state.frames.length - 1, Number(index) || 0));
      state.semanticState = null;
      showFrame(state.index);
      updateTimeDisplay();
      updateScrubber();
      sampleCenter(state.frames[state.index]);
      preloadFrame((state.index + 1) % state.frames.length);
      if (state.motionEnabled) refreshMotionPrototype();
    }

    function createTileLayer(index) {
      var frame = state.frames[index];
      if (!frame || !leaflet) return null;
      var provider = providers.providers[state.providerId];
      var layer;
      if (provider.tile.kind === 'xyz') {
        if (!state.host) return null;
        layer = leaflet.tileLayer(state.host + frame.path + '/256/{z}/{x}/{y}/' + COLOR_SCHEME + '/1_1.png', {
          opacity: state.opacity, zIndex: 400, maxNativeZoom: provider.tile.maxNativeZoom, maxZoom: 18,
          crossOrigin: 'anonymous',
          attribution: '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' +
            provider.attribution.text + '</a>'
        });
        if (state.providerId === 'rainviewer') guardRainViewerTileLayer(layer);
      } else if (provider.tile.kind === 'wms') {
        var params = state.providerId === 'noaa-ridge'
          ? providers.ridgeWmsParameters(frame) : providers.noaaWmsParameters(frame);
        var wmsOptions = {
          layers: params.layers, format: params.format, transparent: true, version: params.version,
          crs: leaflet.CRS.EPSG3857, opacity: state.opacity, zIndex: 400, maxZoom: 18,
          crossOrigin: 'anonymous',
          attribution: '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' +
            provider.attribution.text + '</a>'
        };
        if (params.time) wmsOptions.time = params.time;
        layer = leaflet.tileLayer.wms(provider.tile.endpoint, wmsOptions);
      } else return null;
      var layerGeneration = state.generation;
      var tileErrors = 0;
      var fallbackScheduled = false;
      var tileErrorKeys = Object.create(null);
      layer.on('tileerror', function (event) {
        tileErrors += 1;
        if (tileErrors < 3 || state.layer !== layer || state.generation !== layerGeneration || fallbackScheduled) return;
        if (event && event.coords && layer._tileCoordsToKey && layer._tiles) {
          var tileEntry = layer._tiles[layer._tileCoordsToKey(event.coords)];
          if (!tileEntry || tileEntry.current === false) return;
          tileErrorKeys[layer._tileCoordsToKey(event.coords)] = true;
        }
        fallbackScheduled = true;
        timers.setTimeout(function checkTileErrors() {
          if (state.layer !== layer || state.generation !== layerGeneration) return;
          var unresolved = Object.keys(tileErrorKeys).some(function (key) {
            var tileEntry = layer._tiles && layer._tiles[key];
            return tileEntry && tileEntry.current && !tileEntry.active;
          });
          if (!unresolved) {
            fallbackScheduled = false;
            return;
          }
          if (state.providerId === providers.primaryProviderId && isOnline()) {
            setStatus(tr('radar.tileFallback'), false, true);
            init({ forceNoaa: true, resumePlayback: state.playing });
          } else if (state.providerId === 'noaa-mrms' && isOnline()) {
            setStatus(tr('radar.ridgeTileFallback'), false, true);
            init({ forceRidge: true, resumePlayback: state.playing });
          } else {
            clearDisplay();
            setStatus(tr('radar.tilesUnavailable'), true, true);
          }
        }, 750);
      }, this);
      return layer;
    }

    function handleBudgetExhausted() {
      if (state.budgetFallbackPending || state.providerId !== 'rainviewer') return;
      state.budgetFallbackPending = true;
      var snapshot = state.budget.snapshot();
      setPlaying(false);
      timers.clearTimeout(state.preloadTimer);
      if (state.nextLayer) map().removeLayer(state.nextLayer);
      state.nextLayer = null;
      state.preloadState = { status: 'rate-limited', durationMs: null };
      setStatus(tr('radar.rateLimited', {
        time: formatDateTime(snapshot.rateLimitedUntil, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      }), false, true);
      timers.setTimeout(function () { init({ forceNoaa: true, resumePlayback: false }); }, 0);
    }

    function consumeRainViewerRequest() {
      var allowed = state.budget.consume(1);
      if (!allowed) handleBudgetExhausted();
      return allowed;
    }

    function guardRainViewerTileLayer(layer) {
      var createTile = layer.createTile;
      layer.createTile = function (coords, done) {
        if (consumeRainViewerRequest()) return createTile.call(this, coords, done);
        var tile = documentObject.createElement('canvas');
        tile.width = 256;
        tile.height = 256;
        tile.setAttribute('role', 'presentation');
        timers.setTimeout(function () { done(null, tile); }, 0);
        return tile;
      };
      return layer;
    }

    function preloadFrame(index) {
      if (state.nextLayer) map().removeLayer(state.nextLayer);
      timers.clearTimeout(state.preloadTimer);
      if (!state.preloadingEnabled) {
        state.nextLayer = null;
        state.preloadState = { status: 'suppressed-export', durationMs: 0, index: index };
        return;
      }
      if (state.lowDataMode) {
        state.nextLayer = null;
        state.preloadState = { status: 'suppressed-low-data', durationMs: 0, index: index };
        return;
      }
      if (state.providerId === 'rainviewer' && state.budget.snapshot().remaining <= PRELOAD_RESERVE) {
        state.nextLayer = null;
        state.preloadState = { status: 'suppressed-budget', durationMs: 0, index: index };
        return;
      }
      var startedAt = timers.now();
      state.preloadState = { status: 'loading', durationMs: null, index: index };
      state.nextLayer = createTileLayer(index);
      if (!state.nextLayer) {
        state.preloadState = { status: 'unavailable', durationMs: 0, index: index };
        return;
      }
      var preloadLayer = state.nextLayer;
      state.nextLayer.setOpacity(0);
      preloadLayer.addTo(map());
      applyPaletteToLayer(preloadLayer);
      function finish(status) {
        if (state.nextLayer !== preloadLayer) return;
        timers.clearTimeout(state.preloadTimer);
        state.preloadTimer = null;
        map().removeLayer(preloadLayer);
        state.nextLayer = null;
        state.preloadState = { status: status, durationMs: timers.now() - startedAt, index: index };
      }
      preloadLayer.once('load', function () { timers.setTimeout(function () { finish('complete'); }, 0); });
      state.preloadTimer = timers.setTimeout(function () { finish('timeout'); }, 5000);
    }

    function showFrame(index) {
      if (state.layer) {
        if (state.exportSession) {
          state.layer.setOpacity(0);
          if (state.exportSession.layers.indexOf(state.layer) === -1) state.exportSession.layers.push(state.layer);
        } else map().removeLayer(state.layer);
        state.layer = null;
      }
      state.layer = createTileLayer(index);
      if (state.layer && state.visible) {
        state.layer.addTo(map());
        applyPaletteToLayer(state.layer);
      }
    }

    function beginExport() {
      if (state.exportSession) return false;
      state.exportSession = {
        originalLayer: state.layer,
        originalIndex: state.index,
        originalProviderId: state.providerId,
        originalFrames: state.frames,
        layers: state.layer ? [state.layer] : []
      };
      return true;
    }

    function endExport() {
      var session = state.exportSession;
      if (!session) return;
      state.exportSession = null;
      if (state.frames !== session.originalFrames || state.providerId !== session.originalProviderId) {
        session.layers.forEach(function (layer) {
          if (layer) map().removeLayer(layer);
        });
        if (state.layer) map().removeLayer(state.layer);
        state.layer = null;
        return;
      }
      session.layers.forEach(function (layer) {
        if (layer && layer !== session.originalLayer) map().removeLayer(layer);
      });
      state.layer = session.originalLayer;
      state.index = Math.max(0, Math.min(state.frames.length - 1, session.originalIndex));
      if (state.layer) {
        state.layer.setOpacity(state.opacity);
        if (state.visible && !map().hasLayer(state.layer)) state.layer.addTo(map());
        applyPaletteToLayer(state.layer);
      }
      updateTimeDisplay();
      updateScrubber();
    }

    function centerTileCoordinate(zoom) {
      var center = map().getCenter();
      var scale = Math.pow(2, zoom);
      var x = (center.lng + 180) / 360 * scale;
      var latitude = Math.max(-85.05112878, Math.min(85.05112878, center.lat));
      var radians = latitude * Math.PI / 180;
      var y = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * scale;
      return { x: Math.floor(x), y: Math.floor(y), pixelX: Math.floor((x - Math.floor(x)) * 256),
        pixelY: Math.floor((y - Math.floor(y)) * 256) };
    }

    function sampleTilePixel(url, coordinate) {
      return new Promise(function (resolve) {
        if (!consumeRainViewerRequest() || !imageConstructor) { resolve(null); return; }
        var image = new imageConstructor();
        var settled = false;
        var timeout = timers.setTimeout(function () { if (!settled) resolve(null); }, 4000);
        image.crossOrigin = 'anonymous';
        image.referrerPolicy = 'no-referrer';
        image.onload = function () {
          settled = true;
          timers.clearTimeout(timeout);
          try {
            var canvas = documentObject.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            var context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(image, -coordinate.pixelX, -coordinate.pixelY);
            resolve(Array.from(context.getImageData(0, 0, 1, 1).data));
          } catch (error) { resolve(null); }
        };
        image.onerror = function () { settled = true; timers.clearTimeout(timeout); resolve(null); };
        image.src = url;
      });
    }

    async function sampleCenter(frame) {
      var provider = providers.providers[state.providerId];
      if (!frame || !provider || provider.tile.kind !== 'xyz') {
        var center = map().getCenter();
        var coverage = typeof providers.isPointCovered === 'function'
          ? providers.isPointCovered(state.providerId, center.lat, center.lng) : true;
        state.semanticState = providers.classifyRadarState({ frame: frame, coverage: coverage });
        updateTimeDisplay();
        return;
      }
      var token = ++state.sampleToken;
      var zoom = Math.min(map().getZoom(), provider.tile.maxNativeZoom);
      var coordinate = centerTileCoordinate(zoom);
      var coverageRequest = state.providerId === 'rainviewer'
        ? sampleTilePixel(providers.buildRainViewerCoverageUrl(state.host, zoom, coordinate.x, coordinate.y), coordinate)
        : Promise.resolve(null);
      var pixels = await Promise.all([coverageRequest, sampleTilePixel(
        providers.buildXyzRadarTileUrl(frame, zoom, coordinate.x, coordinate.y), coordinate
      )]);
      if (token !== state.sampleToken || frame !== state.frames[state.index]) return;
      var coveragePixel = pixels[0];
      var radarPixel = pixels[1];
      var intensity = providers.classifyRainViewerPixel(radarPixel);
      var covered = state.providerId !== 'rainviewer' ? true : coveragePixel
        ? !(coveragePixel[3] > 0 && coveragePixel[0] < 16 && coveragePixel[1] < 16 && coveragePixel[2] < 16)
        : null;
      state.semanticState = providers.classifyRadarState({ frame: frame, coverage: covered,
        hasPrecipitation: radarPixel ? intensity !== 'clear' : null,
        intensity: radarPixel ? intensity : null });
      updateTimeDisplay();
    }

    function step(delta) {
      if (!state.frames.length) return;
      selectFrame((state.index + delta + state.frames.length) % state.frames.length);
    }

    function updateCoverageLayer() {
      if (state.coverageLayer) {
        map().removeLayer(state.coverageLayer);
        state.coverageLayer = null;
      }
      if (!documentObject) return;
      var toggle = documentObject.getElementById('toggle-coverage');
      var supported = state.providerId === 'rainviewer' && Boolean(state.host) && state.frames.length > 0;
      toggle.disabled = !supported;
      if (!supported) toggle.checked = false;
      if (!supported || !toggle.checked) return;
      state.coverageLayer = leaflet.tileLayer(state.host + '/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png', {
        opacity: 0.2, zIndex: 350, maxNativeZoom: MAX_NATIVE_ZOOM, maxZoom: 18,
        crossOrigin: 'anonymous', attribution: 'RainViewer'
      });
      guardRainViewerTileLayer(state.coverageLayer).addTo(map());
    }

    function init(optionsForRefresh) {
      optionsForRefresh = optionsForRefresh || {};
      var resumePlayback = optionsForRefresh.resumePlayback == null ? state.playing : Boolean(optionsForRefresh.resumePlayback);
      state.generation += 1;
      if (state.abort) state.abort.abort();
      state.abort = new AbortController();
      setPlaying(false);
      setStatus(tr('radar.loadingPast'), false, true);
      var signal = state.abort.signal;
      var discoveries = {};
      var health = {};
      return (async function () {
        try {
          var primaryProviderId = providers.primaryProviderId;
          try {
            if (optionsForRefresh.forceNoaa || optionsForRefresh.forceRidge) {
              throw new Error(optionsForRefresh.forceRidge
                ? 'NOAA/NWS MRMS tile delivery failed' : 'Primary radar tile delivery failed');
            }
            discoveries[primaryProviderId] = await discoverPrimary(signal);
            health[primaryProviderId] = providers.assessProviderHealth(primaryProviderId, {
              latestFrame: discoveries[primaryProviderId].latestFrame, lastSuccessAt: timers.now()
            });
          } catch (primaryError) {
            if (primaryError.name === 'AbortError') throw primaryError;
            var finalPrimaryError = primaryError;
            if (isOnline() && !optionsForRefresh.forceNoaa && !optionsForRefresh.forceRidge && primaryError.status == null) {
              try {
                discoveries[primaryProviderId] = await discoverPrimary(signal);
                health[primaryProviderId] = providers.assessProviderHealth(primaryProviderId, {
                  latestFrame: discoveries[primaryProviderId].latestFrame, lastSuccessAt: timers.now()
                });
                finalPrimaryError = null;
              } catch (retryError) {
                if (retryError.name === 'AbortError') throw retryError;
                finalPrimaryError = retryError;
              }
            }
            if (finalPrimaryError) {
              health[primaryProviderId] = providers.assessProviderHealth(primaryProviderId, {
                error: finalPrimaryError,
                rateLimitedUntil: finalPrimaryError.status === 429 ? timers.now() + 60000 : null,
                consecutiveFailures: 1
              });
            }
          }
          if (!isOnline() && discoveries[primaryProviderId] && discoveries[primaryProviderId].latestFrame) {
            health[primaryProviderId] = { providerId: primaryProviderId, status: 'degraded', reason: 'cached-offline',
              latestFrameAge: providers.getFrameAge(discoveries[primaryProviderId].latestFrame, primaryProviderId),
              lastSuccessAt: discoveries[primaryProviderId].discoveredAt, consecutiveFailures: 0, checkedAt: timers.now() };
          }
          if (isOnline() && !optionsForRefresh.forceRidge &&
              (!health[primaryProviderId] || health[primaryProviderId].status !== 'healthy')) {
            try {
              discoveries['noaa-mrms'] = await discoverNoaa(signal);
              health['noaa-mrms'] = providers.assessProviderHealth('noaa-mrms', {
                latestFrame: discoveries['noaa-mrms'].latestFrame, lastSuccessAt: timers.now()
              });
            } catch (noaaError) {
              if (noaaError.name === 'AbortError') throw noaaError;
              health['noaa-mrms'] = providers.assessProviderHealth('noaa-mrms', {
                error: noaaError, consecutiveFailures: 1
              });
            }
          }
          var shouldDiscoverRidge = optionsForRefresh.forceRidge ||
            (!health[primaryProviderId] || health[primaryProviderId].status !== 'healthy') &&
            (!health['noaa-mrms'] || health['noaa-mrms'].status !== 'healthy');
          if (isOnline() && shouldDiscoverRidge) {
            try {
              discoveries['noaa-ridge'] = await discoverRidge(signal);
              health['noaa-ridge'] = providers.assessProviderHealth('noaa-ridge', {
                latestFrame: discoveries['noaa-ridge'].latestFrame, lastSuccessAt: timers.now()
              });
            } catch (ridgeError) {
              if (ridgeError.name === 'AbortError') throw ridgeError;
              health['noaa-ridge'] = providers.assessProviderHealth('noaa-ridge', {
                error: ridgeError, consecutiveFailures: 1
              });
            }
          }
          var selectionOptions = {};
          if (health['noaa-ridge'] && typeof providers.isPointCovered === 'function') {
            try {
              var mapCenter = map().getCenter();
              selectionOptions.coverageByProvider = {
                'noaa-ridge': providers.isPointCovered('noaa-ridge', mapCenter.lat, mapCenter.lng)
              };
            } catch (coverageError) { /* map may be unavailable to a headless controller */ }
          }
          var selection = providers.selectProvider(health, selectionOptions);
          if (!selection.selectedProviderId || !discoveries[selection.selectedProviderId]) {
            throw new Error(selection.degradationReason || 'all radar providers unavailable');
          }
          applyDiscovery(discoveries[selection.selectedProviderId], selection);
          if (resumePlayback && state.frames.length) setPlaying(true);
        } catch (error) {
          if (error.name !== 'AbortError') {
            clearDisplay();
            if (documentObject) documentObject.getElementById('radar-meta').textContent = tr('radar.providersUnavailable');
            setStatus(tr('radar.unavailable'), true, true);
          }
        }
      })();
    }

    function startRefreshTimer() {
      stopRefreshTimer();
      state.refreshTimer = timers.setInterval(function () {
        if (!isDocumentHidden() && !isComparisonOpen() && isOnline()) init();
      }, options.refreshIntervalMs || REFRESH_INTERVAL);
    }

    function stopRefreshTimer() {
      timers.clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }

    function setSpeed(value, persist) {
      var speed = PLAYBACK_SPEEDS.indexOf(Number(value)) === -1 ? DEFAULT_SPEED : Number(value);
      state.preferredAnimationSpeed = speed;
      state.animationSpeed = state.lowDataMode ? 0 : speed;
      if (persist !== false) {
        try {
          if (root && root.localStorage) root.localStorage.setItem('stormscope-radar-speed', String(speed));
        } catch (error) { /* optional */ }
      }
      if (documentObject) documentObject.getElementById('radar-speed').value = String(state.animationSpeed);
      setPlaying(state.playing && state.animationSpeed > 0);
      if (state.frames.length) updateTimeDisplay();
    }

    function setPalette(value, persist) {
      state.palette = ['standard', 'colorblind', 'contrast'].indexOf(value) === -1 ? 'standard' : value;
      if (documentObject) documentObject.getElementById('radar-palette').value = state.palette;
      if (persist !== false) {
        try { root.localStorage.setItem('stormscope-radar-palette', state.palette); } catch (error) { /* optional */ }
      }
      applyPalette();
    }

    function setOpacity(value) {
      state.opacity = Math.max(0, Math.min(1, Number(value)));
      if (state.layer) state.layer.setOpacity(state.opacity);
      if (state.nextLayer) state.nextLayer.setOpacity(0);
    }

    function setVisible(value) {
      state.visible = Boolean(value);
      if (state.layer) {
        if (state.visible) state.layer.addTo(map());
        else map().removeLayer(state.layer);
      }
      if (!state.visible) {
        setPlaying(false);
        state.motionGeneration += 1;
        if (motionController) motionController.cancel('disabled');
        if (state.motionEnabled) reportMotion({ status: 'fallback', mode: 'crossfade', reason: 'disabled' });
      } else if (state.motionEnabled) refreshMotionPrototype();
    }

    function setLowDataMode(value) {
      var lowData = Boolean(value);
      if (lowData && !state.lowDataMode) {
        if (state.animationSpeed > 0) state.preferredAnimationSpeed = state.animationSpeed;
        state.animationSpeed = 0;
        setPlaying(false);
        timers.clearTimeout(state.preloadTimer);
        if (state.nextLayer) map().removeLayer(state.nextLayer);
        state.nextLayer = null;
        state.preloadState = { status: 'suppressed-low-data', durationMs: 0 };
      } else if (!lowData && state.lowDataMode) state.animationSpeed = state.preferredAnimationSpeed;
      state.lowDataMode = lowData;
      if (documentObject) documentObject.getElementById('radar-speed').value = String(state.animationSpeed);
      if (state.frames.length) updateTimeDisplay();
      if (state.motionEnabled) refreshMotionPrototype();
    }

    function setPreloadingEnabled(value) {
      var enabled = Boolean(value);
      if (state.preloadingEnabled === enabled) return;
      state.preloadingEnabled = enabled;
      if (!enabled) {
        timers.clearTimeout(state.preloadTimer);
        state.preloadTimer = null;
        if (state.nextLayer) map().removeLayer(state.nextLayer);
        state.nextLayer = null;
        state.preloadState = { status: 'suppressed-export', durationMs: 0 };
      }
    }

    function loadPreferences(lowData) {
      var savedSpeed = null;
      var savedPalette = null;
      try {
        savedSpeed = root.localStorage.getItem('stormscope-radar-speed');
        savedPalette = root.localStorage.getItem('stormscope-radar-palette');
      } catch (error) { /* optional */ }
      var parsedSpeed = Number(savedSpeed);
      if (PLAYBACK_SPEEDS.indexOf(parsedSpeed) !== -1 && savedSpeed !== null) state.preferredAnimationSpeed = parsedSpeed;
      else if (root && root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) state.preferredAnimationSpeed = 0;
      state.palette = ['standard', 'colorblind', 'contrast'].indexOf(savedPalette) === -1 ? 'standard' : savedPalette;
      state.lowDataMode = Boolean(lowData);
      state.animationSpeed = state.lowDataMode ? 0 : state.preferredAnimationSpeed;
      if (documentObject) {
        documentObject.getElementById('radar-speed').value = String(state.animationSpeed);
        documentObject.getElementById('radar-palette').value = state.palette;
      }
      applyPalette();
    }

    function applyScene(scene) {
      scene = scene || {};
      if (scene.opacity != null) setOpacity(scene.opacity);
      if (scene.palette != null) setPalette(scene.palette, false);
      if (scene.speed != null) {
        state.preferredAnimationSpeed = PLAYBACK_SPEEDS.indexOf(Number(scene.speed)) === -1
          ? DEFAULT_SPEED : Number(scene.speed);
        state.animationSpeed = state.lowDataMode ? 0 : state.preferredAnimationSpeed;
        if (documentObject) documentObject.getElementById('radar-speed').value = String(state.animationSpeed);
      }
      var frameTime = scene.frameTime == null ? null : Number(scene.frameTime);
      state.pendingFrameTime = Number.isFinite(frameTime) ? frameTime : null;
      applyPendingFrame();
      if (state.frames.length) updateTimeDisplay();
    }

    function createComparisonLayer(request) {
      if (!state.frames.length || !state.providerId) throw new Error(tr('comparison.radarUnavailable'));
      var index = Math.max(0, Math.min(state.frames.length - 1, Number(request.timeIndex) || 0));
      var frame = state.frames[index];
      var provider = providers.providers[state.providerId];
      var attribution = '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' +
        provider.attribution.text + '</a>';
      var layer;
      if (provider.tile.kind === 'xyz') {
        layer = leaflet.tileLayer(frame.tileHost + frame.path + '/256/{z}/{x}/{y}/' + COLOR_SCHEME + '/1_1.png', {
          opacity: state.opacity, maxNativeZoom: provider.tile.maxNativeZoom, maxZoom: 18, keepBuffer: 1,
          updateWhenIdle: true, crossOrigin: 'anonymous', attribution: attribution
        });
        request.guardTileLayer(layer);
      } else if (provider.tile.kind === 'wms') {
        var params = state.providerId === 'noaa-ridge'
          ? providers.ridgeWmsParameters(frame) : providers.noaaWmsParameters(frame);
        var wmsOptions = {
          layers: params.layers, format: params.format, transparent: true, version: params.version,
          crs: leaflet.CRS.EPSG3857, opacity: state.opacity, maxZoom: 18, keepBuffer: 1,
          updateWhenIdle: true, crossOrigin: 'anonymous', attribution: attribution
        };
        if (params.time) wmsOptions.time = params.time;
        layer = leaflet.tileLayer.wms(provider.tile.endpoint, wmsOptions);
        request.guardTileLayer(layer);
      } else throw new Error(tr('comparison.radarUnavailable'));
      return {
        layer: layer,
        message: provider.label + ' • ' + (frame ? formatDateTime(frame.time, { hour: 'numeric', minute: '2-digit' }) : tr('comparison.unavailable'))
      };
    }

    function snapshot() {
      return {
        frames: state.frames.slice(), index: state.index, playing: state.playing,
        animationSpeed: state.animationSpeed, preferredAnimationSpeed: state.preferredAnimationSpeed,
        palette: state.palette, opacity: state.opacity, visible: state.visible, providerId: state.providerId,
        providerSelection: state.providerSelection, discovery: state.discovery, layer: state.layer,
        preloadState: Object.assign({}, state.preloadState), semanticState: state.semanticState,
        host: state.host, pendingFrameTime: state.pendingFrameTime, lowDataMode: state.lowDataMode,
        preloadingEnabled: state.preloadingEnabled
      };
    }

    function destroy(destroyOptions) {
      if (state.destroyed) return;
      destroyOptions = destroyOptions || {};
      state.motionGeneration += 1;
      if (motionController) motionController.destroy();
      stopRefreshTimer();
      if (state.abort) state.abort.abort();
      timers.clearTimeout(state.preloadTimer);
      setPlaying(false);
      if (destroyOptions.preserveMapLayers) {
        state.frames = [];
        state.host = '';
        state.index = 0;
        state.layer = null;
        state.nextLayer = null;
        state.coverageLayer = null;
        state.preloadState = { status: 'idle', durationMs: null };
        state.semanticState = null;
        state.discovery = null;
        state.providerSelection = null;
      } else {
        clearDisplay();
      }
      state.destroyed = true;
    }

    return Object.freeze({
      applyScene: applyScene,
      applyPalette: applyPalette,
      createComparisonLayer: createComparisonLayer,
      destroy: destroy,
      beginExport: beginExport,
      endExport: endExport,
      getBudget: function () { return state.budget.snapshot(); },
      getFrame: function (index) { return state.frames[index] || null; },
      getFrameTime: function () { return state.frames[state.index] ? state.frames[state.index].time : null; },
      getPreloadState: function () { return Object.assign({}, state.preloadState); },
      getSemanticState: function () { return state.semanticState; },
      getState: snapshot,
      hasPendingFrame: function () { return state.pendingFrameTime != null; },
      init: init,
      loadPreferences: loadPreferences,
      refresh: init,
      selectFrame: selectFrame,
      getMotionState: function () {
        return {
          enabled: state.motionEnabled, status: state.motionStatus,
          lastProfile: state.motionLastProfile ? Object.assign({}, state.motionLastProfile) : null
        };
      },
      refreshMotionPrototype: refreshMotionPrototype,
      setMotionPrototypeEnabled: setMotionPrototypeEnabled,
      setLowDataMode: setLowDataMode,
      setPreloadingEnabled: setPreloadingEnabled,
      setOpacity: setOpacity,
      setPalette: setPalette,
      setPlaying: setPlaying,
      setSpeed: setSpeed,
      setVisible: setVisible,
      startRefreshTimer: startRefreshTimer,
      stopRefreshTimer: stopRefreshTimer,
      step: step,
      sampleCenter: function () {
        var frame = state.frames[state.index];
        if (frame) sampleCenter(frame);
      },
      updateScrubber: updateScrubber,
      updateCoverageLayer: updateCoverageLayer,
      updateTimeDisplay: updateTimeDisplay
    });
  }

  return Object.freeze({ create: create, DEFAULT_SPEED: DEFAULT_SPEED, REFRESH_INTERVAL: REFRESH_INTERVAL });
});
