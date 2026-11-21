// Free starting items for solo AI item matches, in shop display order.
// An unequipped loadout omits the item ID on join.
export const PRACTICE_ITEMS = Object.freeze([
  { id: 'orb', label: '여분 물방울', description: '동시에 설치할 수 있는 물폭탄이 1개에서 2개로 늘어나요.' },
  { id: 'wave', label: '파동 앰플', description: '물폭탄의 파동이 각 방향으로 3칸에서 4칸까지 뻗어요.' },
  { id: 'dash', label: '물결 운동화', description: '한 칸 이동한 뒤 다음 칸으로 움직이기까지 걸리는 시간이 절반으로 줄어요.' },
  { id: 'dart', label: '구조 다트', description: '다트 1발을 가지고 시작해요. 바라보는 방향으로 쏴서 버블에 갇힌 아군을 구할 수 있어요.' },
  { id: 'needle', label: '비상 바늘', description: '물방울에 갇혔을 때 한 번 스스로 탈출할 수 있어요.' },
].map(item => Object.freeze(item)));

export function canUseRescueNeedle(room, player) {
  return room?.phase === 'playing' && room.practice === true && room.itemMode === true && !room.training &&
    player?.alive === true && !player.isBot && player.connected !== false && player.bubbleTicks > 0 && player.rescueNeedles > 0;
}
