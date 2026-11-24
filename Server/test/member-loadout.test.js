import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreferences } from '../public/preferences.js';
import { createMemberLoadout } from '../public/member-loadout.js';

const guest = { characterId: 'nori', skinId: 'bee', orbSkinId: 'duck' };
const saved = { characterId: 'bibi', skinId: 'tabby', orbSkinId: 'star' };
function fixture(overrides = {}) {
  const preferences = createPreferences(null);
  preferences.update({loadout: {...guest, practiceItemId: 'dash'}});
  let userId;
  const client = {
    getSession: () => userId ? {user: {id: userId}} : null,
    getLoadout: async () => ({loadout: null}),
    saveLoadout: async loadout => ({loadout}),
    ...overrides
  };
  const sync = createMemberLoadout({preferences, client, onChange() {}});
  return {sync, preferences, select(id) { userId = id; return sync.setMember(id); }};
}

test('existing device choices need explicit adoption and remote outfits never replace guest preferences', async () => {
  const writes = [];
  const f = fixture({saveLoadout: async loadout => { writes.push(loadout); return {loadout}; }});
  await f.select('alice');
  assert.equal(f.sync.status, 'new');
  assert.deepEqual(f.sync.appearance, guest);
  assert.deepEqual(writes, []);
  await f.sync.saveCurrent();
  assert.deepEqual(writes, [guest]);
  await f.sync.equip({skinId:'cat'});
  assert.deepEqual(writes.at(-1), {...guest, skinId:'cat'});
  assert.equal(f.preferences.value.loadout.skinId, 'bee');
  assert.equal(f.preferences.value.loadout.practiceItemId, 'dash');
  await f.select(null);
  assert.deepEqual(f.sync.appearance, guest);
  await f.sync.equip({skinId:'mint'});
  assert.equal(f.preferences.value.loadout.skinId, 'mint');
  assert.equal(writes.length, 2);
});

test('edits during the initial load merge with the cloud outfit and serialized writes end on the latest explicit choice', async () => {
  const loading = Promise.withResolvers(), writing = Promise.withResolvers();
  const writes = [];
  const f = fixture({
    getLoadout: () => loading.promise,
    saveLoadout: async loadout => { writes.push(loadout); if (writes.length === 1) await writing.promise; return {loadout}; }
  });
  const read = f.select('alice');
  void f.sync.equip({skinId:'cat'});
  assert.deepEqual(writes, []);
  loading.resolve({loadout:saved});
  await read;
  assert.deepEqual(writes, [{...saved, skinId: 'cat'}]);
  const done = f.sync.equip({orbSkinId:'bubble'});
  writing.resolve();
  await done;
  assert.deepEqual(writes, [{...saved, skinId:'cat'}, {...saved, skinId:'cat', orbSkinId:'bubble'}]);
  assert.equal(f.sync.status, 'saved');
});

test('a late read or write for another member cannot change the current outfit or send a queued write', async () => {
  const reading = Promise.withResolvers(), writing = Promise.withResolvers();
  const writes = [];
  let first = true;
  const f = fixture({
    getLoadout: () => { if (first) { first=false;return reading.promise; } return Promise.resolve({loadout:null}); },
    saveLoadout: async loadout => { writes.push(loadout); await writing.promise; return {loadout}; }
  });
  const a = f.select('a');
  await f.select('b');
  reading.resolve({loadout:saved});
  await a;
  assert.deepEqual(f.sync.appearance, guest);
  const set = f.sync.equip({skinId:'cat'});
  void f.sync.equip({skinId:'tabby'});
  await f.select('c');
  writing.resolve(); await set;
  assert.deepEqual(f.sync.appearance, guest);
  assert.deepEqual(writes,[{...guest,skinId:'cat'}]);
});

test('read and write failures are retriable and do not clobber unobserved member fields', async () => {
  let reads = 0, writes = 0;
  const f = fixture({
    getLoadout: async () => { if (++reads === 1) throw Error('offline'); return {loadout:saved}; },
    saveLoadout: async loadout => { if (++writes === 1) throw Error('offline'); return {loadout}; }
  });
  await f.select('member');
  assert.equal(f.sync.status, 'read-error');
  await f.sync.equip({skinId:'tuxedo'});
  assert.equal(writes, 0);
  await f.sync.retry();
  await f.sync.retry();
  assert.equal(f.sync.status, 'saved');
  assert.deepEqual(f.sync.appearance, {...saved, skinId:'tuxedo'});
  assert.equal(writes, 2);
});

test('signing back into the same account reads after its last in-flight save', async () => {
  const ack = Promise.withResolvers();
  let remote = saved;
  const f = fixture({
    getLoadout: async () => ({loadout: remote}),
    saveLoadout: async loadout => { await ack.promise; remote = loadout; return {loadout}; }
  });
  await f.select('same-member');
  const first = f.sync.equip({skinId:'cat'});
  await f.select(null);
  const restored = f.select('same-member');
  assert.equal(f.sync.status, 'loading');
  ack.resolve();
  await Promise.all([first, restored]);
  assert.deepEqual(f.sync.appearance, {...saved, skinId:'cat'});
  assert.equal(f.sync.status, 'saved');
});
