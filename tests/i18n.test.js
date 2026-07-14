'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const i18n = require('../js/i18n.js');

test('English and Spanish catalogs have identical complete key sets', () => {
  assert.deepEqual(Object.keys(i18n.catalogs.es).sort(), Object.keys(i18n.catalogs.en).sort());
  for (const [key, value] of Object.entries(i18n.catalogs.es)) {
    assert.ok(value && typeof value === 'string', `Spanish translation missing for ${key}`);
  }
});

test('locale normalization, interpolation, and fallback are deterministic', () => {
  assert.equal(i18n.normalizeLocale('es-MX'), 'es');
  assert.equal(i18n.normalizeLocale('fr-FR'), 'en');
  assert.equal(i18n.t('camera.count', { count: '24.204' }, 'es'), '24.204 cámaras');
  assert.equal(i18n.t('app.title', null, 'fr'), i18n.catalogs.en['app.title']);
  assert.equal(i18n.t('missing.key', null, 'es'), 'missing.key');
});

test('number, date, and frame-age formatting follow the selected locale', () => {
  assert.equal(i18n.formatNumber(24204, null, 'en'), '24,204');
  assert.equal(i18n.formatNumber(24204, null, 'es'), '24.204');
  assert.match(i18n.formatDateTime('2026-07-11T21:00:00Z', { month: 'short', day: 'numeric', timeZone: 'UTC' }, 'es'), /11 jul/);
  assert.equal(i18n.formatAge(1, 'es'), 'hace 1 minuto');
  assert.equal(i18n.formatAge(5, 'es'), 'hace 5 minutos');
});

test('Spanish deterministic weather, CAP, source, radar, and recovery vocabulary is complete', () => {
  const compass = ['n', 'nne', 'ne', 'ene', 'e', 'ese', 'se', 'sse', 's', 'ssw', 'sw', 'wsw', 'w', 'wnw', 'nw', 'nnw'];
  compass.forEach((direction) => assert.notEqual(i18n.t(`direction.${direction}`, null, 'es'), `direction.${direction}`));
  assert.equal(i18n.t('direction.w', null, 'es'), 'O');
  assert.equal(i18n.t('direction.sw', null, 'es'), 'SO');
  assert.equal(i18n.t('urgency.immediate', null, 'es'), 'Inmediata');
  assert.equal(i18n.t('certainty.observed', null, 'es'), 'Observada');
  assert.equal(i18n.t('source.dot', null, 'es'), 'Departamento de transporte');
  assert.match(i18n.t('cache.noResponse', null, 'es'), /no respondió/);
  assert.match(i18n.t('radar.reason.cached-offline', null, 'es'), /caché/);
});

test('application control logic routes user-facing copy through the locale catalog', () => {
  const source = ['app.js', 'camera-feed.js'].map((file) => (
    fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8')
  )).join('\n');
  const forbidden = [
    /textContent\s*=\s*['"][A-Za-z]/,
    /setRadarStatus\(\s*['"][A-Za-z]/,
    /setSavedStateStatus\(\s*['"][A-Za-z]/,
    /renderFeedError\([^\n]+,\s*['"][A-Za-z]/,
    /appendLiveIndicator\([^\n]+,\s*['"][A-Za-z]/
  ];
  forbidden.forEach((pattern) => assert.doesNotMatch(source, pattern));
});
