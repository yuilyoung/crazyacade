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
- `input.action`: `up`, `down`, `left`, `right`, `place_orb`, `use_dart`. 이동·설치·다트 요청을 분리해 같은 틱에 처리한다. 서버가 입력 빈도와 충돌·피해를 판정한다.
- 소켓 하나는 한 번만 입장할 수 있다. 같은 방의 중복 사용자, 정원 초과, 이미 시작한 방의 입장을 거부한다.

## 서버 → 클라이언트

```json
{ "type": "joined", "playerId": "uuid", "roomId": "team-123" }
{ "type": "state", "roomId": "team-123", "mode": "team", "mapId": "garden", "itemMode": true, "phase": "waiting", "tick": 0, "remaining": 1200, "players": [{ "id": "uuid", "name": "Momo", "team": "blue", "characterId": "momo", "skinId": "classic", "x": 1, "y": 1, "alive": true, "bubbleTicks": 0, "maxOrbs": 1, "range": 3, "dash": false, "pin": false, "speedLevel": 0, "moveCooldownTicks": 2, "darts": 0, "facing": "up", "score": 0 }], "soft": [], "items": [], "orbs": [], "waves": [], "dartEffects": [], "result": null }
{ "type": "error", "code": "unauthorized" }
```

서버는 초당 10틱으로 동작한다. `phase`는 `waiting`, `playing`, `finished`다. `remaining`은 남은 틱 수다. `soft`는 `"x,y"` 배열, `items`는 `{x,y,type}` 배열이다. `playerId`는 해당 입장의 ID다. `dartEffects`는 `{x,y,dx,dy,length,ttl}` 배열이며 발사 위치·방향·실제 사거리·남은 표시 틱을 제공한다. 좌표의 위쪽은 y 증가 방향이다.

팀전은 `blue`와 `pink`에 번갈아 배정하고 8명이 모이면 시작한다. 한 팀의 생존자가 없어지거나 120초가 지나면 생존자 수로 승패를 정하며 동률은 무승부다. 도중 연결이 끊긴 참가자는 경기에서 제외하지만 처음 참가자 명단은 결과 집계에 남긴다.

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
