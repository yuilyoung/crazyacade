# Render 브라우저 데모 배포

웹 화면과 WebSocket 게임 서버를 하나의 Docker 웹 서비스에 올립니다. Unity WebGL 빌드나 Vercel은 이 브라우저 POC 실행에 필요하지 않습니다. 최초 범위는 **Supabase 없이 로그인 없는 AI 7명과의 4대4 연습·기본 훈련·하모니 훈련**입니다.

## 처음 배포하기

1. [Render 배포 시작](https://dashboard.render.com/blueprint/new?repo=https://github.com/yuilyoung/crazyacade)을 열고 Render에 로그인합니다.
2. 요청되면 GitHub의 `yuilyoung/crazyacade` 저장소 접근을 연결합니다. Blueprint는 `main`의 [`render.yaml`](../../render.yaml)을 읽습니다. Root Directory는 별도로 지정하지 않습니다.
3. `poppop-arena`, Docker, Free 서비스 한 개로 표시되는지 확인하고 배포를 시작합니다. 이 단계에서는 Supabase 키를 입력하지 않습니다.
4. 서비스가 Live가 되면 Render 대시보드에 표시되는 `https://…onrender.com` 주소를 엽니다. 실제 URL은 생성 후 확인하며 저장소 이름만으로 미리 정하지 않습니다.
5. **게임 시작**을 눌러 로비에 들어간 뒤 **AI 연습** 또는 훈련을 선택합니다. 캐릭터·스킨과 맵·규칙은 각각의 메뉴에 있습니다. 이동은 방향키/WASD, 물폭탄은 Space, 다트는 F, 별 패스는 G입니다. 모바일은 화면 버튼을 사용합니다. 음악·효과음은 화면에서 직접 켭니다.

배포 링크는 실행 중인 게임 URL이 아닙니다. Render 계정 연결과 최초 배포가 완료되어야 다른 기기에서도 열 수 있는 주소가 생깁니다. 계정 비밀번호나 서버 키를 GitHub·채팅에 올릴 필요가 없습니다.

## 배포 구성

| 설정 | 값과 이유 |
| --- | --- |
| Dockerfile / context | 저장소 루트의 `./Dockerfile` / `.`. `Server/`를 Root Directory로 지정하면 COPY 경로가 맞지 않습니다. |
| 공개 포트 | `HOST=0.0.0.0`, `PORT=10000`. Docker 자체 상태 검사도 `PORT`를 사용합니다. |
| 상태 검사 | `/health/ready`; 신규 입장을 받는 동안 200, 종료 대기 중 503입니다. |
| 인증 | `ALLOW_DEV_GUESTS=false`. AI 연습·훈련만 별도 익명 연습 경로를 사용합니다. |
| 결과 큐 | `/app/data/results`; 이미지의 비루트 사용자에게 쓰기 권한이 있습니다. 무료 데모에는 영속 디스크를 추가하지 않습니다. |
| 종료 대기 | `RUNTIME_DRAIN_MS=20000`. 재배포 시 신규 입장을 중단하고 진행 경기에는 최대 20초를 줍니다. |
| 인스턴스 | 1개. 방·매칭·복귀 정보는 한 프로세스 메모리에 있습니다. |
| 지역 | Singapore. 실제 계정의 Free 제공 여부는 배포 화면에서 확인합니다. |
| 업데이트 | `autoDeployTrigger: checksPass`. 최초 연결 후 `main`의 CI 검사 통과 시 자동 배포합니다. 서비스의 Events에서 배포 성공 여부를 확인합니다. |

브라우저는 현재 HTTPS 주소와 같은 호스트에 WSS로 연결합니다. 클라이언트에 서버 주소를 따로 입력하지 않습니다. Render의 서비스 URL을 사용하며 Docker 내부 주소나 `localhost`를 사용자에게 공유하지 않습니다.

무료 서비스의 유휴 정지·사용량 제한은 [Render 무료 인스턴스 안내](https://render.com/docs/free)를 따릅니다. 첫 접속에서 깨우는 시간이 걸릴 수 있습니다. 무료 컨테이너 파일은 재배포·교체 뒤 보존을 전제로 하지 않으며 진행 중 경기는 재시작 시 사라집니다. 연습방은 프로세스당 최대 8개이고, 이는 무료 인스턴스의 성능 보장이 아닙니다.

## 사람 대전·랭킹을 연결할 때

1. [README의 Supabase 설정](../../README.md#supabase-설정)에 따라 스키마와 네 마이그레이션(마지막 `20261107_member_accounts.sql`)을 적용합니다. Email 인증을 켜고 Site URL을 `https://poppop-arena.onrender.com` 등 실제 배포 주소로 설정합니다. 메일 확인을 사용하면 확인 링크를 연 다음 게임에서 로그인합니다.
2. Render 서비스의 Environment에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`를 추가하고 재배포합니다. 서비스 역할 키는 Render 서버 환경에만 둡니다. 공개 게스트 허용 값은 계속 `false`입니다.
3. 랭크 결과의 재전송까지 운영하려면 영속 디스크를 지원하는 플랜과 디스크를 별도로 구성합니다. `RESULT_OUTBOX_DIR`을 해당 디스크 안의 경로로 변경하고 이미지 사용자 UID 1000의 쓰기 권한을 확인합니다. 기존 디렉터리 위에 디스크를 마운트하면 이미지 빌드 시 지정한 소유권이 그대로 적용된다고 가정하지 않습니다. 이 Blueprint는 유료 자원을 만들지 않습니다.
4. 서로 다른 회원 계정의 두 브라우저에서 인증된 1대1로 입장·결과 저장을 확인한 뒤 8인 4대4를 확인합니다. `/health/storage`의 정상 상태, 경기 결과의 **저장 완료**, Supabase 반영까지 확인합니다. AI 연습 성공은 인증·전적 저장 성공을 대신하지 않습니다.

Supabase가 없는 동안 사람 대전은 입장이 거부되고 랭킹은 사용할 수 없다는 안내가 표시됩니다. 이를 해결하려고 `ALLOW_DEV_GUESTS=true`로 바꾸지 않습니다. 계정 연결·영속 저장·실제 공개 환경의 장시간 검증 상태는 [서비스 준비 상태](Service-Readiness.md)에 구분합니다.

## Live 이후 회원서비스 활성화

현재 게임 주소는 `https://poppop-arena.onrender.com`이며 사용자가 Render의 **Live** 전환을 확인했습니다. 이는 서버 배포 상태이고 Supabase의 SQL 적용·Email 설정·실제 회원가입 완료 여부는 별도로 확인합니다.

1. [통합 설치 SQL](https://github.com/yuilyoung/crazyacade/blob/main/Supabase/setup.sql)을 열고 파일 우측의 **Copy raw file**로 전체 내용을 복사합니다. [프로젝트 SQL Editor](https://supabase.com/dashboard/project/quxsmhgbjhzyjzgttqad/sql/new)에 붙여넣어 **Run**을 누릅니다. 기본 `postgres` 역할로 실행하며 성공 결과는 `Database setup complete`입니다. 별도 키나 사용자 비밀번호를 SQL에 넣지 않습니다. 이 파일은 신규/부분/기존 설치에서 실행할 수 있고 기존 프로필·점수·경기·결제 기록을 보존합니다. 오류가 있으면 전체 트랜잭션을 되돌리므로 오류를 해결한 뒤 전체 파일을 다시 실행합니다.
2. Supabase **Authentication → Sign In / Providers → Email**에서 Email 제공자를 켜고 새 회원가입을 허용합니다. **URL Configuration → Site URL**은 `https://poppop-arena.onrender.com`으로 지정합니다. Email 확인을 사용하는 경우 확인 메일의 링크를 연 뒤 게임 화면에서 로그인합니다. 외부 테스트 사용자에게 메일을 보내려면 프로젝트의 SMTP 발송 설정·허용 수신자·발송 한도도 확인해야 합니다. 기본 메일 제공자의 제한은 DB 설치로 바뀌지 않습니다.
3. Render의 세 환경변수를 저장·재배포한 뒤 [서비스 연결 점검](https://poppop-arena.onrender.com/health/services)을 엽니다. 최신 코드가 배포되기 전에는 404일 수 있습니다. `status: "ready"`와 네 `checks`가 모두 `"ok"`면 아래 읽기 전용 검사를 통과한 것입니다. SQL 수정 후에는 캐시 만료를 위해 최대 30초 뒤 다시 확인합니다.
4. 게임의 **로그인 · 회원가입**에서 직접 가입하고, 메일 확인 후 로그인하여 **내 정보**의 닉네임 저장·재로그인을 확인합니다. 서로 다른 두 계정으로 클래식 **1 vs 1 · 2명**을 완료하고 결과의 **저장 완료**, 내 정보의 경기 기록, 랭킹 반영을 확인합니다. 이후 같은 방식으로 **4 vs 4 · 8명**을 확인합니다. AI 연습·친구+AI 등 비랭크 모드는 계정 전적을 저장하지 않습니다.

`/health/services`는 공개 상태 코드만 반환합니다. Auth 공개 설정은 공개 키로 읽고 DB의 필수 열은 서버 키를 사용한 HEAD 요청으로 확인하며 실제 회원 행을 읽지 않습니다. 결과 저장 RPC는 OpenAPI 메타데이터로 존재·인자를 확인하고 실행하지 않습니다. 요청은 최대 5초, 응답 본문은 최대 1MiB이며 동시 요청을 합치고 30초 동안 결과를 재사용합니다. 이 점검의 `ready`는 실제 메일 발송·JWT 로그인·RLS 전체 검증·경기 쓰기·영속 디스크 성공을 의미하지 않습니다. **Render Health Check Path는 계속 `/health/ready`로 유지**합니다.

| 점검 결과 | 다음 조치 |
| --- | --- |
| `configuration: missing` | Render에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`가 모두 있는지 확인하고 재배포 |
| `configuration: invalid` | URL 형식, 앞뒤 공백, 키 칸이 바뀌지 않았는지 확인. 서버 키를 공개 키 칸에 넣지 않음 |
| `configuration: development_guests_enabled` | `ALLOW_DEV_GUESTS=false`로 재배포 |
| `authentication: email_disabled` / `signup_disabled` | Email 제공자 / 새 회원가입 허용 설정 확인 |
| `unauthorized` | 같은 Supabase 프로젝트에서 복사한 올바른 키인지 확인 |
| `database` 또는 `resultStorage: schema_missing` | 통합 SQL 실행 후 30초 뒤 재확인. Data API의 public 스키마와 OpenAPI 접근 설정도 확인 |
| `timeout` / `unavailable` | Supabase 프로젝트 중지·일시 장애·네트워크 상태 확인 |
| `invalid_response` | 올바른 Supabase 프로젝트 URL 및 API 응답 형식 확인 |

통합 SQL은 정식 마이그레이션에서 생성합니다. SQL 변경 시 `python3 scripts/build-supabase-setup.py`로 갱신하며 CI의 `--check`와 실제 PostgreSQL 설치·재실행·데이터 보존·권한·롤백 검사로 검증합니다. 생성 파일만 직접 편집하지 않습니다.

### 현재 프로젝트 연결값

사용자가 선택한 Supabase 프로젝트는 `quxsmhgbjhzyjzgttqad`입니다. 공개 프로젝트 URL은 Blueprint에 반영했습니다. 키는 저장소에 넣지 않고 Render의 `poppop-arena → Environment → Edit`에서 설정합니다.

| Render 환경변수 이름 | 입력값 |
| --- | --- |
| `SUPABASE_URL` | `https://quxsmhgbjhzyjzgttqad.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase API Keys 화면의 `anon` 공개 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | 같은 화면의 `service_role` 서버 전용 키 |

두 키를 저장한 뒤 새 설정으로 재배포합니다. 이 문서와 Blueprint의 URL 반영은 Render에서 비밀 키 입력이나 Supabase 스키마 적용이 완료됐다는 의미가 아닙니다.

## 공개 URL 확인과 문제 해결

- `/health/ready`가 HTTP 200을 반환하는지 확인합니다. `/api/config`의 `allowDevGuests`는 `false`여야 합니다.
- 게임 화면에서 연습을 시작하고 15×13 맵·8명(사람 1명, AI 7명), 이동·물폭탄을 확인합니다. 두 종류 훈련도 시작합니다. 실제 전체화면 진입·ESC 복귀에서 게임판과 설정 창이 유지되는지 확인합니다.
- 브라우저 개발자 도구의 Network에서 WebSocket이 같은 도메인의 `wss://`로 연결되는지 확인합니다. 단순 HTTP 상태 검사만으로 실시간 플레이 성공을 판단하지 않습니다.
- 빌드 실패는 Events/Logs에서 Docker context와 lockfile을 확인합니다. 시작 실패는 `/usr/bin/flock` 및 결과 폴더 쓰기 권한, 상태 검사 실패는 `HOST`·`PORT`·`/health/ready`를 확인합니다.
- 새 커밋이 자동 배포되지 않으면 GitHub Actions의 검사 상태와 Render의 저장소 연결을 확인합니다. CI 실패·검사 미실행으로 대기 중인 경우는 배포 성공으로 취급하지 않습니다.
- 재배포 후 연결이 복구되지 않으면 페이지를 새로 열고 새 연습방으로 시작합니다. 서버 프로세스가 바뀐 이전 경기는 복구하지 않습니다.

## 로컬 배포 구성 검증 (2026-11-07)

Docker 빌드와 다음 검사를 통과했습니다. 애플리케이션의 `Server/`, `Assets/`, `Supabase/` 코드는 이번 배포 설정에서 변경하지 않았습니다.

- 기존 이미지에서 `PORT=10000`일 때 상태 검사 실패를 재현하고, 수정 이미지의 기본8080·지정10000 포트에서 상태 검사 성공을 확인했습니다.
- Blueprint 환경변수로 실행한 컨테이너가 UID1000으로 결과 폴더를 열고, Supabase 없이 준비 상태200을 반환했습니다. 개발 게스트 값은 false입니다.
- 실제 Chromium에서 인증 없는 사람 대전 거부, AI7명과15×13 4대4 연습, 키보드 이동·물폭탄, 기본·하모니 훈련의 준비→시작을 확인했습니다. 브라우저 JavaScript 오류는 없었습니다.
- 진행 중 연습방이 있는 상태에서 SIGTERM을 보내 준비 상태503과30초 이내 정상 종료(exit0)를 확인했습니다.

검증 범위: 위 검사는 로컬 Docker와 HTTP/WS 환경입니다. 실제 Render 계정의 Blueprint 생성·배포, 공개 URL의 HTTPS/WSS, Render 리소스에서의 성능은 최초 배포 후 별도 확인해야 합니다. 원격 GitHub Actions 성공 여부도 로컬 검사로 대신하지 않습니다.

설정 필드와 배포 링크는 Render의 공식 공개 자료인 [Blueprint 필드 안내](https://github.com/render-oss/skills/blob/main/skills/render-blueprints/references/field-reference.md), [Docker 안내](https://github.com/render-oss/skills/blob/main/skills/render-docker/SKILL.md), [배포 안내](https://github.com/render-oss/skills/blob/main/skills/render-deploy/SKILL.md)를 기준으로 확인했습니다. Render 계정에서의 Blueprint 검증·생성을 실행한 기록은 아닙니다.

회원정보·최근 경기·결제내역은 **내 정보**에서 조회합니다. 결제 테이블은 본인 조회와 서버 기록용이며 현재 구매/청구 API는 없습니다. Supabase 설정이 없으면 회원 화면에 준비 중 안내를 표시하고 로그인 없는 AI 연습을 제공합니다.
