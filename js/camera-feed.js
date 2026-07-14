/* Camera modal feed players with one owner for timers, media, and frame cleanup. */
'use strict';

(function (root, factory) {
  var cameraRecord = typeof module === 'object' && module.exports
    ? require('./camera-record.js')
    : root && root.StormScopeCameraRecord;
  var api = factory(cameraRecord);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeCameraFeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cameraRecord) {
  if (!cameraRecord) throw new Error('Camera feed requires the shared camera-record contract');
  var OBSERVATION_UNSUPPORTED = 'unsupported';
  var REASON_BROWSER_HLS = 'browser_hls';
  var REASON_UNTRUSTED_EMBED = 'untrusted_embed';
  var TRUSTED_EMBED_HOST_SUFFIXES = cameraRecord.TRUSTED_EMBED_HOST_SUFFIXES;

  function requireFunction(value, label) {
    if (typeof value !== 'function') throw new TypeError(label + ' callback is required');
    return value;
  }

  var hostMatchesSuffix = cameraRecord.hostMatchesSuffix;
  var isAllowedEmbedUrl = cameraRecord.isAllowedEmbedUrl;

  function youtubeEmbedUrl(videoId, extraParams, origin) {
    var params = 'autoplay=1&mute=1&playsinline=1&rel=0';
    if (extraParams) params += '&' + extraParams;
    if (origin && origin !== 'null') params += '&origin=' + encodeURIComponent(origin);
    return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(videoId) + '?' + params;
  }

  function create(options) {
    options = options || {};
    var documentRef = options.document;
    if (!documentRef || typeof documentRef.createElement !== 'function') {
      throw new TypeError('camera feed document dependency is required');
    }
    var translate = requireFunction(options.translate, 'camera feed translate');
    var number = requireFunction(options.localNumber, 'camera feed localNumber');
    var refreshInterval = requireFunction(options.imageRefreshInterval, 'camera feed imageRefreshInterval');
    var isActive = requireFunction(options.isActive, 'camera feed isActive');
    var observe = requireFunction(options.recordObservation, 'camera feed recordObservation');
    var schedule = requireFunction(options.setTimeout, 'camera feed setTimeout');
    var cancel = requireFunction(options.clearTimeout, 'camera feed clearTimeout');
    var now = requireFunction(options.now, 'camera feed now');
    var HlsConstructor = options.Hls;
    var origin = String(options.origin || '');
    var trustedSuffixes = options.trustedEmbedHostSuffixes || TRUSTED_EMBED_HOST_SUFFIXES;
    var cleanup = null;
    var imageRefreshTimer = null;
    var currentContainer = null;

    function appendLiveIndicator(container, label) {
      var indicator = documentRef.createElement('div');
      indicator.className = 'feed-refresh-indicator';
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-label', label);
      indicator.title = label;
      container.appendChild(indicator);
    }

    function destroy(container) {
      if (imageRefreshTimer != null) cancel(imageRefreshTimer);
      imageRefreshTimer = null;

      var release = cleanup;
      cleanup = null;
      if (release) release();

      var target = container || currentContainer;
      if (!target) return;
      var orphanedVideos = target.querySelectorAll('video');
      for (var i = 0; i < orphanedVideos.length; i++) {
        orphanedVideos[i].pause();
        orphanedVideos[i].removeAttribute('src');
        orphanedVideos[i].load();
      }
      var orphanedFrames = target.querySelectorAll('iframe');
      for (var j = 0; j < orphanedFrames.length; j++) orphanedFrames[j].src = 'about:blank';
      if (target === currentContainer) currentContainer = null;
    }

    function renderError(cam, container, message, outcome, reason) {
      if (!isActive(cam)) return;
      observe(cam, outcome || 'unavailable', reason || 'playback_error');
      destroy(container);

      var error = documentRef.createElement('div');
      error.className = 'feed-error';
      error.setAttribute('role', 'alert');

      var text = documentRef.createElement('p');
      text.textContent = message;
      error.appendChild(text);

      var retry = documentRef.createElement('button');
      retry.type = 'button';
      retry.className = 'feed-retry-btn';
      retry.textContent = translate('camera.feedRetry');
      retry.addEventListener('click', function () {
        if (!isActive(cam)) return;
        observe(cam, 'retrying', 'manual_retry');
        var loading = documentRef.createElement('div');
        loading.className = 'feed-loading';
        loading.textContent = translate('camera.retrying');
        container.replaceChildren(loading);
        load(cam, container);
      });
      error.appendChild(retry);

      var source = documentRef.createElement('a');
      source.className = 'feed-source-link';
      source.href = cam.type === 'youtube'
        ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(cam.url)
        : cam.url;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = translate('camera.openSource');
      error.appendChild(source);
      container.replaceChildren(error);
      currentContainer = container;
    }

    function appendFrameFallback(cam, container, iframe, sourceUrl) {
      var actions = documentRef.createElement('div');
      actions.className = 'feed-frame-actions';

      var retry = documentRef.createElement('button');
      retry.type = 'button';
      retry.className = 'feed-retry-btn';
      retry.textContent = translate('camera.reload');
      retry.addEventListener('click', function () {
        if (!isActive(cam)) return;
        observe(cam, 'retrying', 'manual_retry');
        destroy(container);
        load(cam, container);
      });

      var source = documentRef.createElement('a');
      source.className = 'feed-source-link';
      source.href = sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = translate('camera.openSource');
      actions.appendChild(retry);
      actions.appendChild(source);
      container.appendChild(actions);

      var timeout = schedule(function () {
        if (isActive(cam)) renderError(cam, container, translate('feed.embedTimeout'));
      }, 12000);
      iframe.addEventListener('load', function () { cancel(timeout); }, { once: true });
      return function () { cancel(timeout); };
    }

    function loadHls(cam, container) {
      var video = documentRef.createElement('video');
      video.referrerPolicy = 'no-referrer';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.controls = true;
      var hls = null;
      var destroyed = false;

      cleanup = function () {
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

      if (HlsConstructor && HlsConstructor.isSupported()) {
        hls = new HlsConstructor({
          enableWorker: true,
          lowLatencyMode: true,
          maxBufferLength: 10,
          maxMaxBufferLength: 20
        });
        hls.loadSource(cam.url);
        hls.attachMedia(video);
        hls.on(HlsConstructor.Events.ERROR, function (event, data) {
          if (data.fatal) renderError(cam, container, translate('feed.streamUnavailable'));
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = cam.url;
        video.addEventListener('error', function () {
          renderError(cam, container, translate('feed.streamUnavailable'));
        }, { once: true });
      } else {
        renderError(cam, container, translate('feed.hlsUnsupported'), OBSERVATION_UNSUPPORTED, REASON_BROWSER_HLS);
        return;
      }

      video.addEventListener('loadeddata', function () {
        if (isActive(cam)) observe(cam, 'playable', 'decoded_media');
      }, { once: true });
      container.replaceChildren(video);
      appendLiveIndicator(container, translate('camera.liveStream'));
    }

    function loadMjpeg(cam, container) {
      var image = documentRef.createElement('img');
      image.referrerPolicy = 'no-referrer';
      image.alt = cam.name;
      image.src = cam.url;
      image.onerror = function () {
        if (isActive(cam)) renderError(cam, container, translate('feed.cameraUnavailable'));
      };
      image.onload = function () {
        if (isActive(cam)) observe(cam, 'playable', 'mjpeg_rendered');
      };
      cleanup = function () {
        image.onload = null;
        image.onerror = null;
        image.src = '';
      };
      container.replaceChildren(image);
      appendLiveIndicator(container, translate('camera.liveMjpeg'));
    }

    function loadYouTube(cam, container) {
      var iframe = documentRef.createElement('iframe');
      var sourceUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(cam.url);
      iframe.src = youtubeEmbedUrl(cam.url, '', origin);
      iframe.width = '100%';
      iframe.height = '100%';
      iframe.style.cssText = 'min-height:400px;border:none;';
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.title = cam.name;
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      container.replaceChildren(iframe);
      var clearLoadTimeout = appendFrameFallback(cam, container, iframe, sourceUrl);
      cleanup = function () {
        clearLoadTimeout();
        iframe.src = 'about:blank';
      };
      appendLiveIndicator(container, translate('camera.youtubeLive'));
    }

    function loadEmbed(cam, container) {
      if (!isAllowedEmbedUrl(cam.url, trustedSuffixes)) {
        renderError(cam, container, translate('feed.untrusted'), OBSERVATION_UNSUPPORTED, REASON_UNTRUSTED_EMBED);
        return;
      }
      var iframe = documentRef.createElement('iframe');
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
        if (isActive(cam)) renderError(cam, container, translate('feed.embedUnavailable'));
      };
      container.replaceChildren(iframe);
      var clearLoadTimeout = appendFrameFallback(cam, container, iframe, cam.url);
      cleanup = function () {
        clearLoadTimeout();
        iframe.onerror = null;
        iframe.src = 'about:blank';
      };
    }

    function loadImage(cam, container) {
      var image = documentRef.createElement('img');
      image.referrerPolicy = 'no-referrer';
      image.alt = cam.name;
      var successfulLoads = 0;

      function setImageSource() {
        image.src = cam.url + (cam.url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + now();
      }

      image.onerror = function () {
        if (isActive(cam)) renderError(cam, container, translate('feed.imageUnavailable'));
      };
      image.onload = function () {
        successfulLoads += 1;
        if (isActive(cam)) {
          observe(cam, successfulLoads >= 2 ? 'playable' : 'loaded',
            successfulLoads >= 2 ? 'refresh_advanced' : 'initial_image');
        }
        var loading = container.querySelector('.feed-loading');
        if (loading) loading.remove();
      };
      setImageSource();
      cleanup = function () {
        image.onload = null;
        image.onerror = null;
        image.src = '';
      };
      container.replaceChildren(image);
      appendLiveIndicator(container, translate('camera.autoRefresh', {
        seconds: number(refreshInterval() / 1000)
      }));

      function scheduleImageRefresh() {
        if (imageRefreshTimer != null) cancel(imageRefreshTimer);
        imageRefreshTimer = schedule(function () {
          if (!isActive(cam)) return;
          setImageSource();
          scheduleImageRefresh();
        }, refreshInterval());
      }
      scheduleImageRefresh();
    }

    function load(cam, container) {
      if (!cam || !container || typeof container.replaceChildren !== 'function') {
        throw new TypeError('camera and feed container are required');
      }
      destroy(currentContainer || container);
      currentContainer = container;
      if (cam.type === 'youtube') loadYouTube(cam, container);
      else if (cam.type === 'hls') loadHls(cam, container);
      else if (cam.type === 'mjpeg') loadMjpeg(cam, container);
      else if (cam.type === 'embed') loadEmbed(cam, container);
      else loadImage(cam, container);
    }

    return Object.freeze({ load: load, destroy: destroy });
  }

  return Object.freeze({
    OBSERVATION_UNSUPPORTED: OBSERVATION_UNSUPPORTED,
    REASON_BROWSER_HLS: REASON_BROWSER_HLS,
    REASON_UNTRUSTED_EMBED: REASON_UNTRUSTED_EMBED,
    TRUSTED_EMBED_HOST_SUFFIXES: TRUSTED_EMBED_HOST_SUFFIXES,
    hostMatchesSuffix: hostMatchesSuffix,
    isAllowedEmbedUrl: isAllowedEmbedUrl,
    youtubeEmbedUrl: youtubeEmbedUrl,
    create: create
  });
});
