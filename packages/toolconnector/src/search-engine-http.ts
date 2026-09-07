import type { SearchEngine } from "./search-engine.js";
import type { SearchEngineConfig } from "./search-config.js";
import { DEFAULT_ENGINE_ID, type Logger } from "./config.js";
import type { EngineSchema } from "./schema-cache.js";

export class HttpSearchEngine implements SearchEngine {
  readonly id: string;
  readonly label: string;
  readonly notes?: string;
  readonly schema: EngineSchema;
  private readonly config: SearchEngineConfig;
  private readonly logger: Logger;

  constructor(config: SearchEngineConfig, schema: EngineSchema, logger: Logger) {
    this.id = config.id;
    this.label = config.label;
    this.notes = config.notes;
    this.schema = schema;
    this.config = config;
    this.logger = logger;
  }

  async search(args: Record<string, unknown>): Promise<unknown> {
    const timeoutMs = this.config.timeoutMs ?? 10000;

    // Special GET adapter for the implicit default search engine. Keeps the
    // legacy GET `/api/search?q=...&limit=...&offset=...` contract that the
    // default upstream serves out of the box (matches toolpanel's
    // `/api/search` and the configured upstream's `/api/search`).
    if (this.id === DEFAULT_ENGINE_ID || this.id === "toolhub-default") {
      const query = String(args.query || "");
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const offset = typeof args.offset === "number" ? args.offset : 0;
      const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
      const base = this.config.endpoint.replace(/\/+$/, "").replace(/\/api\/search$/, "");
      const url = `${base}/api/search?${params.toString()}`;

      const headers = this.getAuthHeaders();
      headers["Accept"] = "application/json";

      this.logger.debug(`HTTP Search Engine [${this.id}] legacy GET requesting: ${url}`);

      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP search request failed with status ${response.status}: ${text}`);
        }

        return await response.json();
      } finally {
        clearTimeout(id);
      }
    }

    // Generic POST pass-through for all other custom engines
    const url = this.config.endpoint;
    const headers = this.getAuthHeaders();
    headers["Accept"] = "application/json";
    headers["Content-Type"] = "application/json";

    this.logger.debug(`HTTP Search Engine [${this.id}] POST requesting: ${url} with args ${JSON.stringify(args)}`);

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP search request failed with status ${response.status}: ${text}`);
      }

      return await response.json();
    } finally {
      clearTimeout(id);
    }
  }

  async close(): Promise<void> {
    // Stateless
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.auth) {
      const envName = this.config.auth.tokenEnv;
      const token = envName ? process.env[envName] : undefined;
      if (!token) {
        this.logger.warn(`Search engine "${this.id}" auth is configured, but environment variable "${envName || ""}" is empty.`);
      } else {
        if (this.config.auth.type === "bearer") {
          headers["Authorization"] = `Bearer ${token}`;
        } else if (this.config.auth.type === "basic") {
          headers["Authorization"] = `Basic ${Buffer.from(token).toString("base64")}`;
        } else if (this.config.auth.type === "header" && this.config.auth.headerName) {
          headers[this.config.auth.headerName] = token;
        }
      }
    }
    return headers;
  }
}
