// Original, free cosmetic choices shared by the browser and server allowlists.
// Descriptions are presentation only: no catalog entry changes game mechanics.
const catalog = entries => Object.freeze(entries.map(entry => Object.freeze(entry)));

export const CHARACTERS = catalog([
  { id: 'momo', label: '모모', description: '동그란 물방울 머리와 작은 볼을 가진 탐험가' },
  { id: 'nori', label: '노리', description: '넓은 챙과 납작한 몸의 느긋한 길잡이' },
  { id: 'bibi', label: '비비', description: '길쭉한 두 귀와 통통 튀는 발걸음' },
  { id: 'toto', label: '토토', description: '네모난 머리와 튼튼한 장화의 든든한 친구' },
]);

export const SKINS = catalog([
  { id: 'classic', label: '클래식', description: '탐험 조끼, 매듭 스카프와 별 단추' },
  { id: 'sunset', label: '선셋', description: '노을 줄무늬 판초, 챙모자와 조개 장식' },
  { id: 'mint', label: '민트', description: '잎사귀 모자, 원예 앞치마와 작은 물뿌리개' },
  { id: 'astronaut', label: '우주 탐험가', description: '투명 우주 헬멧, 공기통과 계기판 우주복' },
  { id: 'bee', label: '꿀벌', description: '더듬이, 두 날개와 노랑 검정 벌무늬' },
  { id: 'raincoat', label: '레인코트', description: '물방울 후드, 방수 망토와 장화' },
]);

export const ORB_SKINS = catalog([
  { id: 'bubble', label: '물방울', description: '반짝이는 둥근 물방울' },
  { id: 'star', label: '별방울', description: '다섯 갈래 별을 품은 물방울' },
  { id: 'duck', label: '오리방울', description: '부리와 작은 날개가 달린 오리 물방울' },
]);

export const ITEM_STYLES = catalog([
  { id: 'classic', label: '클래식', description: '장비 배지 · 공통 능력 기호' },
  { id: 'candy', label: '캔디', description: '사탕 포장 · 공통 능력 기호' },
  { id: 'garden', label: '가든', description: '꽃잎과 잎사귀 · 공통 능력 기호' },
]);
