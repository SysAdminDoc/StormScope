(function () {
  'use strict';

  var MAP_CENTER = [39.5, -98.5];
  var MAP_ZOOM = 5;
  var RADAR_ANIMATION_SPEED = 800;
  var IMAGE_REFRESH_INTERVAL = 15000;

  var map, radarLayer, cameraCluster;
  var radarFrames = [];
  var radarPastCount = 0;
  var radarIndex = 0;
  var radarPlaying = false;
  var radarAnimTimer = null;
  var radarOpacity = 0.65;
  var radarVisible = true;
  var activeCamera = null;
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
      updateRadarTimeDisplay();
    } catch (e) {
      document.getElementById('radar-time').textContent = 'Radar unavailable';
    }
  }

  function showRadarFrame(index) {
    if (radarLayer) {
      map.removeLayer(radarLayer);
      radarLayer = null;
    }
    var frame = radarFrames[index];
    if (!frame) return;
    radarLayer = L.tileLayer(
      'https://tilecache.rainviewer.com' + frame.path + '/256/{z}/{x}/{y}/6/1_1.png',
      { opacity: radarOpacity, zIndex: 400 }
    );
    if (radarVisible) {
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

  function createCameraIcon(isYouTube) {
    var cls = isYouTube ? 'camera-marker youtube-marker' : 'camera-marker';
    var label = isYouTube ? 'YouTube live stream' : 'Traffic camera';
    var svg = isYouTube
      ? '<svg viewBox="0 0 24 24" role="img" aria-label="' + label + '"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/></svg>'
      : '<svg viewBox="0 0 24 24" role="img" aria-label="' + label + '"><path d="M23 19V7.5l-7 4.5V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4l7 4.5z"/></svg>';
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

      var dotIcon = createCameraIcon(false);
      var ytIcon = createCameraIcon(true);
      for (var i = 0; i < allCameras.length; i++) {
        var cam = allCameras[i];
        var marker = L.marker([cam.lat, cam.lon], { icon: cam.type === 'youtube' ? ytIcon : dotIcon });
        marker._camData = cam;
        marker.on('click', onCameraClick);
        marker.bindTooltip(escapeHtml(cam.name), {
          direction: 'top',
          offset: [0, -14],
          className: 'cam-tooltip'
        });
        cameraCluster.addLayer(marker);
      }

      map.addLayer(cameraCluster);
      document.getElementById('camera-count').textContent = allCameras.length.toLocaleString() + ' cameras';
    } catch (e) {
      document.getElementById('camera-count').textContent = 'Failed to load cameras';
    }
  }

  function onCameraClick(e) {
    var cam = e.target._camData;
    openCameraModal(cam);
  }

  // ── Camera Modal ──

  function openCameraModal(cam) {
    activeCamera = cam;
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

  function loadEmbedFeed(cam, container) {
    var iframe = document.createElement('iframe');
    iframe.src = cam.url;
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.cssText = 'min-height:400px;border:none;';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.allowFullscreen = true;
    iframe.title = cam.name;
    iframe.setAttribute('loading', 'lazy');

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

  // ── NWS Weather ──

  async function fetchWeather(lat, lon, cam) {
    var weatherLoading = document.getElementById('weather-loading');
    var weatherData = document.getElementById('weather-data');

    if (weatherAbort) weatherAbort.abort();
    weatherAbort = new AbortController();
    var signal = weatherAbort.signal;

    var isUS = lat >= 17 && lat <= 72 && lon >= -180 && lon <= -65;

    if (!isUS) {
      weatherLoading.textContent = 'Weather data is available for US locations only (NWS coverage).';
      return;
    }

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

      weatherData.innerHTML = '';
      var items = [
        ['Temperature', current.temperature + '°' + current.temperatureUnit],
        ['Conditions', current.shortForecast],
        ['Wind', current.windSpeed + ' ' + current.windDirection],
        ['Humidity', current.relativeHumidity ? current.relativeHumidity.value + '%' : 'N/A']
      ];
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
        weatherData.appendChild(item);
      }

      weatherLoading.classList.add('hidden');
      weatherData.classList.remove('hidden');
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (activeCamera === cam) {
        weatherLoading.textContent = 'Weather data unavailable for this location.';
      }
    }
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
