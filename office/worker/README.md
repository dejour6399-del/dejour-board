# 노션 중계 서버 (Cloudflare Worker)

오피스 지휘실(`office/index.html`)과 노션 `📒 AI 업무 일지`를 이어 주는 작은 서버입니다.
브라우저는 보안 때문에 노션 API 를 직접 부를 수 없어서, 이 서버가 노션 대신 호출해 줍니다.

- 파일: `index.js` (서버 코드) · `wrangler.toml` (배포 설정) · `test.js` (동작 검사)
- 서버는 **비밀키를 코드에 담지 않습니다.** 노션 토큰은 Cloudflare 환경변수로만 넣습니다.
- 무료 플랜으로 충분합니다(하루 10만 요청까지).

## 준비물 2가지

1. **노션 통합 시크릿** — https://www.notion.so/my-integrations → `새 통합 만들기` → 이름 `드쥬르 오피스` → 작업 공간 고르기 → 저장 → `내부 통합 시크릿` 복사 (`secret_...` 또는 `ntn_...`)
2. **업무 일지에 통합 연결** — 노션에서 `📒  AI 업무 일지` 데이터베이스가 있는 페이지를 열고 → 오른쪽 위 `···` → `연결(Connections)` → 방금 만든 `드쥬르 오피스` 선택 · `확인`
   (연결하지 않으면 서버가 `404` 를 받습니다)

## 배포 — Cloudflare 대시보드에서 (권장)

1. https://dash.cloudflare.com 로그인 → 왼쪽 **Workers & Pages** → **Create** → **Workers** → **Create Worker**
2. 이름을 `dejour-office-relay` 로 정하고 **Deploy**
3. **Edit code** 를 눌러 편집기를 열고, 들어 있는 코드를 모두 지운 뒤 이 폴더의 `index.js` 내용을 그대로 붙여넣고 **Deploy**
4. **Settings(설정)** → **Variables and Secrets(변수 및 비밀)** 에 두 개를 추가

   | 이름 | 값 | 종류 |
   | --- | --- | --- |
   | `NOTION_TOKEN` | 위에서 복사한 통합 시크릿 | **Secret**(비밀) |
   | `NOTION_DATABASE_ID` | `b7224085-cf9d-45f2-915a-d1c09df89f11` | Text(일반 변수) |

5. 저장한 뒤 **Deploy** 를 한 번 더 눌러 반영
6. 주소 확인 — Workers 화면에 나오는 `https://dejour-office-relay.<계정>.workers.dev` 뒤에 `/health` 를 붙여 접속

   ```json
   { "ok": true, "notionConfigured": true, "databaseIdConfigured": true, "time": "..." }
   ```

   `notionConfigured` 가 `false` 면 4번의 변수 이름·저장 여부를 다시 봅니다.

7. 오피스 페이지(`office/index.html`) → **지휘실** 탭 → 주소 칸에 `https://dejour-office-relay.<계정>.workers.dev` 입력 → **연결**
   배지가 `노션 연결됨` 으로 바뀌고 노션 업무 일지의 카드가 그대로 올라옵니다.

## 배포 — 터미널에서 (선택)

```bash
cd office/worker
npx wrangler deploy
npx wrangler secret put NOTION_TOKEN        # 시크릿 붙여넣기
npx wrangler secret put NOTION_DATABASE_ID  # b7224085-cf9d-45f2-915a-d1c09df89f11
```

## API

| 메서드 · 경로 | 하는 일 | 요청 본문 | 응답 |
| --- | --- | --- | --- |
| `GET /health` | 동작·설정 확인 | — | `{ ok, notionConfigured, databaseIdConfigured, time }` |
| `GET /tasks` | 업무 일지 최신순 목록 | — | `{ ok, count, tasks: [{ id, title, assignee, status, date, summary, url }] }` |
| `POST /tasks` | 새 업무를 `대기` 로 추가 | `{ "title": "...", "assignee": "설탕이", "summary": "..." }` | `{ ok, task }` (201) |
| `PATCH /tasks/:id` | 상태 변경 | `{ "status": "진행중" }` | `{ ok, task }` |

