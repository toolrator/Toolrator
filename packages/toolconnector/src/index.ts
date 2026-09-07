#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig, Logger, shouldAutoProbePanel, TOOLCONNECTOR_VERSION, TOOLPANEL_PROBE_PATH, TOOLPANEL_PROBE_TIMEOUT_MS, type ToolconnectorConfig } from "./config.js";
import { ConnectorStateManager, schemaTimestamps } from "./state.js";
import { AuthClient } from "./auth-client.js";
import { ExternalMcpClient } from "./external-client.js";
import { registerAllTools } from "./tools.js";
import {
  loadSearchConfig,
  validateSearchEngines,
  type EffectiveSearchConfig,
  type SearchEngineConfig,
} from "./search-config.js";
import { createSearchEngine } from "./search-engine.js";
import { SearchRegistry } from "./search-registry.js";
import {
  DEFAULT_SCHEMA,
  fetchAndCacheSchema,
  startSchemaRefreshLoop,
} from "./schema-cache.js";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

async function main(): Promise<void> {
  // 1. Load configuration
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  logger.info("Toolconnector starting...");
  logger.debug(`Auth URL: ${config.authUrl}`);
  logger.debug(`Config dir: ${config.configDir}`);

  // 2. Initialize state machine
  const stateManager = new ConnectorStateManager(logger);
  await stateManager.init(config.configDir, config.apiKey);

  const registry = new SearchRegistry();
  // Compute the resolved default base URL up front so the implicit default
  // engine in `loadSearchConfig` (used when no engines come from any source)
  // points at the same upstream that the rest of the connector will use.
  // Also feeds the AuthClient's pinned upstream so that device-flow start /
  // poll / verify-key all go to toolpanel when it's alive.
  // Falls back to the configured authUrl when nothing is reachable.
  const initialDecision = await pickRemoteBaseUrl(config, logger, "");
  const resolvedDefaultBaseUrl = initialDecision?.baseUrl ?? config.authUrl;

  // 3. Create HTTP clients — AuthClient is pinned to the resolved URL so the
  // user-facing auth flow (device start / poll / verify-key) targets the
  // same upstream as the search-config pulls. Without this, calling
  // `start_device_flow` would hit `CONNECTOR_UPSTREAM_URL` even when toolpanel
  // is the live, locally-launched provider.
  const authClient = new AuthClient(resolvedDefaultBaseUrl, config.authUrl, logger);
  const externalClient = new ExternalMcpClient(logger);

  // Set API key on auth client if we're starting authenticated
  const initialState = stateManager.getState();
  if (initialState.apiKey) {
    authClient.setApiKey(initialState.apiKey);
  }

  //
  // Precedence:
  //   mode = "toolpanel" (or "auto" with TOOLPANEL_URL set + reachable):
  //     1. Server config from TOOLPANEL_URL  (authoritative; empty list is honored)
  //     2. Local search-engines.json          (fallback: unauthenticated / fetch fails)
  //     3. Implicit default ${product}-default engine (endpoint = TOOLPANEL_URL | CONNECTOR_UPSTREAM_URL)
  //   mode = "auto" (no TOOLPANEL_URL or toolpanel unreachable):
  //     1. Server config from CONNECTOR_UPSTREAM_URL   (authoritative)
  //     2. Local search-engines.json                   (fallback)
  //     3. Implicit default ${product}-default engine
  //   Unauthenticated (or mode "file"):
  //     1. search-engines.json / CONNECTOR_SEARCH_CONFIG
  //     2. default ${product}-default engine (endpoint = TOOLPANEL_URL | CONNECTOR_UPSTREAM_URL)

  let searchConfig = loadSearchConfig(process.env, config.configDir, resolvedDefaultBaseUrl);
  let currentEngines = await applySearchConfig(searchConfig, registry, config, logger);

  const searchConfigState = {
    autoPullSucceeded: false,
    lastVerifiedAt: await getCredentialsSavedAt(config.configDir),
    authUrl: config.authUrl,
    toolpanelUrl: config.toolpanelUrl,
    source: searchConfig.source,
    resolvedBaseUrl: resolvedDefaultBaseUrl,
  };

  // When authenticated + (auto OR toolpanel) mode, the server config is authoritative.
  if (config.searchConfigMode !== "file" && initialState.apiKey) {
    const remote = await pullRemoteConfig(initialState.apiKey, config, stateManager, logger);
    if (remote) {
      currentEngines = await applySearchConfig(remote, registry, config, logger);
      searchConfig = remote;
      searchConfigState.autoPullSucceeded = true;
      searchConfigState.source = remote.source;
      searchConfigState.resolvedBaseUrl =
        remote.source === "remote:toolpanel" ? config.toolpanelUrl : config.authUrl;
      // Repin the auth client to the resolved upstream so device flow traffic
      // (start, poll, verify-key) targets the same backend.
      authClient.setUpstream(searchConfigState.resolvedBaseUrl);
    }
    // else: keep the local-file fallback already applied above
  }

  // Keep the schema refresh loop pointed at the engines currently in use.
  let activeRefreshLoop = startSchemaRefreshLoop(
    currentEngines.map((e) => ({ id: e.id, schemaUrl: e.schemaUrl })),
    config.configDir,
    logger,
  );
  function restartRefreshLoop(): void {
    clearInterval(activeRefreshLoop);
    activeRefreshLoop = startSchemaRefreshLoop(
      currentEngines.map((e) => ({ id: e.id, schemaUrl: e.schemaUrl })),
      config.configDir,
      logger,
    );
  }

  // Re-resolve the search config whenever the auth state changes:
  // authenticated → always pull from the resolved upstream; otherwise fall back
  // to the local file. The auth client is repinned to the same resolved URL
  // so subsequent device-flow start / poll / verify-key calls track the same
  // upstream as the search-config pulls.
  let resolving = false;
  async function reresolveSearchConfig(apiKey?: string): Promise<boolean> {
    if (resolving) return false;
    resolving = true;
    try {
      if (config.searchConfigMode !== "file" && apiKey) {
        const remote = await pullRemoteConfig(apiKey, config, stateManager, logger);
        if (remote) {
          const configChanged = !isDeepStrictEqual(searchConfig, remote);
          currentEngines = await applySearchConfig(remote, registry, config, logger);
          searchConfig = remote;
          searchConfigState.autoPullSucceeded = true;
          searchConfigState.source = remote.source;
          searchConfigState.resolvedBaseUrl =
            remote.source === "remote:toolpanel" ? config.toolpanelUrl : config.authUrl;
          // Repin the auth client to the same upstream so device flow stays
          // consistent with the search-config traffic.
          authClient.setUpstream(searchConfigState.resolvedBaseUrl);

          if (configChanged) {
            updateSearchTool?.();
            server.sendToolListChanged();
          }

          restartRefreshLoop();
          return true;
        }
      }
      // Unauthenticated, or remote fetch failed → local file fallback.
      // Use a freshly-probed base URL so the implicit default engine and the
      // auth client both track the current toolpanel reachability.
      const decision = await pickRemoteBaseUrl(config, logger, "");
      const fallbackBaseUrl = decision?.baseUrl ?? config.authUrl;
      const local = loadSearchConfig(process.env, config.configDir, fallbackBaseUrl);
      const configChanged = !isDeepStrictEqual(searchConfig, local);
      currentEngines = await applySearchConfig(local, registry, config, logger);
      searchConfig = local;
      searchConfigState.autoPullSucceeded = false;
      searchConfigState.resolvedBaseUrl = fallbackBaseUrl;
      authClient.setUpstream(fallbackBaseUrl);
      
      if (configChanged) {
        updateSearchTool?.();
        server.sendToolListChanged();
      }
      
      restartRefreshLoop();
      return false;
    } finally {
      resolving = false;
    }
  }

  // 4. Create MCP server
  const server = new McpServer(
    {
      name: "toolconnector",
      version: TOOLCONNECTOR_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    },
  );

  // 5. Register all tools
  const { updateSearchTool } = registerAllTools(
    server,
    stateManager,
    registry,
    authClient,
    externalClient,
    config.configDir,
    logger,
    searchConfigState,
    reresolveSearchConfig,
  );

  // 6. Wire state changes to notifications/tools/list_changed
  let lastAuthKey = initialState.apiKey || null;
  stateManager.onStateChange(() => {
    logger.debug("Auth state changed, sending tools/list_changed notification");
    const state = stateManager.getState();
    if (state.apiKey) {
      authClient.setApiKey(state.apiKey);
    } else {
      authClient.clearApiKey();
    }

    // Re-resolve search config only when the auth key actually changes:
    // authenticated → pull from CONNECTOR_UPSTREAM_URL; otherwise use local file.
    const currentKey = state.apiKey || null;
    if (currentKey !== lastAuthKey) {
      lastAuthKey = currentKey;
      void reresolveSearchConfig(currentKey ?? undefined);
    }
    server.sendToolListChanged();
  });

  // 7. Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Track when the client requests the tools list
  const originalOnMessage = transport.onmessage;
  if (originalOnMessage) {
    transport.onmessage = (msg) => {
      if (msg && typeof msg === "object" && "method" in msg && msg.method === "tools/list") {
        schemaTimestamps.lastFetched = Date.now();
      }
      originalOnMessage.call(transport, msg);
    };
  }


  logger.info("Toolconnector connected and ready (stdio)");

  // Clean up timer on exit
  process.on("exit", () => {
    clearInterval(activeRefreshLoop);
  });
}

