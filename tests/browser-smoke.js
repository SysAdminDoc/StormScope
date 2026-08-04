'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const sceneCodec = require('../js/scene-codec.js');
const i18n = require('../js/i18n.js');
const pseudoLocale = require('./pseudo-locale.js');

async function collectJsHeap(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  await session.send('HeapProfiler.collectGarbage');
  const result = await session.send('Performance.getMetrics');
  await session.detach();
  return result.metrics.find((metric) => metric.name === 'JSHeapUsedSize').value;
}

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
      const containerElement = document.querySelector(containerSelector);
      if (!containerElement) return false;
      const container = containerElement.getBoundingClientRect();
      return document.activeElement === element && rect.bottom > Math.max(0, container.top) &&
        rect.top < Math.min(window.innerHeight, container.bottom) && rect.right > 0 && rect.left < window.innerWidth;
    }, containerSelector);
    assert.equal(reachable, true, `${selector} must be keyboard reachable in ${containerSelector}`);
  }
}

async function assertEveryControlReachable(page, containerSelector, label) {
  const result = await page.locator(containerSelector).evaluate((container) => {
    const controls = [...container.querySelectorAll('button, input, select, a[href], [tabindex="0"]')];
    const failures = [];
    let checked = 0;
    controls.forEach((element, index) => {
      const style = getComputedStyle(element);
      const initialRect = element.getBoundingClientRect();
      if (element.disabled || style.display === 'none' || style.visibility === 'hidden' ||
          initialRect.width === 0 || initialRect.height === 0) return;
      checked += 1;
      element.focus();
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const reachable = document.activeElement === element && rect.width > 0 && rect.height > 0 &&
        rect.bottom > Math.max(0, containerRect.top) && rect.top < Math.min(window.innerHeight, containerRect.bottom) &&
        rect.right > 0 && rect.left < window.innerWidth;
      if (!reachable) failures.push({ index, id: element.id, tag: element.tagName });
    });
    return { checked, failures };
  });
  assert.ok(result.checked > 0, `${label} must expose at least one enabled control`);
  assert.deepEqual(result.failures, [], `${label} controls must all be keyboard reachable`);
}

async function assertOnlyTopLevelSurface(page, expected, label) {
  const selectors = ['#alerts-panel', '#layers-panel', '#search-panel', '#situation-panel'];
  const visible = [];
  for (const selector of selectors) {
    if (await page.locator(selector).isVisible()) visible.push(selector);
  }
  assert.deepEqual(visible, [expected], `${label} must expose exactly one top-level map surface`);
  assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false,
    `${label} must not create horizontal scrolling`);
  await assertSurfaceWithinViewport(page, expected, label);
  await assertEveryControlReachable(page, expected, label);
}

async function ensureProLayerMode(page) {
  const modeButton = page.locator('#toggle-layer-mode');
  if (await modeButton.getAttribute('aria-pressed') !== 'true') {
    await modeButton.click();
    await page.waitForFunction(() => window._stormscope.getLayerDisplayMode() === 'pro');
  }
}

async function exerciseLayerDisplayMode(page) {
  const modeButton = page.locator('#toggle-layer-mode');
  assert.equal(await page.evaluate(() => window._stormscope.getLayerDisplayMode()), 'simple');
  assert.equal(await modeButton.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#toggle-radar').isVisible(), true);
  assert.equal(await page.locator('#toggle-alerts').isVisible(), true);
  assert.equal(await page.locator('#toggle-watches').isVisible(), true);
  assert.equal(await page.locator('#toggle-earthquakes').isVisible(), false);
  assert.equal(await page.locator('#surface-observations-status').isVisible(), true);
  assert.equal(await page.locator('#earthquake-status').isVisible(), true);
  assert.equal(await page.locator('#toggle-alerts').isDisabled(), true);
  assert.equal(await page.locator('#toggle-alerts').isChecked(), true);
  const sceneBefore = await page.evaluate(() => window._stormscope.getSharedSceneUrl());

  await modeButton.click();
  await page.waitForFunction(() => window._stormscope.getLayerDisplayMode() === 'pro');
  assert.equal(await modeButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#toggle-earthquakes').isVisible(), true);
  assert.equal(await page.locator('#toggle-alerts').isDisabled(), false);
  assert.equal(await page.evaluate(() => window._stormscope.getSharedSceneUrl()), sceneBefore,
    'layer detail mode must stay outside shared scenes');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await page.locator('#btn-layers').click();
  await page.locator('#layers-panel').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window._stormscope.getLayerDisplayMode()), 'pro',
    'layer detail mode must persist locally');
  assert.equal(await page.locator('#toggle-earthquakes').isVisible(), true);

  await modeButton.click();
  await page.waitForFunction(() => window._stormscope.getLayerDisplayMode() === 'simple');
  assert.equal(await page.locator('#toggle-alerts').isDisabled(), true);
  assert.equal(await page.locator('#toggle-alerts').isChecked(), true);
  await modeButton.click();
  await page.waitForFunction(() => window._stormscope.getLayerDisplayMode() === 'pro');
}

async function exerciseLayerNavigation(page, options) {
  await ensureProLayerMode(page);
  const before = await page.evaluate(() => window._stormscope.getLayerRegistryState().enabled);
  const query = page.locator('#layer-filter-query');
  const clear = page.locator('#layer-filter-clear');
  const count = page.locator('#layer-filter-count');
  const groupQuery = options.locale === 'es' ? 'Contexto de peligros' : 'Hazard context';

  await query.fill(groupQuery);
   assert.match(await count.textContent(), /\b6\b/);
  assert.equal(await page.locator('[data-layer-id="lightning"]').first().isVisible(), true);
  assert.equal(await page.locator('[data-layer-id="earthquakes"]').first().isVisible(), true);
  assert.equal(await page.locator('[data-layer-id="radar"]').first().isVisible(), false);

  if (options.detailed) {
    await query.fill(options.locale === 'es' ? 'magnitud' : 'magnitude');
    assert.match(await count.textContent(), /\b1\b/);
    assert.equal(await page.locator('#earthquake-magnitude').isVisible(), true);
    assert.equal(await page.locator('#earthquake-status').isVisible(), true, 'provider status must remain reachable while filtering');

    await query.fill('no-layer-can-match-this');
    assert.match(await count.textContent(), /\b0\b/);
    assert.equal(await page.locator('#layer-filter-empty').isVisible(), true);
    await clear.click();

    await page.locator('#layer-filter-active').check();
    const activeCount = Object.values(before).filter(Boolean).length;
    assert.match(await count.textContent(), new RegExp('\\b' + activeCount + '\\b'));
  }

  await clear.click();
  assert.equal(await query.inputValue(), '');
  assert.equal(await page.locator('#layer-filter-active').isChecked(), false);
  assert.deepEqual(await page.evaluate(() => window._stormscope.getLayerRegistryState().enabled), before,
    'layer navigation must not change enabled state');
}

async function exerciseNarrowPanelState(page, options) {
  const label = `${options.width}px ${options.locale} ${options.theme} ${options.offline ? 'offline' : 'online'}`;
  await page.context().setOffline(options.offline);
  await page.waitForFunction((offline) => document.querySelector('#connection-state').classList.contains('offline') === offline,
    options.offline);

  if (await page.locator('#btn-layers').getAttribute('aria-expanded') !== 'true') {
    await page.locator('#btn-layers').click();
  }
  const alternateLocale = options.locale === 'en' ? 'es' : 'en';
  await page.locator('#app-locale').selectOption(alternateLocale);
  await page.locator('#app-locale').selectOption(options.locale);
  await page.locator('#app-theme').selectOption(options.theme);
  if (options.width === 320) await exerciseLayerNavigation(page, { locale: options.locale, detailed: false });
  await assertOnlyTopLevelSurface(page, '#layers-panel', `${label} layers after alert re-render`);

  await page.locator('#btn-search').click();
  await assertOnlyTopLevelSurface(page, '#search-panel', `${label} search`);
  await page.locator('#btn-summary').click();
  await assertOnlyTopLevelSurface(page, '#situation-panel', `${label} situation summary`);
  await page.locator('#close-summary').click();
  await assertOnlyTopLevelSurface(page, '#alerts-panel', `${label} alerts restored`);
}

async function exercisePseudoLocale(page) {
  await page.locator('#app-locale').selectOption('es');
  const pseudoCatalog = pseudoLocale.expandCatalog(i18n.catalogs.en, 0.35);
  await page.evaluate((catalog) => {
    const locale = window.StormScopeI18n;
    window.__stormscopePseudoOriginal = Object.assign({}, locale.catalogs.en);
    Object.assign(locale.catalogs.en, catalog);
  }, pseudoCatalog);
  await page.locator('#app-locale').selectOption('en');
  const pseudoResult = await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
    const container = document.querySelector('#layers-panel');
    const failures = [];
    [...container.querySelectorAll('button, input, select, a[href], [tabindex="0"]')].forEach((element) => {
      const style = getComputedStyle(element);
      const initialRect = element.getBoundingClientRect();
      if (element.disabled || style.display === 'none' || style.visibility === 'hidden' ||
          initialRect.width === 0 || initialRect.height === 0) return;
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const horizontallyClipped = rect.left < -1 || rect.right > window.innerWidth + 1 ||
        (!['INPUT', 'SELECT'].includes(element.tagName) && element.scrollWidth > element.clientWidth + 2);
      if (horizontallyClipped) failures.push({ id: element.id, tag: element.tagName });
    });
    const result = {
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      pseudoTextPresent: document.body.textContent.includes('⟦'),
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      failures
    };
    return result;
  });
  assert.equal(pseudoResult.lang, 'en', 'pseudo-locale checks must not ship a locale tag');
  assert.equal(pseudoResult.dir, 'rtl', 'pseudo-locale layout must exercise RTL direction');
  assert.equal(pseudoResult.pseudoTextPresent, true, 'pseudo-locale text must be rendered before layout assertions');
  assert.equal(pseudoResult.pageOverflow, false, 'pseudo-locale RTL layout must not overflow at 320px');
  assert.deepEqual(pseudoResult.failures, [], 'pseudo-locale controls must remain unclipped at 320px');
  await page.evaluate(() => {
    const locale = window.StormScopeI18n;
    Object.assign(locale.catalogs.en, window.__stormscopePseudoOriginal);
    delete window.__stormscopePseudoOriginal;
    locale.setLocale('en');
    locale.localizeDocument(document);
  });
}

