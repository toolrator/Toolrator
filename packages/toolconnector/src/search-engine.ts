import type { SearchEngineConfig } from "./search-config.js";
import type { Logger } from "./config.js";
import type { EngineSchema } from "./schema-cache.js";
import { HttpSearchEngine } from "./search-engine-http.js";
import { McpSearchEngine } from "./search-engine-mcp.js";

export interface SearchEngine {
  readonly id: string;
  readonly label: string;
  readonly notes?: string;
  readonly schema: EngineSchema;
  search(args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export function createSearchEngine(
  config: SearchEngineConfig,
  schema: EngineSchema,
  logger: Logger,
): SearchEngine {
  return config.transport === "http"
    ? new HttpSearchEngine(config, schema, logger)
    : new McpSearchEngine(config, schema, logger);
}
