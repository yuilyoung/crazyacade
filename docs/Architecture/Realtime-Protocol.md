# 실시간 대전 프로토콜 v0.1

## 연결 경계

- **Vercel:** Unity WebGL 배포와 초대 링크. 지속 WebSocket 룸은 호스팅하지 않는다.
- **Supabase:** 로그인 토큰 검증, 프로필, 전적, 랭킹, 꾸미기 데이터.
- **별도 Node.js WebSocket 서버:** 룸, 입력, 틱, 전투 판정의 권위자.

## 클라이언트 → 서버

```json
{ "type": "join", "roomId": "quick-123", "name": "Momo" }
{ "type": "input", "action": "up" }
{ "type": "input", "action": "place_orb" }
```

P2에서 `place_orb`도 입력 이벤트로만 보내며, 설치 가능 여부·웨이브·피격·승패는 서버가 판정한다. 클라이언트는 결과 상태를 렌더링만 한다.

## 서버 → 클라이언트

```json
{ "type": "joined", "playerId": "uuid", "roomId": "quick-123" }
{ "type": "state", "roomId": "quick-123", "phase": "playing", "tick": 12, "players": [] }
```

## 보안 전환 조건

Unity WebGL은 익명 Supabase 로그인으로 JWT를 발급받아 `join.accessToken`에 담는다. 서버는 `/auth/v1/user`로 JWT를 검증한 뒤에만 입장을 허용하고, 닉네임은 검증된 프로필을 기준으로 처리한다. 결과 전적도 서버만 Supabase에 기록한다.

`Supabase/schema.sql`은 프로필·전적 테이블과 RLS의 시작점이다. `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY`는 WebSocket 서버 환경변수에만 넣고, Unity WebGL 또는 Vercel 정적 파일에 넣지 않는다.

개발용으로만 `ALLOW_DEV_GUESTS=true`을 쓸 수 있으며 공개 테스트·운영에서는 반드시 `false`여야 한다.

## 현재 권위형 판정 범위

서버가 이동 가능 타일, 오브 수·설치 위치, 2초 점화, 4방향 웨이브, 연쇄 점화, 블록 파괴, 버블 2초 카운트와 승패를 확정한다. 아이템 드롭·구조·안전 구역은 다음 서버 규칙 확장으로 추가한다.
