# 실시간 대전 프로토콜

## 연결 및 인증

브라우저와 Unity WebGL 클라이언트는 같은 WebSocket 서버에 연결한다. 운영 환경에서는 `wss://`를 사용한다. Supabase 익명 로그인 JWT를 `join.accessToken`으로 보내면 서버가 `/auth/v1/user`에서 검증한다. `ALLOW_DEV_GUESTS=true`는 로컬 개발용이며 공개 서버에서는 `false`로 둔다.

서비스 역할 키는 서버 환경변수에만 설정한다. 브라우저와 Unity에는 공개 anon 키만 제공한다. 서버는 인증된 참가자의 프로필과 경기 결과를 저장한다. `schema.sql` 다음으로 `20261102_team_match_history.sql`, `20261102_rankings.sql` 마이그레이션을 순서대로 적용해야 한다.

브라우저 익명 세션은 같은 탭의 `sessionStorage`에서 재사용한다. 장기 계정 연결은 아직 없다. 인증된 사용자의 프로필 저장이 실패하면 `profile_unavailable` 오류로 입장을 거부한다.

## 클라이언트 → 서버

```json
{ "type": "join", "roomId": "team-123", "mode": "team", "itemMode": true, "name": "Momo", "accessToken": "<Supabase JWT>", "characterId": "momo", "skinId": "classic", "mapId": "garden" }
{ "type": "input", "action": "up" }
{ "type": "input", "action": "place_orb" }
{ "type": "input", "action": "use_dart" }
```

- `mode`: `team`은 4대4, 생략하거나 `duel`이면 1대1이다.
- `characterId`: `momo`, `nori`, `bibi`, `toto`. `skinId`: `classic`, `sunset`, `mint`. 생략 시 `momo`, `classic`. 외형만 다르고 시작 능력치는 같다.
- `mapId`: `garden`, `lagoon`, `candy`. 첫 참가자가 정하며 기본값은 `garden`. 기존 방과 다른 값을 명시하면 `map_mismatch`, 알 수 없는 선택이면 `invalid_selection`이다.
- `itemMode`: boolean. 새 방의 기본값은 `true`. 기존 방에서는 생략 시 그 방의 설정을 따르고, 명시한 값이 다르면 `item_mode_mismatch`다. 문자열 등은 `invalid_join`이다.
- `practice`: 생략/`false`는 일반 대전, `true`는 사람 1명+AI 7명의 비랭크 팀 연습이다. boolean 이외 값은 `invalid_join`이다. 아래 격리 규칙을 따른다.
- `input.action`: `up`, `down`, `left`, `right`, `place_orb`, `use_dart`. 이동·설치·다트 요청을 분리해 같은 틱에 처리한다. 서버가 입력 빈도와 충돌·피해를 판정한다.
- 소켓 하나는 한 번만 입장할 수 있다. 같은 방의 중복 사용자, 정원 초과, 이미 시작한 방의 입장을 거부한다.

## 서버 → 클라이언트

```json
{ "type": "joined", "playerId": "uuid", "roomId": "team-123" }
{ "type": "state", "roomId": "team-123", "mode": "team", "mapId": "garden", "itemMode": true, "phase": "waiting", "tick": 0, "remaining": 1200, "players": [{ "id": "uuid", "name": "Momo", "team": "blue", "characterId": "momo", "skinId": "classic", "x": 1, "y": 1, "alive": true, "bubbleTicks": 0, "maxOrbs": 1, "range": 3, "dash": false, "pin": false, "speedLevel": 0, "moveCooldownTicks": 2, "darts": 0, "facing": "up", "score": 0 }], "soft": [], "items": [], "orbs": [], "waves": [], "dartEffects": [], "result": null }
{ "type": "error", "code": "unauthorized" }
```

