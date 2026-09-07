import { Hono } from "hono";
import { stat } from "node:fs/promises";
import { config } from "../config.js";
import { readSearchEngines, writeSearchEngines, SearchEngineSchema, type SearchEngine } from "../storage.js";
import { recordAutoPullOk, recordVerifyKey } from "../whoami.js";

const enginesPath = `${config.configDir}/search-engines.json`;

async function enginesMtime(): Promise<Date> {
  try {
    const st = await stat(enginesPath);
    return st.mtime;
  } catch {
    return new Date(0);
  }
}

export const connector = new Hono();

// GET /api/connector/config — read search-engines.json (UI uses this)
connector.get("/api/connector/config", async (c) => {
  const engines = await readSearchEngines();
  return c.json({ searchEngines: engines });
});

// PUT /api/connector/config — write search-engines.json (UI uses this)
// Returns:
//   200 { success: true }                            — saved cleanly
//   400 { error: "invalid_input", invalid: [...] }   — at least one row failed Zod validation.
//                                                     `invalid` is an array of:
//                                                       { index: number, id: string | null,
//                                                         field?: string, message: string }
//   400 { error: "invalid_input", message }          — body itself was malformed (not JSON,
//                                                     missing searchEngines, etc.)
connector.put("/api/connector/config", async (c) => {
  let body: { searchEngines?: SearchEngine[] };
  try {
    body = (await c.req.json()) as { searchEngines?: SearchEngine[] };
  } catch {
    return c.json({ error: "invalid_input", message: "Expected JSON body." }, 400);
  }
  if (!Array.isArray(body?.searchEngines)) {
    return c.json({ error: "invalid_input", message: "`searchEngines` must be an array." }, 400);
  }
  const invalid: Array<{ index: number; id: string | null; field?: string; message: string }> = [];
  for (let i = 0; i < body.searchEngines.length; i++) {
    const e = body.searchEngines[i];
    const parsed = SearchEngineSchema.safeParse(e);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        invalid.push({
          index: i,
          id: typeof e?.id === "string" ? e.id : null,
          field: issue.path.join(".") || undefined,
          message: issue.message,
        });
      }
    }
  }
  if (invalid.length) {
    return c.json({ error: "invalid_input", message: "One or more engines are invalid.", invalid }, 400);
  }
  try {
    await writeSearchEngines(body.searchEngines);
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: "invalid_input", message: (e as Error).message }, 400);
  }
});

// GET /api/connector/config/auto — toolconnector's authoritative pull (open mode: any bearer)
connector.get("/api/connector/config/auto", async (c) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return c.json({ error: "unauthorized" }, 401);

  // Treat the auto-pull itself as a verify-key success (toolpanel's open mode),
  // so the panel can render "connected" right after this call.
  void recordVerifyKey(true, bearer);

  const mtime = await enginesMtime();
  const since = c.req.header("If-Modified-Since");
  if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime()) && Math.floor(sinceDate.getTime() / 1000) >= Math.floor(mtime.getTime() / 1000)) {
      void recordAutoPullOk(true, 0); // count not known on 304; updated next 200
      return new Response(null, { status: 304, headers: { "Last-Modified": mtime.toUTCString() } });
    }
  }
  const engines = await readSearchEngines();
  void recordAutoPullOk(true, engines.length);
  return c.json({ searchEngines: engines }, 200, { "Last-Modified": mtime.toUTCString() });
});
