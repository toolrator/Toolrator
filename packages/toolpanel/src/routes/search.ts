import { Hono } from "hono";
import { config } from "../config.js";

export const search = new Hono();

// Canonical search schema returned to toolconnector's schema-cache.
// Used by the implicit-default engine as its schemaUrl target.
const CANONICAL_SCHEMA = {
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (supports typos and prefixes; multi-word triggers hybrid semantic search).",
      },
      limit: { type: "number", description: "Max results (default 20, server cap 100)." },
      offset: { type: "number", description: "Pagination offset." },
    },
    required: ["query"],
  },
  outputDescription:
    "JSON object with `hits` (matching servers), `toolHits` (matched tools inside those servers), `facets` (distribution counts for tags/provider), and pagination (`total`, `offset`, `limit`).",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "3600",
};

function corsOptions(c: import("hono").Context) {
  return c.body(null, 204, CORS_HEADERS);
}

// GET /api/search/schema  — consumed by toolconnector for every engine whose schemaUrl is set.
search.get("/api/search/schema", (c) => {
  return c.json(CANONICAL_SCHEMA, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
  });
});

search.options("/api/search/schema", corsOptions);
search.options("/api/search", corsOptions);
search.options("/api/facets", corsOptions);
search.options("/api/search/admin", corsOptions);
search.options("/api/search/admin/reindex", corsOptions);

// ── Unified upstream-error envelope ───────────────────────────────────────
//
// Every proxy path on this router returns one of these on error:
//
//   200 — upstream success, body forwarded verbatim.
//   4xx/5xx — JSON:
//     {
//       "error": "upstream_unreachable" | "upstream_error" | "invalid_input",
//       "status":  <toolpanel status code>,
//       "upstreamStatus": <upstream status code, or null>,
//       "message": "<human summary>",
//       "upstreamMessage": "<upstream's message, or null>",
//       "upstreamUrl": "<sanitized upstream URL, no auth headers>"
//     }
//
// `upstream_unreachable` (503): fetch threw — DNS, connection refused, abort/timeout.
// `upstream_error`: fetch succeeded but upstream returned non-2xx; we forward upstream's
//    status verbatim and include the upstream body's message if it was JSON.
// `invalid_input` (400): local validation before fetch.

interface UpstreamErrorBody {
  error: "upstream_unreachable" | "upstream_error" | "invalid_input";
  status: number;
  upstreamStatus: number | null;
  message: string;
  upstreamMessage: string | null;
  upstreamUrl: string;
}

function sanitizeUpstreamUrl(url: string): string {
  try {
    const u = new URL(url);
    // Never leak any Authorization or query-string secrets; keep origin + pathname + non-sensitive query.
    u.searchParams.delete("token");
    return `${u.origin}${u.pathname}${u.search ? u.search : ""}`;
  } catch {
    return url;
  }
}

function errorResponse(
  body: UpstreamErrorBody,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function unreachableResponse(upstreamUrl: string, err: unknown): Response {
  return errorResponse({
    error: "upstream_unreachable",
    status: 503,
    upstreamStatus: null,
    message: (err as Error)?.message ?? "search engine not reachable",
    upstreamMessage: null,
    upstreamUrl: sanitizeUpstreamUrl(upstreamUrl),
  }, 503);
}

async function forwardUpstreamResponse(res: Response, upstreamUrl: string): Promise<Response> {
  const text = await res.text();
  const contentType = res.headers.get("Content-Type") ?? "application/json";
  // Forward verbatim on 2xx.
  if (res.status >= 200 && res.status < 300) {
    return new Response(text, {
      status: res.status,
      headers: {
        "Content-Type": contentType,
        "Server-Timing": res.headers.get("Server-Timing") ?? "",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    });
  }
  // Non-2xx: try to extract the upstream's error message.
  let upstreamMessage: string | null = null;
  try {
    const parsed = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (typeof p.message === "string") upstreamMessage = p.message;
      else if (typeof p.error === "string") upstreamMessage = p.error;
    }
  } catch {
    // Non-JSON body — keep raw text trimmed as the message if short.
    if (text && text.length < 500) upstreamMessage = text.trim();
  }
  return errorResponse({
    error: "upstream_error",
    status: res.status,
    upstreamStatus: res.status,
    message: `Search engine responded with HTTP ${res.status}.`,
    upstreamMessage,
    upstreamUrl: sanitizeUpstreamUrl(upstreamUrl),
  }, res.status);
}

async function proxyUpstream(upstreamUrl: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.searchAdminToken}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  try {
    const res = await fetch(upstreamUrl, { ...init, headers });
    return await forwardUpstreamResponse(res, upstreamUrl);
  } catch (err) {
    return unreachableResponse(upstreamUrl, err);
  }
}

