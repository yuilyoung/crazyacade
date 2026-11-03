# 경기 결과 저장 복구

기준 `79008a6`, 2026-11-03. 사용자의 자동 고도화·커밋·푸시 지시 아래 선택한 다음 범위다. Node/WebSocket와 기존 Supabase RPC를 유지한다.

## 선택과 목적

현재 완료 경기는 저장 요청 한 번이 실패하면 로그만 남는다. 메모리 재시도만 추가하면 프로세스 재시작에 사라지고, 별도 메시지 브로커는 현 단일 프로세스 POC에 과하다. 완료 결과만 로컬 파일에 먼저 보관하는 outbox를 선택한다. 진행 중 경기 자체 복원은 별도 범위다.

## 계약

- 운영 클래식 완료 결과를 검증·정규화한 불변 RPC payload로 보관하고, 동일 matchId로 기존 record_match를 재호출한다. DB의 트랜잭션/중복 집계 방지를 유지한다. 연습·릴레이는 unranked, 개발 게스트는 demo이며 파일/운영 DB 큐를 우회한다.
- `RESULT_OUTBOX_DIR` 기본값은 프로세스 작업 디렉터리의 `data/results`. Docker에서는 `/app/data/results`를 사용하고 `/app/data`를 영속 볼륨으로 연결한다. 큐 디렉터리는 한 프로세스만 사용한다. 서버 전용 데이터 경로이며 정적 HTTP로 제공하지 않는다. 런타임 파일은 git와 이미지 빌드에 포함하지 않는다.
- 한 경기당 JSON 파일: schema version, 원래 matchId와 정규화된 RPC payload, attempts, nextAttemptAt, 상태. 32KiB 이하의 정상 결과만 수용하고 보관 레코드1000개 상한. 보존된 손상/지원하지 않는 항목도 신규 접수의 보관 한도에 포함한다. 원본 room/player 객체, 소켓, JWT, 복귀 토큰, 키, HTTP 헤더·오류 응답 본문은 저장/로그/공개 상태에 넣지 않는다. filename은 서버 UUID로 제한한다.
- enqueue는 파일 쓰기·flush·원자적 rename을 마친 뒤 HTTP 전송한다. 디렉터리/파일 권한은700/600으로 생성한다. 동일ID/동일payload enqueue는 중복 전송 작업을 만들지 않고, 상충payload는 거부한다. 성공 확인 뒤만 파일을 제거한다. 전송 중 재시작/응답 유실이면 같은 payload가 재시도되어 DB에서 한번만 집계된다.
- HTTP 저장 timeout5초. 네트워크/timeout/408/429/5xx는1/2/5/10/30초 지연 후30초 상한으로 계속 재시도한다. 동시에 최대2건 전송하고 한 ID는 하나만 전송한다. 기타4xx·누락 설정은 failed로 남기고 자동 반복하지 않는다. 설정을 고치고 재시작하면 보관된 failed도 다시 시도한다. 큐 포화·파일 쓰기 실패는 명시적 failed이며 성공으로 취급하지 않는다.
- 시작 시 기존 정상 파일을 검증해 복구한다. 손상/지원하지 않는 파일은 보존하면서 invalid 집계로 보고하고 나머지는 처리한다. 큐 초기화 실패는 명확하게 시작 실패한다. 정상 종료는 새 전송을 중단하고 시작된 디스크 작업을 마친다. 강제 종료의 복구 범위는 디스크에 기록 완료된 결과다.
- `state.resultSaving`은 완료 경기만 `{matchId,status,attempts}` 또는 null. status는 saving/retrying/saved/failed/demo/unranked. 초기 상태·전송 결과를 해당 방에 방송하고, 콜백은 room.matchId 및 finished phase가 그대로일 때만 갱신한다. 새 라운드와 이전 결과를 섞지 않는다. 복귀 시 현재 상태를 받는다.
- 브라우저 점수판의 별도 상태 문구는 실제 저장 확인을 나타낸다. 성공은 record_match2xx 뒤에만 saved. missing/unknown/mismatched 상태는 저장 여부를 모른다고 표시한다. saved/demo로 전환되면 경기당 한번 랭킹을 새로 읽는다. 비랭크·재시도/실패는 성공을 주장하지 않고 게임/재대결을 막지 않는다. 기술적인 시도 횟수는 플레이어 문구에 넣지 않는다.
- `/health`는 기존 liveness 그대로. `/health/storage`는 식별자 없는 큐 집계만 제공한다: status ok/degraded/disabled, pending/retrying/failed/invalid/active/capacity. degraded는HTTP503, 나머지는200. 파일 경로·계정·경기ID·토큰·에러 본문은 공개하지 않는다. 개발 모드 disabled는 영구 저장 성공이 아니다.

## 검증·한계

단위 및 실제 HTTP/WebSocket으로 일시 오류/영구 오류/응답 유실/중복/재대결·복귀 경합, 파일 실패/손상/용량, 실제 프로세스 중단과 재시작을 검증한다. Chromium에서는 저장 재시도→완료 및 랭킹 조회를 확인한다. 기존 DB 중복 집계/권한과 경기·연결·음향 회귀도 확인한다. 실제 Supabase·공개 배포·운영 볼륨은 설정되지 않았으며 로컬 fixture와 Docker 검증으로 대체했다고 주장하지 않는다.
