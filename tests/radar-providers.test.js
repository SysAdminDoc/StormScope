const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', 'radar-providers.js'), 'utf8');
const radar = require('../js/radar-providers.js');
const NOW = Date.UTC(2026, 6, 11, 21, 0, 0);

test('exports a standalone browser global with immutable provider capabilities', () => {
  const context = { URL, globalThis: {} };
  vm.runInNewContext(source, context, { filename: 'radar-providers.js' });
  const browserApi = context.globalThis.StormScopeRadarProviders;

  assert.ok(browserApi);
  assert.equal(browserApi.providers.rainviewer.role, 'primary');
  assert.equal(browserApi.providers['noaa-mrms'].role, 'fallback');
  assert.equal(browserApi.providers.rainviewer.tile.colorScheme, 2);
  assert.equal(browserApi.providers.rainviewer.tile.maxNativeZoom, 7);
  assert.equal(browserApi.providers.rainviewer.coverage.kind, 'xyz-mask');
  assert.equal(browserApi.providers.rainviewer.history.windowMinutes, 120);
  assert.equal(browserApi.providers['noaa-mrms'].tile.kind, 'wms');
  assert.equal(browserApi.providers['noaa-mrms'].tile.layer, 'radar_base_reflectivity_time');
  assert.equal(browserApi.providers['noaa-mrms'].history.advertisedWindowMinutes, 240);
  assert.equal(browserApi.providers['noaa-mrms'].history.windowFromDiscovery, true);
  assert.equal(browserApi.providers['noaa-mrms'].resolution.nominalKilometers, 1);
  assert.ok(Object.isFrozen(browserApi.providers));
});

test('normalizes RainViewer past frames and builds only current public tile contracts', () => {
  const discovery = radar.parseRainViewerDiscovery({
    generated: NOW / 1000,
    host: 'https://tilecache.rainviewer.com',
    radar: {
      past: [
        { time: NOW / 1000 - 600, path: '/v2/radar/older' },
        { time: NOW / 1000, path: '/v2/radar/current_hash' },
        { time: 'bad', path: '/v2/radar/rejected' },
        { time: NOW / 1000, path: '/v2/radar/../rejected' }
      ],
      nowcast: [{ time: NOW / 1000 + 600, path: '/v2/radar/future' }]
    }
  }, NOW);

  assert.equal(discovery.frames.length, 2);
  assert.equal(discovery.latestFrame.path, '/v2/radar/current_hash');
  assert.equal(
    radar.buildRainViewerTileUrl(discovery.latestFrame, 7, 42, 51),
    'https://tilecache.rainviewer.com/v2/radar/current_hash/256/7/42/51/2/1_1.png'
  );
  assert.equal(
    radar.buildRainViewerCoverageUrl(discovery.tileHost, 7, 42, 51),
    'https://tilecache.rainviewer.com/v2/coverage/0/256/7/42/51/0/0_0.png'
  );
  assert.throws(() => radar.buildRainViewerTileUrl(discovery.latestFrame, 8, 0, 0), /cannot exceed 7/);
  assert.throws(() => radar.parseRainViewerDiscovery({ host: 'https://rainviewer.com.attacker.test', radar: { past: [] } }), /untrusted/);
});

function noaaFeature(subset, validTime, validEndTime, fileDate, objectId) {
  return {
    attributes: {
      objectid: objectId,
      idp_subset: subset,
      idp_validtime: validTime,
      idp_validendtime: validEndTime,
      idp_filedate: fileDate,
      idp_ingestdate: fileDate + 10000
    }
  };
}

test('groups NOAA regional rasters into historical frames and builds WMS requests', () => {
  const firstStart = NOW - 20 * 60000;
  const secondStart = NOW - 10 * 60000;
  const subsets = ['CONUS', 'ALASKA', 'HAWAII', 'CARIB', 'GUAM'];
  const features = [];
  subsets.forEach((subset, index) => {
    features.push(noaaFeature(subset, firstStart + index * 1000, secondStart + index * 1000, firstStart + 60000 + index * 1000, index));
    features.push(noaaFeature(subset, secondStart + index * 1000, secondStart + index * 1000, secondStart + 60000 + index * 1000, index + 10));
  });

  const discovery = radar.parseNoaaDiscovery({
    fullExtent: { xmin: -10, ymin: -5, xmax: 10, ymax: 5, spatialReference: { latestWkid: 3857 } },
    timeInfo: { timeExtent: [firstStart, secondStart] }
  }, { features }, NOW);

  assert.equal(discovery.frames.length, 2);
  assert.equal(discovery.availableHistoryMinutes, 10);
  assert.equal(discovery.frames[0].coverageComplete, true);
  assert.deepEqual(discovery.frames[0].coverageSubsets, ['ALASKA', 'CARIB', 'CONUS', 'GUAM', 'HAWAII']);
  assert.ok(discovery.frames[0].wmsTime);
  assert.equal(discovery.latestFrame.isLatest, true);
  assert.equal(discovery.latestFrame.wmsTime, null);

  const historicalUrl = new URL(radar.buildNoaaWmsUrl(discovery.frames[0], [-10, -5, 10, 5], 256, 256));
  assert.equal(historicalUrl.hostname, 'mapservices.weather.noaa.gov');
  assert.equal(historicalUrl.searchParams.get('layers'), 'radar_base_reflectivity_time');
  assert.equal(historicalUrl.searchParams.get('crs'), 'EPSG:3857');
  assert.equal(historicalUrl.searchParams.get('format'), 'image/png');
  assert.ok(historicalUrl.searchParams.get('time'));

  const latestParams = radar.noaaWmsParameters(discovery.latestFrame);
  assert.equal(Object.hasOwn(latestParams, 'time'), false, 'latest NOAA mosaic must let the service select all current regional rasters');
});

