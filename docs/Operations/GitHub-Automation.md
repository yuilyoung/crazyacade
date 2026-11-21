# GitHub 역할별 개발 자동화

저장소의 Actions는 실행기이며, AI 추론에는 별도의 API 인증과 사용료가 필요하다. 아래 파일은 실제 워크플로 정의다. 현재 세션에서는 GitHub 관리자 설정·비밀키 등록·원격 Actions 실행 성공을 확인하지 않았다.

| 역할 | 실행 방식 | 결과 |
| --- | --- | --- |
| CI | 브랜치 푸시 / PR / 수동 | 서버·PostgreSQL·자동화 회귀, Chromium 게임 플레이·입력 지연, 세 브라우저 호환성, 64접속 부하를 포함한 12개 품질 게이트 |
| 개발 Agent | `AI role task`, role=`develop`, 수동 | 지정한 기능의 파일 변경안 → 테스트 → draft PR |
| Code Review Agent | `AI role task`, role=`review`, 수동 | 현재 실행한 main 소스 스냅샷의 검토 보고서 artifact |
| Fix Agent | `AI role task`, role=`fix`, 수동 | 재현 설명을 바탕으로 수정안 → 테스트 → draft PR |
| CD 준비 | `Publish container`, main에서 수동 | 테스트 후 `ghcr.io/yuilyoung/crazyacade:<commit SHA>` 이미지 게시 |

CI에는 AI 키가 필요 없다. AI 워크플로는 매일 한국 시간 09:00(UTC 00:00)에 예약 실행한다. GitHub 예약 실행은 지연될 수 있다. `ENABLE_AI_AGENTS=true`일 때만 AI 요청을 실행하며 변경이 없으면 반영·배포를 건너뛴다. 한 실행당 한 번의 Responses API 요청을 하며 입력 소스는 최대 120,000자, 출력은 최대 12,000토큰이다. 모델은 저장소 변수 `OPENAI_MODEL`로 지정하고 생략하면 `gpt-5-mini`를 사용한다. 소스가 입력 제한을 넘으면 일부 파일은 제외되며 보고서 품질에 영향을 줄 수 있다. 사용 가능한 모델과 비용 한도는 API 프로젝트에서 별도로 관리한다.

## 활성화

1. GitHub 저장소의 Actions가 허용되어 있는지 확인한다. 푸시 후 **CI** 실행 결과를 확인한다.
2. Settings → Secrets and variables → Actions에 **secret** `OPENAI_API_KEY`를 등록한다. 채팅이나 저장소 파일에 값을 넣지 않는다.
3. 같은 화면의 **variable** `ENABLE_AI_AGENTS`를 `true`로 설정한다. 기본적으로 AI 실행은 비활성화된다.
4. Actions → **AI role task** → Run workflow에서 main과 역할을 고른다. 예: `물폭탄을 설치하며 오른쪽으로 움직일 때 입력이 사라지는 버그를 재현하고 고쳐라`.
5. 개발/Fix의 draft PR 생성을 사용하려면 저장소/조직에서 GitHub Actions의 PR 생성 권한이 허용되어 있어야 한다. 토큰의 쓰기 범위는 마지막 PR 게시 job에만 있다.

`GITHUB_TOKEN`이 만든 PR은 GitHub의 재귀 실행 방지 정책에 따라 별도 PR CI를 자동 실행하지 않을 수 있다. 이 워크플로는 PR을 만들기 전에 같은 변경안을 별도 job에서 이미 검사한다. PR을 이후 수정했다면 **CI**의 Run workflow에서 해당 브랜치를 선택해 다시 검사한다. 수동 실행은 기존대로 draft PR을 생성한다. 예약 실행은 격리 검증을 통과한 변경만, 검증 시점과 main이 같은 경우에 자동 반영한다. 분기 보호를 우회하거나 강제 푸시하지 않는다. 이후 해당 커밋의 CI를 명시적으로 실행하고 Render의 동일 커밋 live 배포를 확인한다. 리뷰 역할은 PR 댓글을 자동 게시하지 않고 artifact의 `report.md`를 제공한다.

## 실행 경계

