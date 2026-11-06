# 실시간 대전 프로토콜

## 연결 및 인증

브라우저와 Unity WebGL 클라이언트는 같은 WebSocket 서버에 연결한다. 운영 환경에서는 `wss://`를 사용한다. Supabase 익명 로그인 JWT를 `join.accessToken`으로 보내면 서버가 `/auth/v1/user`에서 검증한다. `ALLOW_DEV_GUESTS=true`는 로컬 개발용이며 공개 서버에서는 `false`로 둔다.

서비스 역할 키는 서버 환경변수에만 설정한다. 브라우저와 Unity에는 공개 anon 키만 제공한다. 서버는 인증된 참가자의 프로필과 랭크 대상 클래식 경기 결과를 저장한다. 하모니·릴레이·훈련·연습·친구+AI는 저장하지 않는다. `schema.sql` 다음으로 `20261102_team_match_history.sql`, `20261102_rankings.sql` 마이그레이션을 순서대로 적용해야 한다.

브라우저 익명 세션은 같은 탭의 `sessionStorage`에서 재사용한다. 장기 계정 연결은 아직 없다. 인증된 사용자의 프로필 저장이 실패하면 `profile_unavailable` 오류로 입장을 거부한다.

## 클라이언트 → 서버

```json
{ "type": "join", "roomId": "team-123", "mode": "team", "itemMode": true, "name": "Momo", "accessToken": "<Supabase JWT>", "characterId": "momo", "skinId": "classic", "mapId": "garden", "reconnect": true }
{ "type": "input", "action": "up" }
{ "type": "input", "action": "place_orb" }
{ "type": "input", "action": "use_dart" }
{ "type": "input", "action": "pass_star" }
```

- `mode`: `team`은 4대4, 생략하거나 `duel`이면 1대1이다.
- `characterId`: `momo`, `nori`, `bibi`, `toto`. `skinId`: `classic`, `sunset`, `mint`, `astronaut`, `bee`, `raincoat`. `orbSkinId`: `bubble`, `star`, `duck`. 생략 시 `momo`, `classic`, `bubble`. 외형만 다르고 시작 능력치는 같다. 검증한 오브 외형은 설치 시 오브에 복사하고 복귀·재대결에서도 보존한다.
- `mapId`: `garden`, `lagoon`, `candy`, `harbor`, `festival`. 첫 참가자가 정하며 기본값은 `garden`. 기존 방과 다른 값을 명시하면 `map_mismatch`, 알 수 없는 선택이면 `invalid_selection`이다. 브라우저와 서버는 `public/map-catalog.js`의 같은 배치를 사용한다.
- `itemMode`: boolean. 새 방의 기본값은 `true`. 기존 방에서는 생략 시 그 방의 설정을 따르고, 명시한 값이 다르면 `item_mode_mismatch`다. 문자열 등은 `invalid_join`이다.
- `ruleSet`: `classic|relay|harmony`. 새 방의 기본값은 `classic`, 기존 방에서 생략하면 그 방의 규칙을 따른다. `relay`와 `harmony`는 team 전용 비랭크다. 기존 방과 다르면 `rule_set_mismatch`, 알 수 없는 값은 `invalid_rule_set`, duel의 협동 규칙은 `invalid_rule_mode`다.
- `practice`: 생략/`false`는 일반 대전, `true`는 사람 1명+AI 7명의 비랭크 팀 연습이다. boolean 이외 값은 `invalid_join`이다. 아래 격리 규칙을 따른다.
- `humanSlots`: team의 사람 정원 `2|4|6|8`. 생략하면 기존 방 설정 또는 새 방8명, duel은2명이다. 잘못된 값은 `invalid_human_slots`, 기존 방과 다르면 `human_slots_mismatch`. 예약된 사람도 정원에 포함한다. 2/4/6명 방은 AI로 나머지를 채우는 비랭크4대4이며 인증을 그대로 요구한다.
- `teamPreference`: 친구+AI 방에서만 `auto|blue|pink`를 선택한다. 팀4명 상한을 넘으면 `team_full`, 잘못된 선택이나 일반8인방의 팀 지정은 `invalid_team_preference`. 개인 팀 선호는 초대 링크에 넣지 않는다.
- `training`: boolean. `true`는 `practice:true`에서만 허용하며 일반방 요청은 `invalid_training`이다. 아래 단계별 훈련 계약을 따른다.
- `trainingMode`: `classic|harmony`. `practice:true`와 `training:true`를 모두 지정한 개인 훈련에서만 허용한다. 생략 시 기본 훈련 `classic`이며 다른 값이나 일반방·일반 연습방의 지정은 인증 전에 `invalid_training_mode`로 거부한다.
- `reconnect`: boolean. `true`이면 아래 연결 복구 프로토콜을 사용한다. 생략/`false`인 Unity·구형 클라이언트는 기존 연결 종료 시 즉시 이탈 동작을 유지한다.
- `input.action`: `up`, `down`, `left`, `right`, `place_orb`, `use_dart`, `pass_star`. 이동·설치·다트·패스 요청을 분리해 같은 틱에 처리한다. 서버가 입력 빈도와 충돌·피해·패스 대상을 판정한다. 클라이언트가 보내는 점수·충전·수신자 지정은 권한이 없다.
- 소켓 하나는 한 번만 입장할 수 있다. 같은 방의 중복 사용자, 정원 초과, 이미 시작한 방의 입장을 거부한다.

