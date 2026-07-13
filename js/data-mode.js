(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StormScopeDataMode = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PREFERENCES = ['auto', 'standard', 'low'];

  function normalize(preference) {
    return PREFERENCES.indexOf(preference) === -1 ? 'auto' : preference;
  }

  function resolve(preference, connection) {
    preference = normalize(preference);
    var saveData = Boolean(connection && connection.saveData);
    var lowData = preference === 'low' || preference === 'auto' && saveData;
    return Object.freeze({
      preference: preference,
      lowData: lowData,
      source: preference === 'standard' ? 'standard' : preference === 'low' ? 'manual' : saveData ? 'save-data' : 'standard',
      radarAutoplay: !lowData,
      radarPreload: !lowData,
      imageRefreshMs: lowData ? 60000 : 15000,
      deferCameraCatalog: lowData
    });
  }

  return Object.freeze({ normalize: normalize, resolve: resolve });
}));
