'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const lifecycle = require('../js/context-layer-controllers.js');

test('controller owns injected aborts and timers and refreshes only while enabled', () => {
  const calls = [];
  let enabled = false;
  const abort = { abort: () => calls.push('abort') };
  const controller = lifecycle.createController({
    id: 'lightning',
    isEnabled: () => enabled,
    refresh: () => calls.push('refresh'),
    aborts: () => abort,
    timers: () => [7, null, 9],
    cancelTimer: timer => calls.push(`cancel:${timer}`)
  });

  controller.refreshIfEnabled();
  enabled = true;
  controller.refreshIfEnabled();
  controller.suspend();
  controller.destroy();
  controller.destroy();
  controller.refreshIfEnabled();

  assert.deepEqual(calls, [
    'refresh',
    'abort', 'cancel:7', 'cancel:9',
    'abort', 'cancel:7', 'cancel:9'
  ]);
});

test('controller set is the single refresh, suspend, and destroy enumeration', () => {
  const calls = [];
  function controller(id) {
    return {
      id,
      refreshIfEnabled: () => calls.push(`${id}:refresh`),
      suspend: () => calls.push(`${id}:suspend`),
      destroy: () => calls.push(`${id}:destroy`)
    };
  }
  const set = lifecycle.createControllerSet([controller('alerts'), controller('satellite')]);
  assert.deepEqual(set.ids, ['alerts', 'satellite']);
  set.refreshEnabled();
  set.suspend();
  set.destroy();
  set.destroy();
  set.refreshEnabled();
  assert.deepEqual(calls, [
    'alerts:refresh', 'satellite:refresh',
    'alerts:suspend', 'satellite:suspend',
    'alerts:destroy', 'satellite:destroy'
  ]);
  assert.throws(
    () => lifecycle.createControllerSet([controller('alerts'), controller('alerts')]),
    /duplicate/
  );
});
