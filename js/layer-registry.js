/* Declarative operational-layer identity, state, controls, and lifecycle ownership. */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StormScopeLayerRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var RAW_DESCRIPTORS = [
    {
      id: 'radar', toggleId: 'toggle-radar', defaultEnabled: true,
      labelKey: 'layers.radar', groupId: 'base', groupLabelKey: 'layers.groupBase',
      searchKeys: ['layers.opacity', 'radar.playback', 'radar.presentation']
    },
    {
      id: 'cameras', toggleId: 'toggle-cameras', defaultEnabled: true,
      labelKey: 'layers.cameras', groupId: 'base', groupLabelKey: 'layers.groupBase'
    },
    {
      id: 'coverage', toggleId: 'toggle-coverage', defaultEnabled: false,
      labelKey: 'layers.coverage', groupId: 'base', groupLabelKey: 'layers.groupBase'
    },
    {
      id: 'terminator', toggleId: 'toggle-terminator', defaultEnabled: false, lifecycleId: 'terminator',
      labelKey: 'layers.terminator', groupId: 'base', groupLabelKey: 'layers.groupBase'
    },
    {
      id: 'snow', toggleId: 'toggle-snow', defaultEnabled: false, lifecycleId: 'snow',
      labelKey: 'layers.snow', groupId: 'base', groupLabelKey: 'layers.groupBase'
    },
    {
      id: 'alerts', toggleId: 'toggle-alerts', defaultEnabled: true, lifecycleId: 'alerts',
      labelKey: 'layers.alerts', groupId: 'warnings', groupLabelKey: 'layers.groupWarnings',
      searchKeys: ['alerts.minimum']
    },
    {
      id: 'lightning', toggleId: 'toggle-lightning', defaultEnabled: false, lifecycleId: 'lightning',
      labelKey: 'layers.lightning', groupId: 'hazards', groupLabelKey: 'layers.groupHazards'
    },
    {
      id: 'surfaceObservations', toggleId: 'toggle-surface-observations', defaultEnabled: false, lifecycleId: 'surface-observations',
      labelKey: 'layers.surfaceObservations', groupId: 'hazards', groupLabelKey: 'layers.groupHazards'
    },
    {
      id: 'wildfires', toggleId: 'toggle-wildfires', defaultEnabled: false, lifecycleId: 'wildfires',
      labelKey: 'layers.wildfires', groupId: 'hazards', groupLabelKey: 'layers.groupHazards'
    },
    {
      id: 'satellite', toggleId: 'toggle-satellite', defaultEnabled: false, lifecycleId: 'satellite',
      labelKey: 'layers.satellite', groupId: 'storms', groupLabelKey: 'layers.groupStorms'
    },
    {
      id: 'spaceWeather', toggleId: 'toggle-space-weather', defaultEnabled: false, lifecycleId: 'space-weather',
      labelKey: 'layers.spaceWeather', groupId: 'storms', groupLabelKey: 'layers.groupStorms',
      searchKeys: ['context.spaceWeatherLimitation', 'context.spaceWeatherSource']
    },
    {
      id: 'marineBuoys', toggleId: 'toggle-marine-buoys', defaultEnabled: false, lifecycleId: 'marine-buoys',
      labelKey: 'layers.marineBuoys', groupId: 'storms', groupLabelKey: 'layers.groupStorms',
      searchKeys: ['context.marineBuoysLimitation', 'context.marineBuoysSource']
    },
    {
      id: 'tropical', toggleId: 'toggle-tropical', defaultEnabled: false, lifecycleId: 'tropical',
      labelKey: 'layers.tropical', groupId: 'storms', groupLabelKey: 'layers.groupStorms'
    },
    {
      id: 'wpcOutlooks', toggleId: 'toggle-wpc-outlooks', defaultEnabled: false, lifecycleId: 'wpc-outlooks',
      labelKey: 'layers.wpcOutlooks', groupId: 'outlooks', groupLabelKey: 'layers.groupOutlooks',
      controls: [{
        key: 'outlookDay', controlId: 'wpc-outlook-day', type: 'integer', minimum: 1, maximum: 3,
        scenePath: 'outlookDay', profilePath: 'outlookDay', defaultValue: 1, labelKey: 'layers.wpcDay'
      }]
    },
    {
      id: 'wssi', toggleId: 'toggle-wssi', defaultEnabled: false, lifecycleId: 'wssi',
      labelKey: 'layers.wssi', groupId: 'outlooks', groupLabelKey: 'layers.groupOutlooks'
    },
    {
      id: 'cpcOutlooks', toggleId: 'toggle-cpc-outlooks', defaultEnabled: false, lifecycleId: 'cpc-outlooks',
      labelKey: 'layers.cpcOutlooks', groupId: 'outlooks', groupLabelKey: 'layers.groupOutlooks',
      searchKeys: ['context.cpcLimitation', 'context.cpcSource']
    },
    {
      id: 'usgsGauges', toggleId: 'toggle-usgs-gauges', defaultEnabled: false, lifecycleId: 'usgs-gauges',
      labelKey: 'layers.usgsGauges', groupId: 'hazards', groupLabelKey: 'layers.groupHazards',
      searchKeys: ['context.gaugeObserved', 'context.gaugeForecast', 'context.gaugesLimitation']
    },
    {
      id: 'earthquakes', toggleId: 'toggle-earthquakes', defaultEnabled: false, lifecycleId: 'earthquakes',
      labelKey: 'layers.earthquakes', groupId: 'hazards', groupLabelKey: 'layers.groupHazards',
      controls: [
        {
          key: 'magnitude', controlId: 'earthquake-magnitude', type: 'choice',
          choices: ['significant', '4.5', '2.5', '1.0', 'all'],
          scenePath: 'earthquake.magnitude', profilePath: 'earthquake.magnitude', defaultValue: '2.5',
          labelKey: 'layers.earthquakeMagnitude'
        },
        {
          key: 'period', controlId: 'earthquake-period', type: 'choice', choices: ['hour', 'day', 'week', 'month'],
          scenePath: 'earthquake.period', profilePath: 'earthquake.period', defaultValue: 'day',
          labelKey: 'layers.earthquakePeriod'
        }
      ]
    },
    {
      id: 'convective', toggleId: 'toggle-convective', defaultEnabled: false, lifecycleId: 'convective',
      labelKey: 'layers.convective', groupId: 'outlooks', groupLabelKey: 'layers.groupOutlooks',
      controls: [{
        key: 'convectiveDay', controlId: 'convective-day', type: 'integer', minimum: 1, maximum: 3,
        scenePath: 'convectiveDay', profilePath: 'convectiveDay', defaultValue: 1, labelKey: 'layers.convectiveDay'
      }]
    },
    {
      id: 'fireWeather', toggleId: 'toggle-fire-weather', defaultEnabled: false, lifecycleId: 'fire-weather',
      labelKey: 'layers.fireWeather', groupId: 'outlooks', groupLabelKey: 'layers.groupOutlooks',
      searchKeys: ['context.fireWeatherForecast', 'context.fireWeatherOfficial'],
      controls: [{
        key: 'fireWeatherDay', controlId: 'fire-weather-day', type: 'integer', minimum: 1, maximum: 8,
        scenePath: 'fireWeatherDay', profilePath: 'fireWeatherDay', defaultValue: 1, labelKey: 'layers.fireWeatherDay'
      }]
    },
    {
      id: 'watches', toggleId: 'toggle-watches', defaultEnabled: false, lifecycleId: 'watches',
      labelKey: 'layers.watches', groupId: 'warnings', groupLabelKey: 'layers.groupWarnings'
    },
    {
      id: 'mesoscale', toggleId: 'toggle-mesoscale', defaultEnabled: false, lifecycleId: 'mesoscale',
      labelKey: 'layers.mesoscale', groupId: 'warnings', groupLabelKey: 'layers.groupWarnings'
    },
    {
      id: 'stormReports', toggleId: 'toggle-storm-reports', defaultEnabled: false, lifecycleId: 'storm-reports',
      labelKey: 'layers.stormReports', groupId: 'hazards', groupLabelKey: 'layers.groupHazards',
      controls: [{
        key: 'window', controlId: 'storm-report-window', type: 'choice', choices: ['24', '48', '72'],
        scenePath: 'stormReportWindow', profilePath: 'stormReportWindow', defaultValue: '24',
        labelKey: 'layers.stormReportWindow'
      }]
    }
  ];

  var ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
  var PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
  var UNSAFE_PATH_PARTS = ['constructor', 'prototype', '__proto__'];

  function validPath(path) {
    return PATH_PATTERN.test(path || '') && path.split('.').every(function (part) {
      return UNSAFE_PATH_PARTS.indexOf(part) === -1;
    });
  }

  function validateDescriptors(input) {
    if (!Array.isArray(input) || !input.length) throw new TypeError('layer descriptors are required');
    var ids = new Set();
    var toggles = new Set();
    var lifecycles = new Set();
    var controls = new Set();
    input.forEach(function (descriptor) {
      if (!descriptor || typeof descriptor !== 'object' || !ID_PATTERN.test(descriptor.id || '')) {
        throw new TypeError('layer descriptor id is invalid');
      }
      if (!ID_PATTERN.test(descriptor.toggleId || '')) throw new TypeError(descriptor.id + ' toggle id is invalid');
      if (!ID_PATTERN.test(descriptor.groupId || '') || !validPath(descriptor.labelKey) ||
          !validPath(descriptor.groupLabelKey)) {
        throw new TypeError(descriptor.id + ' navigation metadata is invalid');
      }
      if (descriptor.searchKeys != null && (!Array.isArray(descriptor.searchKeys) ||
          !descriptor.searchKeys.every(validPath))) {
        throw new TypeError(descriptor.id + ' search keys are invalid');
      }
      if (typeof descriptor.defaultEnabled !== 'boolean') throw new TypeError(descriptor.id + ' default must be boolean');
      if (ids.has(descriptor.id)) throw new TypeError('duplicate layer id: ' + descriptor.id);
      if (toggles.has(descriptor.toggleId)) throw new TypeError('duplicate layer toggle: ' + descriptor.toggleId);
      ids.add(descriptor.id);
      toggles.add(descriptor.toggleId);
      if (descriptor.lifecycleId != null) {
        if (!ID_PATTERN.test(descriptor.lifecycleId)) throw new TypeError(descriptor.id + ' lifecycle id is invalid');
        if (lifecycles.has(descriptor.lifecycleId)) throw new TypeError('duplicate lifecycle id: ' + descriptor.lifecycleId);
        lifecycles.add(descriptor.lifecycleId);
      }
      (descriptor.controls || []).forEach(function (control) {
        if (!control || !ID_PATTERN.test(control.key || '') || !ID_PATTERN.test(control.controlId || '') ||
            !validPath(control.scenePath) || !validPath(control.profilePath) || !validPath(control.labelKey) ||
            ['integer', 'choice'].indexOf(control.type) === -1) {
          throw new TypeError(descriptor.id + ' control is invalid');
        }
        if (controls.has(control.controlId)) throw new TypeError('duplicate layer control: ' + control.controlId);
        controls.add(control.controlId);
        if (control.type === 'integer' && (!Number.isInteger(control.minimum) || !Number.isInteger(control.maximum) ||
            control.minimum > control.maximum || !Number.isInteger(control.defaultValue))) {
          throw new TypeError(control.controlId + ' integer bounds are invalid');
        }
        if (control.type === 'choice' && (!Array.isArray(control.choices) || !control.choices.length ||
            control.choices.indexOf(control.defaultValue) === -1)) {
          throw new TypeError(control.controlId + ' choices are invalid');
        }
      });
    });
    return true;
  }

  function freezeDescriptor(descriptor) {
    var copy = Object.assign({
      sceneKey: descriptor.id,
      profileKey: descriptor.id,
      lifecycleId: null,
      controls: [],
      searchKeys: []
    }, descriptor);
    copy.controls = Object.freeze(copy.controls.map(function (control) {
      var next = Object.assign({}, control);
      if (next.choices) next.choices = Object.freeze(next.choices.slice());
      return Object.freeze(next);
    }));
    copy.searchKeys = Object.freeze(copy.searchKeys.slice());
    return Object.freeze(copy);
  }

  validateDescriptors(RAW_DESCRIPTORS);
  var DESCRIPTORS = Object.freeze(RAW_DESCRIPTORS.map(freezeDescriptor));
  var BY_ID = Object.create(null);
  DESCRIPTORS.forEach(function (descriptor) { BY_ID[descriptor.id] = descriptor; });

  function get(id) {
    var descriptor = BY_ID[id];
    if (!descriptor) throw new RangeError('unknown layer: ' + id);
    return descriptor;
  }

  function readPath(source, path) {
    var value = source;
    var parts = path.split('.');
    for (var index = 0; index < parts.length; index += 1) {
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, parts[index])) return undefined;
      value = value[parts[index]];
    }
    return value;
  }

  function writePath(target, path, value) {
    var parts = path.split('.');
    var cursor = target;
    for (var index = 0; index < parts.length - 1; index += 1) {
      if (!cursor[parts[index]]) cursor[parts[index]] = {};
      cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  function normalizeControl(control, value) {
    if (control.type === 'integer') {
      var number = Number(value);
      if (!Number.isInteger(number) || number < control.minimum || number > control.maximum) {
        throw new TypeError(control.controlId + ' value is invalid');
      }
      return number;
    }
    var text = String(value);
    if (control.choices.indexOf(text) === -1) throw new TypeError(control.controlId + ' value is invalid');
    return text;
  }

  function captureEnabled(documentObject) {
    var state = {};
    DESCRIPTORS.forEach(function (descriptor) {
      var toggle = documentObject.getElementById(descriptor.toggleId);
      if (!toggle) throw new Error('missing layer toggle: ' + descriptor.toggleId);
      state[descriptor.sceneKey] = Boolean(toggle.checked);
    });
    return state;
  }

  function controlState(documentObject, scope) {
    var state = {};
    DESCRIPTORS.forEach(function (descriptor) {
      descriptor.controls.forEach(function (control) {
        var element = documentObject.getElementById(control.controlId);
        if (!element) throw new Error('missing layer control: ' + control.controlId);
        writePath(state, scope === 'profile' ? control.profilePath : control.scenePath,
          normalizeControl(control, element.value));
      });
    });
    return state;
  }

  function applyControlState(documentObject, state, scope) {
    DESCRIPTORS.forEach(function (descriptor) {
      descriptor.controls.forEach(function (control) {
        var value = readPath(state, scope === 'profile' ? control.profilePath : control.scenePath);
        if (value === undefined) return;
        var element = documentObject.getElementById(control.controlId);
        if (!element) throw new Error('missing layer control: ' + control.controlId);
        element.value = String(normalizeControl(control, value));
      });
    });
  }

  return Object.freeze({
    descriptors: DESCRIPTORS,
    get: get,
    sceneKeys: function () { return DESCRIPTORS.map(function (descriptor) { return descriptor.sceneKey; }); },
    lifecycleDescriptors: function () { return DESCRIPTORS.filter(function (descriptor) { return descriptor.lifecycleId; }); },
    defaultState: function () {
      var state = {};
      DESCRIPTORS.forEach(function (descriptor) { state[descriptor.sceneKey] = descriptor.defaultEnabled; });
      return state;
    },
    captureEnabled: captureEnabled,
    captureControlState: controlState,
    applyControlState: applyControlState,
    validateDescriptors: validateDescriptors
  });
});
