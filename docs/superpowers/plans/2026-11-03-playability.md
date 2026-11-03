# 친구·훈련·접근성 구현 계획

**Goal:** 처음 온 사용자와 소규모 친구가4대4를 시작하고 핵심 행동을 익히도록 한다.
**Spec:** [설계](../specs/2026-11-03-playability-design.md). 사용자 자동 실행 승인에 따라 병렬 구현·독립 검토·재평가 후 원격 푸시.

1. 서버 통합: index.js/rankings.js 및 실제WS tests. humanSlots/teamPreference/withBots, 공유봇방 생명주기·비랭크·상한, training 요청/모듈/실제dart구출 연결. 먼저 거부·충원·정리·저장 제외 RED, 구현 후 회귀.
2. 훈련 규칙: 새 src/training.js + tests. initializeTraining(room,resetPlayer), stepTraining(room,resetPlayer), trainingState(room), dropTrainingPickup(room,x,y), trainingResult(room), noteTrainingDartRescue(room,player) 인터페이스. 실제 카운터/위험 기반 단계·재시도·완료를 검사. index 변경은1번 소유.
3. 조작 helper: 새 public/controls.js/preferences.js/feedback.js와 tests. DOM 없는 키검증/저장/사건 모델; UI 담당에게 API 전달. 신호 기준과 경계 테스트 후 통합.
4. 브라우저: app.js/index.html/style.css/experience.js/invite.js + invite tests. 친구설정/초대/훈련/설정 패널/키와 안내/고대비/자막을 통합한다.3번 helper와 계약 조정. 새 항목은 모바일 조작 아래.
5. Root: 실제 브라우저 수용 script·CI, 기술 검증과 독립 코드 리뷰. 별도 평가자에게 기존 기준과 실제 결과를 전달해 Benchmark05를 작성하고70미만이면 근거상 공백을 추가 개선한다. README/프로토콜/운영/완료 기준 갱신, 최종 commit/push와 원격SHA 확인.

Review Focus: 일반방 훈련 인증 우회, AI 경기의 랭킹 오염, 예약 인원/봇의 재대결·방 누수, 키 변경/IME/폼 이벤트와 입력 잔류, 연습 전용 강제 상태의 일반 경기 유출. 각 소유 tests와 실제 브라우저로 검증한다.

## 독립 평가 후 실제 흐름 보완

첫 독립평가68.75에 따라 초기3가지 진입·훈련 완료 후 AI/친구 연결·아레나 사건 한줄표시를 브라우저 담당이 추가한다. 훈련 담당은 각단계ready와 startTrainingLesson을, 서버 담당은 training_ready 메시지와 ready의전투/구출타이머정지를 추가한다. 전체180초상한·인증경계는 유지한다. Root는 실제브라우저에서 설명읽기시간·완료→AI/친구→초대·맵선택보존·재훈련과 모바일표시를 확인하고 재평가한다. 이 보완의 점수는 선지정하지 않는다.