서버는 초당 10틱으로 동작한다. `phase`는 `waiting`, `playing`, `finished`다. `remaining`은 남은 틱 수다. `soft`는 `"x,y"` 배열, `items`는 `{x,y,type}` 배열이다. `playerId`는 해당 입장의 ID다. `dartEffects`는 `{x,y,dx,dy,length,ttl}` 배열이며 발사 위치·방향·실제 사거리·남은 표시 틱을 제공한다. 좌표의 위쪽은 y 증가 방향이다.

클래식 팀전은 `blue`와 `pink`에 번갈아 배정하고 8명이 모이면 시작한다. 한 팀의 생존자가 없어지거나 120초가 지나면 생존자 수로 승패를 정하며 동률은 무승부다. 도중 연결이 끊긴 참가자는 경기에서 제외하지만 처음 참가자 명단은 결과 집계에 남긴다.

결과는 `draw: true`, 팀전의 `winnerTeam`, 또는 1대1의 `winnerId`를 포함한다. `result.scoreboard`는 `{id,name,team,score}`의 점수 내림차순 배열이다. 1대1에는 `team`이 없다.

## 아이템과 구조

아이템전에서만 파괴 블록의 드롭과 습득·사용이 가능하다. `orb`는 동시 설치 수를 최대 5까지, `wave`는 4방향 파동 길이를 최대 7까지 늘린다. `dash`는 한 칸 이동 간격을 2틱에서 1틱으로 줄인다. `pin`은 다음 피격 한 번을 막는다. `dart`는 최대 3발을 보유한다.

`use_dart`는 마지막 이동 방향으로 최대 7칸 발사한다. 벽과 파괴 블록에 막히며 첫 물폭탄을 점화하거나, 버블 아군을 구출하거나, 버블 적을 탈락시킨다. 탄약이 없거나 버블·탈락 상태이면 발사할 수 없다.

팀원은 버블 아군의 같은 칸이나 상하좌우 인접 칸으로 이동해 구조할 수 있다. 구출 후 5틱 동안 재피격을 막는다. 파동이 남아 있는 칸으로 이동하면 피격 판정을 받는다. 점수는 아이템 10, 블록 파괴 5, 구출 50, 적 탈락 100, 승리 200이다.

## 랭킹 HTTP API

`GET /api/leaderboard`는 `{source,entries}`를 반환한다. `source`는 개발 모드의 `demo` 또는 정식 모드의 `supabase`다. 각 항목은 `{rank,name,rating,tier,wins,losses,draws,score}`이며 상위 50명만 제공한다. 사용자 ID와 인증정보는 포함하지 않는다. 정식 모드에서 저장소에 접근할 수 없으면 503 오류를 반환한다.

레이팅은 1,000부터 시작해 승리 +25, 패배 −15, 무승부 +5, 최저 0이다. Bronze <1,100 / Silver ≥1,100 / Gold ≥1,250 / Diamond ≥1,450으로 표시한다. 경기 점수와 레이팅은 별개다. Supabase RPC는 경기별 결과를 원자적으로 한 번만 집계한다. 개발 랭킹은 메모리에만 있고 재시작 시 초기화된다.

## 검증 범위

서버 HTTP/WebSocket 검사, 실제 Chromium 8세션 대전과 다트 습득·구출, 격리된 PostgreSQL 마이그레이션·권한·중복 집계 검사를 제공한다. 실제 Supabase 프로젝트 연결과 Unity 빌드는 별도 검증이 필요하다. Unity에는 새 아이템전 선택·다트·랭킹 UI의 후속 확장이 필요하다. 자동 매칭과 재접속은 아직 없다.

## 비랭크 연습과 학습 피드백

```json
{ "type": "join", "practice": true, "name": "Popper", "characterId": "momo", "skinId": "classic", "mapId": "garden", "itemMode": true }
```

연습전은 인증 토큰 없이 시작할 수 있지만 서버가 고유한 방 ID와 `team` 모드를 강제한다. 클라이언트의 `roomId`를 공유방으로 사용하지 않는다. 다른 소켓의 기존 연습방 입장은 거부한다. 프로필/인증 서비스 호출과 경기/랭킹 저장을 하지 않으며, 정상 사람 간 대전의 인증 경계는 유지한다. 프로세스당 최대 8개 연습방을 허용하고 초과 시 `practice_unavailable`이다. 소유자 연결 종료 시 봇까지 정리하며, 경기 종료 후 120초에 남은 연결을 닫고 정리한다.

