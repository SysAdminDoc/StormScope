(function () {
  'use strict';

  var MAP_CENTER = [39.5, -98.5];
  var MAP_ZOOM = 5;
  var RADAR_ANIMATION_SPEED = 800;
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
  var radarAbort = null;
  var radarOpacity = 0.65;
  var radarVisible = true;
  var activeCamera = null;
  var priorFocusEl = null;
  var weatherAbort = null;
  var imageRefreshTimer = null;
  var activeFeedCleanup = null;
  var allCameras = [];

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

    try {
      var resp = await fetch(RAINVIEWER_API_URL, {
        cache: 'no-store',
        signal: radarAbort.signal
      });
      if (resp.status === 429) {
        clearRadarDisplay();
        setRadarStatus('Radar temporarily rate-limited.', true, true);
        return;
      }
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      var nextHost = getTrustedRainViewerHost(data.host);
      var past = data.radar && Array.isArray(data.radar.past) ? data.radar.past : [];
      var validPast = past.filter(function (frame) {
        return frame && Number.isFinite(frame.time) &&
          typeof frame.path === 'string' && frame.path.indexOf('/v2/radar/') === 0;
      });

      if (!nextHost) throw new Error('Untrusted radar tile host');
      if (validPast.length === 0) {
        clearRadarDisplay();
        setRadarStatus('No recent past radar frames are available.', true, true);
        return;
      }

      radarHost = nextHost;
      radarFrames = validPast;
      radarIndex = radarFrames.length - 1;
      showRadarFrame(radarIndex);
      preloadRadarFrame(radarIndex > 0 ? radarIndex - 1 : radarFrames.length - 1);
      updateRadarTimeDisplay();
    } catch (e) {
      if (e.name !== 'AbortError') {
        clearRadarDisplay();
        setRadarStatus('Past radar is unavailable.', true, true);
      }
    }
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
    if (!frame || !radarHost) return null;
    var layer = L.tileLayer(
      radarHost + frame.path + '/256/{z}/{x}/{y}/' + RAINVIEWER_COLOR_SCHEME + '/1_1.png',
      {
        opacity: radarOpacity,
        zIndex: 400,
        maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM,
        maxZoom: 18,
        crossOrigin: 'anonymous',
        attribution: 'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener noreferrer">RainViewer</a>'
      }
    );
    var tileErrors = 0;
    layer.on('tileerror', function () {
      tileErrors += 1;
      if (tileErrors < 3 || radarLayer !== layer) return;
      clearRadarDisplay();
      setRadarStatus('Radar tiles are unavailable.', true, true);
    });
    return layer;
  }

  function preloadRadarFrame(index) {
    if (radarLayerNext) {
      map.removeLayer(radarLayerNext);
    }
    radarLayerNext = createRadarTileLayer(index);
    if (radarLayerNext) {
      radarLayerNext.setOpacity(0);
      radarLayerNext.addTo(map);
      map.removeLayer(radarLayerNext);
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
    var d = new Date(frame.time * 1000);
    var timeStr = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    });
    setRadarStatus(timeStr + ' • Past radar', false, false);
  }

  function stepRadar(delta) {
    if (radarFrames.length === 0) return;
    radarIndex = (radarIndex + delta + radarFrames.length) % radarFrames.length;
    showRadarFrame(radarIndex);
    updateRadarTimeDisplay();
    var nextIdx = (radarIndex + 1) % radarFrames.length;
    preloadRadarFrame(nextIdx);
  }

  function setRadarPlaying(playing) {
    radarPlaying = playing;
    document.getElementById('icon-play').classList.toggle('hidden', radarPlaying);
    document.getElementById('icon-pause').classList.toggle('hidden', !radarPlaying);

    clearInterval(radarAnimTimer);
    radarAnimTimer = null;

    if (radarPlaying) {
      radarAnimTimer = setInterval(function () {
        stepRadar(1);
      }, RADAR_ANIMATION_SPEED);
    }
  }

  // ── Camera Layer ──

  function createCameraIcon(type) {
    var isYouTube = type === 'youtube';
    var isEmbed = type === 'embed';
    var cls = isYouTube ? 'camera-marker youtube-marker' : (isEmbed ? 'camera-marker embed-marker' : 'camera-marker');
    var label, svg;
    if (isYouTube) {
      label = 'YouTube live stream';
      svg = '<svg viewBox="0 0 24 24" role="img" aria-label="' + label + '"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/></svg>';
    } else if (isEmbed) {
      label = 'Webcam embed';
      svg = '<svg viewBox="0 0 24 24" role="img" aria-label="' + label + '"><circle cx="12" cy="10" r="3"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-2.67 0-8-1.34-8-4v-.8c0-1.33 5.33-2.7 8-2.7s8 1.37 8 2.7v.8c0 2.66-5.33 4-8 4z"/></svg>';
    } else {
      label = 'Traffic camera';
      svg = '<svg viewBox="0 0 24 24" role="img" aria-label="' + label + '"><path d="M23 19V7.5l-7 4.5V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4l7 4.5z"/></svg>';
    }
    return L.divIcon({
      className: '',
      html: '<div class="' + cls + '">' + svg + '</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }

  async function loadCameras() {
    try {
      document.getElementById('camera-count').textContent = 'Loading cameras…';
      var resp = await fetch('data/cameras.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
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

      var icons = {
        youtube: createCameraIcon('youtube'),
        embed: createCameraIcon('embed'),
        dot: createCameraIcon('dot')
      };

      var markers = [];
      for (var i = 0; i < allCameras.length; i++) {
        var cam = allCameras[i];
        var iconKey = cam.type === 'youtube' ? 'youtube' : (cam.type === 'embed' ? 'embed' : 'dot');
        var marker = L.marker([cam.lat, cam.lon], { icon: icons[iconKey] });
        marker._camData = cam;
        marker.on('click', onCameraClick);
        marker.on('mouseover', onMarkerHover);
        markers.push(marker);
      }

      cameraCluster.addLayers(markers);
      map.addLayer(cameraCluster);
      document.getElementById('camera-count').textContent = allCameras.length.toLocaleString() + ' cameras';
    } catch (e) {
      document.getElementById('camera-count').textContent = 'Failed to load cameras';
    }
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
    var weatherLoading = document.getElementById('weather-loading');
    var weatherData = document.getElementById('weather-data');

    nameEl.textContent = cam.name;
    var locParts = [];
    if (cam.county) locParts.push(cam.county);
    if (cam.state) locParts.push(cam.state);
    if (cam.direction) locParts.push(cam.direction);
    locEl.textContent = locParts.join(' • ');

    feedEl.innerHTML = '<div class="feed-loading">Loading camera feed…</div>';
    weatherLoading.textContent = 'Fetching weather…';
    weatherLoading.classList.remove('hidden');
    weatherData.innerHTML = '';
    weatherData.classList.add('hidden');

    modal.classList.remove('hidden');
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
    feedEl.replaceChildren();

    if (priorFocusEl && priorFocusEl.focus) {
      priorFocusEl.focus();
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

    var isUS = lat >= 17 && lat <= 72 && lon >= -180 && lon <= -65;

    if (isUS) {
      await fetchWeatherNWS(lat, lon, cam, signal, weatherLoading, weatherData);
    } else {
      await fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData);
    }
  }

  async function fetchWeatherNWS(lat, lon, cam, signal, weatherLoading, weatherData) {
    try {
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

      showWeatherItems(weatherLoading, weatherData, [
        ['Temperature', current.temperature + '°' + current.temperatureUnit],
        ['Conditions', current.shortForecast],
        ['Wind', current.windSpeed + ' ' + current.windDirection],
        ['Humidity', current.relativeHumidity ? current.relativeHumidity.value + '%' : 'N/A']
      ]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (activeCamera === cam) {
        weatherLoading.textContent = 'Weather data unavailable for this location.';
      }
    }
  }

  async function fetchWeatherOpenMeteo(lat, lon, cam, signal, weatherLoading, weatherData) {
    try {
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) +
        '&longitude=' + lon.toFixed(4) +
        '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code' +
        '&temperature_unit=fahrenheit&wind_speed_unit=mph';
      var resp = await fetch(url, { signal: signal });
      if (!resp.ok) throw new Error('Open-Meteo failed');
      var data = await resp.json();
      var c = data.current;
      if (!c) throw new Error('No current data');

      if (activeCamera !== cam) return;

      var condition = WMO_CODES[c.weather_code] || 'Unknown';
      var windDir = windDirectionFromDegrees(c.wind_direction_10m || 0);

      showWeatherItems(weatherLoading, weatherData, [
        ['Temperature', Math.round(c.temperature_2m) + '°F'],
        ['Conditions', condition],
        ['Wind', Math.round(c.wind_speed_10m) + ' mph ' + windDir],
        ['Humidity', c.relative_humidity_2m != null ? c.relative_humidity_2m + '%' : 'N/A']
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

  // ── UI Bindings ──

  function bindUI() {
    document.getElementById('btn-layers').addEventListener('click', function () {
      var panel = document.getElementById('layers-panel');
      var isHidden = panel.classList.toggle('hidden');
      this.setAttribute('aria-expanded', !isHidden);
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

    document.getElementById('radar-opacity').addEventListener('input', function () {
      radarOpacity = parseInt(this.value, 10) / 100;
      if (radarLayer) radarLayer.setOpacity(radarOpacity);
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
    });
  }

  function registerServiceWorker() {
    var status = document.getElementById('cache-status');
    var clearButton = document.getElementById('clear-cache');
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

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (registration) {
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

  // ── Boot ──

  initMap();
  bindUI();
  initRadar();
  loadCameras();
  registerServiceWorker();

  window._stormscope = { getMap: function () { return map; } };
})();
