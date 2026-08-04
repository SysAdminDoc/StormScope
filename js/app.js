(function () {
  'use strict';

  // Clickjacking protection. CSP frame-ancestors is the correct control, but it is
  // spec-ignored when delivered via a <meta> element and GitHub Pages (and most
  // static hosts) cannot send an HTTP CSP header, so this is the only deliverable
  // guard: if StormScope is framed by another origin, break out to the top window.
  // Same-origin framing (own comparison/monitor iframes are never cross-origin) is
  // allowed; cross-origin access throws, which we treat as hostile framing.
  (function preventFraming() {
    try {
      if (window.top === window.self) return;
      // Throws for cross-origin parents; a readable same-origin href is trusted.
      var parentHref = window.top.location.href;
      if (parentHref) return;
    } catch (e) { /* cross-origin parent — bust out below */ }
    try { window.top.location = window.self.location.href; } catch (e2) { /* ignore */ }
  })();

  var MAP_CENTER = [39.5, -98.5];
  var APP_VERSION = '0.123.0';
  var MAP_ZOOM = 5;
  var RADAR_ANIMATION_SPEED = 800;
  var RADAR_REFRESH_INTERVAL = 10 * 60 * 1000;
  var IMAGE_REFRESH_INTERVAL = 15000;
  var CAMERA_OBSERVATION_TTL = 6 * 60 * 60 * 1000;
  var RECOVERY_ACTION_WINDOW_MS = 10 * 1000;
  var IMPORT_RECOVERY_WINDOW_MS = 12 * 1000;
  var RAINVIEWER_COLOR_SCHEME = 2;
  var RAINVIEWER_MAX_NATIVE_ZOOM = 7;
  var RAINVIEWER_PRELOAD_RESERVE = 20;
  var SATELLITE_ANIMATION_SPEED = 1200;
  var TERMINATOR_REFRESH_INTERVAL = 60 * 1000;

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
  var satelliteRequestBudget = StormScopeRadarProviders.createRollingRequestBudget({ limit: 30, windowMs: 60000 });
  var radarBudgetFallbackPending = false;
  var activeCamera = null;
  var priorFocusEl = null;
  var weatherAbort = null;
  var allCameras = [];
  var cameraIconCache = Object.create(null);
  var cameraObservations = Object.create(null);
  var cameraStore = null;
  var cameraSourceHealth = null;
  var cameraSourceHealthState = 'loading';
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
  var recoveryActionTimers = Object.create(null);
  var startupSharedScene = null;
  var startupSceneError = false;
  var pendingSceneFrameTime = null;
  var pendingSceneCameraId = null;
  var sceneHashTimer = null;
  var sceneHashApplying = false;
  var cameraDataTimestamp = null;
  var diagnostics = StormScopeDiagnostics.create();
  var radarWasPlaying = false;
  var feedPausedForVisibility = false;
  var operationalControllers = null;
  var teardownResources = [];
  var reloadForUpdate = false;
  var refreshInstallDiscovery = function () {};
  var weatherUnits = 'us';
  var alertsVisible = true;
  var alertsPanelDismissed = false;
  var activeAlerts = [];
  var alertLayerGroup = null;
  var alertLayersById = Object.create(null);
  var alertAbort = null;
  var alertRefreshTimer = null;
  var alertMoveTimer = null;
  var alertRetryMetadata = null;
  var alertResultSignature = null;
  var alertDetailReturnFocus = null;
  var alertNationalPayload = null;
  var alertNationalFetchedAt = 0;
  var savedLocationAlertAbort = null;
  var savedLocationAlertTimer = null;
  var savedLocationAlertRetryMetadata = null;
  var savedLocationAlertSeen = Object.create(null);
  var savedLocationAlertNotices = [];
  var SAVED_LOCATION_ALERT_CAP = 12;
  var appLocale = 'en';
  var monitorSelection = new StormScopeMultiCamera.Selection({ minimum: 2, maximum: 4 });
  var monitorRegistry = null;
  var monitorObserver = null;
  var mapComparison = null;
  var comparisonMetricsTimer = null;
  var comparisonSatelliteTime = null;
  var comparisonRadarWasPlaying = false;
  var wakeLockController = null;
  var satelliteLayer = null;
  var satelliteAbort = null;
  var satelliteRefreshTimer = null;
  var satelliteMoveTimer = null;
  var satelliteAnimationTimer = null;
  var satelliteFrameRequestTimer = null;
  var satelliteGeneration = 0;
  var satelliteFrames = [];
  var satelliteFrameIndex = 0;
  var satelliteFrameCache = Object.create(null);
  var satellitePlaying = false;
  var satelliteWasPlaying = false;
  var satelliteLatestTime = null;
  var satelliteStatusState = 'off';
  var satelliteAttributionAdded = false;
  var terminatorLayer = null;
  var terminatorRefreshTimer = null;
  var terminatorUpdatedAt = null;
  var terminatorStatusState = 'off';
  var snowLayer = null;
  var snowAbort = null;
  var snowRefreshTimer = null;
  var snowMoveTimer = null;
  var snowFetchedAt = null;
  var snowStatusState = 'off';
  var snowAttributionAdded = false;
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
  var earthquakeLayer = null;
  var earthquakeAbort = null;
  var earthquakeGeneration = 0;
  var earthquakeRefreshTimer = null;
  var earthquakeGeneratedAt = null;
  var earthquakeCount = 0;
  var earthquakeStatusState = 'off';
  var earthquakeAttributionAdded = false;
  var convectiveLayer = null;
  var convectiveAbort = null;
  var convectiveGeneration = 0;
  var convectiveRefreshTimer = null;
  var convectiveDay = 1;
  var convectiveUpdatedAt = null;
  var convectiveCount = 0;
  var convectiveStatusState = 'off';
  var convectiveAttributionAdded = false;
  var watchLayer = null;
  var watchAbort = null;
  var watchGeneration = 0;
  var watchRefreshTimer = null;
  var watchFetchedAt = null;
  var watchCount = 0;
  var watchStatusState = 'off';
  var watchAttributionAdded = false;
  var mesoscaleLayer = null;
  var mesoscaleAbort = null;
  var mesoscaleGeneration = 0;
  var mesoscaleRefreshTimer = null;
  var mesoscaleLatestAt = null;
  var mesoscaleCount = 0;
  var mesoscaleStatusState = 'off';
  var mesoscaleAttributionAdded = false;
  var stormReportLayer = null;
  var stormReportAbort = null;
  var stormReportGeneration = 0;
  var stormReportRefreshTimer = null;
  var stormReportMoveTimer = null;
  var stormReportWindow = 24;
  var stormReportLatestAt = null;
  var stormReportCount = 0;
  var stormReportStatusState = 'off';
  var stormReportAttributionAdded = false;
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
      layers: { radar: true, cameras: true, coverage: true, alerts: true, satellite: false, lightning: true, wildfires: false, tropical: true, wpcOutlooks: true, usgsGauges: false, earthquakes: false, convective: false, watches: false, mesoscale: false, stormReports: false },
      opacity: { radar: 0.7 }, radar: { palette: 'colorblind', speed: 800 }, alertSeverity: 'severe',
      cameraFilters: { query: '', state: '', source: '', type: '', sort: 'distance', healthy: true, favorites: false }, dataMode: 'auto', outlookDay: 1
    },
    wildfire: {
      center: { lat: 39, lon: -112 }, zoom: 5,
      layers: { radar: false, cameras: true, coverage: false, alerts: true, satellite: true, lightning: false, wildfires: true, tropical: false, wpcOutlooks: false, usgsGauges: false, earthquakes: false, convective: false, watches: false, mesoscale: false, stormReports: false },
      opacity: { radar: 0.55 }, radar: { palette: 'standard', speed: 0 }, alertSeverity: 'moderate',
      cameraFilters: { query: '', state: '', source: '', type: '', sort: 'distance', healthy: true, favorites: false }, dataMode: 'auto', outlookDay: 1
    },
    travel: {
      center: { lat: 38.5, lon: -96 }, zoom: 5,
      layers: { radar: true, cameras: true, coverage: false, alerts: true, satellite: false, lightning: false, wildfires: false, tropical: false, wpcOutlooks: false, usgsGauges: false, earthquakes: false, convective: false, watches: false, mesoscale: false, stormReports: false },
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

  var cameraFeed = StormScopeCameraFeed.create({
    document: document,
    Hls: typeof Hls === 'undefined' ? null : Hls,
    origin: location.origin,
    translate: tr,
    localNumber: localNumber,
    imageRefreshInterval: imageRefreshInterval,
    isActive: function (camera) { return activeCamera === camera; },
    recordObservation: recordCameraObservation,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    now: Date.now
  });
  teardownResources.push(cameraFeed);

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
      setSatellitePlaying(false);
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
    renderSatelliteStatus();
    if (!lowDataMode && cameraCatalogDeferred && cameraStore) resumeCameraCatalog();
    if (mapComparison && mapComparison.isOpen()) mapComparison.refresh();
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Defense-in-depth for popup/anchor hrefs built from fetched provider text.
  // Leaflet 1.9.4 bindPopup renders unsanitized HTML (CVE-2025-69993); all popup
  // builders already construct DOM via textContent, so the only remaining sink is
  // an anchor href carrying a javascript:/data: scheme. Allow http(s) only.
  function safeExternalUrl(value) {
    if (value == null || String(value).trim() === '') return '#';
    try {
      var parsed = new URL(String(value), location.href);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
    } catch (e) { /* fall through */ }
    return '#';
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    if (mapComparison && mapComparison.isOpen()) mapComparison.setBasemapUrl(basemapTileUrl(theme));
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
      var primaryProviderId = StormScopeRadarProviders.primaryProviderId;
      try {
        if (options.forceNoaa) throw new Error('Primary radar tile delivery failed');
        discoveries[primaryProviderId] = await discoverPrimaryRadar(signal);
        health[primaryProviderId] = StormScopeRadarProviders.assessProviderHealth(primaryProviderId, {
          latestFrame: discoveries[primaryProviderId].latestFrame,
          lastSuccessAt: Date.now()
        });
      } catch (primaryError) {
        if (primaryError.name === 'AbortError') throw primaryError;
        health[primaryProviderId] = StormScopeRadarProviders.assessProviderHealth(primaryProviderId, {
          error: primaryError,
          rateLimitedUntil: primaryError.status === 429 ? Date.now() + 60000 : null,
          consecutiveFailures: 1
        });
      }

      if (!navigator.onLine && discoveries[primaryProviderId] && discoveries[primaryProviderId].latestFrame) {
        health[primaryProviderId] = {
          providerId: primaryProviderId,
          status: 'degraded',
          reason: 'cached-offline',
          latestFrameAge: StormScopeRadarProviders.getFrameAge(
            discoveries[primaryProviderId].latestFrame, primaryProviderId
          ),
          lastSuccessAt: discoveries[primaryProviderId].discoveredAt,
          consecutiveFailures: 0,
          checkedAt: Date.now()
        };
      }

      if (navigator.onLine && (!health[primaryProviderId] || health[primaryProviderId].status !== 'healthy')) {
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

  async function discoverPrimaryRadar(signal) {
    var providerId = StormScopeRadarProviders.primaryProviderId;
    var provider = StormScopeRadarProviders.providers[providerId];
    var payload = await fetchRadarJson(provider.discovery.url, signal);
    return StormScopeRadarProviders.parseXyzDiscovery(providerId, payload, Date.now());
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

  function hostMatchesSuffix(hostname, suffix) {
    return hostname === suffix || hostname.endsWith('.' + suffix);
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
    if (provider.tile.kind === 'xyz') {
      if (!radarHost) return null;
      layer = L.tileLayer(radarHost + frame.path + '/256/{z}/{x}/{y}/' + RAINVIEWER_COLOR_SCHEME + '/1_1.png', {
        opacity: radarOpacity,
        zIndex: 400,
        maxNativeZoom: provider.tile.maxNativeZoom,
        maxZoom: 18,
        crossOrigin: 'anonymous',
        attribution: '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
      });
      if (radarProviderId === 'rainviewer') guardRainViewerTileLayer(layer);
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
        if (radarProviderId === StormScopeRadarProviders.primaryProviderId && navigator.onLine) {
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
    var resolution = radarProviderId === 'build-radar'
      ? provider.resolution.label
      : tr('radar.resolution.' + radarProviderId);
    document.getElementById('radar-meta').textContent = provider.label +
      (radarProviderSelection.isFallback ? tr('radar.fallbackSuffix') : '') + ' • ' +
      resolution + ' • ' + StormScopeI18n.formatAge(age.ageMinutes, appLocale) + reason;
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

  function renderTerminatorStatus() {
    if (terminatorStatusState === 'off') {
      setContextStatusElement('terminator-status', tr('context.terminatorOff'), 'off');
      return;
    }
    setContextStatusElement('terminator-status', tr('context.terminatorStatus', {
      time: contextTimestamp(terminatorUpdatedAt)
    }), 'fresh');
  }

  function scheduleTerminatorRefresh() {
    clearTimeout(terminatorRefreshTimer);
    terminatorRefreshTimer = null;
    if (!document.getElementById('toggle-terminator').checked) return;
    terminatorRefreshTimer = setTimeout(refreshTerminator, TERMINATOR_REFRESH_INTERVAL);
  }

  function refreshTerminator() {
    if (!document.getElementById('toggle-terminator').checked || document.hidden) return;
    var now = Date.now();
    var nextLayer = L.polygon(StormScopeSolarTerminator.buildNightPolygon(now), {
      pane: 'contextVectorPane', color: '#071529', weight: 0, opacity: 0,
      fillColor: '#071529', fillOpacity: 0.28, stroke: false, interactive: false,
      className: 'day-night-terminator'
    }).addTo(map);
    if (typeof nextLayer.bringToBack === 'function') nextLayer.bringToBack();
    if (terminatorLayer) map.removeLayer(terminatorLayer);
    terminatorLayer = nextLayer;
    terminatorUpdatedAt = now;
    terminatorStatusState = 'ready';
    renderTerminatorStatus();
    scheduleTerminatorRefresh();
  }

  function disableTerminator() {
    clearTimeout(terminatorRefreshTimer);
    terminatorRefreshTimer = null;
    if (terminatorLayer) map.removeLayer(terminatorLayer);
    terminatorLayer = null;
    terminatorUpdatedAt = null;
    terminatorStatusState = 'off';
    renderTerminatorStatus();
  }

  function renderSnowStatus() {
    if (snowStatusState === 'off') {
      setContextStatusElement('snow-status', tr('context.snowOff'), 'off');
      return;
    }
    if (snowStatusState === 'loading') {
      setContextStatusElement('snow-status', tr('context.loading'), 'loading');
      return;
    }
    if (snowStatusState === 'no-coverage') {
      setContextStatusElement('snow-status', tr('context.snowNoCoverage'), 'off');
      return;
    }
    if (snowStatusState === 'error') {
      setContextStatusElement('snow-status', tr(snowLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var provider = StormScopeContextLayers.providers.snow;
    var freshness = StormScopeContextLayers.freshness(snowFetchedAt, provider.staleMs);
    setContextStatusElement('snow-status', tr('context.snowStatus', {
      freshness: tr('context.' + freshness.state), time: contextTimestamp(snowFetchedAt)
    }), freshness.state);
  }

  function scheduleSnowRefresh() {
    clearTimeout(snowRefreshTimer);
    snowRefreshTimer = null;
    if (!document.getElementById('toggle-snow').checked) return;
    snowRefreshTimer = setTimeout(refreshSnow, StormScopeContextLayers.providers.snow.refreshMs);
  }

  function ensureSnowAttribution() {
    if (snowAttributionAdded) return;
    var provider = StormScopeContextLayers.providers.snow;
    map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
    snowAttributionAdded = true;
  }

  function removeSnowAttribution() {
    if (!snowAttributionAdded) return;
    var provider = StormScopeContextLayers.providers.snow;
    map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
    snowAttributionAdded = false;
  }

  async function refreshSnow() {
    if (!document.getElementById('toggle-snow').checked || document.hidden) return;
    if (snowAbort) snowAbort.abort();
    var operation = new AbortController();
    snowAbort = operation;
    var signal = operation.signal;
    snowStatusState = 'loading';
    renderSnowStatus();
    try {
      var mapBounds = map.getBounds();
      var viewport = map.getSize();
      var request = StormScopeContextLayers.buildSnowExportRequest({
        west: mapBounds.getWest(), south: mapBounds.getSouth(),
        east: mapBounds.getEast(), north: mapBounds.getNorth()
      }, { width: viewport.x, height: viewport.y });
      if (!request) {
        if (snowLayer) map.removeLayer(snowLayer);
        snowLayer = null;
        snowFetchedAt = null;
        removeSnowAttribution();
        snowStatusState = 'no-coverage';
        renderSnowStatus();
        return;
      }
      var nextLayer = L.imageOverlay(request.url, request.bounds, {
        opacity: 0.52, pane: 'contextRasterPane', crossOrigin: 'anonymous', interactive: false
      });
      var loadPromise = new Promise(function (resolve, reject) {
        nextLayer.once('load', resolve);
        nextLayer.once('error', function () { reject(new Error('NOAA NOHRSC snow image failed')); });
      });
      nextLayer.addTo(map);
      try {
        await loadPromise;
        if (signal.aborted || !document.getElementById('toggle-snow').checked) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (snowLayer && snowLayer !== nextLayer) map.removeLayer(snowLayer);
        snowLayer = nextLayer;
        snowFetchedAt = Date.now();
        snowStatusState = 'ready';
        ensureSnowAttribution();
        renderSnowStatus();
      } catch (error) {
        if (map.hasLayer(nextLayer)) map.removeLayer(nextLayer);
        throw error;
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      snowStatusState = 'error';
      renderSnowStatus();
    } finally {
      if (snowAbort === operation) {
        snowAbort = null;
        scheduleSnowRefresh();
      }
    }
  }

  function disableSnow() {
    if (snowAbort) snowAbort.abort();
    snowAbort = null;
    clearTimeout(snowRefreshTimer);
    clearTimeout(snowMoveTimer);
    snowRefreshTimer = null;
    snowMoveTimer = null;
    if (snowLayer) map.removeLayer(snowLayer);
    snowLayer = null;
    snowFetchedAt = null;
    removeSnowAttribution();
    snowStatusState = 'off';
    renderSnowStatus();
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
      renderSatelliteControls();
      return;
    }
    if (satelliteStatusState === 'loading') {
      setContextStatusElement('satellite-status', tr('context.loading'), 'loading');
      renderSatelliteControls();
      return;
    }
    if (satelliteStatusState === 'error') {
      setContextStatusElement('satellite-status', tr(satelliteLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      renderSatelliteControls();
      return;
    }
    var frameFreshness = StormScopeContextLayers.freshness(
      satelliteLatestTime, StormScopeContextLayers.providers.satellite.staleMs
    );
    setContextStatusElement('satellite-status', tr('context.satelliteStatus', {
      freshness: tr('context.' + frameFreshness.state), time: contextTimestamp(satelliteLatestTime),
      current: localNumber(satelliteFrameIndex + 1), total: localNumber(satelliteFrames.length)
    }), frameFreshness.state);
    renderSatelliteControls();
  }

  function renderSatelliteControls() {
    var controls = document.getElementById('satellite-loop-controls');
    if (!controls) return;
    var hasFrames = satelliteFrames.length > 0;
    controls.classList.toggle('hidden', satelliteStatusState === 'off');
    var index = hasFrames ? Math.max(0, Math.min(satelliteFrames.length - 1, satelliteFrameIndex)) : 0;
    var loading = satelliteStatusState === 'loading';
    var previous = document.getElementById('satellite-prev');
    var next = document.getElementById('satellite-next');
    var scrubber = document.getElementById('satellite-scrubber');
    var play = document.getElementById('satellite-play');
    previous.disabled = !hasFrames || loading;
    next.disabled = !hasFrames || loading;
    scrubber.disabled = !hasFrames || loading;
    play.disabled = !hasFrames || loading || satelliteFrames.length < 2 || lowDataMode;
    scrubber.max = String(Math.max(0, satelliteFrames.length - 1));
    scrubber.value = String(index);
    scrubber.setAttribute('aria-valuetext', hasFrames
      ? tr('context.satelliteFramePosition', { current: localNumber(index + 1), total: localNumber(satelliteFrames.length) })
      : tr('weather.unknown'));
    document.getElementById('satellite-frame-position').textContent = tr('context.satelliteFramePosition', {
      current: hasFrames ? localNumber(index + 1) : '0', total: localNumber(satelliteFrames.length)
    });
    document.getElementById('satellite-frame-time').textContent = hasFrames
      ? contextTimestamp(satelliteFrames[index]) : tr('weather.unknown');
    previous.title = tr('context.satellitePrevious');
    previous.setAttribute('aria-label', tr('context.satellitePrevious'));
    next.title = tr('context.satelliteNext');
    next.setAttribute('aria-label', tr('context.satelliteNext'));
    play.title = tr(satellitePlaying ? 'context.satellitePause' : 'context.satellitePlay');
    play.setAttribute('aria-label', tr(satellitePlaying ? 'context.satellitePause' : 'context.satellitePlay'));
    play.setAttribute('aria-pressed', String(satellitePlaying));
    document.getElementById('satellite-play-label').textContent = tr(satellitePlaying
      ? 'context.satellitePause' : 'context.satellitePlay');
  }

  function scheduleSatelliteRefresh() {
    clearTimeout(satelliteRefreshTimer);
    if (!document.getElementById('toggle-satellite').checked) return;
    satelliteRefreshTimer = setTimeout(refreshSatellite, StormScopeContextLayers.providers.satellite.refreshMs);
  }

  function satelliteFrameKey(time) {
    return String(Math.round(Number(time)));
  }

  function nearestSatelliteFrameIndex(times, target) {
    if (!times.length || !Number.isFinite(Number(target))) return Math.max(0, times.length - 1);
    var nearest = 0;
    var distance = Infinity;
    times.forEach(function (time, index) {
      var nextDistance = Math.abs(Number(time) - Number(target));
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = index;
      }
    });
    return nearest;
  }

  function satelliteRequestCountAllowed(count) {
    if (satelliteRequestBudget.consume(count)) return true;
    throw new Error(tr('context.satelliteRequestBudget'));
  }

  function ensureSatelliteAttribution() {
    if (satelliteAttributionAdded) return;
    var provider = StormScopeContextLayers.providers.satellite;
    map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
    satelliteAttributionAdded = true;
  }

  async function loadSatelliteFrame(index, signal, generation) {
    var frameTime = satelliteFrames[index];
    if (!Number.isFinite(Number(frameTime))) throw new Error('NOAA GOES frame is invalid');
    var key = satelliteFrameKey(frameTime);
    var cached = satelliteFrameCache[key];
    if (cached) {
      if (signal.aborted || generation !== satelliteGeneration) throw new DOMException('Aborted', 'AbortError');
      if (satelliteLayer && satelliteLayer !== cached) map.removeLayer(satelliteLayer);
      satelliteLayer = cached;
      cached.addTo(map);
      satelliteLatestTime = frameTime;
      satelliteStatusState = 'ready';
      ensureSatelliteAttribution();
      renderSatelliteStatus();
      return;
    }
    var bounds = map.getBounds();
    var requests = StormScopeContextLayers.buildGoesExportRequests({
      west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth()
    }, frameTime, map.getSize());
    satelliteRequestCountAllowed(requests.length);
    var overlays = requests.map(function (request) {
      return L.imageOverlay(request.url, request.bounds, {
        opacity: 0.55, pane: 'satellitePane', crossOrigin: 'anonymous', interactive: false
      });
    });
    var nextLayer = L.layerGroup(overlays);
    var loadPromise = Promise.all(overlays.map(function (overlay) {
      return new Promise(function (resolve, reject) {
        overlay.once('load', resolve);
        overlay.once('error', function () { reject(new Error('NOAA GOES image failed')); });
      });
    }));
    nextLayer.addTo(map);
    try {
      await loadPromise;
      if (signal.aborted || generation !== satelliteGeneration) throw new DOMException('Aborted', 'AbortError');
      satelliteFrameCache[key] = nextLayer;
      if (satelliteLayer && satelliteLayer !== nextLayer) map.removeLayer(satelliteLayer);
      satelliteLayer = nextLayer;
      satelliteLatestTime = frameTime;
      satelliteStatusState = 'ready';
      ensureSatelliteAttribution();
      renderSatelliteStatus();
    } catch (error) {
      if (map.hasLayer(nextLayer)) map.removeLayer(nextLayer);
      throw error;
    }
  }

  function beginSatelliteOperation() {
    if (satelliteAbort) satelliteAbort.abort();
    satelliteAbort = new AbortController();
    satelliteGeneration += 1;
    return { signal: satelliteAbort.signal, generation: satelliteGeneration };
  }

  async function refreshSatellite() {
    if (!document.getElementById('toggle-satellite').checked || document.hidden) return;
    var previousTime = satelliteFrames[satelliteFrameIndex];
    var operation = beginSatelliteOperation();
    satelliteStatusState = 'loading';
    renderSatelliteStatus();
    try {
      satelliteRequestCountAllowed(1);
      var provider = StormScopeContextLayers.providers.satellite;
      var metadataResponse = await fetch(provider.imageServerUrl + '?f=pjson', { cache: 'no-store', signal: operation.signal });
      if (!metadataResponse.ok) throw new Error('HTTP ' + metadataResponse.status);
      var metadata = StormScopeContextLayers.parseGoesMetadata(await metadataResponse.json());
      if (operation.signal.aborted || operation.generation !== satelliteGeneration) throw new DOMException('Aborted', 'AbortError');
      satelliteFrames = metadata.frameTimes.slice();
      satelliteFrameIndex = nearestSatelliteFrameIndex(satelliteFrames, previousTime == null ? metadata.latestTime : previousTime);
      satelliteFrameCache = Object.create(null);
      renderSatelliteControls();
      await loadSatelliteFrame(satelliteFrameIndex, operation.signal, operation.generation);
    } catch (error) {
      if (error.name === 'AbortError') return;
      satelliteStatusState = 'error';
      renderSatelliteStatus();
    } finally {
      if (operation.generation === satelliteGeneration) scheduleSatelliteRefresh();
    }
  }

  function requestSatelliteFrame(index) {
    if (!satelliteFrames.length || !document.getElementById('toggle-satellite').checked || document.hidden) {
      return Promise.resolve(false);
    }
    satelliteFrameIndex = Math.max(0, Math.min(satelliteFrames.length - 1, Number(index) || 0));
    var operation = beginSatelliteOperation();
    satelliteStatusState = 'loading';
    renderSatelliteStatus();
    return loadSatelliteFrame(satelliteFrameIndex, operation.signal, operation.generation).then(function () {
      return true;
    }).catch(function (error) {
      if (error.name === 'AbortError') return false;
      if (operation.generation === satelliteGeneration) {
        satelliteStatusState = 'error';
        renderSatelliteStatus();
      }
      throw error;
    }).finally(function () {
      if (operation.generation === satelliteGeneration) scheduleSatelliteRefresh();
    });
  }

  function scheduleSatelliteFrameRequest(index) {
    clearTimeout(satelliteFrameRequestTimer);
    satelliteFrameRequestTimer = setTimeout(function () {
      satelliteFrameRequestTimer = null;
      requestSatelliteFrame(index).catch(function () { /* status already rendered */ });
    }, 220);
  }

  function stepSatellite(delta) {
    if (!satelliteFrames.length) return Promise.resolve(false);
    return requestSatelliteFrame((satelliteFrameIndex + delta + satelliteFrames.length) % satelliteFrames.length);
  }

  function scheduleSatelliteAnimation() {
    clearTimeout(satelliteAnimationTimer);
    satelliteAnimationTimer = null;
    if (!satellitePlaying) return;
    satelliteAnimationTimer = setTimeout(function () {
      satelliteAnimationTimer = null;
      stepSatellite(1).then(function () {
        if (satellitePlaying) scheduleSatelliteAnimation();
      }).catch(function () {
        if (satellitePlaying) setSatellitePlaying(false);
      });
    }, SATELLITE_ANIMATION_SPEED);
  }

  function setSatellitePlaying(playing) {
    satellitePlaying = Boolean(playing && satelliteFrames.length > 1 && !lowDataMode &&
      document.getElementById('toggle-satellite') && document.getElementById('toggle-satellite').checked);
    clearTimeout(satelliteAnimationTimer);
    satelliteAnimationTimer = null;
    if (satellitePlaying) scheduleSatelliteAnimation();
    renderSatelliteControls();
    syncWakeLockMonitoring();
  }

  function disableSatellite() {
    satelliteGeneration += 1;
    if (satelliteAbort) satelliteAbort.abort();
    setSatellitePlaying(false);
    clearTimeout(satelliteRefreshTimer);
    clearTimeout(satelliteMoveTimer);
    clearTimeout(satelliteFrameRequestTimer);
    satelliteRefreshTimer = null;
    satelliteMoveTimer = null;
    satelliteFrameRequestTimer = null;
    if (satelliteLayer) map.removeLayer(satelliteLayer);
    satelliteLayer = null;
    satelliteFrameCache = Object.create(null);
    satelliteFrames = [];
    satelliteFrameIndex = 0;
    satelliteLatestTime = null;
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
    link.href = safeExternalUrl(properties.advisoryUrl);
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
    link.href = safeExternalUrl(properties.sourceUrl);
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

  function persistOverlayRecovery(snapshots) {
    var persisted = snapshots.filter(function (snapshot) { return snapshot.persisted; });
    if (!persisted.length) return Promise.resolve();
    if (!localOverlayDatabase) return Promise.reject(new Error('storage unavailable'));
    return new Promise(function (resolve, reject) {
      var transaction = localOverlayDatabase.transaction('overlays', 'readwrite');
      var store = transaction.objectStore('overlays');
      transaction.onabort = function () { reject(transaction.error || new Error('storage aborted')); };
      transaction.onerror = function () { /* onabort reports the atomic failure */ };
      transaction.oncomplete = resolve;
      try {
        persisted.forEach(function (snapshot) { store.put(overlayStoredRecord(snapshot.record)); });
      } catch (error) {
        try { transaction.abort(); } catch (abortError) { /* already failed */ }
        reject(error);
      }
    });
  }

  function addRecoveredOverlays(snapshots, persistent) {
    snapshots.forEach(function (snapshot) {
      var record = snapshot.record;
      record.persisted = persistent && snapshot.persisted;
      record.layer = null;
      localOverlayRecords.push(record);
      drawLocalOverlay(record);
    });
    renderLocalOverlayList();
  }

  function restoreLocalOverlays(snapshots, successKey, variables) {
    var currentIds = new Set(localOverlayRecords.map(function (record) { return record.id; }));
    if (localOverlayRecords.length + snapshots.length > StormScopeLocalOverlays.MAX_OVERLAYS ||
        snapshots.some(function (snapshot) { return currentIds.has(snapshot.record.id); })) {
      return Promise.reject(new Error('overlay recovery conflicts with current overlays'));
    }
    return persistOverlayRecovery(snapshots).then(function () {
      addRecoveredOverlays(snapshots, true);
      setLocalOverlayStatus(successKey, variables);
    }, function () {
      addRecoveredOverlays(snapshots, false);
      setLocalOverlayStatus('overlays.restoredSessionOnly', null, true);
    });
  }

  function removeLocalOverlay(record, button) {
    var snapshots;
    try { snapshots = StormScopeLocalOverlays.recoverySnapshot([record]); } catch (error) {
      if (button) button.disabled = false;
      setLocalOverlayStatus('overlays.error.restore', null, true);
      return;
    }
    var removal = record.persisted
      ? overlayTransaction('readwrite', function (store) { return store.delete(record.id); })
      : Promise.resolve();
    removal.then(function () {
      if (record.layer) map.removeLayer(record.layer);
      localOverlayRecords = localOverlayRecords.filter(function (itemRecord) { return itemRecord !== record; });
      renderLocalOverlayList();
      offerRecoveryAction(
        'local-overlay-status',
        tr('overlays.removedUndo', { name: record.name, seconds: localNumber(RECOVERY_ACTION_WINDOW_MS / 1000) }),
        tr('recovery.undo'),
        tr('overlays.removed', { name: record.name }),
        function () { return restoreLocalOverlays(snapshots, 'overlays.restored', { name: record.name }); },
        function () { setLocalOverlayStatus('overlays.error.restore', null, true); }
      );
    }).catch(function () {
      if (button) button.disabled = false;
      setLocalOverlayStatus('overlays.error.storage', null, true);
    });
  }

  function clearLocalOverlays() {
    var count = localOverlayRecords.length;
    if (!count || !window.confirm(tr('overlays.clearConfirm', {
      count: localNumber(count), seconds: localNumber(RECOVERY_ACTION_WINDOW_MS / 1000)
    }))) return;
    var snapshots;
    try { snapshots = StormScopeLocalOverlays.recoverySnapshot(localOverlayRecords); } catch (error) {
      setLocalOverlayStatus('overlays.error.restore', null, true);
      return;
    }
    var clear = localOverlayDatabase
      ? overlayTransaction('readwrite', function (store) { return store.clear(); }) : Promise.resolve();
    clear.then(function () {
      localOverlayRecords.forEach(function (record) { if (record.layer) map.removeLayer(record.layer); });
      localOverlayRecords = [];
      renderLocalOverlayList();
      offerRecoveryAction(
        'local-overlay-status',
        tr('overlays.clearedUndo', { count: localNumber(count), seconds: localNumber(RECOVERY_ACTION_WINDOW_MS / 1000) }),
        tr('recovery.restore'),
        tr('overlays.cleared'),
        function () { return restoreLocalOverlays(snapshots, 'overlays.restoredAll', { count: localNumber(count) }); },
        function () { setLocalOverlayStatus('overlays.error.restore', null, true); }
      );
    }).catch(function () { setLocalOverlayStatus('overlays.error.storage', null, true); });
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

  function cancelRecoveryAction(statusId) {
    var pending = recoveryActionTimers[statusId];
    if (!pending) return;
    clearTimeout(pending.timer);
    delete recoveryActionTimers[statusId];
  }

  function setRecoveryStatusText(statusId, message, error) {
    cancelRecoveryAction(statusId);
    var status = document.getElementById(statusId);
    status.textContent = message;
    status.classList.toggle('error', Boolean(error));
  }

  function offerRecoveryAction(statusId, message, actionLabel, expiredMessage, action, onError, windowMs) {
    cancelRecoveryAction(statusId);
    var status = document.getElementById(statusId);
    var text = document.createElement('span');
    text.textContent = message;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'recovery-action';
    button.textContent = actionLabel;
    status.replaceChildren(text, button);
    status.classList.remove('error');
    var pending = { timer: null };
    pending.timer = setTimeout(function () {
      if (recoveryActionTimers[statusId] !== pending) return;
      delete recoveryActionTimers[statusId];
      status.textContent = expiredMessage;
    }, Number(windowMs) > 0 ? Number(windowMs) : RECOVERY_ACTION_WINDOW_MS);
    recoveryActionTimers[statusId] = pending;
    button.addEventListener('click', function () {
      if (recoveryActionTimers[statusId] !== pending) return;
      clearTimeout(pending.timer);
      delete recoveryActionTimers[statusId];
      button.disabled = true;
      Promise.resolve().then(action).catch(typeof onError === 'function' ? onError : function () {});
    });
  }

  function setLocalOverlayStatus(key, variables, error) {
    setRecoveryStatusText('local-overlay-status', tr(key, variables), error);
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
        button.addEventListener('click', function () { handler(button); });
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
      action(tr('overlays.remove'), function (button) {
        button.disabled = true;
        removeLocalOverlay(record, button);
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

  // ── USGS earthquakes ──

  function earthquakeSelection() {
    return {
      magnitude: document.getElementById('earthquake-magnitude').value,
      period: document.getElementById('earthquake-period').value
    };
  }

  function renderEarthquakeStatus() {
    if (earthquakeStatusState === 'off') {
      setContextStatusElement('earthquake-status', tr('context.earthquakesOff'), 'off');
      return;
    }
    if (earthquakeStatusState === 'loading') {
      setContextStatusElement('earthquake-status', tr('context.loading'), 'loading');
      return;
    }
    if (earthquakeStatusState === 'error') {
      setContextStatusElement('earthquake-status', tr(earthquakeLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var provider = StormScopeEarthquakes.provider;
    var fresh = StormScopeEarthquakes.freshness(earthquakeGeneratedAt, provider.staleMs);
    setContextStatusElement('earthquake-status', tr('context.earthquakeStatus', {
      count: localNumber(earthquakeCount),
      freshness: tr(fresh.state === 'stale' ? 'context.stale' : 'context.fresh'),
      time: earthquakeGeneratedAt ? localTime(earthquakeGeneratedAt) : tr('weather.unknown')
    }), 'ready');
  }

  function earthquakePopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var heading = document.createElement('strong');
    heading.textContent = tr('context.earthquakeMagnitude', { mag: localNumber(properties.mag) });
    container.appendChild(heading);
    var place = document.createElement('span');
    place.textContent = properties.place || tr('context.earthquakeUnknownPlace');
    container.appendChild(place);
    if (properties.depthKm != null) {
      var depth = document.createElement('span');
      depth.textContent = tr('context.earthquakeDepth', { depth: localNumber(Math.round(properties.depthKm)) });
      container.appendChild(depth);
    }
    if (properties.time != null) {
      var time = document.createElement('span');
      time.textContent = localTime(properties.time);
      container.appendChild(time);
    }
    if (properties.url) {
      var link = document.createElement('a');
      link.href = safeExternalUrl(properties.url);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = tr('context.usgsSource');
      container.appendChild(link);
    }
    return container;
  }

  function scheduleEarthquakeRefresh() {
    clearTimeout(earthquakeRefreshTimer);
    earthquakeRefreshTimer = null;
    if (!document.getElementById('toggle-earthquakes').checked) return;
    earthquakeRefreshTimer = setTimeout(refreshEarthquakes, StormScopeEarthquakes.provider.refreshMs);
  }

  async function refreshEarthquakes() {
    if (!document.getElementById('toggle-earthquakes').checked || document.hidden) return;
    if (earthquakeAbort) earthquakeAbort.abort();
    earthquakeAbort = new AbortController();
    var generation = ++earthquakeGeneration;
    var signal = earthquakeAbort.signal;
    earthquakeStatusState = 'loading';
    renderEarthquakeStatus();
    try {
      var provider = StormScopeEarthquakes.provider;
      var selection = earthquakeSelection();
      var url = StormScopeEarthquakes.buildFeedUrl(selection.magnitude, selection.period);
      var response = await fetch(url, { cache: 'no-store', signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var normalized = StormScopeEarthquakes.normalizeCollection(await response.json());
      if (generation !== earthquakeGeneration) return;
      var nextLayer = L.geoJSON(normalized.collection, {
        pane: 'contextVectorPane',
        pointToLayer: function (feature, latlng) {
          return L.circleMarker(latlng, {
            pane: 'contextVectorPane',
            radius: StormScopeEarthquakes.markerRadius(feature.properties.mag),
            color: '#1a1a1a', weight: 1,
            fillColor: StormScopeEarthquakes.markerColor(feature.properties.mag), fillOpacity: 0.75
          });
        },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return earthquakePopup(feature); }, { autoPan: false, maxWidth: 320, maxHeight: 320 });
        }
      }).addTo(map);
      if (earthquakeLayer) map.removeLayer(earthquakeLayer);
      earthquakeLayer = nextLayer;
      if (!earthquakeAttributionAdded) {
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        earthquakeAttributionAdded = true;
      }
      earthquakeGeneratedAt = normalized.generatedAt;
      earthquakeCount = normalized.count;
      earthquakeStatusState = 'ready';
      renderEarthquakeStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation !== earthquakeGeneration) return;
      earthquakeStatusState = 'error';
      renderEarthquakeStatus();
    } finally {
      if (generation === earthquakeGeneration) scheduleEarthquakeRefresh();
    }
  }

  function disableEarthquakes() {
    earthquakeGeneration += 1;
    if (earthquakeAbort) earthquakeAbort.abort();
    clearTimeout(earthquakeRefreshTimer);
    earthquakeRefreshTimer = null;
    if (earthquakeLayer) map.removeLayer(earthquakeLayer);
    earthquakeLayer = null;
    if (earthquakeAttributionAdded) {
      var provider = StormScopeEarthquakes.provider;
      map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
      earthquakeAttributionAdded = false;
    }
    earthquakeCount = 0;
    earthquakeGeneratedAt = null;
    earthquakeStatusState = 'off';
    renderEarthquakeStatus();
  }

  // ── SPC convective outlooks ──

  function renderConvectiveStatus() {
    if (convectiveStatusState === 'off') {
      setContextStatusElement('convective-status', tr('context.convectiveOff'), 'off');
      return;
    }
    if (convectiveStatusState === 'loading') {
      setContextStatusElement('convective-status', tr('context.loading'), 'loading');
      return;
    }
    if (convectiveStatusState === 'error') {
      setContextStatusElement('convective-status', tr(convectiveLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var provider = StormScopeConvectiveOutlooks.provider;
    var fresh = StormScopeConvectiveOutlooks.freshness(convectiveUpdatedAt, provider.staleMs);
    setContextStatusElement('convective-status', tr('context.convectiveStatus', {
      count: localNumber(convectiveCount), day: localNumber(convectiveDay),
      freshness: tr(fresh.state === 'stale' ? 'context.stale' : 'context.fresh'),
      time: convectiveUpdatedAt ? localTime(convectiveUpdatedAt) : tr('weather.unknown')
    }), 'ready');
  }

  function convectivePopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var title = document.createElement('strong');
    title.textContent = tr('context.convectiveFeature', { category: tr('context.spc.' + properties.outlookCategory) });
    container.appendChild(title);
    var day = document.createElement('span');
    day.textContent = tr('context.convectiveDay', { day: localNumber(properties.outlookDay) });
    container.appendChild(day);
    if (properties.issuedAt) {
      var issued = document.createElement('span');
      issued.textContent = tr('context.convectiveIssued', { time: contextTimestamp(properties.issuedAt) });
      container.appendChild(issued);
    }
    if (properties.startsAt && properties.endsAt) {
      var valid = document.createElement('span');
      valid.textContent = tr('context.convectiveValid', {
        start: contextTimestamp(properties.startsAt), end: contextTimestamp(properties.endsAt)
      });
      container.appendChild(valid);
    }
    var source = document.createElement('span');
    source.textContent = tr('context.convectiveSource', { source: properties.sourceLabel });
    container.appendChild(source);
    var limitation = document.createElement('span');
    limitation.textContent = tr('context.convectiveLimitation');
    container.appendChild(limitation);
    var link = document.createElement('a');
    link.href = 'https://www.spc.noaa.gov/products/outlook/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('context.spcSource');
    container.appendChild(link);
    return container;
  }

  function scheduleConvectiveRefresh() {
    clearTimeout(convectiveRefreshTimer);
    convectiveRefreshTimer = null;
    if (!document.getElementById('toggle-convective').checked) return;
    convectiveRefreshTimer = setTimeout(refreshConvectiveOutlooks, StormScopeConvectiveOutlooks.provider.refreshMs);
  }

  async function refreshConvectiveOutlooks() {
    if (!document.getElementById('toggle-convective').checked || document.hidden) return;
    if (convectiveAbort) convectiveAbort.abort();
    convectiveAbort = new AbortController();
    var generation = ++convectiveGeneration;
    var signal = convectiveAbort.signal;
    convectiveStatusState = 'loading';
    renderConvectiveStatus();
    try {
      var provider = StormScopeConvectiveOutlooks.provider;
      var day = convectiveDay;
      var metadataResponse = await fetch(StormScopeConvectiveOutlooks.metadataUrl(day), { cache: 'no-store', signal: signal });
      var metadata = metadataResponse.ok ? StormScopeConvectiveOutlooks.parseMetadata(await metadataResponse.json()) : { updatedAt: null };
      var collection = await StormScopeConvectiveOutlooks.fetchAllPages(function (url, options) {
        return fetch(url, options);
      }, day, signal);
      if (generation !== convectiveGeneration) return;
      var nextLayer = L.geoJSON(collection, {
        pane: 'contextVectorPane',
        style: function (feature) { return StormScopeConvectiveOutlooks.style(feature.properties.outlookCategory); },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return convectivePopup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 420 });
        }
      }).addTo(map);
      if (convectiveLayer) map.removeLayer(convectiveLayer);
      convectiveLayer = nextLayer;
      if (!convectiveAttributionAdded) {
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        convectiveAttributionAdded = true;
      }
      convectiveUpdatedAt = metadata.updatedAt;
      convectiveCount = collection.features.length;
      convectiveStatusState = 'ready';
      renderConvectiveStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation !== convectiveGeneration) return;
      convectiveStatusState = 'error';
      renderConvectiveStatus();
    } finally {
      if (generation === convectiveGeneration) scheduleConvectiveRefresh();
    }
  }

  function disableConvectiveOutlooks() {
    convectiveGeneration += 1;
    if (convectiveAbort) convectiveAbort.abort();
    clearTimeout(convectiveRefreshTimer);
    convectiveRefreshTimer = null;
    if (convectiveLayer) map.removeLayer(convectiveLayer);
    convectiveLayer = null;
    if (convectiveAttributionAdded) {
      var provider = StormScopeConvectiveOutlooks.provider;
      map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
      convectiveAttributionAdded = false;
    }
    convectiveCount = 0;
    convectiveUpdatedAt = null;
    convectiveStatusState = 'off';
    renderConvectiveStatus();
  }

  // ── SPC severe & tornado watches ──

  function renderWatchStatus() {
    if (watchStatusState === 'off') {
      setContextStatusElement('watch-status', tr('context.watchesOff'), 'off');
      return;
    }
    if (watchStatusState === 'loading') {
      setContextStatusElement('watch-status', tr('context.loading'), 'loading');
      return;
    }
    if (watchStatusState === 'error') {
      setContextStatusElement('watch-status', tr(watchLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var provider = StormScopeSevereWatches.provider;
    var fresh = StormScopeSevereWatches.freshness(watchFetchedAt, provider.staleMs);
    setContextStatusElement('watch-status', tr('context.watchStatus', {
      count: localNumber(watchCount),
      freshness: tr(fresh.state === 'stale' ? 'context.stale' : 'context.fresh'),
      time: watchFetchedAt ? localTime(watchFetchedAt) : tr('weather.unknown')
    }), 'ready');
  }

  function watchPopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var title = document.createElement('strong');
    title.textContent = tr('context.watch.' + properties.watchKind);
    container.appendChild(title);
    if (properties.issuedAt) {
      var issued = document.createElement('span');
      issued.textContent = tr('context.watchIssued', { time: contextTimestamp(properties.issuedAt) });
      container.appendChild(issued);
    }
    if (properties.expiresAt) {
      var expires = document.createElement('span');
      expires.textContent = tr('context.watchExpires', { time: contextTimestamp(properties.expiresAt) });
      container.appendChild(expires);
    }
    if (properties.officialUrl) {
      var link = document.createElement('a');
      link.href = safeExternalUrl(properties.officialUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = tr('context.watchSource');
      container.appendChild(link);
    }
    return container;
  }

  function scheduleWatchRefresh() {
    clearTimeout(watchRefreshTimer);
    watchRefreshTimer = null;
    if (!document.getElementById('toggle-watches').checked) return;
    watchRefreshTimer = setTimeout(refreshSevereWatches, StormScopeSevereWatches.provider.refreshMs);
  }

  async function refreshSevereWatches() {
    if (!document.getElementById('toggle-watches').checked || document.hidden) return;
    if (watchAbort) watchAbort.abort();
    watchAbort = new AbortController();
    var generation = ++watchGeneration;
    var signal = watchAbort.signal;
    watchStatusState = 'loading';
    renderWatchStatus();
    try {
      var provider = StormScopeSevereWatches.provider;
      var collection = await StormScopeSevereWatches.fetchAllPages(function (url, options) {
        return fetch(url, options);
      }, signal);
      if (generation !== watchGeneration) return;
      var nextLayer = L.geoJSON(collection, {
        pane: 'contextVectorPane',
        style: function (feature) { return StormScopeSevereWatches.style(feature.properties.watchKind); },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return watchPopup(feature); }, { autoPan: false, maxWidth: 360, maxHeight: 360 });
        }
      }).addTo(map);
      if (watchLayer) map.removeLayer(watchLayer);
      watchLayer = nextLayer;
      if (!watchAttributionAdded) {
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        watchAttributionAdded = true;
      }
      watchFetchedAt = Date.now();
      watchCount = collection.features.length;
      watchStatusState = 'ready';
      renderWatchStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation !== watchGeneration) return;
      watchStatusState = 'error';
      renderWatchStatus();
    } finally {
      if (generation === watchGeneration) scheduleWatchRefresh();
    }
  }

  function disableSevereWatches() {
    watchGeneration += 1;
    if (watchAbort) watchAbort.abort();
    clearTimeout(watchRefreshTimer);
    watchRefreshTimer = null;
    if (watchLayer) map.removeLayer(watchLayer);
    watchLayer = null;
    if (watchAttributionAdded) {
      var provider = StormScopeSevereWatches.provider;
      map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
      watchAttributionAdded = false;
    }
    watchCount = 0;
    watchFetchedAt = null;
    watchStatusState = 'off';
    renderWatchStatus();
  }

  // ── SPC mesoscale discussions and NWS local storm reports ──

  function freshnessLabel(value, staleMs) {
    var freshness = StormScopeSpcReports.freshness(value, staleMs);
    return freshness.state === 'stale' ? tr('context.stale')
      : freshness.state === 'fresh' ? tr('context.fresh') : tr('weather.unknown');
  }

  function renderMesoscaleStatus() {
    if (mesoscaleStatusState === 'off') {
      setContextStatusElement('mesoscale-status', tr('context.mesoscaleOff'), 'off');
      return;
    }
    if (mesoscaleStatusState === 'loading') {
      setContextStatusElement('mesoscale-status', tr('context.loading'), 'loading');
      return;
    }
    if (mesoscaleStatusState === 'error') {
      setContextStatusElement('mesoscale-status', tr(mesoscaleLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var provider = StormScopeSpcReports.providers.mesoscale;
    setContextStatusElement('mesoscale-status', tr('context.mesoscaleStatus', {
      count: localNumber(mesoscaleCount), freshness: freshnessLabel(mesoscaleLatestAt, provider.staleMs),
      time: mesoscaleLatestAt ? contextTimestamp(mesoscaleLatestAt) : tr('weather.unknown')
    }), 'ready');
  }

  function mesoscalePopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var title = document.createElement('strong');
    title.textContent = tr('context.mesoscaleFeature', { number: properties.discussionNumber || tr('weather.unknown') });
    container.appendChild(title);
    if (properties.issuedAt) {
      var issued = document.createElement('span');
      issued.textContent = tr('context.mesoscaleIssued', { time: contextTimestamp(properties.issuedAt) });
      container.appendChild(issued);
    }
    if (properties.discussionInfo) {
      var info = document.createElement('span');
      info.textContent = tr('context.mesoscaleInfo', { info: properties.discussionInfo });
      container.appendChild(info);
    }
    var guidance = document.createElement('span');
    guidance.textContent = tr('context.mesoscaleGuidance');
    container.appendChild(guidance);
    var link = document.createElement('a');
    link.href = safeExternalUrl(properties.officialUrl);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('context.mesoscaleSource');
    container.appendChild(link);
    return container;
  }

  function scheduleMesoscaleRefresh() {
    clearTimeout(mesoscaleRefreshTimer);
    mesoscaleRefreshTimer = null;
    if (!document.getElementById('toggle-mesoscale').checked) return;
    mesoscaleRefreshTimer = setTimeout(refreshMesoscale, StormScopeSpcReports.providers.mesoscale.refreshMs);
  }

  function contextQueryBounds() {
    var bounds = map.getBounds();
    return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
  }

  async function refreshMesoscale() {
    if (!document.getElementById('toggle-mesoscale').checked || document.hidden) return;
    if (mesoscaleAbort) mesoscaleAbort.abort();
    mesoscaleAbort = new AbortController();
    var generation = ++mesoscaleGeneration;
    var signal = mesoscaleAbort.signal;
    mesoscaleStatusState = 'loading';
    renderMesoscaleStatus();
    try {
      var result = await StormScopeSpcReports.fetchAllPages(function (url, options) {
        return fetch(url, options);
      }, 'mesoscale', null, contextQueryBounds(), signal);
      if (generation !== mesoscaleGeneration) return;
      var nextLayer = L.geoJSON(result.collection, {
        pane: 'contextVectorPane',
        style: function () { return StormScopeSpcReports.mesoscaleStyle(); },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return mesoscalePopup(feature); }, { autoPan: false, maxWidth: 390, maxHeight: 420 });
        }
      }).addTo(map);
      if (mesoscaleLayer) map.removeLayer(mesoscaleLayer);
      mesoscaleLayer = nextLayer;
      if (!mesoscaleAttributionAdded) {
        var provider = StormScopeSpcReports.providers.mesoscale;
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        mesoscaleAttributionAdded = true;
      }
      mesoscaleLatestAt = result.latestAt || Date.now();
      mesoscaleCount = result.collection.features.length;
      mesoscaleStatusState = 'ready';
      renderMesoscaleStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation !== mesoscaleGeneration) return;
      mesoscaleStatusState = 'error';
      renderMesoscaleStatus();
    } finally {
      if (generation === mesoscaleGeneration) scheduleMesoscaleRefresh();
    }
  }

  function disableMesoscale() {
    mesoscaleGeneration += 1;
    if (mesoscaleAbort) mesoscaleAbort.abort();
    clearTimeout(mesoscaleRefreshTimer);
    mesoscaleRefreshTimer = null;
    if (mesoscaleLayer) map.removeLayer(mesoscaleLayer);
    mesoscaleLayer = null;
    if (mesoscaleAttributionAdded) {
      var provider = StormScopeSpcReports.providers.mesoscale;
      map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
      mesoscaleAttributionAdded = false;
    }
    mesoscaleLatestAt = null;
    mesoscaleCount = 0;
    mesoscaleStatusState = 'off';
    renderMesoscaleStatus();
  }

  function renderStormReportStatus() {
    if (stormReportStatusState === 'off') {
      setContextStatusElement('storm-report-status', tr('context.stormReportsOff'), 'off');
      return;
    }
    if (stormReportStatusState === 'loading') {
      setContextStatusElement('storm-report-status', tr('context.loading'), 'loading');
      return;
    }
    if (stormReportStatusState === 'error') {
      setContextStatusElement('storm-report-status', tr(stormReportLayer ? 'context.refreshFailed' : 'context.unavailable'), 'error');
      return;
    }
    var provider = StormScopeSpcReports.providers.reports;
    setContextStatusElement('storm-report-status', tr('context.stormReportsStatus', {
      count: localNumber(stormReportCount), window: localNumber(stormReportWindow),
      freshness: freshnessLabel(stormReportLatestAt, provider.staleMs),
      time: stormReportLatestAt ? contextTimestamp(stormReportLatestAt) : tr('weather.unknown')
    }), 'ready');
  }

  function stormReportPopup(feature) {
    var properties = feature.properties || {};
    var container = document.createElement('div');
    container.className = 'context-popup';
    var title = document.createElement('strong');
    title.textContent = tr('context.stormReportFeature', { type: properties.reportType || tr('weather.unknown') });
    container.appendChild(title);
    if (properties.location || properties.state) {
      var location = document.createElement('span');
      location.textContent = tr('context.stormReportLocation', {
        location: [properties.location, properties.state].filter(Boolean).join(', ')
      });
      container.appendChild(location);
    }
    if (properties.magnitude) {
      var magnitude = document.createElement('span');
      magnitude.textContent = tr('context.stormReportMagnitude', {
        magnitude: properties.magnitude, unit: properties.units || ''
      }).trim();
      container.appendChild(magnitude);
    }
    if (properties.reportedAt) {
      var reported = document.createElement('span');
      reported.textContent = tr('context.stormReportReported', { time: contextTimestamp(properties.reportedAt) });
      container.appendChild(reported);
    }
    if (properties.sourceLabel) {
      var source = document.createElement('span');
      source.textContent = tr('context.stormReportSource', { source: properties.sourceLabel });
      container.appendChild(source);
    }
    if (properties.remarks) {
      var remarks = document.createElement('span');
      remarks.textContent = tr('context.stormReportRemarks', { remarks: properties.remarks });
      container.appendChild(remarks);
    }
    var link = document.createElement('a');
    link.href = safeExternalUrl(properties.officialUrl);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = tr('context.stormReportOfficial');
    container.appendChild(link);
    return container;
  }

  function createStormReportCluster() {
    return L.markerClusterGroup({
      maxClusterRadius: 44,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: 11,
      iconCreateFunction: function (cluster) {
        var count = cluster.getChildCount();
        return L.divIcon({
          html: '<div aria-label="' + count + ' local storm reports"><span>' + count + '</span></div>',
          className: 'storm-report-cluster', iconSize: L.point(34, 34)
        });
      }
    });
  }

  function scheduleStormReportRefresh() {
    clearTimeout(stormReportRefreshTimer);
    stormReportRefreshTimer = null;
    if (!document.getElementById('toggle-storm-reports').checked) return;
    stormReportRefreshTimer = setTimeout(refreshStormReports, StormScopeSpcReports.providers.reports.refreshMs);
  }

  async function refreshStormReports() {
    if (!document.getElementById('toggle-storm-reports').checked || document.hidden) return;
    if (stormReportAbort) stormReportAbort.abort();
    stormReportAbort = new AbortController();
    var generation = ++stormReportGeneration;
    var signal = stormReportAbort.signal;
    stormReportStatusState = 'loading';
    renderStormReportStatus();
    try {
      var result = await StormScopeSpcReports.fetchAllPages(function (url, options) {
        return fetch(url, options);
      }, 'reports', stormReportWindow, contextQueryBounds(), signal);
      if (generation !== stormReportGeneration) return;
      var nextLayer = createStormReportCluster();
      var points = L.geoJSON(result.collection, {
        pointToLayer: function (feature, latlng) {
          var style = StormScopeSpcReports.reportStyle(feature.properties.reportType);
          return L.marker(latlng, {
            pane: 'contextVectorPane',
            icon: L.divIcon({ html: '<span aria-hidden="true"></span>', className: style.className, iconSize: L.point(14, 14), iconAnchor: L.point(7, 7) })
          });
        },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(function () { return stormReportPopup(feature); }, { autoPan: false, maxWidth: 360, maxHeight: 420 });
        }
      });
      points.eachLayer(function (layer) { nextLayer.addLayer(layer); });
      nextLayer.addTo(map);
      if (stormReportLayer) map.removeLayer(stormReportLayer);
      stormReportLayer = nextLayer;
      if (!stormReportAttributionAdded) {
        var provider = StormScopeSpcReports.providers.reports;
        map.attributionControl.addAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
        stormReportAttributionAdded = true;
      }
      stormReportLatestAt = result.latestAt || Date.now();
      stormReportCount = result.collection.features.length;
      stormReportStatusState = 'ready';
      renderStormReportStatus();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation !== stormReportGeneration) return;
      stormReportStatusState = 'error';
      renderStormReportStatus();
    } finally {
      if (generation === stormReportGeneration) scheduleStormReportRefresh();
    }
  }

  function disableStormReports() {
    stormReportGeneration += 1;
    if (stormReportAbort) stormReportAbort.abort();
    clearTimeout(stormReportRefreshTimer);
    clearTimeout(stormReportMoveTimer);
    stormReportRefreshTimer = null;
    stormReportMoveTimer = null;
    if (stormReportLayer) map.removeLayer(stormReportLayer);
    stormReportLayer = null;
    if (stormReportAttributionAdded) {
      var provider = StormScopeSpcReports.providers.reports;
      map.attributionControl.removeAttribution('<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>');
      stormReportAttributionAdded = false;
    }
    stormReportLatestAt = null;
    stormReportCount = 0;
    stormReportStatusState = 'off';
    renderStormReportStatus();
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
      image.referrerPolicy = 'no-referrer';
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
    var provider = StormScopeRadarProviders.providers[radarProviderId];
    if (!frame || !provider || provider.tile.kind !== 'xyz') {
      radarSemanticState = StormScopeRadarProviders.classifyRadarState({ frame: frame, coverage: true });
      updateRadarTimeDisplay();
      return;
    }
    var token = ++radarSampleToken;
    var zoom = Math.min(map.getZoom(), provider.tile.maxNativeZoom);
    var coordinate = centerTileCoordinate(zoom);
    var coverageRequest = radarProviderId === 'rainviewer'
      ? sampleTilePixel(StormScopeRadarProviders.buildRainViewerCoverageUrl(
        radarHost, zoom, coordinate.x, coordinate.y
      ), coordinate)
      : Promise.resolve(null);
    var pixels = await Promise.all([coverageRequest, sampleTilePixel(
      StormScopeRadarProviders.buildXyzRadarTileUrl(frame, zoom, coordinate.x, coordinate.y),
      coordinate
    )]);
    if (token !== radarSampleToken || frame !== radarFrames[radarIndex]) return;
    var coveragePixel = pixels[0];
    var radarPixel = pixels[1];
    var intensity = StormScopeRadarProviders.classifyRainViewerPixel(radarPixel);
    var covered = radarProviderId !== 'rainviewer' ? true : coveragePixel
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
    syncWakeLockMonitoring();
  }

  function monitoringSessionActive() {
    var monitorModal = document.getElementById('monitor-modal');
    return Boolean(radarPlaying || satellitePlaying || activeCamera || mapComparison && mapComparison.isOpen() ||
      monitorModal && !monitorModal.classList.contains('hidden'));
  }

  function renderWakeLockState(snapshot) {
    var checkbox = document.getElementById('wake-lock-monitoring');
    var status = document.getElementById('wake-lock-status');
    if (!checkbox || !status) return;
    checkbox.disabled = !snapshot.supported;
    checkbox.checked = snapshot.enabled;
    status.dataset.state = snapshot.state;
    status.textContent = tr('wake.' + snapshot.state);
  }

  function syncWakeLockMonitoring() {
    if (wakeLockController) wakeLockController.setActive(monitoringSessionActive());
  }

  function initWakeLock() {
    wakeLockController = StormScopeWakeLock.create({
      navigator: navigator,
      document: document,
      onChange: renderWakeLockState
    });
    renderWakeLockState(wakeLockController.snapshot());
    teardownResources.push(wakeLockController);
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

  function refreshCameraSourceHealth() {
    if (!cameraStore) return;
    if (!cameraSourceHealth) cameraSourceHealthState = 'loading';
    renderCameraSourceHealth();
    cameraStore.loadSourceHealth().then(function (health) {
      cameraSourceHealth = health;
      cameraSourceHealthState = 'ready';
      renderCameraSourceHealth();
    }).catch(function (error) {
      if (error && error.name === 'AbortError') return;
      cameraSourceHealth = cameraStore.getSourceHealth();
      cameraSourceHealthState = cameraSourceHealth ? 'ready' : 'unavailable';
      diagnostics.capture(error, 'camera-source-health');
      renderCameraSourceHealth();
    });
  }

  function notifyValidatedCameraGeneration(result) {
    if (!result || !result.complete || result.source !== 'shards' || !result.index ||
        !/^[a-f0-9]{64}$/.test(String(result.index.dataset_sha256 || '')) ||
        !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function (registration) {
      var worker = navigator.serviceWorker.controller || registration.active;
      if (worker) worker.postMessage({
        type: 'STORMSCOPE_CAMERA_GENERATION_COMPLETE',
        generation: result.index.dataset_sha256
      });
    }).catch(function (error) {
      diagnostics.capture(error, 'camera-generation-cache');
    });
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
      var resumePromise = cameraStore.resume({ onProgress: handleCameraLoadProgress });
      refreshCameraSourceHealth();
      var result = await resumePromise;
      cameraLoadMetrics.completeMs = performance.now() - cameraLoadMetrics.startedAt;
      cameraLoadMetrics.source = result.source;
      cameraLoadMetrics.index = result.index;
      notifyValidatedCameraGeneration(result);
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
        monolithUrl: 'data/cameras.json',
        sourceHealthUrl: 'data/source-health.json'
      });
      var cameraLoadPromise = cameraStore.load({
        deferShards: dataPolicy.deferCameraCatalog,
        onProgress: handleCameraLoadProgress
      });
      refreshCameraSourceHealth();
      var result = await cameraLoadPromise;
      cameraLoadMetrics.completeMs = performance.now() - cameraLoadMetrics.startedAt;
      cameraLoadMetrics.source = result.source;
      cameraLoadMetrics.index = result.index;
      notifyValidatedCameraGeneration(result);
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
    renderCameraSourceHealth();
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

    // Helpful empty state once the corpus is loaded and a search/filter matches
    // nothing — a blank list reads as broken.
    if (!results.length && allCameras.length && !cameraCatalogDeferred) {
      var emptyItem = document.createElement('li');
      emptyItem.className = 'camera-result-empty';
      emptyItem.textContent = document.getElementById('camera-favorites').checked
        ? tr('search.noFavorites')
        : tr('search.noMatches');
      list.appendChild(emptyItem);
      return;
    }

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
      layers: StormScopeLayerRegistry.captureEnabled(document),
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
      Object.assign(snapshot, StormScopeLayerRegistry.captureControlState(document, 'profile'));
    }
    return snapshot;
  }

  function captureSharedScene() {
    var snapshot = captureViewSnapshot();
    var filters = cameraSearchFilters();
    return Object.assign({
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
      activeCameraId: activeCamera ? activeCamera.id : null
    }, StormScopeLayerRegistry.captureControlState(document, 'scene'));
  }

  function scheduleSceneHashWrite() {
    if (sceneHashApplying) return;
    clearTimeout(sceneHashTimer);
    sceneHashTimer = setTimeout(writeSceneHash, 500);
  }

  function writeSceneHash() {
    sceneHashTimer = null;
    if (sceneHashApplying || pendingSceneFrameTime != null || pendingSceneCameraId != null) return;
    try {
      var url = new URL(sharedSceneUrl());
      if (url.hash === location.hash) return;
      history.pushState({ stormscopeScene: true }, '', url.href);
    } catch (error) {
      diagnostics.capture(error, 'scene-hash-write');
    }
  }

  function sharedSceneUrl() {
    var url = new URL(location.href);
    url.hash = StormScopeSceneCodec.toHash(captureSharedScene());
    return url.toString();
  }

  function applySharedScene(scene) {
    if (activeCamera) closeCameraModal();
    applyViewSnapshot({
      center: { lat: scene.map.lat, lon: scene.map.lon },
      zoom: scene.map.zoom,
      layers: scene.layers,
      opacity: { radar: scene.radar.opacity },
      outlookDay: scene.outlookDay,
      convectiveDay: scene.convectiveDay,
      stormReportWindow: scene.stormReportWindow,
      earthquake: scene.earthquake
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
    applyPendingSceneFrameIfReady();
    resolvePendingSceneCamera();
    setSavedStateStatus(tr('views.sceneLoaded'));
  }

  function applyPendingSceneFrameIfReady() {
    if (pendingSceneFrameTime == null || !radarFrames.length) return;
    var nearestIndex = 0;
    var nearestDistance = Infinity;
    radarFrames.forEach(function (frame, index) {
      var distance = Math.abs(Number(frame.time) - pendingSceneFrameTime);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestDistance <= 30 * 60 * 1000) selectRadarFrame(nearestIndex);
    else setSavedStateStatus(tr('views.sceneFrameExpired'), true);
    pendingSceneFrameTime = null;
  }

  async function resolvePendingSceneCamera() {
    if (pendingSceneCameraId == null || !cameraStore || cameraLoadMetrics.completeMs == null) return;
    var cameraId = pendingSceneCameraId;
    pendingSceneCameraId = null;
    var camera = allCameras.find(function (candidate) { return String(candidate.id) === cameraId; });
    if (!camera && cameraCatalogDeferred) {
      try { camera = await cameraStore.loadCameraById(cameraId); } catch (error) { camera = null; }
      if (camera && !allCameras.some(function (candidate) { return String(candidate.id) === cameraId; })) {
        addCameraBatch([camera]);
      }
    }
    if (camera) openCameraModal(camera);
    else setSavedStateStatus(tr('views.sceneCameraUnavailable'), true);
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

  function applyLocationScene() {
    clearTimeout(sceneHashTimer);
    sceneHashTimer = null;
    var scene;
    try {
      scene = StormScopeSceneCodec.fromHash(location.hash);
    } catch (error) {
      diagnostics.capture(error, 'scene-navigation');
      setSavedStateStatus(tr('views.sceneInvalid'), true);
      return;
    }
    if (!scene) return;
    sceneHashApplying = true;
    try {
      applySharedScene(scene);
    } finally {
      sceneHashApplying = false;
    }
  }

  // Base (non-lifecycle) layer effects that cannot be expressed as refresh/disable bindings.
  // Every other layer is driven declaratively from the registry's lifecycle bindings, so adding
  // a new lifecycle layer never requires a new apply branch here.
  function applyBaseLayerEffect(id, enabled) {
    if (id === 'radar') {
      radarVisible = enabled;
      if (radarLayer) {
        if (enabled) radarLayer.addTo(map);
        else map.removeLayer(radarLayer);
      }
      return true;
    }
    if (id === 'cameras') {
      if (cameraCluster) {
        if (enabled) cameraCluster.addTo(map);
        else map.removeLayer(cameraCluster);
      }
      return true;
    }
    if (id === 'coverage') {
      if (radarHost) updateCoverageLayer();
      return true;
    }
    if (id === 'alerts') {
      alertsVisible = enabled;
      if (alertLayerGroup) {
        if (enabled) alertLayerGroup.addTo(map);
        else map.removeLayer(alertLayerGroup);
      }
      return true;
    }
    return false;
  }

  function applyLayerEnabled(descriptor, enabled, bindings) {
    var toggle = document.getElementById(descriptor.toggleId);
    if (toggle) toggle.checked = enabled;
    if (applyBaseLayerEffect(descriptor.id, enabled)) return;
    var binding = (bindings || operationalLayerRuntimeBindings())[descriptor.id];
    if (binding && typeof binding.refresh === 'function' && typeof binding.disable === 'function') {
      if (enabled) binding.refresh();
      else binding.disable();
    }
  }

  function applyViewSnapshot(snapshot) {
    if (!snapshot) return;
    StormScopeLayerRegistry.applyControlState(document, snapshot, 'profile');
    wpcOutlookDay = Number(document.getElementById('wpc-outlook-day').value);
    convectiveDay = Number(document.getElementById('convective-day').value);
    stormReportWindow = Number(document.getElementById('storm-report-window').value);
    map.setView([snapshot.center.lat, snapshot.center.lon], snapshot.zoom, { animate: false });
    var layers = snapshot.layers || {};
    var layerBindings = operationalLayerRuntimeBindings();
    StormScopeLayerRegistry.descriptors.forEach(function (descriptor) {
      var enabled = layers[descriptor.sceneKey];
      if (typeof enabled === 'boolean') applyLayerEnabled(descriptor, enabled, layerBindings);
    });
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
    renderLayerNavigation();
  }

  function setSavedStateStatus(message, error) {
    setRecoveryStatusText('saved-state-status', message, error);
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
    scheduleSceneHashWrite();
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

  function renderCameraSourceHealth() {
    var element = document.getElementById('camera-source-health');
    if (!element) return;
    if (!cameraSourceHealth) {
      element.dataset.status = cameraSourceHealthState;
      element.textContent = tr(cameraSourceHealthState === 'loading'
        ? 'camera.sourceHealthLoading'
        : 'camera.sourceHealthUnavailable');
      return;
    }
    var source = document.getElementById('camera-source').value;
    var summary = StormScopeCameraStore.summarizeSourceHealth(cameraSourceHealth, source);
    if (!summary) {
      element.dataset.status = 'unavailable';
      element.textContent = tr('camera.sourceHealthUnavailable');
      return;
    }
    var scope = source
      ? tr('camera.sourceHealthSelected', { source: tr('source.' + source) })
      : tr('camera.sourceHealthAll');
    var delta = summary.coverageDelta > 0
      ? '+' + localNumber(summary.coverageDelta)
      : localNumber(summary.coverageDelta);
    element.dataset.status = summary.failed
      ? 'failed'
      : summary.retained ? 'retained' : summary.fresh ? 'fresh' : 'unknown';
    element.textContent = tr('camera.sourceHealthSummary', {
      scope: scope,
      fresh: localNumber(summary.fresh),
      retained: localNumber(summary.retained),
      failed: localNumber(summary.failed),
      unknown: localNumber(summary.unknown),
      cameras: localNumber(summary.cameras),
      delta: delta
    }) + (summary.lastAttemptAt ? tr('camera.sourceHealthAttempt', {
      time: StormScopeI18n.formatDateTime(new Date(summary.lastAttemptAt), {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      }, appLocale)
    }) : '');
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
    if (e.key !== 'Tab') return;
    var modal = document.querySelector('.modal:not(.hidden) .modal-content');
    if (!modal) return;
    var focusable = getFocusableElements(modal);
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    // If focus has escaped the modal — e.g. the focused control was removed by a
    // feed re-render/retry (replaceChildren) and focus fell back to <body> — a
    // plain first/last check never matches, so pull focus back into the modal.
    if (!modal.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
      return;
    }

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
    syncWakeLockMonitoring();

    loadCameraFeed(cam, feedEl);
    fetchWeather(cam.lat, cam.lon, cam);
    scheduleSceneHashWrite();
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
    scheduleSceneHashWrite();
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
    syncWakeLockMonitoring();

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
    image.referrerPolicy = 'no-referrer';
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
    iframe.src = StormScopeCameraFeed.youtubeEmbedUrl(camera.url, 'enablejsapi=1', location.origin);
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
    video.referrerPolicy = 'no-referrer';
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

  function comparisonAlertColor(severity) {
    return { extreme: '#ff2d55', severe: '#ff7a00', moderate: '#ffd60a', minor: '#42a5f5' }[
      String(severity || '').toLowerCase()
    ] || '#a78bfa';
  }

  function comparisonTimeLabel(index) {
    var frame = radarFrames[Math.max(0, Math.min(radarFrames.length - 1, Number(index) || 0))];
    return frame ? StormScopeI18n.formatDateTime(frame.time, {
      hour: 'numeric', minute: '2-digit'
    }, appLocale) : tr('comparison.unavailable');
  }

  function comparisonRadarLayer(request) {
    if (!radarFrames.length || !radarProviderId) throw new Error(tr('comparison.radarUnavailable'));
    var index = Math.max(0, Math.min(radarFrames.length - 1, request.timeIndex));
    var frame = radarFrames[index];
    var provider = StormScopeRadarProviders.providers[radarProviderId];
    var attribution = '<a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' +
      provider.attribution.text + '</a>';
    var layer;
    if (provider.tile.kind === 'xyz') {
      layer = L.tileLayer(
        frame.tileHost + frame.path + '/256/{z}/{x}/{y}/' + RAINVIEWER_COLOR_SCHEME + '/1_1.png',
        {
          opacity: radarOpacity,
          maxNativeZoom: provider.tile.maxNativeZoom,
          maxZoom: 18,
          keepBuffer: 1,
          updateWhenIdle: true,
          crossOrigin: 'anonymous',
          attribution: attribution
        }
      );
      request.guardTileLayer(layer);
    } else if (provider.tile.kind === 'wms') {
      var params = StormScopeRadarProviders.noaaWmsParameters(frame);
      var options = {
        layers: params.layers,
        format: params.format,
        transparent: true,
        version: params.version,
        crs: L.CRS.EPSG3857,
        opacity: radarOpacity,
        maxZoom: 18,
        keepBuffer: 1,
        updateWhenIdle: true,
        crossOrigin: 'anonymous',
        attribution: attribution
      };
      if (params.time) options.time = params.time;
      layer = L.tileLayer.wms(provider.tile.endpoint, options);
      request.guardTileLayer(layer);
    } else {
      throw new Error(tr('comparison.radarUnavailable'));
    }
    return {
      layer: layer,
      message: provider.label + ' • ' + comparisonTimeLabel(index)
    };
  }

  function ensureComparisonSatelliteTime(request) {
    if (comparisonSatelliteTime) return Promise.resolve(comparisonSatelliteTime);
    if (!request.consumeRequest()) return Promise.reject(new Error(tr('comparison.requestBudget')));
    var provider = StormScopeContextLayers.providers.satellite;
    return fetchRadarJson(provider.imageServerUrl + '?f=pjson').then(function (metadata) {
      comparisonSatelliteTime = StormScopeContextLayers.parseGoesMetadata(metadata).latestTime;
      return comparisonSatelliteTime;
    });
  }

  function comparisonSatelliteLayer(request) {
    return ensureComparisonSatelliteTime(request).then(function (latestTime) {
      var bounds = request.map.getBounds();
      var requests = StormScopeContextLayers.buildGoesExportRequests({
        west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth()
      }, latestTime, request.map.getSize());
      var overlays = requests.map(function (item) {
        if (!request.consumeRequest()) throw new Error(tr('comparison.requestBudget'));
        return L.imageOverlay(item.url, item.bounds, {
          opacity: 0.6,
          crossOrigin: 'anonymous',
          interactive: false,
          attribution: '<a href="https://www.nesdis.noaa.gov/imagery/interactive-maps" target="_blank" rel="noopener noreferrer">NOAA NESDIS</a>'
        });
      });
      return {
        layer: L.layerGroup(overlays),
        message: 'NOAA GOES GeoColor • ' + StormScopeI18n.formatDateTime(latestTime, {
          hour: 'numeric', minute: '2-digit'
        }, appLocale)
      };
    });
  }

  function comparisonHazardLayer() {
    var features = activeAlerts.filter(function (alert) { return alert.geometry; }).map(function (alert) {
      return {
        type: 'Feature',
        geometry: alert.geometry,
        properties: { severity: alert.severity, event: alert.event || '' }
      };
    });
    var layer = L.geoJSON({ type: 'FeatureCollection', features: features }, {
      interactive: false,
      style: function (feature) {
        var color = comparisonAlertColor(feature.properties.severity);
        return { color: color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.16 };
      }
    });
    return {
      layer: layer,
      message: tr(features.length === 1 ? 'comparison.hazardOne' : 'comparison.hazardMany', {
        count: localNumber(features.length)
      })
    };
  }

  function createComparisonLayer(request) {
    if (request.source === 'radar') return comparisonRadarLayer(request);
    if (request.source === 'satellite') return comparisonSatelliteLayer(request);
    return comparisonHazardLayer();
  }

  function updateComparisonBudgetStatus() {
    if (!mapComparison || !mapComparison.isOpen()) return;
    var metrics = mapComparison.metrics();
    document.getElementById('comparison-budget-status').textContent = tr('comparison.budget', {
      requests: localNumber(metrics.requestBudget.used),
      limit: localNumber(metrics.requestBudget.limit),
      memory: localNumber(Math.ceil(metrics.estimatedDecodedBytes / 1048576)),
      memoryLimit: localNumber(metrics.maxEstimatedMemoryBytes / 1048576)
    });
  }

  function pauseOperationalWorkForComparison() {
    comparisonRadarWasPlaying = radarPlaying;
    satelliteWasPlaying = satellitePlaying;
    setRadarPlaying(false);
    setSatellitePlaying(false);
    clearInterval(radarRefreshTimer);
    radarRefreshTimer = null;
    operationalControllers.suspend();
  }

  function resumeOperationalWorkAfterComparison() {
    if (document.hidden) return;
    startRadarRefreshTimer();
    initRadar().then(function () {
      if (comparisonRadarWasPlaying && radarVisible && radarFrames.length) setRadarPlaying(true);
      if (satelliteWasPlaying && satelliteFrames.length && !lowDataMode) setSatellitePlaying(true);
      comparisonRadarWasPlaying = false;
      satelliteWasPlaying = false;
    });
    operationalControllers.refreshEnabled();
  }

  function ensureMapComparison() {
    if (mapComparison) return mapComparison;
    var modal = document.getElementById('comparison-modal');
    mapComparison = StormScopeMapComparison.create({
      L: L,
      modal: modal,
      mainMap: map,
      basemapUrl: function () { return basemapTileUrl(document.documentElement.dataset.theme); },
      layerFactory: createComparisonLayer,
      formatTimeLabel: comparisonTimeLabel,
      isLowData: function () { return lowDataMode; },
      loadingLabel: tr('comparison.loading'),
      lowDataSuspendedLabel: tr('comparison.lowDataSuspended'),
      onOpen: function () {
        pauseOperationalWorkForComparison();
        setModalBackgroundInert(true, modal);
        document.addEventListener('keydown', trapFocus);
        comparisonMetricsTimer = setInterval(updateComparisonBudgetStatus, 500);
        updateComparisonBudgetStatus();
        syncWakeLockMonitoring();
      },
      onClose: function () {
        clearInterval(comparisonMetricsTimer);
        comparisonMetricsTimer = null;
        setModalBackgroundInert(false, modal);
        document.removeEventListener('keydown', trapFocus);
        document.getElementById('comparison-budget-status').textContent = '';
        resumeOperationalWorkAfterComparison();
        syncWakeLockMonitoring();
      }
    });
    return mapComparison;
  }

  function openMapComparison() {
    if (activeCamera) closeCameraModal();
    closeMonitor(false);
    var latest = Math.max(0, radarFrames.length - 1);
    var ranges = document.querySelectorAll('[data-comparison-time]');
    ranges.forEach(function (range) {
      range.max = String(latest);
      range.value = String(latest);
    });
    document.getElementById('layers-panel').classList.add('hidden');
    document.getElementById('btn-layers').setAttribute('aria-expanded', 'false');
    ensureMapComparison().open(document.getElementById('open-comparison'));
  }

  function closeMapComparison(restoreFocus) {
    if (mapComparison) mapComparison.close(restoreFocus);
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
    syncWakeLockMonitoring();
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
      syncWakeLockMonitoring();
    }
  }

  function loadCameraFeed(cam, container) {
    cameraFeed.load(cam, container);
  }

  function destroyActiveFeed(container) {
    cameraFeed.destroy(container);
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
    var airQualityPromise = fetchAirQuality(lat, lon, signal).then(function (data) {
      return { data: data };
    }).catch(function (error) {
      return error && error.name === 'AbortError' ? { aborted: true } : { error: error };
    });

    if (StormScopeWeather.shouldUseNws(cam)) {
      try {
        await fetchWeatherNWS(lat, lon, cam, signal, weatherLoading, weatherData);
      } catch (error) {
        if (error.name === 'AbortError') return;
        await fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData, true);
      }
    } else {
      await fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData, false);
    }

    var airQualityResult = await airQualityPromise;
    if (activeCamera !== cam || airQualityResult.aborted) return;
    appendWeatherSection(weatherData, {
      heading: tr('weather.airQualityHeading'),
      items: airQualityResult.data ? airQualityItems(airQualityResult.data) : null,
      status: airQualityResult.data ? null : tr('weather.airQualityUnavailable')
    });
    weatherLoading.classList.add('hidden');
    weatherData.classList.remove('hidden');
  }

  async function fetchAirQuality(lat, lon, signal) {
    var response = await fetch(StormScopeWeather.buildAirQualityUrl(lat, lon), { signal: signal });
    if (!response.ok) throw new Error('Open-Meteo Air Quality failed');
    var data = StormScopeWeather.normalizeAirQuality(await response.json());
    if (!data) throw new Error('No current air quality data');
    return data;
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
    // Derive a next-12-hour high/low from the hourly periods already fetched (no extra request)
    // so the panel can communicate the forecast range, not just a single point value.
    var window = periods.slice(0, 12);
    var temps = window.map(function (item) { return item.temperature; })
      .filter(function (value) { return typeof value === 'number'; });
    var range = temps.length
      ? { high: Math.max.apply(null, temps), low: Math.min.apply(null, temps), unit: periods[0].temperatureUnit }
      : null;
    return { period: periods[0], updatedAt: data.properties.updateTime, range: range };
  }

  function forecastTemperature(value, unit) {
    return unit === 'F'
      ? StormScopeWeather.temperatureFromFahrenheit(value, weatherUnits)
      : Math.round(value) + '°' + unit;
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
    var temperature = forecastTemperature(current.temperature, current.temperatureUnit);
    var precip = current.probabilityOfPrecipitation && current.probabilityOfPrecipitation.value;
    var range = forecast.range
      ? forecastTemperature(forecast.range.high, forecast.range.unit) + ' / ' +
        forecastTemperature(forecast.range.low, forecast.range.unit)
      : tr('weather.notAvailable');
    return [
      [tr('weather.temperature'), temperature],
      [tr('weather.forecastRange'), range],
      [tr('weather.conditionsProvider'), current.shortForecast],
      [tr('weather.precipChance'), precip != null
        ? localNumber(precip) + '%' : tr('weather.notAvailable')],
      [tr('weather.wind'), StormScopeWeather.windFromMph(current.windSpeed, weatherUnits) + ' ' + localizedWindDirection(current.windDirection)],
      [tr('weather.humidity'), current.relativeHumidity && current.relativeHumidity.value != null
        ? localNumber(current.relativeHumidity.value) + '%' : tr('weather.notAvailable')],
      [tr('weather.forecastIssued'), localTime(forecast.updatedAt)],
      [tr('weather.forecastValid'), localTime(current.startTime)],
      [tr('weather.source'), tr('weather.nwsForecast')]
    ];
  }

  function airQualityItems(airQuality) {
    var primary = airQuality.primaryPollutant;
    var primaryValue = primary
      ? tr('weather.aqiPrimaryValue', {
        pollutant: tr('weather.aqi.pollutant.' + primary.id),
        concentration: primary.concentration === null
          ? tr('weather.notAvailable') : localNumber(primary.concentration) + ' μg/m³',
        aqi: primary.aqi === null ? tr('weather.notAvailable') : localNumber(primary.aqi)
      })
      : tr('weather.notAvailable');
    return [
      [tr('weather.aqi'), localNumber(airQuality.usAqi) + ' • ' + tr('weather.aqi.category.' + airQuality.category)],
      [tr('weather.aqiPrimary'), primaryValue],
      [tr('weather.aqiUpdated'), StormScopeWeather.formatOpenMeteoTime(
        airQuality.time, airQuality.utcOffsetSeconds, appLocale, tr('weather.unknown'))],
      [tr('weather.source'), tr('weather.openMeteoAirQuality')]
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

  function createWeatherSection(section) {
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
    return container;
  }

  function appendWeatherSection(dataEl, section) {
    dataEl.appendChild(createWeatherSection(section));
  }

  function showWeatherSections(loadingEl, dataEl, sections) {
    dataEl.replaceChildren();
    dataEl.classList.remove('weather-data-flat');
    sections.forEach(function (section) {
      appendWeatherSection(dataEl, section);
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
      var signature = activeAlerts.map(function (alert) {
        return alert.dedupeKey + '@' + alert.sent;
      }).sort().join('|');
      var idle = activeAlerts.length === 0 || signature === alertResultSignature;
      alertResultSignature = signature;
      alertRetryMetadata = StormScopeNwsAlerts.successMetadata(undefined, {
        idle: idle, previous: alertRetryMetadata
      });
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

  function savedLocationAlertTargets() {
    if (!savedStore) return [];
    var byKey = Object.create(null);
    savedStore.listViews().forEach(function (view) {
      var center = view && view.snapshot && view.snapshot.center;
      var latitude = Number(center && center.lat);
      var longitude = Number(center && center.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
          !StormScopeWeather.inNwsCoverageBounds(latitude, longitude)) return;
      var key = latitude.toFixed(4) + ',' + longitude.toFixed(4);
      if (!byKey[key]) byKey[key] = { key: key, center: { lat: latitude, lon: longitude }, names: [] };
      if (view.name && byKey[key].names.indexOf(view.name) === -1) byKey[key].names.push(view.name);
    });
    return Object.keys(byKey).slice(0, SAVED_LOCATION_ALERT_CAP).map(function (key) { return byKey[key]; });
  }

  function savedLocationAlertSignature(alert) {
    return [alert.dedupeKey, alert.sentMs == null ? (alert.sent || alert.id) : alert.sentMs, alert.messageType].join('@');
  }

  function savedLocationAlertLocation(target) {
    return target.names.join(' / ') || target.key;
  }

  function renderSavedLocationAlertBanner() {
    var banner = document.getElementById('saved-location-alert-banner');
    if (!banner) return;
    if (!savedLocationAlertNotices.length) {
      banner.classList.add('hidden');
      return;
    }
    var first = savedLocationAlertNotices[0];
    var location = savedLocationAlertLocation(first.target);
    document.getElementById('saved-location-alert-heading').textContent = savedLocationAlertNotices.length === 1
      ? tr('alerts.savedLocationOne', { location: location })
      : tr('alerts.savedLocationMany', { count: localNumber(savedLocationAlertNotices.length) });
    document.getElementById('saved-location-alert-message').textContent = savedLocationAlertNotices.slice(0, 3).map(function (notice) {
      return tr('alerts.savedLocationNotice', {
        event: notice.alert.event || tr('alerts.weatherAlert'),
        location: savedLocationAlertLocation(notice.target)
      });
    }).join(' • ');
    document.getElementById('saved-location-alert-review').textContent = tr('alerts.savedLocationReview');
    document.getElementById('saved-location-alert-dismiss').textContent = tr('alerts.savedLocationDismiss');
    banner.classList.remove('hidden');
  }

  function dismissSavedLocationAlerts() {
    savedLocationAlertNotices = [];
    renderSavedLocationAlertBanner();
  }

  function reviewSavedLocationAlerts() {
    var notice = savedLocationAlertNotices[0];
    if (!notice) return;
    var center = notice.target.center;
    dismissSavedLocationAlerts();
    if (!alertsVisible) {
      alertsVisible = true;
      document.getElementById('toggle-alerts').checked = true;
      scheduleLastViewSave();
    }
    map.setView([center.lat, center.lon], Math.max(map.getZoom(), 7), { animate: false });
    fetchNwsAlerts();
    openAlertsFromSummary();
  }

  function scheduleSavedLocationAlertPoll(delay) {
    clearTimeout(savedLocationAlertTimer);
    savedLocationAlertTimer = null;
    if (document.hidden || !savedStore || !savedLocationAlertTargets().length) return;
    var wait = delay == null ? 0 : Number(delay);
    if (!Number.isFinite(wait) || wait < 0) wait = 0;
    savedLocationAlertTimer = setTimeout(refreshSavedLocationAlerts, wait);
  }

  function restartSavedLocationAlertPolling() {
    if (savedLocationAlertAbort) savedLocationAlertAbort.abort();
    scheduleSavedLocationAlertPoll(0);
  }

  async function refreshSavedLocationAlerts() {
    if (document.hidden || !savedStore) return;
    var targets = savedLocationAlertTargets();
    if (!targets.length) {
      clearTimeout(savedLocationAlertTimer);
      savedLocationAlertTimer = null;
      savedLocationAlertSeen = Object.create(null);
      savedLocationAlertNotices = [];
      renderSavedLocationAlertBanner();
      return;
    }
    if (savedLocationAlertAbort) savedLocationAlertAbort.abort();
    var controller = new AbortController();
    savedLocationAlertAbort = controller;
    var signal = controller.signal;
    var nextDelay = null;
    try {
      var results = await Promise.allSettled(targets.map(function (target) {
        return fetchAlertPayload(StormScopeNwsAlerts.buildPointQuery(target.center.lat, target.center.lon), signal);
      }));
      if (signal.aborted || document.hidden) return;
      var failures = [];
      var successes = 0;
      var newNotices = [];
      var targetByKey = Object.create(null);
      targets.forEach(function (target) { targetByKey[target.key] = target; });
      results.forEach(function (result, index) {
        var target = targets[index];
        if (result.status !== 'fulfilled') {
          if (!result.reason || result.reason.name !== 'AbortError') failures.push(result.reason || new Error('NWS alert request failed'));
          return;
        }
        successes += 1;
        var previous = savedLocationAlertSeen[target.key];
        var current = Object.create(null);
        StormScopeNwsAlerts.normalizeCollection(result.value || { features: [] }).forEach(function (alert) {
          var signature = savedLocationAlertSignature(alert);
          current[signature] = true;
          if (previous && !previous[signature]) {
            newNotices.push({ key: target.key + '@' + signature, target: target, alert: alert });
          }
        });
        savedLocationAlertSeen[target.key] = current;
      });
      Object.keys(savedLocationAlertSeen).forEach(function (key) {
        if (!targetByKey[key]) delete savedLocationAlertSeen[key];
      });
      savedLocationAlertNotices = savedLocationAlertNotices.filter(function (notice) {
        return Boolean(targetByKey[notice.target.key]);
      }).map(function (notice) {
        notice.target = targetByKey[notice.target.key];
        return notice;
      });
      var noticeKeys = Object.create(null);
      savedLocationAlertNotices = newNotices.concat(savedLocationAlertNotices).filter(function (notice) {
        if (noticeKeys[notice.key]) return false;
        noticeKeys[notice.key] = true;
        return true;
      }).slice(0, 8);
      renderSavedLocationAlertBanner();
      if (failures.length || successes < targets.length) {
        savedLocationAlertRetryMetadata = StormScopeNwsAlerts.nextRetryMetadata(
          savedLocationAlertRetryMetadata, failures[0] || new Error('NWS alert request failed'));
      } else {
        savedLocationAlertRetryMetadata = StormScopeNwsAlerts.successMetadata(undefined, {
          idle: newNotices.length === 0, previous: savedLocationAlertRetryMetadata
        });
      }
      nextDelay = savedLocationAlertRetryMetadata.delayMs;
    } catch (error) {
      if (error.name === 'AbortError') return;
      savedLocationAlertRetryMetadata = StormScopeNwsAlerts.nextRetryMetadata(savedLocationAlertRetryMetadata, error);
      nextDelay = savedLocationAlertRetryMetadata.delayMs;
    } finally {
      if (savedLocationAlertAbort === controller) {
        savedLocationAlertAbort = null;
        if (!signal.aborted && !document.hidden) scheduleSavedLocationAlertPoll(nextDelay);
      }
    }
  }

  function getSavedLocationAlertState() {
    return {
      targetCount: savedLocationAlertTargets().length,
      noticeCount: savedLocationAlertNotices.length,
      polling: Boolean(savedLocationAlertTimer),
      inFlight: Boolean(savedLocationAlertAbort),
      retry: savedLocationAlertRetryMetadata ? Object.assign({}, savedLocationAlertRetryMetadata) : null
    };
  }

  function alertColor(alert) {
    if (alert.severity === 'Extreme') return '#ff2d55';
    if (alert.severity === 'Severe') return '#ff7b00';
    if (alert.severity === 'Moderate') return '#ffd166';
    return '#70d6ff';
  }

  function alertImpactRows(alert) {
    return (alert.impactParameters || []).map(function (parameter) {
      var labelKey = 'alerts.impact.' + parameter.kind;
      var label = tr(labelKey);
      if (!parameter.value || label === labelKey) return null;
      return { kind: parameter.kind, label: label, value: parameter.value };
    }).filter(Boolean);
  }

  function appendAlertImpactDetails(container, alert) {
    var rows = alertImpactRows(alert);
    if (!rows.length) return;
    var section = document.createElement('section');
    section.className = 'alert-impact-details';
    section.setAttribute('aria-labelledby', 'alert-impact-heading');
    var heading = document.createElement('h4');
    heading.id = 'alert-impact-heading';
    heading.textContent = tr('alerts.impact.heading');
    var list = document.createElement('dl');
    rows.forEach(function (row) {
      var item = document.createElement('div');
      var term = document.createElement('dt');
      var description = document.createElement('dd');
      term.textContent = row.label;
      description.textContent = row.value;
      item.appendChild(term);
      item.appendChild(description);
      list.appendChild(item);
    });
    section.appendChild(heading);
    section.appendChild(list);
    container.appendChild(section);
  }

  function renderAlerts() {
    var panel = document.getElementById('alerts-panel');
    var list = document.getElementById('alerts-list');
    var status = document.getElementById('alerts-status');
    list.replaceChildren();
    if (!alertLayerGroup) alertLayerGroup = L.layerGroup();
    if (alertsVisible && !map.hasLayer(alertLayerGroup)) alertLayerGroup.addTo(map);
    var nextLayersById = Object.create(null);

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
      var impactSummary = alertImpactRows(alert).filter(function (row) {
        return /DamageThreat$/.test(row.kind);
      }).slice(0, 1);
      impactSummary.forEach(function (row) {
        var impact = document.createElement('span');
        impact.className = 'alert-impact-summary';
        impact.textContent = row.label + ': ' + row.value;
        button.appendChild(impact);
      });
      button.appendChild(summary);
      button.addEventListener('click', function () { showAlertDetail(alert, true, button); });
      item.appendChild(button);
      list.appendChild(item);

      if (alert.geometry) {
        var signature = alert.severity + ':' + JSON.stringify(alert.geometry);
        var layer = alertLayersById[alert.id];
        if (!layer || layer._stormscopeSignature !== signature) {
          if (layer) alertLayerGroup.removeLayer(layer);
          layer = L.geoJSON(alert.geometry, {
            style: {
              color: alertColor(alert),
              weight: alert.severity === 'Extreme' ? 4 : 3,
              opacity: 0.9,
              fillOpacity: 0.12
            }
          });
          layer._stormscopeSignature = signature;
          layer.on('click', function () { showAlertDetail(this._stormscopeAlert, false); });
          layer.addTo(alertLayerGroup);
        }
        layer._stormscopeAlert = alert;
        nextLayersById[alert.id] = layer;
      }
    });

    Object.keys(alertLayersById).forEach(function (alertId) {
      if (!nextLayersById[alertId]) alertLayerGroup.removeLayer(alertLayersById[alertId]);
    });
    alertLayersById = nextLayersById;

    status.textContent = activeAlerts.length
      ? tr(activeAlerts.length === 1 ? 'alerts.countOne' : 'alerts.countMany', { count: localNumber(activeAlerts.length) })
      : tr('alerts.none');
    var navAlertCount = document.getElementById('nav-alert-count');
    navAlertCount.textContent = activeAlerts.length > 99 ? '99+' : localNumber(activeAlerts.length);
    navAlertCount.classList.toggle('hidden', activeAlerts.length === 0);
    document.getElementById('btn-alerts').setAttribute('aria-label', tr('nav.alerts') +
      (activeAlerts.length ? ' (' + localNumber(activeAlerts.length) + ')' : ''));
    syncAlertsPanelVisibility();
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
    appendAlertImpactDetails(detail, alert);
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
    alertsPanelDismissed = false;
    syncAlertsPanelVisibility();
    var panel = document.getElementById('alerts-panel');
    var first = panel.querySelector('.alert-list-button');
    if (first) first.focus();
  }

  function readAlertFromSummary(alert) {
    document.getElementById('situation-panel').classList.add('hidden');
    document.getElementById('btn-summary').setAttribute('aria-expanded', 'false');
    alertsPanelDismissed = false;
    syncAlertsPanelVisibility();
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
    var opening = toggleTopLevelPanel('situation-panel', 'btn-summary');
    if (!opening) return;
    if (summaryWildfireStatus === 'error') summaryWildfireStatus = 'idle';
    renderSituationSummary(true);
    document.getElementById('situation-heading').focus({ preventScroll: true });
  }

  // ── UI Bindings ──

  function normalizeLayerFilterText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase(appLocale).trim();
  }

  function layerFilterText(descriptor) {
    var keys = [descriptor.labelKey, descriptor.groupLabelKey]
      .concat(descriptor.searchKeys)
      .concat(descriptor.controls.map(function (control) { return control.labelKey; }));
    return normalizeLayerFilterText(keys.map(function (key) { return tr(key); }).join(' '));
  }

  function renderLayerNavigation() {
    var queryInput = document.getElementById('layer-filter-query');
    var activeInput = document.getElementById('layer-filter-active');
    if (!queryInput || !activeInput) return;
    var query = normalizeLayerFilterText(queryInput.value);
    var activeOnly = activeInput.checked;
    var visibleCount = 0;
    var visibleGroups = Object.create(null);

    StormScopeLayerRegistry.descriptors.forEach(function (descriptor) {
      var toggle = document.getElementById(descriptor.toggleId);
      var visible = (!query || layerFilterText(descriptor).indexOf(query) !== -1) &&
        (!activeOnly || Boolean(toggle && toggle.checked));
      document.querySelectorAll('[data-layer-id="' + descriptor.id + '"]').forEach(function (element) {
        element.hidden = !visible;
      });
      if (visible) {
        visibleCount += 1;
        visibleGroups[descriptor.groupId] = true;
      }
    });

    document.querySelectorAll('[data-layer-section]').forEach(function (heading) {
      heading.hidden = !visibleGroups[heading.dataset.layerSection];
    });
    document.getElementById('layer-filter-count').textContent = tr('layers.filterCount', {
      count: localNumber(visibleCount), total: localNumber(StormScopeLayerRegistry.descriptors.length)
    });
    document.getElementById('layer-filter-clear').disabled = !query && !activeOnly;
    document.getElementById('layer-filter-empty').hidden = visibleCount !== 0;
  }

  function clearLayerNavigation() {
    document.getElementById('layer-filter-query').value = '';
    document.getElementById('layer-filter-active').checked = false;
    renderLayerNavigation();
  }

  function initLayerNavigation() {
    var panel = document.getElementById('layers-panel');
    var queryInput = document.getElementById('layer-filter-query');
    var activeInput = document.getElementById('layer-filter-active');
    var clearButton = document.getElementById('layer-filter-clear');
    var toggleIds = Object.create(null);
    StormScopeLayerRegistry.descriptors.forEach(function (descriptor) { toggleIds[descriptor.toggleId] = true; });
    queryInput.addEventListener('input', renderLayerNavigation);
    activeInput.addEventListener('change', renderLayerNavigation);
    clearButton.addEventListener('click', function () {
      clearLayerNavigation();
      queryInput.focus();
    });
    queryInput.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && (queryInput.value || activeInput.checked)) {
        event.preventDefault();
        event.stopPropagation();
        clearLayerNavigation();
      }
    });
    panel.addEventListener('change', function (event) {
      if (toggleIds[event.target.id]) renderLayerNavigation();
    });
    renderLayerNavigation();
  }

  var TOP_LEVEL_PANELS = Object.freeze([
    Object.freeze({ panel: 'search-panel', toggle: 'btn-search' }),
    Object.freeze({ panel: 'situation-panel', toggle: 'btn-summary' }),
    Object.freeze({ panel: 'layers-panel', toggle: 'btn-layers' })
  ]);

  function topLevelPanelIsOpen() {
    return TOP_LEVEL_PANELS.some(function (entry) {
      return !document.getElementById(entry.panel).classList.contains('hidden');
    });
  }

  function syncPrimaryNavigation() {
    var selectedId = 'btn-radar';
    TOP_LEVEL_PANELS.some(function (entry) {
      if (document.getElementById(entry.panel).classList.contains('hidden')) return false;
      selectedId = entry.toggle;
      return true;
    });
    if (selectedId === 'btn-radar' && !document.getElementById('alerts-panel').classList.contains('hidden')) {
      selectedId = 'btn-alerts';
    }
    document.querySelectorAll('.primary-nav-btn').forEach(function (button) {
      var selected = button.id === selectedId;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function syncAlertsPanelVisibility() {
    var hidden = !alertsVisible || alertsPanelDismissed || topLevelPanelIsOpen();
    document.getElementById('alerts-panel').classList.toggle('hidden', hidden);
    document.getElementById('btn-alerts').setAttribute('aria-expanded', String(!hidden));
    syncPrimaryNavigation();
  }

  function showRadarCanvas() {
    TOP_LEVEL_PANELS.forEach(function (entry) {
      document.getElementById(entry.panel).classList.add('hidden');
      document.getElementById(entry.toggle).setAttribute('aria-expanded', 'false');
    });
    alertsPanelDismissed = true;
    syncAlertsPanelVisibility();
  }

  function toggleAlertsPanel() {
    TOP_LEVEL_PANELS.forEach(function (entry) {
      document.getElementById(entry.panel).classList.add('hidden');
      document.getElementById(entry.toggle).setAttribute('aria-expanded', 'false');
    });
    alertsPanelDismissed = !document.getElementById('alerts-panel').classList.contains('hidden');
    syncAlertsPanelVisibility();
  }

  function toggleTopLevelPanel(panelId, toggleId) {
    var panel = document.getElementById(panelId);
    var opening = panel.classList.contains('hidden');
    TOP_LEVEL_PANELS.forEach(function (entry) {
      var open = opening && entry.panel === panelId;
      document.getElementById(entry.panel).classList.toggle('hidden', !open);
      document.getElementById(entry.toggle).setAttribute('aria-expanded', String(open));
    });
    syncAlertsPanelVisibility();
    return opening;
  }

  // Close the alerts drawer if it is showing, returning focus to its nav button so
  // Escape behaves consistently with the other header-toggled surfaces.
  function closeAlertsDrawer() {
    if (document.getElementById('alerts-panel').classList.contains('hidden')) return false;
    alertsPanelDismissed = true;
    syncAlertsPanelVisibility();
    document.getElementById('btn-alerts').focus();
    return true;
  }

  // Close a header-toggled panel (search/layers) if it is open, returning focus
  // to its toggle button so keyboard and screen-reader users keep their place.
  function closeOpenPanel(panelId, toggleId) {
    var panel = document.getElementById(panelId);
    if (panel.classList.contains('hidden')) return false;
    panel.classList.add('hidden');
    var toggle = document.getElementById(toggleId);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
    syncAlertsPanelVisibility();
    return true;
  }

  // ── Geolocation "locate me" ──
  // Centers the map on the device location. Coordinates are used only for the
  // in-session map view and a transient marker — never stored, shared, or added
  // to scene links.
  var locateMarker = null;
  var locateMarkerTimer = null;

  function announceLocate(message) {
    var el = document.getElementById('locate-announcer');
    if (el) el.textContent = message;
  }

  function clearLocateMarker() {
    clearTimeout(locateMarkerTimer);
    locateMarkerTimer = null;
    if (locateMarker) {
      map.removeLayer(locateMarker);
      locateMarker = null;
    }
  }

  function locateMe() {
    var button = document.getElementById('btn-locate');
    if (!navigator.geolocation) {
      announceLocate(tr('locate.unsupported'));
      return;
    }
    button.disabled = true;
    announceLocate(tr('locate.searching'));
    navigator.geolocation.getCurrentPosition(function (position) {
      button.disabled = false;
      var lat = position.coords.latitude;
      var lon = position.coords.longitude;
      map.setView([lat, lon], Math.max(map.getZoom(), 9), { animate: !prefersReducedMotion() });
      clearLocateMarker();
      locateMarker = L.circleMarker([lat, lon], {
        radius: 9, color: '#4dabf7', weight: 3, fillColor: '#4dabf7', fillOpacity: 0.35
      }).addTo(map);
      locateMarkerTimer = setTimeout(clearLocateMarker, 15000);
      announceLocate(tr('locate.found'));
    }, function (error) {
      button.disabled = false;
      var key = error && error.code === error.PERMISSION_DENIED ? 'locate.denied'
        : error && error.code === error.TIMEOUT ? 'locate.timeout'
          : 'locate.unavailable';
      announceLocate(tr(key));
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  }

  // ── Place / address geocoding search ──
  // Keyless OSM geocoding (Photon primary, Nominatim fallback). Queries are
  // debounced to respect provider rate limits; results pan the map only and are
  // never stored, shared, or added to scene links.
  var placeSearchTimer = null;
  var placeSearchAbort = null;
  var placeResults = [];
  var placeActiveIndex = -1;

  function searchPanelHidden() {
    return document.getElementById('search-panel').classList.contains('hidden');
  }

  // Cancels any pending debounce and in-flight geocode request. Called on
  // teardown (unload, tab hide) and whenever the search surface closes so a
  // late response can never re-render into a hidden panel or fire a stray
  // aria-live announcement.
  function resetPlaceSearch() {
    clearTimeout(placeSearchTimer);
    placeSearchTimer = null;
    if (placeSearchAbort) {
      placeSearchAbort.abort();
      placeSearchAbort = null;
    }
  }

  function clearPlaceResults() {
    placeResults = [];
    placeActiveIndex = -1;
    document.getElementById('place-results').replaceChildren();
    var input = document.getElementById('place-query');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  // WAI-ARIA combobox pattern: focus stays in the input; the active option is
  // tracked via aria-activedescendant rather than moving DOM focus.
  function setActivePlaceResult(index) {
    var list = document.getElementById('place-results');
    var input = document.getElementById('place-query');
    Array.prototype.forEach.call(list.children, function (child, i) {
      var active = i === index;
      child.classList.toggle('active', active);
      child.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    placeActiveIndex = index;
    if (index >= 0 && list.children[index]) {
      input.setAttribute('aria-activedescendant', 'place-result-' + index);
      list.children[index].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function selectPlaceResult(result) {
    if (!result) return;
    resetPlaceSearch();
    map.setView([result.lat, result.lon], Math.max(map.getZoom(), 11), { animate: !prefersReducedMotion() });
    document.getElementById('place-status').textContent = tr('place.centered', { place: result.label });
    clearPlaceResults();
  }

  function renderPlaceResults(results) {
    if (searchPanelHidden()) return;
    placeResults = results;
    placeActiveIndex = -1;
    var list = document.getElementById('place-results');
    var input = document.getElementById('place-query');
    list.replaceChildren();
    results.forEach(function (result, index) {
      var item = document.createElement('li');
      item.className = 'place-result';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.id = 'place-result-' + index;
      item.textContent = result.label;
      item.addEventListener('click', function () { selectPlaceResult(result); });
      list.appendChild(item);
    });
    input.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    input.removeAttribute('aria-activedescendant');
    document.getElementById('place-status').textContent = results.length
      ? tr('place.results', { count: localNumber(results.length) })
      : tr('place.noResults');
  }

  async function runPlaceSearch(query) {
    if (placeSearchAbort) placeSearchAbort.abort();
    placeSearchAbort = new AbortController();
    var signal = placeSearchAbort.signal;
    document.getElementById('place-status').textContent = tr('place.searching');
    try {
      var response = await fetch(StormScopeGeocode.photonUrl(query), { signal: signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      renderPlaceResults(StormScopeGeocode.parsePhoton(await response.json()));
    } catch (photonError) {
      if (photonError.name === 'AbortError') return;
      try {
        var fallback = await fetch(StormScopeGeocode.nominatimUrl(query), { signal: signal });
        if (!fallback.ok) throw new Error('HTTP ' + fallback.status);
        renderPlaceResults(StormScopeGeocode.parseNominatim(await fallback.json()));
      } catch (nominatimError) {
        if (nominatimError.name === 'AbortError') return;
        if (searchPanelHidden()) return;
        clearPlaceResults();
        document.getElementById('place-status').textContent = tr('place.error');
      }
    }
  }

  function schedulePlaceSearch() {
    var query = StormScopeGeocode.normalizeQuery(document.getElementById('place-query').value);
    clearTimeout(placeSearchTimer);
    if (placeSearchAbort) placeSearchAbort.abort();
    if (query.length < StormScopeGeocode.MIN_QUERY) {
      clearPlaceResults();
      document.getElementById('place-status').textContent = '';
      return;
    }
    // Debounce ≥300 ms so type-ahead stays within Photon/Nominatim fair-use limits.
    placeSearchTimer = setTimeout(function () { runPlaceSearch(query); }, 350);
  }

  function operationalLayerRuntimeBindings() {
    return {
      terminator: {
        refresh: refreshTerminator, disable: disableTerminator,
        aborts: function () { return null; }, timers: function () { return terminatorRefreshTimer; }
      },
      snow: {
        refresh: refreshSnow, disable: disableSnow,
        aborts: function () { return snowAbort; }, timers: function () { return [snowRefreshTimer, snowMoveTimer]; }
      },
      alerts: {
        isEnabled: function () { return alertsVisible; },
        refresh: fetchNwsAlerts,
        aborts: function () { return alertAbort; },
        timers: function () { return [alertRefreshTimer, alertMoveTimer]; }
      },
      lightning: {
        refresh: refreshLightning, disable: disableLightning,
        aborts: function () { return lightningAbort; }, timers: function () { return lightningRefreshTimer; }
      },
      wildfires: {
        refresh: refreshWildfires, disable: disableWildfires,
        aborts: function () { return wildfireAbort; }, timers: function () { return [wildfireRefreshTimer, wildfireMoveTimer]; }
      },
      satellite: {
        refresh: refreshSatellite, disable: disableSatellite,
        aborts: function () { return satelliteAbort; },
        timers: function () { return [satelliteRefreshTimer, satelliteMoveTimer, satelliteAnimationTimer, satelliteFrameRequestTimer]; }
      },
      tropical: {
        refresh: refreshTropical, disable: disableTropical,
        aborts: function () { return tropicalAbort; }, timers: function () { return tropicalRefreshTimer; }
      },
      wpcOutlooks: {
        refresh: refreshWpcOutlooks, disable: disableWpcOutlooks,
        aborts: function () { return [wpcEroAbort, wpcFloodAbort]; }, timers: function () { return wpcRefreshTimer; },
        onControl: function (_control, value) { wpcOutlookDay = Number(value); }
      },
      usgsGauges: {
        refresh: refreshUsgsGauges, disable: disableUsgsGauges,
        aborts: function () { return usgsGaugeAbort; }, timers: function () { return [usgsGaugeRefreshTimer, usgsGaugeMoveTimer]; }
      },
      earthquakes: {
        refresh: refreshEarthquakes, disable: disableEarthquakes,
        aborts: function () { return earthquakeAbort; }, timers: function () { return earthquakeRefreshTimer; }
      },
      convective: {
        refresh: refreshConvectiveOutlooks, disable: disableConvectiveOutlooks,
        aborts: function () { return convectiveAbort; }, timers: function () { return convectiveRefreshTimer; },
        onControl: function (_control, value) { convectiveDay = Number(value); }
      },
      watches: {
        refresh: refreshSevereWatches, disable: disableSevereWatches,
        aborts: function () { return watchAbort; }, timers: function () { return watchRefreshTimer; }
      },
      mesoscale: {
        refresh: refreshMesoscale, disable: disableMesoscale,
        aborts: function () { return mesoscaleAbort; }, timers: function () { return mesoscaleRefreshTimer; }
      },
      stormReports: {
        refresh: refreshStormReports, disable: disableStormReports,
        aborts: function () { return stormReportAbort; },
        timers: function () { return [stormReportRefreshTimer, stormReportMoveTimer]; },
        onControl: function (_control, value) { stormReportWindow = Number(value); }
      }
    };
  }

  function bindOperationalLayer(descriptor, binding) {
    var toggle = document.getElementById(descriptor.toggleId);
    if (!toggle || !binding || typeof binding.refresh !== 'function' || typeof binding.disable !== 'function') {
      throw new Error('operational layer binding is incomplete: ' + descriptor.id);
    }
    toggle.addEventListener('change', function () {
      if (this.checked) binding.refresh();
      else binding.disable();
      scheduleLastViewSave();
    });
    descriptor.controls.forEach(function (control) {
      var element = document.getElementById(control.controlId);
      if (!element) throw new Error('operational layer control is missing: ' + control.controlId);
      element.addEventListener('change', function () {
        if (binding.onControl) binding.onControl(control, this.value);
        if (toggle.checked) binding.refresh();
        scheduleLastViewSave();
      });
    });
  }

  function bindUI() {
    initLayerNavigation();
    document.getElementById('saved-location-alert-review').addEventListener('click', reviewSavedLocationAlerts);
    document.getElementById('saved-location-alert-dismiss').addEventListener('click', dismissSavedLocationAlerts);
    document.getElementById('btn-radar').addEventListener('click', showRadarCanvas);
    document.getElementById('btn-alerts').addEventListener('click', toggleAlertsPanel);
    document.getElementById('close-alerts').addEventListener('click', function () {
      alertsPanelDismissed = true;
      syncAlertsPanelVisibility();
      document.getElementById('btn-alerts').focus();
    });
    document.getElementById('wake-lock-monitoring').addEventListener('change', function () {
      wakeLockController.setEnabled(this.checked, true);
    });
    document.getElementById('btn-locate').addEventListener('click', locateMe);
    document.getElementById('place-query').addEventListener('input', schedulePlaceSearch);
    document.getElementById('place-query').addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        if (!placeResults.length) return;
        event.preventDefault();
        setActivePlaceResult(placeActiveIndex + 1 >= placeResults.length ? 0 : placeActiveIndex + 1);
      } else if (event.key === 'ArrowUp') {
        if (!placeResults.length) return;
        event.preventDefault();
        setActivePlaceResult(placeActiveIndex <= 0 ? placeResults.length - 1 : placeActiveIndex - 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        clearTimeout(placeSearchTimer);
        if (placeResults.length) selectPlaceResult(placeResults[placeActiveIndex >= 0 ? placeActiveIndex : 0]);
        else {
          var query = StormScopeGeocode.normalizeQuery(this.value);
          if (query.length >= StormScopeGeocode.MIN_QUERY) runPlaceSearch(query);
        }
      } else if (event.key === 'Escape') {
        resetPlaceSearch();
        clearPlaceResults();
        document.getElementById('place-status').textContent = '';
      }
    });
    document.getElementById('open-comparison').addEventListener('click', openMapComparison);
    document.querySelector('[data-comparison-close]').addEventListener('click', function () {
      closeMapComparison(true);
    });
    document.querySelector('.comparison-backdrop').addEventListener('click', function () {
      closeMapComparison(true);
    });
    document.getElementById('btn-summary').addEventListener('click', toggleSituationSummary);
    document.getElementById('close-summary').addEventListener('click', function () {
      closeOpenPanel('situation-panel', 'btn-summary');
    });
    document.getElementById('refresh-summary').addEventListener('click', function () {
      if (summaryWildfireStatus === 'error') summaryWildfireStatus = 'idle';
      renderSituationSummary(true);
    });
    document.getElementById('btn-search').addEventListener('click', function () {
      if (toggleTopLevelPanel('search-panel', 'btn-search')) {
        scheduleSearchRender();
        document.getElementById('camera-query').focus();
      }
    });

    document.getElementById('btn-place-search').addEventListener('click', function () {
      if (document.getElementById('search-panel').classList.contains('hidden')) {
        toggleTopLevelPanel('search-panel', 'btn-search');
        scheduleSearchRender();
      }
      document.getElementById('place-query').focus();
    });

    document.getElementById('btn-layers').addEventListener('click', function () {
      if (toggleTopLevelPanel('layers-panel', 'btn-layers')) {
        document.getElementById('layer-filter-query').focus();
      }
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
        alertsPanelDismissed = false;
        fetchNwsAlerts();
      }
      scheduleLastViewSave();
    });

    var operationalBindings = operationalLayerRuntimeBindings();
    StormScopeLayerRegistry.lifecycleDescriptors().forEach(function (descriptor) {
      if (descriptor.id !== 'alerts') bindOperationalLayer(descriptor, operationalBindings[descriptor.id]);
    });

    document.getElementById('alert-severity').addEventListener('change', function () {
      fetchNwsAlerts();
      scheduleSceneHashWrite();
    });

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
      renderLayerNavigation();
      updateConnectionState();
      updateRadarScrubber();
      applyRadarPalette();
      updateLowDataUi();
      refreshInstallDiscovery();
      if (radarFrames.length) updateRadarTimeDisplay();
      if (cameraDataTimestamp) updateDataFreshness();
      refreshCameraLoadLabels();
      if (wakeLockController) renderWakeLockState(wakeLockController.snapshot());
      renderCameraSourceHealth();
      refreshCameraMarkerLabels();
      refreshSavedViews(document.getElementById('saved-views').value);
      renderSavedLocationAlertBanner();
      updateMonitorSelectionUi();
      scheduleSearchRender();
      renderAlerts();
      renderLightningStatus();
      renderSnowStatus();
      renderSatelliteStatus();
      renderWildfireStatus();
      renderTropicalStatus();
      renderWpcStatus();
      renderGaugeStatus();
      renderMesoscaleStatus();
      renderStormReportStatus();
      if (activeCamera) {
        updateModalCameraHealth(activeCamera);
        fetchWeather(activeCamera.lat, activeCamera.lon, activeCamera);
      }
    });

    document.getElementById('radar-prev').addEventListener('click', function () { stepRadar(-1); scheduleSceneHashWrite(); });
    document.getElementById('radar-next').addEventListener('click', function () { stepRadar(1); scheduleSceneHashWrite(); });
    document.getElementById('radar-play').addEventListener('click', function () { setRadarPlaying(!radarPlaying); });
    document.getElementById('radar-scrubber').addEventListener('input', function () {
      setRadarPlaying(false);
      selectRadarFrame(parseInt(this.value, 10));
      scheduleSceneHashWrite();
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
      scheduleSceneHashWrite();
    });
    document.getElementById('satellite-prev').addEventListener('click', function () {
      setSatellitePlaying(false);
      clearTimeout(satelliteFrameRequestTimer);
      satelliteFrameRequestTimer = null;
      stepSatellite(-1).catch(function () { /* status already rendered */ });
    });
    document.getElementById('satellite-next').addEventListener('click', function () {
      setSatellitePlaying(false);
      clearTimeout(satelliteFrameRequestTimer);
      satelliteFrameRequestTimer = null;
      stepSatellite(1).catch(function () { /* status already rendered */ });
    });
    document.getElementById('satellite-play').addEventListener('click', function () {
      setSatellitePlaying(!satellitePlaying);
    });
    document.getElementById('satellite-scrubber').addEventListener('input', function () {
      setSatellitePlaying(false);
      satelliteFrameIndex = Math.max(0, Math.min(satelliteFrames.length - 1, parseInt(this.value, 10) || 0));
      renderSatelliteControls();
      if (satelliteFrames.length) scheduleSatelliteFrameRequest(satelliteFrameIndex);
    });
    document.getElementById('data-mode').addEventListener('change', function () {
      applyDataMode(this.value, true);
      scheduleSceneHashWrite();
    });
    document.getElementById('radar-palette').addEventListener('change', function () {
      radarPalette = ['standard', 'colorblind', 'contrast'].indexOf(this.value) === -1 ? 'standard' : this.value;
      try { localStorage.setItem('stormscope-radar-palette', radarPalette); } catch (error) { /* optional */ }
      applyRadarPalette();
      scheduleSceneHashWrite();
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
      document.getElementById(id).addEventListener('input', function () {
        scheduleSearchRender(true);
        scheduleSceneHashWrite();
      });
    });
    ['camera-source', 'camera-type', 'camera-sort', 'camera-healthy', 'camera-favorites'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', function () {
        scheduleSearchRender(true);
        scheduleSceneHashWrite();
      });
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
        restartSavedLocationAlertPolling();
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
      try { savedStore.deleteView(view.id); } catch (error) {
        setSavedStateStatus(tr('views.deleteError'), true);
        return;
      }
      refreshSavedViews();
      restartSavedLocationAlertPolling();
      document.getElementById('view-name').value = '';
      offerRecoveryAction(
        'saved-state-status',
        tr('views.deletedUndo', { name: view.name, seconds: localNumber(RECOVERY_ACTION_WINDOW_MS / 1000) }),
        tr('recovery.undo'),
        tr('views.deleted', { name: view.name }),
        function () {
          savedStore.restoreView(view);
          refreshSavedViews(view.id);
          restartSavedLocationAlertPolling();
          document.getElementById('view-name').value = view.name;
          setSavedStateStatus(tr('views.restored', { name: view.name }));
        },
        function () { setSavedStateStatus(tr('views.restoreError'), true); }
      );
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
      if (file.size > StormScopeSavedState.MAX_IMPORT_BYTES) {
        setSavedStateStatus(tr('views.importTooLarge'), true);
        input.value = '';
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var json = StormScopeSavedState.decodeImportBytes(reader.result);
          var imported = savedStore.importJson(json);
          refreshSavedViews();
          restartSavedLocationAlertPolling();
          updateFavoriteButton(activeCamera);
          scheduleSearchRender();
          offerRecoveryAction(
            'saved-state-status',
            tr('views.importedUndo', { seconds: localNumber(IMPORT_RECOVERY_WINDOW_MS / 1000) }),
            tr('recovery.undo'),
            tr('views.imported'),
            function () {
              savedStore.replaceState(imported.previous);
              refreshSavedViews();
              restartSavedLocationAlertPolling();
              updateFavoriteButton(activeCamera);
              scheduleSearchRender();
              setSavedStateStatus(tr('views.importRestored'));
            },
            function () { setSavedStateStatus(tr('views.importRestoreError'), true); },
            IMPORT_RECOVERY_WINDOW_MS
          );
        } catch (error) {
          var message = String(error && error.message || '');
          var key = /size limit/i.test(message) ? 'views.importTooLarge'
            : /UTF-8/i.test(message) ? 'views.importEncodingError' : 'views.importRejected';
          setSavedStateStatus(tr(key), true);
        } finally {
          input.value = '';
        }
      };
      reader.onerror = function () {
        setSavedStateStatus(tr('views.importReadError'), true);
        input.value = '';
      };
      reader.readAsArrayBuffer(file);
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
    document.getElementById('clear-local-overlays').addEventListener('click', clearLocalOverlays);
    document.getElementById('copy-scene').addEventListener('click', function () { copyCurrentScene(); });
    document.getElementById('share-scene').addEventListener('click', function () { shareCurrentScene(); });
    window.addEventListener('hashchange', applyLocationScene);
    window.addEventListener('popstate', applyLocationScene);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (activeCamera) { closeCameraModal(); return; }
      if (mapComparison && mapComparison.isOpen()) { closeMapComparison(true); return; }
      if (!document.getElementById('monitor-modal').classList.contains('hidden')) { closeMonitor(true); return; }
      if (closeOpenPanel('situation-panel', 'btn-summary')) return;
      if (hideAlertDetail()) return;
      if (closeOpenPanel('search-panel', 'btn-search')) return;
      if (closeOpenPanel('layers-panel', 'btn-layers')) return;
      closeAlertsDrawer();
    });

    map.on('click', function () {
      TOP_LEVEL_PANELS.forEach(function (entry) {
        document.getElementById(entry.panel).classList.add('hidden');
        document.getElementById(entry.toggle).setAttribute('aria-expanded', 'false');
      });
      syncAlertsPanelVisibility();
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
      if (document.getElementById('toggle-snow').checked) {
        clearTimeout(snowMoveTimer);
        snowMoveTimer = setTimeout(refreshSnow, 900);
      }
      if (document.getElementById('toggle-usgs-gauges').checked) {
        clearTimeout(usgsGaugeMoveTimer);
        usgsGaugeMoveTimer = setTimeout(refreshUsgsGauges, 900);
      }
      if (document.getElementById('toggle-storm-reports').checked) {
        clearTimeout(stormReportMoveTimer);
        stormReportMoveTimer = setTimeout(refreshStormReports, 900);
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

  function startRadarRefreshTimer() {
    clearInterval(radarRefreshTimer);
    radarRefreshTimer = setInterval(function () {
      if (!document.hidden && (!mapComparison || !mapComparison.isOpen()) && navigator.onLine) initRadar();
    }, RADAR_REFRESH_INTERVAL);
  }

  function createOperationalControllers() {
    function toggle(id) {
      return function () { return document.getElementById(id).checked; };
    }

    function controller(id, isEnabled, refresh, aborts, timers) {
      return StormScopeContextLayerControllers.createController({
        id: id,
        isEnabled: isEnabled,
        refresh: refresh,
        aborts: aborts,
        timers: timers,
        cancelTimer: clearTimeout
      });
    }

    var bindings = operationalLayerRuntimeBindings();
    var controllers = StormScopeLayerRegistry.lifecycleDescriptors().map(function (descriptor) {
      var binding = bindings[descriptor.id];
      if (!binding || typeof binding.refresh !== 'function' || typeof binding.aborts !== 'function' ||
          typeof binding.timers !== 'function') {
        throw new Error('operational lifecycle binding is incomplete: ' + descriptor.id);
      }
      return controller(
        descriptor.lifecycleId,
        binding.isEnabled || toggle(descriptor.toggleId),
        binding.refresh,
        binding.aborts,
        binding.timers
      );
    });
    return StormScopeContextLayerControllers.createControllerSet(controllers);
  }

  function initLifecycle() {
    updateConnectionState();
    startRadarRefreshTimer();
    operationalControllers = createOperationalControllers();
    teardownResources.push(operationalControllers);

    document.addEventListener('visibilitychange', function () {
      var container = document.getElementById('modal-feed');
      if (monitorRegistry) monitorRegistry.setDocumentHidden(document.hidden);
      if (mapComparison) mapComparison.setDocumentHidden(document.hidden);
      if (document.hidden) {
        radarWasPlaying = radarPlaying;
        satelliteWasPlaying = satellitePlaying;
        setRadarPlaying(false);
        setSatellitePlaying(false);
        if (activeCamera) {
          destroyActiveFeed(container);
          var paused = document.createElement('div');
          paused.className = 'feed-loading';
          paused.setAttribute('role', 'status');
          paused.textContent = tr('camera.paused');
          container.replaceChildren(paused);
          feedPausedForVisibility = true;
        }
        operationalControllers.suspend();
        if (savedLocationAlertAbort) savedLocationAlertAbort.abort();
        clearTimeout(savedLocationAlertTimer);
        savedLocationAlertTimer = null;
        resetPlaceSearch();
        return;
      }

      startRadarRefreshTimer();
      initRadar().then(function () {
        if ((radarWasPlaying || comparisonRadarWasPlaying) && radarVisible && radarFrames.length) setRadarPlaying(true);
        if (satelliteWasPlaying && satelliteFrames.length && !lowDataMode) setSatellitePlaying(true);
        radarWasPlaying = false;
        satelliteWasPlaying = false;
        comparisonRadarWasPlaying = false;
      });
      if (feedPausedForVisibility && activeCamera) {
        feedPausedForVisibility = false;
        loadCameraFeed(activeCamera, container);
      }
      operationalControllers.refreshEnabled();
      scheduleSavedLocationAlertPoll(0);
    });

    window.addEventListener('online', function () {
      updateConnectionState();
      initRadar();
      operationalControllers.refreshEnabled();
    });
    window.addEventListener('offline', updateConnectionState);
    window.addEventListener('beforeunload', function () {
      clearInterval(radarRefreshTimer);
      clearTimeout(radarPreloadTimer);
      setRadarPlaying(false);
      setSatellitePlaying(false);
      if (radarAbort) radarAbort.abort();
      if (weatherAbort) weatherAbort.abort();
      if (summaryWildfireAbort) summaryWildfireAbort.abort();
      if (savedLocationAlertAbort) savedLocationAlertAbort.abort();
      clearTimeout(savedLocationAlertTimer);
      resetPlaceSearch();
      if (cameraStore) cameraStore.cancel();
      if (monitorRegistry) monitorRegistry.destroyAll();
      if (localOverlayDatabase) localOverlayDatabase.close();
      clearTimeout(saveLastViewTimer);
      Object.keys(recoveryActionTimers).forEach(cancelRecoveryAction);
      teardownResources.forEach(function (resource) { resource.destroy(); });
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

  async function startupDiagnosticContext() {
    var navigationEntries = [];
    try {
      if (window.performance && typeof performance.getEntriesByType === 'function') {
        navigationEntries = performance.getEntriesByType('navigation').map(function (entry) {
          return {
            type: entry.type,
            responseStart: entry.responseStart,
            domContentLoadedEventEnd: entry.domContentLoadedEventEnd,
            loadEventEnd: entry.loadEventEnd,
            duration: entry.duration
          };
        });
      }
    } catch (_error) { navigationEntries = []; }

    var workerState = {
      supported: 'serviceWorker' in navigator,
      controlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
      state: navigator.serviceWorker && navigator.serviceWorker.controller
        ? navigator.serviceWorker.controller.state : null,
      navigationPreload: { supported: false, enabled: false }
    };
    if (workerState.supported && typeof navigator.serviceWorker.getRegistration === 'function') {
      try {
        var registration = await navigator.serviceWorker.getRegistration();
        var worker = navigator.serviceWorker.controller || registration &&
          (registration.active || registration.waiting || registration.installing);
        if (worker) workerState.state = worker.state;
        if (registration && registration.navigationPreload &&
            typeof registration.navigationPreload.getState === 'function') {
          workerState.navigationPreload.supported = true;
          var preload = await registration.navigationPreload.getState();
          workerState.navigationPreload.enabled = Boolean(preload && preload.enabled);
        }
      } catch (_error) { /* Optional diagnostic evidence must not block export. */ }
    }
    return {
      navigationEntries: navigationEntries,
      camera: {
        firstBatchMs: cameraLoadMetrics.firstBatchMs,
        completeMs: cameraLoadMetrics.completeMs,
        source: cameraLoadMetrics.source,
        deferred: cameraCatalogDeferred
      },
      dataMode: { preference: dataModePreference, enabled: lowDataMode, source: lowDataSource },
      serviceWorker: workerState
    };
  }

  async function exportDiagnostics() {
    var report = diagnostics.report({
      appVersion: APP_VERSION,
      corpusGeneration: cameraLoadMetrics.index && cameraLoadMetrics.index.generated_at,
      cameraIngestion: cameraSourceHealth,
      startup: await startupDiagnosticContext(),
      providers: {
        radar: radarProviderId,
        radarStatus: radarProviderSelection && radarProviderSelection.degradationReason || 'ready',
        alerts: { status: activeAlerts.length ? 'ready' : 'none', count: activeAlerts.length },
        lightning: lightningStatusState,
        wildfires: wildfireStatusState,
        tropical: { status: tropicalStatusState, count: tropicalStorms.length },
        wpcOutlooks: { status: wpcStatusState, count: wpcOutlookCount, day: wpcOutlookDay },
        usgsGauges: { status: usgsGaugeStatusState, count: usgsGaugeCount },
        comparison: mapComparison ? mapComparison.metrics() : { active: false }
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
    initWakeLock();
    initRadarPreferences();
    startupSharedScene = readStartupSharedScene();
    initSavedState({ restoreLastView: !startupSharedScene });
    initLocalOverlays();
    if (startupSharedScene) {
      sceneHashApplying = true;
      try { applySharedScene(startupSharedScene); } finally { sceneHashApplying = false; }
    } else if (startupSceneError) setSavedStateStatus(tr('views.sceneInvalid'), true);
    bindUI();
    initInstallDiscovery();
    updateMonitorSelectionUi();
    initRadar();
    loadCameras();
    fetchNwsAlerts();
    registerServiceWorker();
    initLifecycle();
    scheduleSavedLocationAlertPoll(0);
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
    getWakeLockState: function () { return wakeLockController ? wakeLockController.snapshot() : null; },
    getLayerRegistryState: function () {
      return {
        ids: StormScopeLayerRegistry.descriptors.map(function (descriptor) { return descriptor.id; }),
        enabled: StormScopeLayerRegistry.captureEnabled(document)
      };
    },
    captureSharedScene: captureSharedScene,
    getSharedSceneUrl: sharedSceneUrl,
    getActiveCameraId: function () { return activeCamera ? String(activeCamera.id) : null; },
    getRadarFrameTime: function () { return radarFrames[radarIndex] ? radarFrames[radarIndex].time : null; },
    getAlertLayerGroup: function () { return alertLayerGroup; },
    refreshAlerts: fetchNwsAlerts,
    refreshSavedLocationAlerts: refreshSavedLocationAlerts,
    getSavedLocationAlertState: getSavedLocationAlertState,
    getLowDataState: function () {
      return {
        preference: dataModePreference, enabled: lowDataMode, source: lowDataSource,
        imageRefreshMs: imageRefreshInterval(), cameraCatalogDeferred: cameraCatalogDeferred
      };
    },
    getMonitorState: function () {
      return { selected: monitorSelection.count(), players: monitorRegistry ? monitorRegistry.count() : 0 };
    },
    getComparisonState: function () {
      return mapComparison ? mapComparison.metrics() : {
        active: false, paneCount: 0, activeTileNodes: 0, peakTileNodes: 0,
        estimatedDecodedBytes: 0,
        maxEstimatedMemoryBytes: StormScopeMapComparison.limits.maxEstimatedMemoryBytes,
        requestBudget: { limit: StormScopeMapComparison.limits.requestsPerMinute, used: 0, remaining: StormScopeMapComparison.limits.requestsPerMinute },
        syncSamples: 0, syncP95Ms: 0,
        desktopSyncBudgetMs: StormScopeMapComparison.limits.desktopSyncBudgetMs,
        mobileSyncBudgetMs: StormScopeMapComparison.limits.mobileSyncBudgetMs
      };
    },
    setComparisonView: function (side, center, zoom) {
      return mapComparison ? mapComparison.setView(side, center, zoom) : false;
    },
    setComparisonDocumentHidden: function (hidden) {
      if (mapComparison) mapComparison.setDocumentHidden(hidden);
    },
    getContextState: function () {
      return {
        satellite: Boolean(satelliteLayer), lightning: Boolean(lightningLayer), wildfires: Boolean(wildfireLayer),
        tropical: Boolean(tropicalLayer), wpcOutlooks: Boolean(wpcEroLayer || wpcFloodLayer),
        usgsGauges: Boolean(usgsGaugeLayer), earthquakes: Boolean(earthquakeLayer),
        convective: Boolean(convectiveLayer),
        satelliteStatus: satelliteStatusState,
        lightningStatus: lightningStatusState, wildfireStatus: wildfireStatusState,
        tropicalStatus: tropicalStatusState, tropicalCount: tropicalStorms.length,
        wpcStatus: wpcStatusState, wpcCount: wpcOutlookCount, wpcDay: wpcOutlookDay,
        gaugeStatus: usgsGaugeStatusState, gaugeCount: usgsGaugeCount,
        earthquakeStatus: earthquakeStatusState, earthquakeCount: earthquakeCount,
        convectiveStatus: convectiveStatusState, convectiveCount: convectiveCount, convectiveDay: convectiveDay,
        watches: Boolean(watchLayer), watchStatus: watchStatusState, watchCount: watchCount,
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
    getSatelliteState: function () {
      return {
        enabled: Boolean(satelliteLayer), status: satelliteStatusState,
        frameCount: satelliteFrames.length, frameIndex: satelliteFrameIndex,
        playing: satellitePlaying, latestTime: satelliteLatestTime,
        lowData: lowDataMode, requestBudget: satelliteRequestBudget.snapshot()
      };
    },
    getTerminatorState: function () {
      return { enabled: Boolean(terminatorLayer), status: terminatorStatusState, updatedAt: terminatorUpdatedAt };
    },
    getSnowState: function () {
      return { enabled: Boolean(snowLayer), status: snowStatusState, updatedAt: snowFetchedAt };
    },
    getSpcReportsState: function () {
      return {
        mesoscale: Boolean(mesoscaleLayer), mesoscaleStatus: mesoscaleStatusState, mesoscaleCount: mesoscaleCount,
        stormReports: Boolean(stormReportLayer), stormReportsStatus: stormReportStatusState,
        stormReportCount: stormReportCount, stormReportWindow: stormReportWindow
      };
    },
    refreshMesoscale: refreshMesoscale,
    refreshStormReports: refreshStormReports,
    refreshTropical: refreshTropical,
    refreshWpcOutlooks: refreshWpcOutlooks,
    refreshUsgsGauges: refreshUsgsGauges
  };
})();