main().catch((err) => {
  console.error("[toolconnector:fatal]", err);
  process.exit(1);
});

// ── Boot helper functions ──

async function getCredentialsSavedAt(configDir: string): Promise<string | undefined> {
  try {
    const s = await stat(join(configDir, "credentials.json"));
    return s.mtime.toLocaleString();
  } catch {
    return undefined;
  }
}

async function persistSearchEnginesJson(configDir: string, engines: unknown[]): Promise<void> {
  await writeFile(join(configDir, "search-engines.json"), JSON.stringify(engines, null, 2), "utf-8");
}

/**
 * Builds (or rebuilds, in place) the search registry from an effective config.
 * Mutates `registry` directly rather than replacing it, because tool handlers
 * hold a reference to the same instance.
 */
async function applySearchConfig(
  cfg: EffectiveSearchConfig,
  registry: SearchRegistry,
  config: ToolconnectorConfig,
  logger: Logger,
): Promise<SearchEngineConfig[]> {
  const engineSchemas = await Promise.all(
    cfg.engines.map(async (c) => {
      if (!c.schemaUrl) {
        return DEFAULT_SCHEMA;
      }
      return fetchAndCacheSchema(c.id, c.schemaUrl, config.configDir, logger);
    })
  );

  await registry.closeAll();
  registry.clear();
  for (let i = 0; i < cfg.engines.length; i++) {
    const c = cfg.engines[i];
    if (c.enabled !== false) {
      registry.register(createSearchEngine(c, engineSchemas[i], logger));
    }
  }

  return cfg.engines as SearchEngineConfig[];
}

