const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const registry = require('../js/layer-registry.js');
const i18n = require('../js/i18n.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'layer-registry.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const EXPECTED_IDS = [
  'radar', 'cameras', 'coverage', 'terminator', 'snow', 'alerts', 'lightning', 'surfaceObservations', 'wildfires', 'satellite', 'spaceWeather', 'marineBuoys', 'tropical',
  'wpcOutlooks', 'wssi', 'cpcOutlooks', 'usgsGauges', 'earthquakes', 'convective', 'fireWeather', 'watches', 'mesoscale', 'stormReports'
];
const EXPECTED_LIFECYCLES = [
  'terminator', 'snow', 'alerts', 'lightning', 'surface-observations', 'wildfires', 'satellite', 'space-weather', 'marine-buoys', 'tropical', 'wpc-outlooks', 'wssi', 'cpc-outlooks', 'usgs-gauges',
  'earthquakes', 'convective', 'fire-weather', 'watches', 'mesoscale', 'storm-reports'
];

function fakeDocument() {
  const elements = Object.create(null);
  registry.descriptors.forEach((descriptor) => {
    elements[descriptor.toggleId] = { checked: descriptor.defaultEnabled };
    descriptor.controls.forEach((control) => {
      elements[control.controlId] = { value: String(control.defaultValue) };
    });
  });
  return {
    elements,
    getElementById(id) { return elements[id] || null; }
  };
}

test('registry has one immutable descriptor for every stable scene layer', () => {
  assert.deepEqual(registry.descriptors.map((descriptor) => descriptor.id), EXPECTED_IDS);
  assert.deepEqual(registry.sceneKeys(), EXPECTED_IDS);
  assert.deepEqual(registry.lifecycleDescriptors().map((descriptor) => descriptor.lifecycleId), EXPECTED_LIFECYCLES);
  assert.ok(Object.isFrozen(registry.descriptors));
  registry.descriptors.forEach((descriptor) => {
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(descriptor.controls));
    assert.ok(Object.isFrozen(descriptor.searchKeys));
    assert.match(descriptor.labelKey, /^layers\./);
    assert.match(descriptor.groupLabelKey, /^layers\.group/);
    assert.equal(registry.get(descriptor.id), descriptor);
    for (const locale of i18n.supportedLocales) {
      assert.ok(i18n.catalogs[locale][descriptor.labelKey], `${locale} is missing ${descriptor.labelKey}`);
      assert.ok(i18n.catalogs[locale][descriptor.groupLabelKey], `${locale} is missing ${descriptor.groupLabelKey}`);
      descriptor.searchKeys.forEach((key) => assert.ok(i18n.catalogs[locale][key], `${locale} is missing ${key}`));
      descriptor.controls.forEach((control) => {
        assert.ok(i18n.catalogs[locale][control.labelKey], `${locale} is missing ${control.labelKey}`);
      });
    }
  });
  assert.throws(() => registry.get('missing'), /unknown layer/);
});

test('registry defaults match the rendered layer toggles', () => {
  const expected = {};
  registry.descriptors.forEach((descriptor) => {
    const input = html.match(new RegExp('<input[^>]*id="' + descriptor.toggleId + '"[^>]*>'));
    assert.ok(input, 'missing ' + descriptor.toggleId);
    const checked = /\schecked(?:\s|>)/.test(input[0]);
    assert.equal(checked, descriptor.defaultEnabled, descriptor.toggleId + ' default drifted');
    expected[descriptor.id] = descriptor.defaultEnabled;
  });
  assert.deepEqual(registry.defaultState(), expected);
});

