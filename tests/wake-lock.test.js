'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const wakeLock = require('../js/wake-lock.js');

function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    dispatch(type) { if (listeners.has(type)) listeners.get(type)(); },
    has(type) { return listeners.has(type); }
  };
}

function sentinel() {
  const listeners = new Map();
  return {
    releases: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    release() {
      this.releases += 1;
      if (listeners.has('release')) listeners.get('release')();
      return Promise.resolve();
    },
    revoke() { if (listeners.has('release')) listeners.get('release')(); }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('wake lock requires explicit opt-in and an active monitoring session', async () => {
  const document = fakeDocument();
  const locks = [];
  const controller = wakeLock.create({
    document,
    navigator: { wakeLock: { request: async type => {
      assert.equal(type, 'screen');
      const lock = sentinel();
      locks.push(lock);
      return lock;
    } } }
  });

  await controller.setActive(true);
  await controller.setEnabled(true, false);
  assert.equal(locks.length, 0, 'programmatic enable must not authorize a request');
  await controller.setEnabled(true, true);
  assert.equal(locks.length, 1);
  assert.equal(controller.snapshot().held, true);
  await controller.setActive(false);
  assert.equal(locks[0].releases, 1);
  assert.deepEqual(controller.snapshot(), {
    supported: true, enabled: true, active: false, held: false, state: 'ready'
  });
});

test('visibility releases and reacquires only while opt-in monitoring remains active', async () => {
  const document = fakeDocument();
  const locks = [];
  const controller = wakeLock.create({
    document,
    navigator: { wakeLock: { request: async () => {
      const lock = sentinel();
      locks.push(lock);
      return lock;
    } } }
  });
  await controller.setActive(true);
  await controller.setEnabled(true, true);
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  await Promise.resolve();
  assert.equal(locks[0].releases, 1);
  assert.equal(controller.snapshot().state, 'suspended');
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(locks.length, 2);

  await controller.setActive(false);
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  await Promise.resolve();
  assert.equal(locks.length, 2, 'inactive sessions must not reacquire');
});

test('rejection, revocation, unsupported browsers, and stale requests fail soft', async () => {
  const document = fakeDocument();
  const rejected = wakeLock.create({
    document,
    navigator: { wakeLock: { request: () => Promise.reject(new Error('denied')) } }
  });
  await rejected.setActive(true);
  await rejected.setEnabled(true, true);
  assert.equal(rejected.snapshot().state, 'unavailable');

  const held = sentinel();
  const revoked = wakeLock.create({ document: fakeDocument(), navigator: { wakeLock: { request: async () => held } } });
  await revoked.setActive(true);
  await revoked.setEnabled(true, true);
  held.revoke();
  assert.equal(revoked.snapshot().state, 'released');
  assert.equal(revoked.snapshot().held, false);

  const unsupported = wakeLock.create({ document: fakeDocument(), navigator: {} });
  await unsupported.setEnabled(true, true);
  assert.deepEqual(unsupported.snapshot(), {
    supported: false, enabled: false, active: false, held: false, state: 'unsupported'
  });

  const pending = deferred();
  const lateLock = sentinel();
  const stale = wakeLock.create({ document: fakeDocument(), navigator: { wakeLock: { request: () => pending.promise } } });
  await stale.setActive(true);
  const request = stale.setEnabled(true, true);
  await stale.setEnabled(false, true);
  pending.resolve(lateLock);
  await request;
  await Promise.resolve();
  assert.equal(lateLock.releases, 1);
  assert.equal(stale.snapshot().held, false);
});

test('destroy removes lifecycle ownership and releases a held lock', async () => {
  const document = fakeDocument();
  const held = sentinel();
  const controller = wakeLock.create({ document, navigator: { wakeLock: { request: async () => held } } });
  await controller.setActive(true);
  await controller.setEnabled(true, true);
  assert.equal(document.has('visibilitychange'), true);
  controller.destroy();
  await Promise.resolve();
  assert.equal(document.has('visibilitychange'), false);
  assert.equal(held.releases, 1);
});
