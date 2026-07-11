'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
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
          radar: { past: [{ time: Math.floor(Date.now() / 1000) - 300, path: '/v2/radar/fixture' }], nowcast: [] }
        })
      });
      return;
    }
    if (url.includes('tilecache.rainviewer.com') || url.includes('basemaps.cartocdn.com')) {
      await route.fulfill({ contentType: 'image/png', body: pixel });
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
  await page.locator('#camera-count').filter({ hasText: '24,204 cameras' }).waitFor({ state: 'visible' });
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

    assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth), false);
    assert.equal(await page.locator('#radar-retry').isHidden(), true);
    const unnamedButtons = await page.locator('button').evaluateAll((buttons) => buttons.filter((button) => {
      return !(button.getAttribute('aria-label') || button.textContent.trim() || button.title);
    }).length);
    assert.equal(unnamedButtons, 0, 'all buttons must have accessible names');

    await page.locator('#alerts-status').filter({ hasText: '1 alert' }).waitFor({ state: 'visible' });
    const alertButton = page.getByRole('button', { name: /Severe Thunderstorm Warning/ });
    await alertButton.click();
    await page.locator('#alert-detail').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.locator('#toggle-alerts').uncheck();
    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    await page.evaluate(() => window._stormscope.getMap().setView([39.5, -98.5], 5));
    await page.waitForTimeout(100);

    const cameraMarkers = page.locator('.leaflet-marker-icon:has(.camera-marker)');
    const markerIndex = await cameraMarkers.evaluateAll((markers) => markers.findIndex((marker) => {
      const box = marker.getBoundingClientRect();
      return box.x >= 0 && box.y >= 80 && box.right <= innerWidth && box.bottom <= innerHeight - 60;
    }));
    assert.notEqual(markerIndex, -1, 'a visible camera marker should be available');
    await cameraMarkers.nth(markerIndex).click();
    await page.locator('#camera-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#camera-modal').getAttribute('role'), 'dialog');
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await page.locator('#camera-modal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#modal-feed video, #modal-feed iframe, #modal-feed img').count(), 0);

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#camera-count').filter({ hasText: '24,204 cameras' }).waitFor({ state: 'visible' });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'StormScope' }).waitFor({ state: 'visible' });
    await page.locator('#camera-count').filter({ hasText: '24,204 cameras' }).waitFor({ state: 'visible' });
    await context.setOffline(false);

    await page.getByRole('button', { name: 'Toggle layers panel' }).click();
    const clearCache = page.getByRole('button', { name: 'Clear cached data' });
    await clearCache.waitFor({ state: 'visible' });
    await clearCache.click();
    await page.locator('#cache-status').filter({ hasText: 'Offline cache:' }).waitFor({ state: 'visible' });
    const cacheNames = await page.evaluate(() => caches.keys());
    assert.ok(cacheNames.some((name) => name.startsWith('stormscope-shell-')));
    assert.ok(!cacheNames.some((name) => name.startsWith('stormscope-data-')));

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
