/* Bounded client-side solar position and night-side polygon math. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeSolarTerminator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var JULIAN_UNIX_EPOCH = 2440587.5;
  var JULIAN_J2000 = 2451545;
  var DEFAULT_SEGMENTS = 72;
  var MIN_SEGMENTS = 24;
  var MAX_SEGMENTS = 180;
  var DEG_TO_RAD = Math.PI / 180;
  var RAD_TO_DEG = 180 / Math.PI;

  function finiteTimestamp(value) {
    var timestamp = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(timestamp)) throw new TypeError('solar timestamp must be finite');
    return timestamp;
  }

  function normalizeDegrees(value) {
    var normalized = value % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  function signedDegrees(value) {
    var normalized = normalizeDegrees(value);
    return normalized > 180 ? normalized - 360 : normalized;
  }

  function solarPosition(value) {
    var timestamp = finiteTimestamp(value);
    var julianDay = timestamp / 86400000 + JULIAN_UNIX_EPOCH;
    var days = julianDay - JULIAN_J2000;
    var meanLongitude = normalizeDegrees(280.460 + 0.9856474 * days);
    var meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * days) * DEG_TO_RAD;
    var eclipticLongitude = normalizeDegrees(meanLongitude + 1.915 * Math.sin(meanAnomaly) +
      0.020 * Math.sin(2 * meanAnomaly));
    var eclipticRadians = eclipticLongitude * DEG_TO_RAD;
    var obliquity = (23.439 - 0.0000004 * days) * DEG_TO_RAD;
    var rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticRadians),
      Math.cos(eclipticRadians)) * RAD_TO_DEG;
    var declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticRadians)) * RAD_TO_DEG;
    var centuries = days / 36525;
    var greenwichSiderealTime = normalizeDegrees(280.46061837 + 360.98564736629 * days +
      0.000387933 * centuries * centuries - centuries * centuries * centuries / 38710000);
    var longitude = signedDegrees(rightAscension - greenwichSiderealTime);
    return {
      timestamp: timestamp,
      latitude: declination,
      longitude: longitude
    };
  }

  function illuminationCosine(latitude, longitude, position) {
    var latitudeRadians = Number(latitude) * DEG_TO_RAD;
    var declinationRadians = position.latitude * DEG_TO_RAD;
    var hourAngleRadians = signedDegrees(Number(longitude) - position.longitude) * DEG_TO_RAD;
    return Math.sin(latitudeRadians) * Math.sin(declinationRadians) +
      Math.cos(latitudeRadians) * Math.cos(declinationRadians) * Math.cos(hourAngleRadians);
  }

  function terminatorLatitude(longitude, position) {
    var declinationTangent = Math.tan(position.latitude * DEG_TO_RAD);
    var hourAngleCosine = Math.cos(signedDegrees(Number(longitude) - position.longitude) * DEG_TO_RAD);
    if (Math.abs(declinationTangent) < 1e-8 && Math.abs(hourAngleCosine) < 1e-8) return 0;
    if (Math.abs(declinationTangent) < 1e-8) return hourAngleCosine > 0 ? -90 : 90;
    return Math.atan(-hourAngleCosine / declinationTangent) * RAD_TO_DEG;
  }

  function segmentCount(value) {
    var requested = value == null ? DEFAULT_SEGMENTS : Number(value);
    if (!Number.isFinite(requested)) throw new TypeError('terminator segments must be finite');
    return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.round(requested)));
  }

  function buildTerminatorRing(value, options) {
    var position = solarPosition(value);
    var segments = segmentCount(options && options.segments);
    var ring = [];
    for (var index = 0; index <= segments; index += 1) {
      var longitude = -180 + index * 360 / segments;
      ring.push([terminatorLatitude(longitude, position), longitude]);
    }
    return { position: position, ring: ring };
  }

  function buildNightPolygon(value, options) {
    var result = buildTerminatorRing(value, options);
    var ring = result.ring.slice();
    var darkPole = result.position.latitude < 0 ? 90 : -90;
    ring.push([darkPole, 180], [darkPole, -180]);
    return ring;
  }

  return Object.freeze({
    DEFAULT_SEGMENTS: DEFAULT_SEGMENTS,
    MIN_SEGMENTS: MIN_SEGMENTS,
    MAX_SEGMENTS: MAX_SEGMENTS,
    solarPosition: solarPosition,
    illuminationCosine: illuminationCosine,
    terminatorLatitude: terminatorLatitude,
    buildTerminatorRing: buildTerminatorRing,
    buildNightPolygon: buildNightPolygon
  });
});
