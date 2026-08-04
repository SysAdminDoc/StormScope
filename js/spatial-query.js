/* Bounded GeoJSON-to-camera proximity queries for incident context. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSpatialQuery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var HEALTH_RANK = Object.freeze({ healthy: 0, degraded: 1, unknown: 2 });
  var PLAYABLE_TYPES = ['hls', 'image', 'mjpeg', 'youtube'];

  function validPoint(value) {
    return Array.isArray(value) && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
  }

  function wrapLongitude(value) {
    var longitude = Number(value);
    while (longitude > 180) longitude -= 360;
    while (longitude < -180) longitude += 360;
    return longitude;
  }

  function longitudeDelta(left, right) {
    return wrapLongitude(Number(left) - Number(right));
  }

  function distanceKm(left, right) {
    var radians = Math.PI / 180;
    var lat1 = Number(left.lat) * radians;
    var lat2 = Number(right.lat) * radians;
    var deltaLat = (Number(right.lat) - Number(left.lat)) * radians;
    var deltaLon = longitudeDelta(right.lon, left.lon) * radians;
    var a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDegrees(origin, target) {
    var radians = Math.PI / 180;
    var lat1 = Number(origin.lat) * radians;
    var lat2 = Number(target.lat) * radians;
    var deltaLon = longitudeDelta(target.lon, origin.lon) * radians;
    var y = Math.sin(deltaLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return (Math.atan2(y, x) / radians + 360) % 360;
  }

  function pointInRing(point, ring) {
    var inside = false;
    for (var index = 0, prior = ring.length - 1; index < ring.length; prior = index++) {
      if (!validPoint(ring[index]) || !validPoint(ring[prior])) continue;
      var yi = Number(ring[index][1]);
      var yj = Number(ring[prior][1]);
      var xi = longitudeDelta(ring[index][0], point.lon);
      var xj = longitudeDelta(ring[prior][0], point.lon);
      var crosses = (yi > point.lat) !== (yj > point.lat) &&
        0 < (xj - xi) * (point.lat - yi) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(point, rings) {
    if (!Array.isArray(rings) || !rings.length || !pointInRing(point, rings[0])) return false;
    for (var index = 1; index < rings.length; index++) {
      if (pointInRing(point, rings[index])) return false;
    }
    return true;
  }

  function contains(geometry, point) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return false;
    if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.some(function (polygon) { return pointInPolygon(point, polygon); });
    }
    return false;
  }

  function coordinateSequences(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return [];
    if (geometry.type === 'Point') return [[geometry.coordinates]];
    if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return [geometry.coordinates];
    if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates;
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.reduce(function (rings, polygon) { return rings.concat(polygon); }, []);
    }
    return [];
  }

  function geometryBounds(geometry) {
    var coordinates = coordinateSequences(geometry).reduce(function (all, sequence) {
      return all.concat(sequence.filter(validPoint));
    }, []);
    if (!coordinates.length) return null;
    var anchor = Number(coordinates[0][0]);
    return coordinates.reduce(function (bounds, coordinate) {
      var longitude = anchor + longitudeDelta(coordinate[0], anchor);
      var latitude = Number(coordinate[1]);
      bounds.minLon = Math.min(bounds.minLon, longitude);
      bounds.maxLon = Math.max(bounds.maxLon, longitude);
      bounds.minLat = Math.min(bounds.minLat, latitude);
      bounds.maxLat = Math.max(bounds.maxLat, latitude);
      return bounds;
    }, { anchor: anchor, minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity });
  }

  function withinExpandedBounds(point, bounds, distance) {
    var latitudeExpansion = distance / 110.574;
    var edgeLatitude = Math.max(Math.abs(bounds.minLat), Math.abs(bounds.maxLat));
    var longitudeExpansion = distance / (111.32 * Math.max(0.1, Math.cos(edgeLatitude * Math.PI / 180)));
    var longitude = bounds.anchor + longitudeDelta(point.lon, bounds.anchor);
    return point.lat >= bounds.minLat - latitudeExpansion && point.lat <= bounds.maxLat + latitudeExpansion &&
      longitude >= bounds.minLon - longitudeExpansion && longitude <= bounds.maxLon + longitudeExpansion;
  }

  function project(coordinate, origin) {
    return {
      x: longitudeDelta(coordinate[0], origin.lon) * 111.32 * Math.cos(Number(origin.lat) * Math.PI / 180),
      y: (Number(coordinate[1]) - Number(origin.lat)) * 110.574
    };
  }

  function unproject(point, origin) {
    var scale = 111.32 * Math.cos(Number(origin.lat) * Math.PI / 180);
    return { lat: Number(origin.lat) + point.y / 110.574, lon: wrapLongitude(Number(origin.lon) + point.x / scale) };
  }

  function nearestOnSegment(left, right) {
    var dx = right.x - left.x;
    var dy = right.y - left.y;
    if (dx === 0 && dy === 0) return left;
    var ratio = Math.max(0, Math.min(1, -(left.x * dx + left.y * dy) / (dx * dx + dy * dy)));
    return { x: left.x + ratio * dx, y: left.y + ratio * dy };
  }

  function nearestGeometryPoint(geometry, point) {
    var sequences = coordinateSequences(geometry);
    var best = null;
    var bestDistance = Infinity;
    sequences.forEach(function (sequence) {
      for (var index = 0; index < sequence.length; index++) {
        if (!validPoint(sequence[index])) continue;
        var left = project(sequence[index], point);
        var right = index + 1 < sequence.length && validPoint(sequence[index + 1])
          ? project(sequence[index + 1], point) : left;
        var candidate = nearestOnSegment(left, right);
        var candidateDistance = Math.sqrt(candidate.x * candidate.x + candidate.y * candidate.y);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          best = candidate;
        }
      }
    });
    return best ? { point: unproject(best, point), distanceKm: bestDistance } : null;
  }

  function queryCameras(cameras, geometry, options) {
    options = options || {};
    var maxDistanceKm = Math.max(0, Math.min(500, Number(options.maxDistanceKm) || 80));
    var limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
    if (!geometry || !Array.isArray(cameras)) return [];
    var bounds = geometryBounds(geometry);
    if (!bounds) return [];
    return cameras.map(function (camera) {
      if (!camera || camera.health === 'offline') return null;
      var point = { lat: Number(camera && camera.lat), lon: Number(camera && camera.lon) };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
      if (!withinExpandedBounds(point, bounds, maxDistanceKm)) return null;
      var nearest = nearestGeometryPoint(geometry, point);
      if (!nearest) return null;
      var inside = contains(geometry, point) || nearest.distanceKm <= 0.001;
      var relationDistance = inside ? 0 : nearest.distanceKm;
      if (relationDistance > maxDistanceKm) return null;
      return {
        camera: camera,
        relation: inside ? 'inside' : 'nearby',
        inside: inside,
        distanceKm: relationDistance,
        bearing: inside ? null : bearingDegrees(nearest.point, point),
        verification: camera.health === 'healthy' && camera.last_verified ? 'verified'
          : camera.health === 'degraded' && camera.last_verified ? 'degraded' : 'unknown',
        verifiedAt: camera.last_verified || null,
        playable: PLAYABLE_TYPES.indexOf(String(camera.type || '').toLowerCase()) !== -1,
        healthRank: HEALTH_RANK[camera.health] == null ? 3 : HEALTH_RANK[camera.health]
      };
    }).filter(Boolean).sort(function (left, right) {
      return left.healthRank - right.healthRank || Number(right.inside) - Number(left.inside) ||
        left.distanceKm - right.distanceKm || String(right.verifiedAt || '').localeCompare(String(left.verifiedAt || '')) ||
        String(left.camera.name || '').localeCompare(String(right.camera.name || ''), undefined, { sensitivity: 'base' }) ||
        Number(left.camera.id || 0) - Number(right.camera.id || 0);
    }).slice(0, limit);
  }

  function lineLengthKm(line) {
    if (!Array.isArray(line) || line.length < 2) return 0;
    var length = 0;
    for (var index = 1; index < line.length; index += 1) {
      if (!validPoint(line[index - 1]) || !validPoint(line[index])) continue;
      length += distanceKm({ lat: line[index - 1][1], lon: line[index - 1][0] }, {
        lat: line[index][1], lon: line[index][0]
      });
    }
    return Number(length.toFixed(3));
  }

  function projectRoute(line, point) {
    if (!Array.isArray(line) || line.length < 2 || !point ||
        !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lon))) return null;
    var best = null;
    var cumulative = 0;
    var totalLength = lineLengthKm(line);
    for (var index = 0; index < line.length - 1; index += 1) {
      if (!validPoint(line[index]) || !validPoint(line[index + 1])) continue;
      var leftCoordinate = { lat: Number(line[index][1]), lon: Number(line[index][0]) };
      var rightCoordinate = { lat: Number(line[index + 1][1]), lon: Number(line[index + 1][0]) };
      var left = project(line[index], point);
      var right = project(line[index + 1], point);
      var candidate = nearestOnSegment(left, right);
      var segmentLength = distanceKm(leftCoordinate, rightCoordinate);
      var candidateGeo = unproject(candidate, point);
      var candidateDistance = Math.sqrt(candidate.x * candidate.x + candidate.y * candidate.y);
      var along = cumulative + distanceKm(leftCoordinate, candidateGeo);
      if (!best || candidateDistance < best.distanceKm) {
        best = {
          point: candidateGeo,
          distanceKm: candidateDistance,
          routeDistanceKm: along,
          segmentIndex: index,
          bearing: bearingDegrees(leftCoordinate, rightCoordinate)
        };
      }
      cumulative += segmentLength;
    }
    if (!best) return null;
    best.distanceKm = Number(best.distanceKm.toFixed(3));
    best.routeDistanceKm = Number(best.routeDistanceKm.toFixed(3));
    best.progress = totalLength ? Math.max(0, Math.min(1, best.routeDistanceKm / totalLength)) : 0;
    return best;
  }

  function orientation(left, right, point) {
    var value = (right.y - left.y) * (point.x - right.x) - (right.x - left.x) * (point.y - right.y);
    if (Math.abs(value) < 1e-9) return 0;
    return value > 0 ? 1 : 2;
  }

  function onSegment(left, right, point) {
    return point.x >= Math.min(left.x, right.x) - 1e-9 && point.x <= Math.max(left.x, right.x) + 1e-9 &&
      point.y >= Math.min(left.y, right.y) - 1e-9 && point.y <= Math.max(left.y, right.y) + 1e-9;
  }

  function segmentsIntersect(left, right, otherLeft, otherRight) {
    var first = orientation(left, right, otherLeft);
    var second = orientation(left, right, otherRight);
    var third = orientation(otherLeft, otherRight, left);
    var fourth = orientation(otherLeft, otherRight, right);
    if (first !== second && third !== fourth) return true;
    return (first === 0 && onSegment(left, right, otherLeft)) ||
      (second === 0 && onSegment(left, right, otherRight)) ||
      (third === 0 && onSegment(otherLeft, otherRight, left)) ||
      (fourth === 0 && onSegment(otherLeft, otherRight, right));
  }

  function routeSegmentsIntersect(line, sequence) {
    if (!Array.isArray(sequence) || sequence.length < 2) return false;
    var origin = { lat: Number(line[0][1]), lon: Number(line[0][0]) };
    for (var index = 0; index < line.length - 1; index += 1) {
      if (!validPoint(line[index]) || !validPoint(line[index + 1])) continue;
      var left = project(line[index], origin);
      var right = project(line[index + 1], origin);
      for (var otherIndex = 0; otherIndex < sequence.length - 1; otherIndex += 1) {
        if (!validPoint(sequence[otherIndex]) || !validPoint(sequence[otherIndex + 1])) continue;
        var otherLeft = project(sequence[otherIndex], origin);
        var otherRight = project(sequence[otherIndex + 1], origin);
        if (segmentsIntersect(left, right, otherLeft, otherRight)) return true;
      }
    }
    return false;
  }

  function intersectsRouteCorridor(line, geometry, maxDistanceKm) {
    var width = Math.max(0, Math.min(500, Number(maxDistanceKm) || 0));
    if (!Array.isArray(line) || line.length < 2 || !geometry) return false;
    var routeGeometry = { type: 'LineString', coordinates: line };
    var routePoint = function (coordinate) {
      return { lat: Number(coordinate[1]), lon: Number(coordinate[0]) };
    };
    if (coordinateSequences(geometry).some(function (sequence) {
      return sequence.some(function (coordinate) {
        return validPoint(coordinate) && contains(geometry, routePoint(coordinate));
      });
    })) return true;
    if (line.some(function (coordinate) {
      return validPoint(coordinate) && contains(geometry, routePoint(coordinate));
    })) return true;
    if (coordinateSequences(geometry).some(function (sequence) {
      return sequence.some(function (coordinate) {
        if (!validPoint(coordinate)) return false;
        var nearest = nearestGeometryPoint(routeGeometry, routePoint(coordinate));
        return nearest && nearest.distanceKm <= width;
      });
    })) return true;
    return coordinateSequences(geometry).some(function (sequence) { return routeSegmentsIntersect(line, sequence); });
  }

  function queryRouteCameras(cameras, line, options) {
    options = options || {};
    var maxDistanceKm = Math.max(0.1, Math.min(500, Number(options.maxDistanceKm) || 10));
    var limit = Math.max(1, Math.min(20, Number(options.limit) || 12));
    if (!Array.isArray(cameras) || !Array.isArray(line) || line.length < 2) return [];
    var routeGeometry = { type: 'LineString', coordinates: line };
    var bounds = geometryBounds(routeGeometry);
    if (!bounds) return [];
    var verifiedOnly = options.verifiedOnly !== false;
    return cameras.map(function (camera) {
      if (!camera || camera.health === 'offline' || (verifiedOnly && (camera.health !== 'healthy' || !camera.last_verified))) return null;
      var point = { lat: Number(camera.lat), lon: Number(camera.lon) };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !withinExpandedBounds(point, bounds, maxDistanceKm)) return null;
      var projection = projectRoute(line, point);
      if (!projection || projection.distanceKm > maxDistanceKm) return null;
      return {
        camera: camera,
        distanceKm: projection.distanceKm,
        routeDistanceKm: projection.routeDistanceKm,
        routeProgress: projection.progress,
        routeBearing: projection.bearing,
        verification: 'verified',
        playable: PLAYABLE_TYPES.indexOf(String(camera.type || '').toLowerCase()) !== -1
      };
    }).filter(Boolean).sort(function (left, right) {
      return left.routeDistanceKm - right.routeDistanceKm || left.distanceKm - right.distanceKm ||
        String(left.camera.name || '').localeCompare(String(right.camera.name || ''), undefined, { sensitivity: 'base' }) ||
        String(left.camera.id || '').localeCompare(String(right.camera.id || ''));
    }).slice(0, limit);
  }

  function monitorCandidates(results, minimum, maximum) {
    var min = Number.isInteger(minimum) ? minimum : 2;
    var max = Number.isInteger(maximum) ? maximum : 4;
    if (!Array.isArray(results)) return [];
    var cameras = results.filter(function (result) { return result.playable; }).slice(0, max)
      .map(function (result) { return result.camera; });
    return cameras.length < min ? [] : cameras;
  }

  return Object.freeze({
    HEALTH_RANK: HEALTH_RANK,
    bearingDegrees: bearingDegrees,
    contains: contains,
    distanceKm: distanceKm,
    intersectsRouteCorridor: intersectsRouteCorridor,
    lineLengthKm: lineLengthKm,
    monitorCandidates: monitorCandidates,
    nearestGeometryPoint: nearestGeometryPoint,
    projectRoute: projectRoute,
    queryCameras: queryCameras,
    queryRouteCameras: queryRouteCameras
  });
});
