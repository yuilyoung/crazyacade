# Render 브라우저 데모 배포

웹 화면과 WebSocket 게임 서버를 하나의 Docker 웹 서비스에 올립니다. Unity WebGL 빌드나 Vercel은 이 브라우저 POC 실행에 필요하지 않습니다. 최초 범위는 **Supabase 없이 로그인 없는 AI 7명과의 4대4 연습·기본 훈련·하모니 훈련**입니다.

## 처음 배포하기

1. [Render 배포 시작](https://dashboard.render.com/blueprint/new?repo=https://github.com/yuilyoung/crazyacade)을 열고 Render에 로그인합니다.
2. 요청되면 GitHub의 `yuilyoung/crazyacade` 저장소 접근을 연결합니다. Blueprint는 `main`의 [`render.yaml`](../../render.yaml)을 읽습니다. Root Directory는 별도로 지정하지 않습니다.
3. `poppop-arena`, Docker, Free 서비스 한 개로 표시되는지 확인하고 배포를 시작합니다. 이 단계에서는 Supabase 키를 입력하지 않습니다.
4. 서비스가 Live가 되면 Render 대시보드에 표시되는 `https://…onrender.com` 주소를 엽니다. 실제 URL은 생성 후 확인하며 저장소 이름만으로 미리 정하지 않습니다.
5. **혼자 연습하기** 또는 **구조 훈련 시작 / 하모니 패스 훈련**을 누릅니다. 이동은 방향키/WASD, 물폭탄은 Space, 다트는 F, 별 패스는 G입니다. 모바일은 화면 버튼을 사용합니다. 음악·효과음은 화면에서 직접 켭니다.

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

1. [README의 Supabase 설정](../../README.md#supabase-설정)에 따라 스키마와 세 마이그레이션을 적용하고 Anonymous sign-ins를 켭니다.
2. Render 서비스의 Environment에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`를 추가하고 재배포합니다. 서비스 역할 키는 Render 서버 환경에만 둡니다. 공개 게스트 허용 값은 계속 `false`입니다.
3. 랭크 결과의 재전송까지 운영하려면 영속 디스크를 지원하는 플랜과 디스크를 별도로 구성합니다. `RESULT_OUTBOX_DIR`을 해당 디스크 안의 경로로 변경하고 이미지 사용자 UID 1000의 쓰기 권한을 확인합니다. 기존 디렉터리 위에 디스크를 마운트하면 이미지 빌드 시 지정한 소유권이 그대로 적용된다고 가정하지 않습니다. 이 Blueprint는 유료 자원을 만들지 않습니다.
4. 두 브라우저에서 인증된 1대1로 입장·결과 저장을 확인한 뒤 8인 4대4를 확인합니다. `/health/storage`의 정상 상태, 경기 결과의 **저장 완료**, Supabase 반영까지 확인합니다. AI 연습 성공은 인증·전적 저장 성공을 대신하지 않습니다.

Supabase가 없는 동안 사람 대전은 입장이 거부되고 랭킹은 사용할 수 없다는 안내가 표시됩니다. 이를 해결하려고 `ALLOW_DEV_GUESTS=true`로 바꾸지 않습니다. 계정 연결·영속 저장·실제 공개 환경의 장시간 검증 상태는 [서비스 준비 상태](Service-Readiness.md)에 구분합니다.

## 공개 URL 확인과 문제 해결

- `/health/ready`가 HTTP 200을 반환하는지 확인합니다. `/api/config`의 `allowDevGuests`는 `false`여야 합니다.
- 게임 화면에서 연습을 시작하고 15×13 맵·8명(사람 1명, AI 7명), 이동·물폭탄을 확인합니다. 두 종류 훈련도 시작합니다.
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
