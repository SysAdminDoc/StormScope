(function () {
  'use strict';

  var MAP_CENTER = [39.5, -98.5];
  var MAP_ZOOM = 5;
  var RADAR_ANIMATION_SPEED = 800;
  var RADAR_REFRESH_INTERVAL = 10 * 60 * 1000;
  var IMAGE_REFRESH_INTERVAL = 15000;
  var TRUSTED_EMBED_HOST_SUFFIXES = Object.freeze([
    'earthcam.com',
    'myearthcam.com',
    'nps.gov',
    'brownrice.com',
    'abbeyroad.com',
    'esbnyc.com'
  ]);
  var RAINVIEWER_API_URL = 'https://api.rainviewer.com/public/weather-maps.json';
  var RAINVIEWER_COLOR_SCHEME = 2;
  var RAINVIEWER_MAX_NATIVE_ZOOM = 7;

  var map, radarLayer, radarLayerNext, cameraCluster;
  var radarFrames = [];
  var radarHost = '';
  var radarIndex = 0;
  var radarPlaying = false;
  var radarAnimationSpeed = RADAR_ANIMATION_SPEED;
  var radarPalette = 'standard';
  var radarAnimTimer = null;
  var radarRefreshTimer = null;
  var radarPreloadTimer = null;
  var radarPreloadState = { status: 'idle', durationMs: null };
  var radarAbort = null;
  var radarOpacity = 0.65;
  var radarVisible = true;
  var radarProviderId = 'rainviewer';
  var radarProviderSelection = null;
  var radarDiscovery = null;
  var radarCoverageLayer = null;
  var radarSampleToken = 0;
  var radarSemanticState = null;
  var activeCamera = null;
  var priorFocusEl = null;
  var weatherAbort = null;
  var imageRefreshTimer = null;
  var activeFeedCleanup = null;
  var allCameras = [];
  var cameraIconCache = Object.create(null);
  var cameraHealthOverrides = Object.create(null);
  var cameraStore = null;
  var cameraLoadMetrics = { startedAt: 0, firstBatchMs: null, completeMs: null, source: null };
  var cameraLoadProcessed = 0;
  var currentCameraResults = [];
  var searchRenderTimer = null;
  var savedStore = null;
  var saveLastViewTimer = null;
  var cameraDataTimestamp = null;
  var radarWasPlaying = false;
  var feedPausedForVisibility = false;
  var reloadForUpdate = false;
  var weatherUnits = 'us';
  var alertsVisible = true;
  var activeAlerts = [];
  var alertLayerGroup = null;
  var alertLayersById = Object.create(null);
  var alertAbort = null;
  var alertRefreshTimer = null;
  var alertMoveTimer = null;
  var alertRetryMetadata = null;
  var alertDetailReturnFocus = null;
  var alertNationalPayload = null;
  var alertNationalFetchedAt = 0;
  var appLocale = 'en';
  var monitorSelection = new StormScopeMultiCamera.Selection({ minimum: 2, maximum: 4 });
  var monitorRegistry = null;
  var monitorObserver = null;
  var lightningLayer = null;
  var lightningAbort = null;
  var lightningRefreshTimer = null;
  var lightningLatestTime = null;
  var lightningStatusState = 'off';
  var wildfireLayer = null;
  var wildfireAbort = null;
  var wildfireRefreshTimer = null;
  var wildfireMoveTimer = null;
  var wildfireUpdatedAt = null;
  var wildfireCount = 0;
  var wildfireStatusState = 'off';
  var wildfireAttributionAdded = false;

  function tr(key, variables) {
    return StormScopeI18n.t(key, variables, appLocale);
  }

  function localNumber(value) {
    return StormScopeI18n.formatNumber(value, null, appLocale);
  }

  function localTime(value) {
    return StormScopeWeather.formatTime(value, appLocale);
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Map Init ──

  function initMap() {
    map = L.map('map', {
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      zoomControl: true,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 18
    });

    map.createPane('contextRasterPane');
    map.getPane('contextRasterPane').style.zIndex = '325';
    map.getPane('contextRasterPane').style.pointerEvents = 'none';
    map.createPane('contextVectorPane');
    map.getPane('contextVectorPane').style.zIndex = '390';

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      crossOrigin: 'anonymous',
      maxZoom: 19
    }).addTo(map);
  }

  // ── RainViewer Radar ──

  async function initRadar(options) {
    options = options || {};
    var resumePlayback = options.resumePlayback || radarPlaying;
    if (radarAbort) radarAbort.abort();
    radarAbort = new AbortController();
    setRadarPlaying(false);
    setRadarStatus(tr('radar.loadingPast'), false, true);

    var signal = radarAbort.signal;
    var discoveries = {};
    var health = {};

    try {
      try {
        if (options.forceNoaa) throw new Error('RainViewer tile delivery failed');
        discoveries.rainviewer = await discoverRainViewer(signal);
        health.rainviewer = StormScopeRadarProviders.assessProviderHealth('rainviewer', {
          latestFrame: discoveries.rainviewer.latestFrame,
          lastSuccessAt: Date.now()
        });
      } catch (rainError) {
        if (rainError.name === 'AbortError') throw rainError;
        health.rainviewer = StormScopeRadarProviders.assessProviderHealth('rainviewer', {
          error: rainError,
          rateLimitedUntil: rainError.status === 429 ? Date.now() + 60000 : null,
          consecutiveFailures: 1
        });
      }

      if (!navigator.onLine && discoveries.rainviewer && discoveries.rainviewer.latestFrame) {
        health.rainviewer = {
          providerId: 'rainviewer',
          status: 'degraded',
          reason: 'cached-offline',
          latestFrameAge: StormScopeRadarProviders.getFrameAge(discoveries.rainviewer.latestFrame, 'rainviewer'),
          lastSuccessAt: discoveries.rainviewer.discoveredAt,
          consecutiveFailures: 0,
          checkedAt: Date.now()
        };
      }

      if (navigator.onLine && (!health.rainviewer || health.rainviewer.status !== 'healthy')) {
        try {
          discoveries['noaa-mrms'] = await discoverNoaa(signal);
          health['noaa-mrms'] = StormScopeRadarProviders.assessProviderHealth('noaa-mrms', {
            latestFrame: discoveries['noaa-mrms'].latestFrame,
            lastSuccessAt: Date.now()
          });
        } catch (noaaError) {
          if (noaaError.name === 'AbortError') throw noaaError;
          health['noaa-mrms'] = StormScopeRadarProviders.assessProviderHealth('noaa-mrms', {
            error: noaaError,
            consecutiveFailures: 1
          });
        }
      }

      var selection = StormScopeRadarProviders.selectProvider(health);
      if (!selection.selectedProviderId || !discoveries[selection.selectedProviderId]) {
        throw new Error(selection.degradationReason || 'all radar providers unavailable');
      }
      applyRadarDiscovery(discoveries[selection.selectedProviderId], selection);
      if (resumePlayback && radarFrames.length) setRadarPlaying(true);
    } catch (error) {
      if (error.name !== 'AbortError') {
        clearRadarDisplay();
        document.getElementById('radar-meta').textContent = tr('radar.providersUnavailable', { error: error.message });
        setRadarStatus(tr('radar.unavailable'), true, true);
      }
    }
  }

  async function fetchRadarJson(url, signal) {
    var response = await fetch(url, { cache: 'no-store', signal: signal });
    if (!response.ok) {
      var error = new Error('HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function discoverRainViewer(signal) {
    var payload = await fetchRadarJson(RAINVIEWER_API_URL, signal);
    return StormScopeRadarProviders.parseRainViewerDiscovery(payload, Date.now());
  }

  async function discoverNoaa(signal) {
    var provider = StormScopeRadarProviders.providers['noaa-mrms'];
    var metadata = await fetchRadarJson(provider.discovery.serviceUrl, signal);
    var frames = await fetchRadarJson(provider.discovery.framesUrl, signal);
    return StormScopeRadarProviders.parseNoaaDiscovery(metadata, frames, Date.now());
  }

  function applyRadarDiscovery(discovery, selection) {
    radarDiscovery = discovery;
    radarProviderSelection = selection;
    radarProviderId = selection.selectedProviderId;
    radarHost = discovery.tileHost || '';
    radarFrames = discovery.frames;
    if (!radarFrames.length) throw new Error('selected provider returned no frames');
    radarIndex = radarFrames.length - 1;
    updateRadarScrubber();
    updateRadarProviderUI();
    updateCoverageLayer();
    showRadarFrame(radarIndex);
    preloadRadarFrame(radarIndex > 0 ? radarIndex - 1 : radarFrames.length - 1);
    updateRadarTimeDisplay();
    sampleRadarCenter(radarFrames[radarIndex]);
  }

  function clearRadarDisplay() {
    radarFrames = [];
    radarHost = '';
    radarIndex = 0;
    updateRadarScrubber();
    setRadarPlaying(false);
    showRadarFrame(-1);
    if (radarLayerNext) {
      map.removeLayer(radarLayerNext);
      radarLayerNext = null;
    }
    clearTimeout(radarPreloadTimer);
    radarPreloadTimer = null;
    radarPreloadState = { status: 'idle', durationMs: null };
    radarSemanticState = null;
    radarDiscovery = null;
    radarProviderSelection = null;
    if (radarCoverageLayer) {
      map.removeLayer(radarCoverageLayer);
      radarCoverageLayer = null;
    }
  }

  function getTrustedRainViewerHost(value) {
    try {
      var parsed = new URL(value);
      var hostname = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || !hostMatchesSuffix(hostname, 'rainviewer.com')) return '';
      return parsed.origin;
    } catch (e) {
      return '';
    }
  }

  function setRadarStatus(message, canRetry, disabled) {
    document.getElementById('radar-time').textContent = message;
    document.getElementById('radar-retry').classList.toggle('hidden', !canRetry);
    var controls = ['radar-prev', 'radar-next', 'radar-scrubber'];
    for (var i = 0; i < controls.length; i++) {
      document.getElementById(controls[i]).disabled = !!disabled;
    }
    document.getElementById('radar-play').disabled = !!disabled || radarAnimationSpeed === 0;
  }

  function updateRadarScrubber() {
    var scrubber = document.getElementById('radar-scrubber');
    scrubber.max = String(Math.max(0, radarFrames.length - 1));
    scrubber.value = String(Math.min(radarIndex, Math.max(0, radarFrames.length - 1)));
    scrubber.disabled = radarFrames.length === 0;
    document.getElementById('radar-frame-position').textContent = tr('radar.framePosition', {
      current: radarFrames.length ? localNumber(radarIndex + 1) : '0',
      total: localNumber(radarFrames.length)
    });
  }

  function applyRadarPaletteToLayer(layer) {
    if (!layer || !layer.getContainer) return;
    var container = layer.getContainer();
    if (!container) return;
    container.classList.remove('radar-palette-colorblind', 'radar-palette-contrast');
    if (radarPalette !== 'standard') container.classList.add('radar-palette-' + radarPalette);
  }

  function applyRadarPalette() {
    applyRadarPaletteToLayer(radarLayer);
    applyRadarPaletteToLayer(radarLayerNext);
    var legend = document.getElementById('radar-legend');
    legend.classList.remove('palette-standard', 'palette-colorblind', 'palette-contrast');
    legend.classList.add('palette-' + radarPalette);
    legend.setAttribute('aria-label', tr('radar.legend.' + radarPalette));
  }

  function selectRadarFrame(index) {
    if (!radarFrames.length) return;
    radarIndex = Math.max(0, Math.min(radarFrames.length - 1, Number(index) || 0));
    radarSemanticState = null;
    showRadarFrame(radarIndex);
    updateRadarTimeDisplay();
    updateRadarScrubber();
    sampleRadarCenter(radarFrames[radarIndex]);
    preloadRadarFrame((radarIndex + 1) % radarFrames.length);
  }

  function createRadarTileLayer(index) {
    var frame = radarFrames[index];
    if (!frame) return null;
    var provider = StormScopeRadarProviders.providers[radarProviderId];
    var layer;
    if (radarProviderId === 'rainviewer') {
      if (!radarHost) return null;
      layer = L.tileLayer(radarHost + frame.path + '/256/{z}/{x}/{y}/' + RAINVIEWER_COLOR_SCHEME + '/1_1.png', {
        opacity: radarOpacity,
        zIndex: 400,
        maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM,
        maxZoom: 18,
        crossOrigin: 'anonymous',
        attribution: 'Radar: <a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
      });
    } else if (radarProviderId === 'noaa-mrms') {
      var params = StormScopeRadarProviders.noaaWmsParameters(frame);
      var wmsOptions = {
        layers: params.layers,
        format: params.format,
        transparent: true,
        version: params.version,
        crs: L.CRS.EPSG3857,
        opacity: radarOpacity,
        zIndex: 400,
        maxZoom: 18,
        crossOrigin: 'anonymous',
        attribution: 'Radar: <a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
      };
      if (params.time) wmsOptions.time = params.time;
      layer = L.tileLayer.wms(provider.tile.endpoint, wmsOptions);
    } else {
      return null;
    }
    var tileErrors = 0;
    layer.on('tileerror', function () {
      tileErrors += 1;
      if (tileErrors < 3 || radarLayer !== layer) return;
      setTimeout(function () {
        if (radarLayer !== layer) return;
        if (radarProviderId === 'rainviewer' && navigator.onLine) {
          setRadarStatus(tr('radar.tileFallback'), false, true);
          initRadar({ forceNoaa: true, resumePlayback: radarPlaying });
        } else {
          clearRadarDisplay();
          setRadarStatus(tr('radar.tilesUnavailable'), true, true);
        }
      }, 0);
    });
    return layer;
  }

  function preloadRadarFrame(index) {
    if (radarLayerNext) {
      map.removeLayer(radarLayerNext);
    }
    clearTimeout(radarPreloadTimer);
    var startedAt = Date.now();
    radarPreloadState = { status: 'loading', durationMs: null, index: index };
    radarLayerNext = createRadarTileLayer(index);
    if (radarLayerNext) {
      var preloadLayer = radarLayerNext;
      radarLayerNext.setOpacity(0);
      radarLayerNext.addTo(map);
      applyRadarPaletteToLayer(radarLayerNext);
      function finishPreload(status) {
        if (radarLayerNext !== preloadLayer) return;
        clearTimeout(radarPreloadTimer);
        radarPreloadTimer = null;
        map.removeLayer(preloadLayer);
        radarLayerNext = null;
        radarPreloadState = {
          status: status,
          durationMs: Date.now() - startedAt,
          index: index
        };
      }
      preloadLayer.once('load', function () {
        setTimeout(function () { finishPreload('complete'); }, 0);
      });
      radarPreloadTimer = setTimeout(function () { finishPreload('timeout'); }, 5000);
    } else {
      radarPreloadState = { status: 'unavailable', durationMs: 0, index: index };
    }
  }

  function showRadarFrame(index) {
    if (radarLayer) {
      map.removeLayer(radarLayer);
      radarLayer = null;
    }
    radarLayer = createRadarTileLayer(index);
    if (radarLayer && radarVisible) {
      radarLayer.addTo(map);
      applyRadarPaletteToLayer(radarLayer);
    }
  }

  function updateRadarTimeDisplay() {
    var frame = radarFrames[radarIndex];
    if (!frame) return;
    var d = new Date(frame.time);
    var timeStr = d.toLocaleTimeString(appLocale, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    });
    var age = StormScopeRadarProviders.getFrameAge(frame, radarProviderId);
    var ageLabel = StormScopeI18n.formatAge(age.ageMinutes, appLocale);
    var state = radarSemanticState;
    var stateKeys = { clear: 'radar.state.clear', 'no-coverage': 'radar.state.noCoverage', stale: 'radar.state.stale' };
    var label = state && stateKeys[state.state]
      ? tr(stateKeys[state.state], { age: ageLabel })
      : tr('radar.pastFrame', { time: timeStr, age: ageLabel });
    setRadarStatus(label, state ? state.canRetry : false, state ? !state.controlsEnabled : false);
    updateRadarProviderUI();
  }

  function updateRadarProviderUI() {
    if (!radarProviderSelection || !radarFrames.length) return;
    var provider = StormScopeRadarProviders.providers[radarProviderId];
    var age = StormScopeRadarProviders.getFrameAge(radarFrames[radarIndex], radarProviderId);
    var reason = radarProviderSelection.degradationReason
      ? ' • ' + tr('radar.degraded', { reason: radarProviderSelection.degradationReason.replace(/-/g, ' ') })
      : '';
    document.getElementById('radar-meta').textContent = provider.label +
      (radarProviderSelection.isFallback ? tr('radar.fallbackSuffix') : '') + ' • ' +
      tr('radar.resolution.' + radarProviderId) + ' • ' + StormScopeI18n.formatAge(age.ageMinutes, appLocale) + reason;
    var source = document.getElementById('radar-source');
    source.textContent = provider.attribution.text;
    source.href = provider.attribution.url;
  }

  function updateCoverageLayer() {
    if (radarCoverageLayer) {
      map.removeLayer(radarCoverageLayer);
      radarCoverageLayer = null;
    }
    var toggle = document.getElementById('toggle-coverage');
    var supported = radarProviderId === 'rainviewer' && !!radarHost;
    toggle.disabled = !supported;
    if (!supported) toggle.checked = false;
    if (!supported || !toggle.checked) return;
    radarCoverageLayer = L.tileLayer(
      radarHost + '/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png', {
        opacity: 0.2,
        zIndex: 350,
        maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM,
        maxZoom: 18,
        crossOrigin: 'anonymous',
        attribution: 'Coverage: RainViewer'
      }
    ).addTo(map);
  }

  function contextTimestamp(value) {
    return StormScopeI18n.formatDateTime(value, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }, appLocale);
  }

  function setContextStatusElement(id, message, state) {
    var element = document.getElementById(id);
    element.textContent = message;
    element.classList.toggle('error', state === 'error');
    element.classList.toggle('stale', state === 'stale');
  }

  function renderLightningStatus() {
    if (lightningStatusState === 'off') {
      setContextStatusElement('lightning-status', tr('context.lightningOff'), 'off');
      return;
    }
    if (lightningStatusState === 'loading') {
      setContextStatusElement('lightning-status', tr('context.loading'), 'loading');
      return;
    }
    if (lightningStatusState === 'error') {
      setContextStatusElement('lightning-status', tr(lightningLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var freshness = StormScopeContextLayers.freshness(
      lightningLatestTime, StormScopeContextLayers.providers.lightning.staleMs
    );
    setContextStatusElement('lightning-status', tr('context.lightningStatus', {
      freshness: tr('context.' + freshness.state), time: contextTimestamp(lightningLatestTime)
    }), freshness.state);
  }

  function renderWildfireStatus() {
    if (wildfireStatusState === 'off') {
      setContextStatusElement('wildfire-status', tr('context.wildfiresOff'), 'off');
      return;
    }
    if (wildfireStatusState === 'loading') {
      setContextStatusElement('wildfire-status', tr('context.loading'), 'loading');
      return;
    }
    if (wildfireStatusState === 'error') {
      setContextStatusElement('wildfire-status', tr(wildfireLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var freshness = StormScopeContextLayers.freshness(
      wildfireUpdatedAt, StormScopeContextLayers.providers.wildfires.staleMs
    );
    setContextStatusElement('wildfire-status', tr('context.wildfireStatus', {
      count: localNumber(wildfireCount), freshness: tr('context.' + freshness.state), time: contextTimestamp(wildfireUpdatedAt)
    }), freshness.state);
  }

  function scheduleLightningRefresh() {
    clearTimeout(lightningRefreshTimer);
    lightningRefreshTimer = null;
    if (!document.getElementById('toggle-lightning').checked) return;
    lightningRefreshTimer = setTimeout(refreshLightning, StormScopeContextLayers.providers.lightning.refreshMs);
  }

  async function refreshLightning() {
    if (!document.getElementById('toggle-lightning').checked || document.hidden) return;
    if (lightningAbort) lightningAbort.abort();
    lightningAbort = new AbortController();
    lightningStatusState = 'loading';
    renderLightningStatus();
    try {
      var provider = StormScopeContextLayers.providers.lightning;
      var response = await fetch(provider.capabilitiesUrl, { cache: 'no-store', signal: lightningAbort.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var discovery = StormScopeContextLayers.parseLightningCapabilities(await response.text());
      var nextLayer = L.tileLayer.wms(provider.wmsUrl, {
        layers: provider.layer, styles: provider.style, format: 'image/png', transparent: true,
        version: '1.3.0', time: new Date(discovery.latestTime).toISOString(), opacity: 0.62,
        pane: 'contextRasterPane', crossOrigin: 'anonymous',
        attribution: 'Lightning: <a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
      });
      var tileErrors = 0;
      nextLayer.on('tileerror', function () {
        tileErrors += 1;
        if (tileErrors >= 3 && lightningLayer === nextLayer) {
          lightningStatusState = 'error';
          renderLightningStatus();
        }
      });
      nextLayer.addTo(map);
      if (lightningLayer) map.removeLayer(lightningLayer);
      lightningLayer = nextLayer;
      lightningLatestTime = discovery.latestTime;
      lightningStatusState = 'ready';
      renderLightningStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      lightningStatusState = 'error';
      renderLightningStatus();
    } finally {
      scheduleLightningRefresh();
    }
  }

  function disableLightning() {
    if (lightningAbort) lightningAbort.abort();
    clearTimeout(lightningRefreshTimer);
    lightningRefreshTimer = null;
    if (lightningLayer) map.removeLayer(lightningLayer);
    lightningLayer = null;
    lightningStatusState = 'off';
    renderLightningStatus();
  }

  function wildfirePopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var name = document.createElement('strong');
    name.textContent = properties.poly_IncidentName || tr('context.wildfireName');
    container.appendChild(name);
    if (Number.isFinite(Number(properties.poly_GISAcres))) {
      var acres = document.createElement('span');
      acres.textContent = tr('context.acres', { count: localNumber(Math.round(Number(properties.poly_GISAcres))) });
      container.appendChild(acres);
    }
    if (Number.isFinite(Number(properties.attr_PercentContained))) {
      var contained = document.createElement('span');
      contained.textContent = tr('context.contained', { count: localNumber(Math.round(Number(properties.attr_PercentContained))) });
      container.appendChild(contained);
    }
    var link = document.createElement('a');
    link.href = StormScopeContextLayers.providers.wildfires.attribution.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('context.nifcSource');
    container.appendChild(link);
    return container;
  }

  function scheduleWildfireRefresh() {
    clearTimeout(wildfireRefreshTimer);
    wildfireRefreshTimer = null;
    if (!document.getElementById('toggle-wildfires').checked) return;
    wildfireRefreshTimer = setTimeout(refreshWildfires, StormScopeContextLayers.providers.wildfires.refreshMs);
  }

  async function refreshWildfires() {
    if (!document.getElementById('toggle-wildfires').checked || document.hidden) return;
    if (wildfireAbort) wildfireAbort.abort();
    wildfireAbort = new AbortController();
    wildfireStatusState = 'loading';
    renderWildfireStatus();
    try {
      var provider = StormScopeContextLayers.providers.wildfires;
      var bounds = map.getBounds();
      var urls = StormScopeContextLayers.buildWildfireQueries({
        west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth()
      });
      var requests = [provider.layerUrl + '?f=pjson'].concat(urls).map(function (url) {
        return fetch(url, { cache: 'no-store', signal: wildfireAbort.signal }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        });
      });
      var payloads = await Promise.all(requests);
      var metadata = StormScopeContextLayers.parseWildfireMetadata(payloads[0]);
      var merged = { type: 'FeatureCollection', features: [] };
      payloads.slice(1).forEach(function (payload) {
        if (payload && Array.isArray(payload.features)) merged.features.push.apply(merged.features, payload.features);
      });
      var collection = StormScopeContextLayers.normalizeWildfireCollection(merged);
      var nextLayer = L.geoJSON(collection, {
        pane: 'contextVectorPane',
        style: { color: '#ff6b35', weight: 2, opacity: 0.9, fillColor: '#ff6b35', fillOpacity: 0.09 },
        onEachFeature: function (feature, layer) { layer.bindPopup(wildfirePopup(feature)); }
      }).addTo(map);
      if (wildfireLayer) map.removeLayer(wildfireLayer);
      wildfireLayer = nextLayer;
      if (!wildfireAttributionAdded) {
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        wildfireAttributionAdded = true;
      }
      wildfireUpdatedAt = metadata.updatedAt;
      wildfireCount = collection.features.length;
      wildfireStatusState = 'ready';
      renderWildfireStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      wildfireStatusState = 'error';
      renderWildfireStatus();
    } finally {
      scheduleWildfireRefresh();
    }
  }

  function disableWildfires() {
    if (wildfireAbort) wildfireAbort.abort();
    clearTimeout(wildfireRefreshTimer);
    clearTimeout(wildfireMoveTimer);
    wildfireRefreshTimer = null;
    wildfireMoveTimer = null;
    if (wildfireLayer) map.removeLayer(wildfireLayer);
    wildfireLayer = null;
    if (wildfireAttributionAdded) {
      var provider = StormScopeContextLayers.providers.wildfires;
      map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
      wildfireAttributionAdded = false;
    }
    wildfireStatusState = 'off';
    renderWildfireStatus();
  }

  function centerTileCoordinate(zoom) {
    var center = map.getCenter();
    var scale = Math.pow(2, zoom);
    var x = (center.lng + 180) / 360 * scale;
    var latitude = Math.max(-85.05112878, Math.min(85.05112878, center.lat));
    var radians = latitude * Math.PI / 180;
    var y = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * scale;
    return {
      x: Math.floor(x),
      y: Math.floor(y),
      pixelX: Math.floor((x - Math.floor(x)) * 256),
      pixelY: Math.floor((y - Math.floor(y)) * 256)
    };
  }

  function sampleTilePixel(url, coordinate) {
    return new Promise(function (resolve) {
      var image = new Image();
      var settled = false;
      var timeout = setTimeout(function () { if (!settled) resolve(null); }, 4000);
      image.crossOrigin = 'anonymous';
      image.onload = function () {
        settled = true;
        clearTimeout(timeout);
        try {
          var canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          var context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, -coordinate.pixelX, -coordinate.pixelY);
          resolve(Array.from(context.getImageData(0, 0, 1, 1).data));
        } catch (error) {
          resolve(null);
        }
      };
      image.onerror = function () { settled = true; clearTimeout(timeout); resolve(null); };
      image.src = url;
    });
  }

  async function sampleRadarCenter(frame) {
    if (!frame || radarProviderId !== 'rainviewer') {
      radarSemanticState = StormScopeRadarProviders.classifyRadarState({ frame: frame, coverage: true });
      updateRadarTimeDisplay();
      return;
    }
    var token = ++radarSampleToken;
    var zoom = Math.min(map.getZoom(), RAINVIEWER_MAX_NATIVE_ZOOM);
    var coordinate = centerTileCoordinate(zoom);
    var pixels = await Promise.all([
      sampleTilePixel(StormScopeRadarProviders.buildRainViewerCoverageUrl(
        radarHost, zoom, coordinate.x, coordinate.y
      ), coordinate),
      sampleTilePixel(StormScopeRadarProviders.buildRainViewerTileUrl(
        frame, zoom, coordinate.x, coordinate.y
      ), coordinate)
    ]);
    if (token !== radarSampleToken || frame !== radarFrames[radarIndex]) return;
    var coveragePixel = pixels[0];
    var radarPixel = pixels[1];
    var covered = coveragePixel
      ? !(coveragePixel[3] > 0 && coveragePixel[0] < 16 && coveragePixel[1] < 16 && coveragePixel[2] < 16)
      : null;
    radarSemanticState = StormScopeRadarProviders.classifyRadarState({
      frame: frame,
      coverage: covered,
      hasPrecipitation: radarPixel ? radarPixel[3] > 0 : null
    });
    updateRadarTimeDisplay();
  }

  function stepRadar(delta) {
    if (radarFrames.length === 0) return;
    selectRadarFrame((radarIndex + delta + radarFrames.length) % radarFrames.length);
  }

  function setRadarPlaying(playing) {
    radarPlaying = Boolean(playing && radarAnimationSpeed > 0 && radarFrames.length);
    document.getElementById('icon-play').classList.toggle('hidden', radarPlaying);
    document.getElementById('icon-pause').classList.toggle('hidden', !radarPlaying);
    document.getElementById('radar-play').setAttribute('aria-pressed', String(radarPlaying));
    document.getElementById('radar-time').setAttribute('aria-live', radarPlaying ? 'off' : 'polite');

    clearInterval(radarAnimTimer);
    radarAnimTimer = null;

    if (radarPlaying) {
      radarAnimTimer = setInterval(function () {
        stepRadar(1);
      }, radarAnimationSpeed);
    }
  }

  // ── Camera Layer ──

  function createCameraIcon(type, health) {
    var isYouTube = type === 'youtube';
    var isEmbed = type === 'embed';
    var healthClass = 'health-' + (health || 'unknown');
    var cls = (isYouTube ? 'camera-marker youtube-marker' : (isEmbed ? 'camera-marker embed-marker' : 'camera-marker')) + ' ' + healthClass;
    var svg;
    if (isYouTube) {
      svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/></svg>';
    } else if (isEmbed) {
      svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-2.67 0-8-1.34-8-4v-.8c0-1.33 5.33-2.7 8-2.7s8 1.37 8 2.7v.8c0 2.66-5.33 4-8 4z"/></svg>';
    } else {
      svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 19V7.5l-7 4.5V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4l7 4.5z"/></svg>';
    }
    var targetSize = window.matchMedia('(max-width: 600px)').matches ? 44 : 32;
    return L.divIcon({
      className: '',
      html: '<div class="' + cls + '">' + svg + '</div>',
      iconSize: [targetSize, targetSize],
      iconAnchor: [targetSize / 2, targetSize / 2]
    });
  }

  function cameraIconFor(cam) {
    var iconKey = cam.type === 'youtube' ? 'youtube' : (cam.type === 'embed' ? 'embed' : 'dot');
    var health = ['healthy', 'degraded', 'offline'].indexOf(cam.health) >= 0 ? cam.health : 'unknown';
    var key = iconKey + '-' + health;
    if (!cameraIconCache[key]) cameraIconCache[key] = createCameraIcon(iconKey, health);
    return cameraIconCache[key];
  }

  function loadCameraHealthOverrides() {
    try {
      var value = JSON.parse(localStorage.getItem('stormscope-camera-health-v1') || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : Object.create(null);
    } catch (error) {
      return Object.create(null);
    }
  }

  function persistCameraHealthOverrides() {
    try { localStorage.setItem('stormscope-camera-health-v1', JSON.stringify(cameraHealthOverrides)); } catch (error) { /* optional */ }
  }

  function cameraHealthKey(cam) {
    return cam.type + '|' + (cam.source_url || cam.url);
  }

  function recordCameraHealth(cam, health, failureClass) {
    if (!cam) return;
    cam.health = health;
    cam.failure_class = failureClass || null;
    if (health === 'healthy') cam.last_verified = new Date().toISOString();
    cameraHealthOverrides[cameraHealthKey(cam)] = {
      health: cam.health,
      failure_class: cam.failure_class,
      last_verified: cam.last_verified || null
    };
    persistCameraHealthOverrides();
    if (cam._marker) {
      cam._marker.setIcon(cameraIconFor(cam));
      var element = cam._marker.getElement();
      if (element) element.setAttribute('aria-label', tr('camera.feedLabel', { name: cam.name, health: tr('camera.health.' + (cam.health || 'unknown')) }));
    }
    if (activeCamera === cam) updateModalCameraHealth(cam);
  }

  async function loadCameras() {
    try {
      document.getElementById('camera-count').textContent = tr('camera.loadingCount');
      cameraDataTimestamp = new Date();
      cameraHealthOverrides = loadCameraHealthOverrides();
      cameraCluster = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        disableClusteringAtZoom: 13,
        chunkedLoading: true,
        chunkInterval: 50,
        chunkDelay: 25,
        iconCreateFunction: function (cluster) {
          var count = cluster.getChildCount();
          var size = count < 50 ? 'small' : count < 200 ? 'medium' : 'large';
          return L.divIcon({
            html: '<div><span>' + count + '</span></div>',
            className: 'marker-cluster marker-cluster-' + size,
            iconSize: L.point(40, 40)
          });
        }
      });
      if (document.getElementById('toggle-cameras').checked) map.addLayer(cameraCluster);
      allCameras = [];
      cameraLoadProcessed = 0;
      cameraLoadMetrics = { startedAt: performance.now(), firstBatchMs: null, completeMs: null, source: null };
      cameraStore = new StormScopeCameraStore.CameraStore({
        indexUrl: 'data/cameras.index.json',
        monolithUrl: 'data/cameras.json'
      });
      var result = await cameraStore.load({
        onProgress: function (progress) {
          if (progress.source === 'monolith' && cameraLoadMetrics.source !== 'monolith') {
            // Shard loading fell back to the monolith mid-stream: the store replaced
            // its camera objects, so any markers already added reference stale objects
            // that no longer match the search corpus. Rebuild markers from the fresh
            // corpus so filtering never drops orphaned markers.
            if (cameraCluster) cameraCluster.clearLayers();
            allCameras = [];
            cameraLoadProcessed = 0;
          }
          var loaded = cameraStore.getCameras();
          var batch = loaded.slice(cameraLoadProcessed);
          cameraLoadProcessed = loaded.length;
          if (batch.length) addCameraBatch(batch);
          if (cameraLoadMetrics.firstBatchMs == null && loaded.length) {
            cameraLoadMetrics.firstBatchMs = performance.now() - cameraLoadMetrics.startedAt;
          }
          cameraLoadMetrics.source = progress.source;
          document.getElementById('camera-count').textContent = tr('camera.countProgress', {
            loaded: localNumber(progress.loaded), total: localNumber(progress.total)
          });
          document.getElementById('search-progress').textContent = progress.complete
            ? tr('search.loaded', { count: localNumber(progress.total) })
            : tr('search.shards', { loaded: localNumber(progress.shardsLoaded), total: localNumber(progress.shardsTotal) });
          updateSearchStateOptions();
          scheduleSearchRender();
        }
      });
      cameraLoadMetrics.completeMs = performance.now() - cameraLoadMetrics.startedAt;
      cameraLoadMetrics.source = result.source;
      document.getElementById('camera-count').textContent = tr('camera.count', { count: localNumber(allCameras.length) });
      document.getElementById('search-progress').textContent = tr('camera.firstBatch', {
        count: localNumber(allCameras.length), milliseconds: localNumber(Math.round(cameraLoadMetrics.firstBatchMs || 0))
      });
      updateDataFreshness();
      scheduleSearchRender();
    } catch (e) {
      if (e.name === 'AbortError') return;
      document.getElementById('camera-count').textContent = tr('camera.failed');
      document.getElementById('search-progress').textContent = tr('search.loadFailed');
      updateDataFreshness(true);
    }
  }

  function addCameraBatch(batch) {
    var markers = [];
    for (var i = 0; i < batch.length; i++) {
      var cam = batch[i];
      var override = cameraHealthOverrides[cameraHealthKey(cam)];
      if (override) {
        cam.health = override.health || cam.health;
        cam.failure_class = override.failure_class || null;
        cam.last_verified = override.last_verified || cam.last_verified;
      }
      var marker = L.marker([cam.lat, cam.lon], {
        icon: cameraIconFor(cam),
        title: cam.name + ' — ' + (cam.health || 'unknown') + ' feed'
      });
      marker._camData = cam;
      cam._marker = marker;
      marker.on('click', onCameraClick);
      marker.on('mouseover', onMarkerHover);
      marker.on('add', function (event) {
        var element = event.target.getElement();
        var camera = event.target._camData;
        if (element && camera) element.setAttribute('aria-label', tr('camera.feedLabel', {
          name: camera.name, health: tr('camera.health.' + (camera.health || 'unknown'))
        }));
      });
      markers.push(marker);
      allCameras.push(cam);
    }
    cameraCluster.addLayers(markers);
  }

  function updateSearchStateOptions() {
    var datalist = document.getElementById('camera-states');
    var values = Array.from(new Set(allCameras.map(function (camera) {
      return String(camera.state || '').trim();
    }).filter(Boolean))).sort(function (left, right) {
      return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
    });
    var signature = values.join('\n');
    if (datalist.dataset.signature === signature) return;
    datalist.dataset.signature = signature;
    datalist.replaceChildren();
    values.forEach(function (value) {
      var option = document.createElement('option');
      option.value = value;
      datalist.appendChild(option);
    });
  }

  function cameraSearchFilters() {
    return {
      query: document.getElementById('camera-query').value,
      state: document.getElementById('camera-state').value,
      source: document.getElementById('camera-source').value,
      type: document.getElementById('camera-type').value,
      healthy: document.getElementById('camera-healthy').checked
    };
  }

  function cameraSearchIsFiltered(filters) {
    return Boolean(filters.query.trim() || filters.state.trim() || filters.source || filters.type ||
      filters.healthy || document.getElementById('camera-favorites').checked);
  }

  function syncCameraMarkers(results, filtered) {
    if (!cameraCluster) return;
    cameraCluster.clearLayers();
    var cameras = filtered ? results : allCameras;
    cameraCluster.addLayers(cameras.map(function (camera) { return camera._marker; }).filter(Boolean));
  }

  function cameraResultSummary(camera) {
    var parts = [];
    if (camera.road && camera.road !== camera.name) parts.push(camera.road);
    if (camera.county) parts.push(camera.county);
    if (camera.state) parts.push(camera.state);
    parts.push(tr('camera.health.' + (camera.health || 'unknown')) + ' • ' + (camera.source || camera.type || 'camera'));
    return parts.join(' • ');
  }

  function selectCameraResult(camera) {
    map.setView([camera.lat, camera.lon], Math.max(14, map.getZoom()));
    openCameraModal(camera);
  }

  function toggleCameraFavorite(camera) {
    try {
      savedStore.toggleFavorite(camera.id);
      updateFavoriteButton(camera);
      renderCameraResults();
    } catch (error) {
      document.getElementById('camera-results-status').textContent = tr('search.favoriteError', { error: error.message });
    }
  }

  function updateMonitorSelectionUi(message) {
    var count = monitorSelection.count();
    var status = document.getElementById('monitor-selection-status');
    status.textContent = message || tr('monitor.selection', { count: localNumber(count) });
    status.classList.toggle('error', Boolean(message));
    document.getElementById('monitor-bandwidth').classList.toggle('hidden', count < 2);
    var start = document.getElementById('open-monitor');
    start.disabled = !monitorSelection.canStart();
    start.textContent = count ? tr('monitor.startCount', { count: localNumber(count) }) : tr('monitor.start');
  }

  function toggleMonitorCamera(camera) {
    try {
      monitorSelection.toggle(camera);
      updateMonitorSelectionUi();
      renderCameraResults();
    } catch (error) {
      updateMonitorSelectionUi(tr('monitor.maximum'));
    }
  }

  function renderCameraResults() {
    var list = document.getElementById('camera-results');
    var scroller = document.getElementById('camera-results-scroll');
    list.replaceChildren();
    if (!cameraStore) {
      document.getElementById('camera-results-status').textContent = tr('search.indexPending');
      return;
    }

    var filters = cameraSearchFilters();
    var center = map.getCenter();
    var results = cameraStore.search(filters, {
      sortBy: document.getElementById('camera-sort').value,
      origin: { lat: center.lat, lon: center.lng },
      healthFirst: true
    });
    if (document.getElementById('camera-favorites').checked) {
      results = results.filter(function (camera) { return savedStore.isFavorite(camera.id); });
    }
    currentCameraResults = results;
    var filtered = cameraSearchIsFiltered(filters);
    syncCameraMarkers(results, filtered);
    document.getElementById('camera-results-status').textContent = tr('search.results', {
      count: localNumber(results.length),
      label: tr(results.length === 1 ? 'search.resultOne' : 'search.resultMany'),
      map: filtered ? tr('search.shownOnMap') : ''
    });

    var virtual = StormScopeCameraStore.virtualize(results, {
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight || 360,
      itemHeight: 68,
      overscan: 4
    });
    if (virtual.offsetTop) {
      var before = document.createElement('li');
      before.style.height = virtual.offsetTop + 'px';
      before.setAttribute('aria-hidden', 'true');
      list.appendChild(before);
    }
    virtual.items.forEach(function (camera) {
      var item = document.createElement('li');
      item.className = 'camera-result';
      var openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'camera-result-open';
      var name = document.createElement('strong');
      name.textContent = camera.name;
      var summary = document.createElement('span');
      summary.textContent = cameraResultSummary(camera);
      openButton.appendChild(name);
      openButton.appendChild(summary);
      openButton.addEventListener('click', function () { selectCameraResult(camera); });
      var favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'favorite-result';
      favorite.setAttribute('aria-label', tr(savedStore.isFavorite(camera.id) ? 'camera.favoriteRemove' : 'camera.favoriteAdd', {
        name: camera.name
      }));
      favorite.setAttribute('aria-pressed', String(savedStore.isFavorite(camera.id)));
      favorite.textContent = savedStore.isFavorite(camera.id) ? '★' : '☆';
      favorite.addEventListener('click', function () { toggleCameraFavorite(camera); });
      var monitor = document.createElement('button');
      monitor.type = 'button';
      monitor.className = 'monitor-result';
      monitor.setAttribute('aria-pressed', String(monitorSelection.has(camera)));
      monitor.setAttribute('aria-label', tr(monitorSelection.has(camera) ? 'monitor.remove' : 'monitor.add', { name: camera.name }));
      monitor.textContent = monitorSelection.has(camera) ? '−' : '+';
      monitor.addEventListener('click', function () { toggleMonitorCamera(camera); });
      item.appendChild(openButton);
      item.appendChild(favorite);
      item.appendChild(monitor);
      list.appendChild(item);
    });
    if (virtual.offsetBottom) {
      var after = document.createElement('li');
      after.style.height = virtual.offsetBottom + 'px';
      after.setAttribute('aria-hidden', 'true');
      list.appendChild(after);
    }
  }

  function scheduleSearchRender(resetScroll) {
    clearTimeout(searchRenderTimer);
    if (resetScroll) document.getElementById('camera-results-scroll').scrollTop = 0;
    searchRenderTimer = setTimeout(renderCameraResults, 100);
  }

  function updateFavoriteButton(camera) {
    var button = document.getElementById('favorite-camera');
    if (!camera || !savedStore) {
      button.setAttribute('aria-pressed', 'false');
      button.textContent = tr('camera.favorite');
      return;
    }
    var favorite = savedStore.isFavorite(camera.id);
    button.setAttribute('aria-pressed', String(favorite));
    button.textContent = tr(favorite ? 'camera.favorited' : 'camera.favorite');
  }

  function captureViewSnapshot() {
    var center = map.getCenter();
    return {
      center: { lat: center.lat, lon: center.lng },
      zoom: map.getZoom(),
      layers: {
        radar: document.getElementById('toggle-radar').checked,
        cameras: document.getElementById('toggle-cameras').checked,
        coverage: document.getElementById('toggle-coverage').checked,
        alerts: document.getElementById('toggle-alerts').checked,
        lightning: document.getElementById('toggle-lightning').checked,
        wildfires: document.getElementById('toggle-wildfires').checked
      },
      opacity: { radar: radarOpacity }
    };
  }

  function applyViewSnapshot(snapshot) {
    if (!snapshot) return;
    map.setView([snapshot.center.lat, snapshot.center.lon], snapshot.zoom);
    var layers = snapshot.layers || {};
    if (typeof layers.radar === 'boolean') {
      radarVisible = layers.radar;
      document.getElementById('toggle-radar').checked = radarVisible;
      if (radarLayer) {
        if (radarVisible) radarLayer.addTo(map);
        else map.removeLayer(radarLayer);
      }
    }
    if (typeof layers.cameras === 'boolean') {
      document.getElementById('toggle-cameras').checked = layers.cameras;
      if (cameraCluster) {
        if (layers.cameras) cameraCluster.addTo(map);
        else map.removeLayer(cameraCluster);
      }
    }
    if (typeof layers.coverage === 'boolean') {
      document.getElementById('toggle-coverage').checked = layers.coverage;
      if (radarHost) updateCoverageLayer();
    }
    if (typeof layers.alerts === 'boolean') {
      alertsVisible = layers.alerts;
      document.getElementById('toggle-alerts').checked = alertsVisible;
      if (!alertsVisible && alertLayerGroup) map.removeLayer(alertLayerGroup);
      if (alertsVisible && alertLayerGroup) alertLayerGroup.addTo(map);
    }
    if (typeof layers.lightning === 'boolean') {
      document.getElementById('toggle-lightning').checked = layers.lightning;
      if (layers.lightning) refreshLightning();
      else disableLightning();
    }
    if (typeof layers.wildfires === 'boolean') {
      document.getElementById('toggle-wildfires').checked = layers.wildfires;
      if (layers.wildfires) refreshWildfires();
      else disableWildfires();
    }
    if (snapshot.opacity && typeof snapshot.opacity.radar === 'number') {
      radarOpacity = snapshot.opacity.radar;
      document.getElementById('radar-opacity').value = String(Math.round(radarOpacity * 100));
      if (radarLayer) radarLayer.setOpacity(radarOpacity);
    }
  }

  function setSavedStateStatus(message, error) {
    var status = document.getElementById('saved-state-status');
    status.textContent = message;
    status.classList.toggle('error', Boolean(error));
  }

  function refreshSavedViews(selectedId) {
    var select = document.getElementById('saved-views');
    select.replaceChildren();
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = tr('views.choose');
    select.appendChild(placeholder);
    savedStore.listViews().forEach(function (view) {
      var option = document.createElement('option');
      option.value = view.id;
      option.textContent = view.name;
      select.appendChild(option);
    });
    select.value = selectedId || '';
    var hasSelection = Boolean(select.value);
    document.getElementById('load-view').disabled = !hasSelection;
    document.getElementById('delete-view').disabled = !hasSelection;
  }

  function scheduleLastViewSave() {
    if (!savedStore) return;
    clearTimeout(saveLastViewTimer);
    saveLastViewTimer = setTimeout(function () {
      try { savedStore.setLastView(captureViewSnapshot()); } catch (error) {
        setSavedStateStatus(tr('views.lastSaveError', { error: error.message }), true);
      }
    }, 400);
  }

  function initSavedState() {
    savedStore = StormScopeSavedState.createStore();
    var storeStatus = savedStore.getStatus();
    refreshSavedViews();
    if (storeStatus.recoveredFromBackup) setSavedStateStatus(tr('views.recovered'));
    else if (storeStatus.loadError) setSavedStateStatus(tr('views.corrupt'), true);
    else if (!storeStatus.persistent) setSavedStateStatus(tr('views.sessionOnly'), true);
    applyViewSnapshot(savedStore.getLastView());
  }

  function updateDataFreshness(failed) {
    var status = document.getElementById('data-freshness');
    status.classList.remove('hidden', 'offline', 'stale');
    if (failed) {
      status.textContent = tr('camera.dataUnavailable');
      status.classList.add('stale');
      return;
    }
    var offline = !navigator.onLine;
    var stale = cameraDataTimestamp && Date.now() - cameraDataTimestamp.getTime() > 24 * 60 * 60 * 1000;
    var timestamp = cameraDataTimestamp
      ? StormScopeI18n.formatDateTime(cameraDataTimestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, appLocale)
      : tr('weather.unknown');
    status.textContent = tr(offline ? 'camera.offlineCache' : stale ? 'camera.stale' : 'camera.fresh', { time: timestamp });
    if (offline) status.classList.add('offline');
    if (stale) status.classList.add('stale');
  }

  function refreshCameraLoadLabels() {
    if (cameraLoadMetrics.completeMs == null || !allCameras.length) return;
    document.getElementById('camera-count').textContent = tr('camera.count', { count: localNumber(allCameras.length) });
    document.getElementById('search-progress').textContent = tr('camera.firstBatch', {
      count: localNumber(allCameras.length), milliseconds: localNumber(Math.round(cameraLoadMetrics.firstBatchMs || 0))
    });
  }

  function updateConnectionState() {
    var status = document.getElementById('connection-state');
    status.textContent = tr(navigator.onLine ? 'connection.online' : 'connection.offline');
    status.classList.toggle('offline', !navigator.onLine);
    if (cameraDataTimestamp) updateDataFreshness(false);
  }

  function onMarkerHover(e) {
    var marker = e.target;
    if (!marker.getTooltip()) {
      var cam = marker._camData;
      marker.bindTooltip(escapeHtml(cam.name), {
        direction: 'top',
        offset: [0, -14],
        className: 'cam-tooltip'
      });
      marker.openTooltip();
    }
  }

  function onCameraClick(e) {
    var cam = e.target._camData;
    openCameraModal(cam);
  }

  // ── Focus Trap ──

  function getFocusableElements(container) {
    return container.querySelectorAll(
      'button, [href], input, select, textarea, iframe, video, [tabindex]:not([tabindex="-1"])'
    );
  }

  function trapFocus(e) {
    var modal = document.querySelector('.modal:not(.hidden) .modal-content');
    if (!modal) return;
    var focusable = getFocusableElements(modal);
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (e.key === 'Tab') {
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  // ── Camera Modal ──

  function openCameraModal(cam) {
    activeCamera = cam;
    priorFocusEl = document.activeElement;
    var modal = document.getElementById('camera-modal');
    var feedEl = document.getElementById('modal-feed');
    var nameEl = document.getElementById('modal-cam-name');
    var locEl = document.getElementById('modal-cam-location');
    var sourceEl = document.getElementById('modal-cam-source');
    var weatherLoading = document.getElementById('weather-loading');
    var weatherData = document.getElementById('weather-data');

    nameEl.textContent = cam.name;
    var locParts = [];
    if (cam.county) locParts.push(cam.county);
    if (cam.state) locParts.push(cam.state);
    if (cam.direction) locParts.push(cam.direction);
    locEl.textContent = locParts.join(' • ');
    updateModalCameraHealth(cam);
    updateFavoriteButton(cam);
    sourceEl.href = cam.source_url || cam.url;

    feedEl.innerHTML = '<div class="feed-loading">' + tr('camera.feedLoading') + '</div>';
    weatherLoading.textContent = tr('camera.weatherLoading');
    weatherLoading.classList.remove('hidden');
    weatherData.innerHTML = '';
    weatherData.classList.add('hidden');

    modal.classList.remove('hidden');
    setModalBackgroundInert(true, modal);
    document.getElementById('modal-close').focus();
    document.addEventListener('keydown', trapFocus);

    loadCameraFeed(cam, feedEl);
    fetchWeather(cam.lat, cam.lon, cam);
  }

  function updateModalCameraHealth(cam) {
    var healthEl = document.getElementById('modal-cam-health');
    var health = cam.health || 'unknown';
    healthEl.className = 'health-badge health-' + health;
    healthEl.textContent = tr('camera.health.' + health);
    healthEl.title = cam.last_verified ? tr('camera.lastVerified', { time: localTime(cam.last_verified) }) : '';
  }

  function closeCameraModal() {
    activeCamera = null;
    if (weatherAbort) {
      weatherAbort.abort();
      weatherAbort = null;
    }

    document.removeEventListener('keydown', trapFocus);

    var feedEl = document.getElementById('modal-feed');
    destroyActiveFeed(feedEl);

    document.getElementById('camera-modal').classList.add('hidden');
    setModalBackgroundInert(false, document.getElementById('camera-modal'));
    feedEl.replaceChildren();

    if (priorFocusEl && priorFocusEl.focus) {
      priorFocusEl.focus();
      priorFocusEl = null;
    }
  }

  function setModalBackgroundInert(inert, modal) {
    modal = modal || document.getElementById('camera-modal');
    var children = document.body.children;
    for (var i = 0; i < children.length; i++) {
      var element = children[i];
      if (element === modal || element.tagName === 'SCRIPT') continue;
      if (inert) {
        element.dataset.modalInert = 'true';
        element.dataset.previousAriaHidden = element.getAttribute('aria-hidden') || '';
        element.inert = true;
        element.setAttribute('aria-hidden', 'true');
      } else if (element.dataset.modalInert === 'true') {
        element.inert = false;
        if (element.dataset.previousAriaHidden) {
          element.setAttribute('aria-hidden', element.dataset.previousAriaHidden);
        } else {
          element.removeAttribute('aria-hidden');
        }
        delete element.dataset.modalInert;
        delete element.dataset.previousAriaHidden;
      }
    }
  }

  function monitorSourceUrl(camera) {
    if (camera.type === 'youtube') return 'https://www.youtube.com/watch?v=' + encodeURIComponent(camera.url);
    return camera.source_url || camera.url;
  }

  function appendMonitorLink(container, camera, message) {
    var fallback = document.createElement('div');
    fallback.className = 'monitor-link-fallback';
    var text = document.createElement('span');
    text.textContent = message;
    var link = document.createElement('a');
    link.href = monitorSourceUrl(camera);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('monitor.openSource');
    fallback.appendChild(text);
    fallback.appendChild(link);
    container.replaceChildren(fallback);
  }

  function createMonitorImagePlayer(camera, container, refreshing) {
    var image = document.createElement('img');
    image.alt = camera.name;
    var timer = null;
    var active = false;
    function source() {
      return camera.url + (camera.url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
    }
    function pause() {
      active = false;
      clearInterval(timer);
      timer = null;
      image.removeAttribute('src');
    }
    function resume() {
      if (active) return;
      active = true;
      image.src = refreshing ? source() : camera.url;
      if (refreshing) timer = setInterval(function () { if (active) image.src = source(); }, IMAGE_REFRESH_INTERVAL);
    }
    container.replaceChildren(image);
    resume();
    return { pause: pause, resume: resume, destroy: function () { pause(); image.remove(); } };
  }

  function createMonitorYouTubePlayer(camera, container) {
    var iframe = document.createElement('iframe');
    iframe.title = camera.name;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(camera.url) +
      '?autoplay=1&mute=1&enablejsapi=1&rel=0';
    function command(name) {
      if (iframe.contentWindow) iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: name, args: [] }), '*');
    }
    container.replaceChildren(iframe);
    return {
      pause: function () { command('pauseVideo'); },
      resume: function () { command('playVideo'); },
      destroy: function () { command('stopVideo'); iframe.src = 'about:blank'; iframe.remove(); }
    };
  }

  function createMonitorHlsPlayer(camera, container) {
    var video = document.createElement('video');
    video.controls = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    var hls = null;
    var nativePlayback = video.canPlayType('application/vnd.apple.mpegurl');
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(camera.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () { video.play().catch(function () { /* controls remain */ }); });
    } else if (nativePlayback) {
      video.src = camera.url;
      video.play().catch(function () { /* controls remain */ });
    } else {
      throw new Error('HLS unsupported');
    }
    container.replaceChildren(video);
    return {
      pause: function () {
        video.pause();
        if (hls) hls.stopLoad();
        else video.removeAttribute('src');
      },
      resume: function () {
        if (hls) hls.startLoad(-1);
        else if (!video.hasAttribute('src')) { video.src = camera.url; video.load(); }
        video.play().catch(function () { /* controls remain */ });
      },
      destroy: function () {
        video.pause();
        if (hls) hls.destroy();
        video.removeAttribute('src');
        video.load();
        video.remove();
      }
    };
  }

  function createMonitorPlayer(camera, container) {
    var mode = StormScopeMultiCamera.capability(camera).mode;
    if (mode === 'image') return createMonitorImagePlayer(camera, container, true);
    if (mode === 'mjpeg') return createMonitorImagePlayer(camera, container, false);
    if (mode === 'youtube') return createMonitorYouTubePlayer(camera, container);
    if (mode === 'hls') return createMonitorHlsPlayer(camera, container);
    return null;
  }

  function openMonitor() {
    if (!monitorSelection.canStart()) return;
    if (activeCamera) closeCameraModal();
    closeMonitor(false);
    var modal = document.getElementById('monitor-modal');
    var grid = document.getElementById('monitor-grid');
    priorFocusEl = document.activeElement;
    monitorRegistry = new StormScopeMultiCamera.PlayerRegistry();
    if ('IntersectionObserver' in window) {
      monitorObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          monitorRegistry.setVisible(entry.target, entry.isIntersecting && entry.intersectionRatio > 0);
        });
      }, { root: grid, threshold: 0.05 });
    }

    monitorSelection.list().forEach(function (camera) {
      var cell = document.createElement('article');
      cell.className = 'monitor-cell';
      var heading = document.createElement('h3');
      heading.textContent = camera.name;
      var playerContainer = document.createElement('div');
      playerContainer.className = 'monitor-player';
      cell.appendChild(heading);
      cell.appendChild(playerContainer);
      grid.appendChild(cell);
      if (!StormScopeMultiCamera.capability(camera).playable) {
        appendMonitorLink(playerContainer, camera, tr('monitor.unsupported'));
        return;
      }
      try {
        var player = createMonitorPlayer(camera, playerContainer);
        monitorRegistry.register(cell, player);
        if (monitorObserver) monitorObserver.observe(cell);
      } catch (error) {
        appendMonitorLink(playerContainer, camera, tr('monitor.loadError'));
      }
    });
    monitorRegistry.setDocumentHidden(document.hidden);
    modal.classList.remove('hidden');
    document.getElementById('search-panel').classList.add('hidden');
    document.getElementById('btn-search').setAttribute('aria-expanded', 'false');
    setModalBackgroundInert(true, modal);
    document.addEventListener('keydown', trapFocus);
    document.getElementById('monitor-close').focus();
  }

  function closeMonitor(restoreFocus) {
    var modal = document.getElementById('monitor-modal');
    if (monitorObserver) monitorObserver.disconnect();
    monitorObserver = null;
    if (monitorRegistry) monitorRegistry.destroyAll();
    monitorRegistry = null;
    document.getElementById('monitor-grid').replaceChildren();
    if (!modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
      setModalBackgroundInert(false, modal);
      document.removeEventListener('keydown', trapFocus);
      if (restoreFocus !== false) {
        // The monitor is launched from the search panel, which is hidden while
        // the monitor is open — so the trigger button is no longer focusable.
        // Fall back to the always-visible search toggle to avoid dropping focus.
        var target = priorFocusEl && priorFocusEl.isConnected && priorFocusEl.offsetParent !== null
          ? priorFocusEl
          : document.getElementById('btn-search');
        if (target && target.focus) target.focus();
      }
      priorFocusEl = null;
    }
  }

  function loadCameraFeed(cam, container) {
    destroyActiveFeed(container);

    if (cam.type === 'youtube') {
      loadYouTubeFeed(cam, container);
    } else if (cam.type === 'hls') {
      loadHLSFeed(cam, container);
    } else if (cam.type === 'mjpeg') {
      loadMJPEGFeed(cam, container);
    } else if (cam.type === 'embed') {
      loadEmbedFeed(cam, container);
    } else {
      loadImageFeed(cam, container);
    }
  }

  function destroyActiveFeed(container) {
    clearInterval(imageRefreshTimer);
    imageRefreshTimer = null;

    var cleanup = activeFeedCleanup;
    activeFeedCleanup = null;
    if (cleanup) cleanup();

    if (!container) return;
    var orphanedVideos = container.querySelectorAll('video');
    for (var i = 0; i < orphanedVideos.length; i++) {
      orphanedVideos[i].pause();
      orphanedVideos[i].removeAttribute('src');
      orphanedVideos[i].load();
    }
    var orphanedFrames = container.querySelectorAll('iframe');
    for (var j = 0; j < orphanedFrames.length; j++) {
      orphanedFrames[j].src = 'about:blank';
    }
  }

  function renderFeedError(cam, container, message) {
    if (activeCamera !== cam) return;
    recordCameraHealth(cam, 'degraded', 'transient');
    destroyActiveFeed(container);

    var error = document.createElement('div');
    error.className = 'feed-error';
    error.setAttribute('role', 'alert');

    var text = document.createElement('p');
    text.textContent = message;
    error.appendChild(text);

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'feed-retry-btn';
    retry.textContent = tr('camera.feedRetry');
    retry.addEventListener('click', function () {
      if (activeCamera !== cam) return;
      recordCameraHealth(cam, 'degraded', 'manual_retry');
      var loading = document.createElement('div');
      loading.className = 'feed-loading';
      loading.textContent = tr('camera.retrying');
      container.replaceChildren(loading);
      loadCameraFeed(cam, container);
    });
    error.appendChild(retry);

    var source = document.createElement('a');
    source.className = 'feed-source-link';
    source.href = cam.type === 'youtube'
      ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(cam.url)
      : cam.url;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = tr('camera.openSource');
    error.appendChild(source);
    container.replaceChildren(error);
  }

  function appendFrameFallback(cam, container, iframe, sourceUrl) {
    var actions = document.createElement('div');
    actions.className = 'feed-frame-actions';

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'feed-retry-btn';
    retry.textContent = tr('camera.reload');
    retry.addEventListener('click', function () {
      if (activeCamera !== cam) return;
      recordCameraHealth(cam, 'degraded', 'manual_retry');
      destroyActiveFeed(container);
      loadCameraFeed(cam, container);
    });

    var source = document.createElement('a');
    source.className = 'feed-source-link';
    source.href = sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = tr('camera.openSource');
    actions.appendChild(retry);
    actions.appendChild(source);
    container.appendChild(actions);

    var timeout = setTimeout(function () {
      if (activeCamera === cam) {
        renderFeedError(cam, container, tr('feed.embedTimeout'));
      }
    }, 12000);
    iframe.addEventListener('load', function () { clearTimeout(timeout); }, { once: true });
    return function () { clearTimeout(timeout); };
  }

  function loadHLSFeed(cam, container) {
    var video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = true;
    var hls = null;
    var destroyed = false;

    activeFeedCleanup = function () {
      if (destroyed) return;
      destroyed = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (hls) {
        hls.destroy();
        hls = null;
      }
    };

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: 10,
        maxMaxBufferLength: 20
      });
      hls.loadSource(cam.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        if (activeCamera === cam) recordCameraHealth(cam, 'healthy', null);
      });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          renderFeedError(cam, container, tr('feed.streamUnavailable'));
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = cam.url;
      video.addEventListener('loadeddata', function () {
        if (activeCamera === cam) recordCameraHealth(cam, 'healthy', null);
      }, { once: true });
      video.addEventListener('error', function () {
        renderFeedError(cam, container, tr('feed.streamUnavailable'));
      }, { once: true });
    } else {
      renderFeedError(cam, container, tr('feed.hlsUnsupported'));
      return;
    }

    container.replaceChildren(video);
    appendLiveIndicator(container, tr('camera.liveStream'));
  }

  function loadMJPEGFeed(cam, container) {
    var img = document.createElement('img');
    img.alt = cam.name;
    img.src = cam.url;

    img.onerror = function () {
      if (activeCamera === cam) {
        renderFeedError(cam, container, tr('feed.cameraUnavailable'));
      }
    };
    img.onload = function () {
      if (activeCamera === cam) recordCameraHealth(cam, 'healthy', null);
    };

    activeFeedCleanup = function () {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    };
    container.replaceChildren(img);
    appendLiveIndicator(container, tr('camera.liveMjpeg'));
  }

  function loadYouTubeFeed(cam, container) {
    var iframe = document.createElement('iframe');
    var sourceUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(cam.url);
    iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(cam.url) + '?autoplay=1&mute=1&playsinline=1';
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.cssText = 'min-height:400px;border:none;';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.title = cam.name;
    iframe.referrerPolicy = 'no-referrer';

    container.replaceChildren(iframe);
    var clearLoadTimeout = appendFrameFallback(cam, container, iframe, sourceUrl);
    activeFeedCleanup = function () {
      clearLoadTimeout();
      iframe.src = 'about:blank';
    };
    appendLiveIndicator(container, tr('camera.youtubeLive'));
  }

  function hostMatchesSuffix(hostname, suffix) {
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }

  function isAllowedEmbedUrl(url) {
    try {
      var parsed = new URL(url);
      var hostname = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:') return false;
      for (var i = 0; i < TRUSTED_EMBED_HOST_SUFFIXES.length; i++) {
        if (hostMatchesSuffix(hostname, TRUSTED_EMBED_HOST_SUFFIXES[i])) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function loadEmbedFeed(cam, container) {
    if (!isAllowedEmbedUrl(cam.url)) {
      renderFeedError(cam, container, tr('feed.untrusted'));
      return;
    }

    var iframe = document.createElement('iframe');
    iframe.src = cam.url;
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.cssText = 'min-height:400px;border:none;';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.allowFullscreen = true;
    iframe.title = cam.name;
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');

    iframe.onerror = function () {
      if (activeCamera === cam) {
        renderFeedError(cam, container, tr('feed.embedUnavailable'));
      }
    };

    container.replaceChildren(iframe);
    var clearLoadTimeout = appendFrameFallback(cam, container, iframe, cam.url);
    activeFeedCleanup = function () {
      clearLoadTimeout();
      iframe.onerror = null;
      iframe.src = 'about:blank';
    };
  }

  function loadImageFeed(cam, container) {
    var img = document.createElement('img');
    img.alt = cam.name;

    function setImageSrc() {
      img.src = cam.url + (cam.url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
    }

    img.onerror = function () {
      if (activeCamera === cam) {
        renderFeedError(cam, container, tr('feed.imageUnavailable'));
      }
    };

    img.onload = function () {
      if (activeCamera === cam) recordCameraHealth(cam, 'healthy', null);
      var loadingEl = container.querySelector('.feed-loading');
      if (loadingEl) loadingEl.remove();
    };

    setImageSrc();
    activeFeedCleanup = function () {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    };
    container.replaceChildren(img);
    appendLiveIndicator(container, tr('camera.autoRefresh'));

    imageRefreshTimer = setInterval(setImageSrc, IMAGE_REFRESH_INTERVAL);
  }

  function appendLiveIndicator(container, label) {
    var indicator = document.createElement('div');
    indicator.className = 'feed-refresh-indicator';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-label', label);
    indicator.title = label;
    container.appendChild(indicator);
  }

  // ── Weather (NWS for US, Open-Meteo for international) ──

  var WMO_CODES = {
    0: 'weather.code.clear', 1: 'weather.code.mainlyClear', 2: 'weather.code.partlyCloudy', 3: 'weather.code.overcast',
    45: 'weather.code.fog', 48: 'weather.code.rimeFog',
    51: 'weather.code.lightDrizzle', 53: 'weather.code.moderateDrizzle', 55: 'weather.code.denseDrizzle',
    61: 'weather.code.slightRain', 63: 'weather.code.moderateRain', 65: 'weather.code.heavyRain',
    71: 'weather.code.slightSnow', 73: 'weather.code.moderateSnow', 75: 'weather.code.heavySnow',
    77: 'weather.code.snowGrains', 80: 'weather.code.slightShowers', 81: 'weather.code.moderateShowers', 82: 'weather.code.violentShowers',
    85: 'weather.code.slightSnowShowers', 86: 'weather.code.heavySnowShowers',
    95: 'weather.code.thunderstorm', 96: 'weather.code.slightHail', 99: 'weather.code.heavyHail'
  };

  function windDirectionFromDegrees(deg) {
    var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  async function fetchWeather(lat, lon, cam) {
    var weatherLoading = document.getElementById('weather-loading');
    var weatherData = document.getElementById('weather-data');

    if (weatherAbort) weatherAbort.abort();
    weatherAbort = new AbortController();
    var signal = weatherAbort.signal;

    if (StormScopeWeather.shouldUseNws(cam)) {
      try {
        await fetchWeatherNWS(lat, lon, cam, signal, weatherLoading, weatherData);
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
        await fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData, true);
        return;
      }
    }
    await fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData, false);
  }

  async function fetchWeatherNWS(lat, lon, cam, signal, weatherLoading, weatherData) {
    var pointResp = await fetch('https://api.weather.gov/points/' + lat.toFixed(4) + ',' + lon.toFixed(4), {
      headers: { 'Accept': 'application/geo+json' },
      signal: signal
    });
    if (!pointResp.ok) throw new Error('NWS point lookup failed');
    var pointData = await pointResp.json();
    var forecastUrl = pointData.properties.forecastHourly;
    if (!forecastUrl) throw new Error('No forecast URL');

    var fcResp = await fetch(forecastUrl, {
      headers: { 'Accept': 'application/geo+json' },
      signal: signal
    });
    if (!fcResp.ok) throw new Error('NWS forecast failed');
    var fcData = await fcResp.json();
    var periods = fcData.properties.periods;
    if (!periods || !periods.length) throw new Error('No forecast periods');
    var current = periods[0];

    if (activeCamera !== cam) return;
    var temperature = current.temperatureUnit === 'F'
      ? StormScopeWeather.temperatureFromFahrenheit(current.temperature, weatherUnits)
      : Math.round(current.temperature) + '°' + current.temperatureUnit;
    showWeatherItems(weatherLoading, weatherData, [
      [tr('weather.temperature'), temperature],
      [tr('weather.conditions'), current.shortForecast],
      [tr('weather.wind'), StormScopeWeather.windFromMph(current.windSpeed, weatherUnits) + ' ' + current.windDirection],
      [tr('weather.humidity'), current.relativeHumidity ? localNumber(current.relativeHumidity.value) + '%' : tr('weather.notAvailable')],
      [tr('weather.forecastIssued'), localTime(fcData.properties.updateTime)],
      [tr('weather.forecastValid'), localTime(current.startTime)]
    ]);
  }

  async function fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData, isFallback) {
    try {
      var metric = weatherUnits === 'metric';
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) +
        '&longitude=' + lon.toFixed(4) +
        '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code' +
        '&temperature_unit=' + (metric ? 'celsius' : 'fahrenheit') +
        '&wind_speed_unit=' + (metric ? 'kmh' : 'mph') +
        '&timezone=auto';
      var resp = await fetch(url, { signal: signal });
      if (!resp.ok) throw new Error('Open-Meteo failed');
      var data = await resp.json();
      var c = data.current;
      if (!c) throw new Error('No current data');

      if (activeCamera !== cam) return;

      var condition = tr(WMO_CODES[c.weather_code] || 'weather.code.unknown');
      var windDir = windDirectionFromDegrees(c.wind_direction_10m || 0);

      showWeatherItems(weatherLoading, weatherData, [
        [tr('weather.temperature'), localNumber(Math.round(c.temperature_2m)) + (metric ? '°C' : '°F')],
        [tr('weather.conditions'), condition],
        [tr('weather.wind'), localNumber(Math.round(c.wind_speed_10m)) + (metric ? ' km/h ' : ' mph ') + windDir],
        [tr('weather.humidity'), c.relative_humidity_2m != null ? localNumber(c.relative_humidity_2m) + '%' : tr('weather.notAvailable')],
        [tr('weather.observed'), StormScopeWeather.formatOpenMeteoTime(c.time, data.utc_offset_seconds, appLocale)],
        [tr('weather.source'), tr(isFallback ? 'weather.openMeteoFallback' : 'weather.openMeteo')]
      ]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (activeCamera === cam) {
        weatherLoading.textContent = tr('weather.unavailable');
      }
    }
  }

  function showWeatherItems(loadingEl, dataEl, items) {
    dataEl.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var item = document.createElement('div');
      item.className = 'weather-item';
      var label = document.createElement('span');
      label.className = 'weather-label';
      label.textContent = items[i][0];
      var value = document.createElement('span');
      value.className = 'weather-value';
      value.textContent = items[i][1];
      item.appendChild(label);
      item.appendChild(value);
      dataEl.appendChild(item);
    }
    loadingEl.classList.add('hidden');
    dataEl.classList.remove('hidden');
  }

  // ── NWS Alerts ──

  function alertMinimumSeverity() {
    var value = document.getElementById('alert-severity').value;
    return value === 'all' ? null : value.charAt(0).toUpperCase() + value.slice(1);
  }

  async function fetchNwsAlerts() {
    if (!alertsVisible || document.hidden) return;
    if (alertAbort) alertAbort.abort();
    alertAbort = new AbortController();
    var signal = alertAbort.signal;
    var bounds = map.getBounds();
    var center = map.getCenter();
    var viewportQuery = StormScopeNwsAlerts.buildViewportQuery(bounds);
    document.getElementById('alerts-status').textContent = tr('alerts.refreshing');

    try {
      var nationalRequest = alertNationalPayload && Date.now() - alertNationalFetchedAt < StormScopeNwsAlerts.MIN_REFRESH_MS
        ? Promise.resolve(alertNationalPayload)
        : fetchAlertPayload(viewportQuery.url, signal).then(function (payload) {
          alertNationalPayload = payload;
          alertNationalFetchedAt = Date.now();
          return payload;
        });
      var pointRequest = StormScopeWeather.inNwsCoverageBounds(center.lat, center.lng)
        ? fetchAlertPayload(StormScopeNwsAlerts.buildPointQuery(center.lat, center.lng), signal)
        : Promise.resolve(null);
      var results = await Promise.allSettled([nationalRequest, pointRequest]);
      var nationalPayload = results[0].status === 'fulfilled' ? results[0].value : null;
      var pointPayload = results[1].status === 'fulfilled' ? results[1].value : null;
      if (!nationalPayload && !pointPayload) {
        throw results[0].reason || results[1].reason || new Error('NWS alerts unavailable');
      }
      var viewportAlerts = StormScopeNwsAlerts.normalizeCollection(nationalPayload || { features: [] }, {
        bounds: viewportQuery.bounds,
        minimumSeverity: alertMinimumSeverity()
      });
      var pointAlerts = StormScopeNwsAlerts.normalizeCollection(pointPayload || { features: [] }, {
        minimumSeverity: alertMinimumSeverity()
      });
      activeAlerts = StormScopeNwsAlerts.filterAlerts(
        StormScopeNwsAlerts.dedupeAlerts(viewportAlerts.concat(pointAlerts)),
        { minimumSeverity: alertMinimumSeverity() }
      );
      alertRetryMetadata = StormScopeNwsAlerts.successMetadata();
      renderAlerts();
      scheduleAlertRefresh(alertRetryMetadata.delayMs);
    } catch (error) {
      if (error.name === 'AbortError') return;
      alertRetryMetadata = StormScopeNwsAlerts.nextRetryMetadata(alertRetryMetadata, error);
      document.getElementById('alerts-status').textContent = alertRetryMetadata.retryable
        ? tr('alerts.retryScheduled')
        : tr('alerts.unavailable');
      scheduleAlertRefresh(alertRetryMetadata.delayMs);
    }
  }

  async function fetchAlertPayload(url, signal) {
    var response = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: signal });
    if (!response.ok) {
      var error = new Error('NWS alerts HTTP ' + response.status);
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    return response.json();
  }

  function scheduleAlertRefresh(delay) {
    clearTimeout(alertRefreshTimer);
    alertRefreshTimer = null;
    if (!alertsVisible || delay == null) return;
    alertRefreshTimer = setTimeout(fetchNwsAlerts, Math.max(StormScopeNwsAlerts.MIN_REFRESH_MS, delay));
  }

  function alertColor(alert) {
    if (alert.severity === 'Extreme') return '#ff2d55';
    if (alert.severity === 'Severe') return '#ff7b00';
    if (alert.severity === 'Moderate') return '#ffd166';
    return '#70d6ff';
  }

  function renderAlerts() {
    var panel = document.getElementById('alerts-panel');
    var list = document.getElementById('alerts-list');
    var status = document.getElementById('alerts-status');
    list.replaceChildren();
    if (alertLayerGroup) map.removeLayer(alertLayerGroup);
    alertLayerGroup = L.layerGroup();
    alertLayersById = Object.create(null);
    if (alertsVisible) alertLayerGroup.addTo(map);

    activeAlerts.forEach(function (alert) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'alert-list-button';
      button.dataset.severity = alert.severity;
      var title = document.createElement('strong');
      title.textContent = alert.event;
      var summary = document.createElement('span');
      summary.textContent = tr('alerts.expiresSummary', {
        severity: tr('severity.' + String(alert.severity || 'unknown').toLowerCase()),
        time: localTime(alert.expires)
      });
      button.appendChild(title);
      button.appendChild(summary);
      button.addEventListener('click', function () { showAlertDetail(alert, true, button); });
      item.appendChild(button);
      list.appendChild(item);

      if (alert.geometry) {
        var layer = L.geoJSON(alert.geometry, {
          style: {
            color: alertColor(alert),
            weight: alert.severity === 'Extreme' ? 4 : 3,
            opacity: 0.9,
            fillOpacity: 0.12
          }
        });
        layer.on('click', function () { showAlertDetail(alert, false); });
        layer.addTo(alertLayerGroup);
        alertLayersById[alert.id] = layer;
      }
    });

    status.textContent = activeAlerts.length
      ? tr(activeAlerts.length === 1 ? 'alerts.countOne' : 'alerts.countMany', { count: localNumber(activeAlerts.length) })
      : tr('alerts.none');
    panel.classList.toggle('hidden', !alertsVisible);
  }

  function hideAlertDetail() {
    var detail = document.getElementById('alert-detail');
    if (detail.classList.contains('hidden')) return false;
    detail.classList.add('hidden');
    detail.replaceChildren();
    var returnTo = alertDetailReturnFocus;
    alertDetailReturnFocus = null;
    if (returnTo && returnTo.isConnected && returnTo.offsetParent !== null) returnTo.focus();
    return true;
  }

  function showAlertDetail(alert, focus, trigger) {
    var detail = document.getElementById('alert-detail');
    alertDetailReturnFocus = trigger || null;
    detail.replaceChildren();
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'alert-detail-dismiss';
    dismiss.setAttribute('aria-label', tr('alerts.hideDetail'));
    dismiss.textContent = '×';
    dismiss.addEventListener('click', hideAlertDetail);
    detail.appendChild(dismiss);
    var heading = document.createElement('h3');
    heading.textContent = alert.headline;
    detail.appendChild(heading);
    [
      [tr('alerts.area'), alert.areaDescription],
      [tr('alerts.effective'), localTime(alert.effective)],
      [tr('alerts.expires'), localTime(alert.expires)],
      [tr('alerts.severity'), tr('severity.' + String(alert.severity || 'unknown').toLowerCase()) + ' • ' + alert.urgency + ' • ' + alert.certainty],
      [tr('alerts.details'), alert.description],
      [tr('alerts.instructions'), alert.instruction]
    ].forEach(function (row) {
      if (!row[1]) return;
      var paragraph = document.createElement('p');
      var strong = document.createElement('strong');
      strong.textContent = row[0] + ': ';
      paragraph.appendChild(strong);
      paragraph.appendChild(document.createTextNode(row[1]));
      detail.appendChild(paragraph);
    });
    var source = document.createElement('a');
    source.href = alert.sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = tr('alerts.officialSource');
    detail.appendChild(source);
    detail.classList.remove('hidden');
    if (focus) detail.focus();
    if (focus && alertLayersById[alert.id]) {
      var bounds = alertLayersById[alert.id].getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
    }
  }

  // ── UI Bindings ──

  // Close a header-toggled panel (search/layers) if it is open, returning focus
  // to its toggle button so keyboard and screen-reader users keep their place.
  function closeOpenPanel(panelId, toggleId) {
    var panel = document.getElementById(panelId);
    if (panel.classList.contains('hidden')) return false;
    panel.classList.add('hidden');
    var toggle = document.getElementById(toggleId);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
    return true;
  }

  function bindUI() {
    document.getElementById('btn-search').addEventListener('click', function () {
      var panel = document.getElementById('search-panel');
      var isHidden = panel.classList.toggle('hidden');
      this.setAttribute('aria-expanded', String(!isHidden));
      if (!isHidden) {
        document.getElementById('layers-panel').classList.add('hidden');
        document.getElementById('btn-layers').setAttribute('aria-expanded', 'false');
        document.getElementById('alerts-panel').classList.add('hidden');
        scheduleSearchRender();
        document.getElementById('camera-query').focus();
      }
    });

    document.getElementById('btn-layers').addEventListener('click', function () {
      var panel = document.getElementById('layers-panel');
      var isHidden = panel.classList.toggle('hidden');
      this.setAttribute('aria-expanded', String(!isHidden));
      document.getElementById('search-panel').classList.add('hidden');
      document.getElementById('btn-search').setAttribute('aria-expanded', 'false');
      document.getElementById('alerts-panel').classList.toggle('hidden', !isHidden || !alertsVisible);
    });

    document.getElementById('toggle-radar').addEventListener('change', function () {
      radarVisible = this.checked;
      if (radarVisible) {
        if (radarLayer) radarLayer.addTo(map);
      } else {
        setRadarPlaying(false);
        if (radarLayer) map.removeLayer(radarLayer);
      }
      scheduleLastViewSave();
    });

    document.getElementById('toggle-cameras').addEventListener('change', function () {
      if (this.checked) {
        if (cameraCluster) map.addLayer(cameraCluster);
      } else {
        if (cameraCluster) map.removeLayer(cameraCluster);
      }
      scheduleLastViewSave();
    });

    document.getElementById('toggle-coverage').addEventListener('change', function () {
      updateCoverageLayer();
      scheduleLastViewSave();
    });

    document.getElementById('toggle-alerts').addEventListener('change', function () {
      alertsVisible = this.checked;
      if (!alertsVisible) {
        if (alertAbort) alertAbort.abort();
        clearTimeout(alertRefreshTimer);
        if (alertLayerGroup) map.removeLayer(alertLayerGroup);
        document.getElementById('alerts-panel').classList.add('hidden');
      } else {
        fetchNwsAlerts();
      }
      scheduleLastViewSave();
    });

    document.getElementById('toggle-lightning').addEventListener('change', function () {
      if (this.checked) refreshLightning();
      else disableLightning();
      scheduleLastViewSave();
    });

    document.getElementById('toggle-wildfires').addEventListener('change', function () {
      if (this.checked) refreshWildfires();
      else disableWildfires();
      scheduleLastViewSave();
    });

    document.getElementById('alert-severity').addEventListener('change', fetchNwsAlerts);

    document.getElementById('radar-opacity').addEventListener('input', function () {
      radarOpacity = parseInt(this.value, 10) / 100;
      if (radarLayer) radarLayer.setOpacity(radarOpacity);
      scheduleLastViewSave();
    });

    document.getElementById('weather-units').addEventListener('change', function () {
      weatherUnits = StormScopeWeather.normalizeUnits(this.value, navigator.language);
      try { localStorage.setItem('stormscope-weather-units', weatherUnits); } catch (error) { /* optional */ }
      if (activeCamera) fetchWeather(activeCamera.lat, activeCamera.lon, activeCamera);
    });
    document.getElementById('app-locale').addEventListener('change', function () {
      appLocale = StormScopeI18n.setLocale(this.value);
      try { localStorage.setItem(StormScopeI18n.STORAGE_KEY, appLocale); } catch (error) { /* optional */ }
      StormScopeI18n.localizeDocument(document);
      updateConnectionState();
      updateRadarScrubber();
      applyRadarPalette();
      if (radarFrames.length) updateRadarTimeDisplay();
      if (cameraDataTimestamp) updateDataFreshness();
      refreshCameraLoadLabels();
      refreshSavedViews(document.getElementById('saved-views').value);
      updateMonitorSelectionUi();
      scheduleSearchRender();
      renderAlerts();
      renderLightningStatus();
      renderWildfireStatus();
      if (activeCamera) {
        updateModalCameraHealth(activeCamera);
        fetchWeather(activeCamera.lat, activeCamera.lon, activeCamera);
      }
    });

    document.getElementById('radar-prev').addEventListener('click', function () { stepRadar(-1); });
    document.getElementById('radar-next').addEventListener('click', function () { stepRadar(1); });
    document.getElementById('radar-play').addEventListener('click', function () { setRadarPlaying(!radarPlaying); });
    document.getElementById('radar-scrubber').addEventListener('input', function () {
      setRadarPlaying(false);
      selectRadarFrame(parseInt(this.value, 10));
    });
    document.getElementById('radar-speed').addEventListener('change', function () {
      var wasPlaying = radarPlaying;
      radarAnimationSpeed = [0, 400, 800, 1600].indexOf(Number(this.value)) === -1
        ? RADAR_ANIMATION_SPEED
        : Number(this.value);
      try { localStorage.setItem('stormscope-radar-speed', String(radarAnimationSpeed)); } catch (error) { /* optional */ }
      setRadarPlaying(wasPlaying && radarAnimationSpeed > 0);
      if (radarFrames.length) updateRadarTimeDisplay();
    });
    document.getElementById('radar-palette').addEventListener('change', function () {
      radarPalette = ['standard', 'colorblind', 'contrast'].indexOf(this.value) === -1 ? 'standard' : this.value;
      try { localStorage.setItem('stormscope-radar-palette', radarPalette); } catch (error) { /* optional */ }
      applyRadarPalette();
    });
    document.getElementById('radar-retry').addEventListener('click', function () { initRadar(); });

    document.getElementById('modal-close').addEventListener('click', closeCameraModal);
    document.querySelector('.modal-backdrop').addEventListener('click', closeCameraModal);
    document.getElementById('favorite-camera').addEventListener('click', function () {
      if (activeCamera) toggleCameraFavorite(activeCamera);
    });
    document.getElementById('open-monitor').addEventListener('click', openMonitor);
    document.getElementById('monitor-close').addEventListener('click', function () { closeMonitor(true); });
    document.querySelector('.monitor-backdrop').addEventListener('click', function () { closeMonitor(true); });

    ['camera-query', 'camera-state'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', function () { scheduleSearchRender(true); });
    });
    ['camera-source', 'camera-type', 'camera-sort', 'camera-healthy', 'camera-favorites'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', function () { scheduleSearchRender(true); });
    });
    document.getElementById('camera-results-scroll').addEventListener('scroll', function () {
      scheduleSearchRender(false);
    }, { passive: true });

    document.getElementById('saved-views').addEventListener('change', function () {
      var hasSelection = Boolean(this.value);
      document.getElementById('load-view').disabled = !hasSelection;
      document.getElementById('delete-view').disabled = !hasSelection;
      if (hasSelection) document.getElementById('view-name').value = savedStore.getView(this.value).name;
    });
    document.getElementById('save-view').addEventListener('click', function () {
      try {
        var nameInput = document.getElementById('view-name');
        var state = savedStore.saveView(nameInput.value, captureViewSnapshot());
        var normalizedName = nameInput.value.trim().toLowerCase();
        var saved = state.views.find(function (view) { return view.name.toLowerCase() === normalizedName; });
        refreshSavedViews(saved && saved.id);
        setSavedStateStatus(tr('views.savedStatus'));
      } catch (error) {
        setSavedStateStatus(tr('views.saveError', { error: error.message }), true);
      }
    });
    document.getElementById('load-view').addEventListener('click', function () {
      var view = savedStore.getView(document.getElementById('saved-views').value);
      if (!view) return;
      applyViewSnapshot(view.snapshot);
      scheduleSearchRender();
      scheduleLastViewSave();
      setSavedStateStatus(tr('views.loaded', { name: view.name }));
    });
    document.getElementById('delete-view').addEventListener('click', function () {
      var select = document.getElementById('saved-views');
      var view = savedStore.getView(select.value);
      if (!view) return;
      savedStore.deleteView(view.id);
      refreshSavedViews();
      document.getElementById('view-name').value = '';
      setSavedStateStatus(tr('views.deleted', { name: view.name }));
    });
    document.getElementById('export-state').addEventListener('click', function () {
      var blob = new Blob([savedStore.exportJson(2)], { type: 'application/json' });
      var href = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = href;
      link.download = 'stormscope-saved-state.json';
      link.click();
      setTimeout(function () { URL.revokeObjectURL(href); }, 0);
      setSavedStateStatus(tr('views.exported'));
    });
    document.getElementById('import-state').addEventListener('click', function () {
      document.getElementById('import-state-file').click();
    });
    document.getElementById('import-state-file').addEventListener('change', function () {
      var input = this;
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          savedStore.importJson(String(reader.result));
          refreshSavedViews();
          updateFavoriteButton(activeCamera);
          scheduleSearchRender();
          setSavedStateStatus(tr('views.imported'));
        } catch (error) {
          setSavedStateStatus(tr('views.importRejected', { error: error.message }), true);
        } finally {
          input.value = '';
        }
      };
      reader.onerror = function () {
        setSavedStateStatus(tr('views.importReadError'), true);
        input.value = '';
      };
      reader.readAsText(file);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (activeCamera) { closeCameraModal(); return; }
      if (!document.getElementById('monitor-modal').classList.contains('hidden')) { closeMonitor(true); return; }
      if (hideAlertDetail()) return;
      if (closeOpenPanel('search-panel', 'btn-search')) return;
      closeOpenPanel('layers-panel', 'btn-layers');
    });

    map.on('click', function () {
      document.getElementById('layers-panel').classList.add('hidden');
      document.getElementById('btn-layers').setAttribute('aria-expanded', 'false');
      document.getElementById('search-panel').classList.add('hidden');
      document.getElementById('btn-search').setAttribute('aria-expanded', 'false');
      document.getElementById('alerts-panel').classList.toggle('hidden', !alertsVisible);
    });
    map.on('moveend', function () {
      if (radarFrames.length) sampleRadarCenter(radarFrames[radarIndex]);
      clearTimeout(alertMoveTimer);
      alertMoveTimer = setTimeout(fetchNwsAlerts, 600);
      if (document.getElementById('toggle-wildfires').checked) {
        clearTimeout(wildfireMoveTimer);
        wildfireMoveTimer = setTimeout(refreshWildfires, 700);
      }
      if (document.getElementById('camera-sort').value === 'distance') scheduleSearchRender();
      scheduleLastViewSave();
    });
  }

  function registerServiceWorker() {
    var status = document.getElementById('cache-status');
    var clearButton = document.getElementById('clear-cache');
    var updateNotice = document.getElementById('update-notice');
    var applyUpdate = document.getElementById('apply-update');
    if (!('serviceWorker' in navigator) || location.protocol.indexOf('http') !== 0) {
      status.textContent = tr('cache.requiresHttp');
      return;
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 MB';
      var digits = bytes >= 10 * 1024 * 1024 ? 0 : 1;
      return StormScopeI18n.formatNumber(bytes / (1024 * 1024), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      }, appLocale) + ' MB';
    }

    function setCacheError(message) {
      status.textContent = message;
      status.classList.add('error');
    }

    function requestWorker(registration, type) {
      var worker = navigator.serviceWorker.controller || registration.active;
      if (!worker) return Promise.reject(new Error('Offline cache is not active yet.'));
      return new Promise(function (resolve, reject) {
        var channel = new MessageChannel();
        var timeout = setTimeout(function () { reject(new Error('Offline cache did not respond.')); }, 4000);
        channel.port1.onmessage = function (event) {
          clearTimeout(timeout);
          resolve(event.data || {});
        };
        worker.postMessage({ type: type }, [channel.port2]);
      });
    }

    function refreshUsage(registration) {
      return requestWorker(registration, 'STORMSCOPE_GET_CACHE_USAGE').then(function (usage) {
        status.classList.remove('error');
        status.textContent = tr('cache.usage', { bytes: formatBytes(usage.bytes), count: localNumber(usage.entries || 0) });
        clearButton.disabled = false;
      });
    }

    navigator.serviceWorker.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'STORMSCOPE_CACHE_ERROR') return;
      setCacheError(event.data.reason === 'quota-exceeded'
        ? tr('cache.full')
        : tr('cache.writeFailed'));
    });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!reloadForUpdate) return;
      reloadForUpdate = false;
      location.reload();
    });

    function watchForUpdate(registration) {
      function showWaitingUpdate() {
        if (!registration.waiting || !navigator.serviceWorker.controller) return;
        updateNotice.classList.remove('hidden');
      }
      showWaitingUpdate();
      registration.addEventListener('updatefound', function () {
        var installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', function () {
          if (installing.state === 'installed') showWaitingUpdate();
        });
      });
      applyUpdate.addEventListener('click', function () {
        if (!registration.waiting) return;
        applyUpdate.disabled = true;
        applyUpdate.textContent = tr('update.updating');
        reloadForUpdate = true;
        registration.waiting.postMessage({ type: 'STORMSCOPE_SKIP_WAITING' });
      });
    }

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (registration) {
        watchForUpdate(registration);
        return navigator.serviceWorker.ready.then(function () {
          clearButton.addEventListener('click', function () {
            clearButton.disabled = true;
            status.classList.remove('error');
            status.textContent = tr('cache.clearing');
            requestWorker(registration, 'STORMSCOPE_CLEAR_CACHES').then(function () {
              return refreshUsage(registration);
            }).catch(function (error) {
              setCacheError(error.message);
              clearButton.disabled = false;
            });
          });
          return refreshUsage(registration);
        });
      }).catch(function (error) {
        setCacheError(tr('cache.unavailable', { error: error.message }));
      });
    });
  }

  function initLifecycle() {
    updateConnectionState();
    radarRefreshTimer = setInterval(function () {
      if (!document.hidden && navigator.onLine) initRadar();
    }, RADAR_REFRESH_INTERVAL);

    document.addEventListener('visibilitychange', function () {
      var container = document.getElementById('modal-feed');
      if (monitorRegistry) monitorRegistry.setDocumentHidden(document.hidden);
      if (document.hidden) {
        radarWasPlaying = radarPlaying;
        setRadarPlaying(false);
        if (activeCamera) {
          destroyActiveFeed(container);
          var paused = document.createElement('div');
          paused.className = 'feed-loading';
          paused.setAttribute('role', 'status');
          paused.textContent = tr('camera.paused');
          container.replaceChildren(paused);
          feedPausedForVisibility = true;
        }
        if (alertAbort) alertAbort.abort();
        if (lightningAbort) lightningAbort.abort();
        if (wildfireAbort) wildfireAbort.abort();
        clearTimeout(alertRefreshTimer);
        clearTimeout(lightningRefreshTimer);
        clearTimeout(wildfireRefreshTimer);
        return;
      }

      initRadar().then(function () {
        if (radarWasPlaying && radarVisible && radarFrames.length) setRadarPlaying(true);
        radarWasPlaying = false;
      });
      if (feedPausedForVisibility && activeCamera) {
        feedPausedForVisibility = false;
        loadCameraFeed(activeCamera, container);
      }
      fetchNwsAlerts();
      if (document.getElementById('toggle-lightning').checked) refreshLightning();
      if (document.getElementById('toggle-wildfires').checked) refreshWildfires();
    });

    window.addEventListener('online', function () {
      updateConnectionState();
      initRadar();
      if (document.getElementById('toggle-lightning').checked) refreshLightning();
      if (document.getElementById('toggle-wildfires').checked) refreshWildfires();
    });
    window.addEventListener('offline', updateConnectionState);
    window.addEventListener('beforeunload', function () {
      clearInterval(radarRefreshTimer);
      clearTimeout(radarPreloadTimer);
      clearTimeout(alertRefreshTimer);
      clearTimeout(alertMoveTimer);
      clearTimeout(lightningRefreshTimer);
      clearTimeout(wildfireRefreshTimer);
      clearTimeout(wildfireMoveTimer);
      setRadarPlaying(false);
      if (radarAbort) radarAbort.abort();
      if (weatherAbort) weatherAbort.abort();
      if (alertAbort) alertAbort.abort();
      if (lightningAbort) lightningAbort.abort();
      if (wildfireAbort) wildfireAbort.abort();
      if (cameraStore) cameraStore.cancel();
      if (monitorRegistry) monitorRegistry.destroyAll();
      clearTimeout(saveLastViewTimer);
      destroyActiveFeed(document.getElementById('modal-feed'));
    });
  }

  function initWeatherUnits() {
    var saved = null;
    try { saved = localStorage.getItem('stormscope-weather-units'); } catch (error) { /* optional */ }
    weatherUnits = StormScopeWeather.normalizeUnits(saved, navigator.language);
    document.getElementById('weather-units').value = weatherUnits;
  }

  function initLocale() {
    var saved = null;
    try { saved = localStorage.getItem(StormScopeI18n.STORAGE_KEY); } catch (error) { /* optional */ }
    appLocale = StormScopeI18n.setLocale(saved || navigator.language);
    document.getElementById('app-locale').value = appLocale;
    StormScopeI18n.localizeDocument(document);
  }

  function initRadarPreferences() {
    var savedSpeed = null;
    var savedPalette = null;
    try {
      savedSpeed = localStorage.getItem('stormscope-radar-speed');
      savedPalette = localStorage.getItem('stormscope-radar-palette');
    } catch (error) { /* optional */ }
    var parsedSpeed = Number(savedSpeed);
    if ([0, 400, 800, 1600].indexOf(parsedSpeed) !== -1 && savedSpeed !== null) {
      radarAnimationSpeed = parsedSpeed;
    } else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      radarAnimationSpeed = 0;
    }
    radarPalette = ['standard', 'colorblind', 'contrast'].indexOf(savedPalette) === -1 ? 'standard' : savedPalette;
    document.getElementById('radar-speed').value = String(radarAnimationSpeed);
    document.getElementById('radar-palette').value = radarPalette;
    applyRadarPalette();
  }

  // ── Boot ──

  initLocale();
  initMap();
  initWeatherUnits();
  initRadarPreferences();
  initSavedState();
  bindUI();
  updateMonitorSelectionUi();
  initRadar();
  loadCameras();
  fetchNwsAlerts();
  registerServiceWorker();
  initLifecycle();

  window._stormscope = {
    getMap: function () { return map; },
    getRadarPreloadState: function () { return Object.assign({}, radarPreloadState); },
    getCameraLoadMetrics: function () { return Object.assign({}, cameraLoadMetrics); },
    getCameraResults: function () { return currentCameraResults.slice(); },
    getMonitorState: function () {
      return { selected: monitorSelection.count(), players: monitorRegistry ? monitorRegistry.count() : 0 };
    },
    getContextState: function () {
      return {
        lightning: Boolean(lightningLayer), wildfires: Boolean(wildfireLayer),
        lightningStatus: lightningStatusState, wildfireStatus: wildfireStatusState,
        rasterZ: map.getPane('contextRasterPane').style.zIndex,
        vectorZ: map.getPane('contextVectorPane').style.zIndex,
        warningZ: map.getPane('overlayPane').style.zIndex || '400',
        cameraZ: map.getPane('markerPane').style.zIndex || '600'
      };
    }
  };
})();
