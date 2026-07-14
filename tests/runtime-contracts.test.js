const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const contextLayers = fs.readFileSync(path.join(root, 'js', 'context-layers.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const spatialQuery = fs.readFileSync(path.join(root, 'js', 'spatial-query.js'), 'utf8');
const cameraData = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cameras.json'), 'utf8'));
const i18n = require('../js/i18n.js');

test('RainViewer uses the 2026 past-radar contract', () => {
  assert.match(app, /RAINVIEWER_COLOR_SCHEME = 2/);
  assert.match(app, /RAINVIEWER_MAX_NATIVE_ZOOM = 7/);
  assert.match(app, /parseXyzDiscovery/);
  assert.match(app, /discoverNoaa/);
  assert.match(app, /selectProvider/);
  assert.match(app, /sampleRadarCenter/);
  assert.match(app, /maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM/);
  assert.match(app, /crossOrigin: 'anonymous'/);
  assert.match(app, /radar\.pastFrame/);
  assert.match(i18n.catalogs.en['radar.pastFrame'], /Past radar/);
  assert.match(app, /function clearRadarDisplay\(\)/);
  assert.match(app, /layer\.on\('tileerror'/);
  assert.match(html, /href="https:\/\/www\.rainviewer\.com\/"/);
  assert.match(html, /id="radar-retry"/);
});

test('embed trust uses exact host-or-subdomain matching', () => {
  const helperMatch = app.match(/function hostMatchesSuffix\(hostname, suffix\) \{([\s\S]*?)\n  \}/);
  assert.ok(helperMatch, 'hostMatchesSuffix helper should exist');
  const hostMatchesSuffix = new Function('hostname', 'suffix', helperMatch[1]);

  assert.equal(hostMatchesSuffix('earthcam.com', 'earthcam.com'), true);
  assert.equal(hostMatchesSuffix('www.earthcam.com', 'earthcam.com'), true);
  assert.equal(hostMatchesSuffix('earthcam.com.attacker.example', 'earthcam.com'), false);
  assert.equal(hostMatchesSuffix('notearthcam.com', 'earthcam.com'), false);

  assert.match(app, /'abbeyroad\.com'/);
  assert.match(app, /'v\.angelcam\.com'/);
  assert.match(app, /'cdn\.jwplayer\.com'/);
  assert.match(app, /'esbnyc\.com'/);
  assert.match(app, /'weathercams\.faa\.gov'/);
  assert.match(app, /'hazcams\.com'/);
  assert.match(app, /'ipcamlive\.com'/);
  assert.match(app, /'rtsp\.me'/);
  assert.doesNotMatch(app, /hostname\.indexOf/);
  assert.doesNotMatch(app, /'511'/);
  assert.match(app, /parsed\.protocol !== 'https:'/);

  const allowlistMatch = app.match(/TRUSTED_EMBED_HOST_SUFFIXES = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(allowlistMatch, 'trusted embed suffixes should be centralized');
  const suffixes = [...allowlistMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const rejectedEmbeds = cameraData.filter((camera) => {
    if (camera.type !== 'embed') return false;
    const parsed = new URL(camera.url);
    return parsed.protocol !== 'https:' || !suffixes.some((suffix) => hostMatchesSuffix(parsed.hostname, suffix));
  });
  assert.deepEqual(rejectedEmbeds, [], 'every shipped embed should pass the exact trust policy');
});

test('feed failures tear down resources before replacing the DOM and are retryable', () => {
  const renderMatch = app.match(/function renderFeedError\([\s\S]*?\n  \}/);
  assert.ok(renderMatch, 'renderFeedError should exist');
  const renderSource = renderMatch[0];
  assert.ok(renderSource.indexOf('destroyActiveFeed(container)') < renderSource.indexOf('container.replaceChildren(error)'));
  assert.match(app, /if \(destroyed\) return;/);
  assert.match(app, /hls\.destroy\(\)/);
  assert.match(app, /camera\.feedRetry/);
  assert.equal(i18n.catalogs.en['camera.feedRetry'], 'Retry feed');
  assert.match(css, /\.feed-retry-btn/);
  assert.match(app, /appendFrameFallback/);
  assert.match(app, /camera\.openSource/);
  assert.equal(i18n.catalogs.en['camera.openSource'], 'Open source');
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
  assert.match(app, /RADAR_REFRESH_INTERVAL/);
  assert.match(app, /camera\.paused/);
  assert.match(i18n.catalogs.en['camera.paused'], /Feed paused/);
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
  assert.match(app, /radarReasonLabel\(radarProviderSelection\.degradationReason\)/);
  assert.match(app, /sourceLabel\(camera\.source \|\| camera\.type\)/);
});

test('versioned scene links load before the app and remain available offline', () => {
  const savedStatePosition = html.indexOf('js/saved-state.js');
  const sceneCodecPosition = html.indexOf('js/scene-codec.js');
  const appPosition = html.indexOf('js/app.js');
  assert.ok(savedStatePosition >= 0 && sceneCodecPosition > savedStatePosition);
  assert.ok(appPosition > sceneCodecPosition);
  assert.match(html, /id="copy-scene"/);
  assert.match(html, /id="share-scene"/);
  assert.match(app, /StormScopeSceneCodec\.fromHash\(location\.hash\)/);
  assert.match(app, /navigator\.share/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(serviceWorker, /\.\/js\/scene-codec\.js/);
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

test('accessible situation summary is user-triggered and exposes non-map navigation', () => {
  assert.match(html, /id="btn-summary"[^>]*aria-controls="situation-panel"/);
  assert.match(html, /id="situation-panel"[^>]*aria-labelledby="situation-heading"/);
  assert.match(html, /id="situation-heading"[^>]*tabindex="-1"/);
  assert.match(html, /id="situation-announcer"[^>]*aria-live="polite"/);
  assert.match(app, /function renderSituationSummary/);
  assert.match(app, /StormScopeCameraStore\.nearestVerifiedCameras/);
  assert.match(app, /showAlertDetail\(alert, true, document\.getElementById\('btn-summary'\), false\)/);
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
  assert.match(html, /js\/nws-alerts\.js/);
  assert.match(html, /id="toggle-coverage"/);
  assert.match(html, /id="toggle-alerts"/);
  assert.match(html, /id="alerts-panel"/);
  assert.match(html, /Informational only/);
  assert.match(app, /StormScopeRadarProviders\.selectProvider/);
  assert.match(app, /StormScopeRadarProviders\.parseNoaaDiscovery/);
  assert.match(app, /StormScopeRadarProviders\.classifyRadarState/);
  assert.match(app, /if \(params\.time\) wmsOptions\.time = params\.time/);
  assert.match(app, /forceNoaa/);
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
  assert.match(serviceWorker, /\.\/js\/radar-build-config\.js/);
  assert.match(app, /StormScopeRadarProviders\.primaryProviderId/);
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
  assert.match(app, /createRollingRequestBudget\(\{ limit: 90, windowMs: 60000 \}\)/);
  assert.match(app, /function guardRainViewerTileLayer/);
  assert.match(app, /function consumeRainViewerRequest/);
  assert.match(app, /RAINVIEWER_PRELOAD_RESERVE/);
  assert.match(app, /initRadar\(\{ forceNoaa: true, resumePlayback: false \}\)/);
  assert.match(app, /getRainViewerBudget/);
});

test('weather routing, units, freshness, and accessibility contracts are integrated', () => {
  assert.match(html, /js\/weather\.js/);
  assert.match(html, /id="weather-units"/);
  assert.match(html, /id="map" role="region"/);
  assert.match(app, /StormScopeWeather\.shouldUseNws/);
  assert.match(app, /properties\.observationStations/);
  assert.match(app, /Promise\.allSettled/);
  assert.match(app, /observations\/latest\?require_qc=true/);
  assert.match(app, /StormScopeWeather\.normalizeNwsObservation/);
  assert.match(app, /weather\.openMeteoFallback/);
  assert.equal(i18n.catalogs.en['weather.openMeteoFallback'], 'Open-Meteo fallback');
  assert.equal(i18n.catalogs.en['weather.forecastIssued'], 'Forecast issued');
  assert.equal(i18n.catalogs.en['weather.forecastValid'], 'Forecast valid');
  assert.match(app, /localStorage\.setItem\('stormscope-weather-units'/);
  assert.match(app, /setModalBackgroundInert/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /safe-area-inset-bottom/);
});

test('official context layers are optional, attributed, and cannot obscure warnings or cameras', () => {
  assert.match(html, /js\/context-layers\.js/);
  assert.match(html, /js\/tropical-cyclones\.js/);
  assert.match(serviceWorker, /\.\/js\/tropical-cyclones\.js/);
  assert.match(html, /js\/flood-outlooks\.js/);
  assert.match(serviceWorker, /\.\/js\/flood-outlooks\.js/);
  assert.match(html, /js\/local-overlays\.js/);
  assert.match(serviceWorker, /\.\/js\/local-overlays\.js/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-lightning"[^>]*>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="toggle-wildfires"[^>]*>/);
  assert.match(html, /id="lightning-status"[^>]*role="status"/);
  assert.match(html, /id="wildfire-status"[^>]*role="status"/);
  assert.match(html, /https:\/\/nowcoast\.noaa\.gov/);
  assert.match(html, /https:\/\/services3\.arcgis\.com/);
  assert.match(contextLayers, /NOAA nowCOAST/);
  assert.match(contextLayers, /NIFC WFIGS/);
  assert.match(app, /contextRasterPane/);
  assert.match(app, /contextVectorPane/);
  assert.match(app, /style\.zIndex = '325'/);
  assert.match(app, /style\.zIndex = '390'/);
  assert.match(app, /refreshLightning/);
  assert.match(app, /refreshWildfires/);
  assert.match(app, /StormScopeContextLayers\.buildWildfireQueries/);
});

test('live feed checks maintain a local non-destructive health overlay', () => {
  assert.match(app, /stormscope-camera-observations-v1/);
  assert.match(app, /function recordCameraObservation/);
  assert.match(app, /CAMERA_OBSERVATION_TTL/);
  assert.match(app, /loadeddata/);
  assert.match(app, /decoded_media/);
  assert.match(app, /refresh_advanced/);
  assert.match(app, /manual_retry/);
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
    'function loadHLSFeed',
    'function loadMJPEGFeed',
    'function loadImageFeed',
    'function createMonitorImagePlayer',
    'function createMonitorHlsPlayer'
  ];
  for (const marker of directMediaBuilders) {
    const start = app.indexOf(marker);
    assert.ok(start >= 0, `${marker} should exist`);
    // The referrerPolicy assignment appears immediately after the element is
    // created, before any other property, in each builder.
    const window = app.slice(start, start + 220);
    assert.match(window, /referrerPolicy = 'no-referrer'/, `${marker} must set no-referrer`);
  }
  // The radar tile pixel sampler fetches provider tiles cross-origin too.
  assert.match(app, /image\.crossOrigin = 'anonymous';\s*\n\s*image\.referrerPolicy = 'no-referrer';/);
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
  assert.match(app, /link\.href = safeExternalUrl\(properties\.sourceUrl\)/);
  // All feature popups are built as DOM nodes, never HTML strings passed to bindPopup.
  assert.doesNotMatch(app, /bindPopup\(\s*'[^']*<[^']*'/);
});
