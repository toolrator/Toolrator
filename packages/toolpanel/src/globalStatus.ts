import { config } from "./config.js";
import { getWhoami } from "./whoami.js";
import { upstreamHealth } from "./lib/http.js";
import { summarizeToolconnector, type GlobalStatus } from "./views/layout.js";

// Build a {GlobalStatus} for the global status bar. Single-shot — the bar is
// server-rendered and updates only on F5 (no browser polling, per product call).
export async function buildGlobalStatus(): Promise<GlobalStatus> {
  const [whoami, upstream] = await Promise.all([getWhoami(), upstreamHealth()]);
  return {
    searchEngine: {
      reachable: upstream.ok,
      backend: upstream.backend ?? null,
      documentCount: upstream.documentCount ?? null,
      baseUrl: config.searchEngineBaseUrl,
    },
    toolconnector: summarizeToolconnector({
      state: whoami.state,
      lastVerifyKeyAt: whoami.lastVerifyKeyAt,
      lastErrorAt: whoami.lastErrorAt,
      lastErrorReason: whoami.lastErrorReason,
      verifyKeyCount: whoami.verifyKeyCount,
      firstSeenAt: whoami.firstSeenAt,
      bearerPrefix: whoami.bearerPrefix,
    }),
  };
}