## 서버 → 클라이언트

```json
{ "type": "joined", "playerId": "uuid", "roomId": "team-123" }
{ "type": "state", "roomId": "team-123", "mode": "team", "mapId": "garden", "itemMode": true, "phase": "waiting", "tick": 0, "remaining": 1200, "players": [{ "id": "uuid", "name": "Momo", "team": "blue", "characterId": "momo", "skinId": "classic", "x": 1, "y": 1, "alive": true, "bubbleTicks": 0, "maxOrbs": 1, "range": 3, "dash": false, "pin": false, "speedLevel": 0, "moveCooldownTicks": 2, "darts": 0, "facing": "up", "score": 0 }], "soft": [], "items": [], "orbs": [], "waves": [], "dartEffects": [], "result": null }
{ "type": "error", "code": "unauthorized" }
```

서버는 초당 10틱으로 동작한다. `phase`는 `waiting`, `playing`, `finished`다. `remaining`은 남은 틱 수다. `soft`는 `"x,y"` 배열, `items`는 `{x,y,type}` 배열이다. `playerId`는 해당 입장의 ID다. `dartEffects`는 `{x,y,dx,dy,length,ttl}` 배열이며 발사 위치·방향·실제 사거리·남은 표시 틱을 제공한다. 좌표의 위쪽은 y 증가 방향이다.

`state.solid`는 현재 충돌 벽의 `"x,y"` 배열이다. Harbor의 `mapFeatures`는 `{type:'tidegates',cycleTicks:200,warningTicks:20,phase,nextChangeTick,gates}`이며 gate는 `{id,cells,closed,closing,pending}`다. 100틱마다 교대하고20틱 전 예고한다. 사람·봇·물감옥·오브가 있는 칸은 빈 상태까지 닫힘을 미룬다. 닫힐 때 아이템을 제거하며 이동·봇 경로·폭발·다트·패스가 같은 solid를 사용한다. 다른 맵은 `mapFeatures:null`이다.

### 패스와 하모니 추가 계약

`ruleSet:'harmony'`는 team 전용 비랭크이며 relay와 동일한 인증·정원·복귀 계약을 따른다. 제한120초·탈락 후5초 복귀, 목표7점이다. 릴레이는 기존 목표3점과 전달1점을 유지한다. 별을 가진 플레이어가 `pass_star`를 보내면 현재 facing 방향 최대7칸의 첫 생존·연결·비버블 플레이어에게 전달한다. 벽·상자·오브에 막히고 유효 수신자가 없으면 소유권을 유지한다. 성공 패스 후10틱 대기한다.

`state.relay.charges`는 `{passes,rescue,total}`이며 서로 다른 아군 수신자 최대2회와 현재 보유 팀의 실제 구출1회를 누적한다. 하모니 전달 가치는 `1+total`(최대4), 상대 가로채기·드롭·전달 후 초기화된다. 클라이언트가 직접 증가시킬 수 없다. `relay.passCooldownTicks`는 다음 패스까지 남은 틱, `relay.passEffects`는 `{fromId,toId,team,interception,x,y,dx,dy,length,ttl}`의 짧은 표현 정보다. 일반 릴레이는 패스로 득점 보너스를 얻지 않는다.

