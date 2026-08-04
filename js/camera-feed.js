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
  var OUTAGE_OUTCOME = 'likely_outage';
  var REASON_FLAT_FRAME = 'flat_frame';
  var REASON_COLOR_DEPTH_COLLAPSE = 'color_depth_collapse';
  var REASON_STALLED_FRAME = 'stalled_frame';
  var MAX_FRAME_SAMPLES = 4096;
  var STALLED_FRAME_THRESHOLD = 3;
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

  function unavailableFrame(reason) {
    return { state: 'unavailable', likelyOutage: false, reason: reason || 'unavailable', signature: null };
  }

  // Analyze quantized pixels only. Keeping this pure makes the heuristic easy to
  // bound and test without a browser canvas, while the browser adapter below
  // remains best-effort for cross-origin images that cannot expose pixels.
  function analyzeFramePixels(pixels, width, height, options) {
    options = options || {};
    var maxSamples = Number.isSafeInteger(options.maxSamples) && options.maxSamples > 0
      ? Math.min(options.maxSamples, MAX_FRAME_SAMPLES) : MAX_FRAME_SAMPLES;
    if (!pixels || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width < 1 || height < 1 || width * height > 16 * 1024 * 1024 ||
        pixels.length < width * height * 4) return unavailableFrame('invalid_pixels');

    var stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxSamples)));
    var colors = Object.create(null);
    var sampleCount = 0;
    var dominantCount = 0;
    var uniqueColors = 0;
    var minLuma = 255;
    var maxLuma = 0;
    var sumLuma = 0;
    var sumChannelSpread = 0;
    var hash = 2166136261;

    for (var y = 0; y < height; y += stride) {
      for (var x = 0; x < width; x += stride) {
        var offset = (y * width + x) * 4;
        var red = pixels[offset];
        var green = pixels[offset + 1];
        var blue = pixels[offset + 2];
        var alpha = pixels[offset + 3];
        var color = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
        if (!colors[color]) {
          colors[color] = 0;
          uniqueColors += 1;
        }
        colors[color] += 1;
        if (colors[color] > dominantCount) dominantCount = colors[color];
        var luma = Math.round((299 * red + 587 * green + 114 * blue) / 1000);
        minLuma = Math.min(minLuma, luma);
        maxLuma = Math.max(maxLuma, luma);
        sumLuma += luma;
        sumChannelSpread += Math.max(red, green, blue) - Math.min(red, green, blue);
        hash ^= color;
        hash = Math.imul(hash, 16777619);
        hash ^= alpha >> 4;
        hash = Math.imul(hash, 16777619);
        sampleCount += 1;
      }
    }

    if (!sampleCount) return unavailableFrame('empty_pixels');
    var dominantRatio = dominantCount / sampleCount;
    var lumaRange = maxLuma - minLuma;
    var meanLuma = sumLuma / sampleCount;
    var meanChannelSpread = sumChannelSpread / sampleCount;
    var flat = uniqueColors <= 2 && dominantRatio >= 0.985 && lumaRange <= 6 && meanChannelSpread <= 12;
    var colorDepthCollapse = uniqueColors <= 4 && dominantRatio >= 0.98 && lumaRange <= 14;
    var likelyOutage = flat || colorDepthCollapse;
    return {
      state: 'ready',
      likelyOutage: likelyOutage,
      reason: flat ? REASON_FLAT_FRAME : (colorDepthCollapse ? REASON_COLOR_DEPTH_COLLAPSE : null),
      signature: width + 'x' + height + ':' + (hash >>> 0).toString(16),
      samples: sampleCount,
      uniqueColors: uniqueColors,
      dominantRatio: dominantRatio,
      lumaRange: lumaRange,
      meanLuma: meanLuma,
      stalledFrames: 1
    };
  }

  function analyzeImageFrame(image, documentRef, options) {
    if (!image || !documentRef || typeof documentRef.createElement !== 'function') {
      return unavailableFrame('canvas_unavailable');
    }
    var width = Number(image.naturalWidth || image.videoWidth || image.width);
    var height = Number(image.naturalHeight || image.videoHeight || image.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      return unavailableFrame('image_dimensions_unavailable');
    }
    var maxSamples = Number.isSafeInteger(options && options.maxSamples) && options.maxSamples > 0
      ? Math.min(options.maxSamples, MAX_FRAME_SAMPLES) : MAX_FRAME_SAMPLES;
    var scale = Math.min(1, Math.sqrt(maxSamples / (width * height)));
    var sampleWidth = Math.max(1, Math.round(width * scale));
    var sampleHeight = Math.max(1, Math.round(height * scale));
    try {
      var canvas = documentRef.createElement('canvas');
      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || typeof context.drawImage !== 'function' || typeof context.getImageData !== 'function') {
        return unavailableFrame('canvas_unavailable');
      }
      context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
      var imageData = context.getImageData(0, 0, sampleWidth, sampleHeight);
      return analyzeFramePixels(imageData.data, sampleWidth, sampleHeight, options);
    } catch (error) {
      return unavailableFrame('pixel_access_blocked');
    }
  }

  function createFrameDetector(options) {
    options = options || {};
    var threshold = Number.isSafeInteger(options.stalledFrameThreshold) && options.stalledFrameThreshold >= 2
      ? Math.min(options.stalledFrameThreshold, 6) : STALLED_FRAME_THRESHOLD;
    var previousSignature = null;
    var consecutiveFrames = 0;

    function reset() {
      previousSignature = null;
      consecutiveFrames = 0;
    }

    function observe(analysis) {
      if (!analysis || analysis.state !== 'ready' || !analysis.signature) {
        reset();
        return analysis || null;
      }
      if (analysis.signature === previousSignature) consecutiveFrames += 1;
      else consecutiveFrames = 1;
      previousSignature = analysis.signature;
      var stalled = consecutiveFrames >= threshold;
      return Object.assign({}, analysis, {
        likelyOutage: Boolean(analysis.likelyOutage || stalled),
        reason: analysis.likelyOutage ? analysis.reason : (stalled ? REASON_STALLED_FRAME : null),
        stalledFrames: consecutiveFrames
      });
    }

    return Object.freeze({ observe: observe, reset: reset });
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
    var analyzeImage = typeof options.analyzeImage === 'function' ? options.analyzeImage : null;
    var frameDetector = createFrameDetector(options);
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
      frameDetector.reset();
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
        if (isActive(cam)) observeStillFrame(cam, image, 1, 'mjpeg_rendered');
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
        if (isActive(cam)) observeStillFrame(cam, image, successfulLoads,
          successfulLoads >= 2 ? 'refresh_advanced' : 'initial_image');
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

    function observeStillFrame(cam, image, loadCount, normalReason) {
      var analysis = null;
      if (analyzeImage) {
        try { analysis = frameDetector.observe(analyzeImage(image, cam)); } catch (error) { analysis = null; }
      } else {
        frameDetector.reset();
      }
      if (isActive(cam)) {
        if (analysis && analysis.likelyOutage) observe(cam, OUTAGE_OUTCOME, analysis.reason);
        else observe(cam, loadCount >= 2 ? 'playable' : 'loaded', normalReason);
      }
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
    OUTAGE_OUTCOME: OUTAGE_OUTCOME,
    REASON_FLAT_FRAME: REASON_FLAT_FRAME,
    REASON_COLOR_DEPTH_COLLAPSE: REASON_COLOR_DEPTH_COLLAPSE,
    REASON_STALLED_FRAME: REASON_STALLED_FRAME,
    analyzeFramePixels: analyzeFramePixels,
    analyzeImageFrame: analyzeImageFrame,
    createFrameDetector: createFrameDetector,
    TRUSTED_EMBED_HOST_SUFFIXES: TRUSTED_EMBED_HOST_SUFFIXES,
    hostMatchesSuffix: hostMatchesSuffix,
    isAllowedEmbedUrl: isAllowedEmbedUrl,
    youtubeEmbedUrl: youtubeEmbedUrl,
    create: create
  });
});
