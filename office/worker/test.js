/**
 * 중계 서버 동작 검사 — 노션에 실제로 붙지 않고, 노션 응답을 흉내 내어 확인합니다.
 *
 *   cd office/worker && node test.js
 *
 * 확인하는 것
 *   - CORS 사전 요청(OPTIONS)
 *   - /health, /tasks(GET), /tasks(POST), /tasks/:id(PATCH)
 *   - 노션에 보내는 요청 모양(엔드포인트·헤더·속성 이름)
 *   - 잘못된 입력(400), 노션 오류(502), 없는 경로(404), 설정 누락(500)
 *   - 토큰이 응답 본문에 절대 나오지 않는지
 */

import assert from "node:assert/strict";
import worker from "./index.js";

const DB_ID = "b7224085-cf9d-45f2-915a-d1c09df89f11";
const TOKEN = "secret_test_token_do_not_leak";
const ENV = { NOTION_TOKEN: TOKEN, NOTION_DATABASE_ID: DB_ID };

let calls = [];
let nextReply = null;

function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const reply = nextReply;
    if (!reply) throw new Error("예상하지 못한 노션 호출: " + url);
    nextReply = null;
    const body = JSON.stringify(reply.body === undefined ? {} : reply.body);
    return new Response(body, {
      status: reply.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

function page({ id, title, assignee, status, summary, created }) {
  return {
    id,
    url: "https://www.notion.so/" + id.replace(/-/g, ""),
    created_time: created,
    properties: {
      작업: { title: [{ plain_text: title }] },
      "작업 AI": { select: assignee ? { name: assignee } : null },
      상태: { select: status ? { name: status } : null },
      "핵심 정리": { rich_text: summary ? [{ plain_text: summary }] : [] },
      작업일: { created_time: created },
    },
  };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
    console.log("PASS  " + name);
  } catch (err) {
    results.push(["FAIL", name]);
    console.log("FAIL  " + name + "\n      " + (err && err.message));
  }
}

function req(path, init) {
  return new Request("https://relay.example.workers.dev" + path, init);
}

const restore = stubFetch();

await test("OPTIONS 는 204 와 CORS 헤더를 돌려준다", async () => {
  calls = [];
  const res = await worker.fetch(req("/tasks", { method: "OPTIONS" }), ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET,POST,PATCH,OPTIONS");
  assert.equal(res.headers.get("Access-Control-Allow-Headers"), "Content-Type,Authorization");
});

await test("GET /health 는 ok 와 설정 여부를 알려 준다", async () => {
  const res = await worker.fetch(req("/health"), ENV);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.notionConfigured, true);
  assert.equal(data.databaseIdConfigured, true);
  assert.equal(JSON.stringify(data).includes(TOKEN), false);
});

await test("GET /tasks 는 노션 목록을 최신순으로 변환한다", async () => {
  calls = [];
  nextReply = {
    body: {
      results: [
        page({ id: "11111111-1111-1111-1111-111111111111", title: "다음 주 예약표 정리", assignee: "미니미", status: "진행중", summary: "화요일까지", created: "2026-11-26T01:00:00.000Z" }),
        page({ id: "22222222-2222-2222-2222-222222222222", title: "설탕이 응답하라~오바", assignee: "설탕이", status: "대기", summary: "", created: "2026-11-27T15:57:00.000Z" }),
      ],
    },
  };
  const res = await worker.fetch(req("/tasks"), ENV);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.tasks.length, 2);
  // 최신순
  assert.equal(data.tasks[0].title, "설탕이 응답하라~오바");
  assert.equal(data.tasks[0].assignee, "설탕이");
  assert.equal(data.tasks[0].status, "대기");
  assert.equal(data.tasks[0].date, "2026-11-27T15:57:00.000Z");
  assert.match(data.tasks[0].url, /^https:\/\/www\.notion\.so\//);
  assert.equal(data.tasks[1].summary, "화요일까지");

  // 노션에 보낸 요청 확인
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.notion.com/v1/databases/" + DB_ID + "/query");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Notion-Version"], "2022-06-28");
  assert.equal(calls[0].init.headers.Authorization, "Bearer " + TOKEN);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.page_size, 100);
  assert.equal(sent.sorts[0].timestamp, "created_time");
  assert.equal(sent.sorts[0].direction, "descending");
});

