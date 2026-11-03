const messages = {
  saving: '경기 기록을 저장하고 있어요.',
  retrying: '저장 연결이 지연되고 있어요. 서버가 다시 시도합니다.',
  saved: '경기 기록과 랭킹 반영을 확인했어요.',
  failed: '경기 기록을 저장하지 못했어요.',
  demo: '개발 서버의 임시 랭킹에만 반영했어요. 서버 재시작 시 초기화됩니다.',
  unranked: '비랭크 경기 · 전적과 랭킹에 저장하지 않아요.',
  unknown: '저장 상태를 확인하지 못했어요.'
};

/** Only a confirmation for the currently displayed match can refresh its ranking. */
export function createResultSavingPresenter() {
  const refreshedMatches = new Set();
  return {
    update(state) {
      if (state?.phase !== 'finished') return { hidden: true, status: 'none', text: '', refreshLeaderboard: false };
      const report = state.resultSaving;
      const matched = typeof state.matchId === 'string' && state.matchId.length > 0 && report?.matchId === state.matchId;
      let status = matched && Object.hasOwn(messages, report.status) ? report.status : 'unknown';
      if ((state.practice === true || state.ruleSet === 'relay') && status !== 'unranked') status = 'unknown';
      const refreshLeaderboard = (status === 'saved' || status === 'demo') && !refreshedMatches.has(state.matchId);
      if (refreshLeaderboard) refreshedMatches.add(state.matchId);
      return { hidden: false, status, text: messages[status], refreshLeaderboard };
    }
  };
}