`state.practice`는 연습 여부, `players[].isBot`은 AI 여부다. AI는 일반 입력 처리·이동 쿨다운·아이템·피격·구출 규칙을 사용한다. 의사결정은 3틱마다 갱신한다. 초보용 경로 탐색이며 인간 숙련자의 전략을 모사하거나 재미가 검증된 AI라는 뜻은 아니다.

플레이어의 `bombsPlaced`, `itemsCollected`, `rescues`는 실제 수락된 설치·획득·구출 누적 횟수다. `result.scoreboard[].rescues`도 전송한다. 브라우저 안내는 같은 경기에서 실제 이동/설치/획득을 확인하며, 기본전에서는 아이템 단계를 선택 과제로 표시한다. 구조 알림은 같은 팀의 버블 상태와 남은 틱으로 계산한다. 재연습은 새 방이며 안내도 초기화한다.

## 릴레이 규칙과 같은 방 재대결

`join.ruleSet`은 `classic`(새 방 기본값) 또는 `relay`다. 기존 방에서 생략하면 방 규칙을 상속하고, 명시한 값이 다르면 `rule_set_mismatch`다. 유효하지 않은 값은 `invalid_rule_set`, 1대1 relay는 `invalid_rule_mode`다. 연습전은 원래대로 team을 강제한다. 일반 relay도 인증·프로필 검증이 필요하다.

추가 state 필드:

- `ruleSet`, `ranked`: classic이면서 연습이 아닐 때만 ranked=true. 개발 모드는 여전히 임시 랭킹이다.
- `matchId`: 실제 경기를 시작할 때 새 UUID. 대기는 null. `round`: 첫 라운드0, 재대결 준비 때+1.
- `rematch`: `{readyPlayerIds,total}`. total은 연결된 사람 수다.
- `relay`: classic은 null. relay는 `{scores:{blue,pink},goal:3,star:{x,y}|null,carrierId,respawnTicks,bases:{blue:{x:1,y:5},pink:{x:11,y:5}}`.
- 플레이어 `deliveries`, `respawnTicks`; 결과 점수판에도 `deliveries` 포함.

중앙(6,5)의 별을 우리 기지로 전달하면 팀1점/개인150점, 별은50틱 후 중앙 재등장한다. 피격되어 버블이 되거나 탈락/연결 종료하면 별을 떨어뜨리며 같은 틱 재획득을 막는다. 탈락 후50틱에 시작 위치가 안전하면 복귀하며10틱 보호한다. 성장은 유지한다. 3점 또는1200틱 점수 우위로 승리, 동점은 무승부다. 한 팀의 연결된 사람이 없으면 기권승이다. 결과 reason은 `relay_goal`, `relay_time`, `forfeit`이며 `relayScores`를 포함한다. relay의 결과/레이팅은 저장하지 않는다.

일반방의 finished 상태에서 `{ "type":"rematch" }`를 보내면 준비한다. 중복 요청은1회로 처리한다. 연결된 모든 참가자가 준비하면 맵·전투·점수·입력·아이템·릴레이를 초기화하고 round를 올린다. ID·팀·소켓·외형·방 설정은 유지한다. 정원이면 바로 새 matchId로 시작하고 부족하면 waiting에서 새 참가자를 받는다. 이탈 시 준비 인원을 다시 판단한다. 대기/진행 중 요청은 무시한다. 연습전은 이 프로토콜을 사용하지 않고 새 개인 방으로 다시 시작한다.

초대 URL은 `room`, `mode`, `map`, `items=1|0`, `rules`만 내보내며 토큰·이름·키를 포함하지 않는다. 링크는 설정만 채우며 자동 입장하지 않는다. 실제 같은 방 규칙의 최종 판단은 서버가 수행한다.