function buildUpstreamUrl(path: string, query: URLSearchParams): string {
  const u = new URL(`${config.searchEngineBaseUrl}${path}`);
  for (const [k, v] of query.entries()) u.searchParams.append(k, v);
  return u.toString();
}

// GET /api/search — legacy GET used by the implicit default engine
// (see search-engine-http.ts in packages/toolconnector). The engine's
// search() issues a GET `${endpoint}/api/search?q=...&limit=...&offset=...`.
search.get("/api/search", async (c) => {
  const q = new URLSearchParams();
  const allowed = ["q", "limit", "offset", "tags", "provider", "maxTools"];
  for (const k of allowed) {
    const v = c.req.query(k);
    if (v) q.append(k, v);
  }
  return proxyUpstream(buildUpstreamUrl("/search", q), { method: "GET" });
});

// POST /api/search — used by /panel/search UI
search.post("/api/search", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return proxyUpstream(`${config.searchEngineBaseUrl}/search`, {
    method: "POST",
    body: JSON.stringify(body),
  });
});

// GET /api/facets — proxy used by /panel/search UI
search.get("/api/facets", async (c) => {
  return proxyUpstream(`${config.searchEngineBaseUrl}/facets`, { method: "GET" });
});

// GET /api/search/health — used by the search/admin pages to render the status pill
// on first render (no polling per the user's decision). Returns a stable envelope.
search.get("/api/search/health", async (c) => {
  const url = `${config.searchEngineBaseUrl}/health`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.searchAdminToken}` },
      signal: AbortSignal.timeout(2_000),
    });
    const text = await res.text();
    let data: { status?: string; backend?: string; documentCount?: number } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status === 200 && data && data.status === "ok") {
      return c.json(
        {
          ok: true,
          status: data.status,
          backend: data.backend ?? null,
          documentCount: typeof data.documentCount === "number" ? data.documentCount : null,
          baseUrl: config.searchEngineBaseUrl,
          upstreamStatus: 200,
        },
        200,
        { "Cache-Control": "no-store", ...CORS_HEADERS },
      );
    }
    return errorResponse(
      {
        error: "upstream_error",
        status: res.status,
        upstreamStatus: res.status,
        message: `Search engine /health returned HTTP ${res.status}.`,
        upstreamMessage: data && typeof data.status === "string" ? data.status : null,
        upstreamUrl: sanitizeUpstreamUrl(url),
      },
      res.status,
    );
  } catch (err) {
    return unreachableResponse(url, err);
  }
});

// ----- Admin proxies used by /panel/search/admin UI -----
// These wrap Toolhub /admin/* with the configured admin token.
// All return the same envelope on error.

// GET /api/search/admin — dump all docs
search.get("/api/search/admin", async (c) => {
  return proxyUpstream(`${config.searchEngineBaseUrl}/admin/dump`, { method: "GET" });
});

// POST /api/search/admin — index one or more documents ({ documents: [...] })
search.post("/api/search/admin", async (c) => {
  const raw = await c.req.text();
  return proxyUpstream(`${config.searchEngineBaseUrl}/admin/index`, {
    method: "POST",
    body: raw,
  });
});

// DELETE /api/search/admin?name=<mcp_name> — delete one doc
search.delete("/api/search/admin", async (c) => {
  const name = c.req.query("name");
  if (!name) {
    return c.json({ error: "invalid_input", message: "?name= is required" }, 400, CORS_HEADERS);
  }
  const url = `${config.searchEngineBaseUrl}/admin/index/${encodeURIComponent(name)}`;
  return proxyUpstream(url, { method: "DELETE" });
});

// POST /api/search/admin/reindex — full reindex ({ documents: [...] })
search.post("/api/search/admin/reindex", async (c) => {
  const raw = await c.req.text();
  return proxyUpstream(`${config.searchEngineBaseUrl}/admin/reindex`, {
    method: "POST",
    body: raw,
  });
});
