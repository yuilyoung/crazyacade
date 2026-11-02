# 연결 복구 구현 계획

기준: [설계](../specs/2026-11-02-reconnect-design.md). 기존 자동 진행 지시에 따라 서버와 브라우저를 파일 소유권을 나눠 병렬 구현하고 독립 검토 후 통합한다.

1. 서버: `Server/src/index.js`, 필요시 `sessions.js`, `relay.js`; `Server/test/reconnect.test.js`와 fixture. 먼저 실제 소켓으로 복귀/거부/만료 실패를 재현한다. opt-in 토큰·검증·30초 예약·명시적 leave·heartbeat·소켓 교체 가드·연습/재대결 수명을 구현한다. 기존 테스트를 유지한다.
2. 브라우저: `Server/public/app.js`, `reconnect.js`, 필요시 HTML/CSS; 순수 타이머/저장 helper 테스트와 실제 브라우저 검사. 복귀 상태기계·입력 차단·sessionStorage·reload·명시적 leave·실패 UI를 구현한다. 초대/음향/튜토리얼 상태를 보존한다.
3. 통합 검증: `scripts/reconnect-smoke.py`에서 실제 두 클라이언트의 동일 ID/경기/전투 상태 복귀, 새로고침, 취소/만료, 기다리는 팀원 표시와 모바일 조작을 검사한다. 기존 8인/릴레이/연습/음향 스모크 및 서버 전체 테스트, Unity JS bridge와 AI guard를 실행한다. CI에도 새 검사를 추가한다.
4. 문서: realtime protocol, README, service readiness, acceptance와 Benchmark03에 실제 결과와 한계를 반영한다. 보안·인증·경기 수명 독립 검토를 받고 수정 후 필요한 검사만 다시 실행한다. 커밋·main 푸시 및 원격 SHA 확인.

검토 집중: 인증 await 중 만료/교체 경쟁, 이전 소켓 close/input의 영향, 응답 유실 후 같은 토큰 재시도, waiting/finished의 오프라인 참가자와 준비 투표, 릴레이 목적물 재획득/연습방 정리. 각 항목을 서버나 실제 브라우저 테스트에 포함한다.