- `assignee` 는 `미니미`·`설탕이`·`소금이`·`후니훈` (오피스 키 `minimi`·`suger`·`sogeumi`·`hunihun` 도 받습니다).
- `status` 는 `수집`·`대기`·`진행중`·`보류`·`완료`·`실패`.
- CORS: `Access-Control-Allow-Origin: *`, `Methods: GET,POST,PATCH,OPTIONS`, `Headers: Content-Type,Authorization`. 사전 요청(`OPTIONS`)은 `204`.
- 오류는 `{ ok:false, message:"..." }` 로 돌아옵니다. 잘못된 입력 `400`, 노션 쪽 문제 `502`, 설정 누락 `500`.

```bash
curl https://dejour-office-relay.<계정>.workers.dev/health
curl -X POST https://dejour-office-relay.<계정>.workers.dev/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"테스트 지시","assignee":"설탕이"}'
```

## 노션 속성 매핑

`notion data-sources inspect` 로 확인한 실제 스키마입니다.

| 오피스 | 노션 속성 | 타입 | 서버가 하는 일 |
| --- | --- | --- | --- |
| 제목 | `작업` | title | 쓰기 |
| 담당 | `작업 AI` | select | 쓰기 (`미니미`/`설탕이`/`소금이`/`후니훈`) |
| 상태 | `상태` | select | 쓰기 (`대기`로 만들고, `PATCH` 로 변경) |
| 요약 | `핵심 정리` | rich_text | 쓰기 |
| 날짜 | `작업일` | **created_time** | **쓰지 않음** — 노션이 만든 시각을 자동 기록하고, 서버는 그 값을 `date` 로 돌려줍니다 |

- 업무 일지 `data_source_id`: `6c5f1b61-617b-4fdf-b238-771aa2b4ca1a`
- 업무 일지 `database_id`: `b7224085-cf9d-45f2-915a-d1c09df89f11` ← 환경변수에 넣는 값
- Notion API 버전은 `2022-06-28` 로 고정했습니다. 이 데이터베이스는 데이터 소스가 하나뿐이라 `/v1/databases/{id}/query` 가 그대로 동작합니다.

## 잘 안 될 때

| 증상 | 볼 곳 |
| --- | --- |
| `/health` 의 `notionConfigured: false` | 변수 이름이 `NOTION_TOKEN` 인지, 저장 후 다시 Deploy 했는지 |
| `노션 인증에 실패했습니다(401)` | 시크릿 값 앞뒤 공백, 통합을 다시 만든 뒤 값 갱신 |
| `업무 일지를 찾지 못했습니다(404)` | `NOTION_DATABASE_ID` 값, 업무 일지 페이지에 통합 `연결` 했는지 |
| `노션 오류: ... is not a valid select option` | 담당자·상태 이름이 위 표와 같은지 |
| 브라우저에 `CORS` 오류 | Worker 를 다시 Deploy 하고 `/health` 가 열리는지 확인 |
| `지휘실` 배지가 `연결 안 됨` | 주소 끝에 `/` 가 없는지, `https://` 로 시작하는지 |

## 보안

- 주소를 아는 사람은 누구나 업무 일지에 글을 쓸 수 있습니다. **Worker 주소는 공개하지 마세요.**
- 오피스 페이지에서만 쓰게 하려면 `wrangler.toml` 의 `[vars]` 처럼 `ALLOWED_ORIGIN` 을 오피스 주소로 지정합니다.

## 검사

```bash
cd office/worker
node test.js
```

노션에 실제로 붙지 않고, 응답을 흉내 내어 경로·헤더·속성 이름·오류 처리를 확인합니다(13개 검사).
