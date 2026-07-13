(function () {
  'use strict';

  var MAP_CENTER = [39.5, -98.5];
  var APP_VERSION = '0.91.0';
  var MAP_ZOOM = 5;
  var RADAR_ANIMATION_SPEED = 800;
  var RADAR_REFRESH_INTERVAL = 10 * 60 * 1000;
  var IMAGE_REFRESH_INTERVAL = 15000;
  var CAMERA_OBSERVATION_TTL = 6 * 60 * 60 * 1000;
  var OBSERVATION_UNSUPPORTED = 'unsupported';
  var REASON_BROWSER_HLS = 'browser_hls';
  var REASON_UNTRUSTED_EMBED = 'untrusted_embed';
  var TRUSTED_EMBED_HOST_SUFFIXES = Object.freeze([
    'v.angelcam.com',
    'cdn.jwplayer.com',
    'earthcam.com',
    'myearthcam.com',
    'nps.gov',
    'brownrice.com',
    'abbeyroad.com',
    'esbnyc.com',
    'weathercams.faa.gov',
    'hazcams.com',
    'ipcamlive.com',
    'rtsp.me'
  ]);
  var RAINVIEWER_API_URL = 'https://api.rainviewer.com/public/weather-maps.json';
  var RAINVIEWER_COLOR_SCHEME = 2;
  var RAINVIEWER_MAX_NATIVE_ZOOM = 7;
  var RAINVIEWER_PRELOAD_RESERVE = 20;

  var map, radarLayer, radarLayerNext, cameraCluster, basemapLayer;
  var themePreference = 'auto';
  var radarFrames = [];
  var radarHost = '';
  var radarIndex = 0;
  var radarPlaying = false;
  var radarAnimationSpeed = RADAR_ANIMATION_SPEED;
  var preferredRadarAnimationSpeed = RADAR_ANIMATION_SPEED;
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
  var rainViewerBudget = StormScopeRadarProviders.createRollingRequestBudget({ limit: 90, windowMs: 60000 });
  var radarBudgetFallbackPending = false;
  var activeCamera = null;
  var priorFocusEl = null;
  var weatherAbort = null;
  var imageRefreshTimer = null;
  var activeFeedCleanup = null;
  var allCameras = [];
  var cameraIconCache = Object.create(null);
  var cameraObservations = Object.create(null);
  var cameraStore = null;
  var cameraLoadMetrics = { startedAt: 0, firstBatchMs: null, completeMs: null, source: null, index: null };
  var cameraLoadProcessed = 0;
  var cameraCatalogDeferred = false;
  var currentCameraResults = [];
  var cameraResultFocusIndex = 0;
  var suppressNextCameraResultScroll = false;
  var cameraResultKeyboardMode = false;
  var searchRenderTimer = null;
  var searchRenderMetrics = { fullRenders: 0, windowRenders: 0, markerSyncs: 0 };
  var savedStore = null;
  var saveLastViewTimer = null;
  var startupSharedScene = null;
  var startupSceneError = false;
  var pendingSceneFrameTime = null;
  var pendingSceneCameraId = null;
  var cameraDataTimestamp = null;
  var diagnostics = StormScopeDiagnostics.create();
  var radarWasPlaying = false;
  var feedPausedForVisibility = false;
  var reloadForUpdate = false;
  var refreshInstallDiscovery = function () {};
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
  var satelliteLayer = null;
  var satelliteAbort = null;
  var satelliteRefreshTimer = null;
  var satelliteMoveTimer = null;
  var satelliteLatestTime = null;
  var satelliteStatusState = 'off';
  var satelliteAttributionAdded = false;
  var tropicalLayer = null;
  var tropicalAbort = null;
  var tropicalRefreshTimer = null;
  var tropicalStatusState = 'off';
  var tropicalStorms = [];
  var tropicalAttributionAdded = false;
  var wpcEroLayer = null;
  var wpcFloodLayer = null;
  var wpcEroAbort = null;
  var wpcFloodAbort = null;
  var wpcRefreshTimer = null;
  var wpcStatusState = 'off';
  var wpcOutlookCount = 0;
  var wpcOutlookDay = 1;
  var wpcAttributionAdded = false;
  var usgsGaugeLayer = null;
  var usgsGaugeAbort = null;
  var usgsGaugeRefreshTimer = null;
  var usgsGaugeMoveTimer = null;
  var usgsGaugeStatusState = 'off';
  var usgsGaugeCount = 0;
  var usgsGaugeAttributionAdded = false;
  var localOverlayRecords = [];
  var localOverlayDatabase = null;
  var LOCAL_OVERLAY_DB = 'stormscope-local-overlays';
  var lightningLayer = null;
  var lightningAbort = null;
  var lightningRefreshTimer = null;
  var lightningLatestTime = null;
  var lightningStatusState = 'off';
  var wildfireLayer = null;
  var wildfireAbort = null;
  var wildfireGeneration = 0;
  var wildfireRefreshTimer = null;
  var wildfireMoveTimer = null;
  var wildfireUpdatedAt = null;
  var wildfireCount = 0;
  var wildfireStatusState = 'off';
  var wildfireAttributionAdded = false;
  var summaryWildfireStatus = 'idle';
  var summaryWildfireCount = 0;
  var summaryWildfireUpdatedAt = null;
  var summaryWildfireFetchedAt = 0;
  var summaryWildfireBoundsKey = null;
  var summaryWildfireAbort = null;
  var incidentCameraSections = [];
  var dataModePreference = 'auto';
  var dataPolicy = StormScopeDataMode.resolve('auto', navigator.connection);
  var lowDataMode = dataPolicy.lowData;
  var lowDataSource = dataPolicy.source;
  var WORKFLOW_PRESETS = Object.freeze({
    severe: {
      center: { lat: 39.5, lon: -98.5 }, zoom: 5,
      layers: { radar: true, cameras: true, coverage: true, alerts: true, satellite: false, lightning: true, wildfires: false, tropical: true, wpcOutlooks: true, usgsGauges: false },
      opacity: { radar: 0.7 }, radar: { palette: 'colorblind', speed: 800 }, alertSeverity: 'severe',
      cameraFilters: { query: '', state: '', source: '', type: '', sort: 'distance', healthy: true, favorites: false }, dataMode: 'auto', outlookDay: 1
    },
    wildfire: {
      center: { lat: 39, lon: -112 }, zoom: 5,
      layers: { radar: false, cameras: true, coverage: false, alerts: true, satellite: true, lightning: false, wildfires: true, tropical: false, wpcOutlooks: false, usgsGauges: false },
      opacity: { radar: 0.55 }, radar: { palette: 'standard', speed: 0 }, alertSeverity: 'moderate',
      cameraFilters: { query: '', state: '', source: '', type: '', sort: 'distance', healthy: true, favorites: false }, dataMode: 'auto', outlookDay: 1
    },
    travel: {
      center: { lat: 38.5, lon: -96 }, zoom: 5,
      layers: { radar: true, cameras: true, coverage: false, alerts: true, satellite: false, lightning: false, wildfires: false, tropical: false, wpcOutlooks: false, usgsGauges: false },
      opacity: { radar: 0.55 }, radar: { palette: 'colorblind', speed: 0 }, alertSeverity: 'moderate',
      cameraFilters: { query: '', state: '', source: '', type: '', sort: 'distance', healthy: true, favorites: false }, dataMode: 'auto', outlookDay: 1
    }
  });

  function tr(key, variables) {
    return StormScopeI18n.t(key, variables, appLocale);
  }

  function localNumber(value) {
    return StormScopeI18n.formatNumber(value, null, appLocale);
  }

  function localTime(value) {
    return StormScopeWeather.formatTime(value, appLocale, tr('weather.unknown'));
  }

  function imageRefreshInterval() {
    return dataPolicy.imageRefreshMs;
  }

  function updateLowDataUi() {
    document.getElementById('data-mode').value = dataModePreference;
    document.getElementById('low-data-status').textContent = tr(lowDataMode
      ? (lowDataSource === 'save-data' ? 'lowData.onSaveData' : 'lowData.on')
      : 'lowData.off');
  }

  function applyDataMode(preference, persist) {
    var wasLowData = lowDataMode;
    dataModePreference = StormScopeDataMode.normalize(preference);
    dataPolicy = StormScopeDataMode.resolve(dataModePreference, navigator.connection);
    lowDataMode = dataPolicy.lowData;
    lowDataSource = dataPolicy.source;
    if (lowDataMode) {
      if (!wasLowData) {
        if (radarAnimationSpeed > 0) preferredRadarAnimationSpeed = radarAnimationSpeed;
        radarAnimationSpeed = 0;
        setRadarPlaying(false);
      }
      clearTimeout(radarPreloadTimer);
      if (radarLayerNext) map.removeLayer(radarLayerNext);
      radarLayerNext = null;
      radarPreloadState = { status: 'suppressed-low-data', durationMs: 0 };
    } else if (wasLowData) {
      radarAnimationSpeed = preferredRadarAnimationSpeed;
    }
    document.getElementById('radar-speed').value = String(radarAnimationSpeed);
    if (persist) {
      try { localStorage.setItem('stormscope-data-mode', dataModePreference); } catch (error) { /* optional */ }
    }
    updateLowDataUi();
    var refreshIndicator = document.querySelector('#modal-feed .feed-refresh-indicator');
    if (refreshIndicator) {
      var refreshLabel = tr('camera.autoRefresh', { seconds: localNumber(imageRefreshInterval() / 1000) });
      refreshIndicator.setAttribute('aria-label', refreshLabel);
      refreshIndicator.title = refreshLabel;
    }
    updateRadarTimeDisplay();
    if (!lowDataMode && cameraCatalogDeferred && cameraStore) resumeCameraCatalog();
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sourceLabel(value) {
    var source = String(value || '').trim().toLowerCase();
    var known = ['angelcam', 'dot', 'earthcam', 'faa', 'hazcams', 'ipcamlive', 'livebeaches',
      'mwra', 'noaa', 'nps', 'nrao', 'rtspme', 'smithsonian', 'state_park', 'university', 'usgs', 'youtube'];
    return known.indexOf(source) === -1 ? (value || tr('source.camera')) : tr('source.' + source);
  }

  function radarReasonLabel(reason) {
    var known = ['rate-limited', 'request-failed', 'frame-expired', 'no-successful-frame', 'stale-frame',
      'partial-coverage', 'using-last-success', 'all-providers-unavailable', 'outside-provider-coverage',
      'primary-unavailable', 'cached-offline'];
    return known.indexOf(reason) === -1 ? tr('radar.reason.unknown') : tr('radar.reason.' + reason);
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
    map.createPane('satellitePane');
    map.getPane('satellitePane').style.zIndex = '315';
    map.getPane('satellitePane').style.pointerEvents = 'none';
    map.createPane('contextVectorPane');
    map.getPane('contextVectorPane').style.zIndex = '390';
    map.createPane('localOverlayPane');
    map.getPane('localOverlayPane').style.zIndex = '380';
    map.createPane('tropicalPane');
    map.getPane('tropicalPane').style.zIndex = '395';

    basemapLayer = L.tileLayer(basemapTileUrl(resolveTheme(themePreference)), {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      crossOrigin: 'anonymous',
      maxZoom: 19
    }).addTo(map);
  }

  // ── Appearance / Theme ──

  function systemPrefersLight() {
    return typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  function resolveTheme(preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    return systemPrefersLight() ? 'light' : 'dark';
  }

  function basemapTileUrl(theme) {
    return 'https://{s}.basemaps.cartocdn.com/' +
      (theme === 'light' ? 'light_all' : 'dark_all') + '/{z}/{x}/{y}.png';
  }

  function applyTheme(preference) {
    themePreference = ['auto', 'dark', 'light'].indexOf(preference) === -1 ? 'auto' : preference;
    var theme = resolveTheme(themePreference);
    document.documentElement.setAttribute('data-theme', theme);
    if (basemapLayer) basemapLayer.setUrl(basemapTileUrl(theme));
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('stormscope-theme'); } catch (error) { /* optional */ }
    themePreference = ['auto', 'dark', 'light'].indexOf(saved) === -1 ? 'auto' : saved;
    document.getElementById('app-theme').value = themePreference;
    document.documentElement.setAttribute('data-theme', resolveTheme(themePreference));
    if (typeof window.matchMedia === 'function') {
      var query = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () { if (themePreference === 'auto') applyTheme('auto'); };
      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);
    }
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
        document.getElementById('radar-meta').textContent = tr('radar.providersUnavailable');
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
    radarBudgetFallbackPending = false;
    radarHost = discovery.tileHost || '';
    radarFrames = discovery.frames;
    if (!radarFrames.length) throw new Error('selected provider returned no frames');
    radarIndex = radarFrames.length - 1;
    if (pendingSceneFrameTime != null) {
      var nearestIndex = 0;
      var nearestDistance = Infinity;
      radarFrames.forEach(function (frame, index) {
        var distance = Math.abs(Number(frame.time) - pendingSceneFrameTime);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
      if (nearestDistance <= 30 * 60 * 1000) radarIndex = nearestIndex;
      else setSavedStateStatus(tr('views.sceneFrameExpired'), true);
      pendingSceneFrameTime = null;
    }
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
        attribution: '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
      });
      guardRainViewerTileLayer(layer);
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
        attribution: '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
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

  function handleRainViewerBudgetExhausted() {
    if (radarBudgetFallbackPending || radarProviderId !== 'rainviewer') return;
    radarBudgetFallbackPending = true;
    var snapshot = rainViewerBudget.snapshot();
    setRadarPlaying(false);
    clearTimeout(radarPreloadTimer);
    if (radarLayerNext) map.removeLayer(radarLayerNext);
    radarLayerNext = null;
    radarPreloadState = { status: 'rate-limited', durationMs: null };
    setRadarStatus(tr('radar.rateLimited', {
      time: StormScopeI18n.formatDateTime(snapshot.rateLimitedUntil, {
        hour: 'numeric', minute: '2-digit', second: '2-digit'
      }, appLocale)
    }), false, true);
    setTimeout(function () {
      initRadar({ forceNoaa: true, resumePlayback: false });
    }, 0);
  }

  function consumeRainViewerRequest() {
    var allowed = rainViewerBudget.consume(1);
    if (!allowed) handleRainViewerBudgetExhausted();
    return allowed;
  }

  function guardRainViewerTileLayer(layer) {
    var createTile = layer.createTile;
    layer.createTile = function (coords, done) {
      if (consumeRainViewerRequest()) return createTile.call(this, coords, done);
      var tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      setTimeout(function () { done(null, tile); }, 0);
      return tile;
    };
    return layer;
  }

  function preloadRadarFrame(index) {
    if (radarLayerNext) {
      map.removeLayer(radarLayerNext);
    }
    clearTimeout(radarPreloadTimer);
    if (lowDataMode) {
      radarLayerNext = null;
      radarPreloadState = { status: 'suppressed-low-data', durationMs: 0, index: index };
      return;
    }
    if (radarProviderId === 'rainviewer' &&
        rainViewerBudget.snapshot().remaining <= RAINVIEWER_PRELOAD_RESERVE) {
      radarLayerNext = null;
      radarPreloadState = { status: 'suppressed-budget', durationMs: 0, index: index };
      return;
    }
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
      ? ' • ' + tr('radar.degraded', { reason: radarReasonLabel(radarProviderSelection.degradationReason) })
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
        attribution: 'RainViewer'
      }
    );
    guardRainViewerTileLayer(radarCoverageLayer).addTo(map);
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

  function renderSatelliteStatus() {
    if (satelliteStatusState === 'off') {
      setContextStatusElement('satellite-status', tr('context.satelliteOff'), 'off');
      return;
    }
    if (satelliteStatusState === 'loading') {
      setContextStatusElement('satellite-status', tr('context.loading'), 'loading');
      return;
    }
    if (satelliteStatusState === 'error') {
      setContextStatusElement('satellite-status', tr(satelliteLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var frameFreshness = StormScopeContextLayers.freshness(
      satelliteLatestTime, StormScopeContextLayers.providers.satellite.staleMs
    );
    setContextStatusElement('satellite-status', tr('context.satelliteStatus', {
      freshness: tr('context.' + frameFreshness.state), time: contextTimestamp(satelliteLatestTime)
    }), frameFreshness.state);
  }

  function scheduleSatelliteRefresh() {
    clearTimeout(satelliteRefreshTimer);
    if (!document.getElementById('toggle-satellite').checked) return;
    satelliteRefreshTimer = setTimeout(refreshSatellite, StormScopeContextLayers.providers.satellite.refreshMs);
  }

  async function refreshSatellite() {
    if (!document.getElementById('toggle-satellite').checked || document.hidden) return;
    if (satelliteAbort) satelliteAbort.abort();
    satelliteAbort = new AbortController();
    var signal = satelliteAbort.signal;
    var pendingOverlays = [];
    satelliteStatusState = 'loading';
    renderSatelliteStatus();
    try {
      var provider = StormScopeContextLayers.providers.satellite;
      var metadataResponse = await fetch(provider.imageServerUrl + '?f=pjson', { cache: 'no-store', signal: signal });
      if (!metadataResponse.ok) throw new Error('HTTP ' + metadataResponse.status);
      var metadata = StormScopeContextLayers.parseGoesMetadata(await metadataResponse.json());
      var bounds = map.getBounds();
      var requests = StormScopeContextLayers.buildGoesExportRequests({
        west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth()
      }, metadata.latestTime, map.getSize());
      var overlays = requests.map(function (request) {
        return L.imageOverlay(request.url, request.bounds, {
          opacity: 0.55, pane: 'satellitePane', crossOrigin: 'anonymous', interactive: false
        });
      });
      pendingOverlays = overlays;
      var nextLayer = L.layerGroup(overlays);
      await Promise.all(overlays.map(function (overlay) {
        return new Promise(function (resolve, reject) {
          overlay.once('load', resolve);
          overlay.once('error', function () { reject(new Error('NOAA GOES image failed')); });
          overlay.addTo(map);
        });
      }));
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (satelliteLayer) map.removeLayer(satelliteLayer);
      satelliteLayer = nextLayer;
      nextLayer.addTo(map);
      pendingOverlays = [];
      satelliteLatestTime = metadata.latestTime;
      satelliteStatusState = 'ready';
      if (!satelliteAttributionAdded) {
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        satelliteAttributionAdded = true;
      }
      renderSatelliteStatus();
    } catch (error) {
      pendingOverlays.forEach(function (overlay) { if (map.hasLayer(overlay)) map.removeLayer(overlay); });
      if (error.name === 'AbortError') return;
      satelliteStatusState = 'error';
      renderSatelliteStatus();
    } finally {
      scheduleSatelliteRefresh();
    }
  }

  function disableSatellite() {
    if (satelliteAbort) satelliteAbort.abort();
    clearTimeout(satelliteRefreshTimer);
    clearTimeout(satelliteMoveTimer);
    if (satelliteLayer) map.removeLayer(satelliteLayer);
    satelliteLayer = null;
    if (satelliteAttributionAdded) {
      var provider = StormScopeContextLayers.providers.satellite;
      map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
      satelliteAttributionAdded = false;
    }
    satelliteStatusState = 'off';
    renderSatelliteStatus();
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
    if (wildfireStatusState === 'error' || wildfireStatusState === 'incomplete') {
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
        attribution: '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
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

  function renderTropicalStatus() {
    var key = tropicalStatusState === 'off' ? 'context.tropicalOff'
      : tropicalStatusState === 'loading' ? 'context.loading'
        : tropicalStatusState === 'no-active' ? 'context.tropicalNone'
          : tropicalStatusState === 'partial' ? 'context.tropicalPartial'
            : tropicalStatusState === 'error' ? 'context.unavailable' : 'context.tropicalActive';
    setContextStatusElement('tropical-status', tr(key, { count: localNumber(tropicalStorms.length) }),
      tropicalStatusState === 'error' || tropicalStatusState === 'partial' ? 'error' : tropicalStatusState);
    var list = document.getElementById('tropical-storm-list');
    list.replaceChildren();
    tropicalStorms.forEach(function (storm) {
      var item = document.createElement('li');
      var name = document.createElement('strong');
      name.textContent = ((storm.classification ? storm.classification + ' ' : '') + storm.name).trim();
      var detail = document.createElement('span');
      detail.textContent = tr('context.tropicalFeature', {
        product: tr('context.tropical.center'), time: contextTimestamp(storm.issuedAt)
      });
      item.appendChild(name);
      item.appendChild(detail);
      list.appendChild(item);
    });
  }

  function tropicalPopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var heading = document.createElement('strong');
    heading.textContent = properties.classification + ' ' + properties.stormName;
    container.appendChild(heading);
    var detail = document.createElement('span');
    detail.textContent = tr('context.tropicalFeature', {
      product: tr('context.tropical.' + (properties.kind === 'forecast-point' ? 'track' : properties.kind)),
      time: contextTimestamp(properties.issuance)
    });
    container.appendChild(detail);
    if (properties.intensity != null) {
      var intensity = document.createElement('span');
      intensity.textContent = tr('context.tropicalIntensity', {
        wind: localNumber(properties.intensity), pressure: properties.pressure == null ? tr('weather.unknown') : localNumber(properties.pressure)
      });
      container.appendChild(intensity);
    }
    var link = document.createElement('a');
    link.href = properties.advisoryUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('context.tropicalAdvisory');
    container.appendChild(link);
    appendNearbyCameraSection(container, feature._nearbyGeometry || feature.geometry, tr('incident.camerasNearTropical'));
    return container;
  }

  function tropicalStyle(feature) {
    var kind = feature.properties && feature.properties.kind;
    if (kind === 'cone') return { color: '#f4a261', weight: 2, fillColor: '#f4a261', fillOpacity: 0.16 };
    if (kind === 'watches') {
      var watchStyle = StormScopeTropicalCyclones.warningStyle(feature.properties.tcww || feature.properties.wwcode);
      watchStyle.fillOpacity = 0;
      return watchStyle;
    }
    return { color: '#ffffff', weight: 3, dashArray: kind === 'track' ? '7 5' : null, fillOpacity: 0 };
  }

  async function fetchTropicalProduct(kind, signal) {
    try {
      var response = await fetch(StormScopeTropicalCyclones.buildQueryUrl(kind), { cache: 'no-store', signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return { ok: true, collection: await response.json() };
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return { ok: false, error: error };
    }
  }

  async function refreshTropical() {
    if (!document.getElementById('toggle-tropical').checked || document.hidden) return;
    if (tropicalAbort) tropicalAbort.abort();
    tropicalAbort = new AbortController();
    var signal = tropicalAbort.signal;
    tropicalStatusState = 'loading';
    renderTropicalStatus();
    try {
      var kinds = Object.keys(StormScopeTropicalCyclones.LAYERS);
      var responses = await Promise.all(kinds.map(function (kind) { return fetchTropicalProduct(kind, signal); }));
      var input = {};
      kinds.forEach(function (kind, index) { input[kind] = responses[index]; });
      var snapshot = StormScopeTropicalCyclones.normalizeSnapshot(input);
      if (snapshot.state === 'unavailable') {
        tropicalStatusState = 'error';
        renderTropicalStatus();
        return;
      }
      if (snapshot.state === 'no-active') {
        if (tropicalLayer) map.removeLayer(tropicalLayer);
        tropicalLayer = null;
        tropicalStorms = [];
        tropicalStatusState = 'no-active';
        renderTropicalStatus();
        return;
      }
      if (!snapshot.storms.length) {
        tropicalStatusState = 'partial';
        renderTropicalStatus();
        return;
      }
      tropicalStorms = snapshot.storms;
      var features = [];
      tropicalStorms.forEach(function (storm) {
        var nearbyFeature = storm.features.find(function (feature) { return feature.properties.kind === 'cone'; }) ||
          storm.features.find(function (feature) { return feature.properties.kind === 'track'; }) || storm.currentPoint;
        storm.features.forEach(function (feature) {
          feature._nearbyGeometry = nearbyFeature && nearbyFeature.geometry;
          features.push(feature);
        });
      });
      var nextLayer = L.geoJSON({ type: 'FeatureCollection', features: features }, {
        pane: 'tropicalPane', style: tropicalStyle,
        pointToLayer: function (feature, latlng) {
          return L.circleMarker(latlng, { pane: 'tropicalPane', radius: feature.properties.kind === 'center' ? 8 : 5,
            color: '#ffffff', weight: 2, fillColor: '#ff2d55', fillOpacity: 0.9 });
        },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return tropicalPopup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 380 });
        }
      }).addTo(map);
      if (tropicalLayer) map.removeLayer(tropicalLayer);
      tropicalLayer = nextLayer;
      if (!tropicalAttributionAdded) {
        map.attributionControl.addAttribution('<a href="https://www.nhc.noaa.gov/gis/" target="_blank" rel="noopener noreferrer">NOAA NHC</a>');
        tropicalAttributionAdded = true;
      }
      tropicalStatusState = snapshot.state;
      renderTropicalStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      tropicalStatusState = 'error';
      renderTropicalStatus();
    } finally {
      clearTimeout(tropicalRefreshTimer);
      if (document.getElementById('toggle-tropical').checked) {
        tropicalRefreshTimer = setTimeout(refreshTropical, StormScopeTropicalCyclones.REFRESH_MS);
      }
    }
  }

  function disableTropical() {
    if (tropicalAbort) tropicalAbort.abort();
    clearTimeout(tropicalRefreshTimer);
    if (tropicalLayer) map.removeLayer(tropicalLayer);
    tropicalLayer = null;
    tropicalStorms = [];
    if (tropicalAttributionAdded) {
      map.attributionControl.removeAttribution('<a href="https://www.nhc.noaa.gov/gis/" target="_blank" rel="noopener noreferrer">NOAA NHC</a>');
      tropicalAttributionAdded = false;
    }
    tropicalStatusState = 'off';
    renderTropicalStatus();
  }

  function renderWpcStatus() {
    var key = wpcStatusState === 'off' ? 'context.wpcOff'
      : wpcStatusState === 'loading' ? 'context.wpcLoading'
        : wpcStatusState === 'none' ? 'context.wpcNone'
          : wpcStatusState === 'partial' || wpcStatusState === 'error' ? 'context.wpcPartial' : 'context.wpcActive';
    setContextStatusElement('wpc-outlook-status', tr(key, {
      day: localNumber(wpcOutlookDay), count: localNumber(wpcOutlookCount)
    }), wpcStatusState === 'partial' || wpcStatusState === 'error' ? 'error' : wpcStatusState);
  }

  function outlookPopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var title = document.createElement('strong');
    var category = tr('context.' + (properties.outlookKind === 'ero' ? 'wpc.' : 'flood.') + properties.outlookCategory);
    title.textContent = tr(properties.outlookKind === 'ero' ? 'context.wpcEroFeature' : 'context.wpcFloodFeature', { category: category });
    container.appendChild(title);
    var issued = document.createElement('span');
    issued.textContent = tr('context.wpcIssued', { time: contextTimestamp(properties.issuedAt) });
    container.appendChild(issued);
    var valid = document.createElement('span');
    valid.textContent = tr('context.wpcValid', {
      start: contextTimestamp(properties.startsAt), end: contextTimestamp(properties.endsAt)
    });
    container.appendChild(valid);
    var source = document.createElement('span');
    source.textContent = tr('context.wpcSource', { source: properties.sourceLabel });
    container.appendChild(source);
    var limitation = document.createElement('span');
    limitation.textContent = tr('context.wpcLimitation');
    container.appendChild(limitation);
    var link = document.createElement('a');
    link.href = properties.outlookKind === 'ero'
      ? 'https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php'
      : 'https://www.wpc.ncep.noaa.gov/nationalfloodoutlook/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('context.wpcOfficial');
    container.appendChild(link);
    appendNearbyCameraSection(container, feature.geometry, tr('incident.camerasNearOutlook'));
    return container;
  }

  function replaceOutlookLayer(current, collection) {
    var next = L.geoJSON(collection, {
      pane: 'contextVectorPane',
      style: function (feature) {
        return StormScopeFloodOutlooks.style(feature.properties.outlookKind, feature.properties.outlookCategory);
      },
      onEachFeature: function (feature, layer) {
        layer.bindPopup(function () { return outlookPopup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 420 });
      }
    }).addTo(map);
    if (current) map.removeLayer(current);
    return next;
  }

  async function refreshWpcOutlooks() {
    if (!document.getElementById('toggle-wpc-outlooks').checked || document.hidden) return;
    if (wpcEroAbort) wpcEroAbort.abort();
    if (wpcFloodAbort) wpcFloodAbort.abort();
    var eroAbort = wpcEroAbort = new AbortController();
    var floodAbort = wpcFloodAbort = new AbortController();
    wpcStatusState = 'loading';
    renderWpcStatus();
    var ero = StormScopeFloodOutlooks.fetchAllPages(fetch, 'ero', wpcOutlookDay, eroAbort.signal);
    var flood = StormScopeFloodOutlooks.fetchAllPages(fetch, 'flood', null, floodAbort.signal);
    try {
      var results = await Promise.allSettled([ero, flood]);
      if (!document.getElementById('toggle-wpc-outlooks').checked ||
          eroAbort.signal.aborted || floodAbort.signal.aborted) return;
      if (results.every(function (result) { return result.status === 'rejected'; })) {
        if (results.some(function (result) { return result.reason && result.reason.name === 'AbortError'; })) return;
        wpcStatusState = 'error';
        renderWpcStatus();
        return;
      }
      if (results[0].status === 'fulfilled') wpcEroLayer = replaceOutlookLayer(wpcEroLayer, results[0].value);
      if (results[1].status === 'fulfilled') wpcFloodLayer = replaceOutlookLayer(wpcFloodLayer, results[1].value);
      var eroCount = results[0].status === 'fulfilled' ? results[0].value.features.length : 0;
      var floodCount = results[1].status === 'fulfilled' ? results[1].value.features.length : 0;
      wpcOutlookCount = eroCount + floodCount;
      wpcStatusState = results.some(function (result) { return result.status === 'rejected'; })
        ? 'partial' : (wpcOutlookCount ? 'ready' : 'none');
      if (!wpcAttributionAdded) {
        map.attributionControl.addAttribution('<a href="https://www.wpc.ncep.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA WPC</a>');
        wpcAttributionAdded = true;
      }
      renderWpcStatus();
    } finally {
      clearTimeout(wpcRefreshTimer);
      if (document.getElementById('toggle-wpc-outlooks').checked) wpcRefreshTimer = setTimeout(refreshWpcOutlooks, 15 * 60 * 1000);
    }
  }

  function disableWpcOutlooks() {
    if (wpcEroAbort) wpcEroAbort.abort();
    if (wpcFloodAbort) wpcFloodAbort.abort();
    clearTimeout(wpcRefreshTimer);
    if (wpcEroLayer) map.removeLayer(wpcEroLayer);
    if (wpcFloodLayer) map.removeLayer(wpcFloodLayer);
    wpcEroLayer = null;
    wpcFloodLayer = null;
    wpcOutlookCount = 0;
    if (wpcAttributionAdded) {
      map.attributionControl.removeAttribution('<a href="https://www.wpc.ncep.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA WPC</a>');
      wpcAttributionAdded = false;
    }
    wpcStatusState = 'off';
    renderWpcStatus();
  }

  function renderGaugeStatus() {
    var key = usgsGaugeStatusState === 'off' ? 'context.gaugesOff'
      : usgsGaugeStatusState === 'loading' ? 'context.gaugesLoading'
        : usgsGaugeStatusState === 'none' ? 'context.gaugesNone'
          : usgsGaugeStatusState === 'partial' || usgsGaugeStatusState === 'error' ? 'context.gaugesPartial' : 'context.gaugesActive';
    setContextStatusElement('usgs-gauge-status', tr(key, { count: localNumber(usgsGaugeCount) }),
      usgsGaugeStatusState === 'partial' || usgsGaugeStatusState === 'error' ? 'error' : usgsGaugeStatusState);
  }

  function gaugePopup(feature) {
    var properties = feature.properties;
    var container = document.createElement('div');
    container.className = 'context-popup';
    var title = document.createElement('strong');
    title.textContent = properties.name;
    container.appendChild(title);
    var value = document.createElement('span');
    value.textContent = tr('context.gaugeValue', { value: localNumber(properties.value), unit: properties.unit });
    container.appendChild(value);
    Object.keys(properties.thresholds).forEach(function (name) {
      var row = document.createElement('span');
      row.textContent = tr('context.gaugeThreshold', {
        name: name, value: localNumber(properties.thresholds[name]), unit: properties.unit
      });
      container.appendChild(row);
    });
    var age = document.createElement('span');
    age.textContent = tr('context.gaugeAge', {
      age: StormScopeI18n.formatAge((Date.now() - Date.parse(properties.observedAt)) / 60000, appLocale)
    });
    container.appendChild(age);
    var source = document.createElement('span');
    source.textContent = tr('context.gaugeSource', { source: properties.source });
    container.appendChild(source);
    var link = document.createElement('a');
    link.href = properties.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('context.gaugeOfficial');
    container.appendChild(link);
    appendNearbyCameraSection(container, feature.geometry, tr('incident.camerasNearGauge'));
    return container;
  }

  function gaugeBounds() {
    var bounds = map.getBounds();
    var west = Math.max(-180, bounds.getWest());
    var east = Math.min(180, bounds.getEast());
    var south = Math.max(-90, bounds.getSouth());
    var north = Math.min(90, bounds.getNorth());
    return west <= east ? [{ west: west, south: south, east: east, north: north }]
      : [{ west: west, south: south, east: 180, north: north }, { west: -180, south: south, east: east, north: north }];
  }

  async function refreshUsgsGauges() {
    if (!document.getElementById('toggle-usgs-gauges').checked || document.hidden) return;
    if (usgsGaugeAbort) usgsGaugeAbort.abort();
    usgsGaugeAbort = new AbortController();
    var signal = usgsGaugeAbort.signal;
    usgsGaugeStatusState = 'loading';
    renderGaugeStatus();
    try {
      var responses = await Promise.all(gaugeBounds().map(async function (bounds) {
        var response = await fetch(StormScopeFloodOutlooks.usgsUrl(bounds), { cache: 'no-store', signal: signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return StormScopeFloodOutlooks.gaugeCandidates(await response.json());
      }));
      var candidates = [].concat.apply([], responses).filter(function (candidate, index, all) {
        return all.findIndex(function (item) { return item.id === candidate.id; }) === index;
      }).slice(0, StormScopeFloodOutlooks.MAX_GAUGES);
      var details = await Promise.allSettled(candidates.map(async function (candidate) {
        var response = await fetch(StormScopeFloodOutlooks.nwpsUrl(candidate), { cache: 'no-store', signal: signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return StormScopeFloodOutlooks.normalizeGauge(candidate, await response.json());
      }));
      if (signal.aborted || !document.getElementById('toggle-usgs-gauges').checked) return;
      var features = details.filter(function (result) { return result.status === 'fulfilled' && result.value; })
        .map(function (result) { return result.value; });
      var next = L.geoJSON({ type: 'FeatureCollection', features: features }, {
        pane: 'contextVectorPane',
        pointToLayer: function (feature, latlng) {
          var colors = { below: '#4cc9f0', action: '#ffff00', minor: '#ff9f1c', moderate: '#ff2d55', major: '#b5179e' };
          return L.circleMarker(latlng, { pane: 'contextVectorPane', radius: 6, color: '#111111', weight: 2,
            fillColor: colors[feature.properties.category] || '#4cc9f0', fillOpacity: 0.9 });
        },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return gaugePopup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 420 });
        }
      }).addTo(map);
      if (usgsGaugeLayer) map.removeLayer(usgsGaugeLayer);
      usgsGaugeLayer = next;
      usgsGaugeCount = features.length;
      usgsGaugeStatusState = details.some(function (result) { return result.status === 'rejected'; }) ? 'partial'
        : (features.length ? 'ready' : 'none');
      if (!usgsGaugeAttributionAdded) {
        map.attributionControl.addAttribution('<a href="https://waterdata.usgs.gov/" target="_blank" rel="noopener noreferrer">USGS</a> / <a href="https://water.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA NWPS</a>');
        usgsGaugeAttributionAdded = true;
      }
      renderGaugeStatus();
      renderLocalOverlayList();
    } catch (error) {
      if (error.name === 'AbortError') return;
      usgsGaugeStatusState = 'error';
      renderGaugeStatus();
    } finally {
      clearTimeout(usgsGaugeRefreshTimer);
      if (document.getElementById('toggle-usgs-gauges').checked) usgsGaugeRefreshTimer = setTimeout(refreshUsgsGauges, 5 * 60 * 1000);
    }
  }

  function disableUsgsGauges() {
    if (usgsGaugeAbort) usgsGaugeAbort.abort();
    clearTimeout(usgsGaugeRefreshTimer);
    clearTimeout(usgsGaugeMoveTimer);
    if (usgsGaugeLayer) map.removeLayer(usgsGaugeLayer);
    usgsGaugeLayer = null;
    usgsGaugeCount = 0;
    if (usgsGaugeAttributionAdded) {
      map.attributionControl.removeAttribution('<a href="https://waterdata.usgs.gov/" target="_blank" rel="noopener noreferrer">USGS</a> / <a href="https://water.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA NWPS</a>');
      usgsGaugeAttributionAdded = false;
    }
    usgsGaugeStatusState = 'off';
    renderGaugeStatus();
  }

  function overlayStoredRecord(record) {
    return {
      schema: record.schema, version: record.version, id: record.id, name: record.name,
      sourceFormat: record.sourceFormat, createdAt: record.createdAt, updatedAt: new Date().toISOString(),
      visible: record.visible, style: record.style, featureCount: record.featureCount,
      coordinateCount: record.coordinateCount, data: record.data
    };
  }

  function overlayTransaction(mode, operation) {
    if (!localOverlayDatabase) return Promise.reject(new Error('storage unavailable'));
    return new Promise(function (resolve, reject) {
      var transaction = localOverlayDatabase.transaction('overlays', mode);
      var request = operation(transaction.objectStore('overlays'));
      var result;
      request.onsuccess = function () { result = request.result; };
      request.onerror = function () { reject(request.error || new Error('storage failed')); };
      transaction.onabort = function () { reject(transaction.error || new Error('storage aborted')); };
      transaction.oncomplete = function () { resolve(result); };
    });
  }

  function openLocalOverlayDatabase() {
    if (!window.indexedDB) return Promise.resolve([]);
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(LOCAL_OVERLAY_DB, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains('overlays')) request.result.createObjectStore('overlays', { keyPath: 'id' });
      };
      request.onerror = function () { reject(request.error || new Error('storage unavailable')); };
      request.onsuccess = function () {
        localOverlayDatabase = request.result;
        overlayTransaction('readonly', function (store) { return store.getAll(); }).then(resolve, reject);
      };
    });
  }

  function setLocalOverlayStatus(key, variables, error) {
    var status = document.getElementById('local-overlay-status');
    status.textContent = tr(key, variables);
    status.classList.toggle('error', Boolean(error));
  }

  function localOverlayPopup(feature) {
    var container = document.createElement('div');
    container.className = 'context-popup local-overlay-popup';
    var title = document.createElement('strong');
    title.textContent = feature.properties.name || feature.id || tr('overlays.heading');
    container.appendChild(title);
    var entries = Object.keys(feature.properties || {}).slice(0, 12);
    if (entries.length) {
      var details = document.createElement('dl');
      entries.forEach(function (key) {
        var term = document.createElement('dt');
        var value = document.createElement('dd');
        term.textContent = key;
        value.textContent = feature.properties[key] == null ? '—' : String(feature.properties[key]);
        details.appendChild(term);
        details.appendChild(value);
      });
      container.appendChild(details);
    }
    appendNearbyCameraSection(container, feature.geometry, tr('incident.camerasNearOverlay'));
    return container;
  }

  function drawLocalOverlay(record) {
    if (record.layer) map.removeLayer(record.layer);
    record.layer = null;
    if (!record.visible) return;
    record.layer = L.geoJSON(record.data, {
      pane: 'localOverlayPane',
      style: function (feature) { return StormScopeLocalOverlays.style(record, feature.geometry.type); },
      pointToLayer: function (feature, latlng) {
        var style = StormScopeLocalOverlays.style(record, feature.geometry.type);
        return L.circleMarker(latlng, { pane: 'localOverlayPane', radius: 6, color: '#f8f9fa', weight: 2,
          fillColor: style.color, fillOpacity: 0.9 });
      },
      onEachFeature: function (feature, layer) {
        layer.bindPopup(function () { return localOverlayPopup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 420 });
      }
    }).addTo(map);
  }

  function downloadLocalOverlay(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var href = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = href;
    link.download = filename;
    link.click();
    setTimeout(function () { URL.revokeObjectURL(href); }, 0);
  }

  function overlayFeatureCount(record) {
    return tr(record.featureCount === 1 ? 'overlays.featureCountOne' : 'overlays.featureCountMany', {
      count: localNumber(record.featureCount)
    });
  }

  function zoomLocalOverlay(record) {
    var bounds = StormScopeLocalOverlays.geometryBounds(record.data);
    if (bounds.west === bounds.east && bounds.south === bounds.north) {
      map.setView([bounds.south, bounds.west], Math.min(12, Math.max(map.getZoom(), 8)));
    } else map.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [30, 30], maxZoom: 12 });
  }

  function renderLocalOverlayList() {
    var list = document.getElementById('local-overlay-list');
    list.replaceChildren();
    if (!localOverlayRecords.length) {
      var empty = document.createElement('li');
      empty.className = 'local-overlay-empty';
      empty.textContent = tr('overlays.empty');
      list.appendChild(empty);
    }
    localOverlayRecords.forEach(function (record) {
      var item = document.createElement('li');
      item.className = 'local-overlay-item';
      var visibility = document.createElement('input');
      visibility.type = 'checkbox';
      visibility.className = 'local-overlay-visibility';
      visibility.checked = record.visible;
      visibility.setAttribute('aria-label', tr(record.visible ? 'overlays.hide' : 'overlays.show', { name: record.name }));
      visibility.addEventListener('change', function () {
        record.visible = this.checked;
        drawLocalOverlay(record);
        if (record.persisted) overlayTransaction('readwrite', function (store) { return store.put(overlayStoredRecord(record)); }).catch(function () {
          setLocalOverlayStatus('overlays.error.storage', null, true);
        });
        renderLocalOverlayList();
      });
      var name = document.createElement('strong');
      name.className = 'local-overlay-name';
      name.textContent = record.name;
      var meta = document.createElement('span');
      meta.className = 'local-overlay-meta';
      meta.textContent = tr('overlays.meta', {
        type: tr('overlays.type.' + record.sourceFormat), count: overlayFeatureCount(record)
      });
      var actions = document.createElement('div');
      actions.className = 'local-overlay-actions';
      function action(label, handler) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', handler);
        actions.appendChild(button);
      }
      action(tr('overlays.zoom'), function () { zoomLocalOverlay(record); });
      action(tr('overlays.export'), function () {
        try {
          downloadLocalOverlay('stormscope-' + record.id + '.geojson', StormScopeLocalOverlays.exportOverlay(record), 'application/geo+json');
          setLocalOverlayStatus('overlays.exported', { name: record.name });
        } catch (error) { setLocalOverlayStatus('overlays.error.export', null, true); }
      });
      action(tr(record.persisted ? 'overlays.stopKeeping' : 'overlays.keep'), function () {
        var operation = record.persisted
          ? overlayTransaction('readwrite', function (store) { return store.delete(record.id); })
          : overlayTransaction('readwrite', function (store) { return store.put(overlayStoredRecord(record)); });
        operation.then(function () {
          record.persisted = !record.persisted;
          setLocalOverlayStatus(record.persisted ? 'overlays.kept' : 'overlays.notKept', { name: record.name });
          renderLocalOverlayList();
        }).catch(function () { setLocalOverlayStatus('overlays.error.storage', null, true); });
      });
      action(tr('overlays.remove'), function () {
        if (record.layer) map.removeLayer(record.layer);
        localOverlayRecords = localOverlayRecords.filter(function (itemRecord) { return itemRecord !== record; });
        var removal = record.persisted ? overlayTransaction('readwrite', function (store) { return store.delete(record.id); }) : Promise.resolve();
        removal.catch(function () { setLocalOverlayStatus('overlays.error.storage', null, true); });
        setLocalOverlayStatus('overlays.removed', { name: record.name });
        renderLocalOverlayList();
      });
      item.appendChild(visibility);
      item.appendChild(name);
      item.appendChild(meta);
      item.appendChild(actions);
      list.appendChild(item);
    });
    document.getElementById('export-local-overlays').disabled = !localOverlayRecords.length;
    document.getElementById('clear-local-overlays').disabled = !localOverlayRecords.length;
  }

  function importLocalOverlay(file) {
    if (!file) return;
    setLocalOverlayStatus('overlays.reading');
    if (localOverlayRecords.length >= StormScopeLocalOverlays.MAX_OVERLAYS) {
      setLocalOverlayStatus('overlays.error.limit', null, true);
      return;
    }
    if (file.size > StormScopeLocalOverlays.MAX_FILE_BYTES) {
      setLocalOverlayStatus('overlays.error.size', null, true);
      return;
    }
    file.text().then(function (text) {
      var record = StormScopeLocalOverlays.createRecord(file, text);
      var existing = localOverlayRecords.find(function (item) { return item.id === record.id; });
      if (!existing) {
        record.persisted = false;
        record.layer = null;
        localOverlayRecords.push(record);
        drawLocalOverlay(record);
      }
      renderLocalOverlayList();
      setLocalOverlayStatus('overlays.imported', {
        name: record.name, count: overlayFeatureCount(record)
      });
    }).catch(function (error) {
      var message = String(error && error.message || '');
      var key = /size/.test(message) ? 'overlays.error.size'
        : /type|MIME/.test(message) ? 'overlays.error.type'
          : /limit/.test(message) ? 'overlays.error.limit' : 'overlays.error.invalid';
      setLocalOverlayStatus(key, null, true);
    });
  }

  function initLocalOverlays() {
    renderLocalOverlayList();
    openLocalOverlayDatabase().then(function (records) {
      records.forEach(function (value) {
        if (localOverlayRecords.length >= StormScopeLocalOverlays.MAX_OVERLAYS) return;
        try {
          var record = StormScopeLocalOverlays.validateRecord(value);
          record.persisted = true;
          record.layer = null;
          localOverlayRecords.push(record);
          drawLocalOverlay(record);
        } catch (error) { /* invalid records fail closed */ }
      });
      renderLocalOverlayList();
    }).catch(function () { localOverlayDatabase = null; });
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
    appendNearbyCameraSection(container, feature.geometry, tr('incident.camerasNearFire'));
    return container;
  }

  function incidentCameraRelation(result) {
    if (result.inside) return tr('incident.insideArea');
    return tr('incident.nearbyRelation', {
      distance: StormScopeWeather.distanceFromKm(result.distanceKm, weatherUnits),
      bearing: localizedWindDirection(result.bearing)
    });
  }

  function incidentCameraMetadata(result) {
    var camera = result.camera;
    var parts = [incidentCameraRelation(result), tr('camera.health.' + (camera.health || 'unknown'))];
    if (camera.direction && !/^(unknown|any)$/i.test(camera.direction)) {
      parts.push(tr('incident.viewDirection', { direction: localizedWindDirection(camera.direction) }));
    }
    if (camera.last_verified) parts.push(tr('incident.verified', { time: localTime(camera.last_verified) }));
    return parts.join(' • ');
  }

  function refreshIncidentCameraSections() {
    incidentCameraSections = incidentCameraSections.filter(function (entry) {
      if (!entry.element.isConnected) return false;
      renderIncidentCameraSection(entry.element, entry.geometry, entry.heading);
      return true;
    });
  }

  function appendNearbyCameraSection(container, geometry, heading) {
    var section = document.createElement('section');
    section.className = 'incident-cameras';
    section.dataset.incidentCameras = 'true';
    container.appendChild(section);
    incidentCameraSections.push({ element: section, geometry: geometry, heading: heading });
    renderIncidentCameraSection(section, geometry, heading);
  }

  function incidentCameraButton(label, className, action) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  function renderIncidentCameraSection(section, geometry, headingText) {
    section.replaceChildren();
    var heading = document.createElement('h4');
    heading.textContent = headingText;
    section.appendChild(heading);
    var status = document.createElement('p');
    status.className = 'incident-camera-status';
    if (!geometry) {
      status.textContent = tr('incident.noGeometry');
      section.appendChild(status);
      return;
    }
    if (cameraLoadMetrics.completeMs == null) {
      status.textContent = tr('incident.camerasLoading');
      section.appendChild(status);
      return;
    }
    var results = StormScopeSpatialQuery.queryCameras(allCameras, geometry, { maxDistanceKm: 50, limit: 8 });
    if (!results.length) {
      status.textContent = tr('incident.noCameras');
      section.appendChild(status);
      return;
    }
    status.textContent = tr(results.length === 1 ? 'incident.cameraCountOne' : 'incident.cameraCountMany', {
      count: localNumber(results.length)
    });
    section.appendChild(status);
    var list = document.createElement('ul');
    results.forEach(function (result) {
      var camera = result.camera;
      var item = document.createElement('li');
      item.dataset.cameraId = String(camera.id);
      var name = document.createElement('strong');
      name.textContent = camera.name;
      var metadata = document.createElement('span');
      metadata.textContent = incidentCameraMetadata(result);
      var actions = document.createElement('div');
      actions.className = 'incident-camera-actions';
      actions.appendChild(incidentCameraButton(tr('incident.showOnMap'), 'incident-camera-map', function () {
        map.setView([camera.lat, camera.lon], Math.max(12, map.getZoom()), { animate: false });
      }));
      actions.appendChild(incidentCameraButton(tr('incident.openCamera'), 'incident-camera-open', function () {
        openCameraModal(camera);
      }));
      actions.appendChild(incidentCameraButton(
        tr(monitorSelection.has(camera) ? 'incident.removeMonitor' : 'incident.addMonitor'),
        'incident-camera-select',
        function () {
          toggleMonitorCamera(camera);
          refreshIncidentCameraSections();
        }
      ));
      item.appendChild(name);
      item.appendChild(metadata);
      item.appendChild(actions);
      list.appendChild(item);
    });
    section.appendChild(list);
    var monitorCameras = StormScopeSpatialQuery.monitorCandidates(results, 2, 4);
    if (monitorCameras.length >= 2) {
      section.appendChild(incidentCameraButton(tr('incident.openMonitor', {
        count: localNumber(monitorCameras.length)
      }), 'incident-monitor-open', function () {
        monitorSelection.replace(monitorCameras);
        updateMonitorSelectionUi();
        renderCameraResultWindow();
        refreshIncidentCameraSections();
        openMonitor();
      }));
    }
  }

  function scheduleWildfireRefresh() {
    clearTimeout(wildfireRefreshTimer);
    wildfireRefreshTimer = null;
    if (!document.getElementById('toggle-wildfires').checked) return;
    wildfireRefreshTimer = setTimeout(refreshWildfires, StormScopeContextLayers.providers.wildfires.refreshMs);
  }

  function currentWildfireBounds() {
    var bounds = map.getBounds();
    return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
  }

  function wildfireBoundsKey(bounds) {
    return [bounds.west, bounds.south, bounds.east, bounds.north].map(function (value) {
      return Number(value).toFixed(2);
    }).join(',');
  }

  async function fetchWildfireSnapshot(bounds, signal) {
    var provider = StormScopeContextLayers.providers.wildfires;
    var urls = StormScopeContextLayers.buildWildfireQueries(bounds);
    var metadataResponse = await fetch(provider.layerUrl + '?f=pjson', { cache: 'no-store', signal: signal });
    if (!metadataResponse.ok) throw new Error('HTTP ' + metadataResponse.status);
    var metadata = StormScopeContextLayers.parseWildfireMetadata(await metadataResponse.json());
    var paged = await StormScopeContextLayers.fetchWildfirePages({
      urls: urls,
      pageSize: metadata.maxRecordCount,
      signal: signal,
      fetchPage: function (url, pageSignal) {
        return fetch(url, { cache: 'no-store', signal: pageSignal }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        });
      }
    });
    return { collection: paged.collection, metadata: metadata };
  }

  async function refreshWildfires() {
    if (!document.getElementById('toggle-wildfires').checked || document.hidden) return;
    if (wildfireAbort) wildfireAbort.abort();
    wildfireAbort = new AbortController();
    var generation = ++wildfireGeneration;
    var signal = wildfireAbort.signal;
    wildfireStatusState = 'loading';
    renderWildfireStatus();
    try {
      var provider = StormScopeContextLayers.providers.wildfires;
      var bounds = currentWildfireBounds();
      var snapshot = await fetchWildfireSnapshot(bounds, signal);
      if (generation !== wildfireGeneration) return;
      var collection = snapshot.collection;
      var nextLayer = L.geoJSON(collection, {
        pane: 'contextVectorPane',
        style: { color: '#ff6b35', weight: 2, opacity: 0.9, fillColor: '#ff6b35', fillOpacity: 0.09 },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return wildfirePopup(feature); }, { autoPan: false, maxWidth: 380, maxHeight: 360 });
        }
      }).addTo(map);
      if (wildfireLayer) map.removeLayer(wildfireLayer);
      wildfireLayer = nextLayer;
      if (!wildfireAttributionAdded) {
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        wildfireAttributionAdded = true;
      }
      wildfireUpdatedAt = snapshot.metadata.updatedAt;
      wildfireCount = collection.features.length;
      wildfireStatusState = 'ready';
      summaryWildfireStatus = 'ready';
      summaryWildfireCount = wildfireCount;
      summaryWildfireUpdatedAt = wildfireUpdatedAt;
      summaryWildfireFetchedAt = Date.now();
      summaryWildfireBoundsKey = wildfireBoundsKey(bounds);
      renderWildfireStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation !== wildfireGeneration) return;
      wildfireStatusState = wildfireLayer ? 'incomplete' : 'error';
      renderWildfireStatus();
    } finally {
      if (generation === wildfireGeneration) scheduleWildfireRefresh();
    }
  }

  function disableWildfires() {
    wildfireGeneration += 1;
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
      if (!consumeRainViewerRequest()) {
        resolve(null);
        return;
      }
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
    var intensity = StormScopeRadarProviders.classifyRainViewerPixel(radarPixel);
    var covered = coveragePixel
      ? !(coveragePixel[3] > 0 && coveragePixel[0] < 16 && coveragePixel[1] < 16 && coveragePixel[2] < 16)
      : null;
    radarSemanticState = StormScopeRadarProviders.classifyRadarState({
      frame: frame,
      coverage: covered,
      hasPrecipitation: radarPixel ? intensity !== 'clear' : null,
      intensity: radarPixel ? intensity : null
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

  function loadCameraObservations() {
    try {
      var value = JSON.parse(localStorage.getItem('stormscope-camera-observations-v1') || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.create(null);
      var now = Date.now();
      Object.keys(value).forEach(function (key) {
        if (!value[key] || !Number.isFinite(value[key].expires_at) || value[key].expires_at <= now) {
          delete value[key];
        }
      });
      return value;
    } catch (error) {
      return Object.create(null);
    }
  }

  function persistCameraObservations() {
    try { localStorage.setItem('stormscope-camera-observations-v1', JSON.stringify(cameraObservations)); } catch (error) { /* optional */ }
  }

  function cameraHealthKey(cam) {
    return cam.type + '|' + (cam.source_url || cam.url);
  }

  function recordCameraObservation(cam, outcome, reason) {
    if (!cam) return;
    var observedAt = Date.now();
    var observation = {
      outcome: outcome,
      reason: reason || null,
      observed_at: new Date(observedAt).toISOString(),
      expires_at: observedAt + CAMERA_OBSERVATION_TTL
    };
    cameraObservations[cameraHealthKey(cam)] = observation;
    cam.local_observation = observation;
    persistCameraObservations();
    if (activeCamera === cam) updateModalCameraHealth(cam);
  }

  function handleCameraLoadProgress(progress) {
    if (progress.source === 'monolith' && cameraLoadMetrics.source !== 'monolith') {
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

  function showDeferredCameraCatalog(index) {
    cameraCatalogDeferred = true;
    var container = document.getElementById('camera-catalog-deferred');
    container.classList.remove('hidden');
    document.getElementById('camera-catalog-deferred-status').textContent = tr('camera.catalogDeferred', {
      count: localNumber(index.total)
    });
    document.getElementById('camera-count').textContent = tr('camera.available', { count: localNumber(index.total) });
    document.getElementById('search-progress').textContent = tr('search.indexReady');
    document.getElementById('camera-results-status').textContent = tr('camera.catalogDeferredShort');
  }

  async function resumeCameraCatalog() {
    if (!cameraStore || !cameraCatalogDeferred) return;
    var button = document.getElementById('load-camera-catalog');
    button.disabled = true;
    cameraCatalogDeferred = false;
    cameraLoadMetrics.startedAt = performance.now();
    cameraLoadMetrics.firstBatchMs = null;
    cameraLoadProcessed = 0;
    try {
      var result = await cameraStore.resume({ onProgress: handleCameraLoadProgress });
      cameraLoadMetrics.completeMs = performance.now() - cameraLoadMetrics.startedAt;
      cameraLoadMetrics.source = result.source;
      cameraLoadMetrics.index = result.index;
      document.getElementById('camera-catalog-deferred').classList.add('hidden');
      document.getElementById('camera-count').textContent = cameraCountLabel();
      document.getElementById('search-progress').textContent = tr('camera.firstBatch', {
        count: localNumber(allCameras.length), milliseconds: localNumber(Math.round(cameraLoadMetrics.firstBatchMs || 0))
      });
      scheduleSearchRender();
      refreshIncidentCameraSections();
    } catch (error) {
      cameraCatalogDeferred = true;
      button.disabled = false;
      document.getElementById('search-progress').textContent = tr('search.loadFailed');
      diagnostics.capture(error, 'camera-catalog-resume');
    }
  }

  async function loadCameras() {
    try {
      document.getElementById('camera-count').textContent = tr('camera.loadingCount');
      cameraDataTimestamp = null;
      cameraObservations = loadCameraObservations();
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
      cameraLoadMetrics = { startedAt: performance.now(), firstBatchMs: null, completeMs: null, source: null, index: null };
      cameraStore = new StormScopeCameraStore.CameraStore({
        indexUrl: 'data/cameras.index.json',
        monolithUrl: 'data/cameras.json'
      });
      var result = await cameraStore.load({ deferShards: dataPolicy.deferCameraCatalog, onProgress: handleCameraLoadProgress });
      cameraLoadMetrics.completeMs = performance.now() - cameraLoadMetrics.startedAt;
      cameraLoadMetrics.source = result.source;
      cameraLoadMetrics.index = result.index;
      cameraDataTimestamp = result.index ? new Date(result.index.generated_at) : null;
      if (!result.complete) {
        showDeferredCameraCatalog(result.index);
        updateDataFreshness();
        if (pendingSceneCameraId != null) {
          var requestedCamera = await cameraStore.loadCameraById(pendingSceneCameraId);
          if (requestedCamera) {
            addCameraBatch([requestedCamera]);
            openCameraModal(requestedCamera);
          } else setSavedStateStatus(tr('views.sceneCameraUnavailable'), true);
          pendingSceneCameraId = null;
        }
        return;
      }
      document.getElementById('camera-count').textContent = cameraCountLabel();
      document.getElementById('search-progress').textContent = tr('camera.firstBatch', {
        count: localNumber(allCameras.length), milliseconds: localNumber(Math.round(cameraLoadMetrics.firstBatchMs || 0))
      });
      updateDataFreshness();
      scheduleSearchRender();
      refreshIncidentCameraSections();
      if (pendingSceneCameraId != null) {
        var sharedCamera = allCameras.find(function (camera) { return String(camera.id) === pendingSceneCameraId; });
        if (sharedCamera) openCameraModal(sharedCamera);
        else setSavedStateStatus(tr('views.sceneCameraUnavailable'), true);
        pendingSceneCameraId = null;
      }
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
      cam.local_observation = cameraObservations[cameraHealthKey(cam)] || null;
      var marker = L.marker([cam.lat, cam.lon], {
        icon: cameraIconFor(cam),
        title: tr('camera.feedLabel', { name: cam.name, health: tr('camera.health.' + (cam.health || 'unknown')) })
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
    searchRenderMetrics.markerSyncs += 1;
    cameraCluster.clearLayers();
    var cameras = filtered ? results : allCameras;
    cameraCluster.addLayers(cameras.map(function (camera) { return camera._marker; }).filter(Boolean));
  }

  function cameraResultSummary(camera) {
    var parts = [];
    if (camera.road && camera.road !== camera.name) parts.push(camera.road);
    if (camera.county) parts.push(camera.county);
    if (camera.state) parts.push(camera.state);
    parts.push(tr('camera.health.' + (camera.health || 'unknown')) + ' • ' + sourceLabel(camera.source || camera.type));
    return parts.join(' • ');
  }

  function selectCameraResult(camera) {
    map.setView([camera.lat, camera.lon], Math.max(14, map.getZoom()), { animate: false });
    openCameraModal(camera);
  }

  function toggleCameraFavorite(camera) {
    try {
      savedStore.toggleFavorite(camera.id);
      updateFavoriteButton(camera);
      if (document.getElementById('camera-favorites').checked) renderCameraResults();
      else renderCameraResultWindow();
    } catch (error) {
      document.getElementById('camera-results-status').textContent = tr('search.favoriteError');
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
      renderCameraResultWindow();
    } catch (error) {
      updateMonitorSelectionUi(tr('monitor.maximum'));
    }
  }

  function renderCameraResults() {
    searchRenderMetrics.fullRenders += 1;
    if (!cameraStore) {
      document.getElementById('camera-results').replaceChildren();
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

    renderCameraResultWindow();
  }

  function renderCameraResultWindow() {
    searchRenderMetrics.windowRenders += 1;
    var list = document.getElementById('camera-results');
    var scroller = document.getElementById('camera-results-scroll');
    list.replaceChildren();
    var results = currentCameraResults;

    var virtual = StormScopeCameraStore.virtualize(results, {
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight || 360,
      itemHeight: 68,
      overscan: 4
    });
    if (cameraResultKeyboardMode &&
        (cameraResultFocusIndex < virtual.start || cameraResultFocusIndex >= virtual.end)) {
      virtual = StormScopeCameraStore.virtualize(results, {
        scrollTop: cameraResultFocusIndex * 68,
        viewportHeight: scroller.clientHeight || 360,
        itemHeight: 68,
        overscan: 4
      });
    }
    if (virtual.offsetTop) {
      var before = document.createElement('li');
      before.style.height = virtual.offsetTop + 'px';
      before.setAttribute('aria-hidden', 'true');
      list.appendChild(before);
    }
    virtual.items.forEach(function (camera, localIndex) {
      var resultIndex = virtual.start + localIndex;
      var item = document.createElement('li');
      item.className = 'camera-result';
      item.setAttribute('role', 'listitem');
      item.dataset.resultIndex = String(resultIndex);
      item.setAttribute('aria-posinset', String(resultIndex + 1));
      item.setAttribute('aria-setsize', String(results.length));
      var openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'camera-result-open';
      openButton.tabIndex = resultIndex === cameraResultFocusIndex ? 0 : -1;
      var name = document.createElement('strong');
      name.textContent = camera.name;
      var summary = document.createElement('span');
      summary.textContent = cameraResultSummary(camera);
      openButton.appendChild(name);
      openButton.appendChild(summary);
      openButton.addEventListener('click', function () { selectCameraResult(camera); });
      openButton.addEventListener('focus', function () { cameraResultFocusIndex = resultIndex; });
      var favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'favorite-result';
      favorite.tabIndex = resultIndex === cameraResultFocusIndex ? 0 : -1;
      favorite.setAttribute('aria-label', tr(savedStore.isFavorite(camera.id) ? 'camera.favoriteRemove' : 'camera.favoriteAdd', {
        name: camera.name
      }));
      favorite.setAttribute('aria-pressed', String(savedStore.isFavorite(camera.id)));
      favorite.textContent = savedStore.isFavorite(camera.id) ? '★' : '☆';
      favorite.addEventListener('click', function () { toggleCameraFavorite(camera); });
      var monitor = document.createElement('button');
      monitor.type = 'button';
      monitor.className = 'monitor-result';
      monitor.tabIndex = resultIndex === cameraResultFocusIndex ? 0 : -1;
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
    if (cameraResultKeyboardMode) {
      var focusedButton = list.querySelector(
        '.camera-result[data-result-index="' + cameraResultFocusIndex + '"] .camera-result-open'
      );
      if (focusedButton && document.activeElement !== focusedButton) focusedButton.focus();
    }
  }

  function focusCameraResult(index) {
    if (!currentCameraResults.length) return;
    cameraResultFocusIndex = Math.max(0, Math.min(currentCameraResults.length - 1, index));
    var scroller = document.getElementById('camera-results-scroll');
    var itemTop = cameraResultFocusIndex * 68;
    var nextScrollTop = scroller.scrollTop;
    if (itemTop < scroller.scrollTop) nextScrollTop = itemTop;
    else if (itemTop + 68 > scroller.scrollTop + scroller.clientHeight) {
      nextScrollTop = itemTop + 68 - scroller.clientHeight;
    }
    if (nextScrollTop !== scroller.scrollTop) {
      suppressNextCameraResultScroll = true;
      scroller.scrollTop = nextScrollTop;
    }
    renderCameraResultWindow();
    var button = document.querySelector(
      '.camera-result[data-result-index="' + cameraResultFocusIndex + '"] .camera-result-open'
    );
    if (button) button.focus();
  }

  function handleCameraResultNavigation(event) {
    var key = event.key;
    var next = cameraResultFocusIndex;
    if (key === 'ArrowDown') next += 1;
    else if (key === 'ArrowUp') next -= 1;
    else if (key === 'PageDown') next += Math.max(1, Math.floor(event.currentTarget.clientHeight / 68));
    else if (key === 'PageUp') next -= Math.max(1, Math.floor(event.currentTarget.clientHeight / 68));
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = currentCameraResults.length - 1;
    else return;
    event.preventDefault();
    cameraResultKeyboardMode = true;
    focusCameraResult(next);
  }

  function scheduleSearchRender(resetScroll) {
    clearTimeout(searchRenderTimer);
    if (resetScroll) {
      document.getElementById('camera-results-scroll').scrollTop = 0;
      cameraResultFocusIndex = 0;
      cameraResultKeyboardMode = false;
    }
    searchRenderTimer = setTimeout(renderCameraResults, 100);
  }

  function scheduleSearchWindowRender() {
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(renderCameraResultWindow, 16);
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

  function captureViewSnapshot(includeWorkflow) {
    var center = map.getCenter();
    var snapshot = {
      center: { lat: center.lat, lon: center.lng },
      zoom: map.getZoom(),
      layers: {
        radar: document.getElementById('toggle-radar').checked,
        cameras: document.getElementById('toggle-cameras').checked,
        coverage: document.getElementById('toggle-coverage').checked,
        alerts: document.getElementById('toggle-alerts').checked,
        satellite: document.getElementById('toggle-satellite').checked,
        lightning: document.getElementById('toggle-lightning').checked,
        wildfires: document.getElementById('toggle-wildfires').checked,
        tropical: document.getElementById('toggle-tropical').checked,
        wpcOutlooks: document.getElementById('toggle-wpc-outlooks').checked,
        usgsGauges: document.getElementById('toggle-usgs-gauges').checked
      },
      opacity: { radar: radarOpacity }
    };
    if (includeWorkflow) {
      var filters = cameraSearchFilters();
      snapshot.radar = { palette: radarPalette, speed: preferredRadarAnimationSpeed };
      snapshot.alertSeverity = document.getElementById('alert-severity').value;
      snapshot.cameraFilters = {
        query: filters.query, state: filters.state, source: filters.source, type: filters.type,
        sort: document.getElementById('camera-sort').value, healthy: filters.healthy,
        favorites: document.getElementById('camera-favorites').checked
      };
      snapshot.dataMode = dataModePreference;
      snapshot.weatherUnits = weatherUnits;
      snapshot.outlookDay = wpcOutlookDay;
    }
    return snapshot;
  }

  function captureSharedScene() {
    var snapshot = captureViewSnapshot();
    var filters = cameraSearchFilters();
    return {
      map: { lat: snapshot.center.lat, lon: snapshot.center.lon, zoom: snapshot.zoom },
      layers: snapshot.layers,
      radar: {
        opacity: radarOpacity,
        palette: radarPalette,
        speed: radarAnimationSpeed,
        frameTime: radarFrames[radarIndex] ? radarFrames[radarIndex].time : null
      },
      alertSeverity: document.getElementById('alert-severity').value,
      cameraFilters: {
        query: filters.query,
        state: filters.state,
        source: filters.source,
        type: filters.type,
        sort: document.getElementById('camera-sort').value,
        healthy: filters.healthy
      },
      activeCameraId: activeCamera ? activeCamera.id : null,
      outlookDay: wpcOutlookDay
    };
  }

  function sharedSceneUrl() {
    var url = new URL(location.href);
    url.hash = StormScopeSceneCodec.toHash(captureSharedScene());
    return url.toString();
  }

  function applySharedScene(scene) {
    wpcOutlookDay = scene.outlookDay;
    document.getElementById('wpc-outlook-day').value = String(wpcOutlookDay);
    applyViewSnapshot({
      center: { lat: scene.map.lat, lon: scene.map.lon },
      zoom: scene.map.zoom,
      layers: scene.layers,
      opacity: { radar: scene.radar.opacity }
    });
    radarPalette = scene.radar.palette;
    preferredRadarAnimationSpeed = scene.radar.speed;
    radarAnimationSpeed = lowDataMode ? 0 : scene.radar.speed;
    document.getElementById('radar-palette').value = radarPalette;
    document.getElementById('radar-speed').value = String(radarAnimationSpeed);
    applyRadarPalette();
    document.getElementById('alert-severity').value = scene.alertSeverity;
    document.getElementById('camera-query').value = scene.cameraFilters.query;
    document.getElementById('camera-state').value = scene.cameraFilters.state;
    document.getElementById('camera-source').value = scene.cameraFilters.source;
    document.getElementById('camera-type').value = scene.cameraFilters.type;
    document.getElementById('camera-sort').value = scene.cameraFilters.sort;
    document.getElementById('camera-healthy').checked = scene.cameraFilters.healthy;
    document.getElementById('camera-favorites').checked = false;
    pendingSceneFrameTime = scene.radar.frameTime;
    pendingSceneCameraId = scene.activeCameraId;
    setSavedStateStatus(tr('views.sceneLoaded'));
  }

  function readStartupSharedScene() {
    try {
      return StormScopeSceneCodec.fromHash(location.hash);
    } catch (error) {
      startupSceneError = true;
      diagnostics.capture(error, 'scene-url');
      return null;
    }
  }

  function applyViewSnapshot(snapshot) {
    if (!snapshot) return;
    map.setView([snapshot.center.lat, snapshot.center.lon], snapshot.zoom, { animate: false });
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
    if (typeof layers.satellite === 'boolean') {
      document.getElementById('toggle-satellite').checked = layers.satellite;
      if (layers.satellite) refreshSatellite();
      else disableSatellite();
    }
    if (typeof layers.wildfires === 'boolean') {
      document.getElementById('toggle-wildfires').checked = layers.wildfires;
      if (layers.wildfires) refreshWildfires();
      else disableWildfires();
    }
    if (typeof layers.tropical === 'boolean') {
      document.getElementById('toggle-tropical').checked = layers.tropical;
      if (layers.tropical) refreshTropical();
      else disableTropical();
    }
    if (typeof layers.wpcOutlooks === 'boolean') {
      document.getElementById('toggle-wpc-outlooks').checked = layers.wpcOutlooks;
      if (layers.wpcOutlooks) refreshWpcOutlooks();
      else disableWpcOutlooks();
    }
    if (typeof layers.usgsGauges === 'boolean') {
      document.getElementById('toggle-usgs-gauges').checked = layers.usgsGauges;
      if (layers.usgsGauges) refreshUsgsGauges();
      else disableUsgsGauges();
    }
    if (snapshot.opacity && typeof snapshot.opacity.radar === 'number') {
      radarOpacity = snapshot.opacity.radar;
      document.getElementById('radar-opacity').value = String(Math.round(radarOpacity * 100));
      if (radarLayer) radarLayer.setOpacity(radarOpacity);
    }
    if (snapshot.dataMode) applyDataMode(snapshot.dataMode, true);
    if (snapshot.radar) {
      radarPalette = snapshot.radar.palette;
      preferredRadarAnimationSpeed = snapshot.radar.speed;
      radarAnimationSpeed = lowDataMode ? 0 : preferredRadarAnimationSpeed;
      document.getElementById('radar-palette').value = radarPalette;
      document.getElementById('radar-speed').value = String(radarAnimationSpeed);
      applyRadarPalette();
      try {
        localStorage.setItem('stormscope-radar-palette', radarPalette);
        localStorage.setItem('stormscope-radar-speed', String(preferredRadarAnimationSpeed));
      } catch (error) { /* optional */ }
    }
    if (snapshot.alertSeverity) {
      document.getElementById('alert-severity').value = snapshot.alertSeverity;
      renderAlerts();
    }
    if (snapshot.cameraFilters) {
      document.getElementById('camera-query').value = snapshot.cameraFilters.query;
      document.getElementById('camera-state').value = snapshot.cameraFilters.state;
      document.getElementById('camera-source').value = snapshot.cameraFilters.source;
      document.getElementById('camera-type').value = snapshot.cameraFilters.type;
      document.getElementById('camera-sort').value = snapshot.cameraFilters.sort;
      document.getElementById('camera-healthy').checked = snapshot.cameraFilters.healthy;
      document.getElementById('camera-favorites').checked = snapshot.cameraFilters.favorites;
    }
    if (snapshot.weatherUnits) {
      weatherUnits = snapshot.weatherUnits;
      document.getElementById('weather-units').value = weatherUnits;
      try { localStorage.setItem('stormscope-weather-units', weatherUnits); } catch (error) { /* optional */ }
      if (activeCamera) fetchWeather(activeCamera.lat, activeCamera.lon, activeCamera);
    }
    if (snapshot.outlookDay) {
      wpcOutlookDay = snapshot.outlookDay;
      document.getElementById('wpc-outlook-day').value = String(wpcOutlookDay);
      if (document.getElementById('toggle-wpc-outlooks').checked) refreshWpcOutlooks();
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
    var presets = document.createElement('optgroup');
    presets.label = tr('views.presets');
    Object.keys(WORKFLOW_PRESETS).forEach(function (key) {
      var option = document.createElement('option');
      option.value = 'preset:' + key;
      option.textContent = tr('views.preset.' + key);
      presets.appendChild(option);
    });
    select.appendChild(presets);
    savedStore.listViews().forEach(function (view) {
      var option = document.createElement('option');
      option.value = view.id;
      option.textContent = view.name;
      select.appendChild(option);
    });
    select.value = selectedId || '';
    var hasSelection = Boolean(select.value);
    document.getElementById('load-view').disabled = !hasSelection;
    document.getElementById('delete-view').disabled = !hasSelection || select.value.indexOf('preset:') === 0;
  }

  function scheduleLastViewSave() {
    if (!savedStore) return;
    clearTimeout(saveLastViewTimer);
    saveLastViewTimer = setTimeout(function () {
      try { savedStore.setLastView(captureViewSnapshot()); } catch (error) {
        setSavedStateStatus(tr('views.lastSaveError'), true);
      }
    }, 400);
  }

  function initSavedState(options) {
    options = options || {};
    savedStore = StormScopeSavedState.createStore();
    var storeStatus = savedStore.getStatus();
    refreshSavedViews();
    if (storeStatus.recoveredFromBackup) setSavedStateStatus(tr('views.recovered'));
    else if (storeStatus.loadError) setSavedStateStatus(tr('views.corrupt'), true);
    else if (!storeStatus.persistent) setSavedStateStatus(tr('views.sessionOnly'), true);
    if (options.restoreLastView !== false) applyViewSnapshot(savedStore.getLastView());
  }

  function showManualSceneLink(url) {
    var output = document.getElementById('scene-link-output');
    output.value = url;
    output.classList.remove('hidden');
    document.getElementById('scene-link-label').classList.remove('hidden');
    output.focus();
    output.select();
  }

  async function copySceneUrl(url) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(url);
        return true;
      } catch (error) { /* try the synchronous fallback */ }
    }
    showManualSceneLink(url);
    if (typeof document.execCommand === 'function' && document.execCommand('copy')) return true;
    return false;
  }

  async function copyCurrentScene() {
    try {
      var url = sharedSceneUrl();
      var copied = await copySceneUrl(url);
      setSavedStateStatus(tr(copied ? 'views.sceneCopied' : 'views.sceneCopyManual'), !copied);
      return copied;
    } catch (error) {
      setSavedStateStatus(tr('views.sceneCopyFailed'), true);
      return false;
    }
  }

  async function shareCurrentScene() {
    var url;
    try { url = sharedSceneUrl(); } catch (error) {
      setSavedStateStatus(tr('views.sceneShareFailed'), true);
      return;
    }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: tr('app.title'), text: tr('views.sceneShareText'), url: url });
        setSavedStateStatus(tr('views.sceneShared'));
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') {
          setSavedStateStatus(tr('views.sceneShareCanceled'));
          return;
        }
      }
    }
    var copied = await copySceneUrl(url);
    setSavedStateStatus(tr(copied ? 'views.sceneShareFallback' : 'views.sceneCopyManual'), !copied);
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
    if (!cameraDataTimestamp) {
      status.textContent = tr('camera.generationUnknown');
      if (offline) status.classList.add('offline');
      return;
    }
    var stale = cameraDataTimestamp && Date.now() - cameraDataTimestamp.getTime() > 24 * 60 * 60 * 1000;
    var timestamp = cameraDataTimestamp
      ? StormScopeI18n.formatDateTime(cameraDataTimestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, appLocale)
      : tr('weather.unknown');
    status.textContent = tr(offline ? 'camera.offlineCache' : stale ? 'camera.stale' : 'camera.fresh', { time: timestamp });
    if (offline) status.classList.add('offline');
    if (stale) status.classList.add('stale');
  }

  function cameraCountLabel() {
    var index = cameraLoadMetrics.index;
    if (!index) return tr('camera.count', { count: localNumber(allCameras.length) });
    return tr('camera.countSummary', {
      count: localNumber(index.total),
      healthy: localNumber(index.health_totals.healthy || 0),
      degraded: localNumber(index.health_totals.degraded || 0),
      unverified: localNumber(index.health_totals.unknown || 0)
    });
  }

  function refreshCameraLoadLabels() {
    if (cameraLoadMetrics.completeMs == null || !allCameras.length) return;
    document.getElementById('camera-count').textContent = cameraCountLabel();
    document.getElementById('search-progress').textContent = tr('camera.firstBatch', {
      count: localNumber(allCameras.length), milliseconds: localNumber(Math.round(cameraLoadMetrics.firstBatchMs || 0))
    });
  }

  function refreshCameraMarkerLabels() {
    allCameras.forEach(function (camera) {
      if (!camera._marker) return;
      var label = tr('camera.feedLabel', {
        name: camera.name,
        health: tr('camera.health.' + (camera.health || 'unknown'))
      });
      camera._marker.options.title = label;
      var element = camera._marker.getElement();
      if (element) {
        element.setAttribute('title', label);
        element.setAttribute('aria-label', label);
      }
    });
  }

  function updateConnectionState() {
    var status = document.getElementById('connection-state');
    status.textContent = tr(navigator.onLine ? 'connection.online' : 'connection.offline');
    status.classList.toggle('offline', !navigator.onLine);
    if (allCameras.length) updateDataFreshness(false);
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
    healthEl.removeAttribute('title');

    var providerFrameTime = cam.provider_timestamp || cam.provider_image_timestamp || cam.provider_record_time || cam.provider_updated;
    var observation = cam.local_observation;
    var observationText = tr('camera.provenance.unavailable');
    if (observation && observation.observed_at) {
      var outcomeKey = 'camera.observation.outcome.' + observation.outcome;
      var reasonKey = 'camera.observation.reason.' + observation.reason;
      observationText = tr('camera.provenance.observation', {
        outcome: tr(outcomeKey),
        time: localTime(observation.observed_at),
        reason: observation.reason ? tr(reasonKey) : tr('camera.provenance.notApplicable')
      });
    }

    var failureKey = cam.failure_class
      ? 'camera.failure.' + cam.failure_class
      : 'camera.provenance.notApplicable';
    var feedTypeKey = 'camera.feedType.' + (cam.type || 'unknown');
    var providerName = cam.provider || sourceLabel(cam.source);
    var cadence = Number(cam.refresh_cadence_seconds);

    document.getElementById('modal-provider-frame-time').textContent = providerFrameTime
      ? localTime(providerFrameTime)
      : tr('camera.provenance.unavailable');
    document.getElementById('modal-verification-time').textContent = cam.last_verified
      ? localTime(cam.last_verified)
      : tr('camera.provenance.unavailable');
    document.getElementById('modal-local-observation').textContent = observationText;
    document.getElementById('modal-provider').textContent = providerName;
    document.getElementById('modal-feed-type').textContent = tr(feedTypeKey);
    document.getElementById('modal-refresh-cadence').textContent = Number.isFinite(cadence) && cadence > 0
      ? tr('camera.provenance.cadenceSeconds', { count: localNumber(cadence) })
      : tr('camera.provenance.unavailable');
    document.getElementById('modal-degraded-reason').textContent = tr(failureKey);
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
      clearTimeout(timer);
      timer = null;
      image.removeAttribute('src');
    }
    function scheduleRefresh() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (!active) return;
        image.src = source();
        scheduleRefresh();
      }, imageRefreshInterval());
    }
    function resume() {
      if (active) return;
      active = true;
      image.src = refreshing ? source() : camera.url;
      if (refreshing) scheduleRefresh();
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
    iframe.src = youtubeEmbedUrl(camera.url, 'enablejsapi=1');
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

  function renderFeedError(cam, container, message, outcome, reason) {
    if (activeCamera !== cam) return;
    recordCameraObservation(cam, outcome || 'unavailable', reason || 'playback_error');
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
      recordCameraObservation(cam, 'retrying', 'manual_retry');
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
      recordCameraObservation(cam, 'retrying', 'manual_retry');
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
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          renderFeedError(cam, container, tr('feed.streamUnavailable'));
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = cam.url;
      video.addEventListener('error', function () {
        renderFeedError(cam, container, tr('feed.streamUnavailable'));
      }, { once: true });
    } else {
      renderFeedError(cam, container, tr('feed.hlsUnsupported'), OBSERVATION_UNSUPPORTED, REASON_BROWSER_HLS);
      return;
    }

    video.addEventListener('loadeddata', function () {
      if (activeCamera === cam) recordCameraObservation(cam, 'playable', 'decoded_media');
    }, { once: true });

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
      if (activeCamera === cam) recordCameraObservation(cam, 'playable', 'mjpeg_rendered');
    };

    activeFeedCleanup = function () {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    };
    container.replaceChildren(img);
    appendLiveIndicator(container, tr('camera.liveMjpeg'));
  }

  // YouTube's embedded player refuses to start with a "video player configuration
  // error" (error 153 / embedder.identity.missing.referrer) when the embedding page
  // sends no referrer. Send the origin and pass it as ?origin= so the player can
  // verify the embedder. Falls back gracefully on file:// (origin is "null").
  function youtubeEmbedUrl(videoId, extraParams) {
    var params = 'autoplay=1&mute=1&playsinline=1&rel=0';
    if (extraParams) params += '&' + extraParams;
    if (location.origin && location.origin !== 'null') {
      params += '&origin=' + encodeURIComponent(location.origin);
    }
    return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(videoId) + '?' + params;
  }

  function loadYouTubeFeed(cam, container) {
    var iframe = document.createElement('iframe');
    var sourceUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(cam.url);
    iframe.src = youtubeEmbedUrl(cam.url);
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.cssText = 'min-height:400px;border:none;';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.title = cam.name;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';

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
      renderFeedError(cam, container, tr('feed.untrusted'), OBSERVATION_UNSUPPORTED, REASON_UNTRUSTED_EMBED);
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
    var successfulLoads = 0;

    function setImageSrc() {
      img.src = cam.url + (cam.url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
    }

    img.onerror = function () {
      if (activeCamera === cam) {
        renderFeedError(cam, container, tr('feed.imageUnavailable'));
      }
    };

    img.onload = function () {
      successfulLoads += 1;
      if (activeCamera === cam) {
        recordCameraObservation(
          cam,
          successfulLoads >= 2 ? 'playable' : 'loaded',
          successfulLoads >= 2 ? 'refresh_advanced' : 'initial_image'
        );
      }
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
    appendLiveIndicator(container, tr('camera.autoRefresh', { seconds: localNumber(imageRefreshInterval() / 1000) }));

    function scheduleImageRefresh() {
      clearTimeout(imageRefreshTimer);
      imageRefreshTimer = setTimeout(function () {
        if (activeCamera !== cam) return;
        setImageSrc();
        scheduleImageRefresh();
      }, imageRefreshInterval());
    }
    scheduleImageRefresh();
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

  function localizedWindDirection(value) {
    var dirs = ['n', 'nne', 'ne', 'ene', 'e', 'ese', 'se', 'sse',
                's', 'ssw', 'sw', 'wsw', 'w', 'wnw', 'nw', 'nnw'];
    var key = typeof value === 'number'
      ? dirs[(Math.round(value / 22.5) % 16 + 16) % 16]
      : String(value || '').trim().toLowerCase();
    return dirs.indexOf(key) === -1 ? tr('weather.unknown') : tr('direction.' + key);
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
    var properties = pointData.properties || {};
    var results = await Promise.allSettled([
      fetchNwsForecast(properties.forecastHourly, signal),
      fetchNwsObservation(properties.observationStations, lat, lon, signal)
    ]);
    var forecast = results[0].status === 'fulfilled' ? results[0].value : null;
    var observation = results[1].status === 'fulfilled' ? results[1].value : null;
    if (!forecast && !observation) throw results[0].reason || results[1].reason || new Error('NWS weather unavailable');
    if (activeCamera !== cam) return;
    var sections = [];
    if (observation) sections.push({ heading: tr('weather.observationHeading'), items: nwsObservationItems(observation) });
    else sections.push({ heading: tr('weather.observationHeading'), status: tr('weather.observationUnavailable') });
    if (forecast) sections.push({ heading: tr('weather.forecastHeading'), items: nwsForecastItems(forecast) });
    else sections.push({ heading: tr('weather.forecastHeading'), status: tr('weather.forecastUnavailable') });
    showWeatherSections(weatherLoading, weatherData, sections);
  }

  async function fetchNwsJson(url, signal, label) {
    var trustedUrl = StormScopeWeather.trustedNwsUrl(url);
    if (!trustedUrl) throw new Error('Untrusted NWS ' + label + ' URL');
    var response = await fetch(trustedUrl, { headers: { Accept: 'application/geo+json' }, signal: signal });
    if (!response.ok) throw new Error('NWS ' + label + ' failed');
    return response.json();
  }

  async function fetchNwsForecast(url, signal) {
    var data = await fetchNwsJson(url, signal, 'forecast');
    var periods = data.properties && data.properties.periods;
    if (!periods || !periods.length) throw new Error('No forecast periods');
    return { period: periods[0], updatedAt: data.properties.updateTime };
  }

  async function fetchNwsObservation(stationsUrl, lat, lon, signal) {
    var stationCollectionUrl = StormScopeWeather.trustedNwsUrl(stationsUrl);
    if (!stationCollectionUrl) throw new Error('Untrusted NWS stations URL');
    var stationParams = new URL(stationCollectionUrl);
    stationParams.searchParams.set('limit', '5');
    var collection = await fetchNwsJson(stationParams.toString(), signal, 'stations');
    var stations = StormScopeWeather.rankObservationStations(collection, { lat: lat, lon: lon }, 5);
    if (!stations.length) throw new Error('No observation stations');
    for (var index = 0; index < stations.length; index++) {
      try {
        var payload = await fetchNwsJson(stations[index].url + '/observations/latest?require_qc=true', signal, 'observation');
        var observation = StormScopeWeather.normalizeNwsObservation(payload, stations[index]);
        if (observation) return observation;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
      }
    }
    throw new Error('No valid station observation');
  }

  function nwsObservationItems(observation) {
    var ageMinutes = (Date.now() - new Date(observation.timestamp).getTime()) / 60000;
    var station = observation.station;
    var stationLabel = (station.name ? station.name + ' (' + station.id + ')' : station.id) +
      ' • ' + tr('weather.distanceAway', {
        distance: StormScopeWeather.distanceFromKm(station.distanceKm, weatherUnits) || tr('weather.unknown')
      });
    var wind = StormScopeWeather.windFromKmh(observation.windKmh, weatherUnits);
    if (wind && observation.windDirection !== null) wind += ' ' + localizedWindDirection(observation.windDirection);
    return [
      [tr('weather.temperature'), StormScopeWeather.temperatureFromCelsius(observation.temperatureC, weatherUnits) || tr('weather.notAvailable')],
      [tr('weather.conditionsProvider'), observation.conditions || tr('weather.notAvailable')],
      [tr('weather.wind'), wind || tr('weather.notAvailable')],
      [tr('weather.humidity'), observation.humidity !== null ? localNumber(Math.round(observation.humidity)) + '%' : tr('weather.notAvailable')],
      [tr('weather.observed'), localTime(observation.timestamp) + ' • ' + StormScopeI18n.formatAge(ageMinutes, appLocale)],
      [tr('weather.station'), stationLabel],
      [tr('weather.source'), tr('weather.nwsObservation')]
    ];
  }

  function nwsForecastItems(forecast) {
    var current = forecast.period;
    var temperature = current.temperatureUnit === 'F'
      ? StormScopeWeather.temperatureFromFahrenheit(current.temperature, weatherUnits)
      : Math.round(current.temperature) + '°' + current.temperatureUnit;
    return [
      [tr('weather.temperature'), temperature],
      [tr('weather.conditionsProvider'), current.shortForecast],
      [tr('weather.wind'), StormScopeWeather.windFromMph(current.windSpeed, weatherUnits) + ' ' + localizedWindDirection(current.windDirection)],
      [tr('weather.humidity'), current.relativeHumidity && current.relativeHumidity.value != null
        ? localNumber(current.relativeHumidity.value) + '%' : tr('weather.notAvailable')],
      [tr('weather.forecastIssued'), localTime(forecast.updatedAt)],
      [tr('weather.forecastValid'), localTime(current.startTime)],
      [tr('weather.source'), tr('weather.nwsForecast')]
    ];
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
      var windDir = localizedWindDirection(c.wind_direction_10m || 0);

      showWeatherItems(weatherLoading, weatherData, [
        [tr('weather.temperature'), localNumber(Math.round(c.temperature_2m)) + (metric ? '°C' : '°F')],
        [tr('weather.conditions'), condition],
        [tr('weather.wind'), localNumber(Math.round(c.wind_speed_10m)) + (metric ? ' km/h ' : ' mph ') + windDir],
        [tr('weather.humidity'), c.relative_humidity_2m != null ? localNumber(c.relative_humidity_2m) + '%' : tr('weather.notAvailable')],
        [tr('weather.observed'), StormScopeWeather.formatOpenMeteoTime(c.time, data.utc_offset_seconds, appLocale, tr('weather.unknown'))],
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
    dataEl.classList.add('weather-data-flat');
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

  function showWeatherSections(loadingEl, dataEl, sections) {
    dataEl.replaceChildren();
    dataEl.classList.remove('weather-data-flat');
    sections.forEach(function (section) {
      var container = document.createElement('section');
      container.className = 'weather-section';
      var heading = document.createElement('h4');
      heading.textContent = section.heading;
      container.appendChild(heading);
      if (section.status) {
        var status = document.createElement('p');
        status.className = 'weather-section-status';
        status.textContent = section.status;
        container.appendChild(status);
      } else {
        var grid = document.createElement('div');
        grid.className = 'weather-section-grid';
        section.items.forEach(function (row) {
          var item = document.createElement('div');
          item.className = 'weather-item';
          var label = document.createElement('span');
          label.className = 'weather-label';
          label.textContent = row[0];
          var value = document.createElement('span');
          value.className = 'weather-value';
          value.textContent = row[1];
          item.appendChild(label);
          item.appendChild(value);
          grid.appendChild(item);
        });
        container.appendChild(grid);
      }
      dataEl.appendChild(container);
    });
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
      title.textContent = alert.event || tr('alerts.weatherAlert');
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

  function showAlertDetail(alert, focus, trigger, fitMap) {
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
    heading.textContent = alert.headline || tr('alerts.weatherAlert');
    detail.appendChild(heading);
    var providerLabel = document.createElement('p');
    providerLabel.className = 'provider-content-label';
    providerLabel.textContent = tr('alerts.providerContent');
    detail.appendChild(providerLabel);
    [
      [tr('alerts.area'), alert.areaDescription],
      [tr('alerts.effective'), localTime(alert.effective)],
      [tr('alerts.expires'), localTime(alert.expires)],
      [tr('alerts.severity'), tr('severity.' + String(alert.severity || 'unknown').toLowerCase()) + ' • ' +
        tr('urgency.' + String(alert.urgency || 'unknown').toLowerCase()) + ' • ' +
        tr('certainty.' + String(alert.certainty || 'unknown').toLowerCase())],
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
    appendNearbyCameraSection(detail, alert.geometry, tr('incident.camerasNearAlert'));
    detail.classList.remove('hidden');
    if (focus) detail.focus();
    if (focus && fitMap !== false && alertLayersById[alert.id]) {
      var bounds = alertLayersById[alert.id].getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 9, animate: false });
    }
  }

  function appendSituationSection(container, headingText, bodyText) {
    var section = document.createElement('section');
    section.className = 'situation-section';
    var heading = document.createElement('h3');
    heading.textContent = headingText;
    var body = document.createElement('p');
    body.textContent = bodyText;
    section.appendChild(heading);
    section.appendChild(body);
    container.appendChild(section);
    return section;
  }

  function situationCoordinate(value, positiveKey, negativeKey) {
    return tr('summary.coordinate', {
      value: StormScopeI18n.formatNumber(Math.abs(value), {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      }, appLocale),
      direction: tr(value >= 0 ? positiveKey : negativeKey)
    });
  }

  function situationRadarText() {
    if (!radarFrames.length || !radarSemanticState) return tr('summary.radarPending');
    var frame = radarFrames[radarIndex];
    var age = StormScopeRadarProviders.getFrameAge(frame, radarProviderId);
    var provider = StormScopeRadarProviders.providers[radarProviderId];
    var stateKey = {
      clear: 'summary.radarClear',
      precipitation: 'summary.radarPrecipitation',
      'no-coverage': 'summary.radarNoCoverage',
      stale: 'summary.radarStale',
      failure: 'summary.radarFailure',
      available: 'summary.radarAvailable'
    }[radarSemanticState.state] || 'summary.radarAvailable';
    return tr(stateKey, {
      age: StormScopeI18n.formatAge(age.ageMinutes, appLocale),
      source: provider ? provider.label : tr('weather.unknown'),
      intensity: tr('radar.intensity.' + (radarSemanticState.intensity || 'unknown'))
    });
  }

  function openAlertsFromSummary() {
    closeOpenPanel('situation-panel', 'btn-summary');
    document.getElementById('search-panel').classList.add('hidden');
    document.getElementById('btn-search').setAttribute('aria-expanded', 'false');
    document.getElementById('layers-panel').classList.add('hidden');
    document.getElementById('btn-layers').setAttribute('aria-expanded', 'false');
    var panel = document.getElementById('alerts-panel');
    panel.classList.remove('hidden');
    var first = panel.querySelector('.alert-list-button');
    if (first) first.focus();
  }

  function readAlertFromSummary(alert) {
    document.getElementById('situation-panel').classList.add('hidden');
    document.getElementById('btn-summary').setAttribute('aria-expanded', 'false');
    document.getElementById('alerts-panel').classList.remove('hidden');
    showAlertDetail(alert, true, document.getElementById('btn-summary'), false);
  }

  async function refreshSituationWildfires() {
    var bounds = currentWildfireBounds();
    var boundsKey = wildfireBoundsKey(bounds);
    var provider = StormScopeContextLayers.providers.wildfires;
    if (summaryWildfireStatus === 'loading' && summaryWildfireBoundsKey === boundsKey) return;
    if (summaryWildfireStatus === 'ready' && summaryWildfireBoundsKey === boundsKey &&
        Date.now() - summaryWildfireFetchedAt < provider.refreshMs) return;
    if (summaryWildfireAbort) summaryWildfireAbort.abort();
    summaryWildfireAbort = new AbortController();
    var signal = summaryWildfireAbort.signal;
    summaryWildfireStatus = 'loading';
    summaryWildfireBoundsKey = boundsKey;
    try {
      var snapshot = await fetchWildfireSnapshot(bounds, signal);
      summaryWildfireStatus = 'ready';
      summaryWildfireCount = snapshot.collection.features.length;
      summaryWildfireUpdatedAt = snapshot.metadata.updatedAt;
      summaryWildfireFetchedAt = Date.now();
    } catch (error) {
      if (error.name === 'AbortError') return;
      summaryWildfireStatus = 'error';
    } finally {
      if (summaryWildfireAbort && summaryWildfireAbort.signal === signal) summaryWildfireAbort = null;
      if (!document.getElementById('situation-panel').classList.contains('hidden')) renderSituationSummary(false);
    }
  }

  function renderSituationSummary(announce) {
    var content = document.getElementById('situation-content');
    content.replaceChildren();
    var center = map.getCenter();
    appendSituationSection(content, tr('summary.mapHeading'), tr('summary.mapPosition', {
      lat: situationCoordinate(center.lat, 'summary.north', 'summary.south'),
      lon: situationCoordinate(center.lng, 'summary.east', 'summary.west'),
      zoom: localNumber(map.getZoom())
    }));
    appendSituationSection(content, tr('summary.radarHeading'), situationRadarText());

    var wildfireText = summaryWildfireStatus === 'ready' ? tr('summary.wildfireCount', {
      count: localNumber(summaryWildfireCount),
      age: StormScopeI18n.formatAge((Date.now() - summaryWildfireUpdatedAt) / 60000, appLocale)
    }) : summaryWildfireStatus === 'error' ? tr('summary.wildfiresUnavailable') : tr('summary.wildfiresLoading');
    var warningCount = activeAlerts.filter(function (alert) { return alert.kind === 'warning'; }).length;
    var hazards = appendSituationSection(content, tr('summary.hazardsHeading'), tr('summary.hazardCounts', {
      alerts: localNumber(activeAlerts.length), warnings: localNumber(warningCount), wildfires: wildfireText
    }));
    if (activeAlerts.length) {
      hazards.appendChild(incidentCameraButton(tr('summary.reviewAlerts'), 'summary-review-alerts', openAlertsFromSummary));
      var alertList = document.createElement('ul');
      activeAlerts.slice(0, 3).forEach(function (alert) {
        var item = document.createElement('li');
        var label = document.createElement('span');
        label.textContent = tr('summary.alertLine', {
          event: alert.event || tr('alerts.weatherAlert'),
          severity: tr('severity.' + String(alert.severity || 'unknown').toLowerCase())
        });
        item.appendChild(label);
        item.appendChild(incidentCameraButton(tr('summary.readAlert'), 'summary-read-alert', function () {
          readAlertFromSummary(alert);
        }));
        alertList.appendChild(item);
      });
      hazards.appendChild(alertList);
    }

    var cameras = appendSituationSection(content, tr('summary.camerasHeading'), '');
    var cameraStatus = cameras.querySelector('p');
    if (cameraCatalogDeferred) {
      cameraStatus.textContent = tr('summary.camerasDeferred');
    } else if (cameraLoadMetrics.completeMs == null) {
      cameraStatus.textContent = tr('summary.camerasLoading');
    } else {
      var nearby = StormScopeCameraStore.nearestVerifiedCameras(allCameras, {
        lat: center.lat, lon: center.lng
      }, 5);
      if (!nearby.length) {
        cameraStatus.textContent = tr('summary.noVerifiedCameras');
      } else {
        cameraStatus.textContent = tr(nearby.length === 1 ? 'summary.cameraCountOne' : 'summary.cameraCountMany', {
          count: localNumber(nearby.length)
        });
        var list = document.createElement('ul');
        nearby.forEach(function (result) {
          var item = document.createElement('li');
          var label = document.createElement('span');
          label.textContent = tr('summary.cameraLine', {
            name: result.camera.name,
            distance: StormScopeWeather.distanceFromKm(result.distanceKm, weatherUnits),
            bearing: localizedWindDirection(result.bearing)
          });
          item.appendChild(label);
          item.appendChild(incidentCameraButton(tr('incident.openCamera'), 'summary-open-camera', function () {
            openCameraModal(result.camera);
          }));
          list.appendChild(item);
        });
        cameras.appendChild(list);
      }
    }
    document.getElementById('situation-updated').textContent = tr('summary.updated', { time: localTime(Date.now()) });
    if (announce) document.getElementById('situation-announcer').textContent = tr('summary.announced');
    if (summaryWildfireStatus !== 'loading' && summaryWildfireStatus !== 'error') refreshSituationWildfires();
  }

  function toggleSituationSummary() {
    var panel = document.getElementById('situation-panel');
    var opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    document.getElementById('btn-summary').setAttribute('aria-expanded', String(opening));
    if (!opening) return;
    if (summaryWildfireStatus === 'error') summaryWildfireStatus = 'idle';
    document.getElementById('search-panel').classList.add('hidden');
    document.getElementById('btn-search').setAttribute('aria-expanded', 'false');
    document.getElementById('layers-panel').classList.add('hidden');
    document.getElementById('btn-layers').setAttribute('aria-expanded', 'false');
    document.getElementById('alerts-panel').classList.add('hidden');
    renderSituationSummary(true);
    document.getElementById('situation-heading').focus({ preventScroll: true });
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
    document.getElementById('btn-summary').addEventListener('click', toggleSituationSummary);
    document.getElementById('close-summary').addEventListener('click', function () {
      closeOpenPanel('situation-panel', 'btn-summary');
    });
    document.getElementById('refresh-summary').addEventListener('click', function () {
      if (summaryWildfireStatus === 'error') summaryWildfireStatus = 'idle';
      renderSituationSummary(true);
    });
    document.getElementById('btn-search').addEventListener('click', function () {
      document.getElementById('situation-panel').classList.add('hidden');
      document.getElementById('btn-summary').setAttribute('aria-expanded', 'false');
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
      document.getElementById('situation-panel').classList.add('hidden');
      document.getElementById('btn-summary').setAttribute('aria-expanded', 'false');
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

    document.getElementById('toggle-satellite').addEventListener('change', function () {
      if (this.checked) refreshSatellite();
      else disableSatellite();
      scheduleLastViewSave();
    });

    document.getElementById('toggle-wildfires').addEventListener('change', function () {
      if (this.checked) refreshWildfires();
      else disableWildfires();
      scheduleLastViewSave();
    });

    document.getElementById('toggle-tropical').addEventListener('change', function () {
      if (this.checked) refreshTropical();
      else disableTropical();
      scheduleLastViewSave();
    });

    document.getElementById('toggle-wpc-outlooks').addEventListener('change', function () {
      if (this.checked) refreshWpcOutlooks();
      else disableWpcOutlooks();
      scheduleLastViewSave();
    });
    document.getElementById('wpc-outlook-day').addEventListener('change', function () {
      wpcOutlookDay = Number(this.value);
      if (document.getElementById('toggle-wpc-outlooks').checked) refreshWpcOutlooks();
      scheduleLastViewSave();
    });
    document.getElementById('toggle-usgs-gauges').addEventListener('change', function () {
      if (this.checked) refreshUsgsGauges();
      else disableUsgsGauges();
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
    document.getElementById('app-theme').addEventListener('change', function () {
      applyTheme(this.value);
      try { localStorage.setItem('stormscope-theme', themePreference); } catch (error) { /* optional */ }
    });
    document.getElementById('app-locale').addEventListener('change', function () {
      appLocale = StormScopeI18n.setLocale(this.value);
      try { localStorage.setItem(StormScopeI18n.STORAGE_KEY, appLocale); } catch (error) { /* optional */ }
      StormScopeI18n.localizeDocument(document);
      updateConnectionState();
      updateRadarScrubber();
      applyRadarPalette();
      updateLowDataUi();
      refreshInstallDiscovery();
      if (radarFrames.length) updateRadarTimeDisplay();
      if (cameraDataTimestamp) updateDataFreshness();
      refreshCameraLoadLabels();
      refreshCameraMarkerLabels();
      refreshSavedViews(document.getElementById('saved-views').value);
      updateMonitorSelectionUi();
      scheduleSearchRender();
      renderAlerts();
      renderLightningStatus();
      renderSatelliteStatus();
      renderWildfireStatus();
      renderTropicalStatus();
      renderWpcStatus();
      renderGaugeStatus();
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
      preferredRadarAnimationSpeed = radarAnimationSpeed;
      try { localStorage.setItem('stormscope-radar-speed', String(radarAnimationSpeed)); } catch (error) { /* optional */ }
      setRadarPlaying(wasPlaying && radarAnimationSpeed > 0);
      if (radarFrames.length) updateRadarTimeDisplay();
    });
    document.getElementById('data-mode').addEventListener('change', function () {
      applyDataMode(this.value, true);
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
    document.getElementById('load-camera-catalog').addEventListener('click', resumeCameraCatalog);
    document.getElementById('monitor-close').addEventListener('click', function () { closeMonitor(true); });
    document.querySelector('.monitor-backdrop').addEventListener('click', function () { closeMonitor(true); });

    ['camera-query', 'camera-state'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', function () { scheduleSearchRender(true); });
    });
    ['camera-source', 'camera-type', 'camera-sort', 'camera-healthy', 'camera-favorites'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', function () { scheduleSearchRender(true); });
    });
    document.getElementById('camera-results-scroll').addEventListener('scroll', function () {
      if (suppressNextCameraResultScroll) {
        suppressNextCameraResultScroll = false;
        return;
      }
      scheduleSearchWindowRender();
    }, { passive: true });
    document.getElementById('camera-results-scroll').addEventListener('keydown', handleCameraResultNavigation);
    document.getElementById('camera-results-scroll').addEventListener('pointerdown', function () {
      cameraResultKeyboardMode = false;
    });

    document.getElementById('saved-views').addEventListener('change', function () {
      var hasSelection = Boolean(this.value);
      document.getElementById('load-view').disabled = !hasSelection;
      var preset = this.value.indexOf('preset:') === 0;
      document.getElementById('delete-view').disabled = !hasSelection || preset;
      if (hasSelection && !preset) document.getElementById('view-name').value = savedStore.getView(this.value).name;
    });
    document.getElementById('save-view').addEventListener('click', function () {
      try {
        var nameInput = document.getElementById('view-name');
        var state = savedStore.saveView(nameInput.value, captureViewSnapshot(true));
        var normalizedName = nameInput.value.trim().toLowerCase();
        var saved = state.views.find(function (view) { return view.name.toLowerCase() === normalizedName; });
        refreshSavedViews(saved && saved.id);
        setSavedStateStatus(tr('views.savedStatus'));
      } catch (error) {
        setSavedStateStatus(tr('views.saveError'), true);
      }
    });
    document.getElementById('load-view').addEventListener('click', function () {
      var selected = document.getElementById('saved-views').value;
      if (selected.indexOf('preset:') === 0) {
        var presetKey = selected.slice(7);
        var center = map.getCenter();
        var preset = JSON.parse(JSON.stringify(WORKFLOW_PRESETS[presetKey]));
        preset.center = { lat: center.lat, lon: center.lng };
        preset.zoom = map.getZoom();
        preset.weatherUnits = weatherUnits;
        applyViewSnapshot(preset);
        scheduleSearchRender();
        scheduleLastViewSave();
        setSavedStateStatus(tr('views.loaded', { name: tr('views.preset.' + presetKey) }));
        return;
      }
      var view = savedStore.getView(selected);
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
          setSavedStateStatus(tr('views.importRejected'), true);
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
    document.getElementById('import-local-overlay').addEventListener('click', function () {
      document.getElementById('local-overlay-file').click();
    });
    document.getElementById('local-overlay-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      importLocalOverlay(file);
    });
    document.getElementById('export-local-overlays').addEventListener('click', function () {
      try {
        downloadLocalOverlay('stormscope-local-overlays.json',
          StormScopeLocalOverlays.exportBundle(localOverlayRecords), 'application/json');
        setLocalOverlayStatus('overlays.exportedAll');
      } catch (error) { setLocalOverlayStatus('overlays.error.export', null, true); }
    });
    document.getElementById('clear-local-overlays').addEventListener('click', function () {
      localOverlayRecords.forEach(function (record) { if (record.layer) map.removeLayer(record.layer); });
      localOverlayRecords = [];
      var clear = localOverlayDatabase
        ? overlayTransaction('readwrite', function (store) { return store.clear(); }) : Promise.resolve();
      clear.catch(function () { setLocalOverlayStatus('overlays.error.storage', null, true); });
      renderLocalOverlayList();
      setLocalOverlayStatus('overlays.cleared');
    });
    document.getElementById('copy-scene').addEventListener('click', function () { copyCurrentScene(); });
    document.getElementById('share-scene').addEventListener('click', function () { shareCurrentScene(); });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (activeCamera) { closeCameraModal(); return; }
      if (!document.getElementById('monitor-modal').classList.contains('hidden')) { closeMonitor(true); return; }
      if (closeOpenPanel('situation-panel', 'btn-summary')) return;
      if (hideAlertDetail()) return;
      if (closeOpenPanel('search-panel', 'btn-search')) return;
      closeOpenPanel('layers-panel', 'btn-layers');
    });

    map.on('click', function () {
      document.getElementById('situation-panel').classList.add('hidden');
      document.getElementById('btn-summary').setAttribute('aria-expanded', 'false');
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
      if (document.getElementById('toggle-satellite').checked) {
        clearTimeout(satelliteMoveTimer);
        satelliteMoveTimer = setTimeout(refreshSatellite, 900);
      }
      if (document.getElementById('toggle-usgs-gauges').checked) {
        clearTimeout(usgsGaugeMoveTimer);
        usgsGaugeMoveTimer = setTimeout(refreshUsgsGauges, 900);
      }
      if (document.getElementById('camera-sort').value === 'distance') scheduleSearchRender();
      scheduleLastViewSave();
    });
  }

  function registerServiceWorker() {
    var status = document.getElementById('cache-status');
    var clearButton = document.getElementById('clear-cache');
    var keepButton = document.getElementById('keep-offline-data');
    var updateNotice = document.getElementById('update-notice');
    var applyUpdate = document.getElementById('apply-update');

    function cacheOperationError(code) {
      if (code === 'not-active') return tr('cache.notActive');
      if (code === 'no-response') return tr('cache.noResponse');
      if (code === 'quota-exceeded') return tr('cache.full');
      if (code === 'write-failed') return tr('cache.writeFailed');
      return tr('cache.operationFailed');
    }

    function cacheError(code) {
      var error = new Error(code);
      error.code = code;
      return error;
    }
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
      if (!worker) return Promise.reject(cacheError('not-active'));
      return new Promise(function (resolve, reject) {
        var channel = new MessageChannel();
        var timeout = setTimeout(function () { reject(cacheError('no-response')); }, 4000);
        channel.port1.onmessage = function (event) {
          clearTimeout(timeout);
          resolve(event.data || {});
        };
        worker.postMessage({ type: type }, [channel.port2]);
      });
    }

    async function refreshUsage(registration, outcome) {
      var usage = await requestWorker(registration, 'STORMSCOPE_GET_CACHE_USAGE');
      var storage = navigator.storage || null;
      var estimate = storage && storage.estimate
        ? await storage.estimate().catch(function () { return {}; })
        : {};
      var persisted = storage && storage.persisted
        ? await storage.persisted().catch(function () { return false; })
        : null;
      var originUsage = Number(estimate.usage || usage.originUsage || 0);
      var originQuota = Number(estimate.quota || usage.originQuota || 0);
      var percent = originQuota > 0 ? Math.min(100, originUsage / originQuota * 100) : 0;
      var durability = persisted === true ? tr('cache.persistent')
        : persisted === false ? tr('cache.bestEffort') : tr('cache.persistenceUnsupported');
      status.classList.remove('error');
      status.textContent = tr('cache.usageDetailed', {
        cacheBytes: formatBytes(usage.bytes), count: localNumber(usage.entries || 0),
        usage: formatBytes(originUsage), quota: formatBytes(originQuota),
        percent: StormScopeI18n.formatNumber(percent, { maximumFractionDigits: 1 }, appLocale),
        durability: durability
      }) + (outcome ? ' · ' + tr(outcome) : '');
      keepButton.disabled = persisted === true || !storage || typeof storage.persist !== 'function';
      clearButton.disabled = false;
      return { persisted: persisted, usage: originUsage, quota: originQuota };
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
          keepButton.addEventListener('click', function () {
            if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
              keepButton.disabled = true;
              status.textContent = tr('cache.persistenceUnsupported');
              return;
            }
            keepButton.disabled = true;
            status.textContent = tr('cache.persistenceRequesting');
            navigator.storage.persist().then(function (granted) {
              return refreshUsage(registration, granted ? 'cache.persistenceGranted' : 'cache.persistenceDenied');
            }).catch(function () {
              return refreshUsage(registration, 'cache.persistenceFailed');
            });
          });
          clearButton.addEventListener('click', function () {
            clearButton.disabled = true;
            status.classList.remove('error');
            status.textContent = tr('cache.clearing');
            requestWorker(registration, 'STORMSCOPE_CLEAR_CACHES').then(function () {
              return refreshUsage(registration);
            }).catch(function (error) {
              setCacheError(cacheOperationError(error.code));
              clearButton.disabled = false;
            });
          });
          return refreshUsage(registration);
        });
      }).catch(function (error) {
        setCacheError(tr('cache.unavailableGeneric'));
      });
    });
  }

  function initInstallDiscovery() {
    var status = document.getElementById('install-status');
    var button = document.getElementById('install-app');
    var installPrompt = null;
    var installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    var ios = (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) && !window.MSStream;

    function render() {
      button.classList.toggle('hidden', !installPrompt || installed);
      if (installed) status.textContent = tr('install.installed');
      else if (installPrompt) status.textContent = tr('install.ready');
      else status.textContent = tr(ios ? 'install.ios' : 'install.menu');
    }

    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      installPrompt = event;
      render();
    });
    window.addEventListener('appinstalled', function () {
      installed = true;
      installPrompt = null;
      render();
    });
    button.addEventListener('click', async function () {
      if (!installPrompt) return;
      var prompt = installPrompt;
      installPrompt = null;
      button.classList.add('hidden');
      try {
        await prompt.prompt();
        var choice = await prompt.userChoice;
        status.textContent = tr(choice && choice.outcome === 'accepted' ? 'install.accepted' : 'install.dismissed');
      } catch (error) {
        status.textContent = tr('install.menu');
      }
    });
    refreshInstallDiscovery = render;
    render();
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
        if (satelliteAbort) satelliteAbort.abort();
        if (tropicalAbort) tropicalAbort.abort();
        if (wpcEroAbort) wpcEroAbort.abort();
        if (wpcFloodAbort) wpcFloodAbort.abort();
        if (usgsGaugeAbort) usgsGaugeAbort.abort();
        if (wildfireAbort) wildfireAbort.abort();
        clearTimeout(alertRefreshTimer);
        clearTimeout(lightningRefreshTimer);
        clearTimeout(satelliteRefreshTimer);
        clearTimeout(satelliteMoveTimer);
        clearTimeout(tropicalRefreshTimer);
        clearTimeout(wpcRefreshTimer);
        clearTimeout(usgsGaugeRefreshTimer);
        clearTimeout(usgsGaugeMoveTimer);
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
      if (document.getElementById('toggle-satellite').checked) refreshSatellite();
      if (document.getElementById('toggle-tropical').checked) refreshTropical();
      if (document.getElementById('toggle-wpc-outlooks').checked) refreshWpcOutlooks();
      if (document.getElementById('toggle-usgs-gauges').checked) refreshUsgsGauges();
      if (document.getElementById('toggle-wildfires').checked) refreshWildfires();
    });

    window.addEventListener('online', function () {
      updateConnectionState();
      initRadar();
      if (document.getElementById('toggle-lightning').checked) refreshLightning();
      if (document.getElementById('toggle-satellite').checked) refreshSatellite();
      if (document.getElementById('toggle-tropical').checked) refreshTropical();
      if (document.getElementById('toggle-wpc-outlooks').checked) refreshWpcOutlooks();
      if (document.getElementById('toggle-usgs-gauges').checked) refreshUsgsGauges();
      if (document.getElementById('toggle-wildfires').checked) refreshWildfires();
    });
    window.addEventListener('offline', updateConnectionState);
    window.addEventListener('beforeunload', function () {
      clearInterval(radarRefreshTimer);
      clearTimeout(radarPreloadTimer);
      clearTimeout(alertRefreshTimer);
      clearTimeout(alertMoveTimer);
      clearTimeout(lightningRefreshTimer);
      clearTimeout(satelliteRefreshTimer);
      clearTimeout(satelliteMoveTimer);
      clearTimeout(tropicalRefreshTimer);
      clearTimeout(wpcRefreshTimer);
      clearTimeout(usgsGaugeRefreshTimer);
      clearTimeout(usgsGaugeMoveTimer);
      clearTimeout(wildfireRefreshTimer);
      clearTimeout(wildfireMoveTimer);
      setRadarPlaying(false);
      if (radarAbort) radarAbort.abort();
      if (weatherAbort) weatherAbort.abort();
      if (alertAbort) alertAbort.abort();
      if (lightningAbort) lightningAbort.abort();
      if (satelliteAbort) satelliteAbort.abort();
      if (tropicalAbort) tropicalAbort.abort();
      if (wpcEroAbort) wpcEroAbort.abort();
      if (wpcFloodAbort) wpcFloodAbort.abort();
      if (usgsGaugeAbort) usgsGaugeAbort.abort();
      if (wildfireAbort) wildfireAbort.abort();
      if (summaryWildfireAbort) summaryWildfireAbort.abort();
      if (cameraStore) cameraStore.cancel();
      if (monitorRegistry) monitorRegistry.destroyAll();
      if (localOverlayDatabase) localOverlayDatabase.close();
      clearTimeout(saveLastViewTimer);
      destroyActiveFeed(document.getElementById('modal-feed'));
    });
  }

  function showFatalRecovery() {
    var banner = document.getElementById('fatal-recovery');
    document.getElementById('fatal-recovery-message').textContent = tr('diagnostics.fatal');
    banner.classList.remove('hidden');
  }

  async function cacheDiagnosticSummary() {
    var names = typeof caches === 'undefined' ? [] : await caches.keys();
    var counts = await Promise.all(names.filter(function (name) {
      return name.indexOf('stormscope-') === 0;
    }).map(function (name) {
      return caches.open(name).then(function (cache) { return cache.keys(); }).then(function (keys) {
        return { category: name.replace(/-v\d+$/, ''), entries: keys.length };
      });
    }));
    var estimate = navigator.storage && navigator.storage.estimate
      ? await navigator.storage.estimate().catch(function () { return {}; })
      : {};
    return { caches: counts, usage: estimate.usage || null, quota: estimate.quota || null };
  }

  async function exportDiagnostics() {
    var report = diagnostics.report({
      appVersion: APP_VERSION,
      corpusGeneration: cameraLoadMetrics.index && cameraLoadMetrics.index.generated_at,
      providers: {
        radar: radarProviderId,
        radarStatus: radarProviderSelection && radarProviderSelection.degradationReason || 'ready',
        alerts: { status: activeAlerts.length ? 'ready' : 'none', count: activeAlerts.length },
        lightning: lightningStatusState,
        wildfires: wildfireStatusState,
        tropical: { status: tropicalStatusState, count: tropicalStorms.length },
        wpcOutlooks: { status: wpcStatusState, count: wpcOutlookCount, day: wpcOutlookDay },
        usgsGauges: { status: usgsGaugeStatusState, count: usgsGaugeCount }
      },
      localOverlays: {
        count: localOverlayRecords.length,
        bytes: localOverlayRecords.reduce(function (sum, record) { return sum + JSON.stringify(record.data).length; }, 0)
      },
      cache: await cacheDiagnosticSummary()
    });
    var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    var href = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = href;
    link.download = 'stormscope-diagnostics.json';
    link.click();
    setTimeout(function () { URL.revokeObjectURL(href); }, 0);
  }

  function initDiagnostics() {
    diagnostics.install(window, showFatalRecovery);
    document.getElementById('fatal-reload').addEventListener('click', function () { location.reload(); });
    document.getElementById('fatal-clear-cache').addEventListener('click', async function () {
      if (typeof caches !== 'undefined') {
        var names = await caches.keys();
        await Promise.all(names.filter(function (name) {
          return name.indexOf('stormscope-data-') === 0 || name.indexOf('stormscope-tiles-') === 0;
        }).map(function (name) { return caches.delete(name); }));
      }
      location.reload();
    });
    document.getElementById('export-diagnostics').addEventListener('click', function () {
      exportDiagnostics().catch(function (error) { diagnostics.capture(error, 'diagnostics-export'); });
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
      preferredRadarAnimationSpeed = parsedSpeed;
    } else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      preferredRadarAnimationSpeed = 0;
    }
    radarAnimationSpeed = lowDataMode ? 0 : preferredRadarAnimationSpeed;
    radarPalette = ['standard', 'colorblind', 'contrast'].indexOf(savedPalette) === -1 ? 'standard' : savedPalette;
    document.getElementById('radar-speed').value = String(radarAnimationSpeed);
    document.getElementById('radar-palette').value = radarPalette;
    applyRadarPalette();
    updateLowDataUi();
  }

  function initLowDataMode() {
    var saved = null;
    try { saved = localStorage.getItem('stormscope-data-mode'); } catch (error) { /* optional */ }
    dataModePreference = StormScopeDataMode.normalize(saved);
    dataPolicy = StormScopeDataMode.resolve(dataModePreference, navigator.connection);
    lowDataMode = dataPolicy.lowData;
    lowDataSource = dataPolicy.source;
    if (navigator.connection && typeof navigator.connection.addEventListener === 'function') {
      navigator.connection.addEventListener('change', function () {
        if (dataModePreference === 'auto') applyDataMode('auto', false);
      });
    }
    updateLowDataUi();
  }

  // ── Boot ──

  initDiagnostics();
  try {
    initLocale();
    initTheme();
    initMap();
    initWeatherUnits();
    initLowDataMode();
    initRadarPreferences();
    startupSharedScene = readStartupSharedScene();
    initSavedState({ restoreLastView: !startupSharedScene });
    initLocalOverlays();
    if (startupSharedScene) applySharedScene(startupSharedScene);
    else if (startupSceneError) setSavedStateStatus(tr('views.sceneInvalid'), true);
    bindUI();
    initInstallDiscovery();
    updateMonitorSelectionUi();
    initRadar();
    loadCameras();
    fetchNwsAlerts();
    registerServiceWorker();
    initLifecycle();
  } catch (bootError) {
    diagnostics.capture(bootError, 'boot');
    showFatalRecovery();
  }

  window._stormscope = {
    getMap: function () { return map; },
    getRadarPreloadState: function () { return Object.assign({}, radarPreloadState); },
    getRainViewerBudget: function () { return rainViewerBudget.snapshot(); },
    getCameraLoadMetrics: function () { return Object.assign({}, cameraLoadMetrics); },
    getCameraResults: function () { return currentCameraResults.slice(); },
    getSearchRenderMetrics: function () { return Object.assign({}, searchRenderMetrics); },
    captureSharedScene: captureSharedScene,
    getSharedSceneUrl: sharedSceneUrl,
    getActiveCameraId: function () { return activeCamera ? String(activeCamera.id) : null; },
    getRadarFrameTime: function () { return radarFrames[radarIndex] ? radarFrames[radarIndex].time : null; },
    getLowDataState: function () {
      return {
        preference: dataModePreference, enabled: lowDataMode, source: lowDataSource,
        imageRefreshMs: imageRefreshInterval(), cameraCatalogDeferred: cameraCatalogDeferred
      };
    },
    getMonitorState: function () {
      return { selected: monitorSelection.count(), players: monitorRegistry ? monitorRegistry.count() : 0 };
    },
    getContextState: function () {
      return {
        satellite: Boolean(satelliteLayer), lightning: Boolean(lightningLayer), wildfires: Boolean(wildfireLayer),
        tropical: Boolean(tropicalLayer), wpcOutlooks: Boolean(wpcEroLayer || wpcFloodLayer),
        usgsGauges: Boolean(usgsGaugeLayer),
        satelliteStatus: satelliteStatusState,
        lightningStatus: lightningStatusState, wildfireStatus: wildfireStatusState,
        tropicalStatus: tropicalStatusState, tropicalCount: tropicalStorms.length,
        wpcStatus: wpcStatusState, wpcCount: wpcOutlookCount, wpcDay: wpcOutlookDay,
        gaugeStatus: usgsGaugeStatusState, gaugeCount: usgsGaugeCount,
        localOverlays: localOverlayRecords.length,
        rasterZ: map.getPane('contextRasterPane').style.zIndex,
        satelliteZ: map.getPane('satellitePane').style.zIndex,
        vectorZ: map.getPane('contextVectorPane').style.zIndex,
        localOverlayZ: map.getPane('localOverlayPane').style.zIndex,
        tropicalZ: map.getPane('tropicalPane').style.zIndex,
        warningZ: map.getPane('overlayPane').style.zIndex || '400',
        cameraZ: map.getPane('markerPane').style.zIndex || '600'
      };
    },
    refreshTropical: refreshTropical,
    refreshWpcOutlooks: refreshWpcOutlooks,
    refreshUsgsGauges: refreshUsgsGauges
  };
})();