async function exerciseLandscapeLayout(page, theme) {
  const summaryToggle = page.getByRole('button', { name: /Open situation summary|Abrir resumen de situación/ });
  await summaryToggle.click();
  await page.locator('#situation-panel').waitFor({ state: 'visible' });
  await assertSurfaceWithinViewport(page, '#situation-panel', `${theme} situation summary`);
  await assertControlsReachable(page, '#situation-panel', ['#close-summary', '#refresh-summary']);
  await page.locator('#close-summary').click();

  const layersToggle = page.getByRole('button', { name: 'Toggle layers panel' });
  if (await layersToggle.getAttribute('aria-expanded') !== 'true') await layersToggle.click();
  await page.locator('#app-theme').selectOption(theme);
  await page.locator('#radar-speed').selectOption('800');
  if (!await page.locator('#toggle-alerts').isChecked()) await page.locator('#toggle-alerts').check();
  await assertSurfaceWithinViewport(page, '#layers-panel', `${theme} layers`);
  await assertControlsReachable(page, '#layers-panel', ['#toggle-radar', '#alert-severity', '#app-locale', '#keep-offline-data', '#clear-cache']);
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

async function addNetworkFixtures(page, metrics, options) {
  metrics = metrics || { rainViewerRequests: 0 };
  options = options || {};
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (options.customRadar && url.startsWith('http://127.0.0.1:') && new URL(url).pathname === '/') {
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(
        "connect-src 'self'",
        "connect-src 'self' https://radar.example.test https://tiles.example.test"
      );
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      return;
    }
    if (options.customRadar && url.endsWith('/js/radar-build-config.js')) {
      const config = {
        schemaVersion: 1, enabled: true, providerId: 'build-radar', protocol: 'rainviewer-v2',
        discoveryUrl: 'https://radar.example.test/public/weather-maps.json',
        tileOrigins: ['https://tiles.example.test'],
        attribution: { label: 'Fixture Radar', url: 'https://radar.example.test/about' },
        capabilities: {
          maxZoom: 8,
          freshness: { staleAfterMinutes: 15, failAfterMinutes: 30 },
          history: { enabled: true, windowMinutes: 180 }
        }
      };
      await route.fulfill({
        contentType: 'text/javascript; charset=utf-8',
        body: `globalThis.StormScopeRadarBuildConfig = Object.freeze(${JSON.stringify(config)});`
      });
      return;
    }
    if (options.customRadar && url === 'https://radar.example.test/public/weather-maps.json') {
      await route.fulfill({
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          host: 'https://tiles.example.test',
          radar: { past: [{ time: Math.floor(Date.now() / 1000) - 300, path: '/v2/radar/custom-latest' }] }
        })
      });
      return;
    }
    if (options.customRadar && url.startsWith('https://tiles.example.test/')) {
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel });
      return;
    }
    if (options.ridgeFallback && url === 'https://api.rainviewer.com/public/weather-maps.json') {
      await route.abort();
      return;
    }
    if (options.ridgeFallback && url.startsWith('https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer')) {
      await route.abort();
      return;
    }
    if (url.startsWith('https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows') &&
        url.includes('request=GetCapabilities')) {
      const latest = new Date(Date.now() - 5 * 60000).toISOString();
      const middle = new Date(Date.now() - 10 * 60000).toISOString();
      await route.fulfill({
        contentType: 'text/xml',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: `<WMS_Capabilities version="1.3.0"><Capability><Layer><Name>conus_bref_qcd</Name>` +
          `<Dimension name="time" default="${latest}">${middle},${latest}</Dimension>` +
          `</Layer></Capability></WMS_Capabilities>`
      });
      return;
    }
    if (url.startsWith('https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows') &&
        url.includes('request=GetMap')) {
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel });
      return;
    }
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
    if (url.startsWith('https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGEDGC_Last_24hr/ImageServer/exportImage')) {
      metrics.satelliteExports = (metrics.satelliteExports || 0) + 1;
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel });
      return;
    }
    if (url.startsWith('https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGEDGC_Last_24hr/ImageServer')) {
      metrics.satelliteMetadataRequests = (metrics.satelliteMetadataRequests || 0) + 1;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        timeInfo: { timeExtent: [Date.now() - 3600000, Date.now()] }
      }) });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/export')) {
      metrics.snowExports = (metrics.snowExports || 0) + 1;
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: pixel });
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
    if (url.startsWith('https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query')) {
      const future = Date.now() + 3 * 60 * 60 * 1000;
      await route.fulfill({
        contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-101, 36], [-97, 36], [-97, 40], [-101, 40], [-101, 36]]] },
            properties: { objectid: 1, prod_type: 'Tornado Watch', issuance: Date.now() - 1800000, expiration: future, url: 'https://www.spc.noaa.gov/products/watch/ww0042.html' } },
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-95, 37], [-91, 37], [-91, 41], [-95, 41], [-95, 37]]] },
            properties: { objectid: 2, prod_type: 'Severe Thunderstorm Watch', expiration: future, url: 'http://insecure.example/x' } }
        ] })
      });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/spc_mesoscale_discussion/MapServer/0/query')) {
      await route.fulfill({
        contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-101, 36], [-96, 36], [-96, 41], [-101, 41], [-101, 36]]] },
            properties: { objectid: 1, name: 'MD 1234', folderpath: 'Severe weather potential',
              popupinfo: 'https://www.spc.noaa.gov/products/md/md1234.html', idp_filedate: Date.now() - 900000 } }
        ] })
      });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/vector/rest/services/obs/nws_local_storm_reports/MapServer/') && url.includes('/query')) {
      await route.fulfill({
        contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [-98, 39] },
            properties: { objectid: 1, wfo_id: 'TOP', wfo: 'Topeka', descript: 'Hail', loc_desc: 'Fixtureville', state: 'KS',
              magnitude: '1.25', units: 'inch', remarks: '<img src=x onerror=window.__lsrInjected=true>',
              lsr_validtime: Date.now() - 600000 } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [-97, 38] },
            properties: { objectid: 2, wfo_id: 'OUN', wfo: 'Norman', descript: 'Thunderstorm Wind', loc_desc: 'Testburg', state: 'OK',
              magnitude: '60', units: 'mph', lsr_validtime: Date.now() - 1200000 } }
        ] })
      });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/vector/rest/services/aviation/awc_aviation_weather/MapServer/12/query')) {
      if (metrics) metrics.surfaceObservationRequests = (metrics.surfaceObservationRequests || 0) + 1;
      const now = Date.now();
      await route.fulfill({
        contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [
          { type: 'Feature', id: 101, geometry: { type: 'MultiPoint', coordinates: [[-110, 45]] }, properties: {
            objectid: 101, station_id: 'KFIX', raw_text: 'METAR KFIX <img src=x onerror=window.__surfaceInjected=true>',
            observation_time: now - 600000, latitude: 45, longitude: -110, temp_c: 20, dewpoint_c: 12,
            winddir: 180, wind_speed_kt: 12, wind_gust_kt: 22, visibility_statute_mi: '10+',
            wx_string: '-RA', sky_cover: 'BKN', flight_category: 'MVFR', cloud_base_ft_agl: 2200, ceiling_ft: 2200
          } },
          { type: 'Feature', id: 102, geometry: { type: 'MultiPoint', coordinates: [[-90, 35]] }, properties: {
            objectid: 102, station_id: 'KCLEAR', raw_text: 'METAR KCLEAR', observation_time: now - 300000,
            latitude: 35, longitude: -90, temp_c: 25, dewpoint_c: 18, winddir: 90, wind_speed_kt: 8,
            visibility_statute_mi: '10+', sky_cover: 'CLR', flight_category: 'VFR'
          } }
        ] })
      });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/SPC_firewx/MapServer/') && url.includes('/query')) {
      const match = url.match(/MapServer\/(\d+)\/query/);
      const layerId = match ? Number(match[1]) : -1;
      const dryLayers = new Set([2, 5, 7, 10, 13, 16, 19, 22]);
      const dayLayers = new Map([[1, 1], [2, 1], [4, 2], [5, 2], [7, 3], [8, 3], [10, 4], [11, 4],
        [13, 5], [14, 5], [16, 6], [17, 6], [19, 7], [20, 7], [22, 8], [23, 8]]);
      const now = Date.now();
      if (metrics) metrics.fireWeatherRequests = (metrics.fireWeatherRequests || 0) + 1;
      await route.fulfill({ contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-101, 36], [-96, 36], [-96, 41], [-101, 41], [-101, 36]]] },
            properties: { objectid: layerId, label: dryLayers.has(layerId) ? 'Scattered DryT' : 'Critical (40%)',
              dn: dryLayers.has(layerId) ? 8 : 8, issue: now - 1800000, valid: now - 900000, expire: now + 6 * 3600000,
              idp_source: 'NOAA/NWS SPC fixture', stroke: dryLayers.has(layerId) ? '#b00000' : '#b00000',
              fill: dryLayers.has(layerId) ? '#ff0000' : '#ff0000', outlookDay: dayLayers.get(layerId) || 1 }
          }
        ] }) });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer/') && url.includes('/query')) {
      const offset = Number(new URL(url).searchParams.get('resultOffset') || 0);
      await route.fulfill({
        contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-100 + offset, 37], [-96 + offset, 37], [-96 + offset, 41], [-100 + offset, 41], [-100 + offset, 37]]] },
            properties: { objectid: offset + 1, label: 'ENH', dn: 5, issue: Date.now() - 3600000, valid: Date.now() - 1800000, expire: Date.now() + 3600000, idp_source: 'SPC' } },
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-99, 38], [-97, 38], [-97, 40], [-99, 40], [-99, 38]]] },
            properties: { objectid: offset + 2, label: 'MRGL', dn: 3 } }
        ] })
      });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer/')) {
      await route.fulfill({
        contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ editingInfo: { dataLastEditDate: Date.now() - 1800000 } })
      });
      return;
    }
    if (url.startsWith('https://photon.komoot.io/api')) {
      await route.fulfill({
        contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.3321, 47.6062] }, properties: { name: 'Seattle', state: 'Washington', country: 'United States' } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.2015, 47.6101] }, properties: { name: 'Bellevue', state: 'Washington', country: 'United States' } }
        ] })
      });
      return;
    }
    if (url.startsWith('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/')) {
      await route.fulfill({
        contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          type: 'FeatureCollection',
          metadata: { generated: Date.now() - 120000 },
          features: [
            { type: 'Feature', id: 'eq1', geometry: { type: 'Point', coordinates: [-97, 38, 8] },
              properties: { mag: 4.6, place: '<img src=x onerror=window.__quakeInjected=true> 5km N of Fixtureville',
                time: Date.now() - 300000, url: 'javascript:window.__quakeHref=true' } },
            { type: 'Feature', id: 'eq2', geometry: { type: 'Point', coordinates: [-99, 40, 3] },
              properties: { mag: 2.7, place: '3km S of Testburg', time: Date.now() - 900000,
                url: 'https://earthquake.usgs.gov/earthquakes/eventpage/eq2' } }
          ]
        })
      });
      return;
    }
    if (url.includes('/NHC_tropical_weather_summary/MapServer/') && url.includes('/query')) {
      const match = url.match(/MapServer\/(\d+)\/query/);
      const layerId = match ? Number(match[1]) : -1;
      const properties = { binnumber: 'AT1', stormname: 'ALPHA', stormtype: 'Hurricane', advisnum: '12',
        advdate: Date.now() - 600000, idp_filedate: Date.now() - 300000, maxwind: 90, mslp: 970, tau: 0,
        tcww: 'HWA' };
      const geometries = {
        5: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [-90, 27] }, properties },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [-88, 29] }, properties: { ...properties, tau: 12 } }
        ],
        6: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90, 27], [-88, 29]] }, properties }],
        7: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-91, 26], [-89, 26], [-87, 29], [-89, 30], [-91, 26]]] }, properties }],
        8: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-89, 28], [-87, 29]] }, properties }]
      };
      await route.fulfill({ contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', features: geometries[layerId] || [] }) });
      return;
    }
    if (url.includes('/hazards/wpc_precip_hazards/MapServer/') && url.includes('/query')) {
      const match = url.match(/MapServer\/(\d+)\/query/);
      const day = Number(match && match[1]) + 1;
      const categories = [
        { dn: 1, outlook: 'Marginal (At Least 5%)' },
        { dn: 2, outlook: 'Slight (At Least 15%)' },
        { dn: 3, outlook: 'Moderate (At Least 40%)' }
      ];
      await route.fulfill({ contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', features: [categories[day - 1]].map((category, index) => ({
          type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-102 + day, 35], [-98 + day, 35], [-98 + day, 39], [-102 + day, 35]]] },
          properties: { objectid: index + 1, product: `Day ${day} Excessive Rainfall Potential Forecast`,
            valid_time: '12Z - 12Z', issue_time: '2026-07-13 01:03:00', start_time: '2026-07-13 01:00:00',
            end_time: '2026-07-13 12:00:00', idp_source: `fixture-day-${day}`, idp_filedate: Date.now() - 300000,
            ...category }
        })) }) });
      return;
    }
    if (url.includes('/outlooks/sig_riv_fld_outlk/MapServer/0/query')) {
      await route.fulfill({ contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[-92, 36], [-90, 36], [-90, 38], [-92, 36]]] },
          properties: { objectid: 1, id: 'fixture-flood', product: 'Significant River Flood Outlook', outlook: 'Possible',
            issue_time: '2026-07-12 20:00:00', start_time: '2026-07-12 20:00:00', end_time: '2026-07-17 20:00:00',
            idp_source: 'fixture-flood', idp_filedate: Date.now() - 3600000 }
        }] }) });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0/query')) {
      const now = Date.now();
      metrics.riverGaugeRequests = (metrics.riverGaugeRequests || 0) + 1;
      metrics.riverGaugeMaxRecordCount = Math.max(metrics.riverGaugeMaxRecordCount || 0,
        Number(new URL(url).searchParams.get('resultRecordCount') || 0));
      await route.fulfill({ contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [{
          type: 'Feature', geometry: { type: 'Point', coordinates: [-90.18, 38.63] }, properties: {
            objectid: 1, gaugelid: 'USGS-07010000', status: 'minor', location: 'Mississippi River at St. Louis',
            waterbody: 'Mississippi River', state: 'MO', obstime: new Date(now - 60000).toISOString(),
            url: 'https://water.noaa.gov/gauges/07010000', action: 28, units: 'ft', lowthreshu: 'ft',
            secvalue: 100000, secunit: 'cfs', flood: 30, moderate: 35, major: 40, observed: 31,
            latitude: 38.63, longitude: -90.18, idp_ingestdate: now - 30000
          }
        }] }) });
      return;
    }
    if (url.startsWith('https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/1/query')) {
      const now = Date.now();
      metrics.riverGaugeRequests = (metrics.riverGaugeRequests || 0) + 1;
      metrics.riverGaugeMaxRecordCount = Math.max(metrics.riverGaugeMaxRecordCount || 0,
        Number(new URL(url).searchParams.get('resultRecordCount') || 0));
      await route.fulfill({ contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', exceededTransferLimit: false, features: [{
          type: 'Feature', geometry: { type: 'Point', coordinates: [-90.18, 38.63] }, properties: {
            objectid: 1, gaugelid: 'USGS-07010000', status: 'moderate', location: 'Mississippi River at St. Louis',
            waterbody: 'Mississippi River', state: 'MO', fcsttime: new Date(now + 3600000).toISOString(),
            fcstissunc: new Date(now - 120000).toISOString(), url: 'https://water.noaa.gov/gauges/07010000',
            action: 28, units: 'ft', lowthreshu: 'ft', forecast: 36, flood: 30, moderate: 35, major: 40,
            latitude: 38.63, longitude: -90.18, idp_ingestdate: now - 30000
          }
        }] }) });
      return;
    }
    if (url.startsWith('https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items')) {
      await route.fulfill({ contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
          geometry: { type: 'Point', coordinates: [-90.18, 38.63] }, properties: {
            monitoring_location_id: 'USGS-07010000', value: '31', unit_of_measure: 'ft', time: new Date().toISOString()
          } }], links: [] }) });
      return;
    }
    if (url === 'https://api.water.noaa.gov/nwps/v1/gauges/07010000') {
      await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ usgsId: '07010000', name: 'Mississippi River at St. Louis',
          status: { observed: { primary: 31, primaryUnit: 'ft', validTime: new Date().toISOString() } },
          flood: { stageUnits: 'ft', categories: { action: { stage: 28 }, minor: { stage: 30 },
            moderate: { stage: 35 }, major: { stage: 40 } } } }) });
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
      if (url.includes('basemaps.cartocdn.com') && options.realBasemap) return route.continue();
      const tile = url.includes('tilecache.rainviewer.com') && options.transparentRadar
        ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64')
        : pixel;
      await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: tile });
      return;
    }
    if (url.startsWith('https://api.weather.gov/alerts/active')) {
      const now = Date.now();
      const savedAlertFixture = options.savedAlertFixture;
      if (savedAlertFixture) metrics.savedAlertRequests = (metrics.savedAlertRequests || 0) + 1;
      const fixtureVersion = savedAlertFixture ? Number(savedAlertFixture.version || 0) : 0;
      const fixtureBase = savedAlertFixture
        ? (savedAlertFixture.base || (savedAlertFixture.base = now - 60000))
        : now - 60000;
      const fixtureSent = new Date(fixtureBase + fixtureVersion * 60000).toISOString();
      const fixtureFeature = {
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
          sent: fixtureSent,
          effective: fixtureSent,
          expires: new Date(now + 3600000).toISOString(),
          parameters: {
            NWSheadline: ['SEVERE THUNDERSTORM WARNING REMAINS IN EFFECT FOR TEST COUNTY'],
            thunderstormDamageThreat: ['DESTRUCTIVE'],
            maxHailSize: ['2.75'],
            maxWindGust: ['80 MPH'],
            eventMotionDescription: ['2026-07-14T12:00:00-05:00...storm...240DEG...35KT...39.0,-99.0'],
            hailThreat: ['RADAR INDICATED'],
            windThreat: ['OBSERVED'],
            WEAHandling: ['Imminent Threat']
          }
        }
      };
      const fixtureFeatures = [fixtureFeature];
      if (savedAlertFixture && fixtureVersion > 0) {
        fixtureFeatures.push({
          ...fixtureFeature,
          id: 'https://api.weather.gov/alerts/fixture-new',
          properties: {
            ...fixtureFeature.properties,
            id: 'https://api.weather.gov/alerts/fixture-new',
            '@id': 'https://api.weather.gov/alerts/fixture-new',
            event: 'Tornado Warning',
            headline: 'Tornado Warning issued for the test area'
          }
        });
      }
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: fixtureFeatures })
      });
      return;
    }
    if (url.startsWith('https://api.weather.gov/points/')) {
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ properties: {
          forecastHourly: 'https://api.weather.gov/fixture/hourly',
          observationStations: 'https://api.weather.gov/fixture/stations'
        } })
      });
      return;
    }
    if (url.startsWith('https://api.weather.gov/fixture/stations?')) {
      await route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify({ features: [
        {
          id: 'https://api.weather.gov/stations/KEMPTY', geometry: { type: 'Point', coordinates: [-97, 39] },
          properties: { stationIdentifier: 'KEMPTY', name: 'Empty Test Station', distance: { value: 1000 } }
        },
        {
          id: 'https://api.weather.gov/stations/KOBS', geometry: { type: 'Point', coordinates: [-97.1, 39.1] },
          properties: { stationIdentifier: 'KOBS', name: 'Observed Test Station', distance: { value: 3200 } }
        }
      ] }) });
      return;
    }
    if (url.startsWith('https://api.weather.gov/stations/KEMPTY/observations/latest')) {
      await route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify({ properties: {
        timestamp: new Date(Date.now() - 10 * 60000).toISOString(), textDescription: '',
        temperature: { value: null }, windSpeed: { value: null }, relativeHumidity: { value: null }
      } }) });
      return;
    }
    if (url.startsWith('https://api.weather.gov/stations/KOBS/observations/latest')) {
      await route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify({ properties: {
        timestamp: new Date(Date.now() - 20 * 60000).toISOString(), textDescription: 'Mostly Clear',
        temperature: { value: 20, unitCode: 'wmoUnit:degC' },
        windSpeed: { value: 16.09344, unitCode: 'wmoUnit:km_h-1' },
        windDirection: { value: 0, unitCode: 'wmoUnit:degree_(angle)' },
        relativeHumidity: { value: 45, unitCode: 'wmoUnit:percent' }
      } }) });
      return;
    }
    if (url === 'https://api.weather.gov/fixture/hourly') {
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({ properties: { updateTime: new Date(Date.now() - 5 * 60000).toISOString(), periods: Array.from({ length: 12 }, (_, index) => ({
          temperature: index % 2 === 0 ? 72 : 60,
          temperatureUnit: 'F',
          shortForecast: 'Clear',
          windSpeed: index % 2 === 0 ? '5 mph' : '4 mph',
          windDirection: 'N',
          relativeHumidity: { value: index % 2 === 0 ? 45 : 50 },
          probabilityOfPrecipitation: index === 2 ? { value: null } : { value: index === 0 ? 20 : index * 5 },
          quantitativePrecipitation: index === 2 ? { value: null, unitCode: 'wmoUnit:mm' } : {
            value: index === 0 ? 0 : index * 0.5, unitCode: 'wmoUnit:mm'
          },
          startTime: new Date(Date.now() + (55 + index * 60) * 60000).toISOString(),
          endTime: new Date(Date.now() + (115 + index * 60) * 60000).toISOString()
        })) } })
      });
      return;
    }
    if (url.startsWith('https://air-quality-api.open-meteo.com/')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ utc_offset_seconds: -18000, current: {
          time: '2026-07-14T12:00', us_aqi: 43,
          pm2_5: 7.5, pm10: 9.2, ozone: 66, nitrogen_dioxide: 12.3,
          sulphur_dioxide: 1, carbon_monoxide: 123,
          us_aqi_pm2_5: 41, us_aqi_pm10: 8, us_aqi_ozone: 43,
          us_aqi_nitrogen_dioxide: 6, us_aqi_sulphur_dioxide: 1,
          us_aqi_carbon_monoxide: 1
        } })
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
  await page.locator('#camera-count').filter({ hasText: /36[,.]592 (?:indexed|indexadas)/ })
    .waitFor({ state: 'visible' });
  if (requireRadar) {
    await page.waitForFunction(() => /RainViewer|NOAA\/NWS MRMS/.test(document.querySelector('#radar-meta').textContent));
  }
}

