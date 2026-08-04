const assert = require('node:assert/strict');
const test = require('node:test');

const RadarController = require('../js/radar-controller.js');

function providers() {
  return {
    createRollingRequestBudget() {
      return {
        consume() { return true; },
        snapshot() { return { used: 0, limit: 90, remaining: 90, rateLimitedUntil: null }; }
      };
    }
  };
}

test('radar controller exposes isolated state and lifecycle operations', () => {
  const controller = RadarController.create({
    providers: providers(),
    translate: (key) => key,
    getMap: () => null,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {}
  });

  assert.equal(typeof controller.init, 'function');
  assert.equal(typeof controller.createComparisonLayer, 'function');
  assert.equal(typeof controller.sampleCenter, 'function');
  assert.equal(controller.getState().frames.length, 0);
  assert.equal(controller.getState().playing, false);
  assert.equal(controller.getBudget().remaining, 90);

  controller.setSpeed(400);
  controller.setPalette('contrast', false);
  controller.applyScene({ frameTime: 'invalid' });
  assert.equal(controller.getState().animationSpeed, 400);
  assert.equal(controller.getState().palette, 'contrast');
  assert.equal(controller.hasPendingFrame(), false);

  controller.destroy();
  assert.equal(controller.getState().frames.length, 0);
});
