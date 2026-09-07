import { Hono } from "hono";
import { config } from "../config.js";
import { getWhoami } from "../whoami.js";
import { upstreamHealth } from "../lib/http.js";

export const status = new Hono();

// GET /api/status — overall toolpanel status, used by the landing page
// (already server-rendered, but available for any future client island).
status.get("/api/status", async (c) => {
  const [whoami, upstream] = await Promise.all([getWhoami(), upstreamHealth()]);
  return c.json({
    toolpanel: {
      publicUrl: config.publicUrl,
      apiKeyConfigured: config.apiKey.trim() !== "",
    },
    toolconnector: {
      state: whoami.state,
      connected: whoami.connected,
      firstSeenAt: whoami.firstSeenAt,
      lastSeenAt: whoami.lastSeenAt,
      lastVerifyKeyAt: whoami.lastVerifyKeyAt,
      lastVerifyKeyOk: whoami.lastVerifyKeyOk,
      lastAutoPullAt: whoami.lastAutoPullAt,
      lastAutoPullOk: whoami.lastAutoPullOk,
      lastEngineCount: whoami.lastEngineCount,
      verifyKeyCount: whoami.verifyKeyCount,
      bearerPrefix: whoami.bearerPrefix,
      lastErrorReason: whoami.lastErrorReason,
      lastErrorAt: whoami.lastErrorAt,
    },
    searchEngine: {
      reachable: upstream.ok,
      backend: upstream.backend,
      documentCount: upstream.documentCount,
      baseUrl: config.searchEngineBaseUrl,
    },
  }, 200, { "Cache-Control": "no-store" });
});
