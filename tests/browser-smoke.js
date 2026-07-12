'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const pixel = fs.readFileSync(path.join(root, 'assets', 'icon-192.png'));
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch (error) {
    response.writeHead(400).end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(root, '.' + pathname);
  if (target !== root && !target.startsWith(root + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream'
    });
    response.end(data);
  });
}

async function addNetworkFixtures(page) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === 'https://api.rainviewer.com/public/weather-maps.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          host: 'https://tilecache.rainviewer.com',
          radar: { past: [
            { time: Math.floor(Date.now() / 1000) - 900, path: '/v2/radar/fixture-older' },
            { time: Math.floor(Date.now() / 1000) - 600, path: '/v2/radar/fixture-middle' },
            { time: Math.floor(Date.now() / 1000) - 300, path: '/v2/radar/fixture-latest' }
          ], nowcast: [] }
        })
      });
      return;
    }
    if (url.startsWith('https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows') &&
        url.includes('GetCapabilities')) {
      const latest = new Date(Date.now() - 5 * 60000).toISOString();
      await route.fulfill({
        contentType: 'text/xml',
        body: `<WMS_Capabilities><Layer><Name>ldn_lightning_strike_density</Name><Dimension name="time">${latest}</Dimension></Layer></WMS_Capabilities>`
      });
      return;
    }
    if (url.startsWith('https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows')) {
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel });
      return;
    }
    if (url.startsWith('https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query')) {
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [{
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[-100, 39], [-99, 39], [-99, 40], [-100, 40], [-100, 39]]] },
          properties: {
            OBJECTID: 1, poly_IncidentName: 'Fixture Fire', poly_GISAcres: 1250,
            poly_DateCurrent: Date.now() - 600000, attr_PercentContained: 35, attr_IncidentTypeCategory: 'WF'
          }
        }] })
      });
      return;
    }
    if (url.startsWith('https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ name: 'Perimeters', maxRecordCount: 2000, editingInfo: { dataLastEditDate: Date.now() - 300000 } })
      });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/') && url.includes('WMSServer')) {
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/') && url.includes('/query')) {
      const now = Date.now();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
        { attributes: { objectid: 1, idp_subset: 'CONUS', idp_validtime: now - 600000,
          idp_validendtime: now - 540000, idp_filedate: now - 600000, idp_ingestdate: now - 590000 } },
        { attributes: { objectid: 2, idp_subset: 'CONUS', idp_validtime: now - 300000,
          idp_validendtime: now - 240000, idp_filedate: now - 300000, idp_ingestdate: now - 290000 } }
      ] }) });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/')) {
      const now = Date.now();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        timeInfo: { timeExtent: [now - 3600000, now - 60000] },
        fullExtent: { xmin: -20037508, ymin: -20037508, xmax: 20037508, ymax: 20037508,
          spatialReference: { wkid: 102100 } }
      }) });
      return;
    }
    if (url.includes('tilecache.rainviewer.com') || url.includes('basemaps.cartocdn.com')) {
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel });
      return;
    }
    if (url.startsWith('https://api.weather.gov/alerts/active')) {
      const now = Date.now();
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [{
          id: 'https://api.weather.gov/alerts/fixture',
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[-101, 38], [-96, 38], [-96, 42], [-101, 42], [-101, 38]]]
          },
          properties: {
            id: 'https://api.weather.gov/alerts/fixture',
            '@id': 'https://api.weather.gov/alerts/fixture',
            web: 'https://www.weather.gov/',
            event: 'Severe Thunderstorm Warning',
            headline: 'Severe Thunderstorm Warning issued for the test area',
            description: 'Seek shelter indoors.',
            instruction: 'Move away from windows.',
            areaDesc: 'Test County',
            severity: 'Severe',
            urgency: 'Immediate',
            certainty: 'Observed',
            status: 'Actual',
            messageType: 'Alert',
            sent: new Date(now - 60000).toISOString(),
            effective: new Date(now - 60000).toISOString(),
            expires: new Date(now + 3600000).toISOString(),
            parameters: {}
          }
        }] })
      });
      return;
    }
    if (url.startsWith('https://api.weather.gov/points/')) {
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ properties: { forecastHourly: 'https://api.weather.gov/fixture/hourly' } })
      });
      return;
    }
    if (url === 'https://api.weather.gov/fixture/hourly') {
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ properties: { periods: [{
          temperature: 72,
          temperatureUnit: 'F',
          shortForecast: 'Clear',
          windSpeed: '5 mph',
          windDirection: 'N',
          relativeHumidity: { value: 45 }
        }] } })
      });
      return;
    }
    if (url.startsWith('https://api.open-meteo.com/')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ current: {
          temperature_2m: 22,
          weather_code: 0,
          wind_speed_10m: 8,
          wind_direction_10m: 0,
          relative_humidity_2m: 45
        } })
      });
      return;
    }
    await route.continue();
  });
}

