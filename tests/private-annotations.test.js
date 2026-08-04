'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const annotations = require('../js/private-annotations.js');

const NOW = '2026-08-03T12:00:00.000Z';

test('creates bounded point, text, line, polygon, and measurement records', () => {
  const point = annotations.createAnnotation('point', [-90.5, 38.5], 'Storm center', NOW);
  const text = annotations.createAnnotation('text', [-90.4, 38.6], 'Watch area', NOW);
  const line = annotations.createAnnotation('line', [[-90.5, 38.5], [-90.4, 38.6]], '', NOW);
  const polygon = annotations.createAnnotation('polygon', [[[-90.5, 38.5], [-90.4, 38.5], [-90.4, 38.6], [-90.5, 38.5]]], '', NOW);
  const measurement = annotations.createAnnotation('measurement', [[0, 0], [1, 0]], '', NOW);

  assert.equal(point.geometry.type, 'Point');
  assert.equal(text.label, 'Watch area');
  assert.equal(line.geometry.type, 'LineString');
  assert.equal(polygon.geometry.type, 'Polygon');
  assert.ok(measurement.measurement.distanceKm > 111 && measurement.measurement.distanceKm < 112);
  assert.equal(measurement.measurement.bearingDegrees, 90);
});

test('distance and bearing use bounded geodesic calculations', () => {
  const result = annotations.measureLine([[0, 0], [1, 0], [1, 1]]);
  assert.ok(result.distanceKm > 221 && result.distanceKm < 224);
  assert.equal(result.bearingDegrees, 45);
});

test('rejects invalid geometry, labels, timestamps, and oversized input', () => {
  assert.throws(() => annotations.createAnnotation('polygon', [[[0, 0], [1, 0], [0, 1]]], '', NOW), /closed/);
  assert.throws(() => annotations.createAnnotation('line', [[0, 0]], '', NOW), /line/);
  assert.throws(() => annotations.createAnnotation('text', [0, 0], '', NOW), /required/);
  assert.throws(() => annotations.createAnnotation('point', [181, 0], '', NOW), /longitude/);
  assert.throws(() => annotations.createAnnotation('point', [0, 91], '', NOW), /latitude/);
  assert.throws(() => annotations.createAnnotation('text', [0, 0], 'bad' + String.fromCharCode(1), NOW), /text/);
  assert.throws(() => annotations.createAnnotation('point', [0, 0], 'x'.repeat(annotations.MAX_TEXT + 1), NOW), /text/);
  assert.throws(() => annotations.createAnnotation('point', [0, 0], '', 'not-a-date'), /Invalid time value/);
  assert.throws(() => annotations.createAnnotation('line', Array.from({ length: annotations.MAX_VERTICES + 1 }, () => [0, 0]), '', NOW), /line/);
});

test('export and import preserve only validated private records', () => {
  const record = annotations.createAnnotation('measurement', [[-90, 38], [-89, 38]], 'Track', NOW);
  record.persisted = true;
  record.layer = { privateRuntimeObject: true };
  const exported = annotations.exportBundle([record], NOW);
  const payload = JSON.parse(exported);
  assert.equal(payload.schema, annotations.SCHEMA);
  assert.equal(payload.version, annotations.VERSION);
  assert.equal(payload.annotations.length, 1);
  assert.equal(payload.annotations[0].persisted, undefined);
  assert.equal(payload.annotations[0].layer, undefined);
  assert.deepEqual(annotations.parseBundle(exported), [annotations.validateAnnotation(record)]);

  const future = JSON.parse(exported);
  future.version += 1;
  assert.throws(() => annotations.parseBundle(future), /bundle/);
  assert.throws(() => annotations.parseBundle({
    schema: annotations.SCHEMA, version: annotations.VERSION,
    annotations: Array.from({ length: annotations.MAX_ANNOTATIONS + 1 }, () => record)
  }), /bundle/);
});
