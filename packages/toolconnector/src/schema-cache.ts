import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ENGINE_ID, type Logger } from "./config.js";

export interface EngineSchema {
  inputSchema: Record<string, unknown>;
  outputDescription?: string;
}

interface CacheEnvelope {
  schema: EngineSchema;
  _cachedAt: number;
}

// Default hardcoded schema for the implicit default search engine (see
// `DEFAULT_ENGINE_ID` in `config.ts`). Used as a last-resort fallback when
// the engine's schemaUrl is unreachable AND no cached schema exists.
export const DEFAULT_SCHEMA: EngineSchema = {
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query (e.g., 'send an email', 'get stock price')",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default 10)",
      },
      offset: {
        type: "number",
        description: "Offset for pagination (default 0)",
      },
    },
    required: ["query"],
  },
  outputDescription: "Returns standard search results with tool metadata, schemas, and provider info.",
};

// Fallback schema for any custom engine if we fail to load its schema from schemaUrl
export const FALLBACK_SCHEMA: EngineSchema = {
  inputSchema: {
    type: "object",
    properties: {
      arguments: {
        type: "object",
        description: "Generic engine arguments",
      },
    },
  },
  outputDescription: "Returns search results from the custom index.",
};

function getCachePath(configDir: string, engineId: string): string {
  return join(configDir, "schemas", `${engineId}.json`);
}

export async function fetchAndCacheSchema(
  engineId: string,
  schemaUrl: string,
  configDir: string,
  logger: Logger,
  timeoutMs = 5000,
): Promise<EngineSchema> {
  const cachePath = getCachePath(configDir, engineId);

  // Attempt live fetch
  try {
    logger.debug(`Fetching schema for engine "${engineId}" from URL: ${schemaUrl}`);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(schemaUrl, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(id);

    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object" || !data.inputSchema) {
      throw new Error("Invalid schema response format: missing inputSchema property");
    }

    const engineSchema: EngineSchema = {
      inputSchema: data.inputSchema,
      outputDescription: data.outputDescription || undefined,
    };

    // Save to cache
    try {
      const cacheDir = join(configDir, "schemas");
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }
      const envelope: CacheEnvelope = {
        schema: engineSchema,
        _cachedAt: Date.now(),
      };
      writeFileSync(cachePath, JSON.stringify(envelope, null, 2), "utf-8");
      logger.debug(`Cached schema for engine "${engineId}" successfully.`);
    } catch (cacheErr) {
      logger.warn(`Failed to write schema cache for engine "${engineId}": ${String(cacheErr)}`);
    }

    return engineSchema;
  } catch (err) {
    logger.warn(`Failed to fetch schema for engine "${engineId}" from URL "${schemaUrl}": ${String(err)}. Attempting to read cache.`);
    
    // Read cache fallback
    const cached = loadCachedSchema(engineId, configDir);
    if (cached) {
      logger.info(`Using cached schema for engine "${engineId}".`);
      return cached;
    }

    logger.error(`No cached schema available for engine "${engineId}". Falling back to default/generic schema.`);
    if (engineId === DEFAULT_ENGINE_ID) {
      return DEFAULT_SCHEMA;
    }
    return FALLBACK_SCHEMA;
  }
}

export function loadCachedSchema(engineId: string, configDir: string): EngineSchema | null {
  const cachePath = getCachePath(configDir, engineId);
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const envelope = JSON.parse(raw) as CacheEnvelope;
    if (envelope && envelope.schema && typeof envelope.schema === "object") {
      return envelope.schema;
    }
  } catch {
    // ignore parsing errors and return null
  }
  return null;
}

export function startSchemaRefreshLoop(
  engines: Array<{ id: string; schemaUrl?: string }>,
  configDir: string,
  logger: Logger,
  intervalMs = 6 * 60 * 60 * 1000, // default 6 hours
): NodeJS.Timeout {
  return setInterval(async () => {
    logger.debug("Background schema refresh loop triggered.");
    for (const engine of engines) {
      if (engine.schemaUrl) {
        try {
          await fetchAndCacheSchema(engine.id, engine.schemaUrl, configDir, logger);
        } catch (err) {
          logger.warn(`Background schema refresh failed for engine "${engine.id}": ${String(err)}`);
        }
      }
    }
  }, intervalMs);
}
