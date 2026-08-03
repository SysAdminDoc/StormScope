(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeWeather = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var US_REGIONS = new Set([
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
    'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
    'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
    'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
    'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
    'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
    'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
    'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
    'District of Columbia', 'DC', 'Puerto Rico', 'U.S. Virgin Islands',
    'Virgin Islands, U.S.', 'Guam', 'American Samoa', 'Northern Mariana Islands'
  ]);

  function inNwsCoverageBounds(lat, lon) {
    return lat >= 24.3 && lat <= 49.5 && lon >= -125 && lon <= -66.5 ||
      lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129 ||
      lat >= 18.5 && lat <= 22.5 && lon >= -161 && lon <= -154.5 ||
      lat >= 17.5 && lat <= 18.7 && lon >= -67.5 && lon <= -64.5 ||
      lat >= 13.1 && lat <= 13.8 && lon >= 144.5 && lon <= 145 ||
      lat >= 17.6 && lat <= 18.5 && lon >= -65.2 && lon <= -64.5;
  }

  function shouldUseNws(camera) {
    var region = String(camera.state || camera.country || '').trim();
    if (US_REGIONS.has(region)) return true;
    if (region) return false;
    return inNwsCoverageBounds(Number(camera.lat), Number(camera.lon));
  }

  function normalizeUnits(value, locale) {
    if (value === 'metric' || value === 'us') return value;
    return String(locale || '').toLowerCase().startsWith('en-us') ? 'us' : 'metric';
  }

  function temperatureFromFahrenheit(value, units) {
    var number = Number(value);
    return units === 'metric' ? Math.round((number - 32) * 5 / 9) + '°C' : Math.round(number) + '°F';
  }

  function temperatureFromCelsius(value, units) {
    if (value == null) return null;
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    return units === 'metric' ? Math.round(number) + '°C' : Math.round(number * 9 / 5 + 32) + '°F';
  }

  function windFromKmh(value, units) {
    if (value == null) return null;
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(units === 'metric' ? number : number / 1.609344) + (units === 'metric' ? ' km/h' : ' mph');
  }

  function distanceFromKm(value, units) {
    if (value == null) return null;
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(units === 'metric' ? number : number * 0.621371) + (units === 'metric' ? ' km' : ' mi');
  }

  function trustedNwsUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'https:' && url.hostname === 'api.weather.gov' ? url.toString() : null;
    } catch (error) {
      return null;
    }
  }

  function stationDistanceKm(lat, lon, stationLat, stationLon) {
    var toRadians = Math.PI / 180;
    var deltaLat = (stationLat - lat) * toRadians;
    var deltaLon = (stationLon - lon) * toRadians;
    var a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat * toRadians) * Math.cos(stationLat * toRadians) *
      Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function rankObservationStations(collection, origin, limit) {
    var features = collection && Array.isArray(collection.features) ? collection.features : [];
    var lat = Number(origin && origin.lat);
    var lon = Number(origin && origin.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return features.map(function (feature) {
      var coordinates = feature && feature.geometry && feature.geometry.coordinates;
      var properties = feature && feature.properties || {};
      var stationLat = coordinates && Number(coordinates[1]);
      var stationLon = coordinates && Number(coordinates[0]);
      var stationUrl = trustedNwsUrl(feature && (feature.id || feature['@id']));
      if (!stationUrl || !Number.isFinite(stationLat) || !Number.isFinite(stationLon)) return null;
      var providerDistance = properties.distance && Number(properties.distance.value);
      return {
        id: String(properties.stationIdentifier || stationUrl.split('/').pop()),
        name: String(properties.name || properties.stationIdentifier || '').trim(),
        url: stationUrl.replace(/\/$/, ''),
        distanceKm: Number.isFinite(providerDistance) && providerDistance >= 0
          ? providerDistance / 1000
          : stationDistanceKm(lat, lon, stationLat, stationLon)
      };
    }).filter(Boolean).sort(function (left, right) {
      return left.distanceKm - right.distanceKm || left.id.localeCompare(right.id);
    }).slice(0, Math.max(1, Math.min(5, Number(limit) || 5)));
  }

  function quantitativeValue(value) {
    return value && value.value != null && Number.isFinite(Number(value.value)) ? Number(value.value) : null;
  }

  function observationTemperatureC(value) {
    var number = quantitativeValue(value);
    var unit = String(value && value.unitCode || '').toLowerCase();
    if (number === null) return null;
    if (unit.endsWith(':degc')) return number;
    if (unit.endsWith(':degf')) return (number - 32) * 5 / 9;
    return null;
  }

  function observationWindKmh(value) {
    var number = quantitativeValue(value);
    var unit = String(value && value.unitCode || '').toLowerCase();
    if (number === null) return null;
    if (unit.endsWith(':km_h-1')) return number;
    if (unit.endsWith(':m_s-1')) return number * 3.6;
    if (unit.endsWith(':mi_h-1')) return number * 1.609344;
    return null;
  }

  function observationAngle(value) {
    var number = quantitativeValue(value);
    return number !== null && String(value && value.unitCode || '').toLowerCase().endsWith(':degree_(angle)')
      ? number : null;
  }

  function observationPercent(value) {
    var number = quantitativeValue(value);
    return number !== null && String(value && value.unitCode || '').toLowerCase().endsWith(':percent')
      ? number : null;
  }

  function normalizeNwsObservation(payload, station) {
    var properties = payload && payload.properties;
    if (!properties) return null;
    var timestamp = new Date(properties.timestamp);
    if (Number.isNaN(timestamp.getTime())) return null;
    if (timestamp.getTime() > Date.now() + 10 * 60 * 1000) return null;
    var observation = {
      timestamp: timestamp.toISOString(),
      conditions: String(properties.textDescription || '').trim(),
      temperatureC: observationTemperatureC(properties.temperature),
      windKmh: observationWindKmh(properties.windSpeed),
      windDirection: observationAngle(properties.windDirection),
      humidity: observationPercent(properties.relativeHumidity),
      station: station
    };
    if (!observation.conditions && observation.temperatureC === null && observation.windKmh === null &&
        observation.humidity === null) return null;
    return observation;
  }

  function windFromMph(value, units) {
    var text = String(value || '');
    var converted = text.replace(/\d+(?:\.\d+)?/g, function (match) {
      var number = Number(match);
      return String(Math.round(units === 'metric' ? number * 1.609344 : number));
    });
    return converted.replace(/\s*mph\b/i, units === 'metric' ? ' km/h' : ' mph').trim();
  }

  function formatTime(value, locale, unknownValue) {
    var unknown = unknownValue || 'Unknown';
    if (!value) return unknown;
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return unknown;
    return new Intl.DateTimeFormat(locale || undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(date);
  }

  function formatOpenMeteoTime(localTime, utcOffsetSeconds, locale, unknownValue) {
    var unknown = unknownValue || 'Unknown';
    if (!localTime) return unknown;
    var wallClock = Date.parse(String(localTime) + (/[zZ]|[+-]\d\d:\d\d$/.test(String(localTime)) ? '' : 'Z'));
    var offset = Number(utcOffsetSeconds);
    if (!Number.isFinite(wallClock) || !Number.isFinite(offset)) return unknown;
    return formatTime(new Date(wallClock - offset * 1000).toISOString(), locale, unknown);
  }

  var AIR_QUALITY_POLLUTANTS = [
    { id: 'pm25', valueKey: 'pm2_5', aqiKey: 'us_aqi_pm2_5' },
    { id: 'pm10', valueKey: 'pm10', aqiKey: 'us_aqi_pm10' },
    { id: 'ozone', valueKey: 'ozone', aqiKey: 'us_aqi_ozone' },
    { id: 'nitrogenDioxide', valueKey: 'nitrogen_dioxide', aqiKey: 'us_aqi_nitrogen_dioxide' },
    { id: 'sulphurDioxide', valueKey: 'sulphur_dioxide', aqiKey: 'us_aqi_sulphur_dioxide' },
    { id: 'carbonMonoxide', valueKey: 'carbon_monoxide', aqiKey: 'us_aqi_carbon_monoxide' }
  ];

  function boundedNumber(value, minimum, maximum) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    var number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
  }

  function airQualityCoordinate(value, minimum, maximum) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new RangeError('Air quality coordinates are out of bounds');
    }
    return number.toFixed(4);
  }

  function buildAirQualityUrl(lat, lon) {
    var current = AIR_QUALITY_POLLUTANTS.map(function (pollutant) {
      return pollutant.valueKey;
    }).concat(AIR_QUALITY_POLLUTANTS.map(function (pollutant) {
      return pollutant.aqiKey;
    }));
    return 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' +
      airQualityCoordinate(lat, -90, 90) + '&longitude=' + airQualityCoordinate(lon, -180, 180) +
      '&current=us_aqi,' + current.join(',') + '&timezone=auto';
  }

  function airQualityCategory(value) {
    var aqi = boundedNumber(value, 0, 500);
    if (aqi === null) return null;
    if (aqi <= 50) return 'good';
    if (aqi <= 100) return 'moderate';
    if (aqi <= 150) return 'unhealthySensitive';
    if (aqi <= 200) return 'unhealthy';
    if (aqi <= 300) return 'veryUnhealthy';
    return 'hazardous';
  }

  function normalizeAirQuality(payload) {
    var current = payload && payload.current;
    var usAqi = boundedNumber(current && current.us_aqi, 0, 500);
    if (!current || usAqi === null) return null;

    var pollutants = AIR_QUALITY_POLLUTANTS.map(function (pollutant, index) {
      var concentration = boundedNumber(current[pollutant.valueKey], 0, 100000);
      var aqi = boundedNumber(current[pollutant.aqiKey], 0, 500);
      if (concentration === null && aqi === null) return null;
      return {
        id: pollutant.id,
        concentration: concentration,
        aqi: aqi,
        order: index
      };
    }).filter(Boolean);
    var withSubIndex = pollutants.filter(function (pollutant) { return pollutant.aqi !== null; });
    var ranked = (withSubIndex.length ? withSubIndex : pollutants.slice()).sort(function (left, right) {
      var leftValue = left.aqi === null ? left.concentration : left.aqi;
      var rightValue = right.aqi === null ? right.concentration : right.aqi;
      return rightValue - leftValue || left.order - right.order;
    });
    var primary = ranked.length ? ranked[0] : null;
    if (primary) delete primary.order;

    return {
      time: typeof current.time === 'string' ? current.time.slice(0, 64) : null,
      utcOffsetSeconds: boundedNumber(payload.utc_offset_seconds, -86400, 86400),
      usAqi: Math.round(usAqi),
      category: airQualityCategory(usAqi),
      primaryPollutant: primary
    };
  }

  return {
    airQualityCategory: airQualityCategory,
    buildAirQualityUrl: buildAirQualityUrl,
    distanceFromKm: distanceFromKm,
    formatTime: formatTime,
    formatOpenMeteoTime: formatOpenMeteoTime,
    inNwsCoverageBounds: inNwsCoverageBounds,
    normalizeUnits: normalizeUnits,
    normalizeAirQuality: normalizeAirQuality,
    normalizeNwsObservation: normalizeNwsObservation,
    rankObservationStations: rankObservationStations,
    shouldUseNws: shouldUseNws,
    temperatureFromCelsius: temperatureFromCelsius,
    temperatureFromFahrenheit: temperatureFromFahrenheit,
    trustedNwsUrl: trustedNwsUrl,
    windFromKmh: windFromKmh,
    windFromMph: windFromMph
  };
});
