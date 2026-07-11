const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const cameraData = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cameras.json'), 'utf8'));

test('RainViewer uses the 2026 past-radar contract', () => {
  assert.match(app, /RAINVIEWER_COLOR_SCHEME = 2/);
  assert.match(app, /RAINVIEWER_MAX_NATIVE_ZOOM = 7/);
  assert.match(app, /getTrustedRainViewerHost\(data\.host\)/);
  assert.match(app, /data\.radar\.past/);
  assert.doesNotMatch(app, /data\.radar\.nowcast/);
  assert.match(app, /maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM/);
  assert.match(app, /crossOrigin: 'anonymous'/);
  assert.match(app, /Past radar/);
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
  assert.match(app, /'esbnyc\.com'/);
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
  assert.match(app, /Retry feed/);
  assert.match(css, /\.feed-retry-btn/);
  assert.match(app, /appendFrameFallback/);
  assert.match(app, /Open source/);
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
  assert.match(csp[1], /https:\/\/\*\.esbnyc\.com/);
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
