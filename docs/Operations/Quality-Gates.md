# 게임 품질 게이트

게임을 먼저 검증한다. 이 문서는 게임 코드·데이터베이스·실제 브라우저 입력의 검증 기준이며 예약 작업을 활성화하지 않는다. 실행 기준은 [`scripts/quality-gates.json`](../../scripts/quality-gates.json), 실행기는 [`scripts/check-quality-gates.py`](../../scripts/check-quality-gates.py), CI는 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)이다. 문서의 목표와 실행 결과를 구분하며, 새 보고서가 없으면 통과로 표시하지 않는다.

## 실행과 점수

Node 24, Python 3.12, 설치한 Server 의존성, Docker와 실행 가능한 PostgreSQL 이미지, Playwright 1.62.0 및 세 브라우저 엔진이 필요하다.

```bash
(cd Server && npm ci)
python3 -m pip install playwright==1.62.0
python3 -m playwright install --with-deps chromium firefox webkit
python3 scripts/check-quality-gates.py --validate
python3 scripts/check-quality-gates.py --all
```

10개 영역에 각각 10점, 총 100점이다. 영역 안에 연결된 검사에 점수를 균등 배분하고 **이번 실행에서 종료 코드 0으로 통과한 검사에만** 점수를 준다. 하나의 전체 Node 검사가 여러 영역의 관련 테스트를 포함하므로 같은 명령은 한 번 실행하고 결과를 공유한다. 실행하지 않았거나 실패·시간 초과한 검사는 0점이다. 이전 JSON, 스크린샷의 존재 또는 문서 작성 자체에는 점수를 주지 않는다.

전체 통과는 점수 **90/100 이상**, 모든 선언된 검사 통과, 보안·동기화의 전체 서버 검사 및 핵심 E2E의 필수 통과를 함께 요구한다. 필수 검사는 `server-tests`, `game-shell`, `member-account`, `gameplay-upgrade`, `browser-compatibility`다. 높은 합계가 보안 또는 실제 플레이 실패를 가리지 못한다. 현재 모든 검사가 통과한 전체 실행은 100점이 된다. 90점 기준은 실패를 허용하는 면제 규칙이 아니다.

이 점수는 아래 범위에 한정된 **엔지니어링 수용 검사 점수**다. 게임의 재미·미술 완성도 또는 실서비스 품질에 90점을 부여하는 평점이 아니다. 이용자 플레이테스트와 외부 운영 측정은 별도로 필요하며 이 실행기는 점수를 주지 않는다.

```bash
# 명령 목록과 개별 진단. 부분 실행은 전체 게이트 통과를 인증하지 않는다.
python3 scripts/check-quality-gates.py --list
python3 scripts/check-quality-gates.py --run server-tests unity-bridges
python3 scripts/check-quality-gates.py --run input-latency
```

`--validate`는 연결·파일·시간 제한·100ms 예산·세 브라우저 선언을 검사한다. 실제 테스트를 실행하거나 점수를 부여하지 않는다. `--run`은 지정한 검사만 실행하며 실제 명령의 실패 코드를 반환한다. 보고서에는 미실행 검사도 빠진 것으로 나타난다. `movement-quality`는 같은 실행에서 `gameplay-upgrade`가 먼저 통과해야 한다. `--run gameplay-upgrade movement-quality`로 함께 실행한다. 선행 검사가 없거나 실패하면 125로 차단해 오래된 프레임을 점수로 쓰지 않는다. 전체 실행은 이 순서를 보장한다.

## 영역별 기준

아래 ID는 JSON과 보고서에서 동일하다. 각 명령의 정확한 인수·타깃 파일·임계값·증거 경로는 manifest에 있다.

