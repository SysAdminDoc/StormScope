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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      crossOrigin: 'anonymous',
      maxZoom: 19
    }).addTo(map);
  }

  // ── RainViewer Radar ──

  async function initRadar() {
    if (radarAbort) radarAbort.abort();
    radarAbort = new AbortController();
    setRadarPlaying(false);
    setRadarStatus('Loading past radar…', false, true);

    var signal = radarAbort.signal;
    var discoveries = {};
    var health = {};

    try {
      try {
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

      if (!health.rainviewer || health.rainviewer.status !== 'healthy') {
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
    } catch (error) {
      if (error.name !== 'AbortError') {
        clearRadarDisplay();
        document.getElementById('radar-meta').textContent = 'RainViewer and NOAA/MRMS unavailable • ' + error.message;
        setRadarStatus('Past radar is unavailable.', true, true);
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
    var controls = ['radar-prev', 'radar-play', 'radar-next'];
    for (var i = 0; i < controls.length; i++) {
      document.getElementById(controls[i]).disabled = !!disabled;
    }
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
      layer = L.tileLayer.wms(provider.tile.endpoint, {
        layers: params.layers,
        format: params.format,
        transparent: true,
        version: params.version,
        crs: L.CRS.EPSG3857,
        time: params.time,
        opacity: radarOpacity,
        zIndex: 400,
        maxZoom: 18,
        crossOrigin: 'anonymous',
        attribution: 'Radar: <a href="' + provider.attribution.url + '" target="_blank" rel="noopener noreferrer">' + provider.attribution.text + '</a>'
      });
    } else {
      return null;
    }
    var tileErrors = 0;
    layer.on('tileerror', function () {
      tileErrors += 1;
      if (tileErrors < 3 || radarLayer !== layer) return;
      setTimeout(function () {
        if (radarLayer !== layer) return;
        clearRadarDisplay();
        setRadarStatus('Radar tiles are unavailable.', true, true);
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
    }
  }

  function updateRadarTimeDisplay() {
    var frame = radarFrames[radarIndex];
    if (!frame) return;
    var d = new Date(frame.time);
    var timeStr = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    });
    var age = StormScopeRadarProviders.getFrameAge(frame, radarProviderId);
    var state = radarSemanticState;
    var label = state && (state.state === 'clear' || state.state === 'no-coverage' || state.state === 'stale')
      ? state.label
      : timeStr + ' • Past radar • ' + age.label;
    setRadarStatus(label, state ? state.canRetry : false, state ? !state.controlsEnabled : false);
    updateRadarProviderUI();
  }

  function updateRadarProviderUI() {
    if (!radarProviderSelection || !radarFrames.length) return;
    var provider = StormScopeRadarProviders.providers[radarProviderId];
    var age = StormScopeRadarProviders.getFrameAge(radarFrames[radarIndex], radarProviderId);
    var reason = radarProviderSelection.degradationReason
      ? ' • ' + radarProviderSelection.degradationReason.replace(/-/g, ' ')
      : '';
    document.getElementById('radar-meta').textContent = radarProviderSelection.displayLabel +
      ' • ' + provider.resolution.label + ' • ' + age.label + reason;
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
    radarIndex = (radarIndex + delta + radarFrames.length) % radarFrames.length;
    showRadarFrame(radarIndex);
    updateRadarTimeDisplay();
    sampleRadarCenter(radarFrames[radarIndex]);
    var nextIdx = (radarIndex + 1) % radarFrames.length;
    preloadRadarFrame(nextIdx);
  }

  function setRadarPlaying(playing) {
    radarPlaying = playing;
    document.getElementById('icon-play').classList.toggle('hidden', radarPlaying);
    document.getElementById('icon-pause').classList.toggle('hidden', !radarPlaying);
    document.getElementById('radar-play').setAttribute('aria-pressed', String(radarPlaying));

    clearInterval(radarAnimTimer);
    radarAnimTimer = null;

    if (radarPlaying) {
      radarAnimTimer = setInterval(function () {
        stepRadar(1);
      }, RADAR_ANIMATION_SPEED);
    }
  }

  // ── Camera Layer ──

  function createCameraIcon(type, health) {
    var isYouTube = type === 'youtube';
    var isEmbed = type === 'embed';
    var healthClass = 'health-' + (health || 'unknown');
    var cls = (isYouTube ? 'camera-marker youtube-marker' : (isEmbed ? 'camera-marker embed-marker' : 'camera-marker')) + ' ' + healthClass;
    var label, svg;
    if (isYouTube) {
      label = (health || 'unknown') + ' YouTube live stream';
      svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/></svg>';
    } else if (isEmbed) {
      label = (health || 'unknown') + ' webcam embed';
      svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="3"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-2.67 0-8-1.34-8-4v-.8c0-1.33 5.33-2.7 8-2.7s8 1.37 8 2.7v.8c0 2.66-5.33 4-8 4z"/></svg>';
    } else {
      label = (health || 'unknown') + ' traffic camera';
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

  async function loadCameras() {
    try {
      document.getElementById('camera-count').textContent = 'Loading cameras…';
      var resp = await fetch('data/cameras.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var modified = resp.headers.get('last-modified');
      cameraDataTimestamp = modified ? new Date(modified) : new Date();
      allCameras = await resp.json();

      cameraCluster = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        disableClusteringAtZoom: 13,
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

      var icons = {};

      var markers = [];
      for (var i = 0; i < allCameras.length; i++) {
        var cam = allCameras[i];
        var iconKey = cam.type === 'youtube' ? 'youtube' : (cam.type === 'embed' ? 'embed' : 'dot');
        var health = ['healthy', 'degraded', 'offline'].indexOf(cam.health) >= 0 ? cam.health : 'unknown';
        var cachedIconKey = iconKey + '-' + health;
        if (!icons[cachedIconKey]) icons[cachedIconKey] = createCameraIcon(iconKey, health);
        var marker = L.marker([cam.lat, cam.lon], {
          icon: icons[cachedIconKey],
          title: cam.name + ' — ' + health + ' feed'
        });
        marker._camData = cam;
        marker.on('click', onCameraClick);
        marker.on('mouseover', onMarkerHover);
        marker.on('add', function (event) {
          var element = event.target.getElement();
          var camera = event.target._camData;
          if (element && camera) element.setAttribute('aria-label', camera.name + ' — ' + (camera.health || 'unknown') + ' feed');
        });
        markers.push(marker);
      }

      cameraCluster.addLayers(markers);
      map.addLayer(cameraCluster);
      document.getElementById('camera-count').textContent = allCameras.length.toLocaleString() + ' cameras';
      updateDataFreshness();
    } catch (e) {
      document.getElementById('camera-count').textContent = 'Failed to load cameras';
      updateDataFreshness(true);
    }
  }

  function updateDataFreshness(failed) {
    var status = document.getElementById('data-freshness');
    status.classList.remove('hidden', 'offline', 'stale');
    if (failed) {
      status.textContent = 'Camera data unavailable';
      status.classList.add('stale');
      return;
    }
    var offline = !navigator.onLine;
    var stale = cameraDataTimestamp && Date.now() - cameraDataTimestamp.getTime() > 24 * 60 * 60 * 1000;
    var timestamp = cameraDataTimestamp
      ? cameraDataTimestamp.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'unknown time';
    status.textContent = (offline ? 'Offline cache • ' : stale ? 'Stale cameras • ' : 'Cameras • ') + timestamp;
    if (offline) status.classList.add('offline');
    if (stale) status.classList.add('stale');
  }

  function updateConnectionState() {
    var status = document.getElementById('connection-state');
    status.textContent = navigator.onLine ? 'Online' : 'Offline';
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
    var modal = document.querySelector('.modal-content');
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
    var healthEl = document.getElementById('modal-cam-health');
    var sourceEl = document.getElementById('modal-cam-source');
    var weatherLoading = document.getElementById('weather-loading');
    var weatherData = document.getElementById('weather-data');

    nameEl.textContent = cam.name;
    var locParts = [];
    if (cam.county) locParts.push(cam.county);
    if (cam.state) locParts.push(cam.state);
    if (cam.direction) locParts.push(cam.direction);
    locEl.textContent = locParts.join(' • ');
    var health = cam.health || 'unknown';
    healthEl.className = 'health-badge health-' + health;
    healthEl.textContent = health === 'healthy' ? 'Verified healthy' : health === 'degraded' ? 'Degraded' : health === 'offline' ? 'Offline' : 'Not yet verified';
    if (cam.last_verified) healthEl.title = 'Last verified ' + StormScopeWeather.formatTime(cam.last_verified);
    sourceEl.href = cam.source_url || cam.url;

    feedEl.innerHTML = '<div class="feed-loading">Loading camera feed…</div>';
    weatherLoading.textContent = 'Fetching weather…';
    weatherLoading.classList.remove('hidden');
    weatherData.innerHTML = '';
    weatherData.classList.add('hidden');

    modal.classList.remove('hidden');
    setModalBackgroundInert(true);
    document.getElementById('modal-close').focus();
    document.addEventListener('keydown', trapFocus);

    loadCameraFeed(cam, feedEl);
    fetchWeather(cam.lat, cam.lon, cam);
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
    setModalBackgroundInert(false);
    feedEl.replaceChildren();

    if (priorFocusEl && priorFocusEl.focus) {
      priorFocusEl.focus();
      priorFocusEl = null;
    }
  }

  function setModalBackgroundInert(inert) {
    var modal = document.getElementById('camera-modal');
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
    retry.textContent = 'Retry feed';
    retry.addEventListener('click', function () {
      if (activeCamera !== cam) return;
      var loading = document.createElement('div');
      loading.className = 'feed-loading';
      loading.textContent = 'Retrying camera feed…';
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
    source.textContent = 'Open source';
    error.appendChild(source);
    container.replaceChildren(error);
  }

  function appendFrameFallback(cam, container, iframe, sourceUrl) {
    var actions = document.createElement('div');
    actions.className = 'feed-frame-actions';

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'feed-retry-btn';
    retry.textContent = 'Reload feed';
    retry.addEventListener('click', function () {
      if (activeCamera !== cam) return;
      destroyActiveFeed(container);
      loadCameraFeed(cam, container);
    });

    var source = document.createElement('a');
    source.className = 'feed-source-link';
    source.href = sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = 'Open source';
    actions.appendChild(retry);
    actions.appendChild(source);
    container.appendChild(actions);

    var timeout = setTimeout(function () {
      if (activeCamera === cam) {
        renderFeedError(cam, container, 'The embedded feed did not finish loading.');
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
          renderFeedError(cam, container, 'Stream unavailable. The camera may be offline or blocked by CORS.');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = cam.url;
      video.addEventListener('error', function () {
        renderFeedError(cam, container, 'Stream unavailable. The camera may be offline or blocked by CORS.');
      }, { once: true });
    } else {
      renderFeedError(cam, container, 'HLS playback is not supported in this browser.');
      return;
    }

    container.replaceChildren(video);
    appendLiveIndicator(container, 'Live stream');
  }

  function loadMJPEGFeed(cam, container) {
    var img = document.createElement('img');
    img.alt = cam.name;
    img.src = cam.url;

    img.onerror = function () {
      if (activeCamera === cam) {
        renderFeedError(cam, container, 'Camera feed unavailable. The camera may be offline.');
      }
    };

    activeFeedCleanup = function () {
      img.onerror = null;
      img.src = '';
    };
    container.replaceChildren(img);
    appendLiveIndicator(container, 'Live MJPEG stream');
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
    appendLiveIndicator(container, 'YouTube live stream');
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
      renderFeedError(cam, container, 'This embed source is not trusted.');
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
        renderFeedError(cam, container, 'Embed unavailable. The camera page may be offline.');
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
        renderFeedError(cam, container, 'Camera image unavailable. The camera may be offline.');
      }
    };

    img.onload = function () {
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
    appendLiveIndicator(container, 'Auto-refreshes every 15s');

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
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    77: 'Snow grains', 80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
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
      ['Temperature', temperature],
      ['Conditions', current.shortForecast],
      ['Wind', StormScopeWeather.windFromMph(current.windSpeed, weatherUnits) + ' ' + current.windDirection],
      ['Humidity', current.relativeHumidity ? current.relativeHumidity.value + '%' : 'N/A'],
      ['Forecast issued', StormScopeWeather.formatTime(fcData.properties.updateTime)],
      ['Forecast valid', StormScopeWeather.formatTime(current.startTime)]
    ]);
  }

  async function fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData, isFallback) {
    try {
      var metric = weatherUnits === 'metric';
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) +
        '&longitude=' + lon.toFixed(4) +
        '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code' +
        '&temperature_unit=' + (metric ? 'celsius' : 'fahrenheit') +
        '&wind_speed_unit=' + (metric ? 'kmh' : 'mph');
      var resp = await fetch(url, { signal: signal });
      if (!resp.ok) throw new Error('Open-Meteo failed');
      var data = await resp.json();
      var c = data.current;
      if (!c) throw new Error('No current data');

      if (activeCamera !== cam) return;

      var condition = WMO_CODES[c.weather_code] || 'Unknown';
      var windDir = windDirectionFromDegrees(c.wind_direction_10m || 0);

      showWeatherItems(weatherLoading, weatherData, [
        ['Temperature', Math.round(c.temperature_2m) + (metric ? '°C' : '°F')],
        ['Conditions', condition],
        ['Wind', Math.round(c.wind_speed_10m) + (metric ? ' km/h ' : ' mph ') + windDir],
        ['Humidity', c.relative_humidity_2m != null ? c.relative_humidity_2m + '%' : 'N/A'],
        ['Observed', StormScopeWeather.formatTime(c.time)],
        ['Source', isFallback ? 'Open-Meteo fallback' : 'Open-Meteo']
      ]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (activeCamera === cam) {
        weatherLoading.textContent = 'Weather data unavailable for this location.';
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
    var pointQuery = StormScopeNwsAlerts.buildPointQuery(center.lat, center.lng);
    document.getElementById('alerts-status').textContent = 'Refreshing…';

    try {
      var responses = await Promise.all([
        fetch(viewportQuery.url, { headers: { Accept: 'application/geo+json' }, signal: signal }),
        fetch(pointQuery, { headers: { Accept: 'application/geo+json' }, signal: signal })
      ]);
      for (var i = 0; i < responses.length; i++) {
        if (!responses[i].ok) {
          var responseError = new Error('NWS alerts HTTP ' + responses[i].status);
          responseError.status = responses[i].status;
          responseError.retryAfter = responses[i].headers.get('retry-after');
          throw responseError;
        }
      }
      var payloads = await Promise.all(responses.map(function (response) { return response.json(); }));
      var viewportAlerts = StormScopeNwsAlerts.normalizeCollection(payloads[0], {
        bounds: viewportQuery.bounds,
        minimumSeverity: alertMinimumSeverity()
      });
      var pointAlerts = StormScopeNwsAlerts.normalizeCollection(payloads[1], {
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
        ? 'Unavailable • retry scheduled'
        : 'Unavailable';
      scheduleAlertRefresh(alertRetryMetadata.delayMs);
    }
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
      summary.textContent = alert.severity + ' • expires ' + StormScopeWeather.formatTime(alert.expires);
      button.appendChild(title);
      button.appendChild(summary);
      button.addEventListener('click', function () { showAlertDetail(alert, true); });
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
      ? activeAlerts.length + (activeAlerts.length === 1 ? ' alert' : ' alerts')
      : 'No active alerts in view';
    panel.classList.toggle('hidden', !alertsVisible);
  }

  function showAlertDetail(alert, focus) {
    var detail = document.getElementById('alert-detail');
    detail.replaceChildren();
    var heading = document.createElement('h3');
    heading.textContent = alert.headline;
    detail.appendChild(heading);
    [
      ['Area', alert.areaDescription],
      ['Effective', StormScopeWeather.formatTime(alert.effective)],
      ['Expires', StormScopeWeather.formatTime(alert.expires)],
      ['Severity', alert.severity + ' • ' + alert.urgency + ' • ' + alert.certainty],
      ['Details', alert.description],
      ['Instructions', alert.instruction]
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
    source.textContent = 'Official alert source';
    detail.appendChild(source);
    detail.classList.remove('hidden');
    if (focus) detail.focus();
    if (focus && alertLayersById[alert.id]) {
      var bounds = alertLayersById[alert.id].getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
    }
  }

  // ── UI Bindings ──

  function bindUI() {
    document.getElementById('btn-layers').addEventListener('click', function () {
      var panel = document.getElementById('layers-panel');
      var isHidden = panel.classList.toggle('hidden');
      this.setAttribute('aria-expanded', !isHidden);
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
    });

    document.getElementById('toggle-cameras').addEventListener('change', function () {
      if (this.checked) {
        if (cameraCluster) map.addLayer(cameraCluster);
      } else {
        if (cameraCluster) map.removeLayer(cameraCluster);
      }
    });

    document.getElementById('toggle-coverage').addEventListener('change', updateCoverageLayer);

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
    });

    document.getElementById('alert-severity').addEventListener('change', fetchNwsAlerts);

    document.getElementById('radar-opacity').addEventListener('input', function () {
      radarOpacity = parseInt(this.value, 10) / 100;
      if (radarLayer) radarLayer.setOpacity(radarOpacity);
    });

    document.getElementById('weather-units').addEventListener('change', function () {
      weatherUnits = StormScopeWeather.normalizeUnits(this.value, navigator.language);
      try { localStorage.setItem('stormscope-weather-units', weatherUnits); } catch (error) { /* optional */ }
      if (activeCamera) fetchWeather(activeCamera.lat, activeCamera.lon, activeCamera);
    });

    document.getElementById('radar-prev').addEventListener('click', function () { stepRadar(-1); });
    document.getElementById('radar-next').addEventListener('click', function () { stepRadar(1); });
    document.getElementById('radar-play').addEventListener('click', function () { setRadarPlaying(!radarPlaying); });
    document.getElementById('radar-retry').addEventListener('click', initRadar);

    document.getElementById('modal-close').addEventListener('click', closeCameraModal);
    document.querySelector('.modal-backdrop').addEventListener('click', closeCameraModal);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeCamera) {
        closeCameraModal();
      }
    });

    map.on('click', function () {
      document.getElementById('layers-panel').classList.add('hidden');
      document.getElementById('btn-layers').setAttribute('aria-expanded', 'false');
      document.getElementById('alerts-panel').classList.toggle('hidden', !alertsVisible);
    });
    map.on('moveend', function () {
      if (radarFrames.length) sampleRadarCenter(radarFrames[radarIndex]);
      clearTimeout(alertMoveTimer);
      alertMoveTimer = setTimeout(fetchNwsAlerts, 600);
    });
  }

  function registerServiceWorker() {
    var status = document.getElementById('cache-status');
    var clearButton = document.getElementById('clear-cache');
    var updateNotice = document.getElementById('update-notice');
    var applyUpdate = document.getElementById('apply-update');
    if (!('serviceWorker' in navigator) || location.protocol.indexOf('http') !== 0) {
      status.textContent = 'Offline cache requires HTTP or HTTPS.';
      return;
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 MB';
      return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
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
        status.textContent = 'Offline cache: ' + formatBytes(usage.bytes) + ' in ' + (usage.entries || 0) + ' items';
        clearButton.disabled = false;
      });
    }

    navigator.serviceWorker.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'STORMSCOPE_CACHE_ERROR') return;
      setCacheError(event.data.reason === 'quota-exceeded'
        ? 'Offline cache is full. Clear cached data and retry.'
        : 'Offline cache could not save new data.');
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
        applyUpdate.textContent = 'Updating…';
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
            status.textContent = 'Clearing cached data…';
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
        setCacheError('Offline cache unavailable: ' + error.message);
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
      if (document.hidden) {
        radarWasPlaying = radarPlaying;
        setRadarPlaying(false);
        if (activeCamera) {
          destroyActiveFeed(container);
          var paused = document.createElement('div');
          paused.className = 'feed-loading';
          paused.setAttribute('role', 'status');
          paused.textContent = 'Feed paused while this tab is hidden.';
          container.replaceChildren(paused);
          feedPausedForVisibility = true;
        }
        if (alertAbort) alertAbort.abort();
        clearTimeout(alertRefreshTimer);
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
    });

    window.addEventListener('online', function () {
      updateConnectionState();
      initRadar();
    });
    window.addEventListener('offline', updateConnectionState);
    window.addEventListener('beforeunload', function () {
      clearInterval(radarRefreshTimer);
      clearTimeout(radarPreloadTimer);
      clearTimeout(alertRefreshTimer);
      clearTimeout(alertMoveTimer);
      setRadarPlaying(false);
      if (radarAbort) radarAbort.abort();
      if (weatherAbort) weatherAbort.abort();
      if (alertAbort) alertAbort.abort();
      destroyActiveFeed(document.getElementById('modal-feed'));
    });
  }

  function initWeatherUnits() {
    var saved = null;
    try { saved = localStorage.getItem('stormscope-weather-units'); } catch (error) { /* optional */ }
    weatherUnits = StormScopeWeather.normalizeUnits(saved, navigator.language);
    document.getElementById('weather-units').value = weatherUnits;
  }

  // ── Boot ──

  initMap();
  initWeatherUnits();
  bindUI();
  initRadar();
  loadCameras();
  fetchNwsAlerts();
  registerServiceWorker();
  initLifecycle();

  window._stormscope = {
    getMap: function () { return map; },
    getRadarPreloadState: function () { return Object.assign({}, radarPreloadState); }
  };
})();
