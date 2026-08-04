'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const i18n = require('../js/i18n.js');
const pseudoLocale = require('./pseudo-locale.js');

const root = path.resolve(__dirname, '..');

function collectStaticTranslationKeys() {
  const sourceFiles = fs.readdirSync(path.join(root, 'js'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(root, 'js', file));
  sourceFiles.push(path.join(root, 'index.html'));
  const keys = new Set();
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\btr\(\s*['"]([^'"]+)['"]\s*(?=[,)])/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n(?:-[^=]+)?="([^"]+)"/g)) keys.add(match[1]);
  }
  return [...keys].sort();
}

test('English and Spanish catalogs have identical complete key sets', () => {
  assert.deepEqual(Object.keys(i18n.catalogs.es).sort(), Object.keys(i18n.catalogs.en).sort());
  for (const locale of ['en', 'es']) {
    for (const [key, value] of Object.entries(i18n.catalogs[locale])) {
      assert.ok(value && typeof value === 'string' && value !== key,
        `${locale} translation missing for ${key}`);
    }
  }
});

test('static translation references have non-sentinel entries in every shipped locale', () => {
  const keys = collectStaticTranslationKeys();
  assert.ok(keys.length >= 100, `expected broad static translation coverage, found ${keys.length} keys`);
  for (const locale of i18n.supportedLocales) {
    assert.deepEqual(pseudoLocale.missingKeySentinels(i18n.catalogs[locale], keys), [],
      `${locale} has missing-key sentinels`);
    for (const key of keys) assert.notEqual(i18n.t(key, null, locale), key, `${locale} falls back for ${key}`);
  }
});

test('pseudo-locale expands every catalog value without shipping a locale', () => {
  const expanded = pseudoLocale.expandCatalog(i18n.catalogs.en, 0.35);
  assert.equal(i18n.supportedLocales.includes(pseudoLocale.PSEUDO_LOCALE), false);
  assert.equal(Object.hasOwn(i18n.catalogs, pseudoLocale.PSEUDO_LOCALE), false);
  for (const [key, value] of Object.entries(i18n.catalogs.en)) {
    assert.match(expanded[key], /^⟦[\s\S]+⟧$/);
    assert.ok(expanded[key].length >= value.length + Math.ceil(value.length * 0.35) + 2,
      `${key} should have at least 35% expansion`);
    assert.notEqual(expanded[key], key);
  }
});

test('locale direction is deterministic for LTR and RTL language tags', () => {
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<html lang="en" dir="ltr">/);
  assert.equal(i18n.directionForLocale('en'), 'ltr');
  assert.equal(i18n.directionForLocale('es-MX'), 'ltr');
  assert.equal(i18n.directionForLocale('ar'), 'rtl');
  assert.equal(i18n.directionForLocale('he-IL'), 'rtl');
  assert.equal(i18n.directionForLocale('FA_ir'), 'rtl');
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