/**
 * Fetches the authoritative search-engine config for an authenticated user.
 *
 * Resolution order:
 *   1. When `searchConfigMode === "toolpanel"` or
 *      (mode === "auto" AND TOOLPANEL_URL is set AND the toolpanel is reachable),
 *      the toolpanel at `${config.toolpanelUrl}` is the authoritative source.
 *   2. Otherwise (and in `auto` mode without toolpanel), the upstream at
 *      `${config.authUrl}` (CONNECTOR_UPSTREAM_URL) is the authoritative source.
 *
 * Resolution order (driven by `pickRemoteBaseUrl`):
 *   1. mode `toolpanel` or `auto` with toolpanel alive → toolpanel URL
 *   2. mode `toolpanel` with toolpanel unreachable → returns null (do not
 *      fall back; the mode strictly requires toolpanel)
 *   3. mode `auto` with toolpanel unreachable → configured authUrl
 *   4. failure → caller uses the local search-engines.json fallback
 *
 * The toolpanel liveness probe is `GET ${toolpanelUrl}${TOOLPANEL_PROBE_PATH}`
 * (a well-known 204 endpoint). Probe timeout: `TOOLPANEL_PROBE_TIMEOUT_MS`.
 */

/**
 * Verify-key retry policy. A transient upstream 401 must not log the user
 * out and wipe stored credentials; only a consistently-401 key (all
 * `VERIFY_KEY_MAX_RETRIES + 1` attempts, with linear backoff) is treated as
 * genuinely invalid.
 */
const VERIFY_KEY_MAX_RETRIES = 2;
const VERIFY_KEY_RETRY_DELAY_MS = 400;

