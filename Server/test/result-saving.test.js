import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResultSavingPresenter } from '../public/result-saving.js';

const finished = (status, matchId = 'match-a', extra = {}) => ({
  phase: 'finished', matchId, practice: false, ruleSet: 'classic',
  resultSaving: { matchId, status, attempts: 1 }, ...extra
});

test('a completed match distinguishes saving, retrying, failure and confirmed persistence', () => {
  const presenter = createResultSavingPresenter();
  for (const status of ['saving', 'retrying', 'failed']) {
    const view = presenter.update(finished(status));
    assert.equal(view.status, status);
    assert.equal(view.hidden, false);
    assert.equal(view.refreshLeaderboard, false);
    assert.ok(!view.text.includes('확인했어요'));
  }
  const saved = presenter.update(finished('saved'));
  assert.equal(saved.status, 'saved');
  assert.equal(saved.text, '경기 기록과 랭킹 반영을 확인했어요.');
  assert.equal(saved.refreshLeaderboard, true);
});

test('unknown, missing, malformed and mismatched reports never claim saved or refresh ranking', () => {
  const presenter = createResultSavingPresenter();
  for (const resultSaving of [null, undefined, {}, { status: 'saved' },
    { matchId: 'match-a', status: 'unexpected' }, { matchId: 'older-match', status: 'saved' }]) {
    const view = presenter.update(finished('saved', 'match-a', { resultSaving }));
    assert.equal(view.status, 'unknown');
    assert.equal(view.text, '저장 상태를 확인하지 못했어요.');
    assert.equal(view.refreshLeaderboard, false);
  }
});

test('only one confirmed update per match refreshes ranking across repeated snapshots and reconnect', () => {
  const presenter = createResultSavingPresenter();
  assert.equal(presenter.update(finished('retrying')).refreshLeaderboard, false);
  assert.equal(presenter.update(finished('saved')).refreshLeaderboard, true);
  for (let i = 0; i < 5; i++) assert.equal(presenter.update(structuredClone(finished('saved'))).refreshLeaderboard, false);
  assert.equal(presenter.update(null).hidden, true);
  assert.equal(presenter.update(finished('saved')).refreshLeaderboard, false);
  assert.equal(presenter.update(finished('saved', 'match-b')).refreshLeaderboard, true);
  assert.equal(presenter.update(finished('saved')).refreshLeaderboard, false);
});

test('new rounds hide old status and cannot reuse a prior match confirmation', () => {
  const presenter = createResultSavingPresenter();
  presenter.update(finished('saved'));
  for (const phase of ['waiting', 'playing']) {
    const view = presenter.update({ ...finished('saved'), phase });
    assert.equal(view.hidden, true);
    assert.equal(view.text, '');
    assert.equal(view.refreshLeaderboard, false);
  }
  const next = presenter.update(finished('saved', 'match-b', { resultSaving: { matchId: 'match-a', status: 'saved' } }));
  assert.equal(next.status, 'unknown');
  assert.equal(next.refreshLeaderboard, false);
});

test('demo and unranked results never claim permanent persistence', () => {
  const presenter = createResultSavingPresenter();
  const demo = presenter.update(finished('demo'));
  assert.equal(demo.status, 'demo');
  assert.match(demo.text, /임시 랭킹/);
  assert.match(demo.text, /초기화/);
  assert.equal(demo.refreshLeaderboard, true);
  assert.equal(presenter.update(finished('demo')).refreshLeaderboard, false);
  for (const extra of [{ practice: true }, { ruleSet: 'relay' }]) {
    const unranked = presenter.update(finished('unranked', 'match-c', extra));
    assert.equal(unranked.status, 'unranked');
    assert.match(unranked.text, /저장하지 않아요/);
    assert.equal(unranked.refreshLeaderboard, false);
    assert.equal(presenter.update(finished('saved', 'match-c', extra)).status, 'unknown');
  }
});