`players[]`와 결과 scoreboard에는 `passes`, `interceptions`, `deliveries`, `rescues`를 제공한다. 하모니 결과의 `reason`은 `harmony_goal|harmony_time|forfeit`, 릴레이는 `relay_goal|relay_time|forfeit`이며 둘 다 `relayScores`를 사용한다. `ruleSet`으로 UI 명칭과 목표를 구분한다. 하모니·릴레이·훈련·연습·친구+AI는 공통 `ranked-policy`가 데모 랭킹과 결과 Outbox/직접 저장 경계에서 모두 제외한다.

인증·프로필 어댑터는 주입 가능한 fetch와 기본5초 제한을 사용한다. 유효하지 않은 토큰과 인증 서비스 장애를 구분하고, 원격 응답 본문·URL·키를 오류에 넣지 않는다. 이 인터페이스는 테스트 가능한 어댑터 계약이며 별도 프로세스 IPC는 아니다.

일반 8인 클래식 팀전은 `blue`와 `pink`에 번갈아 배정하고 8명이 연결되면 시작한다. 친구+AI 방은 설정한 사람 정원이 모두 연결되면 봇으로 나머지를 채운다. 한 팀의 생존자가 없어지거나 120초가 지나면 생존자 수로 승패를 정하며 동률은 무승부다. 복귀를 요청하지 않은 참가자와 명시적으로 나가거나 복귀 유예가 만료된 참가자는 경기에서 제외하지만 처음 참가자 명단은 결과 집계에 남긴다. 유예 중 캐릭터는 그대로 남아 피격·탈락 판정을 받는다.

결과는 `draw: true`, 팀전의 `winnerTeam`, 또는 1대1의 `winnerId`를 포함한다. `result.scoreboard`는 `{id,name,team,score,rescues,deliveries,passes,interceptions}`의 점수 내림차순 배열이다. 1대1에는 `team`이 없다. 결과 카드로 내보낼 때는 브라우저가 자신의 최종 행과 검증된 외형만 별도 허용 목록으로 투영하며 이름·계정 ID·토큰·다른 사람 정보는 제외한다.

### 결과 저장 상태

`state.resultSaving`은 대기·진행 중에는 `null`이며 완료 경기에서는 다음 객체를 제공한다. 클라이언트는 `resultSaving.matchId`가 현재 `state.matchId`와 일치할 때만 사용한다.

```json
{ "matchId": "<completed match UUID>", "status": "retrying", "attempts": 1 }
```

| status | 의미 |
| --- | --- |
| `saving` | 운영 클래식 결과를 큐에 접수하거나 전송 중 |
| `retrying` | 일시 저장 오류 뒤 서버가 재전송을 기다리거나 시도함 |
| `saved` | Supabase `record_match`의 성공 응답을 확인함 |
| `failed` | 자동 재시도하지 않는 오류 또는 큐 접수 실패. 저장 성공을 뜻하지 않음 |
| `demo` | 개발 서버 메모리의 임시 랭킹에만 반영됨 |
| `unranked` | 연습·기본/하모니 훈련·친구+AI·릴레이·하모니 경기로 계정 전적과 랭킹에 저장하지 않음 |

서버는 저장 상태가 바뀌면 종료된 방에도 새 `state`를 방송한다. 같은 참가자의 복귀에서도 현재 상태를 받는다. 완료 결과의 비동기 콜백은 경기 ID와 finished 상태를 확인하며 이전 라운드의 성공/실패를 새 라운드에 적용하지 않는다. 재대결 준비 시 저장 표시를 초기화하지만 이전 결과 전송은 독립적으로 계속한다.

브라우저는 점수판에 저장 상태를 표시하고 `saved` 또는 `demo`를 받은 경기마다 한 번 랭킹을 새로 읽는다. 종료 phase나 랭킹 조회 성공만으로 현재 경기 저장을 추정하지 않는다. 필드가 없거나 상태가 알려지지 않았거나 경기 ID가 다르면 저장 여부를 확인하지 못했다고 표시한다. `attempts`는 진단용 숫자이며 플레이어에게 기술적인 재시도 횟수를 안내하지 않는다. 클라이언트가 결과를 쓰거나 임의로 재전송하는 메시지는 없다.

