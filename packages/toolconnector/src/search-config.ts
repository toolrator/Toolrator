import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AUTH_URL, DEFAULT_ENGINE_ID } from "./config.js";

// ---------------------------------------------------------------------------
// Schemas and Types
// ---------------------------------------------------------------------------

export const SearchEngineConfigSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric and dashes only")
      .max(64),
    label: z.string().max(80),
    transport: z.enum(["http", "mcp-http", "mcp-sse", "mcp-stdio"]),
    endpoint: z.string(),
    args: z.array(z.string()).optional(),
    schemaUrl: z.string().url().optional(),
    auth: z
      .object({
        type: z.enum(["bearer", "basic", "header"]),
        tokenEnv: z.string().optional(),
        headerName: z.string().optional(),
      })
      .optional(),
    notes: z
      .string()
      .max(500)
      .transform((val) => val.trim())
      .optional(),
    timeoutMs: z.number().default(10000),
    enabled: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    // transport = mcp-stdio requirements
    if (data.transport === "mcp-stdio" && !data.args) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "args is required when transport is 'mcp-stdio'",
        path: ["args"],
      });
    }

    // auth requirements
    if (data.auth) {
      if (data.auth.type === "header" && !data.auth.headerName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "headerName is required when auth type is 'header'",
          path: ["auth", "headerName"],
        });
      }
    }
  });

export type SearchEngineConfig = z.infer<typeof SearchEngineConfigSchema>;

export interface EffectiveSearchConfig {
  engines: ReadonlyArray<SearchEngineConfig>;
  source: "env" | "file" | "default" | "remote" | "remote:toolpanel";
}

// ---------------------------------------------------------------------------
// Resolution & Loading
// ---------------------------------------------------------------------------

export function loadSearchConfig(
  env: Record<string, string | undefined>,
  configDir: string,
  defaultEndpointUrl?: string,
): EffectiveSearchConfig {
  let source: EffectiveSearchConfig["source"] = "default";
  let rawEngines: unknown[] = [];

  const envConfigPath = env.CONNECTOR_SEARCH_CONFIG;
  const fileConfigPath = join(configDir, "search-engines.json");

  // 1. Try env variable config path
  if (envConfigPath && envConfigPath.trim() !== "") {
    const trimmedPath = envConfigPath.trim();
    if (existsSync(trimmedPath)) {
      try {
        const raw = readFileSync(trimmedPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          rawEngines = parsed;
          source = "env";
        }
      } catch (err) {
        console.error(`[toolconnector:warn] Failed to read/parse config from env path "${trimmedPath}": ${String(err)}`);
      }
    } else {
      console.error(`[toolconnector:warn] Config path in CONNECTOR_SEARCH_CONFIG "${trimmedPath}" does not exist.`);
    }
  }

  // 2. Try default config directory path
  if (source === "default" && existsSync(fileConfigPath)) {
    try {
      const raw = readFileSync(fileConfigPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        rawEngines = parsed;
        source = "file";
      }
    } catch (err) {
      console.error(`[toolconnector:warn] Failed to read/parse config from default path "${fileConfigPath}": ${String(err)}`);
    }
  }

  // 3. Fall back to implicit default engine
  if (source === "default" && rawEngines.length === 0) {
    // The implicit default engine's endpoint must align with whichever upstream
    // the connector actually decided to use at runtime. That decision is made
    // asynchronously by `pickRemoteBaseUrl()` in index.ts, which probes
    // TOOLPANEL_URL, falls back to CONNECTOR_UPSTREAM_URL, etc. The caller
    // passes the already-resolved URL in as `defaultEndpointUrl`; we accept it
    // as the authoritative answer and do NOT re-derive it from the env vars
    // here.
    //
    // When `defaultEndpointUrl` is provided, it has higher precedence than
    // the raw env-var chain. We still keep the env-var chain as a sync
    // fallback for unit tests that load the resolver directly.
    const fallback = (defaultEndpointUrl
      || env.TOOLPANEL_URL
      || env.CONNECTOR_UPSTREAM_URL
      || DEFAULT_AUTH_URL).trim().replace(/\/+$/, "");
    rawEngines = [
      {
        id: DEFAULT_ENGINE_ID,
        label: `Default (${fallback})`,
        transport: "http",
        endpoint: fallback,
        schemaUrl: `${fallback}/api/search/schema`,
        enabled: true,
      },
    ];
  }

  // Parse and validate engines
  const validatedEngines = validateSearchEngines(rawEngines, env);

  return {
    engines: Object.freeze(validatedEngines),
    source,
  };
}

/**
 * Validates and de-duplicates a raw engine list. Shared by the local-file
 * resolver and the remote (CONNECTOR_UPSTREAM_URL) resolver so both produce
 * the same shape. Returns an empty array if `raw` is not an array.
 */
export function validateSearchEngines(
  raw: unknown,
  env: Record<string, string | undefined> = {},
): SearchEngineConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const validated: SearchEngineConfig[] = [];
  const seenIds = new Set<string>();

  for (const rawEng of raw) {
    const result = SearchEngineConfigSchema.safeParse(rawEng);
    if (!result.success) {
      console.error(`[toolconnector:warn] Skipping invalid engine config: ${JSON.stringify(rawEng)}. Errors: ${result.error.message}`);
      continue;
    }

    const engine = result.data;
    if (seenIds.has(engine.id)) {
      console.error(`[toolconnector:warn] Skipping duplicate engine ID: ${engine.id}`);
      continue;
    }
    seenIds.add(engine.id);

    // Resolve env value for auth token if present
    if (engine.auth && engine.auth.tokenEnv) {
      const tokenValue = env[engine.auth.tokenEnv];
      if (!tokenValue) {
        console.error(`[toolconnector:warn] Engine "${engine.id}" references tokenEnv "${engine.auth.tokenEnv}" but it is not set in environment.`);
      }
    }

    validated.push(engine);
  }

  return validated;
}
