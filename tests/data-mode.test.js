'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const dataMode = require('../js/data-mode.js');

test('automatic mode follows Save-Data and works without Network Information', () => {
  assert.deepEqual(dataMode.resolve('auto', { saveData: true }), {
    preference: 'auto', lowData: true, source: 'save-data', radarAutoplay: false,
    radarPreload: false, imageRefreshMs: 60000, deferCameraCatalog: true
  });
  assert.equal(dataMode.resolve('auto').lowData, false);
});

test('manual Standard and Low override the browser preference', () => {
  assert.equal(dataMode.resolve('standard', { saveData: true }).lowData, false);
  assert.equal(dataMode.resolve('standard', { saveData: true }).source, 'standard');
  assert.equal(dataMode.resolve('low', { saveData: false }).lowData, true);
  assert.equal(dataMode.resolve('low', { saveData: false }).source, 'manual');
  assert.equal(dataMode.normalize('invalid'), 'auto');
});
