/**
 * 드쥬르 합동 비서실 — 오피스 지휘실 ↔ 노션 중계 서버 (Cloudflare Worker)
 *
 * 브라우저(office/index.html)는 보안 정책 때문에 노션 API 를 직접 부를 수 없어서,
 * 이 작은 중계 서버가 노션 REST API 를 대신 호출해 줍니다.
 *
 * 환경변수 (대시보드 Settings > Variables 또는 `wrangler secret put`)
 *   NOTION_TOKEN        노션 통합 시크릿 (필수, secret 으로 넣기)
 *   NOTION_DATABASE_ID  b7224085-cf9d-45f2-915a-d1c09df89f11  ('📒 AI 업무 일지')
 *   ALLOWED_ORIGIN      (선택) 오피스 페이지 주소. 비우면 "*"
 *
 * API
 *   GET   /health      동작 확인
 *   GET   /tasks       노션 업무 일지 최신순 목록
 *   POST  /tasks       새 업무를 '대기' 상태로 추가
 *   PATCH /tasks/:id   상태 변경 (대기·진행중·완료·보류·실패…)
 *
 * 비밀키는 코드에 절대 적지 않습니다. (저장소가 공개되어 있음)
 */

const NOTION_API = "https://api.notion.com/v1";
// 이 DB 는 data source 가 하나뿐이라 v1 databases 엔드포인트가 그대로 동작합니다.
// (2025-09-03 이후 버전은 data_sources 엔드포인트를 쓰므로 버전을 고정합니다.)
const NOTION_VERSION = "2022-06-28";

const STATUSES = ["수집", "대기", "진행중", "보류", "완료", "실패"];

// 오피스 화면의 키(minimi…)와 노션 select 값(미니미…)을 모두 받아 줍니다.
const ASSIGNEES = {
  minimi: "미니미",
  suger: "설탕이",
  sogeumi: "소금이",
  hunihun: "후니훈",
  미니미: "미니미",
  설탕이: "설탕이",
  소금이: "소금이",
  후니훈: "후니훈",
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status || 500;
  }
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": (env && env.ALLOWED_ORIGIN) || "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      corsHeaders(env)
    ),
  });
}

function fail(message, status, env) {
  return json({ ok: false, message: message }, status, env);
}

function requireConfig(env) {
  if (!env || !env.NOTION_TOKEN) {
    throw new HttpError(
      "NOTION_TOKEN 이 설정되지 않았습니다. Worker 환경변수에 노션 통합 시크릿을 넣어 주세요.",
      500
    );
  }
  if (!env.NOTION_DATABASE_ID) {
    throw new HttpError(
      "NOTION_DATABASE_ID 가 설정되지 않았습니다. Worker 환경변수에 업무 일지 database_id 를 넣어 주세요.",
      500
    );
  }
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("object 아님");
    }
    return parsed;
  } catch (err) {
    throw new HttpError("요청 본문이 올바른 JSON 이 아닙니다.", 400);
  }
}

/** 노션 API 호출. 실패하면 토큰을 노출하지 않는 선에서 이유를 그대로 돌려줍니다. */
async function notionFetch(env, path, init) {
  requireConfig(env);
  const options = init || {};
  const res = await fetch(NOTION_API + path, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new HttpError(
        "노션 인증에 실패했습니다(401). NOTION_TOKEN 이 맞는지, 업무 일지 페이지에 통합이 연결됐는지 확인해 주세요.",
        502
      );
    }
    if (res.status === 404) {
      throw new HttpError(
        "노션에서 업무 일지를 찾지 못했습니다(404). NOTION_DATABASE_ID 와 페이지 연결(··· > Connections)을 확인해 주세요.",
        502
      );
    }
    const reason = (data && (data.message || data.code)) || "응답 " + res.status;
    throw new HttpError("노션 오류: " + reason, 502);
  }
  return data;
}

function richText(rich) {
  return (rich || [])
    .map(function (part) {
      if (part && typeof part.plain_text === "string") return part.plain_text;
      if (part && part.text && typeof part.text.content === "string") return part.text.content;
      return "";
    })
    .join("")
    .trim();
}

function selectName(prop) {
  return (prop && prop.select && prop.select.name) || "";
}

