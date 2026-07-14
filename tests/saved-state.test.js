'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '..', 'js', 'saved-state.js');
const SavedState = require(modulePath);
const NOW = Date.parse('2026-07-11T20:00:00Z');

function snapshot(overrides) {
  return Object.assign({
    center: { lat: 39.1, lon: -90.2 },
    zoom: 7,
    layers: { radar: true, cameras: true, alerts: false },
    opacity: { radar: 0.65 }
  }, overrides);
}

function storeOptions(storage, extra) {
  return Object.assign({ storage, now: () => NOW, random: () => 0.25 }, extra);
}

test('exports the same frozen API as a browser global and CommonJS module', () => {
  const source = fs.readFileSync(modulePath, 'utf8');
  const context = {
    JSON, Date, Math, Number, String, Boolean, Object, Array, ArrayBuffer, Uint8Array,
    TextDecoder, TextEncoder, TypeError, RangeError, Set, isFinite
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'saved-state.js' });
  assert.equal(context.StormScopeSavedState.VERSION, 3);
  assert.equal(SavedState.VERSION, 3);
  assert.equal(Object.isFrozen(SavedState), true);
});

test('persists canonical favorite IDs and reloads them without duplicates', () => {
  const storage = SavedState.memoryStorage();
  const store = SavedState.createStore(storeOptions(storage));
  store.setFavorite(42, true);
  store.setFavorite('42', true);
  assert.equal(store.toggleFavorite('youtube:abc123'), true);
  assert.deepEqual(store.listFavorites(), ['42', 'youtube:abc123']);
  assert.equal(store.isFavorite(42), true);
  assert.equal(store.toggleFavorite(42), false);

  const reloaded = SavedState.createStore(storeOptions(storage));
  assert.deepEqual(reloaded.listFavorites(), ['youtube:abc123']);
  assert.equal(reloaded.getStatus().persistent, true);
});

test('saves and updates named views with map, layer, and opacity state', () => {
  const storage = SavedState.memoryStorage();
  const store = SavedState.createStore(storeOptions(storage));
  store.saveView('  Home   storms  ', snapshot(), { id: 'home' });
  let view = store.getView('home');
  assert.equal(view.name, 'Home storms');
  assert.deepEqual(view.snapshot, snapshot());
  assert.equal(view.createdAt, '2026-07-11T20:00:00.000Z');

  store.saveView('HOME STORMS', snapshot({ zoom: 9, opacity: { radar: 0.4 } }));
  assert.equal(store.listViews().length, 1);
  view = store.getView('home');
  assert.equal(view.snapshot.zoom, 9);
  assert.equal(view.snapshot.opacity.radar, 0.4);
  const deleted = store.getView('home');
  store.deleteView('home');
  assert.deepEqual(store.listViews(), []);
  store.restoreView(deleted);
  assert.deepEqual(store.getView('home'), deleted);
  assert.throws(() => store.restoreView(deleted), /conflicts/);
  store.deleteView('home');

  store.saveView('Generated one', snapshot());
  store.saveView('Generated two', snapshot());
  assert.equal(new Set(store.listViews().map((saved) => saved.id)).size, 2);
});

test('stores, restores, and clears an independent last-view snapshot', () => {
  const storage = SavedState.memoryStorage();
  const store = SavedState.createStore(storeOptions(storage));
  store.setLastView({
    map: { lat: 61.2, lng: -149.9, zoom: 6 },
    radarVisible: false,
    camerasVisible: true,
    radarOpacity: 0.25
  });
  assert.deepEqual(store.getLastView(), {
    center: { lat: 61.2, lon: -149.9 },
    zoom: 6,
    layers: { cameras: true, radar: false },
    opacity: { radar: 0.25 }
  });
  store.clearLastView();
  assert.equal(store.getLastView(), null);
});

test('exports and imports validated JSON without network or account state', () => {
  const sourceStorage = SavedState.memoryStorage();
  const sourceStore = SavedState.createStore(storeOptions(sourceStorage));
  sourceStore.setFavorite(7, true);
  sourceStore.saveView('Plains', snapshot(), { id: 'plains' });
  sourceStore.setLastView(snapshot({ zoom: 5 }));
  const exported = sourceStore.exportJson();
  assert.equal(JSON.parse(exported).version, 3);

  const targetStorage = SavedState.memoryStorage();
  const targetStore = SavedState.createStore(storeOptions(targetStorage));
  targetStore.importJson(exported);
  assert.deepEqual(targetStore.getState(), sourceStore.getState());
  assert.doesNotMatch(exported, /account|token|network/i);
});