async function pullRemoteConfig(
  apiKey: string,
  config: ToolconnectorConfig,
  stateManager: ConnectorStateManager,
  logger: Logger,
): Promise<EffectiveSearchConfig | null> {
  // Decide which upstream to use.
  const decision = await pickRemoteBaseUrl(config, logger, apiKey);
  if (!decision) return null;
  const { baseUrl, source } = decision;

  try {
    // Verify-key with retry/backoff: transient upstream flakiness (a single
    // 401 from a hiccuping proxy/control plane) must NOT nuke stored
    // credentials. Only a consistently-401 key (all attempts) triggers logout.
    let verifyResult: Response | null = null;
    for (let attempt = 0; attempt <= VERIFY_KEY_MAX_RETRIES; attempt++) {
      logger.debug(`verify-key → ${baseUrl}/api/auth/verify-key (attempt ${attempt + 1}/${VERIFY_KEY_MAX_RETRIES + 1})`);
      verifyResult = await fetch(`${baseUrl}/api/auth/verify-key`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2000),
      });
      if (verifyResult.status !== 401 || attempt === VERIFY_KEY_MAX_RETRIES) break;
      const backoffMs = VERIFY_KEY_RETRY_DELAY_MS * (attempt + 1);
      logger.warn(`verify-key returned 401 (attempt ${attempt + 1}); retrying in ${backoffMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    if (!verifyResult || !verifyResult.ok) {
      if (verifyResult?.status === 401) {
        // API key invalid — clear stored credentials
        await stateManager.logout(config.configDir);
        logger.info(`Stored API key no longer valid against ${baseUrl} (${VERIFY_KEY_MAX_RETRIES + 1} consecutive 401s); logged out.`);
      }
      return null;
    }

    const autoResp = await fetch(`${baseUrl}/api/connector/config/auto`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(3000),
    });

    if (autoResp.status !== 200) {
      // 304 (not modified) or any non-OK → caller uses its local cache/fallback
      return null;
    }

    const data = (await autoResp.json()) as { searchEngines?: unknown };
    const engines = validateSearchEngines(data.searchEngines ?? [], process.env);

    // Persist as a cache for the unauthenticated / offline fallback path,
    // even when the server returned zero engines — that's the authoritative
    // view of the upstream and the connector should respect it.
    await persistSearchEnginesJson(config.configDir, engines);

    if (engines.length === 0) {
      logger.warn(`Server at ${baseUrl} returned no valid search engines; keeping the (empty) cache.`);
    }

    return { engines, source };
  } catch (e) {
    logger.warn(`Remote search config pull failed against ${baseUrl}: ${String(e)}`);
    return null;
  }
}

/**
 * Pick the URL to use for verify-key + auto-pull, honouring the configured
 * `searchConfigMode` and (when enabled) the toolpanel liveness probe.
 *
 * Returns `{ baseUrl, source }` — baseUrl is the URL to call, source is the
 * provenance tag stored alongside the resulting search-engine list.
 * Returns `null` only when mode is `toolpanel` AND toolpanel is unreachable,
 * which signals "do not retry this run; surface the error to the caller".
 */
async function pickRemoteBaseUrl(
  config: ToolconnectorConfig,
  logger: Logger,
  _apiKey: string,
): Promise<{ baseUrl: string; source: EffectiveSearchConfig["source"] } | null> {
  const toolpanelUrl = config.toolpanelUrl;
  const authUrl = config.authUrl;
  const mode = config.searchConfigMode;

  logger.debug(
    `pickRemoteBaseUrl: toolpanelUrl="${toolpanelUrl || "<unset>"}" mode=${mode} discovery=${config.toolpanelDiscovery} authUrl=${authUrl}`,
  );

  if (!toolpanelUrl || toolpanelUrl.trim() === "") {
    return { baseUrl: authUrl, source: "remote" };
  }

  if (mode === "toolpanel") {
    const alive = await isToolpanelAlive(toolpanelUrl, logger);
    if (!alive) {
      logger.warn(
        `TOOLPANEL_URL=${toolpanelUrl} unreachable at ${TOOLPANEL_PROBE_PATH}; mode=toolpanel requires it, leaving search engines from the local file/empty cache.`,
      );
      return null;
    }
    logger.debug(`Pulling remote config from toolpanel at ${toolpanelUrl}`);
    return { baseUrl: toolpanelUrl, source: "remote:toolpanel" };
  }

  // mode === "auto"
  if (shouldAutoProbePanel(config)) {
    const alive = await isToolpanelAlive(toolpanelUrl, logger);
    if (alive) {
      logger.debug(`Pulling remote config from toolpanel at ${toolpanelUrl} (preferred over ${authUrl})`);
      return { baseUrl: toolpanelUrl, source: "remote:toolpanel" };
    }
    logger.debug(`Toolpanel at ${toolpanelUrl} not reachable; using ${authUrl} (per mode=auto).`);
    return { baseUrl: authUrl, source: "remote" };
  }

  return { baseUrl: authUrl, source: "remote" };
}

/**
 * Lightweight liveness probe for a local toolpanel instance.
 *
 * Hits `${toolpanelUrl}${TOOLPANEL_PROBE_PATH}` with a `GET`. Toolpanel's
 * well-known endpoint always returns 204 No Content (no auth required). Any
 * 2xx response is treated as "alive". Genuine failures (timeout, DNS error,
 * connection refused, non-2xx status) return `false`.
 *
 * Probe times out after `TOOLPANEL_PROBE_TIMEOUT_MS`. Never throws.
 */
async function isToolpanelAlive(toolpanelUrl: string, logger: Logger): Promise<boolean> {
  const url = `${toolpanelUrl}${TOOLPANEL_PROBE_PATH}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOOLPANEL_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
    });
    return res.status >= 200 && res.status < 300;
  } catch (e) {
    logger.debug(`Toolpanel liveness probe failed for ${url}: ${String(e)}`);
    return false;
  } finally {
    clearTimeout(t);
  }
}


