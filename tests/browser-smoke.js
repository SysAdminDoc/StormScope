'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const sceneCodec = require('../js/scene-codec.js');

async function assertSurfaceWithinViewport(page, selector, label) {
  const bounds = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom,
      width: window.innerWidth, height: window.innerHeight };
  });
  assert.ok(bounds.top >= -1 && bounds.left >= -1, `${label} starts outside viewport: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1,
    `${label} ends outside viewport: ${JSON.stringify(bounds)}`);
}

async function assertControlsReachable(page, containerSelector, selectors) {
  for (const selector of selectors) {
    const reachable = await page.locator(selector).evaluate((element, containerSelector) => {
      element.focus();
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const container = element.closest(containerSelector).getBoundingClientRect();
      return document.activeElement === element && rect.bottom > Math.max(0, container.top) &&
        rect.top < Math.min(window.innerHeight, container.bottom) && rect.right > 0 && rect.left < window.innerWidth;
    }, containerSelector);
    assert.equal(reachable, true, `${selector} must be keyboard reachable in ${containerSelector}`);
  }
}

async function exerciseLandscapeLayout(page, theme) {
  const layersToggle = page.getByRole('button', { name: 'Toggle layers panel' });
  if (await layersToggle.getAttribute('aria-expanded') !== 'true') await layersToggle.click();
  await page.locator('#app-theme').selectOption(theme);
  await page.locator('#radar-speed').selectOption('800');
  if (!await page.locator('#toggle-alerts').isChecked()) await page.locator('#toggle-alerts').check();
  await assertSurfaceWithinViewport(page, '#layers-panel', `${theme} layers`);
  await assertControlsReachable(page, '#layers-panel', ['#toggle-radar', '#alert-severity', '#app-locale', '#clear-cache']);
  assert.ok((await page.screenshot()).length > 1000);
  await layersToggle.click();

  await page.locator('#alerts-status').filter({ hasText: /alert|alerta/ }).waitFor({ state: 'visible' });
  await assertSurfaceWithinViewport(page, '#alerts-panel', `${theme} alerts`);
  assert.ok((await page.screenshot()).length > 1000);

  const searchToggle = page.getByRole('button', { name: /Find cameras|Buscar cámaras/ });
  await searchToggle.click();
  await page.locator('#search-panel').waitFor({ state: 'visible' });
  await assertSurfaceWithinViewport(page, '#search-panel', `${theme} search`);
  await assertControlsReachable(page, '#search-panel', [
    '#camera-query', '#camera-state', '#camera-source', '#camera-type', '#camera-sort',
    '#camera-healthy', '#camera-favorites', '#camera-results-scroll'
  ]);
  assert.ok((await page.screenshot()).length > 1000);

  const firstResult = page.locator('.camera-result:visible').first();
  await firstResult.locator('.camera-result-open').click();
  await page.locator('#camera-modal').waitFor({ state: 'visible' });
  await assertSurfaceWithinViewport(page, '#camera-modal .modal-content', `${theme} camera modal`);
  await page.locator('#modal-close').focus();
  assert.equal(await page.locator('#modal-close').evaluate((element) => document.activeElement === element), true);
  assert.ok((await page.screenshot()).length > 1000);
  await page.locator('#modal-close').click();

  if ((await page.evaluate(() => window._stormscope.getMonitorState().selected)) < 2) {
    await page.locator('.camera-result:visible .monitor-result').nth(0).click();
    await page.locator('.camera-result:visible .monitor-result').nth(1).click();
  }
  await page.locator('#open-monitor').click();
  await page.locator('#monitor-modal').waitFor({ state: 'visible' });
  await assertSurfaceWithinViewport(page, '#monitor-modal .modal-content', `${theme} monitor`);
  assert.ok((await page.screenshot()).length > 1000);
  await page.locator('#monitor-close').click();
  await searchToggle.click();

  await page.waitForFunction(() => !document.getElementById('radar-play').disabled);
  await assertSurfaceWithinViewport(page, '#radar-controls', `${theme} radar timeline`);
  await assertControlsReachable(page, '#radar-controls', ['#radar-prev', '#radar-play', '#radar-next', '#radar-scrubber']);
}

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

async function addNetworkFixtures(page, metrics) {
  metrics = metrics || { rainViewerRequests: 0 };
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
      const offset = Number(new URL(url).searchParams.get('resultOffset') || 0);
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [{
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[-100 + offset, 39], [-99 + offset, 39], [-99 + offset, 40], [-100 + offset, 40], [-100 + offset, 39]]] },
          properties: {
            OBJECTID: offset + 1,
            poly_IncidentName: offset === 0
              ? '<img src=x onerror=window.__wildfireInjected=true>'
              : 'Fixture Fire ' + (offset + 1),
            poly_GISAcres: 1250,
            poly_DateCurrent: Date.now() - 600000, attr_PercentContained: 35, attr_IncidentTypeCategory: 'WF'
          }
        }], properties: { exceededTransferLimit: offset === 0 } })
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
      if (url.includes('tilecache.rainviewer.com')) metrics.rainViewerRequests += 1;
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
  await page.locator('#camera-count').filter({ hasText: '36,592 indexed' }).waitFor({ state: 'visible' });
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
    const networkMetrics = { rainViewerRequests: 0 };
    await addNetworkFixtures(page, networkMetrics);
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
    await page.locator('#wildfire-status').filter({ hasText: '2 wildfire perimeters' }).waitFor({ state: 'visible' });
    const popupOpened = await page.evaluate(() => {
      window.__wildfireInjected = false;
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          String(item.feature.properties.poly_IncidentName).startsWith('<img'));
        if (child) {
          child.openPopup();
          opened = true;
        }
      });
      return opened;
    });
    assert.equal(popupOpened, true);
    const hostilePopup = page.locator('.leaflet-popup-content');
    await hostilePopup.waitFor({ state: 'visible' });
    assert.match(await hostilePopup.textContent(), /<img src=x onerror=window\.__wildfireInjected=true>/);
    assert.equal(await hostilePopup.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__wildfireInjected), false);
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
    if (Number(await scrubber.getAttribute('max')) > 0) {
      assert.notEqual(await scrubber.inputValue(), frameBeforeNext,
        'manual frame controls must remain usable without animation');
    }
    const budgetSnapshot = await page.evaluate(() => window._stormscope.getRainViewerBudget());
    assert.ok(budgetSnapshot.used <= 90, 'RainViewer rolling budget exceeded: ' + JSON.stringify(budgetSnapshot));
    assert.ok(networkMetrics.rainViewerRequests <= 90,
      'RainViewer network requests exceeded the safety ceiling: ' + networkMetrics.rainViewerRequests);
    const failLightning = (route) => route.fulfill({ status: 503, body: 'fixture unavailable' });
    await page.route('https://nowcoast.noaa.gov/**', failLightning);
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#toggle-lightning').check();
    await page.locator('#toggle-wildfires').check();
    await page.locator('#lightning-status').filter({ hasText: 'Official data unavailable' }).waitFor({ state: 'visible' });
    await page.locator('#wildfire-status').filter({ hasText: '2 wildfire perimeters' }).waitFor({ state: 'visible' });
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
    assert.match(
      await page.locator('#camera-count').textContent(),
      /^36\.592 indexadas .* 13\.071 saludables .* 1 degradadas .* 23\.520 sin verificar$/
    );
    assert.match(await page.locator('#radar-frame-position').textContent(), /^Fotograma /);
    assert.match(await page.locator('#radar-time').textContent(), /hace|ahora mismo/);
    await page.locator('#alerts-status').filter({ hasText: '1 alerta' }).waitFor({ state: 'visible' });
    assert.equal(
      (await page.locator('.alerts-provider-note').textContent()).trim(),
      'Texto del proveedor NWS (puede permanecer en inglés)'
    );
    await page.getByRole('button', { name: /Severe Thunderstorm Warning/ }).click();
    await page.locator('#alert-detail').waitFor({ state: 'visible' });
    assert.match(await page.locator('#alert-detail').textContent(), /Severa • Inmediata • Observada/);
    await page.locator('#alert-detail .alert-detail-dismiss').click();
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
    const renderMetricsBeforeScroll = await page.evaluate(() => window._stormscope.getSearchRenderMetrics());
    await page.locator('#camera-results-scroll').evaluate(element => { element.scrollTop = 900; });
    await page.waitForFunction(before => {
      const current = window._stormscope.getSearchRenderMetrics();
      return current.windowRenders > before.windowRenders;
    }, renderMetricsBeforeScroll);
    const renderMetricsAfterScroll = await page.evaluate(() => window._stormscope.getSearchRenderMetrics());
    assert.equal(renderMetricsAfterScroll.fullRenders, renderMetricsBeforeScroll.fullRenders,
      'virtual scrolling must not rerun full-corpus search/sort');
    assert.equal(renderMetricsAfterScroll.markerSyncs, renderMetricsBeforeScroll.markerSyncs,
      'virtual scrolling must not clear or re-add map markers');
    await page.locator('#camera-results-scroll').focus();
    const focusedStart = 0;
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(expected => {
      const item = document.activeElement && document.activeElement.closest('.camera-result');
      return item && Number(item.dataset.resultIndex) === expected;
    }, focusedStart + 1);
    await page.keyboard.press('PageDown');
    await page.waitForFunction(start => {
      const item = document.activeElement && document.activeElement.closest('.camera-result');
      return item && Number(item.dataset.resultIndex) > start + 1;
    }, focusedStart);
    await page.keyboard.press('End');
    await page.waitForTimeout(100);
    const finalResultPosition = await page.evaluate(() => ({
      position: document.activeElement.closest('.camera-result') && document.activeElement.closest('.camera-result').getAttribute('aria-posinset'),
      size: document.activeElement.closest('.camera-result') && document.activeElement.closest('.camera-result').getAttribute('aria-setsize'),
      total: window._stormscope.getCameraResults().length
    }));
    assert.equal(Number(finalResultPosition.position), finalResultPosition.total);
    assert.equal(Number(finalResultPosition.size), finalResultPosition.total);
    await page.keyboard.press('Home');
    await page.waitForFunction(() => {
      const item = document.activeElement && document.activeElement.closest('.camera-result');
      return item && item.getAttribute('aria-posinset') === '1';
    });
    await page.locator('#camera-type').selectOption('image');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length > 0 && results.every(camera => camera.type === 'image');
    });
    const observedCamera = await page.evaluate(() => {
      const cameras = window._stormscope.getCameraResults();
      const observedIndex = 0;
      const camera = cameras[0];
      return {
        observedIndex,
        url: camera.url,
        type: camera.type,
        health: camera.health,
        lastVerified: camera.last_verified
      };
    });
    assert.equal(observedCamera.type, 'image');
    const cameraImageFixture = route => route.fulfill({
      contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel
    });
    const cameraImageMatch = url => url.href.startsWith(observedCamera.url);
    await page.route(cameraImageMatch, cameraImageFixture);
    await visibleResults.nth(observedCamera.observedIndex).locator('.camera-result-open').click();
    await page.locator('#camera-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#camera-modal').getAttribute('role'), 'dialog');
    const modalImage = page.locator('#modal-feed img');
    await modalImage.waitFor({ state: 'visible' });
    await modalImage.dispatchEvent('load');
    await page.waitForFunction(() => {
      const observations = JSON.parse(localStorage.getItem('stormscope-camera-observations-v1') || '{}');
      return Object.values(observations).some(item => item.outcome === 'playable' && item.reason === 'refresh_advanced');
    });
    const playbackContract = await page.evaluate(() => {
      const camera = window._stormscope.getCameraResults().find(item => item.type === 'image');
      const observations = JSON.parse(localStorage.getItem('stormscope-camera-observations-v1'));
      const observation = Object.values(observations)[0];
      return {
        health: camera.health,
        lastVerified: camera.last_verified,
        observation,
        now: Date.now()
      };
    });
    assert.equal(playbackContract.health, observedCamera.health);
    assert.equal(playbackContract.lastVerified, observedCamera.lastVerified);
    assert.ok(playbackContract.observation.expires_at > playbackContract.now);
    assert.ok(playbackContract.observation.expires_at <= playbackContract.now + 6 * 60 * 60 * 1000);
    const provenance = page.locator('.camera-provenance');
    await provenance.getByRole('heading', { name: 'Feed details' }).waitFor({ state: 'visible' });
    assert.equal(await provenance.locator('dt').count(), 7);
    assert.match(await page.locator('#modal-local-observation').textContent(), /Playable.*image advanced on refresh/);
    assert.ok((await page.locator('#modal-provider').textContent()).trim().length > 0);
    assert.ok((await page.locator('#modal-feed-type').textContent()).trim().length > 0);
    assert.equal(await page.locator('#modal-cam-health').getAttribute('title'), null);
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await page.locator('#camera-modal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#modal-feed video, #modal-feed iframe, #modal-feed img').count(), 0);
    await page.unroute(cameraImageMatch, cameraImageFixture);
    await page.locator('#camera-type').selectOption('');

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
    await page.locator('#camera-source').selectOption('angelcam');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length > 1 && results.every((camera) => camera.source === 'angelcam');
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
    await page.locator('#camera-source').selectOption('smithsonian');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 6 && results.every((camera) => camera.source === 'smithsonian');
    });
    await page.locator('#camera-source').selectOption('mwra');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 2 && results.every((camera) => camera.source === 'mwra');
    });
    await page.locator('#camera-source').selectOption('ipcamlive');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 22 && results.every((camera) => camera.source === 'ipcamlive');
    });
    await page.locator('#camera-source').selectOption('rtspme');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 1 && results.every((camera) => camera.source === 'rtspme');
    });
    await page.locator('#camera-source').selectOption('noaa');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 3 && results.every((camera) => camera.source === 'noaa');
    });
    await page.locator('#camera-source').selectOption('usgs');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 32 && results.every((camera) => camera.source === 'usgs');
    });
    await page.locator('#camera-source').selectOption('faa');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 18 && results.every((camera) => camera.source === 'faa');
    });
    await page.locator('#camera-source').selectOption('hazcams');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 17 && results.every((camera) => camera.source === 'hazcams');
    });
    await page.locator('#camera-source').selectOption('angelcam');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 4 && results.every((camera) => camera.source === 'angelcam');
    });
    await page.locator('#camera-source').selectOption('nrao');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 1 && results.every((camera) => camera.source === 'nrao');
    });
    await page.locator('#camera-source').selectOption('university');
    await page.waitForFunction(() => {
      const results = window._stormscope.getCameraResults();
      return results.length === 9 && results.every((camera) => camera.source === 'university');
    });
    await page.locator('#camera-source').selectOption('');
    await page.getByRole('button', { name: 'Find cameras' }).click();

    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#view-name').fill('Smoke view');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#saved-state-status').filter({ hasText: 'View saved locally.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();

    const sceneFixture = await page.evaluate(() => {
      const camera = window._stormscope.getCameraResults()[0];
      return { cameraId: String(camera.id), cameraName: camera.name, frameTime: window._stormscope.getRadarFrameTime() };
    });
    const sharedScene = {
      map: { lat: 39.75, lon: -98.25, zoom: 6 },
      layers: { radar: true, cameras: true, coverage: false, alerts: true, lightning: false, wildfires: false },
      radar: { opacity: 0.48, palette: 'contrast', speed: 400, frameTime: sceneFixture.frameTime },
      alertSeverity: 'severe',
      cameraFilters: {
        query: sceneFixture.cameraName, state: '', source: '', type: '', sort: 'distance', healthy: false
      },
      activeCameraId: sceneFixture.cameraId
    };
    const scenePage = await context.newPage();
    scenePage.baseURL = baseURL + '#' + sceneCodec.toHash(sharedScene);
    await addNetworkFixtures(scenePage);
    await waitForApp(scenePage);
    await scenePage.locator('#camera-modal').waitFor({ state: 'visible' });
    const restoredScene = await scenePage.evaluate(() => ({
      scene: window._stormscope.captureSharedScene(),
      activeCameraId: window._stormscope.getActiveCameraId(),
      frameTime: window._stormscope.getRadarFrameTime(),
      favoriteOnly: document.getElementById('camera-favorites').checked
    }));
    assert.ok(Math.abs(restoredScene.scene.map.lat - sharedScene.map.lat) < 0.01);
    assert.ok(Math.abs(restoredScene.scene.map.lon - sharedScene.map.lon) < 0.01);
    assert.equal(restoredScene.scene.map.zoom, sharedScene.map.zoom);
    assert.deepEqual(restoredScene.scene.layers, sharedScene.layers);
    assert.equal(restoredScene.scene.radar.opacity, sharedScene.radar.opacity);
    assert.equal(restoredScene.scene.radar.palette, sharedScene.radar.palette);
    assert.equal(restoredScene.scene.radar.speed, sharedScene.radar.speed);
    assert.ok(Math.abs(restoredScene.frameTime - sharedScene.radar.frameTime) <= 30 * 60 * 1000);
    assert.equal(restoredScene.scene.alertSeverity, sharedScene.alertSeverity);
    assert.deepEqual(restoredScene.scene.cameraFilters, sharedScene.cameraFilters);
    assert.equal(restoredScene.activeCameraId, sharedScene.activeCameraId);
    assert.equal(restoredScene.favoriteOnly, false);

    await scenePage.evaluate(() => {
      window.__copiedScene = null;
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText(value) { window.__copiedScene = value; return Promise.resolve(); } }
      });
    });
    await scenePage.locator('#modal-close').click();
    await scenePage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await scenePage.locator('#share-scene').click();
    await scenePage.locator('#saved-state-status').filter({ hasText: 'Web Share was unavailable; the scene link was copied instead.' })
      .waitFor({ state: 'visible' });
    assert.match(await scenePage.evaluate(() => window.__copiedScene), /#scene=1\./);
    assert.equal((await scenePage.evaluate(() => window.__copiedScene)).includes('favorite'), false);
    await scenePage.close();

    const invalidScenePage = await context.newPage();
    invalidScenePage.baseURL = baseURL + '#scene=0.e30';
    await addNetworkFixtures(invalidScenePage);
    await waitForApp(invalidScenePage, false);
    await invalidScenePage.locator('#saved-state-status')
      .filter({ hasText: 'Shared scene link is invalid or unsupported; local state was preserved.' }).waitFor({ state: 'attached' });
    assert.equal(await invalidScenePage.locator('#fatal-recovery').isHidden(), true);
    await invalidScenePage.close();

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#camera-count').filter({ hasText: '36,592 indexed' }).waitFor({ state: 'visible' });
    const onlineGeneration = await page.evaluate(() => window._stormscope.getCameraLoadMetrics().index.generated_at);
    assert.match(onlineGeneration, /^2026-07-12T/);
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.waitForFunction(async () => {
      const cache = await caches.open('stormscope-data-v2');
      const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
      return keys.includes('/data/cameras.index.json') &&
        keys.filter((pathname) => pathname.includes('/data/camera-shards/')).length === 49;
    });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'StormScope' }).waitFor({ state: 'visible' });
    await page.locator('#camera-count').filter({ hasText: 'indexed' }).waitFor({ state: 'visible' });
    assert.match(
      await page.locator('#camera-count').textContent(),
      /^36[,.]592 indexed .* 13[,.]071 healthy .* 1 degraded .* 23[,.]520 unverified$/
    );
    assert.equal(
      await page.evaluate(() => window._stormscope.getCameraLoadMetrics().index.generated_at),
      onlineGeneration,
      'offline reload must preserve the authoritative generation timestamp'
    );
    await context.setOffline(false);

    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    const clearCache = page.getByRole('button', { name: 'Clear cached data' });
    await clearCache.waitFor({ state: 'visible' });
    await clearCache.click();
    await page.locator('#cache-status').filter({ hasText: 'Offline cache:' }).waitFor({ state: 'visible' });
    const cacheNames = await page.evaluate(() => caches.keys());
    assert.ok(cacheNames.some((name) => name.startsWith('stormscope-shell-')));
    assert.ok(!cacheNames.some((name) => name.startsWith('stormscope-data-')), 'runtime data cache should be cleared: ' + cacheNames.join(', '));

    await page.evaluate(() => setTimeout(() => {
      throw new Error('feed https://camera.example/private?token=secret at 40.12345,-75.98765');
    }, 0));
    await page.locator('#fatal-recovery').waitFor({ state: 'visible' });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export diagnostics' }).click();
    const diagnosticsDownload = await downloadPromise;
    const diagnosticsReport = JSON.parse(fs.readFileSync(await diagnosticsDownload.path(), 'utf8'));
    const serializedDiagnostics = JSON.stringify(diagnosticsReport);
    assert.equal(diagnosticsReport.schema, 1);
    assert.match(serializedDiagnostics, /\[url\]/);
    assert.doesNotMatch(serializedDiagnostics, /camera\.example|token=secret|40\.12345|-75\.98765/);
    assert.equal(Object.hasOwn(diagnosticsReport, 'favorites'), false);
    assert.equal(Object.hasOwn(diagnosticsReport, 'savedViews'), false);
    const expectedDiagnosticError = errors.findIndex(message => message.includes('camera.example/private'));
    assert.ok(expectedDiagnosticError >= 0, 'the injected runtime failure must reach the page error channel');
    errors.splice(expectedDiagnosticError, 1);

    const mobile = await context.newPage();
    mobile.baseURL = baseURL;
    await mobile.setViewportSize({ width: 390, height: 844 });
    await addNetworkFixtures(mobile);
    await waitForApp(mobile, false);
    assert.equal(await mobile.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
    await mobile.getByRole('button', { name: 'Toggle layers panel' }).click();
    assert.equal(await mobile.getByRole('button', { name: 'Toggle layers panel' }).getAttribute('aria-expanded'), 'true');
    await mobile.getByRole('region', { name: 'Map layers' }).waitFor({ state: 'visible' });

    for (const viewport of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
      const landscape = await context.newPage();
      landscape.baseURL = baseURL;
      await landscape.setViewportSize(viewport);
      await addNetworkFixtures(landscape);
      await waitForApp(landscape, false);
      assert.equal(await landscape.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
      await exerciseLandscapeLayout(landscape, 'dark');
      await exerciseLandscapeLayout(landscape, 'light');
      await landscape.close();
    }

    assert.deepEqual(errors, []);
    console.log('Headless desktop/mobile/modal/offline/cache/accessibility smoke passed.');
  } finally {
    await context.setOffline(false).catch(() => {});
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { addNetworkFixtures, serveStatic, waitForApp };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