test('computes provider-specific frame age and health without hiding stale success', () => {
  const freshFrame = { providerId: 'rainviewer', time: NOW - 5 * 60000 };
  const staleFrame = { providerId: 'rainviewer', time: NOW - 25 * 60000 };
  const expiredFrame = { providerId: 'rainviewer', time: NOW - 45 * 60000 };

  assert.equal(radar.getFrameAge(freshFrame, null, NOW).stale, false);
  assert.equal(radar.getFrameAge(staleFrame, null, NOW).stale, true);
  assert.equal(radar.getFrameAge(staleFrame, null, NOW).failed, false);
  assert.equal(radar.getFrameAge(expiredFrame, null, NOW).failed, true);
  assert.equal(radar.assessProviderHealth('rainviewer', { latestFrame: staleFrame }, NOW).status, 'degraded');
  assert.equal(radar.assessProviderHealth('rainviewer', { latestFrame: expiredFrame }, NOW).status, 'unavailable');
  const partial = radar.assessProviderHealth('noaa-mrms', {
    latestFrame: { providerId: 'noaa-mrms', time: NOW - 5 * 60000, coverageComplete: false }
  }, NOW);
  assert.equal(partial.status, 'degraded');
  assert.equal(partial.reason, 'partial-coverage');
});

test('failover preserves provider identity and never labels NOAA as primary', () => {
  const primary = radar.assessProviderHealth('rainviewer', {
    latestFrame: { providerId: 'rainviewer', time: NOW - 45 * 60000 },
    error: new Error('unavailable'),
    consecutiveFailures: 2
  }, NOW);
  const fallback = radar.assessProviderHealth('noaa-mrms', {
    latestFrame: { providerId: 'noaa-mrms', time: NOW - 5 * 60000 }
  }, NOW);

  const selection = radar.selectProvider({ rainviewer: primary, 'noaa-mrms': fallback });
  assert.equal(selection.selectedProviderId, 'noaa-mrms');
  assert.equal(selection.role, 'fallback');
  assert.equal(selection.isFallback, true);
  assert.equal(selection.displayLabel, 'NOAA/NWS MRMS (fallback)');
  assert.notEqual(selection.displayLabel, radar.providers.rainviewer.label);
  assert.equal(selection.degradationReason, 'request-failed');
});

test('classifies clear, no-coverage, stale, and failure as distinct accessible states', () => {
  const freshFrame = { providerId: 'rainviewer', time: NOW - 5 * 60000 };
  const staleFrame = { providerId: 'rainviewer', time: NOW - 25 * 60000 };

  const clear = radar.classifyRadarState({ frame: freshFrame, coverage: true, hasPrecipitation: false, now: NOW });
  const noCoverage = radar.classifyRadarState({ frame: freshFrame, coverage: false, hasPrecipitation: false, now: NOW });
  const stale = radar.classifyRadarState({ frame: staleFrame, coverage: true, hasPrecipitation: true, now: NOW });
  const failure = radar.classifyRadarState({ providerId: 'rainviewer', error: new Error('down'), now: NOW });

  assert.deepEqual([clear.state, noCoverage.state, stale.state, failure.state], ['clear', 'no-coverage', 'stale', 'failure']);
  assert.equal(clear.label, 'No precipitation detected');
  assert.equal(noCoverage.controlsEnabled, false);
  assert.match(stale.label, /25 minutes old/);
  assert.equal(failure.canRetry, true);
  assert.equal(failure.controlsEnabled, false);
});

test('returns no-coverage separately from all-provider failure when no candidate can run', () => {
  const unavailable = { status: 'unavailable', reason: 'request-failed' };
  const health = { rainviewer: unavailable, 'noaa-mrms': unavailable };
  assert.equal(radar.selectProvider(health).state, 'failure');
  assert.equal(radar.selectProvider(health, {
    coverageByProvider: { rainviewer: false, 'noaa-mrms': false }
  }).state, 'no-coverage');
});