운영 서버는 정규화된 완료 결과를 파일에 기록한 뒤 같은 `matchId`/payload로 전송한다. 기존 RPC의 트랜잭션과 중복 집계 방지가 응답 유실 뒤 재시도에도 적용된다. 파일에는 원본 room/player·소켓·JWT·복귀 토큰·키·헤더·오류 응답 본문을 포함하지 않는다. `RESULT_OUTBOX_DIR`의 영속 디스크를 유지한 재시작은 미전송 완료 결과만 복구하며 진행 중 경기는 복원하지 않는다.

## 아이템과 구조

아이템전에서만 파괴 블록의 드롭과 습득·사용이 가능하다. `orb`는 동시 설치 수를 최대 5까지, `wave`는 4방향 파동 길이를 최대 7까지 늘린다. `dash`는 한 칸 이동 간격을 2틱에서 1틱으로 줄인다. `pin`은 다음 피격 한 번을 막는다. `dart`는 최대 3발을 보유한다.

`use_dart`는 마지막 이동 방향으로 최대 7칸 발사한다. 벽과 파괴 블록에 막히며 첫 물폭탄을 점화하거나, 버블 아군을 구출하거나, 버블 적을 탈락시킨다. 탄약이 없거나 버블·탈락 상태이면 발사할 수 없다.

팀원은 버블 아군의 같은 칸이나 상하좌우 인접 칸으로 이동해 구조할 수 있다. 구출 후 5틱 동안 재피격을 막는다. 파동이 남아 있는 칸으로 이동하면 피격 판정을 받는다. 점수는 아이템 10, 블록 파괴 5, 구출 50, 적 탈락 100, 승리 200이다.

## 랭킹 HTTP API

`GET /api/leaderboard`는 `{source,entries}`를 반환한다. `source`는 개발 모드의 `demo` 또는 정식 모드의 `supabase`다. 각 항목은 `{rank,name,rating,tier,wins,losses,draws,score}`이며 상위 50명만 제공한다. 사용자 ID와 인증정보는 포함하지 않는다. 정식 모드에서 저장소에 접근할 수 없으면 503 오류를 반환한다.

레이팅은 1,000부터 시작해 승리 +25, 패배 −15, 무승부 +5, 최저 0이다. Bronze <1,100 / Silver ≥1,100 / Gold ≥1,250 / Diamond ≥1,450으로 표시한다. 경기 점수와 레이팅은 별개다. Supabase RPC는 경기별 결과를 원자적으로 한 번만 집계한다. 개발 랭킹은 랭크 대상 클래식만 메모리에 반영하고 재시작 시 초기화된다. 훈련·연습·친구+AI·릴레이·하모니는 개발 랭킹에서도 제외한다.

## 저장 큐 상태 HTTP API

`GET /health`의 기존 생존 응답은 유지한다. `GET /health/storage`는 `status`, `pending`, `retrying`, `failed`, `invalid`, `active`, `capacity`만 제공한다. 상태는 `ok`, `degraded`, `disabled`이며 degraded는 HTTP503, 나머지는 HTTP200이다. 개발 모드의 disabled는 큐를 사용하지 않는다는 뜻이다. 경로·계정·경기 ID·토큰·HTTP 오류 본문은 공개하지 않는다.

큐의 기본 경로는 실행 디렉터리의 `data/results`이고 `RESULT_OUTBOX_DIR`로 지정할 수 있다. Docker는 `/app/data/results`를 사용한다. 같은 경로를 한 서버 프로세스가 소유한다. 최대1000개·JSON 레코드 전체당32KiB, 동시 전송2건, HTTP5초 제한이다. 네트워크/시간초과/408/429/5xx는1/2/5/10/30초 이후30초 상한으로 재시도한다. 기타4xx·누락 설정은 failed 파일로 남겨 반복을 멈추고, 설정 수정 후 서버를 재시작하면 다시 시도한다. 손상/지원하지 않는 파일은 보존하고 invalid로 집계한다. 큐 초기화 실패는 서버 시작 실패로 드러나며, 접수 단계의 디스크 오류·용량 초과는 해당 결과의 failed로 드러난다.

## 검증 범위

