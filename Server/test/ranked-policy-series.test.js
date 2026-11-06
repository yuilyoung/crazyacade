import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRankedMatch } from '../src/ranked-policy.js';
import { buildMatchPayload } from '../src/supabase.js';
import { finalizeMatch, getLeaderboard } from '../src/rankings.js';
import { createResultOutbox } from '../src/result-outbox.js';

const party = (extra = {}) => ({
  id: 'party-room', matchId: 'd0000000-0000-4000-8000-000000000085', mode: 'team',
  ruleSet: 'classic', ranked: true, seriesMode: 'party3', result: { winnerTeam: 'blue' },
  participants: [{ userId: 'party-user', name: 'PartyOnly', team: 'blue', score: 1000 }], ...extra
});

test('party selection and active party state cannot enter the ranked policy', () => {
  for (const match of [party(), party({ seriesMode: undefined, series: { id: 'active-party' } }), party({ seriesMode: 'unknown' })]) {
    assert.equal(isRankedMatch(match), false);
    assert.throws(() => buildMatchPayload(match), /Invalid ranked result/);
  }
  assert.equal(isRankedMatch(party({ seriesMode: 'single', series: null })), true);
  assert.equal(isRankedMatch(party({ seriesMode: undefined })), true, 'legacy single matches remain ranked');
});

test('party results never add demo rating or production payloads', async () => {
  const env = { ALLOW_DEV_GUESTS: 'true' };
  const before = await getLeaderboard(env);
  await finalizeMatch(party(), env);
  assert.deepEqual(await getLeaderboard(env), before);
  await finalizeMatch(party({ seriesMode: undefined, series: { id: 'active-party' } }), env);
  assert.deepEqual(await getLeaderboard(env), before);
});

test('outbox rejects party results before a result file or provider delivery exists', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poppop-party-policy-'));
  const box = createResultOutbox({ directory, persist: async () => assert.fail('party result reached ranked provider') });
  t.after(async () => { await box.close(); await rm(directory, { recursive: true, force: true }); });
  await box.start();
  await assert.rejects(box.enqueue(party()), /Invalid ranked result/);
  assert.equal((await readdir(directory)).some(file => file.endsWith('.json')), false);
  assert.equal(box.diagnostics().pending, 0);
});