async function writeFailureArtifacts(context, label, error) {
  const artifactRoot = process.env.STORMSCOPE_TEST_ARTIFACTS;
  if (!artifactRoot) return;
  fs.mkdirSync(artifactRoot, { recursive: true });
  const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  fs.writeFileSync(path.join(artifactRoot, `${safeLabel}-error.txt`), String(error && error.stack || error), 'utf8');
  const pages = context.pages();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const prefix = path.join(artifactRoot, `${safeLabel}-page-${index + 1}`);
    await page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
    await page.content().then(content => fs.writeFileSync(`${prefix}.html`, content, 'utf8')).catch(() => {});
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
    await page.addInitScript(() => {
      let persistent = false;
      window.__persistCalls = 0;
      Object.defineProperty(navigator.storage, 'estimate', {
        configurable: true, value: () => Promise.resolve({ usage: 25 * 1024 * 1024, quota: 100 * 1024 * 1024 })
      });
      Object.defineProperty(navigator.storage, 'persisted', {
        configurable: true, value: () => Promise.resolve(persistent)
      });
      Object.defineProperty(navigator.storage, 'persist', {
        configurable: true, value: () => { window.__persistCalls += 1; persistent = true; return Promise.resolve(true); }
      });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const source = message.location().url || '';
      if (/net::ERR_(FAILED|INTERNET_DISCONNECTED)/.test(text)) return;
      if (text.startsWith('Failed to load resource') && source && !source.startsWith(baseURL)) return;
      errors.push(text);
    });
    const networkMetrics = { rainViewerRequests: 0, satelliteExports: 0, satelliteMetadataRequests: 0, snowExports: 0, surfaceObservationRequests: 0 };
    await addNetworkFixtures(page, networkMetrics);
    await waitForApp(page);

    const permalinkPage = await context.newPage();
    permalinkPage.baseURL = baseURL;
    await addNetworkFixtures(permalinkPage);
    await waitForApp(permalinkPage);
    await permalinkPage.locator('#btn-layers').click();
    await permalinkPage.locator('#layers-panel').waitFor({ state: 'visible' });
    await ensureProLayerMode(permalinkPage);
    await permalinkPage.locator('#toggle-terminator').check();
    await permalinkPage.waitForFunction(() => location.hash.startsWith('#scene=1.'));
    const terminatorOnHash = await permalinkPage.evaluate(() => location.hash);
    assert.equal((await permalinkPage.evaluate(() => window._stormscope.getTerminatorState())).enabled, true);
    await permalinkPage.locator('#toggle-terminator').uncheck();
    await permalinkPage.waitForFunction((hash) => location.hash.startsWith('#scene=1.') && location.hash !== hash, terminatorOnHash);
    const terminatorOffHash = await permalinkPage.evaluate(() => location.hash);
    await permalinkPage.goBack({ waitUntil: 'commit' }).catch(() => {});
    await permalinkPage.waitForFunction((hash) => location.hash === hash && window._stormscope.getTerminatorState().enabled, terminatorOnHash);
    await permalinkPage.goForward({ waitUntil: 'commit' }).catch(() => {});
    await permalinkPage.waitForFunction((hash) => location.hash === hash && !window._stormscope.getTerminatorState().enabled, terminatorOffHash);
    await permalinkPage.evaluate((hash) => { location.hash = hash; }, terminatorOnHash.slice(1));
    await permalinkPage.waitForFunction(() => window._stormscope.getTerminatorState().enabled === true);
    await permalinkPage.evaluate(() => { location.hash = 'scene=0.e30'; });
    await permalinkPage.locator('#saved-state-status')
      .filter({ hasText: 'Shared scene link is invalid or unsupported' }).waitFor({ state: 'visible' });
    assert.equal((await permalinkPage.evaluate(() => window._stormscope.getTerminatorState())).enabled, true,
      'invalid live scene links must preserve the current state');
    await permalinkPage.close();

    const savedAlertFixture = { version: 0 };
    const savedLocationPage = await context.newPage();
    savedLocationPage.baseURL = baseURL;
    const savedAlertMetrics = { rainViewerRequests: 0, savedAlertRequests: 0 };
    await addNetworkFixtures(savedLocationPage, savedAlertMetrics, { savedAlertFixture });
    await waitForApp(savedLocationPage);
    await savedLocationPage.locator('#btn-layers').click();
    await savedLocationPage.locator('#view-name').fill('Saved Plains');
    await savedLocationPage.locator('#save-view').click();
    await savedLocationPage.locator('#saved-state-status').filter({ hasText: 'View saved locally.' })
      .waitFor({ state: 'visible' });
    await savedLocationPage.evaluate(() => window._stormscope.refreshSavedLocationAlerts());
    await savedLocationPage.waitForFunction(() => {
      const state = window._stormscope.getSavedLocationAlertState();
      return state.targetCount === 1 && state.noticeCount === 0 && !state.inFlight;
    });
    const baselineSavedAlertRequests = savedAlertMetrics.savedAlertRequests;
    savedAlertFixture.version = 1;
    await savedLocationPage.evaluate(() => window._stormscope.refreshSavedLocationAlerts());
    await savedLocationPage.locator('#saved-location-alert-banner').waitFor({ state: 'visible' });
    assert.match(await savedLocationPage.locator('#saved-location-alert-banner').textContent(), /Tornado Warning/);
    assert.equal((await savedLocationPage.evaluate(() => window._stormscope.getSavedLocationAlertState())).noticeCount, 2);
    await savedLocationPage.locator('#saved-location-alert-dismiss').click();
    await savedLocationPage.locator('#saved-location-alert-banner').waitFor({ state: 'hidden' });

    await savedLocationPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await savedLocationPage.waitForFunction(() => !window._stormscope.getSavedLocationAlertState().polling);
    savedAlertFixture.version = 2;
    await savedLocationPage.evaluate(() => window._stormscope.refreshSavedLocationAlerts());
    assert.equal(savedAlertMetrics.savedAlertRequests, baselineSavedAlertRequests + 1,
      'hidden tabs must not issue saved-location alert requests');
    await savedLocationPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await savedLocationPage.waitForFunction(() => window._stormscope.getSavedLocationAlertState().polling);
    await savedLocationPage.close();

    await page.locator('#alerts-status').filter({ hasText: /1 alert/ }).waitFor({ state: 'visible' });
    await assertSurfaceWithinViewport(page, '#primary-nav', 'desktop primary navigation');
    await assertSurfaceWithinViewport(page, '#radar-controls', 'desktop radar timeline');
    assert.equal(await page.locator('#btn-alerts').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#nav-alert-count').textContent(), '1');
    await page.locator('#btn-radar').click();
    await page.locator('#alerts-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#btn-radar').getAttribute('aria-current'), 'page');
    await page.locator('#btn-alerts').click();
    await page.locator('#alerts-panel').waitFor({ state: 'visible' });
    await page.locator('#close-alerts').click();
    await page.locator('#alerts-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'btn-alerts');
    await page.locator('#btn-alerts').click();
    await page.locator('#alerts-panel').waitFor({ state: 'visible' });
    // Escape closes the alerts drawer and returns focus to its nav button.
    await page.keyboard.press('Escape');
    await page.locator('#alerts-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'btn-alerts');
    // Opening the Layers panel moves focus into it (the layer search), like Search/Situation.
    await page.locator('#btn-layers').click();
    await page.locator('#layers-panel').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'layer-filter-query');
    await exerciseLayerDisplayMode(page);
    await page.locator('#btn-layers').click();
    await page.locator('#layers-panel').waitFor({ state: 'hidden' });
    if (await page.locator('#alerts-panel').isHidden()) await page.locator('#btn-alerts').click();
    await page.locator('#alerts-panel').waitFor({ state: 'visible' });
    await page.locator('#btn-place-search').click();
    await page.locator('#search-panel').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'place-query');
    assert.equal(await page.locator('#btn-search').getAttribute('aria-current'), 'page');
    await page.locator('#btn-search').click();
    await page.locator('#search-panel').waitFor({ state: 'hidden' });
    await page.locator('#alerts-panel').waitFor({ state: 'visible' });

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
    await page.waitForFunction(() => document.getElementById('camera-source-health').textContent
      .startsWith('All ingestion sources:'));

    // Geolocation "locate me": grant + mock a position, then verify the map
    // recenters and the polite announcer confirms it. Coordinates are session-only.
    await context.grantPermissions(['geolocation'], { origin: baseURL });
    await context.setGeolocation({ latitude: 47.6062, longitude: -122.3321 });
    await page.locator('#btn-locate').click();
    await page.waitForFunction(() =>
      document.getElementById('locate-announcer').textContent.includes('Centered the map'));
    // setView may animate, so poll until the map center settles near the target
    // (an animated zoom does not update getCenter() synchronously).
    await page.waitForFunction(() => {
      const center = window._stormscope.getMap().getCenter();
      return Math.abs(center.lat - 47.6062) < 0.5 && Math.abs(center.lng + 122.3321) < 0.5;
    }, { timeout: 5000 });
    await context.clearPermissions();
    // Restore the default view so downstream golden-path assertions are stable.
    // Wait for the animated recenter to settle (moveend) before hard-resetting,
    // with a timeout fallback in case the animation already completed.
    await page.evaluate(() => new Promise((resolve) => {
      const map = window._stormscope.getMap();
      let settled = false;
      const reset = () => {
        if (settled) return;
        settled = true;
        map.setView([39.5, -98.5], 5, { animate: false });
        resolve();
      };
      map.once('moveend', reset);
      setTimeout(reset, 1200);
    }));

    // Place/address geocoding: open the search panel, type a query, pick the top
    // result, and confirm the map recenters. Then restore the default view.
    await page.locator('#btn-search').click();
    await page.locator('#search-panel').waitFor({ state: 'visible' });
    await page.locator('#place-query').fill('Seattle');
    await page.locator('#place-results .place-result').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('#place-results .place-result').count(), 2);
    assert.match(await page.locator('#place-status').textContent(), /places found/);
    // Combobox keyboard pattern: focus stays in the input and the active option
    // is tracked via aria-activedescendant (not DOM focus).
    await page.locator('#place-query').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#place-query').getAttribute('aria-activedescendant'), 'place-result-0');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'place-query');
    assert.equal(await page.locator('#place-results .place-result.active').count(), 1);
    await page.keyboard.press('ArrowUp'); // wraps to last
    assert.equal(await page.locator('#place-query').getAttribute('aria-activedescendant'), 'place-result-1');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const center = window._stormscope.getMap().getCenter();
      return Math.abs(center.lat - 47.6101) < 0.5; // Bellevue (second result)
    }, { timeout: 5000 });
    assert.equal(await page.locator('#place-query').getAttribute('aria-activedescendant'), null);
    // Re-run and select via mouse click to cover that path too.
    await page.locator('#place-query').fill('Seattle');
    await page.locator('#place-results .place-result').first().waitFor({ state: 'visible' });
    await page.locator('#place-results .place-result').first().click();
    await page.waitForFunction(() => {
      const center = window._stormscope.getMap().getCenter();
      return Math.abs(center.lat - 47.6062) < 0.5 && Math.abs(center.lng + 122.3321) < 0.5;
    }, { timeout: 5000 });
    assert.match(await page.locator('#place-status').textContent(), /Centered on Seattle/);
    await page.evaluate(() => new Promise((resolve) => {
      const map = window._stormscope.getMap();
      let settled = false;
      const reset = () => { if (settled) return; settled = true; map.setView([39.5, -98.5], 5, { animate: false }); resolve(); };
      map.once('moveend', reset);
      setTimeout(reset, 1200);
    }));
    await page.locator('#btn-search').click();
    await page.locator('#search-panel').waitFor({ state: 'hidden' });

    assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
    assert.equal(await page.locator('#radar-retry').isHidden(), true);
    await page.waitForFunction(() => !document.querySelector('#radar-time').textContent.startsWith('Loading'));
    assert.match(await page.locator('#radar-time').textContent(), /old|ago|just now/i);
    await page.locator('#btn-summary').focus();
    await page.keyboard.press('Enter');
    await page.locator('#situation-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#btn-summary').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'situation-heading');
    await page.locator('#situation-content').filter({ hasText: '2 current perimeters' }).waitFor({ state: 'visible' });
    const summaryText = await page.locator('#situation-content').textContent();
    assert.match(summaryText, /Map position.*zoom 5/s);
    assert.match(summaryText, /Radar at map center.*coverage|Radar at map center.*no coverage/s);
    assert.match(summaryText, /1 active alerts, including 1 warnings/);
    assert.match(summaryText, /Nearest verified cameras.*5 nearest verified cameras/s);
    const situationTableRequests = [];
    const situationTableRequestListener = request => situationTableRequests.push(request.url());
    page.on('request', situationTableRequestListener);
    await page.getByRole('button', { name: 'Show accessible data table' }).click();
    await page.locator('#situation-data-table-panel').waitFor({ state: 'visible' });
    page.off('request', situationTableRequestListener);
    assert.deepEqual(situationTableRequests, [], 'opening the data table must not fetch new data');
    assert.deepEqual(await page.locator('#situation-data-table thead th').allTextContents(), [
      'Type', 'Event or name', 'Severity or count', 'Area or details', 'Action'
    ]);
    const situationTable = page.locator('#situation-data-table');
    await situationTable.getByText('Severe Thunderstorm Warning', { exact: true }).waitFor({ state: 'visible' });
    await situationTable.getByText('Test County', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await situationTable.getByRole('button', { name: 'Read alert' }).count(), 1);
    assert.equal(await situationTable.getByRole('button', { name: 'Open camera' }).count(), 5);
    await situationTable.getByRole('button', { name: 'Open camera' }).first().focus();
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('situation-data-table-action')), true);
    await page.getByRole('button', { name: 'Hide accessible data table' }).click();
    await page.locator('#situation-data-table-panel').waitFor({ state: 'hidden' });
    const snapshot = await page.evaluate(() => window._stormscope.buildSituationSnapshot(false));
    assert.equal(snapshot.json.schema, 1);
    assert.deepEqual(snapshot.json.map.center, { latitude: 39.5, longitude: -98.5 });
    assert.equal(Object.hasOwn(snapshot.json, 'public_scene_url'), false);
    assert.equal(Object.hasOwn(snapshot.json, 'favorites'), false);
    assert.equal(Object.hasOwn(snapshot.json, 'savedViews'), false);
    assert.equal(Object.hasOwn(snapshot.json, 'local_overlays'), false);
    assert.ok(snapshot.json.sources.some((source) => source.id === 'radar'));
    await page.locator('#snapshot-include-scene').check();
    const linkedSnapshot = await page.evaluate(() => window._stormscope.buildSituationSnapshot(true));
    assert.match(linkedSnapshot.json.public_scene_url, /#scene=1\./);
    const snapshotDownloadPromise = page.waitForEvent('download');
    await page.locator('#download-situation-snapshot').click();
    const snapshotDownload = await snapshotDownloadPromise;
    assert.equal(snapshotDownload.suggestedFilename(), 'stormscope-situation-snapshot.json');
    const downloadedSnapshot = JSON.parse(fs.readFileSync(await snapshotDownload.path(), 'utf8'));
    assert.equal(downloadedSnapshot.schema, 1);
    assert.equal(Object.hasOwn(downloadedSnapshot, 'public_scene_url'), true);
    const summaryMapState = await page.evaluate(() => {
      const map = window._stormscope.getMap();
      return { center: map.getCenter(), zoom: map.getZoom() };
    });
    await page.locator('.summary-read-alert').first().click();
    await page.locator('#alert-detail').waitFor({ state: 'visible' });
    const impactDetails = page.locator('#alert-detail .alert-impact-details');
    await impactDetails.getByRole('heading', { name: 'Official impact details' }).waitFor({ state: 'visible' });
    assert.match(await impactDetails.textContent(), /Official NWS headline.*SEVERE THUNDERSTORM WARNING REMAINS IN EFFECT/s);
    assert.match(await impactDetails.textContent(), /Thunderstorm damage threat.*DESTRUCTIVE/s);
    assert.match(await impactDetails.textContent(), /Maximum hail size.*2\.75/s);
    assert.match(await impactDetails.textContent(), /Maximum wind gust.*80 MPH/s);
    assert.match(await impactDetails.textContent(), /Storm motion.*240DEG.*35KT/s);
    assert.match(await impactDetails.textContent(), /Hail detection.*RADAR INDICATED/s);
    assert.match(await impactDetails.textContent(), /Wind detection.*OBSERVED/s);
    assert.match(await impactDetails.textContent(), /Wireless Emergency Alert handling.*Imminent Threat/s);
    assert.deepEqual(await page.evaluate(() => {
      const map = window._stormscope.getMap();
      return { center: map.getCenter(), zoom: map.getZoom() };
    }), summaryMapState, 'reading an alert from the summary must not manipulate the map');
    await page.getByRole('button', { name: 'Hide alert details' }).click();
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'btn-summary');
    await page.locator('#btn-summary').click();
    await page.locator('.summary-open-camera').first().click();
    await page.locator('#camera-modal').waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => {
      const map = window._stormscope.getMap();
      return { center: map.getCenter(), zoom: map.getZoom() };
    }), summaryMapState, 'opening a camera from the summary must not manipulate the map');
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await page.locator('#refresh-summary').click();
    assert.equal(await page.locator('#situation-announcer').textContent(), 'Situation summary updated.');
    await page.keyboard.press('Escape');
    await page.locator('#situation-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'btn-summary');
    const scrubber = page.locator('#radar-scrubber');
    assert.ok(Number(await scrubber.getAttribute('max')) > 0, 'radar timeline should expose multiple frames');
    assert.deepEqual(await page.evaluate(() => window._stormscope.getContextState()), {
      satellite: false, lightning: false, wildfires: false, tropical: false, wpcOutlooks: false, usgsGauges: false, earthquakes: false, convective: false, fireWeather: false, satelliteStatus: 'off',
      lightningStatus: 'off', wildfireStatus: 'off', tropicalStatus: 'off', tropicalCount: 0,
      wpcStatus: 'off', wpcCount: 0, wpcDay: 1, gaugeStatus: 'off', gaugeCount: 0,
      earthquakeStatus: 'off', earthquakeCount: 0, convectiveStatus: 'off', convectiveCount: 0, convectiveDay: 1, fireWeatherStatus: 'off', fireWeatherCount: 0, fireWeatherDay: 1, watches: false, watchStatus: 'off', watchCount: 0, satelliteZ: '315',
      localOverlays: 0, rasterZ: '325', vectorZ: '390', localOverlayZ: '380', tropicalZ: '395', warningZ: '400', cameraZ: '600'
    });
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    const hostileOverlay = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { name: '<img src=x onerror=window.__overlayInjected=true>', href: 'https://attacker.example/beacon' },
      geometry: { type: 'Polygon', coordinates: [[[-101, 37], [-99, 37], [-99, 39], [-101, 37]]] }
    }] });
    await page.locator('#local-overlay-file').setInputFiles({
      name: 'incident-plan.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(hostileOverlay)
    });
    await page.locator('#local-overlay-status').filter({ hasText: 'Imported “incident-plan” with 1 feature' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 1);
    assert.deepEqual(await page.evaluate(() => {
      const state = window._stormscope.getContextState();
      return { count: state.localOverlays, z: state.localOverlayZ };
    }), { count: 1, z: '380' });
    const localPopupOpened = await page.evaluate(() => {
      window.__overlayInjected = false;
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          String(item.feature.properties.name).startsWith('<img'));
        if (child) { child.openPopup(); opened = true; }
      });
      return opened;
    });
    assert.equal(localPopupOpened, true);
    const localPopup = page.locator('.leaflet-popup-content').filter({ hasText: '<img src=x' });
    await localPopup.waitFor({ state: 'visible' });
    assert.equal(await localPopup.locator('img').count(), 0);
    assert.equal(await localPopup.locator('a[href*="attacker.example"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__overlayInjected), false);
    await page.locator('.local-overlay-actions').getByRole('button', { name: 'Keep locally' }).click();
    await page.locator('#local-overlay-status').filter({ hasText: 'will be kept locally' }).waitFor({ state: 'visible' });
    const persistedOverlayPage = await context.newPage();
    persistedOverlayPage.baseURL = baseURL;
    await addNetworkFixtures(persistedOverlayPage);
    await waitForApp(persistedOverlayPage);
    await persistedOverlayPage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await persistedOverlayPage.locator('.local-overlay-item').filter({ hasText: 'incident-plan' }).waitFor({ state: 'visible' });
    assert.equal((await persistedOverlayPage.evaluate(() => window._stormscope.getContextState())).localOverlays, 1);
    await persistedOverlayPage.close();

    const routeAnchors = await page.evaluate(() => window._stormscope.getCameraResults()
      .filter(camera => camera.health === 'healthy' && camera.last_verified &&
        ['image', 'hls', 'mjpeg', 'youtube'].includes(String(camera.type).toLowerCase()))
      .slice(0, 2)
      .map(camera => ({ name: camera.name, lat: camera.lat, lon: camera.lon })));
    assert.equal(routeAnchors.length, 2, 'route smoke needs two verified playable cameras');
    const gpx = '<?xml version="1.0"?><gpx version="1.1"><wpt lat="' + routeAnchors[0].lat +
      '" lon="' + routeAnchors[0].lon + '"><name>Checkpoint</name></wpt>' +
      '<trk><name>Route</name><trkseg><trkpt lat="' + routeAnchors[0].lat + '" lon="' + routeAnchors[0].lon +
      '"></trkpt><trkpt lat="' + routeAnchors[1].lat + '" lon="' + routeAnchors[1].lon +
      '"></trkpt></trkseg></trk></gpx>';
    await page.locator('#local-overlay-file').setInputFiles({
      name: 'route.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx)
    });
    await page.locator('#local-overlay-status').filter({ hasText: 'Imported “route” with 2 features' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 2);
    await page.getByRole('button', { name: 'Open situation summary' }).click();
    const routeSelect = page.locator('#route-corridor-route');
    await routeSelect.locator('option').nth(1).waitFor({ state: 'attached' });
    await routeSelect.selectOption({ index: 1 });
    await page.locator('#route-corridor-width').fill('5');
    await page.locator('#route-corridor-activate').click();
    await page.locator('#route-corridor-status').filter({ hasText: 'Route corridor analyzed.' }).waitFor({ state: 'visible' });
    const routeCameraGroup = page.locator('#route-corridor-results .route-corridor-result-group').nth(1);
    await routeCameraGroup.waitFor({ state: 'visible' });
    assert.ok(await routeCameraGroup.locator('.route-open-camera').count() >= 2,
      'route corridor should expose at least two verified cameras');
    const routeCameraText = await routeCameraGroup.textContent();
    assert.ok(await routeCameraGroup.locator('li').count() <= 12, 'route camera results must stay bounded');
    assert.match(routeCameraText, /along route/);
    assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window._stormscope.captureSharedScene())),
      /route|route-corridor|Checkpoint/i, 'route corridor state must stay out of shared scenes');
    const routeMonitor = page.locator('.route-corridor-monitor');
    await routeMonitor.waitFor({ state: 'visible' });
    assert.equal(await routeMonitor.isEnabled(), true);
    await routeMonitor.click();
    await page.locator('#monitor-modal').waitFor({ state: 'visible' });
    const routeMonitorCount = await page.locator('.monitor-cell').count();
    assert.ok(routeMonitorCount >= 2 && routeMonitorCount <= 4, 'route monitor must stay bounded to 2–4 cameras');
    await page.locator('#monitor-close').click();
    await page.locator('#route-corridor-clear').click();
    await page.locator('#route-corridor-status').filter({ hasText: 'Route corridor cleared.' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Close situation summary' }).click();
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window._stormscope.captureSharedScene())),
      /incident-plan|route|localOverlay/i, 'shared scenes must exclude private local overlay data and IDs');
    const malformed = JSON.stringify({ type: 'Point', coordinates: [999, 0] });
    await page.locator('#local-overlay-file').setInputFiles({
      name: 'bad.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(malformed)
    });
    await page.locator('#local-overlay-status').filter({ hasText: 'Import rejected' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 2, 'rejected import must preserve prior overlays');
    const overlayDownload = page.waitForEvent('download');
    await page.locator('#export-local-overlays').click();
    assert.equal((await overlayDownload).suggestedFilename(), 'stormscope-local-overlays.json');

    const persistedOverlay = page.locator('.local-overlay-item').filter({ hasText: 'incident-plan' });
    await persistedOverlay.getByRole('button', { name: 'Remove', exact: true }).click();
    const overlayUndo = page.locator('#local-overlay-status .recovery-action');
    await overlayUndo.waitFor({ state: 'visible' });
    assert.match(await page.locator('#local-overlay-status').textContent(), /Removed “incident-plan”\. Undo for 10 seconds\./);
    assert.equal(await page.locator('.local-overlay-item').count(), 1);
    await overlayUndo.focus();
    await page.keyboard.press('Enter');
    await page.locator('#local-overlay-status').filter({ hasText: 'Restored “incident-plan”.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 2);
    const recoveredOverlayPage = await context.newPage();
    recoveredOverlayPage.baseURL = baseURL;
    await addNetworkFixtures(recoveredOverlayPage);
    await waitForApp(recoveredOverlayPage);
    await recoveredOverlayPage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await recoveredOverlayPage.locator('.local-overlay-item').filter({ hasText: 'incident-plan' }).waitFor({ state: 'visible' });
    await recoveredOverlayPage.close();

    await persistedOverlay.getByRole('button', { name: 'Remove', exact: true }).click();
    await overlayUndo.waitFor({ state: 'visible' });
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function failNextTransaction() {
        IDBDatabase.prototype.transaction = transaction;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      };
    });
    await overlayUndo.click();
    await page.locator('#local-overlay-status')
      .filter({ hasText: 'restored for this session but could not be kept for reload' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 2, 'failed persistence must retain a session-only recovery');

    page.once('dialog', async dialog => {
      assert.match(dialog.message(), /Remove all 2 local overlays.*Restore will be available for 10 seconds/);
      await dialog.dismiss();
    });
    await page.locator('#clear-local-overlays').click();
    assert.equal(await page.locator('.local-overlay-item').count(), 2, 'cancelled bulk removal must preserve all overlays');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#clear-local-overlays').click();
    const overlayRestore = page.locator('#local-overlay-status .recovery-action');
    await overlayRestore.waitFor({ state: 'visible' });
    assert.match(await page.locator('#local-overlay-status').textContent(), /Removed 2 local overlays\. Restore for 10 seconds\./);
    assert.equal(await page.locator('.local-overlay-item').count(), 0);
    await overlayRestore.focus();
    await page.keyboard.press('Enter');
    await page.locator('#local-overlay-status').filter({ hasText: 'Restored 2 local overlays.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 2);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#clear-local-overlays').click();
    await page.locator('#local-overlay-status').filter({ hasText: 'Removed 2 local overlays.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 0);
    await page.locator('#annotation-tool').selectOption('point');
    await page.locator('#annotation-lat').fill('38.5');
    await page.locator('#annotation-lon').fill('-90.5');
    await page.locator('#annotation-label').fill('Point marker');
    await page.locator('#annotation-add-point').click();
    await page.locator('.private-annotation-item').filter({ hasText: 'Point marker' }).waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window._stormscope.getPrivateAnnotationState()), {
      count: 1, draftVertices: 0, tool: 'point', paneZ: '385'
    });
    await page.locator('#annotation-tool').selectOption('measure');
    await page.locator('#measure-start-lat').fill('38.5');
    await page.locator('#measure-start-lon').fill('-90.5');
    await page.locator('#measure-end-lat').fill('38.5');
    await page.locator('#measure-end-lon').fill('-89.5');
    await page.locator('#annotation-measure-run').focus();
    await page.keyboard.press('Enter');
    await page.locator('#annotation-measure-result').filter({ hasText: 'bearing' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.private-annotation-item').count(), 2);
    await page.locator('#annotation-tool').selectOption('line');
    await page.locator('#annotation-lat').fill('38');
    await page.locator('#annotation-lon').fill('-91');
    await page.locator('#annotation-add-vertex').click();
    await page.locator('#annotation-lat').fill('39');
    await page.locator('#annotation-lon').fill('-90');
    await page.locator('#annotation-add-vertex').click();
    assert.equal((await page.evaluate(() => window._stormscope.getPrivateAnnotationState())).draftVertices, 2);
    await page.locator('#annotation-finish').click();
    assert.equal(await page.locator('.private-annotation-item').count(), 3);
    await page.locator('#annotation-tool').selectOption('polygon');
    for (const [lat, lon] of [['37', '-92'], ['37', '-91'], ['38', '-91']]) {
      await page.locator('#annotation-lat').fill(lat);
      await page.locator('#annotation-lon').fill(lon);
      await page.locator('#annotation-add-vertex').click();
    }
    await page.locator('#annotation-finish').click();
    assert.equal(await page.locator('.private-annotation-item').count(), 4,
      await page.locator('#private-annotation-status').textContent());
    await page.locator('#annotation-tool').selectOption('text');
    await page.locator('#annotation-lat').fill('40');
    await page.locator('#annotation-lon').fill('-88');
    await page.locator('#annotation-label').fill('Text marker');
    await page.locator('#annotation-add-point').click();
    assert.equal(await page.locator('.private-annotation-item').count(), 5);
    await page.locator('#private-annotation-undo').click();
    assert.equal(await page.locator('.private-annotation-item').count(), 4);
    await page.locator('.private-annotation-item').first().getByRole('button', { name: 'Keep locally', exact: true }).click();
    await page.locator('#private-annotation-status').filter({ hasText: 'will be kept locally' }).waitFor({ state: 'visible' });
    assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window._stormscope.captureSharedScene())), /Point marker|private-annotation/);
    const persistedAnnotationPage = await context.newPage();
    persistedAnnotationPage.baseURL = baseURL;
    await addNetworkFixtures(persistedAnnotationPage);
    await waitForApp(persistedAnnotationPage);
    await persistedAnnotationPage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await persistedAnnotationPage.locator('.private-annotation-item').filter({ hasText: 'Point marker' }).waitFor({ state: 'visible' });
    assert.equal(await persistedAnnotationPage.locator('.private-annotation-item').count(), 1);
    await persistedAnnotationPage.close();
    const annotationDownload = page.waitForEvent('download');
    await page.locator('#private-annotation-export').click();
    assert.equal((await annotationDownload).suggestedFilename(), 'stormscope-private-annotations.json');
    await page.locator('#private-annotation-clear').click();
    await page.locator('#private-annotation-status').filter({ hasText: 'Cleared private annotations' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.private-annotation-item').count(), 0);
    assert.equal((await page.evaluate(() => window._stormscope.getTerminatorState())).status, 'off');
    await page.locator('#toggle-terminator').check();
    await page.locator('#terminator-status').filter({ hasText: 'Day/night terminator' }).waitFor({ state: 'visible' });
    const terminatorState = await page.evaluate(() => window._stormscope.getTerminatorState());
    assert.equal(terminatorState.status, 'ready');
    assert.equal(terminatorState.enabled, true);
    assert.ok(Number.isFinite(terminatorState.updatedAt));
    await page.locator('#toggle-terminator').uncheck();
    assert.deepEqual(await page.evaluate(() => window._stormscope.getTerminatorState()), {
      enabled: false, status: 'off', updatedAt: null
    });
    assert.deepEqual(await page.evaluate(() => window._stormscope.getSnowState()), {
      enabled: false, status: 'off', updatedAt: null
    });
    await page.locator('#toggle-snow').check();
    await page.locator('#snow-status').filter({ hasText: 'NOHRSC snow depth' }).waitFor({ state: 'visible' });
    const snowState = await page.evaluate(() => window._stormscope.getSnowState());
    assert.equal(snowState.status, 'ready');
    assert.equal(snowState.enabled, true);
    assert.ok(Number.isFinite(snowState.updatedAt));
    assert.equal(networkMetrics.snowExports, 1);
    await page.locator('#toggle-snow').uncheck();
    assert.deepEqual(await page.evaluate(() => window._stormscope.getSnowState()), {
      enabled: false, status: 'off', updatedAt: null
    });
    await page.locator('#toggle-surface-observations').check();
    await page.locator('#surface-observations-status').filter({ hasText: '2 METAR stations' }).waitFor({ state: 'visible' });
    const surfaceObservationState = await page.evaluate(() => window._stormscope.getSurfaceObservationState());
    assert.equal(surfaceObservationState.enabled, true);
    assert.equal(surfaceObservationState.status, 'ready');
    assert.equal(surfaceObservationState.count, 2);
    assert.equal(networkMetrics.surfaceObservationRequests, 1);
    const metarPopupOpened = await page.evaluate(() => {
      window.__surfaceInjected = false;
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          item.feature.properties.stationId === 'KFIX');
        if (child) { child.openPopup(); opened = true; }
      });
      return opened;
    });
    assert.equal(metarPopupOpened, true);
    await page.locator('.metar-popup details').evaluate(element => { element.open = true; });
    await page.locator('.metar-popup pre').waitFor({ state: 'visible' });
    assert.match(await page.locator('.metar-popup pre').textContent(), /<img src=x/);
    assert.equal(await page.evaluate(() => window.__surfaceInjected), false);
    assert.equal(await page.locator('.metar-station-marker').first().getAttribute('role'), 'button');
    await page.locator('#toggle-surface-observations').uncheck();
    assert.deepEqual(await page.evaluate(() => window._stormscope.getSurfaceObservationState()), {
      enabled: false, status: 'off', count: 0, updatedAt: null, fetchedAt: null, truncated: false
    });
    await page.locator('#toggle-satellite').check();
    await page.locator('#toggle-lightning').check();
    await page.locator('#toggle-wildfires').check();
    await page.locator('#toggle-tropical').check();
    await page.locator('#toggle-wpc-outlooks').check();
    await page.locator('#toggle-usgs-gauges').check();
    await page.locator('#satellite-status').filter({ hasText: 'GOES GeoColor' }).waitFor({ state: 'visible' });
    const satelliteLoopState = await page.evaluate(() => window._stormscope.getSatelliteState());
    assert.equal(satelliteLoopState.status, 'ready');
    assert.equal(satelliteLoopState.frameCount, 7);
    assert.equal(satelliteLoopState.frameIndex, satelliteLoopState.frameCount - 1);
    assert.equal(await page.locator('#satellite-scrubber').getAttribute('max'), '6');
    await assertControlsReachable(page, '#satellite-loop-controls', ['#satellite-prev', '#satellite-play', '#satellite-next', '#satellite-scrubber']);
    const satelliteExportsAfterInitial = networkMetrics.satelliteExports;
    const satelliteInitialIndex = satelliteLoopState.frameIndex;
    const satelliteNextIndex = (satelliteInitialIndex + 1) % satelliteLoopState.frameCount;
    await page.locator('#satellite-next').click();
    await page.waitForFunction((index) => {
      const state = window._stormscope.getSatelliteState();
      return state.status === 'ready' && state.frameIndex === index;
    }, satelliteNextIndex);
    assert.equal(networkMetrics.satelliteExports, satelliteExportsAfterInitial + 1);
    const satelliteExportsAfterNext = networkMetrics.satelliteExports;
    await page.locator('#satellite-prev').click();
    await page.waitForFunction((index) => {
      const state = window._stormscope.getSatelliteState();
      return state.status === 'ready' && state.frameIndex === index;
    }, satelliteInitialIndex);
    assert.equal(networkMetrics.satelliteExports, satelliteExportsAfterNext, 'cached satellite frames must not re-request exports');
    await page.locator('#satellite-play').click();
    await page.waitForFunction(() => window._stormscope.getSatelliteState().playing === true);
    await page.waitForFunction((index) => window._stormscope.getSatelliteState().frameIndex !== index, satelliteInitialIndex);
    await page.locator('#satellite-play').click();
    assert.equal((await page.evaluate(() => window._stormscope.getSatelliteState())).playing, false);
    assert.ok((await page.evaluate(() => window._stormscope.getSatelliteState())).requestBudget.used <= 30);
    await page.locator('#lightning-status').filter({ hasText: '15 min density' }).waitFor({ state: 'visible' });
    await page.locator('#wildfire-status').filter({ hasText: '2 wildfire perimeters' }).waitFor({ state: 'visible' });
    await page.locator('#tropical-status').filter({ hasText: '1 active tropical cyclones' }).waitFor({ state: 'visible' });
    await page.locator('#wpc-outlook-status').filter({ hasText: '2 official outlook areas' }).waitFor({ state: 'visible' });
    await page.locator('#usgs-gauge-status').filter({ hasText: '1 NOAA NWPS river gauges' }).waitFor({ state: 'visible' });
    assert.ok(networkMetrics.riverGaugeRequests >= 2);
    assert.ok(networkMetrics.riverGaugeMaxRecordCount <= 200);
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
    await hostilePopup.locator('.incident-cameras li').first().waitFor({ state: 'visible' });
    assert.match(await hostilePopup.locator('.incident-camera-status').textContent(), /nearby camera/);
    assert.ok(await hostilePopup.locator('.incident-camera-map').count() > 0);
    assert.deepEqual(await page.evaluate(() => window._stormscope.getContextState()), {
      satellite: true, lightning: true, wildfires: true, tropical: true, wpcOutlooks: true, usgsGauges: true, earthquakes: false, convective: false, fireWeather: false, satelliteStatus: 'ready',
      lightningStatus: 'ready', wildfireStatus: 'ready', tropicalStatus: 'ready', tropicalCount: 1,
      wpcStatus: 'ready', wpcCount: 2, wpcDay: 1, gaugeStatus: 'ready', gaugeCount: 1,
      earthquakeStatus: 'off', earthquakeCount: 0, convectiveStatus: 'off', convectiveCount: 0, convectiveDay: 1, fireWeatherStatus: 'off', fireWeatherCount: 0, fireWeatherDay: 1, watches: false, watchStatus: 'off', watchCount: 0, satelliteZ: '315',
      localOverlays: 0, rasterZ: '325', vectorZ: '390', localOverlayZ: '380', tropicalZ: '395', warningZ: '400', cameraZ: '600'
    });

    // USGS earthquakes: toggle on, verify count/status, hostile place text is
    // rendered as inert text (no <img> node, no handler), and a javascript:
    // event href is neutralized to '#'.
    await page.locator('#toggle-earthquakes').check();
    await page.locator('#earthquake-status').filter({ hasText: '2 earthquakes' }).waitFor({ state: 'visible' });
    const quakeState = await page.evaluate(() => window._stormscope.getContextState());
    assert.equal(quakeState.earthquakes, true);
    assert.equal(quakeState.earthquakeStatus, 'ready');
    assert.equal(quakeState.earthquakeCount, 2);
    await page.evaluate(() => window._stormscope.getMap().closePopup());
    await page.locator('.leaflet-popup-content').waitFor({ state: 'hidden' }).catch(() => {});
    const quakePopupOpened = await page.evaluate(() => {
      window.__quakeInjected = false;
      window.__quakeHref = false;
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          String(item.feature.properties.place).startsWith('<img'));
        if (child) { child.openPopup(); opened = true; }
      });
      return opened;
    });
    assert.equal(quakePopupOpened, true);
    const quakePopup = page.locator('.leaflet-popup-content');
    await quakePopup.waitFor({ state: 'visible' });
    assert.match(await quakePopup.textContent(), /<img src=x onerror=window\.__quakeInjected=true>/);
    assert.equal(await quakePopup.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__quakeInjected), false);
    assert.equal(await quakePopup.locator('a').getAttribute('href'), '#');
    assert.equal(await page.evaluate(() => window.__quakeHref), false);
    await page.locator('#toggle-earthquakes').uncheck();
    assert.equal((await page.evaluate(() => window._stormscope.getContextState())).earthquakes, false);

    // SPC convective outlooks: toggle on, verify count/status/day, then switch day.
    await page.evaluate(() => window._stormscope.getMap().closePopup());
    await page.locator('.leaflet-popup-content').waitFor({ state: 'hidden' }).catch(() => {});
    await page.locator('#toggle-convective').check();
    await page.locator('#convective-status').filter({ hasText: '2 SPC risk areas' }).waitFor({ state: 'visible' });
    const convectiveState = await page.evaluate(() => window._stormscope.getContextState());
    assert.equal(convectiveState.convective, true);
    assert.equal(convectiveState.convectiveStatus, 'ready');
    assert.equal(convectiveState.convectiveCount, 2);
    assert.equal(convectiveState.convectiveDay, 1);
    await page.locator('#convective-day').selectOption('2');
    await page.waitForFunction(() => window._stormscope.getContextState().convectiveDay === 2);
    await page.locator('#convective-day').selectOption('1'); // restore default for later assertions
    await page.locator('#toggle-convective').uncheck();
    const convectiveOff = await page.evaluate(() => window._stormscope.getContextState());
    assert.equal(convectiveOff.convective, false);
    assert.equal(convectiveOff.convectiveDay, 1);

    // SPC fire-weather outlooks: forecast risk is separate from observed NIFC perimeters.
    await page.locator('#toggle-fire-weather').check();
    await page.locator('#fire-weather-status').filter({ hasText: '2 SPC fire-weather areas' }).waitFor({ state: 'visible' });
    const fireWeatherState = await page.evaluate(() => window._stormscope.getFireWeatherState());
    assert.equal(fireWeatherState.enabled, true);
    assert.equal(fireWeatherState.status, 'ready');
    assert.equal(fireWeatherState.count, 2);
    assert.equal(fireWeatherState.day, 1);
    const fireWeatherPopupOpened = await page.evaluate(() => {
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          item.feature.properties.fireWeatherCategory === 'critical');
        if (child) { child.openPopup(); opened = true; }
      });
      return opened;
    });
    assert.equal(fireWeatherPopupOpened, true);
    const fireWeatherPopup = page.locator('.leaflet-popup-content').filter({ hasText: 'fire-weather forecast' });
    await fireWeatherPopup.waitFor({ state: 'visible' });
    assert.match(await fireWeatherPopup.textContent(), /Forecast fire-weather risk/);
    assert.match(await fireWeatherPopup.textContent(), /not an observed wildfire perimeter/);
    await fireWeatherPopup.getByRole('link', { name: 'Open official SPC fire-weather outlook' }).waitFor({ state: 'visible' });
    await page.locator('#fire-weather-day').selectOption('8');
    await page.locator('#fire-weather-status').filter({ hasText: 'Day 8' }).waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(() => window._stormscope.getFireWeatherState())).day, 8);
    await page.locator('#toggle-fire-weather').uncheck();
    assert.deepEqual(await page.evaluate(() => window._stormscope.getFireWeatherState()), {
      enabled: false, status: 'off', count: 0, day: 8, updatedAt: null
    });
    await page.locator('#fire-weather-day').selectOption('1');

    // SPC severe & tornado watches: toggle on; only active watches load (expired
    // and non-severe dropped by the module), the insecure official URL is nulled.
    await page.locator('#toggle-watches').check();
    await page.locator('#watch-status').filter({ hasText: '2 active watches' }).waitFor({ state: 'visible' });
    const watchState = await page.evaluate(() => window._stormscope.getContextState());
    assert.equal(watchState.watches, true);
    assert.equal(watchState.watchStatus, 'ready');
    assert.equal(watchState.watchCount, 2);
    await page.locator('#toggle-watches').uncheck();
    assert.equal((await page.evaluate(() => window._stormscope.getContextState())).watches, false);

    // SPC mesoscale discussions: polygon guidance is distinct from watches and warnings.
    await page.locator('#toggle-mesoscale').check();
    await page.locator('#mesoscale-status').filter({ hasText: '1 mesoscale discussions' }).waitFor({ state: 'visible' });
    const mesoscaleState = await page.evaluate(() => window._stormscope.getSpcReportsState());
    assert.equal(mesoscaleState.mesoscale, true);
    assert.equal(mesoscaleState.mesoscaleStatus, 'ready');
    assert.equal(mesoscaleState.mesoscaleCount, 1);
    const mesoscalePopupOpened = await page.evaluate(() => {
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || !layer.feature || layer.feature.properties.discussionNumber !== 'MD 1234') return;
        layer.openPopup();
        opened = true;
      });
      return opened;
    });
    assert.equal(mesoscalePopupOpened, true);
    await page.locator('.leaflet-popup-content').filter({ hasText: 'MD 1234' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('.leaflet-popup-content a').getAttribute('href'), 'https://www.spc.noaa.gov/products/md/md1234.html');
    await page.evaluate(() => window._stormscope.getMap().closePopup());
    await page.locator('#toggle-mesoscale').uncheck();
    assert.equal((await page.evaluate(() => window._stormscope.getSpcReportsState())).mesoscale, false);

    // NWS local storm reports: bounded point queries use a selectable time window and cluster.
    await page.locator('#toggle-storm-reports').check();
    await page.locator('#storm-report-status').filter({ hasText: '2 local storm reports' }).waitFor({ state: 'visible' });
    const reportState = await page.evaluate(() => window._stormscope.getSpcReportsState());
    assert.equal(reportState.stormReports, true);
    assert.equal(reportState.stormReportsStatus, 'ready');
    assert.equal(reportState.stormReportCount, 2);
    assert.equal(reportState.stormReportWindow, 24);
    await page.locator('#storm-report-window').selectOption('48');
    await page.waitForFunction(() => window._stormscope.getSpcReportsState().stormReportWindow === 48);
    const reportPopupOpened = await page.evaluate(() => {
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties && item.feature.properties.reportType === 'Hail');
        if (child) {
          if (typeof layer.zoomToShowLayer === 'function') {
            layer.zoomToShowLayer(child, () => child.openPopup());
          } else {
            child.openPopup();
          }
          opened = true;
        }
      });
      return opened;
    });
    assert.equal(reportPopupOpened, true);
    const reportPopup = page.locator('.leaflet-popup-content');
    await reportPopup.filter({ hasText: 'Hail' }).waitFor({ state: 'visible' });
    assert.match(await reportPopup.textContent(), /<img src=x onerror=window\.__lsrInjected=true>/);
    assert.equal(await reportPopup.locator('img').count(), 0);
    await page.locator('#toggle-storm-reports').uncheck();
    assert.equal((await page.evaluate(() => window._stormscope.getSpcReportsState())).stormReports, false);

    const tropicalPopupOpened = await page.evaluate(() => {
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          item.feature.properties.binNumber === 'AT1' && item.feature.properties.kind === 'cone');
        if (child) { child.openPopup(); opened = true; }
      });
      return opened;
    });
    assert.equal(tropicalPopupOpened, true);
    const tropicalPopup = page.locator('.leaflet-popup-content').filter({
      has: page.getByRole('link', { name: 'Open official NHC advisory' })
    });
    await tropicalPopup.getByRole('link', { name: 'Open official NHC advisory' }).waitFor({ state: 'visible' });
    assert.match(await tropicalPopup.getByRole('link', { name: 'Open official NHC advisory' }).getAttribute('href'),
      /graphics_at1\.shtml$/);
    await tropicalPopup.locator('.incident-camera-status').last().waitFor({ state: 'visible' });

    const failCone = route => route.fulfill({ status: 503, body: 'fixture unavailable' });
    await page.route('**/NHC_tropical_weather_summary/MapServer/7/query?**', failCone);
    await page.evaluate(() => window._stormscope.refreshTropical());
    await page.locator('#tropical-status').filter({ hasText: 'some official products unavailable' }).waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(() => window._stormscope.getContextState())).tropicalStatus, 'partial');
    await page.unroute('**/NHC_tropical_weather_summary/MapServer/7/query?**', failCone);

    const emptyTropical = route => route.fulfill({ contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    await page.route('**/NHC_tropical_weather_summary/MapServer/*/query?**', emptyTropical);
    await page.evaluate(() => window._stormscope.refreshTropical());
    await page.locator('#tropical-status').filter({ hasText: 'No active NHC tropical cyclones' }).waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => {
      const state = window._stormscope.getContextState();
      return { tropical: state.tropical, status: state.tropicalStatus, count: state.tropicalCount };
    }), { tropical: false, status: 'no-active', count: 0 });
    await page.unroute('**/NHC_tropical_weather_summary/MapServer/*/query?**', emptyTropical);

    const outlookPopupOpened = await page.evaluate(() => {
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          item.feature.properties.outlookKind === 'ero');
        if (child) { child.openPopup(); opened = true; }
      });
      return opened;
    });
    assert.equal(outlookPopupOpened, true);
    const outlookPopup = page.locator('.leaflet-popup-content').filter({ hasText: 'excessive rainfall outlook' });
    await outlookPopup.getByRole('link', { name: 'Open official WPC outlook' }).waitFor({ state: 'visible' });
    assert.match(await outlookPopup.textContent(), /Planning guidance only/);

    const gaugePopupOpened = await page.evaluate(() => {
      let opened = false;
      window._stormscope.getMap().eachLayer(layer => {
        if (opened || typeof layer.getLayers !== 'function') return;
        const child = layer.getLayers().find(item => item.feature && item.feature.properties &&
          item.feature.properties.gaugeId === 'USGS-07010000');
        if (child) { child.openPopup(); opened = true; }
      });
      return opened;
    });
    assert.equal(gaugePopupOpened, true);
    const gaugePopup = page.locator('.leaflet-popup-content').filter({ hasText: 'Mississippi River at St. Louis' });
    await gaugePopup.getByRole('link', { name: 'Open official NOAA NWPS gauge' }).waitFor({ state: 'visible' });
    assert.match(await gaugePopup.textContent(), /Observed/);
    assert.match(await gaugePopup.textContent(), /Forecast/);
    assert.match(await gaugePopup.textContent(), /Minor threshold: 30 ft/i);
    assert.match(await gaugePopup.textContent(), /Moderate/);

    const failRiverForecast = route => route.fulfill({ status: 503, body: 'fixture unavailable' });
    await page.route('**/riv_gauges/MapServer/1/query?**', failRiverForecast);
    await page.evaluate(() => window._stormscope.refreshUsgsGauges());
    await page.locator('#usgs-gauge-status').filter({ hasText: 'some official products unavailable' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => window._stormscope.getContextState().gaugeStatus === 'partial');
    assert.deepEqual(await page.evaluate(() => {
      const state = window._stormscope.getContextState();
      return { enabled: state.usgsGauges, status: state.gaugeStatus, count: state.gaugeCount };
    }), { enabled: true, status: 'partial', count: 1 });
    await page.unroute('**/riv_gauges/MapServer/1/query?**', failRiverForecast);

    await page.locator('#wpc-outlook-day').selectOption('2');
    await page.locator('#wpc-outlook-status').filter({ hasText: 'Day 2' }).waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(() => window._stormscope.getContextState())).wpcDay, 2);
    const failFlood = route => route.fulfill({ status: 503, body: 'fixture unavailable' });
    await page.route('**/outlooks/sig_riv_fld_outlk/MapServer/0/query?**', failFlood);
    await page.evaluate(() => window._stormscope.refreshWpcOutlooks());
    await page.locator('#wpc-outlook-status').filter({ hasText: 'partial' }).waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(() => window._stormscope.getContextState())).wpcOutlooks, true,
      'a failed flood feed must not remove the successful ERO layer');
    await page.unroute('**/outlooks/sig_riv_fld_outlk/MapServer/0/query?**', failFlood);
    await page.locator('#toggle-satellite').uncheck();
    await page.locator('#toggle-lightning').uncheck();
    await page.locator('#toggle-wildfires').uncheck();
    await page.locator('#toggle-tropical').uncheck();
    await page.locator('#toggle-wpc-outlooks').uncheck();
    await page.locator('#toggle-usgs-gauges').uncheck();
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
      satellite: false, lightning: false, wildfires: true, tropical: false, wpcOutlooks: false, usgsGauges: false, earthquakes: false, convective: false, fireWeather: false, satelliteStatus: 'off',
      lightningStatus: 'error', wildfireStatus: 'ready', tropicalStatus: 'off', tropicalCount: 0,
      wpcStatus: 'off', wpcCount: 0, wpcDay: 2, gaugeStatus: 'off', gaugeCount: 0,
      earthquakeStatus: 'off', earthquakeCount: 0, convectiveStatus: 'off', convectiveCount: 0, convectiveDay: 1, fireWeatherStatus: 'off', fireWeatherCount: 0, fireWeatherDay: 1, watches: false, watchStatus: 'off', watchCount: 0, satelliteZ: '315',
      localOverlays: 0, rasterZ: '325', vectorZ: '390', localOverlayZ: '380', tropicalZ: '395', warningZ: '400', cameraZ: '600'
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
    await page.locator('#alerts-status').filter({ hasText: '1 alerta' }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#alerts-panel').isHidden(), true,
      'alert re-render must not obscure the open layers panel');
    assert.equal(
      (await page.locator('.alerts-provider-note').textContent()).trim(),
      'Texto del proveedor NWS (puede permanecer en inglés)'
    );
    await page.locator('#btn-layers').click();
    await page.locator('#alerts-status').filter({ hasText: '1 alerta' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /Severe Thunderstorm Warning/ }).click();
    await page.locator('#alert-detail').waitFor({ state: 'visible' });
    assert.match(await page.locator('#alert-detail').textContent(), /Severa • Inmediata • Observada/);
    assert.match(await page.locator('#alert-detail').textContent(), /Detalles oficiales del impacto/);
    assert.match(await page.locator('#alert-detail').textContent(), /Amenaza de daños por tormenta.*DESTRUCTIVE/s);
    assert.match(await page.locator('#alert-detail').textContent(), /Ráfaga máxima de viento.*80 MPH/s);
    await page.locator('#alert-detail .alert-detail-dismiss').click();
    await page.locator('#btn-layers').click();
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
    const alertRefreshLayers = await page.evaluate(async () => {
      const group = window._stormscope.getAlertLayerGroup();
      const before = group.getLayers().length;
      await window._stormscope.refreshAlerts();
      return {
        sameGroup: group === window._stormscope.getAlertLayerGroup(),
        before: before,
        after: group.getLayers().length
      };
    });
    assert.equal(alertRefreshLayers.sameGroup, true, 'alert refresh should retain the LayerGroup instance');
    assert.equal(alertRefreshLayers.after, alertRefreshLayers.before, 'unchanged alerts should retain their map layers');
    assert.equal(await page.locator('#alert-detail').isVisible(), true, 'alert refresh should preserve open details');
    const alertCameras = page.locator('#alert-detail .incident-cameras');
    await alertCameras.locator('li').first().waitFor({ state: 'visible' });
    assert.match(await alertCameras.locator('.incident-camera-status').textContent(), /nearby camera/);
    assert.match(await alertCameras.locator('li').first().textContent(), /Verified healthy|Degraded|Unverified/);
    await alertCameras.locator('.incident-camera-map').first().click();
    assert.ok(await page.evaluate(() => window._stormscope.getMap().getZoom()) >= 12);
    await alertCameras.locator('.incident-camera-open').first().click();
    await page.locator('#camera-modal').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await alertCameras.locator('.incident-monitor-open').click();
    await page.locator('#monitor-modal').waitFor({ state: 'visible' });
    const incidentMonitorCount = await page.locator('.monitor-cell').count();
    assert.ok(incidentMonitorCount >= 2 && incidentMonitorCount <= 4);
    await page.getByRole('button', { name: 'Close multi-camera monitor' }).click();
    while (await alertCameras.getByRole('button', { name: 'Remove from monitor' }).count()) {
      await alertCameras.getByRole('button', { name: 'Remove from monitor' }).first().click();
    }
    assert.equal((await page.evaluate(() => window._stormscope.getMonitorState())).selected, 0);
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
    // Empty state: a query that matches nothing shows helpful guidance, not a blank list.
    await page.locator('#camera-query').fill('zzzznomatchxyzzz');
    await page.locator('.camera-result-empty').waitFor({ state: 'visible' });
    assert.match(await page.locator('.camera-result-empty').textContent(), /No cameras match/);
    assert.equal(await page.locator('.camera-result').count(), 0);
    await page.locator('#camera-query').fill('Alabama');
    await page.locator('.camera-result').first().waitFor({ state: 'visible' });
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
    await page.getByRole('heading', { name: 'Current observation' }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('heading', { name: 'Hourly forecast' }).count(), 1);
    assert.match(await page.locator('#weather-data').textContent(), /68°F.*Mostly Clear.*10 mph N.*Observed Test Station \(KOBS\).*2 mi away.*NWS station observation/s);
    assert.match(await page.locator('#weather-data').textContent(), /72°F.*Clear.*NWS hourly forecast/s);
    assert.match(await page.locator('#weather-data').textContent(), /Chance of precipitation \(forecast\)[\s\S]{0,80}20%/);
    assert.match(await page.locator('#weather-data').textContent(), /Next 12 h high \/ low \(forecast\)[\s\S]{0,80}72°F \/ 60°F/);
    const precipTimeline = page.locator('.weather-precipitation-timeline');
    await precipTimeline.waitFor({ state: 'visible' });
    assert.equal(await precipTimeline.locator('.weather-precip-card').count(), 12);
    assert.match(await precipTimeline.textContent(), /20%/);
    assert.match(await precipTimeline.textContent(), /0 in/);
    assert.match(await precipTimeline.textContent(), /N\/A/);
    assert.equal(await page.locator('#radar-controls .weather-precipitation-timeline').count(), 0,
      'precipitation guidance must stay outside the radar scrubber');
    assert.match(await page.locator('#weather-data').textContent(), /US AQI[\s\S]{0,120}43 \• Good/);
    assert.match(await page.locator('#weather-data').textContent(), /Primary pollutant[\s\S]{0,120}Ozone \• 66 μg\/m³ \(AQI 43\)/);
    assert.match(await page.locator('#weather-data').textContent(), /Open-Meteo Air Quality/);
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

    const failedAirQualityFixture = route => route.fulfill({ status: 503, body: 'air quality unavailable' });
    await page.route('https://air-quality-api.open-meteo.com/**', failedAirQualityFixture);
    await visibleResults.nth(observedCamera.observedIndex).locator('.camera-result-open').click();
    await page.getByText('Air quality unavailable.', { exact: true }).waitFor({ state: 'visible' });
    assert.match(await page.locator('#weather-data').textContent(), /72°F.*NWS hourly forecast/s);
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await page.unroute('https://air-quality-api.open-meteo.com/**', failedAirQualityFixture);

    const emptyStationsFixture = route => route.fulfill({
      status: 200, contentType: 'application/geo+json', body: JSON.stringify({ features: [] })
    });
    await page.route('https://api.weather.gov/fixture/stations?*', emptyStationsFixture);
    await visibleResults.nth(observedCamera.observedIndex).locator('.camera-result-open').click();
    await page.getByText('Station observation unavailable.', { exact: true }).waitFor({ state: 'visible' });
    assert.match(await page.locator('#weather-data').textContent(), /72°F.*NWS hourly forecast/s);
    assert.equal((await page.locator('#weather-data').textContent()).includes('Open-Meteo fallback'), false);
    await page.getByRole('button', { name: 'Close camera viewer' }).click();

    const failedForecastFixture = route => route.fulfill({ status: 503, body: 'forecast unavailable' });
    await page.route('https://api.weather.gov/fixture/hourly', failedForecastFixture);
    await visibleResults.nth(observedCamera.observedIndex).locator('.camera-result-open').click();
    await page.locator('#weather-data').filter({ hasText: 'Open-Meteo fallback' }).waitFor({ state: 'visible' });
    assert.match(await page.locator('#weather-data').textContent(), /22°F.*Open-Meteo fallback/s);
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await page.unroute('https://api.weather.gov/fixture/hourly', failedForecastFixture);
    await page.unroute('https://api.weather.gov/fixture/stations?*', emptyStationsFixture);
    await page.unroute(cameraImageMatch, cameraImageFixture);
    await page.locator('#camera-type').selectOption('');

    const firstFavorite = visibleResults.first().locator('.favorite-result');
    await firstFavorite.click();
    await page.locator('#camera-favorites').evaluate(element => {
      element.checked = true;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#camera-results-status').filter({ hasText: '1 result shown on map' }).waitFor({ state: 'visible' });
    await page.locator('#camera-favorites').evaluate(element => {
      element.checked = false;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
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
    assert.match(await page.locator('#camera-source-health').textContent(), /^AngelCam ingestion sources:/);
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
    assert.equal(await page.locator('#saved-views optgroup[label="Workflow presets"] option').count(), 3);
    await exerciseLayerNavigation(page, { locale: 'en', detailed: true });
    await page.locator('#radar-palette').selectOption('contrast');
    await page.locator('#radar-speed').selectOption('400');
    await page.locator('#alert-severity').selectOption('severe');
    await page.locator('#data-mode').selectOption('low');
    await page.locator('#weather-units').selectOption('metric');
    await page.locator('#wpc-outlook-day').selectOption('2');
    await page.locator('#convective-day').selectOption('3');
    await page.locator('#earthquake-magnitude').selectOption('4.5');
    await page.locator('#earthquake-period').selectOption('week');
    assert.deepEqual(await page.evaluate(() => window._stormscope.getLayerRegistryState().ids), [
      'radar', 'cameras', 'coverage', 'terminator', 'snow', 'alerts', 'lightning', 'surfaceObservations', 'wildfires', 'satellite', 'tropical',
      'wpcOutlooks', 'usgsGauges', 'earthquakes', 'convective', 'fireWeather', 'watches', 'mesoscale', 'stormReports'
    ]);
    await page.locator('#camera-favorites').evaluate(element => {
      element.checked = true;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#view-name').fill('Smoke view');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#saved-state-status').filter({ hasText: 'View saved locally.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    await page.locator('#saved-views').selectOption({ label: 'Smoke view' });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const savedViewUndo = page.locator('#saved-state-status .recovery-action');
    await savedViewUndo.waitFor({ state: 'visible' });
    assert.match(await page.locator('#saved-state-status').textContent(), /Deleted “Smoke view”\. Undo for 10 seconds\./);
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 0);
    await savedViewUndo.focus();
    await page.keyboard.press('Enter');
    await page.locator('#saved-state-status').filter({ hasText: 'Restored “Smoke view”.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    await page.locator('#data-mode').selectOption('standard');
    await page.locator('#radar-palette').selectOption('standard');
    await page.locator('#radar-speed').selectOption('800');
    await page.locator('#alert-severity').selectOption('all');
    await page.locator('#weather-units').selectOption('us');
    await page.locator('#wpc-outlook-day').selectOption('1');
    await page.locator('#convective-day').selectOption('1');
    await page.locator('#earthquake-magnitude').selectOption('2.5');
    await page.locator('#earthquake-period').selectOption('day');
    await page.locator('#camera-favorites').evaluate(element => {
      element.checked = false;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#saved-views').selectOption({ label: 'Smoke view' });
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    assert.equal(await page.locator('#data-mode').inputValue(), 'low');
    assert.equal(await page.locator('#radar-palette').inputValue(), 'contrast');
    assert.equal(await page.locator('#radar-speed').inputValue(), '0');
    assert.equal(await page.locator('#alert-severity').inputValue(), 'severe');
    assert.equal(await page.locator('#weather-units').inputValue(), 'metric');
    assert.equal(await page.locator('#camera-favorites').isChecked(), true);
    assert.equal(await page.locator('#wpc-outlook-day').inputValue(), '2');
    assert.equal(await page.locator('#convective-day').inputValue(), '3');
    assert.equal(await page.locator('#earthquake-magnitude').inputValue(), '4.5');
    assert.equal(await page.locator('#earthquake-period').inputValue(), 'week');
    await page.locator('#data-mode').selectOption('standard');
    assert.equal(await page.locator('#radar-speed').inputValue(), '400');
    await page.locator('#data-mode').selectOption('auto');
    await page.locator('#weather-units').selectOption('us');
    await page.locator('#camera-favorites').evaluate(element => {
      element.checked = false;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const savedStateBeforeImport = await page.evaluate(() => localStorage.getItem('stormscope.saved-state'));
    const savedStateContentsBeforeImport = JSON.parse(savedStateBeforeImport);
    delete savedStateContentsBeforeImport.updatedAt;
    const importedState = JSON.parse(savedStateBeforeImport);
    importedState.views = [Object.assign({}, importedState.views[0], {
      id: 'imported-view',
      name: 'Imported view'
    })];
    importedState.updatedAt = '2026-07-14T12:00:00.000Z';
    await page.locator('#import-state-file').setInputFiles({
      name: 'stormscope-saved-state.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(importedState), 'utf8')
    });
    const importUndo = page.locator('#saved-state-status .recovery-action');
    await importUndo.waitFor({ state: 'visible' });
    assert.match(await page.locator('#saved-state-status').textContent(), /Saved state imported\. Undo for 12 seconds\./);
    assert.equal(await page.locator('#saved-views option', { hasText: 'Imported view' }).count(), 1);
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 0);
    await importUndo.focus();
    await page.keyboard.press('Enter');
    await page.locator('#saved-state-status').filter({ hasText: 'Previous saved state restored.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#saved-views option', { hasText: 'Imported view' }).count(), 0);
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    assert.deepEqual(await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('stormscope.saved-state'));
      delete state.updatedAt;
      return state;
    }), savedStateContentsBeforeImport);

    const invalidImportedState = JSON.parse(savedStateBeforeImport);
    invalidImportedState.views[0].snapshot.zoom = String(invalidImportedState.views[0].snapshot.zoom);
    await page.locator('#import-state-file').setInputFiles({
      name: 'invalid-saved-state.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(invalidImportedState), 'utf8')
    });
    await page.locator('#saved-state-status').filter({ hasText: 'Import rejected because the file is invalid.' })
      .waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('stormscope.saved-state'));
      delete state.updatedAt;
      return state;
    }), savedStateContentsBeforeImport);
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);

    await page.locator('#import-state-file').setInputFiles({
      name: 'oversized-saved-state.json',
      mimeType: 'application/json',
      buffer: Buffer.alloc((5 * 1024 * 1024) + 1, 0x20)
    });
    await page.locator('#saved-state-status').filter({ hasText: 'Import rejected because the file exceeds 5 MiB.' }).waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('stormscope.saved-state'));
      delete state.updatedAt;
      return state;
    }), savedStateContentsBeforeImport);

    await page.locator('#import-state-file').setInputFiles({
      name: 'invalid-utf8-saved-state.json',
      mimeType: 'application/json',
      buffer: Buffer.from([0xc3, 0x28])
    });
    await page.locator('#saved-state-status').filter({ hasText: 'Import rejected because the file is not valid UTF-8.' }).waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('stormscope.saved-state'));
      delete state.updatedAt;
      return state;
    }), savedStateContentsBeforeImport);

    const presetMap = await page.evaluate(() => {
      const map = window._stormscope.getMap();
      return { center: map.getCenter(), zoom: map.getZoom() };
    });
    await page.locator('#saved-views').selectOption('preset:severe');
    assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    assert.equal(await page.locator('#radar-palette').inputValue(), 'colorblind');
    assert.equal(await page.locator('#alert-severity').inputValue(), 'severe');
    assert.equal(await page.locator('#toggle-coverage').isChecked(), true);
    assert.equal(await page.locator('#toggle-lightning').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => {
      const map = window._stormscope.getMap();
      return { center: map.getCenter(), zoom: map.getZoom() };
    }), presetMap);
    await page.locator('#toggle-lightning').uncheck();
    await page.locator('#toggle-coverage').evaluate(element => {
      element.checked = false;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();

    const sceneFixture = await page.evaluate(() => {
      const camera = window._stormscope.getCameraResults()[0];
      return { cameraId: String(camera.id), cameraName: camera.name, frameTime: window._stormscope.getRadarFrameTime() };
    });
    const sharedScene = {
      map: { lat: 39.75, lon: -98.25, zoom: 6 },
      layers: { radar: true, cameras: true, coverage: false, terminator: false, snow: false, surfaceObservations: false, alerts: true, lightning: false, wildfires: false, satellite: false, tropical: false,
        wpcOutlooks: false, usgsGauges: false, earthquakes: false, convective: false, fireWeather: false, watches: false, mesoscale: false, stormReports: false },
      radar: { opacity: 0.48, palette: 'contrast', speed: 400, frameTime: sceneFixture.frameTime },
      alertSeverity: 'severe',
      cameraFilters: {
        query: sceneFixture.cameraName, state: '', source: '', type: '', sort: 'distance', healthy: false
      },
      activeCameraId: sceneFixture.cameraId,
      outlookDay: 3,
      convectiveDay: 2, fireWeatherDay: 4,
      earthquake: { magnitude: '4.5', period: 'week' }
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
    assert.equal(restoredScene.scene.outlookDay, sharedScene.outlookDay);
    assert.equal(restoredScene.scene.convectiveDay, sharedScene.convectiveDay);
    assert.equal(restoredScene.scene.fireWeatherDay, sharedScene.fireWeatherDay);
    assert.deepEqual(restoredScene.scene.earthquake, sharedScene.earthquake);
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

    const wakePage = await context.newPage();
    wakePage.baseURL = baseURL;
    await wakePage.addInitScript(() => {
      window.__wakeLockRequests = 0;
      window.__wakeLockReleases = 0;
      window.__wakeVisibility = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get() { return window.__wakeVisibility; }
      });
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request(type) {
            if (type !== 'screen') return Promise.reject(new Error('unexpected lock type'));
            window.__wakeLockRequests += 1;
            const listeners = new Map();
            let released = false;
            return Promise.resolve({
              addEventListener(name, listener) { listeners.set(name, listener); },
              release() {
                if (released) return Promise.resolve();
                released = true;
                window.__wakeLockReleases += 1;
                if (listeners.has('release')) listeners.get('release')();
                return Promise.resolve();
              }
            });
          }
        }
      });
    });
    await addNetworkFixtures(wakePage);
    await waitForApp(wakePage);
    if (await wakePage.locator('#radar-play').getAttribute('aria-pressed') === 'true') {
      await wakePage.locator('#radar-play').click();
    }
    await wakePage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await wakePage.locator('#wake-lock-monitoring').check();
    await wakePage.waitForFunction(() => window._stormscope.getWakeLockState().state === 'ready');
    assert.equal(await wakePage.evaluate(() => window.__wakeLockRequests), 0, 'opt-in alone must not request a lock');
    await wakePage.locator('#open-comparison').click();
    await wakePage.locator('#comparison-modal').waitFor({ state: 'visible' });
    await wakePage.waitForFunction(() => window._stormscope.getWakeLockState().state === 'active');
    assert.equal(await wakePage.evaluate(() => window.__wakeLockRequests), 1);
    await wakePage.evaluate(() => {
      window.__wakeVisibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wakePage.waitForFunction(() => window._stormscope.getWakeLockState().state === 'suspended');
    assert.equal(await wakePage.evaluate(() => window.__wakeLockReleases), 1);
    await wakePage.evaluate(() => {
      window.__wakeVisibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wakePage.waitForFunction(() => window._stormscope.getWakeLockState().state === 'active');
    assert.equal(await wakePage.evaluate(() => window.__wakeLockRequests), 2);
    await wakePage.getByRole('button', { name: 'Close map comparison' }).click();
    await wakePage.waitForFunction(() => window._stormscope.getWakeLockState().state === 'ready');
    assert.equal(await wakePage.evaluate(() => window.__wakeLockReleases), 2);
    await wakePage.close();

    const navigationPreloadState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.navigationPreload ? registration.navigationPreload.getState() : null;
    });
    if (navigationPreloadState) assert.equal(navigationPreloadState.enabled, true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#camera-count').filter({ hasText: '36,592 indexed' }).waitFor({ state: 'visible' });
    const onlineGeneration = await page.evaluate(() => window._stormscope.getCameraLoadMetrics().index.generated_at);
    assert.match(onlineGeneration, /^2026-07-12T/);
    assert.equal(await page.locator('#saved-views option', { hasText: 'Smoke view' }).count(), 1);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const shareTargetResult = await page.evaluate(async () => {
      const form = new FormData();
      const gpx = '<?xml version="1.0"?><gpx version="1.1"><wpt lat="38" lon="-90"><name>Shared point</name></wpt></gpx>';
      form.append('file', new File([gpx], 'shared-track.gpx', { type: 'application/gpx+xml' }), 'shared-track.gpx');
      const response = await fetch(new URL('share-target', location.href), { method: 'POST', body: form });
      return { status: response.status, url: response.url };
    });
    assert.equal(shareTargetResult.status, 200, 'share target should redirect back to the app');
    assert.match(shareTargetResult.url, /[?&]share_target=[A-Za-z0-9_-]{8,80}/);
    await page.goto(shareTargetResult.url, { waitUntil: 'domcontentloaded' });
    await page.locator('#camera-count').filter({ hasText: '36,592 indexed' }).waitFor({ state: 'visible' });
    if (await page.getByRole('button', { name: 'Toggle layers panel' }).getAttribute('aria-expanded') !== 'true') {
      await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    }
    await page.locator('#local-overlay-status').filter({ hasText: 'Received shared “shared-track” with 1 feature' })
      .waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 1);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#clear-local-overlays').click();
    await page.locator('.local-overlay-empty').waitFor({ state: 'visible' });

    if (await page.getByRole('button', { name: 'Toggle layers panel' }).getAttribute('aria-expanded') === 'true') {
      await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    }
    const unsupportedShareResult = await page.evaluate(async () => {
      const form = new FormData();
      form.append('file', new File(['not an overlay'], 'notes.txt', { type: 'text/plain' }), 'notes.txt');
      const response = await fetch(new URL('share-target', location.href), { method: 'POST', body: form });
      return { status: response.status, url: response.url };
    });
    assert.equal(unsupportedShareResult.status, 200);
    assert.match(unsupportedShareResult.url, /[?&]share_target_error=unsupported/);
    await page.goto(unsupportedShareResult.url, { waitUntil: 'domcontentloaded' });
    await page.locator('#camera-count').filter({ hasText: '36,592 indexed' }).waitFor({ state: 'visible' });
    if (await page.getByRole('button', { name: 'Toggle layers panel' }).getAttribute('aria-expanded') !== 'true') {
      await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    }
    await page.locator('#local-overlay-status').filter({ hasText: 'Shared file rejected: choose a GPX or GeoJSON file.' })
      .waitFor({ state: 'visible' });
    assert.equal(await page.locator('.local-overlay-item').count(), 0);
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.waitForFunction(async () => {
      const cache = await caches.open('stormscope-data-v2');
      const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
      return keys.includes('/data/cameras.index.json') &&
        keys.filter((pathname) => pathname.includes('/data/camera-shards/')).length === 49;
    });
    await page.waitForFunction(async () => {
      const expected = window._stormscope.getCameraLoadMetrics().index.dataset_sha256;
      const cache = await caches.open('stormscope-data-v2');
      const marker = await cache.match(location.origin + '/__stormscope-camera-generations__');
      return marker && (await marker.json()).completed.includes(expected);
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
    assert.equal(await page.locator('#install-app').isHidden(), true);
    assert.equal(await page.evaluate(() => {
      window.__installPromptCalls = 0;
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.defineProperties(event, {
        prompt: { value: () => { window.__installPromptCalls += 1; return Promise.resolve(); } },
        userChoice: { value: Promise.resolve({ outcome: 'accepted' }) }
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), true);
    await page.getByRole('button', { name: 'Install StormScope' }).click();
    await page.locator('#install-status').filter({ hasText: 'Installation started.' }).waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__installPromptCalls), 1);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.locator('#install-status').filter({ hasText: 'StormScope is installed.' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#install-app').isHidden(), true);
    await page.locator('#cache-status').filter({ hasText: '25%' }).waitFor({ state: 'visible' });
    assert.match(await page.locator('#cache-status').textContent(), /best effort/);
    await page.getByRole('button', { name: 'Keep offline data' }).click();
    await page.locator('#cache-status').filter({ hasText: 'offline data will be kept' }).waitFor({ state: 'visible' });
    assert.match(await page.locator('#cache-status').textContent(), /persistent/);
    assert.equal(await page.evaluate(() => window.__persistCalls), 1);
    assert.equal(await page.getByRole('button', { name: 'Keep offline data' }).isDisabled(), true);
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
    assert.equal(diagnosticsReport.camera_ingestion.available, true);
    assert.equal(diagnosticsReport.camera_ingestion.providers.length, 78);
    assert.equal(diagnosticsReport.startup.navigation.available, true);
    assert.ok(diagnosticsReport.startup.navigation.response_start_ms >= 0);
    assert.ok(diagnosticsReport.startup.camera.first_batch_ms >= 0);
    assert.ok(diagnosticsReport.startup.camera.complete_ms >= diagnosticsReport.startup.camera.first_batch_ms);
    assert.match(diagnosticsReport.startup.camera.source, /^(?:shards|monolith)$/);
    assert.match(diagnosticsReport.startup.data_mode.preference, /^(?:auto|standard|low)$/);
    assert.equal(diagnosticsReport.startup.service_worker.supported, true);
    assert.equal(diagnosticsReport.startup.service_worker.controlled, true);
    assert.equal(diagnosticsReport.startup.service_worker.navigation_preload.supported, true);
    assert.equal(diagnosticsReport.startup.service_worker.navigation_preload.enabled, true);
    assert.ok(Number.isInteger(diagnosticsReport.dropped_entries.errors));
    assert.ok(Number.isInteger(diagnosticsReport.dropped_entries.navigation));
    assert.ok(Number.isInteger(diagnosticsReport.dropped_entries.camera_ingestion_providers));
    assert.match(serializedDiagnostics, /\[url\]/);
    assert.doesNotMatch(serializedDiagnostics, /camera\.example|token=secret|40\.12345|-75\.98765/);
    assert.equal(Object.hasOwn(diagnosticsReport, 'favorites'), false);
    assert.equal(Object.hasOwn(diagnosticsReport, 'savedViews'), false);
    const expectedDiagnosticError = errors.findIndex(message => message.includes('camera.example/private'));
    assert.ok(expectedDiagnosticError >= 0, 'the injected runtime failure must reach the page error channel');
    errors.splice(expectedDiagnosticError, 1);

    if (await page.locator('#layers-panel').isHidden()) {
      await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    }
    const comparisonHeapBefore = await collectJsHeap(page);
    await page.locator('#open-comparison').click();
    await page.locator('#comparison-modal').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#comparison-modal .leaflet-container').length === 2);
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('[data-comparison-status]'))
      .some((element) => /Loading comparison/.test(element.textContent)));
    const comparisonMaps = await page.locator('.comparison-map').evaluateAll((elements) => elements.map((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height
    })));
    assert.ok(comparisonMaps.every((bounds) => bounds.width >= 400 && bounds.height >= 220));
    await page.locator('[data-comparison-source="right"]').selectOption('radar');
    await page.locator('[data-comparison-time="right"]').evaluate((element) => {
      element.value = '0';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.notEqual(
      await page.locator('[data-comparison-time="left"]').inputValue(),
      await page.locator('[data-comparison-time="right"]').inputValue(),
      'comparison panes must retain independent radar frame selections'
    );
    await page.evaluate(async () => {
      for (let index = 0; index < 30; index += 1) {
        window._stormscope.setComparisonView('left', [38 + index * 0.01, -98 - index * 0.01], 5 + index % 2);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    const comparisonState = await page.evaluate(() => window._stormscope.getComparisonState());
    assert.equal(comparisonState.paneCount, 2);
    assert.ok(comparisonState.syncSamples >= 30);
    assert.ok(comparisonState.syncP95Ms <= comparisonState.desktopSyncBudgetMs,
      `comparison sync p95 exceeded desktop budget: ${JSON.stringify(comparisonState)}`);
    assert.ok(comparisonState.estimatedDecodedBytes <= comparisonState.maxEstimatedMemoryBytes);
    assert.ok(comparisonState.requestBudget.used <= comparisonState.requestBudget.limit);
    const comparisonHeapAfter = await collectJsHeap(page);
    assert.ok(comparisonHeapAfter - comparisonHeapBefore <= 32 * 1024 * 1024,
      `comparison desktop JS heap delta exceeded 32 MiB: ${comparisonHeapAfter - comparisonHeapBefore}`);
    await page.locator('[data-comparison-source="left"]').selectOption('hazards');
    await page.locator('[data-comparison-source="right"]').selectOption('hazards');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-comparison-status]'))
      .every((element) => /NWS hazard/.test(element.textContent)));
    const hazardRequestCount = networkMetrics.rainViewerRequests;
    await page.evaluate(() => window._stormscope.setComparisonView('left', [40, -97], 6));
    await page.waitForTimeout(300);
    assert.equal(networkMetrics.rainViewerRequests, hazardRequestCount, 'hazard/hazard comparison must add no radar requests');
    await page.locator('[data-comparison-close]').click();
    await page.locator('#comparison-modal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#comparison-modal .leaflet-container').count(), 0);
    assert.equal(await page.locator('.leaflet-container').count(), 1, 'comparison close must retain only the main map');

    const lowDataContext = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await lowDataContext.addInitScript(() => {
      const connection = new EventTarget();
      Object.defineProperty(connection, 'saveData', { value: true, configurable: true });
      Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
    });
    const lowDataPage = await lowDataContext.newPage();
    lowDataPage.baseURL = baseURL;
    let lowDataShardRequests = 0;
    lowDataPage.on('request', request => {
      if (request.url().includes('/data/camera-shards/')) lowDataShardRequests += 1;
    });
    await addNetworkFixtures(lowDataPage);
    await lowDataPage.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await lowDataPage.locator('#camera-count').filter({ hasText: '36,592 cameras available' }).waitFor({ state: 'visible' });
    await lowDataPage.waitForFunction(() => /RainViewer|NOAA\/NWS MRMS/.test(document.querySelector('#radar-meta').textContent));
    assert.deepEqual(await lowDataPage.evaluate(() => window._stormscope.getLowDataState()), {
      preference: 'auto', enabled: true, source: 'save-data', imageRefreshMs: 60000, cameraCatalogDeferred: true
    });
    assert.equal(await lowDataPage.locator('#radar-speed').inputValue(), '0');
    assert.equal((await lowDataPage.evaluate(() => window._stormscope.getRadarPreloadState())).status, 'suppressed-low-data');
    assert.equal(lowDataShardRequests, 0, 'Save-Data startup must fetch only the camera manifest');
    await lowDataPage.getByRole('button', { name: 'Find cameras' }).click();
    await lowDataPage.getByRole('button', { name: 'Load camera catalog' }).click();
    await lowDataPage.locator('#camera-count').filter({ hasText: '36,592 indexed' }).waitFor({ state: 'visible' });
    assert.equal(lowDataShardRequests, 49);
    await lowDataPage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await lowDataPage.locator('#open-comparison').click();
    await lowDataPage.locator('#comparison-modal').waitFor({ state: 'visible' });
    await lowDataPage.locator('[data-comparison-status="right"]')
      .filter({ hasText: 'Paused by low-data mode' }).waitFor({ state: 'visible' });
    const lowComparisonState = await lowDataPage.evaluate(() => window._stormscope.getComparisonState());
    assert.equal(lowComparisonState.paneCount, 2);
    assert.ok(lowComparisonState.requestBudget.used <= lowComparisonState.requestBudget.limit);
    await lowDataPage.evaluate(() => window._stormscope.setComparisonDocumentHidden(true));
    await lowDataPage.locator('#comparison-modal').waitFor({ state: 'hidden' });
    assert.equal((await lowDataPage.evaluate(() => window._stormscope.getComparisonState())).active, false);
    await lowDataPage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await lowDataPage.locator('#data-mode').selectOption('standard');
    await lowDataPage.reload({ waitUntil: 'domcontentloaded' });
    await lowDataPage.locator('#camera-count').filter({ hasText: '36,592 indexed' }).waitFor({ state: 'visible' });
    assert.deepEqual(await lowDataPage.evaluate(() => window._stormscope.getLowDataState()), {
      preference: 'standard', enabled: false, source: 'standard', imageRefreshMs: 15000, cameraCatalogDeferred: false
    });
    await lowDataContext.close();

    const iosContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'
    });
    await iosContext.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    });
    const iosPage = await iosContext.newPage();
    iosPage.baseURL = baseURL;
    await addNetworkFixtures(iosPage);
    await iosPage.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await iosPage.getByRole('heading', { name: 'StormScope' }).waitFor({ state: 'visible' });
    await iosPage.getByRole('button', { name: 'Toggle layers panel' }).click();
    await iosPage.locator('#install-status').filter({ hasText: 'In Safari, use Share, then Add to Home Screen.' })
      .waitFor({ state: 'visible' });
    assert.equal(await iosPage.locator('#install-app').isHidden(), true);
    await iosContext.close();

    const narrowContext = await browser.newContext({
      viewport: { width: 390, height: 568 },
      serviceWorkers: 'block'
    });
    for (const width of [320, 360, 390]) {
      const narrow = await narrowContext.newPage();
      narrow.baseURL = baseURL;
      await narrow.setViewportSize({ width, height: 568 });
      await addNetworkFixtures(narrow);
      await waitForApp(narrow, false);
      for (const offline of [false, true]) {
        for (const locale of ['en', 'es']) {
          for (const theme of ['dark', 'light']) {
            await exerciseNarrowPanelState(narrow, { width, locale, theme, offline });
          }
        }
      }
      await narrowContext.setOffline(false);
      await narrow.close();
    }
    const pseudoPage = await narrowContext.newPage();
    pseudoPage.baseURL = baseURL;
    await pseudoPage.setViewportSize({ width: 320, height: 568 });
    await addNetworkFixtures(pseudoPage);
    await waitForApp(pseudoPage, false);
    await pseudoPage.getByRole('button', { name: /Toggle layers panel|Mostrar panel de capas/ }).click();
    await pseudoPage.locator('#layers-panel').waitFor({ state: 'visible' });
    await exercisePseudoLocale(pseudoPage);
    await pseudoPage.close();
    await narrowContext.close();

    const mobile = await context.newPage();
    mobile.baseURL = baseURL;
    await mobile.setViewportSize({ width: 390, height: 844 });
    await addNetworkFixtures(mobile);
    await waitForApp(mobile, false);
    assert.equal(await mobile.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
    await mobile.getByRole('button', { name: 'Toggle layers panel' }).click();
    assert.equal(await mobile.getByRole('button', { name: 'Toggle layers panel' }).getAttribute('aria-expanded'), 'true');
    await mobile.getByRole('region', { name: 'Map layers' }).waitFor({ state: 'visible' });
    await mobile.getByRole('button', { name: 'Open situation summary' }).click();
    await mobile.locator('#situation-panel').waitFor({ state: 'visible' });
    await assertSurfaceWithinViewport(mobile, '#situation-panel', 'mobile situation summary');
    await mobile.locator('#close-summary').click();
    if (await mobile.locator('#layers-panel').isHidden()) {
      await mobile.getByRole('button', { name: 'Toggle layers panel' }).click();
    }
    const mobileHeapBefore = await collectJsHeap(mobile);
    await mobile.locator('#open-comparison').click();
    await mobile.locator('#comparison-modal').waitFor({ state: 'visible' });
    await mobile.waitForFunction(() => document.querySelectorAll('#comparison-modal .leaflet-container').length === 2);
    const mobileComparisonBounds = await mobile.locator('.comparison-map').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    assert.ok(mobileComparisonBounds.every((bounds) => bounds.width >= 340 && bounds.height >= 240));
    assert.equal(await mobile.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
    await mobile.evaluate(() => window._stormscope.setComparisonView('left', [39, -96], 6));
    await mobile.waitForTimeout(100);
    const mobileComparisonState = await mobile.evaluate(() => window._stormscope.getComparisonState());
    assert.ok(mobileComparisonState.syncP95Ms <= mobileComparisonState.mobileSyncBudgetMs);
    assert.ok(mobileComparisonState.estimatedDecodedBytes <= mobileComparisonState.maxEstimatedMemoryBytes);
    const mobileHeapAfter = await collectJsHeap(mobile);
    assert.ok(mobileHeapAfter - mobileHeapBefore <= 24 * 1024 * 1024,
      `comparison mobile JS heap delta exceeded 24 MiB: ${mobileHeapAfter - mobileHeapBefore}`);
    await mobile.locator('[data-comparison-close]').click();

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

    const customRadarContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block'
    });
    const customRadarPage = await customRadarContext.newPage();
    customRadarPage.baseURL = baseURL;
    customRadarPage.on('pageerror', (error) => errors.push(error.message));
    await addNetworkFixtures(customRadarPage, {}, { customRadar: true });
    await waitForApp(customRadarPage, false);
    await customRadarPage.waitForFunction(() => /Fixture Radar/.test(document.querySelector('#radar-meta').textContent));
    assert.equal(await customRadarPage.locator('#radar-source').textContent(), 'Fixture Radar');
    assert.match(await customRadarPage.locator('#radar-meta').textContent(), /Configured tile pyramid through zoom 8/);
    assert.equal(await customRadarPage.evaluate(() => window.StormScopeRadarProviders.primaryProviderId), 'build-radar');
    await customRadarContext.close();

    const ridgeFallbackContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block'
    });
    const ridgeFallbackPage = await ridgeFallbackContext.newPage();
    ridgeFallbackPage.baseURL = baseURL;
    ridgeFallbackPage.on('pageerror', (error) => errors.push(error.message));
    await addNetworkFixtures(ridgeFallbackPage, {}, { ridgeFallback: true });
    await waitForApp(ridgeFallbackPage, false);
    await ridgeFallbackPage.waitForFunction(() => /NOAA\/NWS RIDGE/.test(document.querySelector('#radar-meta').textContent));
    assert.equal(await ridgeFallbackPage.locator('#radar-source').textContent(), 'NOAA/NWS RIDGE');
    assert.match(await ridgeFallbackPage.locator('#radar-meta').textContent(), /Quality-controlled 1 km CONUS composite/);
    assert.match(await ridgeFallbackPage.locator('#radar-frame-position').textContent(), /Frame 2 of 2/);
    await ridgeFallbackContext.close();

    assert.deepEqual(errors, []);
    console.log('Headless desktop/mobile/modal/offline/cache/accessibility smoke passed.');
  } catch (error) {
    await writeFailureArtifacts(context, 'chromium', error);
    throw error;
  } finally {
    await context.setOffline(false).catch(() => {});
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { addNetworkFixtures, serveStatic, waitForApp, writeFailureArtifacts };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
