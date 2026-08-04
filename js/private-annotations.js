/* Bounded, local-only measurement and annotation records. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopePrivateAnnotations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SCHEMA = 'stormscope-private-annotations';
  var VERSION = 1;
  var MAX_ANNOTATIONS = 100;
  var MAX_VERTICES = 256;
  var MAX_TEXT = 240;
  var TYPES = Object.freeze(['point', 'line', 'polygon', 'text', 'measurement']);

  function safeText(value, fallback, required) {
    var text = value == null ? '' : String(value);
    if (/[\u0000-\u001f\u007f]/.test(text) || text.length > MAX_TEXT) throw new TypeError('annotation text is invalid');
    text = text.trim();
    if (!text && required) throw new TypeError('annotation text is required');
    return text || fallback || '';
  }

  function safeNumber(value, minimum, maximum, label) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) throw new TypeError(label + ' is invalid');
    return Object.is(number, -0) ? 0 : number;
  }

  function position(value) {
    if (!Array.isArray(value) || value.length !== 2) throw new TypeError('annotation coordinate is invalid');
    return [safeNumber(value[0], -180, 180, 'longitude'), safeNumber(value[1], -90, 90, 'latitude')];
  }

  function equalPosition(left, right) { return left[0] === right[0] && left[1] === right[1]; }

  function lineCoordinates(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > MAX_VERTICES) {
      throw new TypeError('annotation line is invalid');
    }
    return value.map(position);
  }

  function polygonCoordinates(value) {
    if (!Array.isArray(value) || value.length !== 1) throw new TypeError('annotation polygon is invalid');
    var ring = lineCoordinates(value[0]);
    if (ring.length < 4 || !equalPosition(ring[0], ring[ring.length - 1])) {
      throw new TypeError('annotation polygon ring must be closed');
    }
    return [ring];
  }

  function normalizeGeometry(type, value) {
    if (type === 'point' || type === 'text') return { type: 'Point', coordinates: position(value) };
    if (type === 'line' || type === 'measurement') return { type: 'LineString', coordinates: lineCoordinates(value) };
    if (type === 'polygon') return { type: 'Polygon', coordinates: polygonCoordinates(value) };
    throw new TypeError('annotation type is unsupported');
  }

  function haversineKm(left, right) {
    var radians = Math.PI / 180;
    var deltaLat = (right[1] - left[1]) * radians;
    var deltaLon = (right[0] - left[0]) * radians;
    var a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(left[1] * radians) * Math.cos(right[1] * radians) *
      Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function bearingDegrees(left, right) {
    var radians = Math.PI / 180;
    var deltaLon = (right[0] - left[0]) * radians;
    var leftLat = left[1] * radians;
    var rightLat = right[1] * radians;
    var y = Math.sin(deltaLon) * Math.cos(rightLat);
    var x = Math.cos(leftLat) * Math.sin(rightLat) -
      Math.sin(leftLat) * Math.cos(rightLat) * Math.cos(deltaLon);
    return (Math.atan2(y, x) / radians + 360) % 360;
  }

  function measureLine(value) {
    var coordinates = lineCoordinates(value);
    var distanceKm = 0;
    for (var index = 1; index < coordinates.length; index += 1) distanceKm += haversineKm(coordinates[index - 1], coordinates[index]);
    return {
      distanceKm: Number(distanceKm.toFixed(3)),
      bearingDegrees: Number(bearingDegrees(coordinates[0], coordinates[coordinates.length - 1]).toFixed(1))
    };
  }

  function hash(text) {
    var value = 2166136261;
    for (var index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return (value >>> 0).toString(36);
  }

  function normalizeType(value) {
    var type = String(value || '').toLowerCase();
    if (TYPES.indexOf(type) === -1) throw new TypeError('annotation type is unsupported');
    return type;
  }

  function validTimestamp(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('annotation timestamp is invalid');
    return date.toISOString();
  }

  function validateAnnotation(value) {
    if (!value || value.schema !== SCHEMA || value.version !== VERSION ||
        typeof value.id !== 'string' || !/^annotation-[a-z0-9]+$/.test(value.id)) {
      throw new TypeError('annotation record is invalid');
    }
    var type = normalizeType(value.type);
    var geometry = normalizeGeometry(type, value.geometry && value.geometry.coordinates);
    var record = {
      schema: SCHEMA,
      version: VERSION,
      id: value.id,
      type: type,
      label: safeText(value.label, '', type === 'text'),
      createdAt: validTimestamp(value.createdAt),
      updatedAt: validTimestamp(value.updatedAt),
      geometry: geometry
    };
    if (type === 'measurement') record.measurement = measureLine(geometry.coordinates);
    return record;
  }

  function createAnnotation(type, coordinates, label, now) {
    type = normalizeType(type);
    var geometry = normalizeGeometry(type, coordinates);
    var timestamp = new Date(now == null ? Date.now() : now).toISOString();
    var cleanLabel = safeText(label, '', type === 'text');
    var canonical = JSON.stringify({ type: type, label: cleanLabel, geometry: geometry });
    var record = {
      schema: SCHEMA,
      version: VERSION,
      id: 'annotation-' + hash(canonical + timestamp),
      type: type,
      label: cleanLabel,
      createdAt: timestamp,
      updatedAt: timestamp,
      geometry: geometry
    };
    if (type === 'measurement') record.measurement = measureLine(geometry.coordinates);
    return record;
  }

  function exportAnnotation(value) { return JSON.stringify(validateAnnotation(value), null, 2); }

  function exportBundle(records, now) {
    if (!Array.isArray(records) || records.length > MAX_ANNOTATIONS) throw new RangeError('annotation limit exceeded');
    return JSON.stringify({
      schema: SCHEMA, version: VERSION, exportedAt: new Date(now == null ? Date.now() : now).toISOString(),
      annotations: records.map(validateAnnotation)
    }, null, 2);
  }

  function parseBundle(value) {
    var source = typeof value === 'string' ? JSON.parse(value) : value;
    if (!source || source.schema !== SCHEMA || source.version !== VERSION ||
        !Array.isArray(source.annotations) || source.annotations.length > MAX_ANNOTATIONS) {
      throw new TypeError('annotation bundle is invalid');
    }
    return source.annotations.map(validateAnnotation);
  }

  return Object.freeze({
    SCHEMA: SCHEMA,
    VERSION: VERSION,
    MAX_ANNOTATIONS: MAX_ANNOTATIONS,
    MAX_VERTICES: MAX_VERTICES,
    MAX_TEXT: MAX_TEXT,
    TYPES: TYPES,
    createAnnotation: createAnnotation,
    exportAnnotation: exportAnnotation,
    exportBundle: exportBundle,
    measureLine: measureLine,
    parseBundle: parseBundle,
    validateAnnotation: validateAnnotation
  });
});
