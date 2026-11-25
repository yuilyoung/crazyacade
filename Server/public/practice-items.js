export const BATTLE_ITEMS = Object.freeze([
  { id: 'orb', label: '여분 물방울', unit: '개', starter: true, description: '동시에 설치할 수 있는 물폭탄이 1개에서 2개로 늘어나요.' },
  { id: 'wave', label: '파동 앰플', unit: '칸', starter: true, description: '물폭탄의 파동이 각 방향으로 3칸에서 4칸까지 뻗어요.' },
  { id: 'dash', label: '물결 운동화', unit: '단계', starter: true, description: '한 칸 이동한 뒤 다음 칸으로 움직이기까지 걸리는 시간이 절반으로 줄어요.' },
  { id: 'pin', label: '보호 핀', unit: '개', description: '가지고 있으면 물폭탄에 맞았을 때 한 번 자동으로 막아요.' },
  { id: 'dart', label: '구조 다트', unit: '발', starter: true, action: 'use_dart', description: '다트 1발을 가지고 시작해요. 바라보는 방향으로 쏴서 버블에 갇힌 아군을 구할 수 있어요.' },
  { id: 'needle', label: '비상 바늘', unit: '개', starter: true, action: 'use_needle', description: '물방울에 갇혔을 때 한 번 스스로 탈출할 수 있어요.' },
].map(item => Object.freeze({ ...item, icon: `/assets/items/${item.id}.webp` })));

// This allowlist is also used by the server to validate starting gear.
export const PRACTICE_ITEMS = Object.freeze(BATTLE_ITEMS.filter(item => item.starter));

export function isPracticeItemMatch(room) {
  return room?.practice === true && room.itemMode === true && !room.training;
}

export function canUseRescueNeedle(room, player) {
  return room?.phase === 'playing' && isPracticeItemMatch(room) &&
    player?.alive === true && !player.isBot && player.connected !== false && player.bubbleTicks > 0 && player.rescueNeedles > 0;
}
