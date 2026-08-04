/* Keyless USGS earthquake feed contract (static GeoJSON, CORS: *). */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeEarthquakes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
  var DETAIL_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/';
  var PRODUCT_BASE = 'https://earthquake.usgs.gov/pdl/products/';
  var MAGNITUDES = ['significant', '4.5', '2.5', '1.0', 'all'];
  var PERIODS = ['hour', 'day', 'week', 'month'];
  var MAX_INTENSITY_FEATURES = 500;
  var MAX_DETAIL_BYTES = 2 * 1024 * 1024;
  var MAX_PRODUCT_BYTES = 4 * 1024 * 1024;

  var provider = Object.freeze({
    id: 'earthquakes',
    label: 'USGS earthquakes',
    defaultVisible: false,
    defaultMagnitude: '2.5',
    defaultPeriod: 'day',
    magnitudes: Object.freeze(MAGNITUDES.slice()),
    periods: Object.freeze(PERIODS.slice()),
    refreshMs: 5 * 60 * 1000,
    // USGS updates the summary feeds every minute; treat a snapshot older than
    // one refresh interval plus slack as stale.
    staleMs: 15 * 60 * 1000,
    attribution: Object.freeze({
      text: 'USGS Earthquake Hazards Program',
      url: 'https://earthquake.usgs.gov/earthquakes/map/'
    }),
    intensityMaxFeatures: MAX_INTENSITY_FEATURES,
    intensityProducts: Object.freeze(['shakemap', 'dyfi'])
  });

  function boundedText(value, maximum) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, maximum || 320);
  }

  function finiteNumber(value, minimum, maximum) {
    if (value == null || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
  }

  function timestampMs(value) {
    if (value == null || value === '') return null;
    var number = Number(value);
    if (Number.isFinite(number)) {
      if (number > 0 && number < 100000000000) number *= 1000;
      return number > 0 ? number : null;
    }
    var parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function eventId(value) {
    var id = boundedText(value, 80);
    return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : '';
  }

  function officialUrl(value, prefix) {
    var candidate = boundedText(value, 500);
    if (!candidate) return '';
    try {
      var parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && parsed.hostname === 'earthquake.usgs.gov' &&
          parsed.pathname.indexOf(prefix) === 0) return parsed.href;
    } catch (error) { /* malformed provider text stays unavailable */ }
    return '';
  }

  function detailUrl(value) {
    var url = officialUrl(value, '/earthquakes/feed/v1.0/detail/');
    return url && /\.geojson$/.test(new URL(url).pathname) ? url : '';
  }

  function productUrl(value) {
    var candidate = boundedText(value, 800);
    if (!candidate) return '';
    try {
      var parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && parsed.hostname === 'earthquake.usgs.gov' &&
          parsed.pathname.indexOf('/pdl/products/') === 0) return parsed.href;
    } catch (error) { /* malformed product text stays unavailable */ }
    return '';
  }

  function assertChoice(value, allowed, label) {
    var text = String(value == null ? '' : value).trim().toLowerCase();
    if (allowed.indexOf(text) === -1) throw new TypeError(label + ' is unsupported');
    return text;
  }

  function buildFeedUrl(magnitude, period) {
    var mag = assertChoice(magnitude, MAGNITUDES, 'earthquake magnitude');
    var span = assertChoice(period, PERIODS, 'earthquake period');
    return FEED_BASE + mag + '_' + span + '.geojson';
  }

  function normalizeCollection(payload) {
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new TypeError('USGS earthquake response is not GeoJSON');
    }
    var seen = Object.create(null);
    var features = [];
    payload.features.forEach(function (feature) {
      var geometry = feature && feature.geometry;
      var properties = feature && feature.properties;
      if (!geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return;
      var lon = Number(geometry.coordinates[0]);
      var lat = Number(geometry.coordinates[1]);
      var depthKm = Number(geometry.coordinates[2]);
      var mag = Number(properties && properties.mag);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(mag)) return;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
      var id = String(feature.id == null ? lon + ',' + lat + ',' + mag : feature.id);
      if (seen[id]) return;
      seen[id] = true;
      var time = Number(properties && properties.time);
      var detail = detailUrl(properties && properties.detail);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          id: id,
          mag: mag,
          place: boundedText(properties && properties.place, 240),
          depthKm: Number.isFinite(depthKm) ? depthKm : null,
          time: Number.isFinite(time) ? time : null,
          url: boundedText(properties && properties.url, 500),
          detailUrl: detail,
          significant: mag >= 4.5
        }
      });
    });
    var generatedAt = Number(payload.metadata && payload.metadata.generated);
    return {
      collection: { type: 'FeatureCollection', features: features },
      generatedAt: Number.isFinite(generatedAt) ? generatedAt : null,
      count: features.length
    };
  }

  function contentUrl(contents, names) {
    if (!contents || typeof contents !== 'object' || Array.isArray(contents)) return '';
    for (var index = 0; index < names.length; index += 1) {
      var entry = contents[names[index]];
      var url = productUrl(entry && typeof entry === 'object' ? entry.url : entry);
      if (url) return url;
    }
    return '';
  }

  function productDescriptor(kind, products) {
    var values = products && Array.isArray(products[kind]) ? products[kind] : [];
    var names = kind === 'shakemap'
      ? ['download/cont_mmi.json', 'download/cont_mi.json', 'cont_mmi.json', 'cont_mi.json']
      : ['dyfi_geo_10km.geojson', 'dyfi_geo_1km.geojson', 'dyfi_geo.geojson'];
    var candidates = values.map(function (product) {
      if (!product || typeof product !== 'object' || String(product.status || '').toUpperCase() === 'DELETE') return null;
      var url = contentUrl(product.contents, names);
      if (!url) return null;
      return {
        kind: kind,
        url: url,
        issuedAt: timestampMs(product.updateTime) || timestampMs(product.indexTime),
        preferredWeight: finiteNumber(product.preferredWeight, -100000, 100000) || 0,
        source: boundedText(product.source, 40),
        code: boundedText(product.code, 80)
      };
    }).filter(Boolean);
    candidates.sort(function (left, right) {
      return right.preferredWeight - left.preferredWeight || Number(right.issuedAt || 0) - Number(left.issuedAt || 0);
    });
    return candidates[0] || null;
  }

  function normalizeDetail(payload) {
    if (!payload || payload.type !== 'Feature' || !payload.properties ||
        typeof payload.properties !== 'object' || Array.isArray(payload.properties)) {
      throw new TypeError('USGS earthquake detail is invalid');
    }
    var properties = payload.properties;
    var id = eventId(payload.id || properties.code);
    if (!id) throw new TypeError('USGS earthquake detail ID is invalid');
    var products = properties.products;
    if (!products || typeof products !== 'object' || Array.isArray(products)) products = {};
    return {
      eventId: id,
      eventUrl: officialUrl(properties.url, '/earthquakes/eventpage/') || 'https://earthquake.usgs.gov/earthquakes/map/',
      issuedAt: timestampMs(properties.updated) || timestampMs(properties.time),
      felt: finiteNumber(properties.felt, 0, 1000000),
      maxMmi: finiteNumber(properties.mmi, 0, 12),
      maxCdi: finiteNumber(properties.cdi, 0, 12),
      products: ['shakemap', 'dyfi'].map(function (kind) { return productDescriptor(kind, products); }).filter(Boolean)
    };
  }

  function coordinateValid(value, depth) {
    if (!Array.isArray(value) || !value.length || depth > 5) return false;
    if (typeof value[0] === 'number') {
      return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
        value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
    }
    return value.every(function (child) { return coordinateValid(child, depth + 1); });
  }

  function stripMarkup(value) {
    return boundedText(value, 180).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeIntensityCollection(payload, descriptor) {
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features) ||
        payload.features.length > MAX_INTENSITY_FEATURES) {
      throw new TypeError('USGS intensity response is invalid');
    }
    if (!descriptor || ['shakemap', 'dyfi'].indexOf(descriptor.kind) === -1 || !eventId(descriptor.eventId)) {
      throw new TypeError('USGS intensity descriptor is invalid');
    }
    var allowedGeometry = descriptor.kind === 'shakemap'
      ? ['LineString', 'MultiLineString'] : ['Polygon', 'MultiPolygon'];
    var features = payload.features.map(function (feature, index) {
      if (!feature || feature.type !== 'Feature' || !feature.geometry ||
          allowedGeometry.indexOf(feature.geometry.type) === -1 ||
          !coordinateValid(feature.geometry.coordinates, 0) || !feature.properties ||
          typeof feature.properties !== 'object' || Array.isArray(feature.properties)) return null;
      var source = feature.properties;
      var intensity = descriptor.kind === 'shakemap'
        ? finiteNumber(source.value, 0, 12) : finiteNumber(source.cdi, 0, 12);
      if (intensity == null) return null;
      return {
        type: 'Feature',
        id: descriptor.eventId + '-' + descriptor.kind + '-' + index,
        geometry: feature.geometry,
        properties: {
          kind: descriptor.kind,
          eventId: descriptor.eventId,
          intensity: intensity,
          responses: descriptor.kind === 'dyfi' ? finiteNumber(source.nresp, 0, 1000000) : null,
          distanceKm: descriptor.kind === 'dyfi' ? finiteNumber(source.dist, 0, 100000) : null,
          place: descriptor.kind === 'dyfi' ? stripMarkup(source.name) : '',
          issuedAt: descriptor.issuedAt,
          sourceLabel: descriptor.kind === 'shakemap' ? 'USGS ShakeMap' : 'USGS Did You Feel It?',
          sourceUrl: descriptor.url
        }
      };
    }).filter(Boolean);
    return {
      kind: descriptor.kind,
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      updatedAt: descriptor.issuedAt
    };
  }

  function mergeIntensityCollections(results) {
    var seen = Object.create(null);
    var features = [];
    (results || []).forEach(function (result) {
      var candidates = result && result.collection && result.collection.features;
      if (!Array.isArray(candidates)) return;
      candidates.forEach(function (feature) {
        if (!feature || !feature.id || seen[feature.id] || features.length >= MAX_INTENSITY_FEATURES) return;
        seen[feature.id] = true;
        features.push(feature);
      });
    });
    var kinds = Object.create(null);
    features.forEach(function (feature) { kinds[feature.properties.kind] = true; });
    return {
      collection: { type: 'FeatureCollection', features: features },
      count: features.length,
      productCount: Object.keys(kinds).length,
      updatedAt: features.reduce(function (latest, feature) {
        var value = Number(feature.properties.issuedAt);
        return Number.isFinite(value) && (latest == null || value > latest) ? value : latest;
      }, null)
    };
  }

  function intensityColor(value) {
    var intensity = Number(value);
    if (intensity >= 8) return '#8e2de2';
    if (intensity >= 7) return '#d6336c';
    if (intensity >= 6) return '#e8590c';
    if (intensity >= 5) return '#f59f00';
    if (intensity >= 4) return '#94d82d';
    return '#22b8cf';
  }

  function intensityStyle(properties) {
    properties = properties || {};
    var color = intensityColor(properties.intensity);
    return {
      color: color,
      weight: Math.max(1, Math.min(5, Math.round(Number(properties.intensity) || 1))),
      opacity: 0.9,
      fillColor: color,
      fillOpacity: properties.kind === 'dyfi' ? 0.24 : 0
    };
  }

  // Marker radius grows with magnitude but is clamped so a swarm of small
  // quakes stays readable and a great quake does not blanket the map.
  function markerRadius(magnitude) {
    var mag = Number(magnitude);
    if (!Number.isFinite(mag)) return 4;
    return Math.max(3, Math.min(18, 3 + mag * 2));
  }

  // Warmer colors for stronger quakes; deterministic thresholds only.
  function markerColor(magnitude) {
    var mag = Number(magnitude);
    if (mag >= 6) return '#d6336c';
    if (mag >= 4.5) return '#f76707';
    if (mag >= 2.5) return '#f59f00';
    return '#74b816';
  }

  function freshness(generatedAt, staleMs, now) {
    if (generatedAt == null) return { state: 'unknown', ageMs: null };
    var timestamp = Number(generatedAt);
    var current = Number(now == null ? Date.now() : now);
    if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMs: null };
    var ageMs = Math.max(0, current - timestamp);
    return { state: ageMs > staleMs ? 'stale' : 'fresh', ageMs: ageMs };
  }

  return Object.freeze({
    provider: provider,
    MAGNITUDES: Object.freeze(MAGNITUDES.slice()),
    PERIODS: Object.freeze(PERIODS.slice()),
    buildFeedUrl: buildFeedUrl,
    normalizeCollection: normalizeCollection,
    detailUrl: detailUrl,
    productUrl: productUrl,
    normalizeDetail: normalizeDetail,
    normalizeIntensityCollection: normalizeIntensityCollection,
    mergeIntensityCollections: mergeIntensityCollections,
    intensityColor: intensityColor,
    intensityStyle: intensityStyle,
    MAX_INTENSITY_FEATURES: MAX_INTENSITY_FEATURES,
    MAX_DETAIL_BYTES: MAX_DETAIL_BYTES,
    MAX_PRODUCT_BYTES: MAX_PRODUCT_BYTES,
    markerRadius: markerRadius,
    markerColor: markerColor,
    freshness: freshness
  });
});
