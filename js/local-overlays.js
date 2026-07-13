/* Strict, local-only GeoJSON and GPX overlay normalization. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeLocalOverlays = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var RECORD_SCHEMA = 'stormscope-local-overlay';
  var BUNDLE_SCHEMA = 'stormscope-local-overlays';
  var VERSION = 1;
  var MAX_FILE_BYTES = 5 * 1024 * 1024;
  var MAX_FEATURES = 2000;
  var MAX_COORDINATES = 100000;
  var MAX_FEATURE_COORDINATES = 50000;
  var MAX_PROPERTIES = 32;
  var MAX_PROPERTY_TEXT = 1024;
  var MAX_NAME = 100;
  var MAX_OVERLAYS = 10;
  var SUPPORTED_GEOMETRIES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
  var COLORS = Object.freeze({ cyan: '#4cc9f0', blue: '#4895ef', violet: '#b5179e', pink: '#f72585', orange: '#ff9f1c', yellow: '#ffe66d', green: '#2ec4b6', red: '#ef476f' });

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function safeText(value, maximum, label) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(label + ' is invalid');
    return value;
  }
  function cleanName(value, fallback) {
    var text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
    if (!text) text = fallback || 'Local overlay';
    return text.slice(0, MAX_NAME);
  }
  function safeNumber(value, minimum, maximum, label) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) throw new TypeError(label + ' is invalid');
    return Object.is(number, -0) ? 0 : number;
  }
  function normalizePosition(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 3) throw new TypeError('coordinate position is invalid');
    var result = [safeNumber(value[0], -180, 180, 'longitude'), safeNumber(value[1], -90, 90, 'latitude')];
    if (value.length === 3) result.push(safeNumber(value[2], -12000, 100000, 'elevation'));
    return result;
  }
  function positions(value, depth, counter) {
    if (!Array.isArray(value) || !value.length || depth > 6) throw new TypeError('coordinate nesting is invalid');
    if (typeof value[0] === 'number') {
      counter.total += 1;
      counter.feature += 1;
      if (counter.total > MAX_COORDINATES || counter.feature > MAX_FEATURE_COORDINATES) throw new RangeError('coordinate limit exceeded');
      return normalizePosition(value);
    }
    return value.map(function (child) { return positions(child, depth + 1, counter); });
  }
  function positionCount(value) {
    if (!Array.isArray(value)) return 0;
    if (typeof value[0] === 'number') return 1;
    return value.reduce(function (sum, child) { return sum + positionCount(child); }, 0);
  }
  function positionEqual(a, b) { return a.length === b.length && a.every(function (value, index) { return value === b[index]; }); }
  function validateGeometryShape(geometry) {
    var coordinates = geometry.coordinates;
    function requireLine(line, ring) {
      if (!Array.isArray(line) || line.length < (ring ? 4 : 2) || line.length > 20000) throw new TypeError('line or ring is invalid');
      if (ring && !positionEqual(line[0], line[line.length - 1])) throw new TypeError('polygon ring must be closed');
    }
    if (geometry.type === 'Point') return;
    if (geometry.type === 'MultiPoint') { if (!coordinates.length) throw new TypeError('multipoint is empty'); return; }
    if (geometry.type === 'LineString') return requireLine(coordinates, false);
    if (geometry.type === 'MultiLineString') return coordinates.forEach(function (line) { requireLine(line, false); });
    if (geometry.type === 'Polygon') {
      if (coordinates.length > 256) throw new RangeError('polygon ring limit exceeded');
      return coordinates.forEach(function (ring) { requireLine(ring, true); });
    }
    coordinates.forEach(function (polygon) {
      if (polygon.length > 256) throw new RangeError('polygon ring limit exceeded');
      polygon.forEach(function (ring) { requireLine(ring, true); });
    });
  }
  function normalizeGeometry(value, counter) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || SUPPORTED_GEOMETRIES.indexOf(value.type) === -1 || !own(value, 'coordinates')) {
      throw new TypeError('geometry type is unsupported');
    }
    counter.feature = 0;
    var geometry = { type: value.type, coordinates: positions(value.coordinates, 0, counter) };
    validateGeometryShape(geometry);
    return geometry;
  }
  function normalizeProperties(value) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('feature properties must be an object');
    var keys = Object.keys(value);
    if (keys.length > MAX_PROPERTIES) throw new RangeError('property limit exceeded');
    var result = {};
    keys.sort().forEach(function (key) {
      safeText(key, 64, 'property key');
      if (['__proto__', 'prototype', 'constructor'].indexOf(key) !== -1) throw new TypeError('property key is unsafe');
      var property = value[key];
      if (property == null || typeof property === 'boolean') result[key] = property;
      else if (typeof property === 'number' && Number.isFinite(property)) result[key] = property;
      else if (typeof property === 'string') result[key] = safeText(property, MAX_PROPERTY_TEXT, 'property value');
      else throw new TypeError('nested feature properties are unsupported');
    });
    return result;
  }
  function rootFeatures(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('GeoJSON root is invalid');
    if (value.type === 'FeatureCollection') {
      if (own(value, 'crs') || own(value, 'bbox')) throw new TypeError('GeoJSON CRS or bbox is unsupported');
      if (!Array.isArray(value.features)) throw new TypeError('GeoJSON features are invalid');
      return value.features;
    }
    if (value.type === 'Feature') return [value];
    if (SUPPORTED_GEOMETRIES.indexOf(value.type) !== -1) return [{ type: 'Feature', properties: {}, geometry: value }];
    throw new TypeError('GeoJSON root type is unsupported');
  }
  function normalizeGeoJson(value) {
    var source = typeof value === 'string' ? JSON.parse(value) : value;
    var input = rootFeatures(source);
    if (!input.length || input.length > MAX_FEATURES) throw new RangeError('feature limit exceeded');
    var counter = { total: 0, feature: 0 };
    var features = input.map(function (feature, index) {
      if (!feature || feature.type !== 'Feature' || feature.geometry == null) throw new TypeError('GeoJSON feature is invalid');
      var id = feature.id == null ? 'feature-' + (index + 1) : String(feature.id);
      safeText(id, 128, 'feature ID');
      return { type: 'Feature', id: id, properties: normalizeProperties(feature.properties), geometry: normalizeGeometry(feature.geometry, counter) };
    });
    return { collection: { type: 'FeatureCollection', features: features }, coordinateCount: counter.total };
  }

  function decodeXml(value) {
    return String(value || '').replace(/&(?:amp|lt|gt|quot|apos);/g, function (entity) {
      return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity];
    });
  }
  function childText(block, name, maximum) {
    var match = String(block || '').match(new RegExp('<(?:[A-Za-z_][\\w.-]*:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?' + name + '>', 'i'));
    if (!match) return null;
    var text = decodeXml(match[1].replace(/<[^>]+>/g, '')).trim();
    return text ? safeText(text, maximum, 'GPX metadata') : null;
  }
  function pointFromTag(attributes, body) {
    function attribute(name) {
      var match = attributes.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\'])(.*?)\\1', 'i'));
      return match && match[2];
    }
    var point = [safeNumber(attribute('lon'), -180, 180, 'longitude'), safeNumber(attribute('lat'), -90, 90, 'latitude')];
    var elevation = childText(body, 'ele', 32);
    if (elevation != null) point.push(safeNumber(elevation, -12000, 100000, 'elevation'));
    return point;
  }
  function pointTags(block, tag) {
    var expression = new RegExp('<(?:[A-Za-z_][\\w.-]*:)?' + tag + '\\b([^>]*)>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?' + tag + '>', 'gi');
    var points = [];
    var match;
    while ((match = expression.exec(block))) points.push(pointFromTag(match[1], match[2]));
    return points;
  }
  function gpxProperties(block, fallback) {
    var result = { name: childText(block, 'name', 160) || fallback };
    var description = childText(block, 'desc', MAX_PROPERTY_TEXT) || childText(block, 'cmt', MAX_PROPERTY_TEXT);
    var type = childText(block, 'type', 80);
    if (description) result.description = description;
    if (type) result.category = type;
    return result;
  }
  function parseGpx(text) {
    var xml = String(text || '');
    if (xml.length > MAX_FILE_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:[A-Za-z_][\w.-]*:)?gpx\b/i.test(xml) || !/<\/(?:[A-Za-z_][\w.-]*:)?gpx\s*>/i.test(xml)) {
      throw new TypeError('GPX document is invalid');
    }
    var features = [];
    var match;
    var waypoint = /<(?:[A-Za-z_][\w.-]*:)?wpt\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?wpt>/gi;
    while ((match = waypoint.exec(xml))) features.push({ type: 'Feature', properties: gpxProperties(match[2], 'Waypoint'), geometry: { type: 'Point', coordinates: pointFromTag(match[1], match[2]) } });
    var route = /<(?:[A-Za-z_][\w.-]*:)?rte\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?rte>/gi;
    while ((match = route.exec(xml))) {
      var routePoints = pointTags(match[1], 'rtept');
      if (routePoints.length < 2) throw new TypeError('GPX route is invalid');
      features.push({ type: 'Feature', properties: gpxProperties(match[1], 'Route'), geometry: { type: 'LineString', coordinates: routePoints } });
    }
    var track = /<(?:[A-Za-z_][\w.-]*:)?trk\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?trk>/gi;
    while ((match = track.exec(xml))) {
      var segments = [];
      var segmentMatch;
      var segment = /<(?:[A-Za-z_][\w.-]*:)?trkseg\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?trkseg>/gi;
      while ((segmentMatch = segment.exec(match[1]))) {
        var segmentPoints = pointTags(segmentMatch[1], 'trkpt');
        if (segmentPoints.length < 2) throw new TypeError('GPX track segment is invalid');
        segments.push(segmentPoints);
      }
      if (!segments.length) throw new TypeError('GPX track is invalid');
      features.push({ type: 'Feature', properties: gpxProperties(match[1], 'Track'), geometry: {
        type: segments.length === 1 ? 'LineString' : 'MultiLineString', coordinates: segments.length === 1 ? segments[0] : segments
      } });
    }
    if (!features.length) throw new TypeError('GPX has no supported features');
    return normalizeGeoJson({ type: 'FeatureCollection', features: features });
  }

  function extension(filename) { var match = String(filename || '').toLowerCase().match(/\.(geojson|json|gpx)$/); return match && match[1]; }
  function sourceFormat(file) {
    var ext = extension(file && file.name);
    if (!ext) throw new TypeError('overlay file type is unsupported');
    var mime = String(file.type || '').toLowerCase();
    var allowed = ext === 'gpx' ? ['application/gpx+xml', 'application/xml', 'text/xml', 'application/octet-stream', '']
      : ['application/geo+json', 'application/json', 'text/json', 'application/octet-stream', ''];
    if (allowed.indexOf(mime) === -1) throw new TypeError('overlay MIME type contradicts its extension');
    return ext === 'gpx' ? 'gpx' : 'geojson';
  }
  function hash(text) { var value = 2166136261; for (var i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); return (value >>> 0).toString(36); }
  function createRecord(file, text, now) {
    if (!file || !Number.isFinite(Number(file.size)) || file.size < 1 || file.size > MAX_FILE_BYTES) throw new RangeError('overlay file size is unsupported');
    if (new TextEncoder().encode(String(text)).length > MAX_FILE_BYTES) throw new RangeError('overlay file size is unsupported');
    var format = sourceFormat(file);
    var normalized = format === 'gpx' ? parseGpx(text) : normalizeGeoJson(text);
    var name = cleanName(String(file.name).replace(/\.(?:geojson|json|gpx)$/i, ''), 'Local overlay');
    var canonical = JSON.stringify(normalized.collection);
    var timestamp = new Date(now || Date.now()).toISOString();
    return {
      schema: RECORD_SCHEMA, version: VERSION, id: 'overlay-' + hash(name + canonical), name: name,
      sourceFormat: format, createdAt: timestamp, updatedAt: timestamp, visible: true,
      style: { color: 'cyan' }, featureCount: normalized.collection.features.length,
      coordinateCount: normalized.coordinateCount, data: normalized.collection
    };
  }
  function validateRecord(value) {
    if (!value || value.schema !== RECORD_SCHEMA || value.version !== VERSION || !/^overlay-[a-z0-9]+$/.test(value.id)) throw new TypeError('overlay record is invalid');
    var normalized = normalizeGeoJson(value.data);
    var record = {
      schema: RECORD_SCHEMA, version: VERSION, id: value.id,
      name: cleanName(value.name), sourceFormat: value.sourceFormat === 'gpx' ? 'gpx' : 'geojson', visible: value.visible !== false,
      style: { color: own(COLORS, value.style && value.style.color) ? value.style.color : 'cyan' },
      createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(),
      featureCount: normalized.collection.features.length, coordinateCount: normalized.coordinateCount, data: normalized.collection
    };
    return record;
  }
  function parseBundle(value) {
    var source = typeof value === 'string' ? JSON.parse(value) : value;
    if (!source || source.schema !== BUNDLE_SCHEMA || source.version !== VERSION || !Array.isArray(source.overlays) || source.overlays.length > MAX_OVERLAYS) throw new TypeError('overlay bundle is invalid');
    return source.overlays.map(validateRecord);
  }
  function exportOverlay(record) { return JSON.stringify(validateRecord(record).data, null, 2); }
  function exportBundle(records, now) {
    if (!Array.isArray(records) || records.length > MAX_OVERLAYS) throw new RangeError('overlay limit exceeded');
    return JSON.stringify({ schema: BUNDLE_SCHEMA, version: VERSION, exportedAt: new Date(now || Date.now()).toISOString(), overlays: records.map(validateRecord) }, null, 2);
  }
  function geometryBounds(collection) {
    var normalized = normalizeGeoJson(collection).collection;
    var result = { west: 180, south: 90, east: -180, north: -90 };
    function visit(value) {
      if (typeof value[0] === 'number') {
        result.west = Math.min(result.west, value[0]); result.east = Math.max(result.east, value[0]);
        result.south = Math.min(result.south, value[1]); result.north = Math.max(result.north, value[1]); return;
      }
      value.forEach(visit);
    }
    normalized.features.forEach(function (feature) { visit(feature.geometry.coordinates); });
    return result;
  }
  function style(record, geometryType) {
    var color = COLORS[record && record.style && record.style.color] || COLORS.cyan;
    var polygon = /Polygon$/.test(geometryType);
    return { color: color, weight: polygon ? 2 : 3, opacity: 0.9, fillColor: color, fillOpacity: polygon ? 0.12 : 0, dashArray: null };
  }

  return Object.freeze({
    RECORD_SCHEMA: RECORD_SCHEMA, BUNDLE_SCHEMA: BUNDLE_SCHEMA, VERSION: VERSION, MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_FEATURES: MAX_FEATURES, MAX_COORDINATES: MAX_COORDINATES, MAX_OVERLAYS: MAX_OVERLAYS, COLORS: COLORS,
    sourceFormat: sourceFormat, normalizeGeoJson: normalizeGeoJson, parseGpx: parseGpx, createRecord: createRecord,
    validateRecord: validateRecord, parseBundle: parseBundle, exportOverlay: exportOverlay, exportBundle: exportBundle,
    geometryBounds: geometryBounds, positionCount: positionCount, style: style
  });
});