서버 HTTP/WebSocket 검사, 실제 Chromium 8세션 대전과 다트 습득·구출, 격리된 PostgreSQL 마이그레이션·권한·중복 집계 검사를 제공한다. 연결 복구는 [벤치마크03](../Design/Benchmark-03-Reconnect.md), 완료 결과 저장 복구는 [벤치마크04](../Design/Benchmark-04-Result-Storage.md), 외형·하모니·화면·공유와 추가 훈련의 최종 실행 상태는 [벤치마크06](../Design/Benchmark-06-Experience.md)에 기록한다. 실제 Supabase 프로젝트 연결·공개 HTTPS/WSS 운영·Unity 빌드는 미검증이다. Unity에는 연결 복구·새 아이템전 선택·다트·패스·하모니·새 외형/맵·훈련·랭킹·저장 상태 UI와 DTO의 후속 확장이 필요하다. 자동 매칭과 서버 재시작 후 진행 경기/다중 인스턴스 복구는 아직 없다.

## 비랭크 연습과 학습 피드백

```json
{ "type": "join", "practice": true, "name": "Popper", "characterId": "momo", "skinId": "classic", "mapId": "garden", "itemMode": true }
```

연습전은 인증 토큰 없이 시작할 수 있지만 서버가 고유한 방 ID와 `team` 모드를 강제한다. 클라이언트의 `roomId`를 공유방으로 사용하지 않는다. 다른 소켓의 기존 연습방 `join`은 거부한다. 소유자의 유효한 `resume`은 허용한다. 프로필/인증 서비스 호출과 경기/랭킹 저장을 하지 않으며, 정상 사람 간 대전의 인증 경계는 유지한다. 프로세스당 최대 8개 연습방을 허용하고 초과 시 `practice_unavailable`이다. 복귀 유예 중인 연습방도 정원에 포함한다. 소유자가 명시적으로 나가거나 유예가 만료되면 봇까지 정리하며, 복귀를 요청하지 않은 소유자는 연결 종료 시 즉시 정리한다. 경기 종료 후 120초에는 남은 연결과 복귀 권한을 정리한다.

`state.practice`는 연습 여부, `players[].isBot`은 AI 여부다. AI는 일반 입력 처리·이동 쿨다운·아이템·피격·구출 규칙을 사용한다. 의사결정은 3틱마다 갱신한다. 초보용 경로 탐색이며 인간 숙련자의 전략을 모사하거나 재미가 검증된 AI라는 뜻은 아니다.

플레이어의 `bombsPlaced`, `itemsCollected`, `rescues`는 실제 수락된 설치·획득·구출 누적 횟수다. `result.scoreboard[].rescues`도 전송한다. 브라우저 안내는 같은 경기에서 실제 이동/설치/획득을 확인하며, 기본전에서는 아이템 단계를 선택 과제로 표시한다. 구조 알림은 같은 팀의 버블 상태와 남은 틱으로 계산한다. 재연습은 새 방이며 안내도 초기화한다.

## 릴레이·하모니 규칙과 같은 방 재대결

`join.ruleSet`은 `classic`(새 방 기본값), `relay`, `harmony`다. 기존 방에서 생략하면 방 규칙을 상속하고, 명시한 값이 다르면 `rule_set_mismatch`다. 유효하지 않은 값은 `invalid_rule_set`, 1대1의 relay/harmony는 `invalid_rule_mode`다. 연습전은 team을 강제한다. 일반 relay/harmony와 친구+AI는 사람 대전의 인증·프로필 검증을 그대로 요구한다.

추가 state 필드:

- `ruleSet`, `ranked`: classic이면서 연습·친구+AI가 아닐 때만 ranked=true. 개발 모드는 여전히 임시 랭킹이다.
- `humanSlots`, `withBots`: 사람 정원과 공유 친구+AI 방 여부. 개인 연습·훈련은 `practice:true`로 구분하며 `withBots:false`다. 공유 친구+AI 방은 최대16개이며 마지막 사람의 명시적 이탈/유예 만료 시 봇과 방을 정리한다. 정원 모두 연결되면 AI를 채우고 시작한다. 재대결 투표는 사람만 하며 봇은 새 라운드에 재구성하고 사람이 부족하면 충원을 기다린다.
- `matchId`: 실제 경기를 시작할 때 새 UUID. 대기는 null. `round`: 첫 라운드0, 재대결 준비 때+1.
- `rematch`: `{readyPlayerIds,total}`. total은 방에 남은 사람 수이며 복귀 유예 중인 사람도 포함한다. 봇은 재대결 투표에 참여하지 않는다.
- `relay`: classic은 null. relay/harmony는 `{scores:{blue,pink},goal,star:{x,y}|null,carrierId,respawnTicks,bases:{blue:{x:1,y:5},pink:{x:11,y:5}},charges:{passes,rescue,total},passCooldownTicks,passEffects:[]}`. `goal`은 relay에서3, harmony에서7이다. 충전·패스 표현 필드는 위 추가 계약을 따른다.
- 플레이어 `deliveries`, `passes`, `interceptions`, `rescues`, `respawnTicks`; 결과 점수판에도 기여 카운터를 포함한다.

