const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const contextLayers = fs.readFileSync(path.join(root, 'js', 'context-layers.js'), 'utf8');
const cameraData = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cameras.json'), 'utf8'));
const i18n = require('../js/i18n.js');

test('RainViewer uses the 2026 past-radar contract', () => {
  assert.match(app, /RAINVIEWER_COLOR_SCHEME = 2/);
  assert.match(app, /RAINVIEWER_MAX_NATIVE_ZOOM = 7/);
  assert.match(app, /parseRainViewerDiscovery/);
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
  assert.match(html, /id="clear-cache"/);
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
