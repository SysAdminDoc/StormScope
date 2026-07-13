/* Official NOAA NHC tropical-cyclone ArcGIS adapter. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeTropicalCyclones = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SERVICE_ROOT = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
  var REFRESH_MS = 5 * 60 * 1000;
  var MAX_FEATURES = 1000;
  var LAYERS = Object.freeze({ points: 5, track: 6, cone: 7, watches: 8 });
  var FIELDS = Object.freeze({
    points: 'stormname,stormtype,dvlbl,basin,advdate,advisnum,fcstprd,gust,maxwind,mslp,ssnum,datelbl,tcdvlp,tcdir,tcspd,fldatelbl,lat,lon,stormnum,stormsrc,timezone,validtime,tau,idp_source,idp_subset,idp_filedate,idp_ingestdate,binnumber',
    track: 'stormname,stormtype,basin,advisnum,advdate,fcstprd,stormnum,idp_source,idp_filedate,idp_ingestdate,binnumber',
    cone: 'stormname,stormtype,basin,advisnum,advdate,fcstprd,stormnum,idp_source,idp_filedate,idp_ingestdate,binnumber',
    watches: 'stormname,stormtype,basin,advisnum,advdate,fcstprd,stormnum,tcww,idp_source,idp_filedate,idp_ingestdate,binnumber'
  });

  function buildQueryUrl(kind) {
    if (!Object.prototype.hasOwnProperty.call(LAYERS, kind)) throw new Error('Unknown NHC layer');
    var params = new URLSearchParams({
      where: '1=1', outFields: FIELDS[kind], returnGeometry: 'true', outSR: '4326', f: 'geojson'
    });
    return SERVICE_ROOT + '/' + LAYERS[kind] + '/query?' + params.toString();
  }

  function parseTime(value) {
    if (value == null || value === '') return null;
    var numeric = Number(value);
    var date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function featureKey(properties) {
    var bin = String(properties.binnumber || '').trim().toUpperCase();
    if (/^(AT|EP)[1-5]$/.test(bin)) return bin;
    var source = String(properties.stormsrc || '').trim().toUpperCase();
    var number = String(properties.stormnum || '').trim();
    return source && number ? source + number.padStart(2, '0') : '';
  }

  function advisory(properties) {
    return String(properties.advisnum == null ? '' : properties.advisnum).trim();
  }

  function coordinateTreeValid(value, depth) {
    if (!Array.isArray(value) || !value.length || depth > 5) return false;
    if (typeof value[0] === 'number') {
      return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
        value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
    }
    return value.every(function (child) { return coordinateTreeValid(child, depth + 1); });
  }

  function geometryValid(geometry) {
    if (!geometry || ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].indexOf(geometry.type) === -1) return false;
    return coordinateTreeValid(geometry.coordinates, 0);
  }

  function validateCollection(value) {
    if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > MAX_FEATURES) {
      throw new Error('Invalid NHC GeoJSON collection');
    }
    return {
      type: 'FeatureCollection',
      features: value.features.map(function (feature) {
        if (!feature || feature.type !== 'Feature' || !geometryValid(feature.geometry) ||
            !feature.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
          throw new Error('Invalid NHC GeoJSON feature');
        }
        return { type: 'Feature', geometry: feature.geometry, properties: Object.assign({}, feature.properties) };
      })
    };
  }

  function officialLinks(binNumber) {
    var bin = String(binNumber || '').trim().toUpperCase();
    return Object.freeze({
      advisory: /^(AT|EP)[1-5]$/.test(bin)
        ? 'https://www.nhc.noaa.gov/graphics_' + bin.toLowerCase() + '.shtml'
        : 'https://www.nhc.noaa.gov/cyclones/',
      gis: 'https://www.nhc.noaa.gov/gis/'
    });
  }

  function warningStyle(code) {
    var styles = {
      HWA: { color: '#ff7f7f', weight: 5, dashArray: '8 5' },
      HWR: { color: '#ff0000', weight: 5, dashArray: null },
      TWA: { color: '#ffff00', weight: 3, dashArray: '8 5' },
      TWR: { color: '#004da8', weight: 3, dashArray: null }
    };
    return Object.assign({ color: '#ff2d55', weight: 3, dashArray: '4 4' }, styles[String(code || '').toUpperCase()] || {});
  }

  function freshness(value, now, staleMs) {
    var time = Date.parse(value || '');
    if (!Number.isFinite(time)) return { state: 'unknown', ageMs: null };
    var age = Math.max(0, Number(now || Date.now()) - time);
    return { state: age > Number(staleMs || 6 * 60 * 60 * 1000) ? 'stale' : 'fresh', ageMs: age };
  }

  function resultEntry(entry) {
    if (!entry || entry.ok !== true) return { ok: false, collection: null };
    try { return { ok: true, collection: validateCollection(entry.collection || entry.data) }; }
    catch (error) { return { ok: false, collection: null, error: error }; }
  }

  function normalizeSnapshot(input, now) {
    input = input || {};
    var results = {};
    Object.keys(LAYERS).forEach(function (kind) { results[kind] = resultEntry(input[kind]); });
    var missing = Object.keys(results).filter(function (kind) { return !results[kind].ok; });
    var successes = Object.keys(results).filter(function (kind) { return results[kind].ok; });
    if (!successes.length) return { state: 'unavailable', missing: missing, storms: [], updatedAt: null };
    var successfulFeatureCount = successes.reduce(function (count, kind) {
      return count + results[kind].collection.features.length;
    }, 0);
    if (results.points.ok && results.points.collection.features.length === 0) {
      return {
        state: missing.length || successfulFeatureCount ? 'partial' : 'no-active',
        missing: missing, storms: [], updatedAt: null
      };
    }
    if (!results.points.ok) return { state: 'partial', missing: missing, storms: [], updatedAt: null };

    var groups = Object.create(null);
    results.points.collection.features.forEach(function (feature) {
      var properties = feature.properties;
      var key = featureKey(properties);
      if (!key) return;
      if (!groups[key]) groups[key] = [];
      groups[key].push(feature);
    });
    var storms = Object.keys(groups).map(function (key) {
      var points = groups[key].slice().sort(function (a, b) {
        return Number(a.properties.tau || 0) - Number(b.properties.tau || 0);
      });
      var current = points.find(function (feature) { return Number(feature.properties.tau || 0) === 0; }) || points[0];
      var properties = current.properties;
      var stormAdvisory = advisory(properties);
      var issuedAt = parseTime(properties.idp_filedate) || parseTime(properties.advdate) || parseTime(properties.validtime);
      var features = points.map(function (feature) {
        feature.properties.kind = Number(feature.properties.tau || 0) === 0 ? 'center' : 'forecast-point';
        return feature;
      });
      ['track', 'cone', 'watches'].forEach(function (kind) {
        if (!results[kind].ok) return;
        results[kind].collection.features.forEach(function (feature) {
          if (featureKey(feature.properties) !== key) return;
          var productAdvisory = advisory(feature.properties);
          if (stormAdvisory && productAdvisory && productAdvisory !== stormAdvisory) return;
          feature.properties.kind = kind;
          features.push(feature);
        });
      });
      features.forEach(function (feature) {
        Object.assign(feature.properties, {
          stormName: String(properties.stormname || key),
          classification: String(properties.stormtype || properties.dvlbl || '').trim(),
          issuance: issuedAt,
          advisory: stormAdvisory,
          advisoryUrl: officialLinks(key).advisory,
          intensity: Number.isFinite(Number(properties.maxwind)) ? Number(properties.maxwind) : null,
          pressure: Number.isFinite(Number(properties.mslp)) ? Number(properties.mslp) : null,
          binNumber: key
        });
      });
      return {
        id: key, binNumber: key, advisory: stormAdvisory,
        name: String(properties.stormname || key),
        classification: String(properties.stormtype || properties.dvlbl || '').trim(),
        issuedAt: issuedAt, wind: Number.isFinite(Number(properties.maxwind)) ? Number(properties.maxwind) : null,
        pressure: Number.isFinite(Number(properties.mslp)) ? Number(properties.mslp) : null,
        links: officialLinks(key), currentPoint: current, features: features
      };
    });
    var updatedAt = storms.map(function (storm) { return storm.issuedAt; }).filter(Boolean).sort().pop() || null;
    return { state: missing.length ? 'partial' : 'ready', missing: missing, storms: storms, updatedAt: updatedAt };
  }

  return Object.freeze({
    SERVICE_ROOT: SERVICE_ROOT, REFRESH_MS: REFRESH_MS, LAYERS: LAYERS, FIELDS: FIELDS,
    buildQueryUrl: buildQueryUrl, validateCollection: validateCollection, normalizeSnapshot: normalizeSnapshot,
    warningStyle: warningStyle, freshness: freshness, officialLinks: officialLinks
  });
});
