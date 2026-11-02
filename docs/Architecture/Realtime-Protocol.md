# 실시간 대전 프로토콜

## 연결 및 인증

Unity WebGL 클라이언트는 WebSocket 서버에 연결한다. 운영 환경에서는 `wss://`를 사용한다. Supabase 익명 로그인으로 발급받은 JWT는 `join.accessToken`으로 보낸다. 서버는 Supabase `/auth/v1/user`에서 JWT를 검증하고 입장을 결정한다. `ALLOW_DEV_GUESTS=true`는 로컬 개발용이며 공개 서버에서는 사용하지 않는다.

서비스 역할 키는 서버의 `SUPABASE_SERVICE_ROLE_KEY`에만 설정한다. Unity 빌드나 정적 호스팅 파일에는 공개 anon 키만 사용한다. 서버는 프로필과 경기 결과를 Supabase에 기록한다.

## 클라이언트 → 서버

```json
{ "type": "join", "roomId": "quick-123", "mode": "team", "name": "Momo", "accessToken": "<Supabase JWT>" }
{ "type": "input", "action": "up" }
{ "type": "input", "action": "place_orb" }
```

- `mode`가 `team`이면 4대4 방이다. `mode`를 생략하면 기존 1대1 방이다.
- `input.action`은 `up`, `down`, `left`, `right`, `place_orb` 중 하나다. 이동·설치·충돌·피해·결과는 서버가 판정한다.
- 소켓 하나는 한 번만 입장할 수 있다. 정원이 찼거나 시작한 방은 입장할 수 없다.

## 서버 → 클라이언트

```json
{ "type": "joined", "playerId": "uuid", "roomId": "quick-123" }
{ "type": "state", "roomId": "quick-123", "mode": "team", "phase": "waiting", "tick": 0, "remaining": 1200, "players": [ { "id": "uuid", "name": "Momo", "team": "blue", "x": 1, "y": 1, "alive": true, "bubbleTicks": 0 } ], "soft": [], "orbs": [], "waves": [], "result": null }
{ "type": "error", "code": "unauthorized" }
```

`state`는 방의 참가자와 블록, 오브 및 웨이브 상태를 전송한다. `phase`는 `waiting`, `playing`, `finished` 중 하나이고, `remaining`은 남은 틱 수다. 서버는 초당 10틱으로 동작한다. `soft`는 `"x,y"` 문자열 배열이고 오브와 웨이브는 각각 좌표와 남은 시간을 포함한다. `playerId`는 사용자 ID가 아닌 해당 입장의 ID다.

팀전에서는 `players[].team`이 `blue` 또는 `pink`이며, 빈 자리를 파랑·분홍 순서로 배정한다. 8명이 모이면 4명씩 경기를 시작한다. 한쪽 팀의 생존자가 없어지면 승패를 정하고 결과에 `winnerTeam`을 제공한다. 제한 시간이 끝나면 생존자 수가 많은 팀이 이기며, 생존자 수가 같으면 `draw`로 표시한다. 경기 도중 연결이 끊긴 참가자는 탈락 처리되며 양 팀에 생존자가 남아 있으면 경기가 계속된다.

## 범위와 남은 작업

서버는 이동 가능 타일, 오브 수와 설치 위치, 점화, 4방향 웨이브와 연쇄 점화, 블록 파괴, 버블과 경기 결과를 판정한다. 캐릭터·스킨·맵 선택, 온라인 아이템 및 아군 구조는 별도 구현과 검증이 필요하다. 경기 결과 저장 스키마는 개인 승자 중심이므로 팀별 참가자와 전적을 완전하게 표현하도록 확장해야 한다.
