(function () {
  'use strict';

  var MAP_CENTER = [39.5, -98.5];
  var MAP_ZOOM = 5;
  var RADAR_ANIMATION_SPEED = 800;
  var IMAGE_REFRESH_INTERVAL = 15000;
  var EMBED_ALLOWLIST = [
    'earthcam.com', 'nps.gov', 'livebeaches.com', 'brownrice.com',
    'wxyz.com', 'skylinewebcams.com', 'webcamtaxi.com', 'windy.com',
    'dot.gov', 'dot.state', '511', 'wsdot.wa.gov'
  ];

  var map, radarLayer, radarLayerNext, cameraCluster;
  var radarFrames = [];
  var radarPastCount = 0;
  var radarIndex = 0;
  var radarPlaying = false;
  var radarAnimTimer = null;
  var radarOpacity = 0.65;
  var radarVisible = true;
  var activeCamera = null;
  var priorFocusEl = null;
  var weatherAbort = null;
  var imageRefreshTimer = null;
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
      maxZoom: 19
    }).addTo(map);
  }

  // ── RainViewer Radar ──

  async function initRadar() {
    try {
      var resp = await fetch('https://api.rainviewer.com/public/weather-maps.json');
      if (!resp.ok) throw new Error(resp.status);
      var data = await resp.json();
      var past = data.radar.past || [];
      var nowcast = data.radar.nowcast || [];
      radarPastCount = past.length;
      radarFrames = past.concat(nowcast);
      if (radarFrames.length === 0) return;
      radarIndex = radarFrames.length - 1;
      showRadarFrame(radarIndex);
      preloadRadarFrame(radarIndex > 0 ? radarIndex - 1 : radarFrames.length - 1);
      updateRadarTimeDisplay();
    } catch (e) {
      document.getElementById('radar-time').textContent = 'Radar unavailable';
    }
  }

  function createRadarTileLayer(index) {
    var frame = radarFrames[index];
    if (!frame) return null;
    return L.tileLayer(
      'https://tilecache.rainviewer.com' + frame.path + '/256/{z}/{x}/{y}/6/1_1.png',
      { opacity: radarOpacity, zIndex: 400 }
    );
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
    var label = radarIndex >= radarPastCount ? 'Forecast' : 'Past';
    document.getElementById('radar-time').textContent = timeStr + ' • ' + label;
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
    clearInterval(imageRefreshTimer);
    imageRefreshTimer = null;
    if (weatherAbort) {
      weatherAbort.abort();
      weatherAbort = null;
    }

    document.removeEventListener('keydown', trapFocus);

    var feedEl = document.getElementById('modal-feed');
    var video = feedEl.querySelector('video');
    if (video) {
      video.pause();
      if (video._hls) {
        video._hls.destroy();
      }
      video.src = '';
    }
    var iframe = feedEl.querySelector('iframe');
    if (iframe) {
      iframe.src = '';
    }

    document.getElementById('camera-modal').classList.add('hidden');
    feedEl.innerHTML = '';

    if (priorFocusEl && priorFocusEl.focus) {
      priorFocusEl.focus();
      priorFocusEl = null;
    }
  }

  function loadCameraFeed(cam, container) {
    clearInterval(imageRefreshTimer);

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

  function loadHLSFeed(cam, container) {
    var video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = true;

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      var hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: 10,
        maxMaxBufferLength: 20
      });
      hls.loadSource(cam.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          container.innerHTML = '<div class="feed-error">Stream unavailable. The camera may be offline or blocked by CORS.</div>';
        }
      });
      video._hls = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = cam.url;
    } else {
      container.innerHTML = '<div class="feed-error">HLS not supported in this browser.</div>';
      return;
    }

    container.innerHTML = '';
    container.appendChild(video);
    appendLiveIndicator(container, 'Live stream');
  }

  function loadMJPEGFeed(cam, container) {
    var img = document.createElement('img');
    img.alt = cam.name;
    img.src = cam.url;

    img.onerror = function () {
      if (activeCamera === cam) {
        container.innerHTML = '<div class="feed-error">Camera feed unavailable. The camera may be offline.</div>';
      }
    };

    container.innerHTML = '';
    container.appendChild(img);
    appendLiveIndicator(container, 'Live MJPEG stream');
  }

  function loadYouTubeFeed(cam, container) {
    var iframe = document.createElement('iframe');
    iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(cam.url) + '?autoplay=1&mute=1&playsinline=1';
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.cssText = 'min-height:400px;border:none;';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.title = cam.name;

    container.innerHTML = '';
    container.appendChild(iframe);
    appendLiveIndicator(container, 'YouTube live stream');
  }

  function isAllowedEmbedUrl(url) {
    try {
      var hostname = new URL(url).hostname.toLowerCase();
      for (var i = 0; i < EMBED_ALLOWLIST.length; i++) {
        if (hostname.indexOf(EMBED_ALLOWLIST[i]) !== -1) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function loadEmbedFeed(cam, container) {
    if (!isAllowedEmbedUrl(cam.url)) {
      container.innerHTML = '<div class="feed-error">This embed source is not recognized.</div>';
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
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');

    iframe.onerror = function () {
      if (activeCamera === cam) {
        container.innerHTML = '<div class="feed-error">Embed unavailable. The camera page may be offline.</div>';
      }
    };

    container.innerHTML = '';
    container.appendChild(iframe);
  }

  function loadImageFeed(cam, container) {
    var img = document.createElement('img');
    img.alt = cam.name;

    function setImageSrc() {
      img.src = cam.url + (cam.url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
    }

    img.onerror = function () {
      if (activeCamera === cam) {
        container.innerHTML = '<div class="feed-error">Camera image unavailable. The camera may be offline.</div>';
        clearInterval(imageRefreshTimer);
      }
    };

    img.onload = function () {
      var loadingEl = container.querySelector('.feed-loading');
      if (loadingEl) loadingEl.remove();
    };

    setImageSrc();
    container.innerHTML = '';
    container.appendChild(img);
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
        headers: { 'Accept': 'application/geo+json', 'User-Agent': 'StormScope/1.0' },
        signal: signal
      });
      if (!pointResp.ok) throw new Error('NWS point lookup failed');
      var pointData = await pointResp.json();
      var forecastUrl = pointData.properties.forecastHourly;
      if (!forecastUrl) throw new Error('No forecast URL');

      var fcResp = await fetch(forecastUrl, {
        headers: { 'Accept': 'application/geo+json', 'User-Agent': 'StormScope/1.0' },
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

  // ── Boot ──

  initMap();
  bindUI();
  initRadar();
  loadCameras();

  window._stormscope = { getMap: function () { return map; } };
})();