await test("POST /tasks 는 '대기' 행을 만들고 오피스 키(assignee)를 노션 이름으로 바꾼다", async () => {
  calls = [];
  nextReply = {
    status: 200,
    body: page({ id: "33333333-3333-3333-3333-333333333333", title: "새 지시", assignee: "설탕이", status: "대기", summary: "메모", created: "2026-11-28T00:10:00.000Z" }),
  };
  const res = await worker.fetch(
    req("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  새 지시  ", assignee: "suger", summary: "메모" }),
    }),
    ENV
  );
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.task.status, "대기");
  assert.equal(data.task.assignee, "설탕이");

  assert.equal(calls[0].url, "https://api.notion.com/v1/pages");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.parent.database_id, DB_ID);
  assert.equal(sent.properties["작업"].title[0].text.content, "새 지시");
  assert.equal(sent.properties["작업 AI"].select.name, "설탕이");
  assert.equal(sent.properties["상태"].select.name, "대기");
  assert.equal(sent.properties["핵심 정리"].rich_text[0].text.content, "메모");
  // created_time 속성은 보내지 않는다 (노션이 값을 거부함)
  assert.equal("작업일" in sent.properties, false);
});

await test("POST /tasks 는 한글 이름도 그대로 받는다", async () => {
  calls = [];
  nextReply = {
    body: page({ id: "44444444-4444-4444-4444-444444444444", title: "한글 이름", assignee: "미니미", status: "대기", created: "2026-11-28T00:20:00.000Z" }),
  };
  const res = await worker.fetch(
    req("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "한글 이름", assignee: "미니미" }),
    }),
    ENV
  );
  assert.equal(res.status, 201);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.properties["작업 AI"].select.name, "미니미");
});

await test("POST /tasks 제목·담당자 누락은 400", async () => {
  let res = await worker.fetch(
    req("/tasks", { method: "POST", body: JSON.stringify({ assignee: "미니미" }) }),
    ENV
  );
  assert.equal(res.status, 400);

  res = await worker.fetch(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "제목", assignee: "없는사람" }) }),
    ENV
  );
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.message, /assignee/);
});

await test("POST /tasks 잘못된 JSON 은 400", async () => {
  const res = await worker.fetch(req("/tasks", { method: "POST", body: "{not json" }), ENV);
  assert.equal(res.status, 400);
});

await test("PATCH /tasks/:id 는 상태를 바꾼다", async () => {
  calls = [];
  const id = "55555555-5555-5555-5555-555555555555";
  nextReply = {
    body: page({ id, title: "상태 바꾸기", assignee: "소금이", status: "완료", created: "2026-11-27T00:00:00.000Z" }),
  };
  const res = await worker.fetch(
    req("/tasks/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "완료" }),
    }),
    ENV
  );
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.task.status, "완료");

  assert.equal(calls[0].url, "https://api.notion.com/v1/pages/" + id);
  assert.equal(calls[0].init.method, "PATCH");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.properties["상태"].select.name, "완료");
});

await test("PATCH 보류·실패 상태도 받는다", async () => {
  for (const status of ["보류", "실패", "진행중", "대기"]) {
    calls = [];
    nextReply = {
      body: page({ id: "66666666-6666-6666-6666-666666666666", title: "x", assignee: "후니훈", status, created: "2026-11-27T00:00:00.000Z" }),
    };
    const res = await worker.fetch(
      req("/tasks/66666666-6666-6666-6666-666666666666", {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
      ENV
    );
    assert.equal(res.status, 200, status + " 가 거절됨");
  }
});

await test("PATCH 잘못된 상태·빈 본문은 400", async () => {
  let res = await worker.fetch(
    req("/tasks/77777777-7777-7777-7777-777777777777", {
      method: "PATCH",
      body: JSON.stringify({ status: "지워짐" }),
    }),
    ENV
  );
  assert.equal(res.status, 400);

  res = await worker.fetch(req("/tasks/77777777-7777-7777-7777-777777777777", { method: "PATCH", body: "{}" }), ENV);
  assert.equal(res.status, 400);
});

await test("노션 401 은 502 로 감싸고 토큰을 흘리지 않는다", async () => {
  nextReply = { status: 401, body: { code: "unauthorized", message: "API token is invalid." } };
  const res = await worker.fetch(req("/tasks"), ENV);
  const data = await res.json();
  assert.equal(res.status, 502);
  assert.equal(data.ok, false);
  assert.match(data.message, /401/);
  assert.equal(JSON.stringify(data).includes(TOKEN), false);
});

await test("설정이 비면 500", async () => {
  const res = await worker.fetch(req("/tasks"), {});
  const data = await res.json();
  assert.equal(res.status, 500);
  assert.match(data.message, /NOTION_TOKEN/);
});

await test("없는 경로는 404", async () => {
  const res = await worker.fetch(req("/nope"), ENV);
  assert.equal(res.status, 404);
});

restore();

const failed = results.filter((r) => r[0] === "FAIL");
console.log("\n" + (results.length - failed.length) + "/" + results.length + " 통과");
if (failed.length) process.exitCode = 1;