relay는 중앙(6,5)의 별을 우리 기지로 전달하면 팀1점/개인150점, harmony는 위 충전 계약에 따라 팀1~4점/개인150점을 얻는다. 별은50틱 후 중앙 재등장한다. 피격되어 버블이 되거나 탈락/연결 종료하면 별을 떨어뜨리며 같은 틱 재획득을 막는다. 연결이 끊긴 사람은 유예 중에도 별을 다시 줍거나 전달하지 않는다. 탈락 후50틱에 시작 위치가 안전하면 복귀하며10틱 보호한다. 성장은 유지한다. 각 목표 점수(relay3/harmony7)에 도달하거나1200틱 종료 시 점수 우위로 승리하며 동점은 무승부다. 한 팀의 참가자가 모두 명시적 이탈/유예 만료로 제거되면 기권승이다. 결과 reason은 relay의 `relay_goal|relay_time|forfeit`, harmony의 `harmony_goal|harmony_time|forfeit`이며 `relayScores`를 포함한다. 두 규칙 모두 결과/레이팅을 저장하지 않는다.

일반방의 finished 상태에서 `{ "type":"rematch" }`를 보내면 준비한다. 중복 요청은1회로 처리한다. 남은 모든 참가자가 연결되고 준비하면 맵·전투·점수·기여 카운터·입력·아이템·릴레이/하모니의 충전과 패스 대기를 초기화하고 round를 올린다. 복귀 유예 중인 사람이 있으면 기다린다. 연결 복구 시 그 사람의 준비 투표는 초기화한다. ID·팀·외형·방 설정은 유지한다. 정원이 모두 연결되면 바로 새 matchId로 시작하고 부족하면 waiting에서 새 참가자를 받는다. 명시적 이탈/유예 만료 시 준비 인원을 다시 판단한다. 대기/진행 중 요청은 무시한다. 연습전은 이 프로토콜을 사용하지 않고 새 개인 방으로 다시 시작한다.

초대 URL은 기본 `room`, `mode`, `map`, `items=1|0`, `rules`를 내보내고, 친구+AI 팀방에만 `humans=2|4|6`을 추가한다. 토큰·이름·키·개인 팀 선택은 포함하지 않는다. 링크는 설정만 채우며 자동 입장하지 않는다. 실제 같은 방 규칙의 최종 판단은 서버가 수행한다.

## 단계별 개인 훈련

```json
{ "type": "join", "practice": true, "training": true, "trainingMode": "classic", "characterId": "momo", "skinId": "classic", "orbSkinId": "bubble" }
{ "type": "join", "practice": true, "training": true, "trainingMode": "harmony", "characterId": "bibi", "skinId": "raincoat", "orbSkinId": "duck" }
```

`practice:true, training:true`는 비랭크 개인방이며 `trainingMode` 생략 시 기존 기본 훈련이다. 기본 훈련은 garden/team/items/classic, 하모니 훈련은 festival/team/items/harmony를 강제한다. 선택 외형은 유지한다. 사람1명과 정지 연습 대상7명을 사용하며 일반 AI 의사결정·팀 전멸·일반 릴레이 목표 종료를 적용하지 않는다. 연습방의 최대8개·복귀 유예·종료 후 정리 정책을 공유한다. 인증·프로필 호출을 하지 않고 정상 전투·패스·구출·기지 전달 로직으로 판정하며1800틱(3분) 제한을 둔다.

