# 실시간 대전 프로토콜

## 연결 및 인증

Unity WebGL 클라이언트는 WebSocket 서버에 연결한다. 운영 환경에서는 `wss://`를 사용한다. Supabase 익명 로그인으로 발급받은 JWT를 `join.accessToken`으로 보낸다. 서버는 Supabase `/auth/v1/user`에서 JWT를 검증하고 입장을 결정한다. `ALLOW_DEV_GUESTS=true`는 로컬 개발용이며 공개 서버에서는 `false`로 둔다.

서비스 역할 키는 서버의 `SUPABASE_SERVICE_ROLE_KEY`에만 설정한다. Unity 빌드와 정적 호스팅 파일에는 공개 anon 키만 사용한다. 서버는 인증된 참가자 기준 프로필과 경기 결과를 저장하며, 팀별 참가자 전적에는 `Supabase/migrations/20261102_team_match_history.sql` 적용이 필요하다.

브라우저 익명 세션은 `sessionStorage`에 보관되어 같은 탭에서만 재사용된다. 탭 종료나 저장소 삭제 후 장기적으로 같은 계정과 전적을 유지하려면 추후 계정 연결 기능이 필요하다. 현재 계정 연결은 구현되어 있지 않다. 인증된 사용자의 프로필 저장 요청이 실패하면 서버는 `profile_unavailable` 오류를 전송하고 입장을 거부한다.

## 클라이언트 → 서버

```json
{ "type": "join", "roomId": "team-123", "mode": "team", "name": "Momo", "accessToken": "<Supabase JWT>", "characterId": "momo", "skinId": "classic", "mapId": "garden" }
{ "type": "input", "action": "up" }
{ "type": "input", "action": "place_orb" }
```

- `mode`가 `team`이면 4대4 방이다. 생략하거나 `duel`을 지정하면 1대1 방이다.
- `characterId`: `momo`, `nori`, `bibi`, `toto`. `skinId`: `classic`, `sunset`, `mint`. 둘 다 생략하면 각각 `momo`, `classic`이 된다. 외형만 바뀌며 능력치는 같다.
- `mapId`: `garden`, `lagoon`, `candy`. 첫 참가자가 선택하며 생략하면 `garden`이다. 이후 생략하면 기존 방의 맵을 사용하고, 명시적으로 다른 맵을 보내면 `map_mismatch` 오류를 받는다. 잘못된 선택은 `invalid_selection` 오류다.
- `input.action`은 `up`, `down`, `left`, `right`, `place_orb` 중 하나다. 이동·설치·충돌·피해·결과는 서버가 판정한다.
- 소켓 하나는 한 번만 입장할 수 있다. 중복 사용자, 정원이 찼거나 시작한 방은 입장할 수 없다.

## 서버 → 클라이언트

```json
{ "type": "joined", "playerId": "uuid", "roomId": "team-123" }
{ "type": "state", "roomId": "team-123", "mode": "team", "mapId": "garden", "phase": "waiting", "tick": 0, "remaining": 1200, "players": [ { "id": "uuid", "name": "Momo", "team": "blue", "characterId": "momo", "skinId": "classic", "x": 1, "y": 1, "alive": true, "bubbleTicks": 0, "maxOrbs": 1, "range": 3, "dash": false, "pin": false } ], "soft": [], "items": [], "orbs": [], "waves": [], "result": null }
{ "type": "error", "code": "unauthorized" }
```

`state`는 참가자와 블록, 아이템, 오브 및 웨이브 상태를 전송한다. `phase`는 `waiting`, `playing`, `finished` 중 하나이고 `remaining`은 남은 틱 수다. 서버는 초당 10틱으로 동작한다. `soft`는 `"x,y"` 문자열 배열이고, `items`는 `{x,y,type}` 배열이다. `playerId`는 사용자 ID가 아닌 해당 입장의 ID다.

팀전에서는 `players[].team`이 `blue` 또는 `pink`이며, 빈 자리를 파랑·분홍 순서로 배정한다. 8명이 모이면 4명씩 경기를 시작한다. 한쪽 팀의 생존자가 없어지면 승패를 정하고 결과에 `winnerTeam`을 제공한다. 제한 시간이 끝나면 생존자 수가 많은 팀이 이기며, 같으면 `draw`다. 경기 도중 연결이 끊긴 참가자는 탈락 처리되며 양 팀에 생존자가 남아 있으면 경기가 계속된다.

## 아이템과 구조

서버가 파괴 블록에서 아이템을 생성하고 이동 중 획득을 판정한다. `orb`는 동시 오브 수를 최대 5까지, `wave`는 범위를 최대 7까지 늘린다. `dash`는 이동 입력당 최대 두 칸 이동하고, `pin`은 다음 피격을 한 번 막는다. 팀원은 버블 상태인 아군의 같은 칸이나 상하좌우 인접 칸에 도달해 구조할 수 있다. 파동 중인 칸으로 이동하면 피격 판정이 적용된다.

## 검증 범위

서버 자동 테스트는 실제 WebSocket 입장·정원·퇴장, 선택값과 팀 승패 및 서버 아이템 규칙을 검사한다. Unity 빌드와 실제 Supabase 서비스 연결, 8인 WebGL 대전은 별도 환경에서 검증해야 한다. 자동 매칭과 재접속은 아직 없다.