test('registry captures and applies layer controls for scene and workflow state', () => {
  const documentObject = fakeDocument();
  documentObject.elements['toggle-earthquakes'].checked = true;
  documentObject.elements['wpc-outlook-day'].value = '3';
  documentObject.elements['convective-day'].value = '2';
  documentObject.elements['fire-weather-day'].value = '6';
  documentObject.elements['storm-report-window'].value = '48';
  documentObject.elements['earthquake-magnitude'].value = '4.5';
  documentObject.elements['earthquake-period'].value = 'week';

  assert.equal(registry.captureEnabled(documentObject).earthquakes, true);
  const expected = {
    outlookDay: 3,
    earthquake: { magnitude: '4.5', period: 'week' },
    convectiveDay: 2, fireWeatherDay: 6, stormReportWindow: '48'
  };
  assert.deepEqual(registry.captureControlState(documentObject, 'scene'), expected);
  assert.deepEqual(registry.captureControlState(documentObject, 'profile'), expected);

  registry.applyControlState(documentObject, {
    outlookDay: 1,
    earthquake: { magnitude: 'significant', period: 'month' },
    convectiveDay: 3, fireWeatherDay: 2, stormReportWindow: '24'
  }, 'profile');
  assert.equal(documentObject.elements['wpc-outlook-day'].value, '1');
  assert.equal(documentObject.elements['earthquake-magnitude'].value, 'significant');
  assert.equal(documentObject.elements['earthquake-period'].value, 'month');
  assert.equal(documentObject.elements['convective-day'].value, '3');
  assert.equal(documentObject.elements['fire-weather-day'].value, '2');
  assert.equal(documentObject.elements['storm-report-window'].value, '24');
  assert.throws(() => registry.applyControlState(documentObject, { convectiveDay: 4 }, 'scene'), /value is invalid/);
});

test('descriptor validation rejects incomplete, duplicate, or unsafe metadata', () => {
  const descriptor = {
    id: 'one', toggleId: 'toggle-one', defaultEnabled: false,
    labelKey: 'layers.one', groupId: 'base', groupLabelKey: 'layers.groupBase'
  };
  assert.equal(registry.validateDescriptors([descriptor]), true);
  assert.throws(() => registry.validateDescriptors([{ toggleId: 'toggle-one', defaultEnabled: false }]), /id is invalid/);
  assert.throws(() => registry.validateDescriptors([{
    id: 'one', toggleId: 'toggle-one', defaultEnabled: false
  }]), /navigation metadata/);
  assert.throws(() => registry.validateDescriptors([descriptor, descriptor]), /duplicate layer id/);
  assert.throws(() => registry.validateDescriptors([
    descriptor, {
      id: 'two', toggleId: 'toggle-one', defaultEnabled: false,
      labelKey: 'layers.two', groupId: 'base', groupLabelKey: 'layers.groupBase'
    }
  ]), /duplicate layer toggle/);
  assert.throws(() => registry.validateDescriptors([{
    id: 'one', toggleId: 'toggle-one', defaultEnabled: false,
    labelKey: 'layers.one', groupId: 'base', groupLabelKey: 'layers.groupBase',
    controls: [{
      key: 'value', controlId: 'control-one', type: 'choice', choices: ['ok'], defaultValue: 'ok',
      scenePath: 'constructor.prototype', profilePath: 'value', labelKey: 'layers.value'
    }]
  }]), /control is invalid/);
});

test('registry is local declarative data without executable loading primitives', () => {
  assert.doesNotMatch(source, /\beval\s*\(|\bFunction\s*\(|\bimport\s*\(/);
  assert.doesNotMatch(source, /https?:\/\//);
});

test('every layer is covered by view-snapshot apply through a base effect or lifecycle binding', () => {
  // Base (non-lifecycle) layers whose apply effect lives in app.js applyBaseLayerEffect.
  const BASE_EFFECT_IDS = ['radar', 'cameras', 'coverage', 'alerts'];
  registry.descriptors.forEach((descriptor) => {
    const covered = BASE_EFFECT_IDS.includes(descriptor.id) || Boolean(descriptor.lifecycleId);
    assert.ok(covered, descriptor.id + ' has no apply path (add a base effect or a lifecycle binding)');
  });
});

test('applyViewSnapshot drives layer effects from the registry, not a per-layer ladder', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  // Apply must iterate the registry so a new layer is never silently omitted.
  assert.match(app, /function applyViewSnapshot[\s\S]*StormScopeLayerRegistry\.descriptors\.forEach/);
  // The old hand-enumerated ladder must be gone.
  assert.doesNotMatch(app, /if \(typeof layers\.(radar|earthquakes|watches) === 'boolean'\)/);
});
