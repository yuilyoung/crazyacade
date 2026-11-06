const counters = ['score','bombsPlaced','itemsCollected','rescues','passes','interceptions','deliveries'];
function ownRecord(records, playerId, maximum) {
  if (!Array.isArray(records)) return null;
  const owned = records.filter(record => record?.playerId === playerId);
  if (owned.length !== 1 || counters.some(key => !Number.isSafeInteger(owned[0][key]) || owned[0][key] < 0 || owned[0][key] > maximum)) return null;
  return { team: ['blue','pink'].includes(owned[0].team) ? owned[0].team : null,
    totals: Object.freeze(Object.fromEntries(counters.map(key => [key,owned[0][key]]))) };
}
/** Only the server's completed-party aggregate is a source for final personal totals. */
export function ownPartyContributions(series, playerId) {
  if (!series?.complete || series.round !== 3 || series.total !== 3 || typeof playerId !== 'string' || !playerId) return null;
  const own = ownRecord(series.contributions, playerId, 3000000);
  if (!own) return null;
  const history = Array.isArray(series.history) ? series.history : [];
  const rounds = [1,2,3].map(round => {
    const records = history.filter(entry => entry?.round === round), entry = records.length === 1 ? records[0] : null;
    return Object.freeze({ round, mapId: entry?.mapId || null, totals: ownRecord(entry?.contributions, playerId, 1000000)?.totals || null });
  });
  return Object.freeze({ ...own, rounds: Object.freeze(rounds) });
}
export function contributionText(totals) {
  if (!totals) return '내 기여 기록을 확인하지 못했어요.';
  return `${totals.score}점 · 구출 ${totals.rescues}회 · 패스 ${totals.passes}회 · 전달 ${totals.deliveries}회 · 아이템 ${totals.itemsCollected}개 · 물폭탄 ${totals.bombsPlaced}개 · 가로채기 ${totals.interceptions}회`;
}
