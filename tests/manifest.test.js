'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sceneCodec = require('../js/scene-codec.js');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function pngSize(filename) {
  const data = fs.readFileSync(path.join(root, filename));
  assert.equal(data.subarray(1, 4).toString(), 'PNG');
  return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`;
}

test('manifest has stable identity and exact wide and narrow screenshots', () => {
  assert.equal(manifest.id, './index.html');
  assert.equal(manifest.start_url, './index.html');
  assert.deepEqual(manifest.screenshots.map(item => item.form_factor), ['wide', 'narrow']);
  manifest.screenshots.forEach(item => {
    assert.equal(pngSize(item.src), item.sizes);
    assert.equal(item.type, 'image/png');
  });
});

test('manifest shortcuts are bounded valid public scenes with existing icons', () => {
  assert.equal(manifest.shortcuts.length, 2);
  const scenes = manifest.shortcuts.map(shortcut => {
    const url = new URL(shortcut.url, 'https://stormscope.example/');
    shortcut.icons.forEach(icon => assert.ok(fs.existsSync(path.join(root, icon.src))));
    return sceneCodec.fromHash(url.hash);
  });
  assert.deepEqual(scenes[0].layers, {
    radar: true, cameras: true, coverage: false, alerts: true, lightning: false, wildfires: false, satellite: false, tropical: false,
    wpcOutlooks: false, usgsGauges: false, earthquakes: false, convective: false
  });
  assert.equal(scenes[0].alertSeverity, 'severe');
  assert.equal(scenes[0].cameraFilters.healthy, true);
  assert.deepEqual(scenes[1].map, { lat: 35.5, lon: -92.5, zoom: 6 });
  assert.equal(scenes[1].layers.wildfires, true);
  assert.equal(scenes[1].alertSeverity, 'moderate');
});
