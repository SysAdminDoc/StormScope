/* Keyless official satellite, lightning, and wildfire context-provider contracts. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeContextLayers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var LIGHTNING_CAPABILITIES = 'https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities';
  var LIGHTNING_WMS = 'https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows';
  var WILDFIRE_LAYER = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0';
  var GOES_IMAGE_SERVER = 'https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGEDGC_Last_24hr/ImageServer';
  var NOHRSC_SNOW_IMAGE_SERVER = 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer';
  var NOHRSC_SNOW_BOUNDS = Object.freeze({ west: -130.5166666666, south: 24.1000104152, east: -62.2500027306, north: 58.2333423832 });
  var GOES_MAX_FRAMES = 12;
  var GOES_MIN_FRAME_INTERVAL_MS = 10 * 60 * 1000;
  var providers = Object.freeze({
    satellite: Object.freeze({
      id: 'satellite', label: 'NOAA NESDIS merged GOES GeoColor', defaultVisible: false,
      imageServerUrl: GOES_IMAGE_SERVER, refreshMs: 10 * 60 * 1000, staleMs: 35 * 60 * 1000,
      maxFrames: GOES_MAX_FRAMES, minFrameIntervalMs: GOES_MIN_FRAME_INTERVAL_MS,
      coverage: '76.5°S–76.5°N, merged GOES East and West',
      attribution: Object.freeze({ text: 'NOAA NESDIS GeoColor', url: 'https://www.nesdis.noaa.gov/imagery/interactive-maps' })
    }),
    snow: Object.freeze({
      id: 'snow', label: 'NOAA NOHRSC snow depth analysis', defaultVisible: false,
      imageServerUrl: NOHRSC_SNOW_IMAGE_SERVER, refreshMs: 30 * 60 * 1000, staleMs: 2 * 60 * 60 * 1000,
      coverage: 'CONUS snow depth analysis', coverageBounds: NOHRSC_SNOW_BOUNDS,
      attribution: Object.freeze({ text: 'NOAA NOHRSC', url: 'https://www.nohrsc.noaa.gov/nsa/' })
    }),
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

  function buildGoesFrameTimes(startTime, endTime, options) {
    var start = Number(startTime);
    var end = Number(endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      throw new TypeError('GOES time extent is invalid');
    }
    if (start === end) return [end];
    options = options || {};
    var maxFrames = Number.isInteger(options.maxFrames) && options.maxFrames >= 2
      ? Math.min(24, options.maxFrames) : GOES_MAX_FRAMES;
    var minimumInterval = Number.isFinite(Number(options.minFrameIntervalMs)) && Number(options.minFrameIntervalMs) > 0
      ? Number(options.minFrameIntervalMs) : GOES_MIN_FRAME_INTERVAL_MS;
    var frameCount = Math.max(2, Math.min(maxFrames, Math.floor((end - start) / minimumInterval) + 1));
    var step = (end - start) / (frameCount - 1);
    var times = [];
    for (var index = 0; index < frameCount; index += 1) {
      times.push(Math.round(start + step * index));
    }
    times[times.length - 1] = end;
    return times.filter(function (time, index) { return index === 0 || time > times[index - 1]; });
  }

  function normalizeLongitude(value) {
    var longitude = Number(value);
    while (longitude < -180) longitude += 360;
    while (longitude > 180) longitude -= 360;
    return longitude;
  }

  function parseGoesMetadata(payload) {
    var extent = payload && payload.timeInfo && payload.timeInfo.timeExtent;
    if (!Array.isArray(extent) || !Number.isFinite(Number(extent[0])) || !Number.isFinite(Number(extent[1]))) {
      throw new TypeError('NOAA GOES metadata has no latest frame time');
    }
    var frameTimes = buildGoesFrameTimes(extent[0], extent[1], {
      maxFrames: providers.satellite.maxFrames,
      minFrameIntervalMs: providers.satellite.minFrameIntervalMs
    });
    return {
      earliestTime: Number(extent[0]), latestTime: Number(extent[1]),
      frameCount: frameTimes.length, frameTimes: frameTimes,
      coverage: providers.satellite.coverage
    };
  }

  function goesRequest(west, south, east, north, latestTime, viewport) {
    var width = Math.max(320, Math.min(1200, Math.round(Number(viewport && viewport.width) || 1024)));
    var height = Math.max(240, Math.min(900, Math.round(Number(viewport && viewport.height) || 768)));
    var parameters = new URLSearchParams({
      f: 'image', bbox: [west, south, east, north].join(','), bboxSR: '4326', imageSR: '4326',
      size: width + ',' + height, format: 'png32', transparent: 'true',
      interpolation: 'RSP_BilinearInterpolation', time: String(latestTime)
    });
    return {
      bounds: [[south, west], [north, east]],
      url: providers.satellite.imageServerUrl + '/exportImage?' + parameters.toString()
    };
  }

  function buildGoesExportRequests(bounds, latestTime, viewport) {
    if (!bounds || !Number.isFinite(Number(latestTime))) throw new TypeError('GOES bounds and frame time are required');
    var south = Math.max(-76.49, Number(bounds.south));
    var north = Math.min(76.45, Number(bounds.north));
    var rawWest = Number(bounds.west);
    var rawEast = Number(bounds.east);
    if (![south, north, rawWest, rawEast].every(Number.isFinite) || south >= north) {
      throw new TypeError('GOES map bounds are invalid or outside coverage');
    }
    if (rawEast - rawWest >= 360) return [goesRequest(-180, south, 180, north, latestTime, viewport)];
    var west = normalizeLongitude(rawWest);
    var east = normalizeLongitude(rawEast);
    if (east >= west && rawEast <= 180 && rawWest >= -180) {
      return [goesRequest(west, south, east, north, latestTime, viewport)];
    }
    return [goesRequest(west, south, 180, north, latestTime, viewport),
      goesRequest(-180, south, east, north, latestTime, viewport)];
  }

  function buildSnowExportRequest(bounds, viewport) {
    if (!bounds) throw new TypeError('snow map bounds are required');
    var rawWest = Number(bounds.west);
    var rawEast = Number(bounds.east);
    var rawSouth = Number(bounds.south);
    var rawNorth = Number(bounds.north);
    if (![rawWest, rawEast, rawSouth, rawNorth].every(Number.isFinite) || rawSouth >= rawNorth) {
      throw new TypeError('snow map bounds are invalid');
    }
    var coverage = providers.snow.coverageBounds;
    var south = Math.max(coverage.south, rawSouth, -90);
    var north = Math.min(coverage.north, rawNorth, 90);
    var west = rawEast - rawWest >= 360 ? coverage.west : Math.max(coverage.west, rawWest);
    var east = rawEast - rawWest >= 360 ? coverage.east : Math.min(coverage.east, rawEast);
    if (south >= north || west >= east) return null;
    var width = Math.max(320, Math.min(1200, Math.round(Number(viewport && viewport.width) || 1024)));
    var height = Math.max(240, Math.min(900, Math.round(Number(viewport && viewport.height) || 768)));
    var parameters = new URLSearchParams({
      bbox: [west, south, east, north].join(','), bboxSR: '4326', imageSR: '4326',
      size: width + ',' + height, format: 'png32', transparent: 'true', layers: 'show:0', f: 'image'
    });
    return {
      bounds: [[south, west], [north, east]],
      url: providers.snow.imageServerUrl + '/export?' + parameters.toString()
    };
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
    parseGoesMetadata: parseGoesMetadata,
    buildGoesFrameTimes: buildGoesFrameTimes,
    buildGoesExportRequests: buildGoesExportRequests,
    buildSnowExportRequest: buildSnowExportRequest,
    parseLightningCapabilities: parseLightningCapabilities,
    buildWildfireQueries: buildWildfireQueries,
    fetchWildfirePages: fetchWildfirePages,
    transferLimitExceeded: transferLimitExceeded,
    normalizeWildfireCollection: normalizeWildfireCollection,
    parseWildfireMetadata: parseWildfireMetadata,
    freshness: freshness
  });
});
