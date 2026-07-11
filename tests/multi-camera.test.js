'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const multi = require('../js/multi-camera.js');

test('selection is bounded to two through four unique cameras', () => {
  const selection = new multi.Selection();
  const cameras = [1, 2, 3, 4, 5].map((id) => ({ id, type: 'image' }));
  assert.equal(selection.canStart(), false);
  selection.add(cameras[0]);
  selection.add(cameras[1]);
  assert.equal(selection.canStart(), true);
  selection.add(cameras[2]);
  selection.add(cameras[3]);
  assert.throws(() => selection.add(cameras[4]), /maximum/);
  assert.equal(selection.toggle(cameras[0]), false);
  assert.equal(selection.count(), 3);
  assert.deepEqual(selection.list().map((camera) => camera.id), [2, 3, 4]);
});

test('supported direct feeds are playable and embeds degrade to links', () => {
  for (const type of ['hls', 'image', 'mjpeg', 'youtube']) {
    assert.equal(multi.capability({ type }).playable, true);
  }
  assert.deepEqual(multi.capability({ type: 'embed' }), { type: 'embed', playable: false, mode: 'link' });
  assert.deepEqual(multi.capability({ type: 'unknown' }), { type: 'unknown', playable: false, mode: 'link' });
});

test('registry pauses hidden/offscreen players, resumes visible players, and destroys all once', () => {
  const calls = [];
  function player(name) {
    return {
      pause: () => calls.push(name + ':pause'),
      resume: () => calls.push(name + ':resume'),
      destroy: () => calls.push(name + ':destroy')
    };
  }
  const first = {};
  const second = {};
  const registry = new multi.PlayerRegistry();
  registry.register(first, player('first'));
  registry.register(second, player('second'));
  registry.setVisible(second, false);
  registry.setDocumentHidden(true);
  registry.setDocumentHidden(false);
  registry.destroyAll();
  registry.destroyAll();
  assert.deepEqual(calls, [
    'second:pause', 'first:pause', 'second:pause', 'first:resume', 'second:pause',
    'first:destroy', 'second:destroy'
  ]);
  assert.equal(registry.count(), 0);
});