| 영역 (각 10점) | 실행 검사와 구체적인 타깃 | 실패 기준 / 측정 범위 |
| --- | --- | --- |
| `traffic-latency` 트래픽·네트워크 지연 | `input-latency`, `bounded-load` | 실제 키 입력→WebSocket 전송→권위 상태→Canvas 가시 이동을 측정한다. 로컬 가시 이동은 **모든 표본 ≤100ms**, 누락 표본 0. WebSocket 각 방향 40ms 고정 지연을 추가한 별도 프로필도 실제 측정한다. 64명 정상 트래픽의 거부/예상 밖 연결 종료는 0. |
| `security` 보안 | `server-tests`의 `account-http`, `http`, `boundary-contracts`, `runtime-network`, `reconnect`; `postgres-rankings`, `automation-guards`, `member-account` | 인증·자기 소유 계정 행·비밀정보 비노출·경로 탈출·과대 메시지·토큰·SQL 권한의 기존 부정 사례 모두 통과. 실제 소켓 flood는 정책 코드 1008로 종료하고 정상 사용자는 진행해야 한다. |
| `service-stability` 서비스 안정성 | `server-tests`의 `lifecycle`, `runtime-http`, 결과 outbox; `migration-consistency`, `postgres-rankings`, `bounded-load` | readiness/drain/복구·영속 결과 테스트 모두 통과. 부하 후 연결/룸/대기열/auth 자원 모두 0, stderr 0바이트, SIGTERM 종료 코드 0. |
| `ipc-stability` IPC 안정성 | `server-tests`의 `directory-lease`, `claim-lifecycle`, `lifecycle`, `socket-transport`; `unity-bridges`, `bounded-load` | 실제 자식 프로세스 IPC·OS lease·프레임 직렬화·종료 수명 주기와 Unity JavaScript bridge 계약 통과. 공유 outbox의 살아 있는 writer는 최대 1개. Unity 편집기/C# 플레이 모드 전체 실행을 주장하지 않는다. |
| `test-levels` 클래스/모듈/통합/E2E | 전체 Node `npm test`, Unity bridge 단위 검사, `postgres-rankings`, `game-shell`, `member-account`, `gameplay-upgrade` | 클래스/모듈의 규칙·입력·뷰모델과 실제 HTTP/WebSocket/프로세스/SQL 통합 검사를 실행한다. 실제 키보드·터치·계정 화면·플레이 E2E가 모두 통과해야 한다. |
| `ui-ux` UI/UX | `game-shell`, `gameplay-upgrade`, `movement-quality`, `input-latency` | 1440×900, 1280×720, 390×844, 844×390 화면 경계·보드 잘림·버튼 hit target·터치·네이티브 Escape·설정 유지·훈련·이동·구출 등 기존 assertion 통과. 미적 만족/접근성 전체 감사는 사람의 평가가 필요하다. |
| `browser-refresh-compatibility` 새로고침·호환성 | `game-shell`, `browser-compatibility` | Chromium 전체 E2E와 **Chromium/Firefox/WebKit 각각** 실제 2인 서비스 플레이. 새로고침 전후 키보드 이동·폭탄 입력, 같은 참가자/매치/진행 상태 재개, 중복 참가자 및 페이지 오류 0. 대기열이 가득 차서 거절된 사용자가 로비에서 바로 AI 연습 경기를 시작할 수 있어야 한다. 고양이 스킨 3종을 각각 장착하고 새로고침 뒤 마지막 스킨과 파동 앰플이 실제 연습 경기에 적용되는지도 검사한다. 엔진 미설치도 실패다. |
| `concurrent-connections` 동시 접속 | `server-tests`의 `runtime-network`, `runtime-control-integration`; `bounded-load`, `game-shell` | 실제 **64소켓/8룸/룸당 8명/60초** 정상 입력·ping·tick 진행. 별도 flood·최대 연결/룸 거부·정상 peer 지속·자원 반환 검증. 4v4는 실제 독립 브라우저 8명 입력도 검사한다. |
| `thread-safety` 스레드 안전성 | `server-tests`의 `async-gate`, `outbox-concurrency`, `directory-lease`, `queue-sessions`; `postgres-rankings` | 단일 권위 이벤트 루프에서 await 경계의 경합 검증: FIFO/취소/permit 반환, 중복 결과, 100개 동시 초과 admission 거부, 단일 writer, SQL 동시 결과의 잠금·idempotency. 공유 메모리 다중 worker 안전성을 인증하지 않는다. |
| `synchronization` 동기화 | `server-tests`의 `reconnect`, `queue-sessions`, `outbox-concurrency`, `directory-lease`; `browser-compatibility`, `bounded-load`, `postgres-rankings` | 지연 인증과 세션 takeover의 경합, 만료 예약·queue assignment, 직렬 저장·불변 중복 결과, 실제 reload 재개·부하 중 권위 상태 진행의 기존 assertion 전부 통과. |

