import { CHARACTERS, SKINS, ORB_SKINS } from './cosmetics.js';
import { drawAvatar } from './visuals.js';
import { buildInviteUrl, parseInvite } from './invite.js';
import { ownPartyContributions } from './party-contributions.js';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const allowed = (catalog, value) => catalog.some(entry => entry.id === value) ? value : catalog[0].id;
const RULE_NAMES = { classic: '클래식', relay: '팝 릴레이', harmony: '하모니' };
const MAP_NAMES = { garden: '팝 가든', lagoon: '버블 라군', candy: '캔디 코브', harbor: '썰물 부두', festival: '풍선 광장' };

// A public, identity-free projection. Never spread a server player or result into a card.
export function createResultCardData(state, playerId) {
  if (state?.phase !== 'finished' || typeof playerId !== 'string' || !playerId) return null;
  const party = state.series?.complete === true;
  const aggregate = party ? ownPartyContributions(state.series,playerId) : null;
  const own = party ? aggregate && { ...aggregate.totals,team:aggregate.team } : state.result?.scoreboard?.find(player => player.id === playerId);
  if (!own) return null;
  const player = state.players?.find(player => player.id === playerId);
  if (!player) return null;
  const team = own.team === 'blue' || own.team === 'pink' ? own.team : null;
  const result = party ? state.series.outcome : state.result;
  const outcome = result?.draw === true ? 'draw'
    : team && ['blue', 'pink'].includes(result?.winnerTeam) ? (result.winnerTeam === team ? 'victory' : 'defeat') : 'finished';
  return Object.freeze({ version: 1,
    ruleSet: Object.hasOwn(RULE_NAMES, state.ruleSet) ? state.ruleSet : 'classic',
    mapId: Object.hasOwn(MAP_NAMES, state.mapId) ? state.mapId : 'garden', outcome,
    practice: Boolean(state.practice || state.training || state.withBots),
    ...(party ? {party:true,bombsPlaced:own.bombsPlaced,itemsCollected:own.itemsCollected} : {}),
    score: count(own.score), rescues: count(own.rescues), passes: count(own.passes),
    interceptions: count(own.interceptions), deliveries: count(own.deliveries),
    appearance: Object.freeze({ characterId: allowed(CHARACTERS, player.characterId),
      skinId: allowed(SKINS, player.skinId), orbSkinId: allowed(ORB_SKINS, player.orbSkinId), team }) });
}

function circle(ctx, x, y, radius, fill) {
  ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}

export function renderResultCard(data, { canvas = globalThis.document.createElement('canvas'), drawAvatar: avatar = drawAvatar } = {}) {
  if (!data) throw new Error('A finished result is required.');
  canvas.width = 1200; canvas.height = 630;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');
  const gradient = ctx.createLinearGradient(0, 0, 1200, 630);
  gradient.addColorStop(0, '#102e4a'); gradient.addColorStop(1, '#205b64');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1200, 630);
  for (const [x, y, size] of [[70, 90, 26], [1100, 80, 90], [1075, 550, 110], [350, 520, 38]]) {
    circle(ctx, x, y, size, '#ffffff0a');
  }
  ctx.textAlign = 'left'; ctx.fillStyle = '#9ff3dc'; ctx.font = 'bold 24px sans-serif';
  ctx.fillText('POP POP ARENA', 62, 65);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 51px sans-serif';
  ctx.fillText(({ victory: '함께 만든 승리!', defeat: '다음 판도 함께!', draw: '끝까지 팽팽하게!', finished: '나의 플레이 기록' })[data.outcome] || '나의 플레이 기록', 60, 137);
  ctx.fillStyle = '#cce6ed'; ctx.font = '24px sans-serif';
  ctx.fillText(`${RULE_NAMES[data.ruleSet] || RULE_NAMES.classic} · ${MAP_NAMES[data.mapId] || MAP_NAMES.garden}`, 62, 181);
  if(data.party) { ctx.font='20px sans-serif';ctx.fillText(`파티 전체 · 물폭탄 ${count(data.bombsPlaced)}개 · 아이템 ${count(data.itemsCollected)}개`,62,218); }
  circle(ctx, 213, 356, 113, '#ffffff16');
  ctx.save(); ctx.translate(213, 368); ctx.scale(3.3, 3.3);
  avatar(ctx, data.appearance, { time: 0, reducedMotion: true }); ctx.restore();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 24px sans-serif';
  ctx.fillText(data.party ? '나의 파티 전체 기여' : '나의 팀 기여', 213, 519);
  const metrics = [['점수', data.score], ['구출', data.rescues], ['패스', data.passes], ['가로채기', data.interceptions], ['별 전달', data.deliveries]];
  metrics.forEach(([label, value], index) => {
    const x = index < 2 ? 475 + index * 330 : 443 + (index - 2) * 245;
    const y = index < 2 ? 315 : 458;
    ctx.fillStyle = '#fff'; ctx.font = `bold ${index < 2 ? 60 : 44}px sans-serif`; ctx.fillText(String(count(value)), x, y);
    ctx.fillStyle = '#bfe4e8'; ctx.font = '23px sans-serif'; ctx.fillText(label, x, y + 36);
  });
  ctx.textAlign = 'left'; ctx.fillStyle = '#cce6ed'; ctx.font = '20px sans-serif';
  ctx.fillText(`${data.party ? '3라운드 파티 · 비랭크' : data.practice ? 'AI / 훈련 · 비랭크' : data.ruleSet === 'classic' ? '완료된 경기의 내 기록' : '협동 모드 · 비랭크'} · 초기 POC`, 62, 585);
  ctx.textAlign = 'right'; ctx.fillStyle = '#9ff3dc'; ctx.fillText('구하고 · 패스하고 · 다시 한 판', 1138, 585);
  return canvas;
}

