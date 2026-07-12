'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { firefox, webkit } = require('@playwright/test');
const { addNetworkFixtures, serveStatic, waitForApp } = require('./browser-smoke.js');

async function exercise(name, engine, baseURL) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 } });
  const page = await context.newPage();
  page.baseURL = baseURL;
  try {
    if (name === 'webkit') {
      await page.addInitScript(() => {
        const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (type) {
          if (type === 'application/vnd.apple.mpegurl') return 'maybe';
          return nativeCanPlayType.call(this, type);
        };
      });
    }
    await addNetworkFixtures(page);
    await waitForApp(page, false);
    await page.getByRole('button', { name: 'Find cameras' }).click();
    await page.locator('#camera-query').fill('Alabama');
    await page.locator('#camera-results-status').filter({ hasText: /results? shown on map/ }).waitFor({ state: 'visible' });
    await page.locator('.camera-result-open').first().click();
    await page.locator('#camera-modal').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Close camera viewer' }).click();
    await page.locator('#camera-modal').waitFor({ state: 'hidden' });

    const hls = await page.evaluate(() => {
      const video = document.createElement('video');
      return {
        native: video.canPlayType('application/vnd.apple.mpegurl'),
        hlsJs: typeof Hls !== 'undefined' && Hls.isSupported()
      };
    });
    if (name === 'webkit') assert.ok(hls.native, 'WebKit must exercise native HLS capability');
    else assert.equal(hls.hlsJs, true, 'Firefox must exercise HLS.js/MSE capability');

    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
    await context.setOffline(true);
    const offlineShell = await page.evaluate(async () => {
      const response = await caches.match('./index.html');
      if (!response) return { ok: false, body: '' };
      return { ok: response.ok, body: await response.text() };
    });
    assert.equal(offlineShell.ok, true);
    assert.match(offlineShell.body, /<title>StormScope/);
  } finally {
    await context.setOffline(false).catch(() => {});
    await browser.close();
  }
}

async function main() {
  const server = http.createServer(serveStatic);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/`;
  try {
    await exercise('firefox', firefox, baseURL);
    await exercise('webkit', webkit, baseURL);
    console.log('Reduced Firefox/WebKit boot/search/modal/HLS/offline contracts passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