## 실패 처리와 증거

각 명령은 셸 문자열 대신 인수 배열로 실행하고 원래 종료 코드를 보존한다. 시간 초과는 124, 선행 증거 실패는 125, 실행 파일 없음은 127, 키보드 중단은 130, SIGTERM 중단은 143으로 기록한다. 시간 초과/중단 시 명령과 자식 프로세스 그룹에 SIGINT를 보내 Python의 finally 정리와 임시 PostgreSQL 컨테이너 제거를 허용한다. 5초 안에 종료하지 않으면 남은 그룹을 강제 종료한다. 실패 후 독립 검사를 계속해 진단을 수집하되 첫 실패 코드를 유지하므로 후속 성공으로 실패가 지워지지 않는다. 전체 게이트를 통과하지 못하면 CI도 실패한다. `continue-on-error`, `|| true` 또는 출력 파이프로 성공을 위장하지 않는다.

`/tmp/crazyacade-quality/<실행ID>/report.json`에 개별 실행 보고서를 보존하고 `/tmp/crazyacade-quality/report.json`은 가장 최근에 갱신한 실행의 복사본이다. 보고서에는 실행 ID·커밋·작업 트리 수정 여부·manifest SHA-256·시작/종료·실행 명령·종료 코드·검사별 로그·부분/전체 실행 구분·영역별 점수·빠진 필수 검사가 있다. 명령 로그는 매 실행의 새 하위 디렉터리에 저장하며 동시 실행도 각자 보고서를 보존한다. 보고서는 검사 전 및 검사마다 원자적으로 갱신한다. 중간 강제 종료도 `complete:false`와 현재까지의 실제 결과를 남긴다. UI 스크린샷·측정 JSON·서비스 로그, 입력 지연 원시 표본, 64명 부하 증거도 CI artifact로 함께 보관한다. 부하 스크립트가 assertion에서 종료하면 전체 성공 JSON이 없을 수 있으며 이 경우에도 실패 명령 로그가 남는다.

CI는 **모든 브랜치의 push**, pull request, 수동 실행에서 돈다. 새 push 때문에 앞선 커밋의 실행을 취소하지 않는다. GitHub의 push 이벤트는 그 push의 최종 SHA를 검사하므로 여러 커밋을 한 번에 push한 경우 중간 SHA 각각을 따로 실행했다는 의미는 아니다. push는 브랜치 HEAD, PR은 GitHub가 만든 merge ref를 검증한다. 둘은 코드 트리가 달라질 수 있어 PR 동기화 검사를 생략하는 방식으로 중복을 제거하지 않는다. 동일 변경에 두 실행이 보이는 것은 서로 다른 병합 상태를 검증하기 위한 의도다. 예약 실행의 등록이나 변경은 이 게이트의 범위에 포함하지 않는다.

GitHub Actions 실행의 **Summary**에서 검사한 커밋, 전체 점수, 통과 여부와 실패한 검사 이름을 확인할 수 있다. 해당 커밋의 전체 보고서가 완성되기 전에 실행이 멈추면 점수는 미확정으로 표시한다.