function safeInvite(getInviteUrl) {
  try {
    const url = new URL(getInviteUrl());
    return buildInviteUrl(url.href, parseInvite(url.search));
  } catch { return null; }
}

function resultText(data) {
  return `Pop Pop Arena · ${data.party ? '3라운드 파티 전체 내 기여 · 비랭크' : '나의 기록'}: ${count(data.score)}점 · 구출 ${count(data.rescues)} · 패스 ${count(data.passes)} · 가로채기 ${count(data.interceptions)} · 별 전달 ${count(data.deliveries)}${data.party ? ` · 물폭탄 ${count(data.bombsPlaced)} · 아이템 ${count(data.itemsCollected)}` : ''}. 구하고 패스하는 팀 배틀! (초기 POC)`;
}

// Invoke these actions only from player clicks. No network posting or persistent storage.
export function createResultSharing({ getResult, getInviteUrl = () => null, navigator = globalThis.navigator,
  document = globalThis.document, canvasFactory = () => document.createElement('canvas'),
  urlApi = globalThis.URL, defer = fn => setTimeout(fn, 1000) } = {}) {
  const response = (status, message) => ({ status, message });
  async function copy(data) {
    const url = safeInvite(getInviteUrl);
    if (!url) return response('unavailable', '초대 링크를 만들 수 없어요. 결과 카드 다운로드를 이용해 주세요.');
    try {
      await navigator.clipboard.writeText(`${resultText(data)}\n${url}`);
      return response('copied', '내 기록과 초대 링크를 복사했어요. 원하는 곳에 직접 붙여 넣어 주세요.');
    } catch { return response('manual', `복사를 사용할 수 없어요. 이 초대 링크를 직접 복사해 주세요: ${url}`); }
  }
  async function png(data) {
    const canvas = renderResultCard(data, { canvas: canvasFactory() });
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob?.type === 'image/png' ? resolve(blob) : reject(new Error('PNG unavailable')), 'image/png'));
  }
  async function download() {
    const data = getResult();
    if (!data) return response('unavailable', '경기가 끝나면 내 결과 카드를 만들 수 있어요.');
    let objectUrl;
    try {
      objectUrl = urlApi.createObjectURL(await png(data));
      const link = document.createElement('a'); link.href = objectUrl; link.download = 'pop-pop-arena-result.png';
      document.body.append(link); link.click(); link.remove();
      return response('downloaded', '결과 카드 PNG 다운로드를 요청했어요.');
    } catch { return copy(data); }
    finally { if (objectUrl) defer(() => urlApi.revokeObjectURL(objectUrl)); }
  }
  async function share() {
    const data = getResult();
    if (!data) return response('unavailable', '경기가 끝나면 내 결과를 공유할 수 있어요.');
    if (typeof navigator?.share !== 'function') return copy(data);
    try {
      const url = safeInvite(getInviteUrl);
      const payload = { title: 'Pop Pop Arena · 나의 플레이 기록', text: resultText(data), ...(url ? { url } : {}) };
      // File support is optional; a refused PNG still leaves the safe invitation usable.
      try {
        if (typeof navigator.canShare === 'function' && typeof globalThis.File === 'function') {
          const file = new File([await png(data)], 'pop-pop-arena-result.png', { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) payload.files = [file];
        }
      } catch { /* Continue with the result text and safe URL. */ }
      await navigator.share(payload);
      return response('shared', '공유 창에 내 기록을 전달했어요.');
    } catch (error) {
      if (error?.name === 'AbortError') return response('cancelled', '공유를 취소했어요.');
      return copy(data);
    }
  }
  return Object.freeze({ download, share });
}
