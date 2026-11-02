# GitHub 역할별 개발 자동화

저장소의 Actions는 실행기이며, AI 추론에는 별도의 API 인증과 사용료가 필요하다. 아래 파일은 실제 워크플로 정의다. 현재 세션에서는 GitHub 관리자 설정·비밀키 등록·원격 Actions 실행 성공을 확인하지 않았다.

| 역할 | 실행 방식 | 결과 |
| --- | --- | --- |
| CI | main 푸시 / PR / 수동 | 서버 테스트, Unity JS 브리지, PostgreSQL 마이그레이션, AI 변경 경로 검사, Chromium 8세션 대전·비랭크 AI 연습/안내 |
| 개발 Agent | `AI role task`, role=`develop`, 수동 | 지정한 기능의 파일 변경안 → 테스트 → draft PR |
| Code Review Agent | `AI role task`, role=`review`, 수동 | 현재 실행한 main 소스 스냅샷의 검토 보고서 artifact |
| Fix Agent | `AI role task`, role=`fix`, 수동 | 재현 설명을 바탕으로 수정안 → 테스트 → draft PR |
| CD 준비 | `Publish container`, main에서 수동 | 테스트 후 `ghcr.io/yuilyoung/crazyacade:<commit SHA>` 이미지 게시 |

CI에는 AI 키가 필요 없다. AI 워크플로는 예약 실행하지 않는다. 한 실행당 한 번의 Responses API 요청을 하며 입력 소스는 최대 120,000자, 출력은 최대 12,000토큰이다. 모델은 저장소 변수 `OPENAI_MODEL`로 지정하고 생략하면 `gpt-5-mini`를 사용한다. 소스가 입력 제한을 넘으면 일부 파일은 제외되며 보고서 품질에 영향을 줄 수 있다. 사용 가능한 모델과 비용 한도는 API 프로젝트에서 별도로 관리한다.

## 활성화

1. GitHub 저장소의 Actions가 허용되어 있는지 확인한다. 푸시 후 **CI** 실행 결과를 확인한다.
2. Settings → Secrets and variables → Actions에 **secret** `OPENAI_API_KEY`를 등록한다. 채팅이나 저장소 파일에 값을 넣지 않는다.
3. 같은 화면의 **variable** `ENABLE_AI_AGENTS`를 `true`로 설정한다. 기본적으로 AI 실행은 비활성화된다.
4. Actions → **AI role task** → Run workflow에서 main과 역할을 고른다. 예: `물폭탄을 설치하며 오른쪽으로 움직일 때 입력이 사라지는 버그를 재현하고 고쳐라`.
5. 개발/Fix의 draft PR 생성을 사용하려면 저장소/조직에서 GitHub Actions의 PR 생성 권한이 허용되어 있어야 한다. 토큰의 쓰기 범위는 마지막 PR 게시 job에만 있다.

`GITHUB_TOKEN`이 만든 PR은 GitHub의 재귀 실행 방지 정책에 따라 별도 PR CI를 자동 실행하지 않을 수 있다. 이 워크플로는 PR을 만들기 전에 같은 변경안을 별도 job에서 이미 검사한다. PR을 이후 수정했다면 **CI**의 Run workflow에서 해당 브랜치를 선택해 다시 검사한다. 자동 승인·자동 병합은 하지 않는다. 리뷰 역할은 PR 댓글을 자동 게시하지 않고 artifact의 `report.md`를 제공한다.

## 실행 경계

- 제안 job만 OpenAI API secret을 받는다. API는 `https://api.openai.com/v1/responses`를 사용한다. [공식 Responses API 문서](https://platform.openai.com/docs/api-reference/responses/create).
- 변경안은 최대 20개 소스/테스트/설계문서 파일로 제한한다. `.github`, 자격증명, 의존성 선언, 배포 및 데이터베이스 마이그레이션은 변경하지 못한다.
- 검증 job은 API secret과 저장소 쓰기 권한이 없고 체크아웃 인증정보를 저장하지 않는다.
- 마지막 job은 원래 제안을 새 체크아웃에 다시 적용한다. 이 job은 제안된 코드를 실행하지 않고 draft PR만 만든다.
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
