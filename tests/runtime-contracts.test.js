const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const contextLayers = fs.readFileSync(path.join(root, 'js', 'context-layers.js'), 'utf8');
const solarTerminator = fs.readFileSync(path.join(root, 'js', 'solar-terminator.js'), 'utf8');
const weather = fs.readFileSync(path.join(root, 'js', 'weather.js'), 'utf8');
const contextControllers = fs.readFileSync(path.join(root, 'js', 'context-layer-controllers.js'), 'utf8');
const spcReports = fs.readFileSync(path.join(root, 'js', 'spc-reports.js'), 'utf8');
const surfaceObservations = fs.readFileSync(path.join(root, 'js', 'surface-observations.js'), 'utf8');
const cameraRecordSource = fs.readFileSync(path.join(root, 'js', 'camera-record.js'), 'utf8');
const cameraFeedSource = fs.readFileSync(path.join(root, 'js', 'camera-feed.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const radarControllerSource = fs.readFileSync(path.join(root, 'js', 'radar-controller.js'), 'utf8');
const radarMotionSource = fs.readFileSync(path.join(root, 'js', 'radar-motion.js'), 'utf8');
const radarMotionWorkerSource = fs.readFileSync(path.join(root, 'js', 'radar-motion-worker.js'), 'utf8');
const riverGaugesSource = fs.readFileSync(path.join(root, 'js', 'river-gauges.js'), 'utf8');
const earthquakeSource = fs.readFileSync(path.join(root, 'js', 'earthquakes.js'), 'utf8');
const winterOutlooksSource = fs.readFileSync(path.join(root, 'js', 'winter-outlooks.js'), 'utf8');
const fireWeatherSource = fs.readFileSync(path.join(root, 'js', 'fire-weather.js'), 'utf8');
const spaceWeatherSource = fs.readFileSync(path.join(root, 'js', 'space-weather.js'), 'utf8');
const marineBuoysSource = fs.readFileSync(path.join(root, 'js', 'marine-buoys.js'), 'utf8');
const cpcOutlooksSource = fs.readFileSync(path.join(root, 'js', 'cpc-outlooks.js'), 'utf8');
const spatialQuery = fs.readFileSync(path.join(root, 'js', 'spatial-query.js'), 'utf8');
const spatialQuerySource = spatialQuery;
const privateAnnotationSource = fs.readFileSync(path.join(root, 'js', 'private-annotations.js'), 'utf8');
const wakeLockSource = fs.readFileSync(path.join(root, 'js', 'wake-lock.js'), 'utf8');
const layerRegistrySource = fs.readFileSync(path.join(root, 'js', 'layer-registry.js'), 'utf8');
const situationSnapshotSource = fs.readFileSync(path.join(root, 'js', 'situation-snapshot.js'), 'utf8');
const cameraData = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cameras.json'), 'utf8'));
const i18n = require('../js/i18n.js');
const cameraRecord = require('../js/camera-record.js');
const cameraFeed = require('../js/camera-feed.js');
const situationSnapshot = require('../js/situation-snapshot.js');

test('RainViewer uses the 2026 past-radar contract', () => {
  assert.match(radarControllerSource, /COLOR_SCHEME = 2/);
  assert.match(radarControllerSource, /MAX_NATIVE_ZOOM = 7/);
  assert.match(radarControllerSource, /parseXyzDiscovery/);
  assert.match(radarControllerSource, /discoverNoaa/);
  assert.match(radarControllerSource, /discoverRidge/);
  assert.match(radarControllerSource, /selectProvider/);
  assert.match(radarControllerSource, /sampleCenter/);
  assert.match(radarControllerSource, /maxNativeZoom: provider\.tile\.maxNativeZoom/);
  assert.match(radarControllerSource, /crossOrigin: 'anonymous'/);
  assert.match(radarControllerSource, /radar\.pastFrame/);
  assert.match(i18n.catalogs.en['radar.pastFrame'], /Past radar/);
  assert.match(radarControllerSource, /function clearDisplay\(\)/);
  assert.match(radarControllerSource, /layer\.on\('tileerror'/);
  assert.match(html, /js\/radar-controller\.js[\s\S]*js\/app\.js/);
  assert.match(serviceWorker, /\.\/js\/radar-controller\.js/);
  assert.doesNotMatch(app, /\bvar radarFrames\b/);
  assert.doesNotMatch(app, /function initRadar\(/);
  assert.match(html, /href="https:\/\/www\.rainviewer\.com\/"/);
  assert.match(html, /id="radar-retry"/);
});

test('motion playback remains an opt-in bounded worker preview with crossfade fallback', () => {
  assert.match(html, /js\/radar-motion\.js[\s\S]*js\/radar-controller\.js[\s\S]*js\/app\.js/);
  assert.match(html, /id="radar-motion-prototype"[^>]*type="checkbox"/);
  assert.match(html, /id="radar-motion-preview"[^>]*width="128"[^>]*height="72"/);
  assert.match(serviceWorker, /\.\/js\/radar-motion\.js/);
  assert.match(serviceWorker, /\.\/js\/radar-motion-worker\.js/);
  assert.match(radarMotionSource, /MAX_PIXELS = 128 \* 72/);
  assert.match(radarMotionSource, /reason: 'reduced-motion'/);
  assert.match(radarMotionSource, /reason: 'low-data'/);
  assert.match(radarMotionSource, /reason: 'comparison'/);
  assert.match(radarMotionSource, /reason: 'memory'/);
  assert.match(radarMotionSource, /mode: 'crossfade'/);
  assert.match(radarMotionSource, /worker\.terminate/);
  assert.match(radarMotionWorkerSource, /bounded block-matching/);
  assert.match(radarMotionWorkerSource, /data\.width \* data\.height > 128 \* 72/);
  assert.match(radarControllerSource, /setMotionPrototypeEnabled/);
  assert.match(radarControllerSource, /supportsFuture === false/);
  assert.match(radarControllerSource, /refreshMotionPrototype/);
  assert.match(app, /radar-motion-prototype/);
  assert.match(app, /radar\.motionFallback/);
});

test('embed trust uses exact host-or-subdomain matching', () => {
  assert.equal(cameraFeed.TRUSTED_EMBED_HOST_SUFFIXES, cameraRecord.TRUSTED_EMBED_HOST_SUFFIXES);
  assert.equal(cameraFeed.hostMatchesSuffix('earthcam.com', 'earthcam.com'), true);
  assert.equal(cameraFeed.hostMatchesSuffix('www.earthcam.com', 'earthcam.com'), true);
  assert.equal(cameraFeed.hostMatchesSuffix('earthcam.com.attacker.example', 'earthcam.com'), false);
  assert.equal(cameraFeed.hostMatchesSuffix('notearthcam.com', 'earthcam.com'), false);

  for (const suffix of ['abbeyroad.com', 'v.angelcam.com', 'cdn.jwplayer.com', 'esbnyc.com',
    'weathercams.faa.gov', 'hazcams.com', 'ipcamlive.com', 'rtsp.me']) {
    assert.ok(cameraFeed.TRUSTED_EMBED_HOST_SUFFIXES.includes(suffix));
  }
  assert.doesNotMatch(cameraRecordSource, /hostname\.indexOf/);
  assert.doesNotMatch(cameraRecordSource, /'511'/);
  assert.match(cameraRecordSource, /parsed\.protocol !== 'https:'/);

  const suffixes = cameraFeed.TRUSTED_EMBED_HOST_SUFFIXES;
  const rejectedEmbeds = cameraData.filter((camera) => {
    if (camera.type !== 'embed') return false;
    const parsed = new URL(camera.url);
    return parsed.protocol !== 'https:' || !suffixes.some((suffix) => cameraFeed.hostMatchesSuffix(parsed.hostname, suffix));
  });
  assert.deepEqual(rejectedEmbeds, [], 'every shipped embed should pass the exact trust policy');
  cameraData.forEach((camera) => cameraRecord.validateCameraRecord(camera));
});

test('feed failures tear down resources before replacing the DOM and are retryable', () => {
  const renderMatch = cameraFeedSource.match(/function renderError\([\s\S]*?\n    \}/);
  assert.ok(renderMatch, 'renderError should exist');
  const renderSource = renderMatch[0];
  assert.ok(renderSource.indexOf('destroy(container)') < renderSource.indexOf('container.replaceChildren(error)'));
  assert.match(cameraFeedSource, /if \(destroyed\) return;/);
  assert.match(cameraFeedSource, /hls\.destroy\(\)/);
  assert.match(cameraFeedSource, /camera\.feedRetry/);
  assert.equal(i18n.catalogs.en['camera.feedRetry'], 'Retry feed');
  assert.match(css, /\.feed-retry-btn/);
  assert.match(cameraFeedSource, /appendFrameFallback/);
  assert.match(cameraFeedSource, /camera\.openSource/);
  assert.equal(i18n.catalogs.en['camera.openSource'], 'Open source');
});

test('still-frame outage detection is opt-in, bounded, visible, and local-only', () => {
  assert.match(cameraFeedSource, /function analyzeFramePixels/);
  assert.match(cameraFeedSource, /MAX_FRAME_SAMPLES = 4096/);
  assert.match(cameraFeedSource, /STALLED_FRAME_THRESHOLD = 3/);
  assert.match(cameraFeedSource, /function createFrameDetector/);
  assert.match(cameraFeedSource, /OUTAGE_OUTCOME = 'likely_outage'/);
  assert.match(html, /id="camera-outage-check"/);
  assert.match(html, /id="modal-camera-outage"[^>]*class="camera-outage-badge hidden"/);
  assert.match(app, /stormscope-camera-outage-check-v1/);
  assert.match(app, /StormScopeCameraFeed\.analyzeImageFrame/);
  assert.match(app, /camera\.local_observation\.outcome === 'likely_outage'/);
  assert.match(app, /cam\.local_observation = observation/);
  assert.doesNotMatch(app, /cam\.health\s*=/);
  assert.match(css, /\.camera-outage-badge/);
  for (const locale of ['en', 'es']) {
    for (const key of ['camera.outageCheck', 'camera.outageBadge', 'camera.outageDescription',
      'camera.observation.outcome.likely_outage', 'camera.observation.reason.flat_frame',
      'camera.observation.reason.color_depth_collapse', 'camera.observation.reason.stalled_frame']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
});

test('extracted lifecycle modules load before app, remain offline, and own one teardown loop', () => {
  const recordPosition = html.indexOf('js/camera-record.js');
  const storePosition = html.indexOf('js/camera-store.js');
  const cameraPosition = html.indexOf('js/camera-feed.js');
  const controllerPosition = html.indexOf('js/context-layer-controllers.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(recordPosition >= 0 && storePosition > recordPosition && cameraPosition > recordPosition && controllerPosition >= 0 &&
    appPosition > cameraPosition && appPosition > controllerPosition);
  assert.match(serviceWorker, /\.\/js\/camera-record\.js/);
  assert.match(serviceWorker, /\.\/js\/camera-feed\.js/);
  assert.match(serviceWorker, /\.\/js\/context-layer-controllers\.js/);
  assert.match(app, /STORMSCOPE_CAMERA_GENERATION_COMPLETE/);
  assert.match(serviceWorker, /rememberCompleteCameraGeneration/);
  assert.match(serviceWorker, /CAMERA_CACHE_MAX_BYTES = 64 \* 1024 \* 1024/);
  assert.match(contextControllers, /function createControllerSet/);
  assert.match(app, /teardownResources\.forEach\(function \(resource\) \{ resource\.destroy\(\); \}\)/);
  assert.doesNotMatch(app, /function loadHLSFeed/);
  const reportsPosition = html.indexOf('js/spc-reports.js');
  assert.ok(reportsPosition >= 0 && appPosition > reportsPosition);
  assert.match(serviceWorker, /\.\/js\/spc-reports\.js/);
  assert.match(spcReports, /function fetchAllPages/);
});

test('NWPS river gauges are bounded, forecast-aware, and lifecycle-owned', () => {
  const floodPosition = html.indexOf('js/flood-outlooks.js');
  const gaugePosition = html.indexOf('js/river-gauges.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(floodPosition >= 0 && gaugePosition > floodPosition && appPosition > gaugePosition);
  assert.match(serviceWorker, /var VERSION = 'v116'/);
  assert.match(serviceWorker, /\.\/js\/river-gauges\.js/);
  assert.match(riverGaugesSource, /resultRecordCount: String\(MAX_RECORDS\)/);
  assert.match(riverGaugesSource, /function buildQueries\(bounds, zoom\)/);
  assert.match(riverGaugesSource, /function stageflowUrl\(identifier\)/);
  assert.match(riverGaugesSource, /Promise\.allSettled/);
  assert.match(riverGaugesSource, /state\.lastGood = Boolean\(state\.layer\)/);
  assert.match(riverGaugesSource, /gaugeObserved/);
  assert.match(riverGaugesSource, /gaugeForecast/);
  assert.match(app, /StormScopeRiverGauges\.create/);
  assert.match(app, /riverGaugesController\.scheduleMoveRefresh/);
  assert.doesNotMatch(app, /\bvar usgsGaugeLayer\b/);
  assert.doesNotMatch(app, /StormScopeFloodOutlooks\.usgsUrl/);
  assert.match(html, /data-i18n="layers\.usgsGauges"[^>]*>NOAA NWPS River Gauges/);
  assert.match(i18n.catalogs.en['layers.usgsGauges'], /NOAA NWPS/);
  assert.match(i18n.catalogs.es['layers.usgsGauges'], /NOAA NWPS/);
});

test('WPC Winter Storm Severity Index is an optional bounded attributed layer', () => {
  const floodPosition = html.indexOf('js/flood-outlooks.js');
  const wssiPosition = html.indexOf('js/winter-outlooks.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(floodPosition >= 0 && wssiPosition > floodPosition && appPosition > wssiPosition);
  assert.match(serviceWorker, /\.\/js\/winter-outlooks\.js/);
  assert.match(winterOutlooksSource, /MapServer';/);
  assert.match(winterOutlooksSource, /var LAYER_ID = 4/);
  assert.match(winterOutlooksSource, /resultRecordCount: String\(PAGE_SIZE\)/);
  assert.match(winterOutlooksSource, /function normalizeCollection/);
  assert.match(winterOutlooksSource, /function fetchAllPages/);
  assert.match(html, /id="toggle-wssi"/);
  assert.match(html, /id="wssi-status"[^>]*role="status"/);
  assert.match(html, /data-i18n="layers\.wssi"/);
  assert.match(app, /function refreshWssi/);
  assert.match(app, /function disableWssi/);
  assert.match(app, /StormScopeWinterOutlooks\.fetchAllPages/);
  assert.match(layerRegistrySource, /id: 'wssi', toggleId: 'toggle-wssi'/);
  assert.equal(i18n.catalogs.en['layers.wssi'], 'WPC Winter Storm Severity Index');
  assert.ok(i18n.catalogs.es['layers.wssi']);
});

test('static CSP removes inline script execution and mirrors trusted frame hosts', () => {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'CSP meta should exist');
  assert.match(csp[1], /script-src 'self'/);
  assert.doesNotMatch(csp[1], /script-src[^;]*'unsafe-inline'/);
  assert.match(csp[1], /object-src 'none'/);
  assert.match(csp[1], /base-uri 'none'/);
  // frame-ancestors is intentionally NOT in the meta CSP: it is spec-ignored when
  // delivered via <meta> and a static host cannot send a CSP header. Clickjacking
  // is instead handled by a JS frame-guard (asserted below).
  assert.doesNotMatch(csp[1], /frame-ancestors/);
  assert.match(csp[1], /worker-src 'self' blob:/);
  assert.match(csp[1], /https:\/\/\*\.abbeyroad\.com/);
  assert.match(csp[1], /https:\/\/v\.angelcam\.com/);
  assert.match(csp[1], /https:\/\/cdn\.jwplayer\.com/);
  assert.match(csp[1], /https:\/\/\*\.esbnyc\.com/);
  assert.match(csp[1], /https:\/\/weathercams\.faa\.gov/);
  assert.match(csp[1], /https:\/\/\*\.hazcams\.com/);
  assert.match(csp[1], /https:\/\/\*\.ipcamlive\.com/);
  assert.match(csp[1], /https:\/\/nzp-wowza01\.si\.edu/);
  assert.match(csp[1], /https:\/\/nzp-wowza02\.si\.edu/);
  assert.match(csp[1], /https:\/\/cs7\.pixelcaster\.com/);
  assert.match(csp[1], /https:\/\/\*\.rtsp\.me/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(app, /navigator\.serviceWorker\.register\('sw\.js'\)/);

  const hlsHosts = new Set(cameraData
    .filter((camera) => camera.type === 'hls')
    .map((camera) => new URL(camera.url))
    .filter((url) => url.protocol === 'https:')
    .map((url) => url.origin));
  for (const origin of hlsHosts) {
    assert.ok(csp[1].includes(origin), `CSP should allow shipped HLS origin ${origin}`);
  }
});

test('cache diagnostics and recovery are reachable from the layers panel', () => {
  assert.match(html, /id="cache-status"[^>]*role="status"/);
  assert.match(html, /id="keep-offline-data"/);
  assert.match(html, /id="clear-cache"/);
  assert.match(app, /storage\.persisted/);
  assert.match(app, /navigator\.storage\.persist\(\)/);
  assert.match(app, /STORMSCOPE_GET_CACHE_USAGE/);
  assert.match(app, /STORMSCOPE_CLEAR_CACHES/);
  assert.match(app, /STORMSCOPE_CACHE_ERROR/);
  assert.match(app, /quota-exceeded/);
  assert.match(app, /new MessageChannel\(\)/);
  assert.match(css, /\.cache-status\.error/);
});

test('PWA update and page lifecycle work are explicit and recoverable', () => {
  assert.match(html, /id="connection-state"[^>]*role="status"/);
  assert.match(html, /id="data-freshness"[^>]*role="status"/);
  assert.match(html, /id="update-notice"/);
  assert.match(app, /registration\.waiting/);
  assert.match(app, /updatefound/);
  assert.match(app, /controllerchange/);
  assert.match(app, /STORMSCOPE_SKIP_WAITING/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /beforeunload/);
  assert.match(app, /window\.addEventListener\('online'/);
  assert.match(app, /window\.addEventListener\('offline'/);
  assert.match(app, /radarController\.startRefreshTimer\(\)/);
  assert.match(radarControllerSource, /REFRESH_INTERVAL/);
  assert.match(app, /camera\.paused/);
  assert.match(i18n.catalogs.en['camera.paused'], /Feed paused/);
});

test('panel and scene changes use progressive, reduced-motion-safe view transitions', () => {
  assert.match(app, /function runViewTransition\(update, afterUpdate\)/);
  assert.match(app, /typeof document\.startViewTransition !== 'function'/);
  assert.match(app, /prefersReducedMotion\(\)/);
  assert.match(app, /viewTransitionInFlight/);
  assert.match(app, /viewTransitionReady = true/);
  assert.match(app, /runViewTransition\(function \(\) \{[\s\S]*applyViewSnapshot/);
  assert.match(app, /runViewTransition\(function \(\) \{[\s\S]*TOP_LEVEL_PANELS/);
  assert.match(css, /@supports \(view-transition-name: none\)/);
  assert.match(css, /view-transition-name: stormscope-surface/);
  assert.match(css, /::view-transition-group\(root\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('saved views provide foreground NWS alert polling with bounded notices', () => {
  assert.match(html, /id="saved-location-alert-banner"[^>]*role="status"/);
  assert.match(html, /id="saved-location-alert-review"/);
  assert.match(html, /id="saved-location-alert-dismiss"/);
  assert.match(html, /data-i18n="alerts\.savedLocationHelp"/);
  assert.match(app, /function savedLocationAlertTargets\(\)/);
  assert.match(app, /SAVED_LOCATION_ALERT_CAP = 12/);
  assert.match(app, /savedStore\.listViews\(\)/);
  assert.match(app, /StormScopeNwsAlerts\.buildPointQuery\(target\.center\.lat, target\.center\.lon\)/);
  assert.match(app, /document\.hidden/);
  assert.match(app, /StormScopeNwsAlerts\.nextRetryMetadata/);
  assert.match(app, /function renderSavedLocationAlertBanner\(\)/);
  assert.match(app, /function syncSavedLocationAlertBadge\(\)/);
  assert.match(app, /badgeApi\.setAppBadge/);
  assert.match(app, /badgeApi\.clearAppBadge/);
  assert.match(app, /function initFileHandling\(\)/);
  assert.match(app, /window\.launchQueue\.setConsumer/);
  assert.match(app, /function consumeFileHandlerLaunch\(params\)/);
  assert.match(app, /window\.showSaveFilePicker/);
  assert.match(css, /\.saved-location-alert-banner/);
  for (const locale of ['en', 'es']) {
    for (const key of ['alerts.savedLocationHelp', 'alerts.savedLocationOne', 'alerts.savedLocationMany',
      'alerts.savedLocationNotice', 'alerts.savedLocationReview', 'alerts.savedLocationDismiss']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
});

test('install discovery is capability-gated with iOS guidance', () => {
  assert.match(html, /id="install-status"[^>]*role="status"/);
  assert.match(html, /id="install-app"/);
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /appinstalled/);
  assert.match(app, /maxTouchPoints > 1/);
  assert.match(app, /install\.ios/);
});

test('deterministic runtime status copy never exposes raw localization bypasses', () => {
  assert.doesNotMatch(app, /\.degradationReason\.replace\(/);
  assert.doesNotMatch(app, /Offline cache (?:is not active yet|did not respond)/);
  assert.doesNotMatch(app, /\(cam\.health \|\| 'unknown'\) \+ ' feed'/);
  assert.match(app, /function radarReasonLabel\(reason\)/);
  assert.match(app, /sourceLabel\(camera\.source \|\| camera\.type\)/);
});

test('versioned scene links load before the app and remain available offline', () => {
  const registryPosition = html.indexOf('js/layer-registry.js');
  const savedStatePosition = html.indexOf('js/saved-state.js');
  const sceneCodecPosition = html.indexOf('js/scene-codec.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(registryPosition >= 0 && savedStatePosition > registryPosition && sceneCodecPosition > savedStatePosition);
  assert.ok(appPosition > sceneCodecPosition);
  assert.match(html, /id="copy-scene"/);
  assert.match(html, /id="share-scene"/);
  assert.match(app, /StormScopeSceneCodec\.fromHash\(location\.hash\)/);
  assert.match(app, /window\.addEventListener\('hashchange', applyLocationScene\)/);
  assert.match(app, /window\.addEventListener\('popstate', applyLocationScene\)/);
  assert.match(app, /history\.pushState\(\{ stormscopeScene: true \}/);
  assert.match(app, /function scheduleSceneHashWrite/);
  assert.match(app, /navigator\.share/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(serviceWorker, /\.\/js\/scene-codec\.js/);
  assert.match(serviceWorker, /\.\/js\/layer-registry\.js/);
});

test('operational layer identity, controls, and lifecycle ownership use one local registry', () => {
  assert.match(layerRegistrySource, /var RAW_DESCRIPTORS = \[/);
  assert.match(layerRegistrySource, /id: 'wpcOutlooks'/);
  assert.match(layerRegistrySource, /id: 'earthquakes'/);
  assert.match(layerRegistrySource, /id: 'convective'/);
  assert.match(app, /StormScopeLayerRegistry\.captureEnabled\(document\)/);
  assert.match(app, /StormScopeLayerRegistry\.captureControlState\(document, 'profile'\)/);
  assert.match(app, /StormScopeLayerRegistry\.applyControlState\(document, snapshot, 'profile'\)/);
  assert.match(app, /StormScopeLayerRegistry\.lifecycleDescriptors\(\)\.map/);
  assert.match(app, /StormScopeLayerRegistry\.lifecycleDescriptors\(\)\.forEach/);
});

test('layer navigation is searchable, active-only, localized, and state-preserving', () => {
  assert.match(html, /id="layer-filter-query"[^>]*type="search"/);
  assert.match(html, /id="layer-filter-active"[^>]*type="checkbox"/);
  assert.match(html, /id="layer-filter-count"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="layer-filter-clear"[^>]*disabled/);
  assert.match(html, /id="layer-filter-empty"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /id="toggle-layer-mode"[^>]*aria-pressed="false"/);
  assert.match(html, /id="layer-mode-description"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /data-layer-section="hazards"/);
  assert.match(html, /data-layer-id="earthquakes"/);
  assert.match(css, /\.layer-filter-toolbar[\s\S]*position: sticky/);
  assert.match(app, /function renderLayerNavigation\(\)/);
  assert.match(app, /LAYER_DISPLAY_MODE_STORAGE_KEY/);
  assert.match(app, /SIMPLE_LAYER_IDS/);
  assert.match(app, /function toggleLayerDisplayMode\(\)/);
  assert.match(app, /function enforceSimpleAlertSafety\(\)/);
  assert.match(app, /layerFilterText\(descriptor\)\.indexOf\(query\)/);
  assert.match(app, /!activeOnly \|\| Boolean\(toggle && toggle\.checked\)/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.doesNotMatch(app.slice(app.indexOf('function renderLayerNavigation()'), app.indexOf('function clearLayerNavigation()')),
    /\.checked\s*=/);
  for (const locale of ['en', 'es']) {
    for (const key of ['layers.searchLabel', 'layers.searchPlaceholder', 'layers.activeOnly', 'layers.filterCount',
      'layers.clearFilters', 'layers.noMatches']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
});

test('responsive operations shell keeps primary workflows explicit and radar clear of drawers', () => {
  assert.match(html, /id="primary-nav"[^>]*aria-label="Primary navigation"/);
  assert.match(html, /id="btn-radar"[^>]*aria-current="page"/);
  assert.match(html, /id="btn-alerts"[^>]*aria-expanded="false"[^>]*aria-controls="alerts-panel"/);
  assert.match(html, /id="nav-alert-count"[^>]*aria-hidden="true"/);
  assert.match(html, /id="close-alerts"[^>]*aria-label="Close active alerts"/);
  assert.match(html, /id="btn-place-search"[^>]*aria-controls="search-panel"/);
  assert.match(html, /class="radar-controls-header"/);
  assert.match(html, /class="radar-controls-body"/);
  assert.match(css, /@media \(min-width: 601px\)[\s\S]*\.primary-nav[\s\S]*flex-direction: column/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.primary-nav[\s\S]*bottom: 0/);
  assert.match(css, /max-height: calc\(100vh - 224px/);
  assert.match(css, /max-height: calc\(100vh - 240px/);
  assert.match(app, /function syncPrimaryNavigation\(\)/);
  assert.match(app, /function showRadarCanvas\(\)/);
  assert.match(app, /function toggleAlertsPanel\(\)/);
  assert.match(app, /alertsPanelDismissed/);
  for (const locale of ['en', 'es']) {
    for (const key of ['nav.primary', 'nav.radar', 'nav.alerts', 'nav.layers', 'nav.cameras', 'nav.situation',
      'radar.observed', 'radar.earlier', 'radar.latest', 'alerts.closePanel', 'header.placeSearch']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
});

test('incident camera proximity loads before the app and remains available offline', () => {
  const spatialPosition = html.indexOf('js/spatial-query.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(spatialPosition >= 0 && appPosition > spatialPosition);
  assert.match(serviceWorker, /\.\/js\/spatial-query\.js/);
  assert.match(spatialQuery, /function queryCameras/);
  assert.match(app, /appendNearbyCameraSection/);
  assert.match(app, /StormScopeSpatialQuery\.monitorCandidates/);
});

test('screen wake lock is opt-in, lifecycle-owned, and available offline', () => {
  const wakePosition = html.indexOf('js/wake-lock.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(wakePosition >= 0 && appPosition > wakePosition);
  assert.match(serviceWorker, /\.\/js\/wake-lock\.js/);
  assert.match(html, /id="wake-lock-monitoring"/);
  assert.doesNotMatch(html, /id="wake-lock-monitoring"[^>]*checked/);
  assert.match(wakeLockSource, /userInitiated/);
  assert.match(wakeLockSource, /visibilitychange/);
  assert.match(wakeLockSource, /lock\.addEventListener\('release'/);
  assert.match(app, /syncWakeLockMonitoring/);
});

test('public contribution, provider, release, and security contracts are discoverable', () => {
  assert.match(readme, /## Contributing and Security/);
  assert.match(readme, /python scripts\/check\.py/);
  assert.match(readme, /atomic `ProviderResult`/);
  assert.match(readme, /Existing IDs are never renumbered or reused/);
  assert.match(readme, /scripts\/package_release\.py --prepare/);
  assert.match(readme, /mailto:matt_parker@outlook\.com/);
  assert.match(readme, /Do not open a public issue containing exploit details/);
});

test('accessible situation summary is user-triggered and exposes non-map navigation', () => {
  assert.match(html, /id="btn-summary"[^>]*aria-controls="situation-panel"/);
  assert.match(html, /id="situation-panel"[^>]*aria-labelledby="situation-heading"/);
  assert.match(html, /id="situation-heading"[^>]*tabindex="-1"/);
  assert.match(html, /id="situation-announcer"[^>]*aria-live="polite"/);
  assert.match(html, /id="toggle-situation-table"[^>]*aria-controls="situation-data-table-panel"/);
  assert.match(html, /id="situation-data-table-panel"[^>]*aria-labelledby="situation-data-table-heading"/);
  assert.match(html, /id="situation-data-table-description"/);
  assert.match(app, /function renderSituationSummary/);
  assert.match(app, /function renderSituationDataTable/);
  assert.match(app, /function situationDataTableHazards/);
  assert.match(app, /StormScopeCameraStore\.nearestVerifiedCameras/);
  assert.match(app, /function toggleSituationDataTable/);
  assert.match(app, /showAlertDetail\(alert, true, document\.getElementById\('btn-summary'\), false\)/);
  const snapshotPosition = html.indexOf('js/situation-snapshot.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(snapshotPosition >= 0 && appPosition > snapshotPosition);
  assert.match(serviceWorker, /\.\/js\/situation-snapshot\.js/);
  assert.match(html, /id="snapshot-include-scene"/);
  assert.match(html, /id="copy-situation-snapshot"/);
  assert.match(html, /id="download-situation-snapshot"/);
  assert.match(app, /function buildSituationSnapshot\(includeSceneUrl\)/);
  assert.match(app, /function copySituationSnapshot\(\)/);
  assert.match(app, /function downloadSituationSnapshot\(\)/);
  assert.equal(situationSnapshot.VERSION, 1);
  assert.equal(situationSnapshot.COORDINATE_DECIMALS, 2);
  assert.match(situationSnapshotSource, /private_state_included: false/);
  for (const locale of ['en', 'es']) {
    for (const key of ['snapshot.includeScene', 'snapshot.copy', 'snapshot.download', 'snapshot.title',
      'snapshot.sourcesHeading', 'snapshot.hazardsHeading', 'snapshot.selectedCameraHeading',
      'snapshot.publicScene', 'summary.dataTableToggle', 'summary.dataTableHide',
      'summary.dataTableHeading', 'summary.dataTableDescription', 'summary.dataTableCaption',
      'summary.dataTableCategory', 'summary.dataTableName', 'summary.dataTableMeasure',
      'summary.dataTableArea', 'summary.dataTableAction', 'summary.dataTableAlert',
      'summary.dataTableHazard', 'summary.dataTableCamera', 'summary.dataTableNoAlerts',
      'summary.dataTableNoCameras', 'summary.dataTableAdditionalAlerts', 'summary.dataTableLoading',
      'summary.dataTableUnavailable', 'summary.dataTableReady', 'summary.dataTableUnknown',
      'summary.dataTableCameraDetails', 'summary.dataTableOpenCamera']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
});

test('fatal recovery keeps shell cache and exports redacted diagnostics', () => {
  assert.match(app, /StormScopeDiagnostics\.create/);
  assert.match(app, /diagnostics\.install\(window/);
  assert.match(app, /stormscope-data-/);
  assert.match(app, /stormscope-tiles-/);
  assert.match(app, /stormscope-diagnostics\.json/);
});

test('radar failover, coverage semantics, and NWS alerts are wired into the UI', () => {
  assert.match(html, /js\/radar-providers\.js/);
  assert.match(html, /js\/radar-controller\.js/);
  assert.match(html, /js\/nws-alerts\.js/);
  assert.match(html, /id="toggle-coverage"/);
  assert.match(html, /id="toggle-alerts"/);
  assert.match(html, /id="alerts-panel"/);
  assert.match(html, /Informational only/);
  assert.match(radarControllerSource, /selectProvider/);
  assert.match(radarControllerSource, /parseNoaaDiscovery/);
  assert.match(radarControllerSource, /parseRidgeDiscovery/);
  assert.match(radarControllerSource, /classifyRadarState/);
  assert.match(radarControllerSource, /if \(params\.time\) wmsOptions\.time = params\.time/);
  assert.match(radarControllerSource, /forceNoaa/);
  assert.match(radarControllerSource, /forceRidge/);
  assert.match(html, /https:\/\/opengeo\.ncep\.noaa\.gov/);
  assert.match(app, /StormScopeNwsAlerts\.buildViewportQuery/);
  assert.match(app, /StormScopeNwsAlerts\.buildPointQuery/);
  assert.match(app, /StormScopeNwsAlerts\.nextRetryMetadata/);
  assert.match(app, /StormScopeWeather\.inNwsCoverageBounds/);
  assert.match(app, /alertNationalFetchedAt/);
  assert.match(css, /\.radar-legend/);
  assert.match(css, /\.alert-list-button\[data-severity="Extreme"\]/);
});

test('build-time radar configuration loads before providers and remains in the offline shell', () => {
  assert.match(html, /js\/radar-build-config\.js[\s\S]*js\/radar-providers\.js/);
  assert.match(html, /js\/radar-providers\.js[\s\S]*js\/radar-controller\.js/);
  assert.match(serviceWorker, /\.\/js\/radar-build-config\.js/);
  assert.match(radarControllerSource, /providers\.primaryProviderId/);
  assert.doesNotMatch(app, /localStorage[^\n]*radar[^\n]*provider/i);
  assert.doesNotMatch(app, /URLSearchParams[^\n]*radar/i);
});

test('two-map comparison is packaged, budgeted, low-data aware, and lifecycle bound', () => {
  assert.match(html, /js\/map-comparison\.js[\s\S]*js\/app\.js/);
  assert.match(serviceWorker, /\.\/js\/map-comparison\.js/);
  assert.match(app, /StormScopeMapComparison\.create/);
  assert.match(app, /mapComparison\.setDocumentHidden\(document\.hidden\)/);
  assert.match(app, /lowDataSuspendedLabel/);
  assert.match(app, /getComparisonState/);
});

test('RainViewer requests are guarded before tile and sampling fetches', () => {
  assert.match(radarControllerSource, /createRollingRequestBudget\(\{ limit: 90, windowMs: 60000 \}\)/);
  assert.match(radarControllerSource, /function guardRainViewerTileLayer/);
  assert.match(radarControllerSource, /function consumeRainViewerRequest/);
  assert.match(radarControllerSource, /PRELOAD_RESERVE/);
  assert.match(radarControllerSource, /init\(\{ forceNoaa: true, resumePlayback: state\.playing \}\)/);
  assert.match(app, /getRainViewerBudget/);
});

test('weather routing, units, freshness, and accessibility contracts are integrated', () => {
  assert.match(html, /js\/weather\.js/);
  assert.match(html, /https:\/\/air-quality-api\.open-meteo\.com/);
  assert.match(html, /id="weather-units"/);
  assert.match(html, /id="map" role="region"/);
  assert.match(app, /StormScopeWeather\.shouldUseNws/);
  assert.match(app, /properties\.observationStations/);
  assert.match(app, /Promise\.allSettled/);
  assert.match(app, /observations\/latest\?require_qc=true/);
  assert.match(app, /StormScopeWeather\.normalizeNwsObservation/);
  assert.match(app, /StormScopeWeather\.normalizeNwsForecastTimeline/);
  assert.match(app, /kind: 'precipitationTimeline'/);
  assert.match(app, /StormScopeWeather\.buildAirQualityUrl/);
  assert.match(app, /StormScopeWeather\.normalizeAirQuality/);
  assert.match(app, /weather\.airQualityUnavailable/);
  assert.match(weather, /function buildAirQualityUrl/);
  assert.match(weather, /function normalizeAirQuality/);
  assert.match(i18n.catalogs.en['weather.openMeteoAirQuality'], /Open-Meteo Air Quality/);
  assert.match(app, /weather\.openMeteoFallback/);
  assert.equal(i18n.catalogs.en['weather.openMeteoFallback'], 'Open-Meteo fallback');
  assert.equal(i18n.catalogs.en['weather.forecastIssued'], 'Forecast issued');
  assert.equal(i18n.catalogs.en['weather.forecastValid'], 'Forecast valid');
  assert.equal(i18n.catalogs.en['weather.precipTimelineHeading'], 'Precipitation forecast guidance');
  assert.equal(i18n.catalogs.en['weather.precipTimelineWindow'], 'Next {hours} hours • forecast only');
  assert.match(css, /\.weather-precipitation-timeline/);
  assert.match(css, /\.weather-precip-timeline[\s\S]*overflow-x: auto/);
  assert.equal(html.includes('weather-precipitation-timeline'), false,
    'forecast timeline is rendered only after an independent NWS response');
  assert.match(app, /localStorage\.setItem\('stormscope-weather-units'/);
  assert.match(app, /setModalBackgroundInert/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /safe-area-inset-bottom/);
});

test('official context layers are optional, attributed, and cannot obscure warnings or cameras', () => {
  assert.match(html, /js\/context-layers\.js/);
  assert.match(html, /js\/solar-terminator\.js/);
  assert.match(serviceWorker, /\.\/js\/solar-terminator\.js/);
  assert.match(html, /js\/tropical-cyclones\.js/);
  assert.match(serviceWorker, /\.\/js\/tropical-cyclones\.js/);
  assert.match(html, /js\/flood-outlooks\.js/);
  assert.match(serviceWorker, /\.\/js\/flood-outlooks\.js/);
  assert.match(html, /js\/local-overlays\.js/);
  assert.match(serviceWorker, /\.\/js\/local-overlays\.js/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-lightning"[^>]*>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-wildfires"[^>]*>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-terminator"[^>]*>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-snow"[^>]*>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-surface-observations"[^>]*>/);
  assert.match(html, /id="lightning-status"[^>]*role="status"/);
  assert.match(html, /id="wildfire-status"[^>]*role="status"/);
  assert.match(html, /id="snow-status"[^>]*role="status"/);
  assert.match(html, /id="surface-observations-status"[^>]*role="status"/);
  assert.match(html, /https:\/\/nowcoast\.noaa\.gov/);
  assert.match(html, /https:\/\/services3\.arcgis\.com/);
  assert.match(contextLayers, /NOAA nowCOAST/);
  assert.match(contextLayers, /NIFC WFIGS/);
  assert.match(solarTerminator, /function buildNightPolygon/);
  assert.match(app, /StormScopeSolarTerminator\.buildNightPolygon/);
  assert.match(app, /function getTerminatorState|updatedAt: terminatorUpdatedAt/);
  assert.match(contextLayers, /buildGoesFrameTimes/);
  assert.match(contextLayers, /buildSnowExportRequest/);
  assert.match(app, /contextRasterPane/);
  assert.match(app, /contextVectorPane/);
  assert.match(app, /style\.zIndex = '325'/);
  assert.match(app, /style\.zIndex = '390'/);
  assert.match(app, /refreshLightning/);
  assert.match(app, /refreshWildfires/);
  assert.match(app, /StormScopeContextLayers\.buildWildfireQueries/);
  assert.match(app, /satelliteRequestBudget/);
  assert.match(app, /getSatelliteState/);
  assert.match(app, /function refreshSnow/);
  assert.match(app, /function disableSnow/);
  assert.match(app, /getSnowState/);
  assert.match(app, /function refreshSurfaceObservations/);
  assert.match(app, /function disableSurfaceObservations/);
  assert.match(app, /getSurfaceObservationState/);
  assert.match(app, /clusterPane: 'contextVectorPane'/);
  assert.match(surfaceObservations, /MapServer\/12/);
  assert.match(surfaceObservations, /resultRecordCount: String\(PAGE_SIZE\)/);
  assert.match(surfaceObservations, /function buildQueries/);
  assert.match(surfaceObservations, /function normalizeCollection/);
  assert.match(surfaceObservations, /MultiPoint/);
  assert.match(html, /js\/surface-observations\.js/);
  assert.match(serviceWorker, /\.\/js\/surface-observations\.js/);
  assert.match(layerRegistrySource, /id: 'snow', toggleId: 'toggle-snow'/);
  assert.match(layerRegistrySource, /id: 'surfaceObservations', toggleId: 'toggle-surface-observations'/);
  assert.match(html, /id="satellite-scrubber"/);
});

test('Web Share Target hands bounded files to the private local-overlay intake without upload fallback', () => {
  assert.match(serviceWorker, /var SHARE_CACHE = 'stormscope-share-target-v1'/);
  assert.match(serviceWorker, /function isShareTargetRequest/);
  assert.match(serviceWorker, /request\.formData\(\)/);
  assert.match(serviceWorker, /SHARE_TARGET_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(serviceWorker, /STORMSCOPE_CONSUME_SHARE_TARGET/);
  assert.match(app, /function consumeShareTarget\(\)/);
  assert.match(app, /STORMSCOPE_CONSUME_SHARE_TARGET/);
  assert.match(app, /new File\(\[buffer\], name/);
  assert.match(app, /StormScopeLocalOverlays\.createRecord/);
});

test('private measurements and annotations stay bounded and outside shared or diagnostic state', () => {
  assert.match(html, /js\/private-annotations\.js/);
  assert.match(serviceWorker, /\.\/js\/private-annotations\.js/);
  assert.match(html, /id="annotation-tool"/);
  assert.match(html, /id="annotation-measure-run"/);
  assert.match(html, /id="private-annotation-export"/);
  assert.match(app, /StormScopePrivateAnnotations\.createAnnotation/);
  assert.match(app, /StormScopePrivateAnnotations\.validateAnnotation/);
  assert.match(app, /function annotationTransaction\(mode, operation\)/);
  assert.match(app, /function getPrivateAnnotationState|getPrivateAnnotationState: function/);
  assert.match(privateAnnotationSource, /MAX_ANNOTATIONS = 100/);
  assert.match(privateAnnotationSource, /MAX_VERTICES = 256/);
  assert.match(privateAnnotationSource, /function measureLine/);
  assert.match(css, /\.private-annotation-label/);
  for (const locale of ['en', 'es']) {
    for (const key of ['annotations.heading', 'annotations.privacy', 'annotations.toolMeasure',
      'annotations.measureResult', 'annotations.keep', 'annotations.statusStorageError',
      'annotations.type.measurement']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
  const sceneStart = app.indexOf('function captureSharedScene()');
  const sceneEnd = app.indexOf('function scheduleSceneHashWrite()', sceneStart);
  assert.ok(sceneStart >= 0 && sceneEnd > sceneStart);
  assert.doesNotMatch(app.slice(sceneStart, sceneEnd), /privateAnnotation|annotation-tool/);
  const diagnosticsStart = app.indexOf('async function exportDiagnostics()');
  const diagnosticsEnd = app.indexOf('function initDiagnostics()', diagnosticsStart);
  assert.ok(diagnosticsStart >= 0 && diagnosticsEnd > diagnosticsStart);
  assert.doesNotMatch(app.slice(diagnosticsStart, diagnosticsEnd), /privateAnnotation|annotation-tool/);
});

test('route corridor mode uses local LineStrings, bounded geometry, and route-order camera selection', () => {
  assert.match(html, /id="route-corridor-route"/);
  assert.match(html, /id="route-corridor-width"/);
  assert.match(html, /id="route-corridor-activate"/);
  assert.match(html, /id="route-corridor-results"/);
  assert.match(app, /function routeCorridorFeatureCandidates\(\)/);
  assert.match(app, /StormScopeSpatialQuery\.queryRouteCameras/);
  assert.match(app, /StormScopeSpatialQuery\.intersectsRouteCorridor/);
  assert.match(app, /function openRouteCorridorMonitor\(\)/);
  assert.match(app, /monitorSelection\.replace\(cameras\)/);
  assert.match(spatialQuerySource, /function projectRoute\(line, point\)/);
  assert.match(spatialQuerySource, /function queryRouteCameras\(cameras, line, options\)/);
  assert.match(spatialQuerySource, /function intersectsRouteCorridor\(line, geometry, maxDistanceKm\)/);
  assert.match(css, /\.route-corridor-panel/);
  for (const locale of ['en', 'es']) {
    for (const key of ['summary.routeCorridorHeading', 'summary.routeCorridorPrivacy',
      'summary.routeCorridorNoImported', 'summary.routeCorridorStatus',
      'summary.routeCorridorCameraLine', 'summary.routeCorridorOpenMonitor']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
  const sceneStart = app.indexOf('function captureSharedScene()');
  const sceneEnd = app.indexOf('function scheduleSceneHashWrite()', sceneStart);
  assert.doesNotMatch(app.slice(sceneStart, sceneEnd), /routeCorridor|route-corridor/);
  const snapshotStart = app.indexOf('function buildSituationSnapshot(includeSceneUrl)');
  const snapshotEnd = app.indexOf('function copySituationSnapshot()', snapshotStart);
  assert.doesNotMatch(app.slice(snapshotStart, snapshotEnd), /routeCorridor|route-corridor/);
});

test('place/address geocoding is keyless, debounced, attributed, and session-only', () => {
  assert.match(html, /js\/geocode\.js/);
  assert.match(serviceWorker, /\.\/js\/geocode\.js/);
  assert.match(html, /id="place-query"[^>]*role="combobox"/);
  assert.match(html, /id="place-results"[^>]*role="listbox"/);
  assert.match(html, /openstreetmap\.org\/copyright/);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /https:\/\/photon\.komoot\.io/);
  assert.match(csp, /https:\/\/nominatim\.openstreetmap\.org/);
  assert.match(app, /function runPlaceSearch/);
  assert.match(app, /StormScopeGeocode\.photonUrl/);
  assert.match(app, /StormScopeGeocode\.nominatimUrl/);
  // Debounced (≥300 ms) and never persisted.
  assert.match(app, /setTimeout\(function \(\) \{ runPlaceSearch\(query\); \}, 3[0-9][0-9]\)/);
  const placeBlock = app.slice(app.indexOf('function runPlaceSearch'), app.indexOf('function bindUI()'));
  assert.doesNotMatch(placeBlock, /localStorage|sessionStorage|indexedDB/i);
});

test('SPC severe & tornado watches are an optional, attributed, keyless layer wired end to end', () => {
  assert.match(html, /js\/severe-watches\.js/);
  assert.match(serviceWorker, /\.\/js\/severe-watches\.js/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-watches"[^>]*>/);
  assert.match(html, /id="watch-status"[^>]*role="status"/);
  assert.match(app, /function refreshSevereWatches/);
  assert.match(app, /function disableSevereWatches/);
  assert.match(app, /StormScopeSevereWatches\.fetchAllPages/);
  assert.match(layerRegistrySource, /id: 'watches', toggleId: 'toggle-watches'/);
  assert.match(app, /link\.href = safeExternalUrl\(properties\.officialUrl\)/);
});

test('scene updates consolidate context announcements and cluster counts stay accessible', () => {
  assert.match(html, /id="transient-announcer"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="wpc-outlook-status"[^>]*role="status"[^>]*aria-live="off"/);
  assert.match(html, /id="snow-status"[^>]*role="status"[^>]*aria-live="off"/);
  assert.match(app, /function beginSceneAnnouncementBatch\(\)/);
  assert.match(app, /function endSceneAnnouncementBatch\(\)/);
  assert.match(app, /accessibility\.sceneApplied/);
  assert.match(app, /camera\.clusterCount/);
  assert.match(app, /context\.stormReportCluster/);
  assert.match(app, /role="img" aria-label="' \+ label/);
  assert.equal(i18n.catalogs.en['accessibility.sceneApplied'], 'View applied. {count} layers active.');
  assert.equal(i18n.catalogs.es['accessibility.sceneApplied'], 'Vista aplicada. {count} capas activas.');
});

test('SPC convective outlooks are an optional, attributed, keyless layer wired end to end', () => {
  assert.match(html, /js\/convective-outlooks\.js/);
  assert.match(serviceWorker, /\.\/js\/convective-outlooks\.js/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-convective"[^>]*>/);
  assert.match(html, /id="convective-day"/);
  assert.match(html, /id="convective-status"[^>]*role="status"/);
  assert.match(app, /function refreshConvectiveOutlooks/);
  assert.match(app, /function disableConvectiveOutlooks/);
  assert.match(app, /StormScopeConvectiveOutlooks\.fetchAllPages/);
  assert.match(layerRegistrySource, /id: 'convective', toggleId: 'toggle-convective'/);
  // Host already CSP-allowed; no new connect-src origin required.
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /https:\/\/mapservices\.weather\.noaa\.gov/);
});

test('SPC fire-weather outlooks are bounded Day 1–8 forecast guidance with safe lifecycle wiring', () => {
  const convectivePosition = html.indexOf('js/convective-outlooks.js');
  const fireWeatherPosition = html.indexOf('js/fire-weather.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(convectivePosition >= 0 && fireWeatherPosition > convectivePosition && appPosition > fireWeatherPosition);
  assert.match(serviceWorker, /\.\/js\/fire-weather\.js/);
  assert.match(fireWeatherSource, /SPC_firewx\/MapServer/);
  assert.match(fireWeatherSource, /DAY_LAYERS/);
  assert.match(fireWeatherSource, /function buildQueries\(day, bounds\)/);
  assert.match(fireWeatherSource, /geometryType/);
  assert.match(fireWeatherSource, /function fetchAllPages/);
  assert.match(fireWeatherSource, /function mergeCollections/);
  assert.match(html, /id="toggle-fire-weather"/);
  assert.match(html, /id="fire-weather-day"/);
  assert.match(html, /id="fire-weather-status"[^>]*role="status"/);
  assert.match(app, /function refreshFireWeather/);
  assert.match(app, /function disableFireWeather/);
  assert.match(app, /StormScopeFireWeather\.buildQueries/);
  assert.match(app, /StormScopeFireWeather\.mergeCollections/);
  assert.match(app, /fireWeatherForecast/);
  assert.match(layerRegistrySource, /id: 'fireWeather', toggleId: 'toggle-fire-weather'/);
  assert.match(css, /\.fire-weather-swatch/);
  assert.equal(i18n.catalogs.en['context.fireWeatherForecast'].includes('observed wildfire perimeter'), true);
  assert.ok(i18n.catalogs.es['context.fireWeatherForecast']);
});

test('SWPC aurora and space-weather feeds are optional, bounded, attributed, and independently recoverable', () => {
  const situationPosition = html.indexOf('js/situation-snapshot.js');
  const spaceWeatherPosition = html.indexOf('js/space-weather.js');
  const motionPosition = html.indexOf('js/radar-motion.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(situationPosition >= 0 && spaceWeatherPosition > situationPosition && motionPosition > spaceWeatherPosition && appPosition > motionPosition);
  assert.match(serviceWorker, /\.\/js\/space-weather\.js/);
  assert.match(spaceWeatherSource, /ovation_aurora_latest\.json/);
  assert.match(spaceWeatherSource, /noaa-planetary-k-index\.json/);
  assert.match(spaceWeatherSource, /products\/alerts\.json/);
  assert.match(spaceWeatherSource, /AURORA_WIDTH = 360/);
  assert.match(spaceWeatherSource, /AURORA_HEIGHT = 181/);
  assert.match(spaceWeatherSource, /MAX_ALERTS = 8/);
  assert.match(spaceWeatherSource, /Promise\.allSettled/);
  assert.match(spaceWeatherSource, /state\.lastGood = hasData/);
  assert.match(spaceWeatherSource, /contextRasterPane/);
  assert.match(html, /id="toggle-space-weather"/);
  assert.match(html, /id="space-weather-status"[^>]*role="status"/);
  assert.match(html, /https:\/\/services\.swpc\.noaa\.gov/);
  assert.match(app, /StormScopeSpaceWeather\.create/);
  assert.match(app, /spaceWeatherController\.renderStatus/);
  assert.match(layerRegistrySource, /id: 'spaceWeather', toggleId: 'toggle-space-weather'/);
  assert.equal(i18n.catalogs.en['layers.spaceWeather'], 'NOAA SWPC Space Weather & Aurora');
  assert.ok(i18n.catalogs.es['context.spaceWeatherLimitation']);
});

test('NDBC marine buoy observations are optional, viewport-bounded, DOM-only, and teardown-safe', () => {
  const spaceWeatherPosition = html.indexOf('js/space-weather.js');
  const marineBuoysPosition = html.indexOf('js/marine-buoys.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(spaceWeatherPosition >= 0 && marineBuoysPosition > spaceWeatherPosition && appPosition > marineBuoysPosition);
  assert.match(serviceWorker, /\.\/js\/marine-buoys\.js/);
  assert.match(marineBuoysSource, /cwwcNDBCMet\.json/);
  assert.match(marineBuoysSource, /MAX_TABLE_ROWS = 5000/);
  assert.match(marineBuoysSource, /LOOKBACK_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(marineBuoysSource, /function buildQueries\(bounds, zoom, now\)/);
  assert.match(marineBuoysSource, /function normalizeCollection/);
  assert.match(marineBuoysSource, /function jsonpRequest/);
  assert.match(marineBuoysSource, /Promise\.allSettled/);
  assert.match(marineBuoysSource, /contextVectorPane/);
  assert.match(marineBuoysSource, /safeExternalUrl/);
  assert.match(html, /id="toggle-marine-buoys"/);
  assert.match(html, /id="marine-buoy-status"[^>]*role="status"/);
  assert.match(html, /https:\/\/www\.ndbc\.noaa\.gov\//);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /script-src 'self' https:\/\/coastwatch\.pfeg\.noaa\.gov/);
  assert.match(csp, /connect-src[^;]*https:\/\/coastwatch\.pfeg\.noaa\.gov/);
  assert.match(app, /StormScopeMarineBuoys\.create/);
  assert.match(app, /marineBuoysController\.scheduleMoveRefresh/);
  assert.match(app, /marineBuoysController\.renderStatus/);
  assert.match(layerRegistrySource, /id: 'marineBuoys', toggleId: 'toggle-marine-buoys'/);
  assert.equal(i18n.catalogs.en['layers.marineBuoys'], 'NOAA NDBC Marine Buoys');
  assert.ok(i18n.catalogs.es['context.marineBuoysLimitation']);
});

test('NOAA CPC drought and extended-range outlooks are optional, bounded, and lifecycle-owned', () => {
  const marineBuoysPosition = html.indexOf('js/marine-buoys.js');
  const cpcPosition = html.indexOf('js/cpc-outlooks.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(marineBuoysPosition >= 0 && cpcPosition > marineBuoysPosition && appPosition > cpcPosition);
  assert.match(serviceWorker, /\.\/js\/cpc-outlooks\.js/);
  assert.match(cpcOutlooksSource, /cpc_drought_outlk\/MapServer/);
  assert.match(cpcOutlooksSource, /cpc_6_10_day_outlk\/MapServer/);
  assert.match(cpcOutlooksSource, /cpc_8_14_day_outlk\/MapServer/);
  assert.match(cpcOutlooksSource, /MAX_RECORDS = 200/);
  assert.match(cpcOutlooksSource, /MAX_FEATURES = 2000/);
  assert.match(cpcOutlooksSource, /function buildQueries\(bounds, zoom\)/);
  assert.match(cpcOutlooksSource, /function normalizeCollection/);
  assert.match(cpcOutlooksSource, /Promise\.allSettled/);
  assert.match(cpcOutlooksSource, /contextVectorPane/);
  assert.match(cpcOutlooksSource, /safeExternalUrl/);
  assert.match(html, /id="toggle-cpc-outlooks"/);
  assert.match(html, /id="cpc-outlook-status"[^>]*role="status"/);
  assert.match(html, /https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
  assert.match(app, /StormScopeCpcOutlooks\.create/);
  assert.match(app, /cpcOutlooksController\.scheduleMoveRefresh/);
  assert.match(app, /cpcOutlooksController\.renderStatus/);
  assert.match(layerRegistrySource, /id: 'cpcOutlooks', toggleId: 'toggle-cpc-outlooks'/);
  assert.equal(i18n.catalogs.en['layers.cpcOutlooks'], 'NOAA CPC Drought & Extended-Range Outlooks');
  assert.ok(i18n.catalogs.es['context.cpcLimitation']);
});

test('USGS earthquakes are an optional, attributed, keyless layer wired end to end', () => {
  assert.match(html, /js\/earthquakes\.js/);
  assert.match(serviceWorker, /\.\/js\/earthquakes\.js/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-earthquakes"[^>]*>/);
  assert.match(html, /id="earthquake-magnitude"/);
  assert.match(html, /id="earthquake-period"/);
  assert.match(html, /id="earthquake-status"[^>]*role="status"/);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /https:\/\/earthquake\.usgs\.gov/);
  assert.match(app, /function refreshEarthquakes/);
  assert.match(app, /function disableEarthquakes/);
  assert.match(app, /StormScopeEarthquakes\.buildFeedUrl/);
  assert.match(app, /StormScopeEarthquakes\.normalizeCollection/);
  assert.match(app, /StormScopeEarthquakes\.normalizeDetail/);
  assert.match(app, /StormScopeEarthquakes\.normalizeIntensityCollection/);
  assert.match(app, /getEarthquakeIntensityState/);
  assert.match(earthquakeSource, /\['shakemap', 'dyfi'\]/);
  assert.match(earthquakeSource, /kind === 'shakemap'/);
  assert.match(earthquakeSource, /MultiLineString/);
  assert.match(earthquakeSource, /MAX_INTENSITY_FEATURES = 500/);
  // Popup href is scheme-guarded and the layer participates in scene state.
  assert.match(app, /link\.href = safeExternalUrl\(properties\.url\)/);
  assert.match(layerRegistrySource, /id: 'earthquakes', toggleId: 'toggle-earthquakes'/);
});

test('live feed checks maintain a local non-destructive health overlay', () => {
  const feedHealthSource = app + '\n' + cameraFeedSource;
  assert.match(app, /stormscope-camera-observations-v1/);
  assert.match(app, /function recordCameraObservation/);
  assert.match(app, /CAMERA_OBSERVATION_TTL/);
  assert.match(feedHealthSource, /loadeddata/);
  assert.match(feedHealthSource, /decoded_media/);
  assert.match(feedHealthSource, /refresh_advanced/);
  assert.match(feedHealthSource, /manual_retry/);
  assert.doesNotMatch(app, /cam\.health\s*=/);
  assert.doesNotMatch(app, /cam\.last_verified\s*=/);
});

test('virtual-list scrolling renders only the visible window', () => {
  assert.match(app, /function renderCameraResultWindow/);
  assert.match(app, /function scheduleSearchWindowRender/);
  assert.match(app, /getSearchRenderMetrics/);
  assert.match(app, /camera-results-scroll'[\s\S]*scheduleSearchWindowRender\(\)/);
});

test('virtual camera results expose roving keyboard collection semantics', () => {
  assert.match(app, /function focusCameraResult/);
  assert.match(app, /function handleCameraResultNavigation/);
  assert.match(app, /ArrowDown/);
  assert.match(app, /PageDown/);
  assert.match(app, /aria-posinset/);
  assert.match(app, /aria-setsize/);
});

test('geolocation locate-me is permission-gated and never persists coordinates', () => {
  assert.match(html, /id="btn-locate"[^>]*data-i18n-title-key="header\.locate"/);
  assert.match(html, /id="btn-locate"[^>]*data-i18n-aria-label-key="header\.locateLabel"/);
  assert.match(html, /id="locate-announcer"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(app, /function locateMe\(\)/);
  assert.match(app, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(app, /error\.PERMISSION_DENIED/);
  assert.match(app, /error\.TIMEOUT/);
  // Coordinates are session-only: the locate flow must not write to storage.
  const locateBlock = app.slice(app.indexOf('function locateMe()'), app.indexOf('function bindUI()'));
  assert.doesNotMatch(locateBlock, /localStorage|sessionStorage|indexedDB/i);
  for (const locale of ['en', 'es']) {
    for (const key of ['header.locate', 'header.locateLabel', 'locate.searching', 'locate.found', 'locate.denied', 'locate.timeout', 'locate.unavailable', 'locate.unsupported']) {
      assert.ok(i18n.catalogs[locale][key], `${locale} catalog should define ${key}`);
    }
  }
});

test('focus trap recovers focus that escaped the modal and inerts the background', () => {
  const match = app.match(/function trapFocus\(e\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'trapFocus should exist');
  const body = match[1];
  // Escaped-focus recovery: when the focused node is removed (feed re-render) and
  // focus falls back to <body>, any Tab must pull focus back into the modal.
  assert.match(body, /!modal\.contains\(document\.activeElement\)/);
  // Comparison and monitor modals inert the background like the camera modal.
  const inertCalls = [...app.matchAll(/setModalBackgroundInert\(true, modal\)/g)];
  assert.ok(inertCalls.length >= 2, 'comparison and monitor modals must inert the background');
});

test('a JS frame-guard breaks out of cross-origin framing', () => {
  const match = app.match(/function preventFraming\(\) \{([\s\S]*?)\n  \}\)\(\);/);
  assert.ok(match, 'preventFraming guard should exist and run immediately');
  const body = match[1];
  assert.match(body, /window\.top === window\.self/);
  assert.match(body, /window\.top\.location = window\.self\.location\.href/);
});

test('direct camera media suppresses cross-origin referrers', () => {
  // Every element that loads third-party camera media directly (not via a
  // referrer-policied iframe) must set referrerPolicy='no-referrer' so the
  // document origin+path never leaks to DOT/FAA/USGS/relay hosts.
  const directMediaBuilders = [
    [cameraFeedSource, 'function loadHls'],
    [cameraFeedSource, 'function loadMjpeg'],
    [cameraFeedSource, 'function loadImage'],
    [app, 'function createMonitorImagePlayer'],
    [app, 'function createMonitorHlsPlayer']
  ];
  for (const [source, marker] of directMediaBuilders) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `${marker} should exist`);
    // The referrerPolicy assignment appears immediately after the element is
    // created, before any other property, in each builder.
    const window = source.slice(start, start + 220);
    assert.match(window, /referrerPolicy = 'no-referrer'/, `${marker} must set no-referrer`);
  }
  // The radar tile pixel sampler fetches provider tiles cross-origin too.
  assert.match(radarControllerSource, /image\.crossOrigin = 'anonymous';\s*\n\s*image\.referrerPolicy = 'no-referrer';/);
});

test('popup anchor hrefs from fetched provider text are scheme-guarded (CVE-2025-69993)', () => {
  const match = app.match(/function safeExternalUrl\(value\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'safeExternalUrl helper should exist');
  const safeExternalUrl = new Function('value', 'location', match[1]);
  const loc = { href: 'https://stormscope.example/index.html' };
  assert.equal(safeExternalUrl('https://www.nhc.noaa.gov/gis/', loc), 'https://www.nhc.noaa.gov/gis/');
  assert.equal(safeExternalUrl('javascript:alert(1)', loc), '#');
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>', loc), '#');
  assert.equal(safeExternalUrl('vbscript:msgbox(1)', loc), '#');
  assert.equal(safeExternalUrl(null, loc), '#');
  // Dynamic provider-supplied hrefs must route through the guard.
  assert.match(app, /link\.href = safeExternalUrl\(properties\.advisoryUrl\)/);
  assert.match(riverGaugesSource, /options\.safeExternalUrl\(properties\.officialUrl\)/);
  // All feature popups are built as DOM nodes, never HTML strings passed to bindPopup.
  assert.doesNotMatch(app, /bindPopup\(\s*'[^']*<[^']*'/);
});

test('local authored-data deletion exposes bounded recovery and confirmed bulk removal', () => {
  assert.match(app, /RECOVERY_ACTION_WINDOW_MS = 10 \* 1000/);
  assert.match(app, /window\.confirm\(tr\('overlays\.clearConfirm'/);
  assert.match(app, /function persistOverlayRecovery\(snapshots\)/);
  assert.match(app, /savedStore\.restoreView\(view\)/);
  assert.match(css, /\.saved-state-status \.recovery-action/);
});