async function waitForApp(page, requireRadar = true) {
  await page.goto(page.baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('#camera-count').filter({ hasText: '33,661 cameras' }).waitFor({ state: 'visible' });
  if (requireRadar) {
    await page.waitForFunction(() => /RainViewer|NOAA\/NWS MRMS/.test(document.querySelector('#radar-meta').textContent));
  }
}

async function main() {
  const server = http.createServer(serveStatic);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const errors = [];

  try {
    const page = await context.newPage();
    page.baseURL = baseURL;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const source = message.location().url || '';
      if (/net::ERR_(FAILED|INTERNET_DISCONNECTED)/.test(text)) return;
      if (text.startsWith('Failed to load resource') && source && !source.startsWith(baseURL)) return;
      errors.push(text);
    });
    await addNetworkFixtures(page);
    await waitForApp(page);

    const vendorRuntime = await page.evaluate(() => ({
      leaflet: window.L && window.L.version,
      markercluster: typeof window.L.markerClusterGroup,
      hls: window.Hls && window.Hls.version
    }));
    assert.deepEqual(vendorRuntime, { leaflet: '1.9.4', markercluster: 'function', hls: '1.6.16' });

    const cameraMetrics = await page.evaluate(() => window._stormscope.getCameraLoadMetrics());
    assert.equal(cameraMetrics.source, 'shards');
    assert.ok(cameraMetrics.firstBatchMs > 0 && cameraMetrics.firstBatchMs < 2500,
      `first camera shard should render within 2.5 s, observed ${cameraMetrics.firstBatchMs} ms`);

    assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
    assert.equal(await page.locator('#radar-retry').isHidden(), true);
    assert.match(await page.locator('#radar-time').textContent(), /old|ago|just now/i);
    const scrubber = page.locator('#radar-scrubber');
    assert.ok(Number(await scrubber.getAttribute('max')) > 0, 'radar timeline should expose multiple frames');
    assert.deepEqual(await page.evaluate(() => window._stormscope.getContextState()), {
      lightning: false, wildfires: false, lightningStatus: 'off', wildfireStatus: 'off',
      rasterZ: '325', vectorZ: '390', warningZ: '400', cameraZ: '600'
    });
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#toggle-lightning').check();
    await page.locator('#toggle-wildfires').check();
    await page.locator('#lightning-status').filter({ hasText: '15 min density' }).waitFor({ state: 'visible' });
    await page.locator('#wildfire-status').filter({ hasText: '1 wildfire perimeters' }).waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window._stormscope.getContextState()), {
      lightning: true, wildfires: true, lightningStatus: 'ready', wildfireStatus: 'ready',
      rasterZ: '325', vectorZ: '390', warningZ: '400', cameraZ: '600'
    });
    await page.locator('#toggle-lightning').uncheck();
    await page.locator('#toggle-wildfires').uncheck();
    await page.locator('#radar-speed').selectOption('0');
    await page.locator('#radar-palette').selectOption('colorblind');
    assert.equal(await page.locator('#radar-play').isDisabled(), true);
    assert.equal(await page.locator('#radar-legend').getAttribute('class'), 'radar-legend palette-colorblind');
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await scrubber.fill('0');
    assert.match(await page.locator('#radar-frame-position').textContent(), /^Frame 1 of /);
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#radar-speed').inputValue(), '0');
    assert.equal(await page.locator('#radar-play').getAttribute('aria-pressed'), 'false',
      'manual-only mode must stop playback even if a provider refresh replaces the timeline');
    await page.waitForFunction(() => !document.querySelector('#radar-time').textContent.startsWith('Loading'));
    const nextRadar = page.getByRole('button', { name: 'Next radar frame' });
    assert.equal(await nextRadar.isDisabled(), false, 'manual next control should remain enabled: ' +
      await page.locator('#radar-time').textContent());
    const frameBeforeNext = await scrubber.inputValue();
    await nextRadar.click();
    assert.notEqual(await scrubber.inputValue(), frameBeforeNext, 'manual frame controls must remain usable without animation');
    const failLightning = (route) => route.fulfill({ status: 503, body: 'fixture unavailable' });
    await page.route('https://nowcoast.noaa.gov/**', failLightning);
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#toggle-lightning').check();
    await page.locator('#toggle-wildfires').check();
    await page.locator('#lightning-status').filter({ hasText: 'Official data unavailable' }).waitFor({ state: 'visible' });
    await page.locator('#wildfire-status').filter({ hasText: '1 wildfire perimeters' }).waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window._stormscope.getContextState()), {
      lightning: false, wildfires: true, lightningStatus: 'error', wildfireStatus: 'ready',
      rasterZ: '325', vectorZ: '390', warningZ: '400', cameraZ: '600'
    });
    await page.locator('#toggle-lightning').uncheck();
    await page.locator('#toggle-wildfires').uncheck();
    await page.unroute('https://nowcoast.noaa.gov/**', failLightning);
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#app-locale').selectOption('es');
    assert.equal(await page.locator('html').getAttribute('lang'), 'es');
    assert.equal(await page.locator('label[for="app-locale"]').textContent(), 'Idioma');
    assert.equal(await page.locator('#search-heading').textContent(), 'Buscar cámaras');
    assert.match(await page.locator('#camera-count').textContent(), /^33\.661 cámaras$/);
    assert.match(await page.locator('#radar-frame-position').textContent(), /^Fotograma /);
    assert.match(await page.locator('#radar-time').textContent(), /hace|ahora mismo/);
    await page.locator('#app-locale').selectOption('en');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    const unnamedButtons = await page.locator('button').evaluateAll((buttons) => buttons.filter((button) => {
      return !(button.getAttribute('aria-label') || button.textContent.trim() || button.title);
    }).length);
    assert.equal(unnamedButtons, 0, 'all buttons must have accessible names');

    await page.locator('#alerts-status').filter({ hasText: '1 alert' }).waitFor({ state: 'visible' });
    const alertButton = page.getByRole('button', { name: /Severe Thunderstorm Warning/ });
    await alertButton.click();
    await page.locator('#alert-detail').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Hide alert details' }).click();
    await page.locator('#alert-detail').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#toggle-alerts').uncheck();
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.evaluate(() => window._stormscope.getMap().setView([39.5, -98.5], 5));
    await page.waitForTimeout(100);

    await page.getByRole('button', { name: 'Find cameras' }).click();
    await page.locator('#search-panel').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#search-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'btn-search',
      'Escape should close the search panel and return focus to its toggle');

    await page.getByRole('button', { name: 'Find cameras' }).click();
    await page.locator('#camera-query').fill('Alabama');
    await page.locator('#camera-results-status').filter({ hasText: /results? shown on map/ }).waitFor({ state: 'visible' });
    const visibleResults = page.locator('.camera-result');
    assert.ok(await visibleResults.count() > 0, 'search should expose keyboard-accessible camera results');
    assert.ok(await visibleResults.count() < 30, 'search results should be virtualized');
    await visibleResults.first().locator('.camera-result-open').click();
    await page.locator('#camera-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#camera-modal').getAttribute('role'), 'dialog');
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await page.locator('#camera-modal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#modal-feed video, #modal-feed iframe, #modal-feed img').count(), 0);

    const firstFavorite = visibleResults.first().locator('.favorite-result');
    await firstFavorite.click();
    await page.locator('#camera-favorites').check();
    await page.locator('#camera-results-status').filter({ hasText: '1 result shown on map' }).waitFor({ state: 'visible' });
    await page.locator('#camera-favorites').uncheck();
    await visibleResults.nth(0).locator('.monitor-result').click();
    await visibleResults.nth(1).locator('.monitor-result').click();
    await page.locator('#monitor-selection-status').filter({ hasText: '2 of 4 selected' }).waitFor({ state: 'visible' });
    await page.locator('#monitor-bandwidth').waitFor({ state: 'visible' });
    await page.locator('#open-monitor').click();
    await page.locator('#monitor-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.monitor-cell').count(), 2);
    assert.equal((await page.evaluate(() => window._stormscope.getMonitorState())).players, 2);
    await page.getByRole('button', { name: 'Close multi-camera monitor' }).click();
    await page.locator('#monitor-modal').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window._stormscope.getMonitorState()), { selected: 2, players: 0 });
    assert.equal(await page.locator('#monitor-grid > *').count(), 0);
    await page.getByRole('button', { name: 'Find cameras' }).click();
    await page.locator('#camera-query').fill('');
    await page.locator('#camera-source').selectOption('earthcam');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length > 1 && results.every((camera) => camera.source === 'earthcam');
    });
    await visibleResults.nth(0).locator('.monitor-result').click();
    await visibleResults.nth(1).locator('.monitor-result').click();
    await page.locator('#open-monitor').click();
    await page.locator('#monitor-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.monitor-cell').count(), 4);
    assert.equal(await page.locator('.monitor-link-fallback').count(), 2,
      'unsupported provider embeds should degrade to source links');
    await page.getByRole('button', { name: 'Close multi-camera monitor' }).click();
    await page.getByRole('button', { name: 'Find cameras' }).click();
    await page.locator('#camera-source').selectOption('');
    await page.getByRole('button', { name: 'Find cameras' }).click();

    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#view-name').fill('Smoke view');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#saved-state-status').filter({ hasText: 'View saved locally.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#camera-count').filter({ hasText: '33,661 cameras' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'StormScope' }).waitFor({ state: 'visible' });
    await page.locator('#camera-count').filter({ hasText: '33,661 cameras' }).waitFor({ state: 'visible' });
    await context.setOffline(false);

    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    const clearCache = page.getByRole('button', { name: 'Clear cached data' });
    await clearCache.waitFor({ state: 'visible' });
    await clearCache.click();
    await page.locator('#cache-status').filter({ hasText: 'Offline cache:' }).waitFor({ state: 'visible' });
    const cacheNames = await page.evaluate(() => caches.keys());
    assert.ok(cacheNames.some((name) => name.startsWith('stormscope-shell-')));
    assert.ok(!cacheNames.some((name) => name.startsWith('stormscope-data-')), 'runtime data cache should be cleared: ' + cacheNames.join(', '));

    const mobile = await context.newPage();
    mobile.baseURL = baseURL;
    await mobile.setViewportSize({ width: 390, height: 844 });
    await addNetworkFixtures(mobile);
    await waitForApp(mobile, false);
    assert.equal(await mobile.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
    await mobile.getByRole('button', { name: 'Toggle layers panel' }).click();
    assert.equal(await mobile.getByRole('button', { name: 'Toggle layers panel' }).getAttribute('aria-expanded'), 'true');
    await mobile.getByRole('region', { name: 'Map layers' }).waitFor({ state: 'visible' });

    assert.deepEqual(errors, []);
    console.log('Headless desktop/mobile/modal/offline/cache/accessibility smoke passed.');
  } finally {
    await context.setOffline(false).catch(() => {});
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