/** 노션 page → 오피스 지휘실이 쓰는 모양 */
function mapPage(page) {
  const p = (page && page.properties) || {};
  const title = richText((p["작업"] || {}).title) || "(제목 없음)";
  const assignee = selectName(p["작업 AI"]);
  const status = selectName(p["상태"]);
  const summary = richText((p["핵심 정리"] || {}).rich_text);
  // '작업일'은 노션 created_time 이라 값을 넣을 수 없습니다. 그래서 만들어진 시각을 씁니다.
  const created =
    page.created_time || (p["작업일"] && p["작업일"].created_time) || "";
  return {
    id: page.id,
    title: title,
    assignee: assignee,
    status: status,
    date: created,
    summary: summary,
    url: page.url || "",
  };
}

function normalizeAssignee(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  return ASSIGNEES[raw] || ASSIGNEES[raw.toLowerCase()] || "";
}

function buildTitle(text) {
  return { title: [{ type: "text", text: { content: String(text).slice(0, 200) } }] };
}

function buildSummary(text) {
  const value = String(text == null ? "" : text).trim();
  if (!value) return { rich_text: [] };
  return { rich_text: [{ type: "text", text: { content: value.slice(0, 1900) } }] };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // CORS 사전 요청
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (path === "/" && method === "GET") {
        return json(
          {
            ok: true,
            service: "dejour-office-notion-relay",
            endpoints: ["GET /health", "GET /tasks", "POST /tasks", "PATCH /tasks/:id"],
          },
          200,
          env
        );
      }

      if (path === "/health" && method === "GET") {
        return json(
          {
            ok: true,
            notionConfigured: Boolean(env && env.NOTION_TOKEN),
            databaseIdConfigured: Boolean(env && env.NOTION_DATABASE_ID),
            time: new Date().toISOString(),
          },
          200,
          env
        );
      }

      if (path === "/tasks" && method === "GET") {
        const data = await notionFetch(
          env,
          "/databases/" + encodeURIComponent(env.NOTION_DATABASE_ID) + "/query",
          {
            method: "POST",
            body: {
              page_size: 100,
              sorts: [{ timestamp: "created_time", direction: "descending" }],
            },
          }
        );
        const tasks = (data && data.results ? data.results : []).map(mapPage);
        tasks.sort(function (a, b) {
          return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
        });
        return json({ ok: true, count: tasks.length, tasks: tasks }, 200, env);
      }

      if (path === "/tasks" && method === "POST") {
        const body = await readJson(request);
        const title = String(body.title == null ? "" : body.title).trim();
        if (!title) return fail("title(업무 제목)이 필요합니다.", 400, env);
        const assignee = normalizeAssignee(body.assignee);
        if (!assignee) {
          return fail(
            "assignee 는 미니미·설탕이·소금이·후니훈 중 하나여야 합니다. (minimi·suger·sogeumi·hunihun 도 됩니다)",
            400,
            env
          );
        }
        const properties = {
          "작업": buildTitle(title),
          "작업 AI": { select: { name: assignee } },
          "상태": { select: { name: "대기" } },
        };
        const summary = String(body.summary == null ? "" : body.summary).trim();
        if (summary) properties["핵심 정리"] = buildSummary(summary);

        const page = await notionFetch(env, "/pages", {
          method: "POST",
          body: { parent: { database_id: env.NOTION_DATABASE_ID }, properties: properties },
        });
        return json({ ok: true, task: mapPage(page) }, 201, env);
      }

      const match = path.match(/^\/tasks\/([0-9a-fA-F-]{32,36})$/);
      if (match && method === "PATCH") {
        const body = await readJson(request);
        const properties = {};

        if (body.status !== undefined) {
          const status = String(body.status).trim();
          if (STATUSES.indexOf(status) < 0) {
            return fail(
              "status 는 " + STATUSES.join("·") + " 중 하나여야 합니다.",
              400,
              env
            );
          }
          properties["상태"] = { select: { name: status } };
        }
        if (body.summary !== undefined) {
          properties["핵심 정리"] = buildSummary(body.summary);
        }
        if (!Object.keys(properties).length) {
          return fail("바꿀 값이 없습니다. status 를 보내 주세요.", 400, env);
        }

        const page = await notionFetch(env, "/pages/" + match[1], {
          method: "PATCH",
          body: { properties: properties },
        });
        return json({ ok: true, task: mapPage(page) }, 200, env);
      }

      return fail("없는 경로입니다: " + method + " " + path, 404, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return fail((err && err.message) || "알 수 없는 오류가 났습니다.", status, env);
    }
  },
};