`state.training`은 일반 경기에서 null이며 훈련에서는 `{mode,stage,step,total:4,title,instruction,target:{x,y}|null,attempts,completed,status}`이고 harmony에만 `failureReason`을 추가한다. `mode`는 `classic|harmony`, `status`는 `ready|active|retrying|complete`, `completed`는 완료 단계 수다.

| mode | stage 순서 | 실제 완료 판정 |
| --- | --- | --- |
| `classic` | `escape → item → rescue → dart → complete` | 물폭탄 폭발에서 살아남아 안전칸 도달 → 지정 상자 파동 아이템 습득 → 버블 아군 접근 구출 → 실제 다트 구출 |
| `harmony` | `pass → intercept → charge_rescue → delivery → complete` | 아군에게 성공 패스 → 적에게 패스해 적의 가로채기와 충전 초기화 확인 → 우리 팀 별 보유 중 실제 아군 구출로 충전 → 앞 단계의 구출 충전을 유지한 별을 우리 기지로 전달해2점 획득 |

각 단계는 위치·지형·전투 입력·별 소유권을 준비된 상황으로 재설정하지만 학습 기여 카운터를 유지한다. 하모니 충전은 앞 단계의 실제 행동으로 얻은 값만 이어받고 실패 재시도 시 그 단계 진입값으로 되돌린다. 실패하면1초 뒤 같은 단계의 `ready`로 돌아간다. 하모니 `failureReason`은 `null|self_bubble|player_eliminated|star_dropped|target_eliminated`이며 실패·재준비 동안 유지하고 다음 `training_ready` 때 지운다. 브라우저는 이 값을 설명으로 표시한다. 기본 훈련은 종전 피격·구출 기회 제한을 유지한다. 완료는 `result.reason=training_complete`, 시간 종료는 `training_timeout`이다. 두 훈련 모두 전적·결과 큐·개발 랭킹에 저장하지 않는다. 다시 훈련은 해당 모드의 새 개인방에서 시작한다.

단계 시작 전 `ready`에서는 전투 입력·이동·피격·구출·별 진행 타이머가 정지한다. 자신의 연결에서 `{ "type":"training_ready" }`를 보내면 한 번만 `active`로 바뀐다. 이미 `active`인 단계에서 중복 요청은 자원·위치·타이머를 재설정하지 않으며 일반방에서는 무시한다. 전체1800틱 제한은 설명을 읽는 시간에도 진행한다. 일반 input으로 단계 완료를 대신 요청할 수는 없다.

브라우저 로비의 **하모니 패스 훈련**이 위 harmony join을 보낸다. 완료 후 **하모니 AI 연습**은 `training` 없이 `practice:true,ruleSet:'harmony'`로 새 연습을 시작하고, **친구와 하모니 준비**는 `mode:'team',ruleSet:'harmony',humanSlots:2`의 로비 설정과 초대 동선으로 이어진다. 이때 훈련 전에 선택한 맵·외형을 복원하며 개인 훈련방을 공유방으로 전환하지 않는다. 기본 훈련의 기존 진입과 연습/친구 이어가기 동선은 유지한다.

## 브라우저 연결 복구

이번 추가 계약은 `join.reconnect: true`를 요청한 참가자에게 적용한다. 상태·결과·설정을 클라이언트에서 업로드해 복원하지 않고 서버에 남아 있는 동일 참가자 객체에 새 소켓을 연결한다.

```json
{ "type": "joined", "playerId": "uuid", "roomId": "team-123", "resumeToken": "<private opaque token>", "reconnectGraceMs": 30000 }
{ "type": "resume", "roomId": "team-123", "playerId": "uuid", "resumeToken": "<private opaque token>", "accessToken": "<current Supabase JWT>" }
{ "type": "joined", "playerId": "uuid", "roomId": "team-123", "resumeToken": "<private opaque token>", "reconnectGraceMs": 30000, "resumed": true }
{ "type": "leave" }
{ "type": "ping" }
{ "type": "pong" }
```

`joined`와 `pong`은 서버 응답이고 나머지는 클라이언트 요청이다. 정상 `resume` 뒤 서버는 즉시 최신 `state`를 보낸다. 클라이언트는 그 상태를 받기 전까지 전투 입력을 보내지 않는다.

### 권한과 소켓 교체

