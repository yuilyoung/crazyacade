// Read-only labels from authoritative capabilities; no client-side upgrades.
export function pickupLabel(type, player = {}) {
  if (type === 'orb' && Number.isInteger(player.maxOrbs)) return `폭탄 ${player.maxOrbs}/5`;
  if (type === 'wave' && Number.isInteger(player.range)) return `물줄기 ${player.range}/7`;
  if (type === 'dash' && [1,2].includes(player.moveCooldownTicks)) return `속도 ${10/player.moveCooldownTicks}칸/초`;
  return ({orb:'폭탄 +',wave:'물줄기 +',dash:'속도 +',pin:'보호 핀',dart:'다트 +'})[type] || '획득';
}