test('decodes only bounded valid UTF-8 import bytes', () => {
  const text = '{"schema":"stormscope-saved-state"}';
  assert.equal(SavedState.decodeImportBytes(new TextEncoder().encode(text)), text);
  assert.throws(() => SavedState.decodeImportBytes(
    new Uint8Array(SavedState.MAX_IMPORT_BYTES + 1)
  ), /size limit/);
  assert.throws(() => SavedState.decodeImportBytes(new Uint8Array([0xC3, 0x28])), /UTF-8/);
});

test('current schema rejects coercible scalar types while explicit v0-v2 migrations retain coercion', () => {
  const source = SavedState.createStore(storeOptions(SavedState.memoryStorage()));
  source.setFavorite(7, true);
  source.saveView('Strict', snapshot(), { id: 'strict' });
  const canonical = source.getState();
  function changed(mutator) {
    const value = structuredClone(canonical);
    mutator(value);
    return value;
  }
  assert.throws(() => SavedState.migratePayload(changed(value => { value.version = '3'; })), /version/);
  assert.throws(() => SavedState.migratePayload(changed(value => { value.favorites = null; })), /array/);
  assert.throws(() => SavedState.migratePayload(changed(value => { value.favorites[0] = 7; })), /strings/);
  assert.throws(() => SavedState.migratePayload(changed(value => { value.views[0].snapshot.zoom = '7'; })), /finite number/);
  assert.throws(() => SavedState.migratePayload(changed(value => { value.views[0].snapshot.center.lat = false; })), /finite number/);
  assert.throws(() => SavedState.migratePayload(changed(value => { value.views[0].snapshot.opacity.radar = []; })), /finite number/);

  const legacy = SavedState.migratePayload({
    version: '2', favorites: [7], views: [{
      id: 'legacy', name: 'Legacy', createdAt: '2026-07-11T20:00:00Z',
      snapshot: { center: { lat: '39.1', lon: '-90.2' }, zoom: '7', layers: { radar: true }, opacity: { radar: '0.5' } }
    }], lastView: null
  }, { nowIso: '2026-07-11T20:00:00.000Z' });
  assert.equal(legacy.views[0].snapshot.zoom, 7);
  assert.equal(legacy.views[0].snapshot.opacity.radar, 0.5);
  assert.deepEqual(legacy.favorites, ['7']);
});

test('imports reject duplicate IDs and case-insensitive names without mutating state', () => {
  const storage = SavedState.memoryStorage();
  const store = SavedState.createStore(storeOptions(storage));
  store.saveView('Existing', snapshot(), { id: 'existing' });
  const before = store.getState();
  const beforeRaw = storage.getItem(SavedState.DEFAULT_KEY);

  const duplicateId = structuredClone(before);
  duplicateId.views.push(Object.assign({}, duplicateId.views[0], { name: 'Different name' }));
  assert.throws(() => store.importJson(JSON.stringify(duplicateId)), /IDs must be unique/);
  const duplicateName = structuredClone(before);
  duplicateName.views.push(Object.assign({}, duplicateName.views[0], { id: 'different', name: 'eXiStInG' }));
  assert.throws(() => store.importJson(JSON.stringify(duplicateName)), /names must be unique/);
  assert.deepEqual(store.getState(), before);
  assert.equal(storage.getItem(SavedState.DEFAULT_KEY), beforeRaw);
});

test('successful imports return a restorable previous snapshot', () => {
  const target = SavedState.createStore(storeOptions(SavedState.memoryStorage()));
  target.setFavorite(99, true);
  const previous = target.getState();
  const source = SavedState.createStore(storeOptions(SavedState.memoryStorage()));
  source.setFavorite(7, true);
  source.saveView('Imported', snapshot(), { id: 'imported' });

  const result = target.importJson(source.exportJson());
  assert.deepEqual(result.previous, previous);
  assert.deepEqual(result.state, source.getState());
  target.replaceState(result.previous);
  assert.deepEqual(target.getState().favorites, ['99']);
  assert.deepEqual(target.listViews(), []);
});

test('migrates v1 and unversioned payloads safely', () => {
  const v1 = {
    version: 1,
    favoriteCameraIds: [1, 'youtube:test', 1],
    savedViews: [{
      name: 'Legacy', lat: 40, lng: -100, zoom: 4,
      radarVisible: true, camerasVisible: false, radarOpacity: 0.5
    }],
    lastView: { center: { latitude: 35, longitude: -80 }, zoom: 8, layers: { radar: false } }
  };
  const migrated = SavedState.migratePayload(v1, { nowIso: '2026-07-11T20:00:00.000Z' });
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.favorites, ['1', 'youtube:test']);
  assert.equal(migrated.views[0].id, 'migrated-1');
  assert.deepEqual(migrated.views[0].snapshot.layers, { cameras: false, radar: true });
  assert.equal(migrated.lastView.center.lon, -80);

  const older = SavedState.migratePayload({ favorites: { '9': true, '10': false }, views: [] });
  assert.deepEqual(older.favorites, ['9']);
});

