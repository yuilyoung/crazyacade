import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthProvider } from '../src/supabase.js';

test('joining a game never overwrites an edited nickname with old signup metadata', async () => {
  let saved = { id: 'member', nickname: 'EditedName', rating: 1230, wins: 4 };
  const provider = createAuthProvider({ env: { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server' }, fetchImpl: async (_url, options) => {
    const proposed = JSON.parse(options.body);
    if (options.headers.Prefer === 'resolution=merge-duplicates') saved = { ...saved, ...proposed };
    else if (options.headers.Prefer !== 'resolution=ignore-duplicates') throw Error('Expected safe upsert conflict handling');
    return new Response(null, { status: 201 });
  } });
  await provider.upsertProfile({ id: 'member', user_metadata: { nickname: 'SignupName' } }, 'GameName');
  assert.deepEqual(saved, { id: 'member', nickname: 'EditedName', rating: 1230, wins: 4 });
});
