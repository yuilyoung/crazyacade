# 경기 결과 저장 복구 구현 계획

**Goal:** 완료 경기의 안전한 재전송과 정직한 저장 상태를 구현한다.
**Architecture:** 단일 프로세스 파일 outbox + 기존 idempotent Supabase RPC. 서버 상태와 브라우저 점수판을 matchId로 연결한다.
**Spec:** [설계](../specs/2026-11-03-result-outbox-design.md). 기존 자동 진행 승인에 따라 파일 소유권을 나눠 병렬 구현한다.

1. `Server/src/result-outbox.js`, `supabase.js` 및 해당 tests: 먼저 RED로 파일 선기록/재시도/재시작/상충ID/손상/비공개 필드를 검증. `createResultOutbox({directory,persist,onStatus,...testOptions})` → `start()`, `enqueue(snapshot)`, `diagnostics()`, 동기 `pause()`, `close()` 제공. `pause`는 신규 전송을 멈추되 접수된 파일 쓰기는 마친다. `onStatus({matchId,status,attempts})`. `buildMatchPayload(room)`과 `persistMatchPayload(payload, options)`는 allowlist·timeout·retryable error를 제공하고 기존 persistMatch를 호환 wrapper로 유지한다.
2. `Server/src/index.js`, `http.js`, integration tests/fixtures: 운영에서 outbox를 초기화하고 finishMatch에서 snapshot enqueue. demo는 기존 finalizeMatch. state.resultSaving, 콜백 방송/이전 라운드 guard, storage health, 종료 처리를 연결. production fixture마다 임시 RESULT_OUTBOX_DIR 격리. 실제 subprocess 재시작과 저장 실패/지연·재대결을 검증한다.
3. `Server/public/app.js`, `index.html`, 새 result-saving helper/tests: 상태 문구·unknown 처리·saved/demo 당 한번 랭킹 갱신. 기존 자동1초 갱신을 대체하고 복귀/재대결을 검사한다.
4. Root: 실제 Chromium 저장 fixture smoke와 CI 등록, Docker 비루트 영속볼륨 구성, 환경 예제/gitignore/운영 문서 및 Benchmark04. 독립 코드 리뷰와 전체/브라우저/DB/컨테이너 검증 후 커밋·푸시·원격SHA 확인.

Review Focus: 응답 유실 뒤 같은 ID 집계, enqueue 중 중복/상충 요청, 손상 파일을 삭제하지 않음, 이전 라운드 늦은 성공, 로그/디스크/공개 상태의 토큰 차단. 테스트는 각 구현 단계에 포함한다. benchmark는 기술 근거가 변한 항목만 같은 기준으로 재평가한다.