test('workflow profiles round-trip bounded settings while v2 views migrate unchanged', () => {
  const workflow = snapshot({
    radar: { palette: 'colorblind', speed: 400 },
    alertSeverity: 'severe',
    cameraFilters: { query: 'I-95', state: 'Virginia', source: 'dot', type: 'image', sort: 'distance', healthy: true, favorites: false },
    dataMode: 'low', weatherUnits: 'metric', outlookDay: 2
  });
  const store = SavedState.createStore(storeOptions(SavedState.memoryStorage()));
  store.saveView('Workflow', workflow, { id: 'workflow' });
  assert.deepEqual(store.getView('workflow').snapshot, workflow);

  const migrated = SavedState.migratePayload({
    schema: SavedState.SCHEMA, version: 2, favorites: [],
    views: [{ id: 'old', name: 'Old view', snapshot: snapshot(), createdAt: new Date(NOW).toISOString() }],
    lastView: null
  }, { nowIso: new Date(NOW).toISOString() });
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.views[0].snapshot, snapshot());
  assert.throws(() => store.saveView('Bad outlook', snapshot({ outlookDay: 4 })), /outlook day/);
});

test('corrupt imports and future versions do not overwrite good state', () => {
  const storage = SavedState.memoryStorage();
  const store = SavedState.createStore(storeOptions(storage));
  store.setFavorite(12, true);
  const beforeState = store.getState();
  const beforeRaw = storage.getItem(SavedState.DEFAULT_KEY);

  assert.throws(() => store.importJson('{broken'), SyntaxError);
  assert.throws(() => store.importJson(JSON.stringify({
    schema: SavedState.SCHEMA,
    version: 99,
    favorites: [], views: [], lastView: null
  })), /newer/);
  assert.deepEqual(store.getState(), beforeState);
  assert.equal(storage.getItem(SavedState.DEFAULT_KEY), beforeRaw);
});

test('recovers a valid backup without overwriting corrupt primary storage', () => {
  const storage = SavedState.memoryStorage();
  const good = SavedState.migratePayload({ favoriteCameraIds: [33] }, { nowIso: '2026-07-11T20:00:00.000Z' });
  storage.setItem(SavedState.DEFAULT_KEY, '{corrupt');
  storage.setItem(SavedState.DEFAULT_KEY + '.backup', JSON.stringify(good));
  const store = SavedState.createStore(storeOptions(storage));
  assert.deepEqual(store.listFavorites(), ['33']);
  assert.equal(store.getStatus().recoveredFromBackup, true);
  assert.ok(store.getStatus().loadError instanceof Error);
  assert.equal(storage.getItem(SavedState.DEFAULT_KEY), '{corrupt');
});

test('failed storage writes leave the in-memory last good state unchanged', () => {
  const backing = SavedState.memoryStorage();
  const storage = {
    getItem: backing.getItem,
    removeItem: backing.removeItem,
    setItem(key, value) {
      if (key === SavedState.DEFAULT_KEY) throw new Error('quota exceeded');
      backing.setItem(key, value);
    }
  };
  const store = SavedState.createStore(storeOptions(storage));
  assert.throws(() => store.setFavorite(1, true), /quota/);
  assert.deepEqual(store.listFavorites(), []);
});

test('failed view restore preserves the current state', () => {
  const backing = SavedState.memoryStorage();
  const source = SavedState.createStore(storeOptions(backing));
  source.saveView('Recover me', snapshot(), { id: 'recover-me' });
  const deleted = source.getView('recover-me');
  source.deleteView('recover-me');
  const before = source.getState();
  const storage = {
    getItem: backing.getItem,
    removeItem: backing.removeItem,
    setItem(key, value) {
      if (key === SavedState.DEFAULT_KEY) throw new Error('quota exceeded');
      backing.setItem(key, value);
    }
  };
  const store = SavedState.createStore(storeOptions(storage));
  assert.throws(() => store.restoreView(deleted), /quota/);
  assert.deepEqual(store.getState(), before);
});

test('rejects unsafe view payloads before persistence', () => {
  const storage = SavedState.memoryStorage();
  const store = SavedState.createStore(storeOptions(storage));
  assert.throws(() => store.saveView('', snapshot()), /name/);
  assert.throws(() => store.saveView('Bad zoom', snapshot({ zoom: 25 })), /zoom/);
  assert.throws(() => store.saveView('Bad opacity', snapshot({ opacity: { radar: 2 } })), /opacity/);
  assert.throws(() => store.saveView('Bad layer', snapshot({ layers: { ['__proto__']: true } })), /layer|object/);
  assert.throws(() => store.saveView('Bad workflow', snapshot({ dataMode: 'unlimited' })), /data mode/);
  assert.deepEqual(store.getState().views, []);
  assert.equal(storage.getItem(SavedState.DEFAULT_KEY), null);
});