- `resumeToken`은 서버가 생성한 32바이트 무작위 값이다. 해당 참가자에게만 보내며 공개 `state`, 초대 URL, 로그, 랭킹 데이터에 포함하지 않는다. 참가자 수명 동안 유지하므로 복귀 응답이 유실되어도 같은 값으로 재시도할 수 있다. 명시적 이탈/유예 만료/방 정리 때 무효화된다.
- 최초 입장이 인증된 사용자는 매 복귀 시 JWT를 다시 검증하고 동일 `userId`를 요구한다. JWT가 없거나 다른 계정이면 `unauthorized`다. 인증 서비스 장애는 `authentication_unavailable`이다. 인증 실패를 개발 게스트/연습 권한으로 대체하지 않는다. 개발 게스트와 연습 소유자는 그 참가자의 비공개 복귀 토큰으로 증명한다.
- 사라진 방/참가자, 잘못된 토큰과 유예 만료는 `resume_unavailable`이다. 복귀는 새 프로필·참가자·경기 ID·결과를 만들지 않는다.
- 유효한 복귀는 이전 소켓이 열려 있어도 교체하며 이전 소켓을 코드 `4001`로 종료한다. 이전 연결의 입력과 지연된 종료 콜백은 새 연결에 영향을 주지 않는다. 이전 브라우저는 자동 재시도를 중단하고 다른 연결에서 복귀했다는 안내를 표시한다.

### 자리와 경기 수명

서버가 연결 종료를 확인하면 30초 유예를 시작한다. 실패한 복귀 요청은 유예를 연장하지 않는다. 슬롯·팀·외형·아이템·점수·경기 ID를 유지하고 대기 입력을 비운다. 경기는 멈추지 않으며 기존 캐릭터는 공격받고 물감옥·탈락 판정도 계속된다. 복귀는 생존 상태를 되돌리거나 추가 무적을 제공하지 않는다. 종료된 경기로 복귀하면 동일 결과를 보여 주고 중복 기록하지 않는다.

`state.players[]`에 `connected`와 `reconnectRemainingMs`가 추가된다. 연결된 사람과 AI는 connected=true, 복귀 유예 중 사람은 false다. 남은 유예는 밀리초 단위이며 연결된 참가자는 0이다. 전원이 연결되지 않은 대기방은 시작하지 않고, 종료방도 복귀 대기 참가자가 있는 동안 새 라운드를 시작하지 않는다. 만료 후 기존 이탈·기권·방 정리 규칙을 적용한다. 1대1에서도 유예 동안 즉시 연결 종료 패배를 주지 않지만 자연스러운 전투 종료는 가능하다.

`leave`는 즉시 권한·자리를 반납한다. 브라우저의 나가기와 새 연습 시작은 이 요청을 사용한다. 새로고침/`pagehide`는 `leave` 없이 소켓만 닫고 탭별 복귀 정보를 보존한다. 서버에 연결할 수 없는 상태에서 나가면 클라이언트의 복귀 정보를 지우고 서버 자리는 유예 만료 때 정리된다.

### 감지와 브라우저 재시도

서버 WebSocket ping/pong은 종료 이벤트가 오지 않는 연결도 감지한다. 브라우저는 애플리케이션 `ping`을 5초마다 보내고 12초 동안 응답이 없으면 복귀를 시도한다. 최초 0.5초부터 1/2/4초 간격으로 재시도하되 최대 간격은 4초, 로컬 시도 기간은 30초다. 서버의 만료 응답이 우선하며 이 기간은 서버의 예약 시간을 새로 늘리지 않는다.

브라우저는 현재 origin의 `sessionStorage`에 복귀 정보를 보관한다. 같은 탭 새로고침은 설정을 불러온 뒤 복귀를 시도한다. 저장이 금지되어도 같은 페이지의 일시 단절 복구는 메모리 정보로 시도한다. 복귀 중 기존 경기 화면과 명단을 유지하고 남은 시간·나가기를 제공하며 입력을 차단한다. 만료·권한 실패·소켓 교체로 종료되면 저장된 복귀 정보를 지운다.

이 기능은 같은 서버 프로세스가 살아 있는 동안만 동작한다. 서버 재시작, 다중 인스턴스 라우팅, 실제 모바일 망의 모든 장애 복구 또는 Unity 재접속을 지원한다는 뜻이 아니다.
