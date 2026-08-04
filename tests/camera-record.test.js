const assert = require('node:assert/strict');
const test = require('node:test');

const cameraRecord = require('../js/camera-record.js');

test('capture freshness uses provider frame timestamps and type-aware thresholds', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  const fresh = cameraRecord.captureFreshness({
    type: 'image',
    provider_timestamp: '2026-08-04T11:30:00Z',
    refresh_cadence_seconds: 30
  }, now);
  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.ageMs, 30 * 60 * 1000);
  assert.equal(fresh.staleAfterMs, cameraRecord.CAPTURE_STALE_AFTER_MS.image);

  const stale = cameraRecord.captureFreshness({
    type: 'image',
    provider_timestamp: '2026-08-04T11:14:59Z',
    refresh_cadence_seconds: 30
  }, now);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.timestampMs, Date.parse('2026-08-04T11:14:59Z'));

  const slowCadence = cameraRecord.captureFreshness({
    type: 'image',
    provider_timestamp: now - 2 * 60 * 60 * 1000,
    refresh_cadence_seconds: 3600
  }, now);
  assert.equal(slowCadence.state, 'fresh');
  assert.equal(slowCadence.staleAfterMs, 3 * 60 * 60 * 1000);
});

test('capture freshness accepts numeric and UTC provider formats and fails closed when absent', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  assert.equal(cameraRecord.captureTimestamp({ provider_image_timestamp: now - 1000 }), now - 1000);
  assert.equal(cameraRecord.captureTimestamp({ provider_record_time: '2026-08-04 11:00:00' }), now - 60 * 60 * 1000);
  assert.equal(cameraRecord.captureTimestamp({ provider_timestamp: 'not-a-time' }), null);
  assert.deepEqual(cameraRecord.captureFreshness({ type: 'youtube' }, now), {
    state: 'unknown', timestampMs: null, ageMs: null, staleAfterMs: cameraRecord.CAPTURE_STALE_AFTER_MS.youtube
  });
});