실패/성공 모두 artifact 업로드를 시도하며 **14일** 보관한다. 브라우저 설치나 Docker 준비 실패도 게이트 실패이며 검사 생략을 통과로 취급하지 않는다. 이 문서나 CI 파일의 존재는 원격 CI가 이미 실행·통과했다는 증거가 아니다.

## 운영 해석의 한계

- Node 서버의 권위 게임 상태는 **하나의 프로세스와 이벤트 루프**가 소유한다. 비동기 작업 경합과 별도 writer 프로세스의 배타성은 검사하지만, worker thread 공유 상태나 여러 게임 서버의 룸 분산·일관성은 구현/검증했다고 주장하지 않는다.
- 64명/60초와 연결 상한 검사는 localhost에서 제한된 부하를 입증한다. 장시간 soak, 무제한 확장 또는 공개 서버의 수용량/SLA는 별도 측정이 필요하다. RTT 분포는 기록하지만 해당 분포에 정의하지 않은 p95/p99 SLA를 부여하지 않는다.
- 로컬 100ms는 키 이벤트에서 Canvas 제출까지의 측정이다. 디스플레이 scanout·사용자 화면까지의 물리 지연을 포함하지 않는다. 각 방향 40ms 모의 전달은 payload/order를 유지하지만 실제 인터넷의 jitter·손실·TLS·지리·모바일 네트워크 전체를 재현하지 않는다. 모의 네트워크 프로필에 로컬 100ms 보장을 확대하지 않는다.
- 세 브라우저의 대표 기능 검사는 운영체제·실기기·브라우저 모든 버전·전체 접근성 호환을 인증하지 않는다. 엔진을 실제 실행하지 못하면 그 결과는 미검증이다.
- 재미, 미술 완성도, 접근성의 사람 평가와 실제 공개 서비스의 보안 점검·모니터링은 별도다. 이 게이트 점수로 미술/재미 90점 또는 운영 준비 완료를 주장하지 않는다.


## 이 변경의 실제 검증 상태

당시 전체12검사 중11개가 실제 통과했다. 당시 Node696개, DB 권한/동시성/반복 설치, 계정·게임 E2E, 실제 입력100ms 예산,64접속/8룸/60초 부하가 포함된다. 점수는92.5/100이지만 `browser-compatibility`가 필수이므로 **전체 게이트 실패**다. Chromium의 실제 새로고침·동일 참가자 재개는 통과했고 Firefox/WebKit은 미설치 및 공식 다운로드의403차단 때문에 실행하지 못했다. 실패를 skipped나 passed로 바꾸지 않는다.

공식 다운로드 도메인 `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`을 환경 설정 초안에 추가했다. GitHub CI 확인용 `api.github.com`도 추가했다. 초안을 환경 설정에서 저장·게시해 필요한 네트워크 접근을 적용한 뒤 `python3 -m playwright install --with-deps chromium firefox webkit`와 전체 게이트를 재실행해야 한다. 원격 GitHub CI는 별도로3엔진 설치 및 검증을 실행한다. 로컬 초안 저장은 원격CI 통과나 배포 완료의 증거가 아니다.

독립 검토에서 발견한 임계값 중복 옵션/부하시간 단축/명령 no-op 교체 허점은 실패 회귀를 먼저 확인한 뒤 차단했다. 현재12개 표준 검사 진입점·작업 폴더·필수 의존 관계·옵션을 고정하고, 기존 Node 전체 검색과 양수 테스트 수를 확인한다. Python 최적화로assert가 사라지지 않게 한다. 최종35개 자동화/게이트 회귀가 통과했다. [당시 전체 실행 보고서](../Design/evidence/input-response/quality-report.json)와 [입력 표본](../Design/evidence/input-response/input-latency.json)을 함께 보관한다.

### 2026-11-21 `main` 재검증

