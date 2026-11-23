import { CHARACTERS, SKINS, ORB_SKINS } from './cosmetics.js';

function appearance({characterId, skinId, orbSkinId}) {
  return {characterId, skinId, orbSkinId};
}

function checkedLoadout(value) {
  if (!CHARACTERS.some(item => item.id === value?.characterId) ||
      !SKINS.some(item => item.id === value?.skinId) ||
      !ORB_SKINS.some(item => item.id === value?.orbSkinId)) throw Error('Invalid member loadout');
  return appearance(value);
}

// Device preferences own the guest outfit. Member outfits are read from the account only.
export function createMemberLoadout({client, preferences, onChange}) {
  let member = null;
  const outstandingWrites = new Map();
  const selected = () => ({...appearance(member?.saved ?? preferences.value.loadout), ...member?.edits});

  function isCurrent(scope) {
    if (scope !== member) return false;
    const id = client.getSession()?.user.id ?? null;
    if (id === scope.id) return true;
    setMember(id);
    return false;
  }

  function write(scope) {
    if (!isCurrent(scope) || scope.saved === undefined || !scope.edits || scope.writing) return scope.writing;
    scope.writing = (async () => {
      try {
        while (scope.edits && isCurrent(scope)) {
          const edits = scope.edits;
          scope.status = 'saving';
          onChange();
          const {loadout} = await client.saveLoadout(selected());
          if (!isCurrent(scope)) return;
          scope.saved = checkedLoadout(loadout);
          if (edits === scope.edits) scope.edits = null;
        }
        scope.status = 'saved';
      } catch {
        scope.status = 'save-error';
      } finally {
        if (outstandingWrites.get(scope.id) === scope.writing) outstandingWrites.delete(scope.id);
        scope.writing = null;
        if (isCurrent(scope)) onChange();
      }
    })();
    outstandingWrites.set(scope.id, scope.writing);
    return scope.writing;
  }

  function read(scope) {
    scope.status = 'loading';
    onChange();
    scope.reading = (async () => {
      try {
        // A fast sign-out/sign-in of the same account should observe its last sent update.
        const previous = outstandingWrites.get(scope.id);
        if (previous) await previous;
        if (!isCurrent(scope)) return;
        const {loadout} = await client.getLoadout();
        if (!isCurrent(scope)) return;
        scope.saved = loadout === null ? null : checkedLoadout(loadout);
        scope.status = scope.saved ? 'saved' : 'new';
      } catch {
        scope.status = 'read-error';
      } finally {
        scope.reading = null;
        if (isCurrent(scope)) {
          onChange();
          if (scope.edits && scope.saved !== undefined) void write(scope);
        }
      }
    })();
    return scope.reading;
  }

  function setMember(id) {
    if (id === (member?.id ?? null)) return member?.reading;
    if (!id) { member = null; onChange(); return; }
    member = {id, saved: undefined, edits: null, reading: null, writing: null};
    return read(member);
  }

  function equip(patch) {
    if (!member) { preferences.update({loadout:patch}); onChange(); return; }
    member.edits = {...member.edits, ...patch};
    onChange();
    return write(member);
  }

  return {
    setMember, equip,
    get appearance() { return selected(); },
    get status() { return member?.status ?? 'guest'; },
    saveCurrent() { return equip(selected()); },
    async retry() {
      if (!member) return;
      const scope = member;
      if (scope.status === 'read-error') await read(scope);
      else if (scope.status === 'save-error') await write(scope);
      await scope.writing;
    }
  };
}