- 제안 job만 OpenAI API secret을 받는다. API는 `https://api.openai.com/v1/responses`를 사용한다. [공식 Responses API 문서](https://platform.openai.com/docs/api-reference/responses/create).
- 변경안은 최대 20개 소스/테스트/설계문서 파일로 제한한다. `.github`, 자격증명, 의존성 선언, 배포 및 데이터베이스 마이그레이션은 변경하지 못한다.
- 검증 job은 API secret과 저장소 쓰기 권한이 없고 체크아웃 인증정보를 저장하지 않는다.
- 마지막 job은 원래 제안을 새 체크아웃에 다시 적용한다. 제안된 코드를 실행하지 않으며, 수동 실행은 draft PR을 만들고 예약 실행은 최신 기준 확인 후 main에 일반 푸시한다. 기존 테스트 변경은 차단하며 새 회귀 테스트만 추가할 수 있다. 예약 게시 job만 `contents:write`, `actions:write`를 받고 API 키는 제안 job에만 전달한다.
- 테스트 통과가 구현의 완전성을 보장하지 않는다. 사람은 PR의 변경 내용과 검증 artifact를 확인한다.

## 컨테이너와 실서비스 배포

`Publish container`는 실행 시점 main 커밋을 검사한 뒤 GHCR에 해당 SHA 태그로 게시한다. 외부 게임 서버 호스팅/도메인/TLS/서비스 환경변수는 아직 지정되지 않았으므로 실제 서비스로 배포하지 않는다. 서버는 WebSocket 연결을 유지해야 하며 컨테이너를 지원하는 호스트에서 실행한다.

```bash
docker build -t pop-pop-arena .
docker run --rm -p 8080:8080 --env-file /secure/location/server.env pop-pop-arena
```

컨테이너는 비루트 사용자로 실행하고 기본 개발 게스트 모드는 꺼져 있다. 환경 파일에는 서버에만 필요한 Supabase 설정을 둔다. 마이그레이션을 먼저 적용한다. 한 프로세스가 룸 상태를 메모리에 보관하므로 여러 복제본으로 수평 확장하려면 룸 라우팅/상태 공유 설계가 추가로 필요하다.

## 로컬 검증

```bash
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
cd Server && npm test
```

현재 환경에서 AI API 호출·원격 GitHub Actions 실행·GHCR 게시를 하지 않았다. 설정 파일을 저장했다고 AI Agent가 실행 중이거나 배포가 완료된 것은 아니다.

이번 환경에서 Docker 이미지를 실제로 빌드하고, 비루트 실행·`/health`·HTML 페이지·개발 게스트 기본 차단을 확인했다. 원격 GHCR 게시와 실제 배포는 수행하지 않았다. 클라우드 프록시 인증서가 필요한 빌드 환경은 `--secret id=proxy_ca,src="$CODEX_PROXY_CERT"`를 추가한다. 이 인증서는 빌드 시에만 마운트하고 이미지에 저장하지 않는다.


## 매일 자동 수정·배포 활성화

워크플로 파일: `.github/workflows/ai-roles.yml`. 실행 시각 `0 0 * * *` = 매일 한국 09:00. 이는 GitHub 실행기에서 저장소를 체크아웃하는 방식이며 현재 클라우드 작업공간 프로세스를 예약 재사용하는 기능이 아니다.

1. 이 변경이 기본 브랜치 main에 반영되어야 cron이 등록된다.
2. GitHub Settings → Secrets and variables → Actions에서 기존 `OPENAI_API_KEY` secret을 재사용하거나 없으면 안전하게 등록한다. `ENABLE_AI_AGENTS=true`, 필요하면 `OPENAI_MODEL` 변수를 설정한다. 키를 채팅이나 파일에 적지 않는다.
3. Render의 기존 서비스에 main·checksPass 자동 배포가 연결되어 있어야 한다. GitHub Actions에 `RENDER_API_KEY` secret과 `RENDER_SERVICE_ID` 변수(`srv-…`)를 설정한다. 두 값이 없으면 예약 게시 job은 main을 바꾸기 전에 중단한다. Render API 키는 게시 job의 배포 확인 단계에만 전달된다.
4. Actions의 쓰기 권한과 브랜치 보호 정책이 이 자동 반영 방식을 허용해야 한다. 정책으로 거부되면 강제 푸시하거나 보호를 해제하지 말고 PR 방식으로 운영한다.
5. 첫 예약 실행의 propose → validate → daily-publish와 명시적으로 실행된 CI의 실제 커밋 SHA를 확인한다. Render에서도 같은 SHA가 live여야 배포 완료다.

예약 작업은 UTC 날짜에 따라 안정화, 게임 고도화, 방어적 보안을 하루씩 순환한다. 안정화 차례에는 서버 수명 주기·매칭 대기열·결과 저장의 구현과 테스트를, 보안 차례에는 회원 본인 확인·응답 데이터 범위의 구현과 테스트를 우선 제공한다. 게임 고도화 차례에는 기존 다섯 주제를 순환하며 게임 고도화 문서의 미완료 항목을 확인한다. 각 실행은 근거가 있는 변경 한 건까지 제안하며, 근거가 부족하면 빈 제안으로 종료한다.

예약 변경에는 새 `Server/test/*.test.js` 또는 `Assets/Tests/*.test.cjs` 파일이 필요하다. 제안 접수, 격리 검증, 예약 게시 단계에서 이 조건을 검사한다. 패키지 설정과 잠금 파일은 허용 디렉터리 안에서도 보호한다.

검증 job은 기준 커밋에 새 테스트를 얹어 적어도 한 단언이 실패하는지 확인한다. 이어서 게시할 변경안에 같은 테스트를 실행해 그 단언을 포함한 테스트가 통과하는지 확인한다. 수동 PR과 예약 게시 모두 변경안을 적용한 상태에서 `python3 scripts/check-quality-gates.py --all`을 실행한다. 전체 게이트와 Unity JS 브리지 테스트, 검증 전후 패치 일치 확인을 통과해야 게시 단계로 진행한다. 품질 게이트 보고서와 로그의 보존 기간은 14일이다. GitHub Actions의 `ai-validation-browser-evidence` artifact에서 확인할 수 있다.

GitHub 봇 토큰으로 푸시하면 일반 push CI가 재실행되지 않을 수 있다. 따라서 daily-publish는 main의 현재 SHA와 시간·이벤트·브랜치가 일치하는 workflow_dispatch CI를 찾아 성공을 기다린다. CI/배포 확인 실패를 배포 성공으로 표시하지 않는다. main이 검증 후 바뀌었으면 게시를 거부한다.

현재 세션에서는 GitHub 관리 API가 Forbidden이므로 저장소 설정과 secret 유무, 예약 작업 실행 및 Render live 상태를 확인하지 못했다. 로컬 스크립트 테스트와 YAML 검사 성공은 원격 등록·실행 성공과 구분한다.
