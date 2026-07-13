'use strict';

const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { addNetworkFixtures, serveStatic, waitForApp } = require('../tests/browser-smoke.js');

async function capture(browser, baseURL, filename, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.baseURL = baseURL;
  await page.addInitScript(() => localStorage.setItem('stormscope-theme', 'dark'));
  await addNetworkFixtures(page, null, { realBasemap: true, transparentRadar: true });
  await waitForApp(page);
  await page.evaluate(() => {
    const toggle = document.getElementById('toggle-radar');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('.leaflet-tile-loaded').first().waitFor({ state: 'attached', timeout: 10000 });
  await page.screenshot({ path: path.join(__dirname, '..', 'assets', filename), animations: 'disabled' });
  await context.close();
}

async function main() {
  const server = http.createServer(serveStatic);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    await capture(browser, baseURL, 'screenshot-wide.png', { width: 1280, height: 720 });
    await capture(browser, baseURL, 'screenshot-narrow.png', { width: 390, height: 844 });
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Captured manifest screenshots at 1280x720 and 390x844.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
