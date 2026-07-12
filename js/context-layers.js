/* Keyless official lightning and wildfire context-provider contracts. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeContextLayers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var LIGHTNING_CAPABILITIES = 'https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities';
  var LIGHTNING_WMS = 'https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows';
  var WILDFIRE_LAYER = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0';
  var providers = Object.freeze({
    lightning: Object.freeze({
      id: 'lightning', label: 'NOAA nowCOAST lightning density', defaultVisible: false,
      capabilitiesUrl: LIGHTNING_CAPABILITIES, wmsUrl: LIGHTNING_WMS,
      layer: 'ldn_lightning_strike_density', style: 'lightning_density',
      refreshMs: 15 * 60 * 1000, staleMs: 35 * 60 * 1000,
      coverage: '25°S–80°N, 110°E–0°W',
      attribution: Object.freeze({ text: 'NOAA nowCOAST', url: 'https://nowcoast.noaa.gov/' })
    }),
    wildfires: Object.freeze({
      id: 'wildfires', label: 'NIFC WFIGS current wildfire perimeters', defaultVisible: false,
      layerUrl: WILDFIRE_LAYER, refreshMs: 5 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000,
      coverage: 'United States current interagency wildfire perimeters',
      attribution: Object.freeze({ text: 'NIFC WFIGS', url: 'https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824' })
    })
  });

  function decodeXml(value) {
    return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function parseLightningCapabilities(xml) {
    var source = String(xml || '');
    if (source.indexOf('<Name>' + providers.lightning.layer + '</Name>') === -1) {
      throw new Error('NOAA lightning layer is missing from WMS capabilities');
    }
    var dimension = source.match(/<Dimension\b[^>]*name=["']time["'][^>]*>([^<]+)<\/Dimension>/i);
    if (!dimension) throw new Error('NOAA lightning timeline is missing from WMS capabilities');
    var times = decodeXml(dimension[1]).split(',').map(function (value) {
      var parsed = Date.parse(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }).filter(function (value) { return value !== null; }).sort(function (left, right) { return left - right; });
    if (!times.length) throw new Error('NOAA lightning timeline contains no valid frames');
    return { latestTime: times[times.length - 1], frameCount: times.length, times: times };
  }

  function normalizeLongitude(value) {
    var longitude = Number(value);
    while (longitude < -180) longitude += 360;
    while (longitude > 180) longitude -= 360;
    return longitude;
  }

  function envelopeUrl(west, south, east, north, offset, pageSize) {
    var parameters = new URLSearchParams({
      where: "attr_IncidentTypeCategory='WF'",
      geometry: [west, south, east, north].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'OBJECTID,poly_IncidentName,poly_GISAcres,poly_DateCurrent,attr_PercentContained,attr_IncidentTypeCategory',
      returnGeometry: 'true', outSR: '4326', f: 'geojson',
      orderByFields: 'OBJECTID ASC',
      resultOffset: String(offset || 0),
      resultRecordCount: String(pageSize || 2000)
    });
    return providers.wildfires.layerUrl + '/query?' + parameters.toString();
  }

  function transferLimitExceeded(payload) {
    return Boolean(payload && (
      payload.exceededTransferLimit ||
      payload.properties && payload.properties.exceededTransferLimit
    ));
  }

  async function fetchWildfirePages(options) {
    options = options || {};
    var urls = options.urls;
    var fetchPage = options.fetchPage;
    var pageSize = Math.max(1, Math.min(2000, Number(options.pageSize) || 2000));
    var maxPages = Math.max(1, Number(options.maxPages) || 100);
    if (!Array.isArray(urls) || !urls.length || typeof fetchPage !== 'function') {
      throw new TypeError('wildfire page URLs and fetch callback are required');
    }
    var features = [];
    var pageCount = 0;
    for (var urlIndex = 0; urlIndex < urls.length; urlIndex += 1) {
      var offset = 0;
      var complete = false;
      while (!complete) {
        if (pageCount >= maxPages) throw new Error('NIFC wildfire pagination exceeded the page cap');
        var pageUrl = new URL(urls[urlIndex]);
        pageUrl.searchParams.set('orderByFields', 'OBJECTID ASC');
        pageUrl.searchParams.set('resultOffset', String(offset));
        pageUrl.searchParams.set('resultRecordCount', String(pageSize));
        var payload = await fetchPage(pageUrl.toString(), options.signal);
        pageCount += 1;
        if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
          throw new TypeError('NIFC wildfire page is not GeoJSON');
        }
        features.push.apply(features, payload.features);
        complete = !transferLimitExceeded(payload);
        if (!complete && payload.features.length === 0) {
          throw new Error('NIFC wildfire pagination made no progress');
        }
        offset += payload.features.length;
      }
    }
    return {
      collection: normalizeWildfireCollection({ type: 'FeatureCollection', features: features }),
      pageCount: pageCount
    };
  }

  function buildWildfireQueries(bounds) {
    if (!bounds) throw new TypeError('map bounds are required');
    var south = Math.max(-90, Number(bounds.south));
    var north = Math.min(90, Number(bounds.north));
    var rawWest = Number(bounds.west);
    var rawEast = Number(bounds.east);
    if (![south, north, rawWest, rawEast].every(Number.isFinite) || south >= north) {
      throw new TypeError('map bounds are invalid');
    }
    if (rawEast - rawWest >= 360) return [envelopeUrl(-180, south, 180, north)];
    var west = normalizeLongitude(rawWest);
    var east = normalizeLongitude(rawEast);
    if (east >= west && rawEast <= 180 && rawWest >= -180) return [envelopeUrl(west, south, east, north)];
    return [envelopeUrl(west, south, 180, north), envelopeUrl(-180, south, east, north)];
  }

  function normalizeWildfireCollection(payload) {
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new TypeError('NIFC wildfire response is not GeoJSON');
    }
    var seen = Object.create(null);
    var features = payload.features.filter(function (feature) {
      var properties = feature && feature.properties;
      var geometry = feature && feature.geometry;
      if (!properties || properties.attr_IncidentTypeCategory !== 'WF' || !geometry ||
          ['Polygon', 'MultiPolygon'].indexOf(geometry.type) === -1) return false;
      var id = String(properties.OBJECTID == null ? JSON.stringify(geometry.coordinates) : properties.OBJECTID);
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    });
    return { type: 'FeatureCollection', features: features };
  }

  function parseWildfireMetadata(payload) {
    var timestamp = Number(payload && payload.editingInfo && (payload.editingInfo.dataLastEditDate || payload.editingInfo.lastEditDate));
    if (!Number.isFinite(timestamp)) throw new TypeError('NIFC wildfire metadata has no update timestamp');
    return { updatedAt: timestamp, maxRecordCount: Number(payload.maxRecordCount) || 2000 };
  }

  function freshness(updatedAt, staleMs, now) {
    var timestamp = Number(updatedAt);
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var ageMs = Math.max(0, current - timestamp);
    return { state: ageMs > staleMs ? 'stale' : 'fresh', ageMs: ageMs };
  }

  return Object.freeze({
    providers: providers,
    parseLightningCapabilities: parseLightningCapabilities,
    buildWildfireQueries: buildWildfireQueries,
    fetchWildfirePages: fetchWildfirePages,
    transferLimitExceeded: transferLimitExceeded,
    normalizeWildfireCollection: normalizeWildfireCollection,
    parseWildfireMetadata: parseWildfireMetadata,
    freshness: freshness
  });
});