후속 입력·전체화면 수정이 합쳐진 `dbcca9b2f4393d8b7d624be6bb750963c1a223c9`에서 manifest 검증과 비브라우저 진단 부분집합을 새로 실행했다. 여섯 검사 모두 종료 코드0으로 통과했다.

| 검사 | 이번 실행 결과 |
| --- | --- |
| `server-tests` | Node **700/700**, 실패·건너뜀0 |
| `unity-bridges` | JavaScript bridge **5/5** |
| `migration-consistency` | 통합 SQL 생성물 일치 |
| `postgres-rankings` | 격리 PostgreSQL의 권한·동시 Elo·마이그레이션 반복 검사 통과 |
| `automation-guards` | 자동화/게이트 회귀 **35/35** |
| `bounded-load` | 자동 클라이언트64개·8룸·60초, 입력19,200회·ping3,840회, 누락 입력 배치0 |

부하 표본의 localhost RTT p95는3.32ms, 틱 계산 p95는4.03ms, 틱 지연 p95는0.93ms였다. 같은 호스트의 자동 클라이언트 측정이므로 공개 인터넷·실제 사용자·장시간 수용량으로 일반화하지 않는다.

이 부분 실행은 비브라우저 검사 6개를 선택해 61.667점을 기록했다. Playwright 전용 캐시는 비어 있었고 공식 엔진 다운로드 요청은 HTTP 403을 반환했다. 후속 점검에서 저장소의 브라우저 검사가 시스템 Chromium을 자동으로 사용한다는 것을 확인했다.

### 안정화·자동 수정 변경안 전체 검증

11월 21일 22:00 KST에 기준 커밋 `dbcca9b`과 로컬 변경안으로 전체 검사를 마쳤다. 실행 ID는 `20261121T125318Z-7156ea17`이다. 12개 중 11개가 통과했고, 필수 `browser-compatibility` 실패로 전체 결과는 **92.5/100, 종료 코드 1**이다.

| 항목 | 관측 결과 |
| --- | --- |
| 입력과 매칭 수정 | 마우스 보조 버튼의 이동·물폭탄 오입력과 종료 중인 연결이 매칭 대기열을 점유하는 문제를 재현했다. 예약 수정 검증기로 새 테스트 2개가 기준 코드에서 실패하고 변경안에서 통과하는 것을 확인했다. |
| 서버·데이터·자동화 | Node 702/702, Unity JS 브리지 5/5, 자동화 테스트 49/49 통과. 통합 SQL 일치 및 PostgreSQL 권한·동시성 검사 통과. |
| Chromium 게임 플레이 | 회원 화면, 8인 대전, 2인 재대결, 5개 맵, 갇힘·구출, 이동 품질 통과. 별도 호환성 시나리오에서도 같은 참가자로 새로고침 복귀 후 이동과 물폭탄 설치에 성공했다. |
| 지연·부하 | 로컬 키 입력에서 Canvas 이동까지 36회 측정, 최대 40.7ms(기준 100ms). 64접속·8룸·60초 동안 입력 19,200회, ping 3,840회, 누락 입력 배치 0회. |
| 남은 호환성 검사 | Firefox·WebKit은 엔진 설치 요청이 공식 배포처에서 HTTP 403으로 차단돼 실행 단계에서 실패했다. 환경 설정의 다운로드 도메인을 적용한 뒤 두 엔진을 설치하고 전체 게이트를 다시 실행해야 한다. |

### 11월 21일 원격 main 검증

커밋 `c035882`에서 검증 브랜치와 `main`의 GitHub Actions가 각각 전체 검사를 실행했다. 두 실행 모두 Chromium·Firefox·WebKit을 포함해 12개 게이트를 통과했고, 10개 평가 영역에서 100/100을 달성했다. [검증 브랜치 실행](https://github.com/yuilyoung/crazyacade/actions/runs/44909785056) · [main 실행](https://github.com/yuilyoung/crazyacade/actions/runs/44910582116)
