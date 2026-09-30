import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { connectMcpClient, type ConnectedMcpClient } from "./mcp-client.js";
import { DEFAULT_ENGINE_ID, TOOLCONNECTOR_VERSION, type Logger } from "./config.js";
import type { SearchEngineConfig } from "./search-config.js";
import type { EngineSchema } from "./schema-cache.js";

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


export class McpSearchEngine implements SearchEngine {
  readonly id: string;
  readonly label: string;
  readonly notes?: string;
  readonly schema: EngineSchema;
  private readonly config: SearchEngineConfig;
  private readonly logger: Logger;
  private clientInstance: Client | null = null;
  private connectedClient: ConnectedMcpClient | null = null;
  private stdioTransport: StdioClientTransport | null = null;
  private isConnecting = false;

  constructor(config: SearchEngineConfig, schema: EngineSchema, logger: Logger) {
    this.id = config.id;
    this.label = config.label;
    this.notes = config.notes;
    this.schema = schema;
    this.config = config;
    this.logger = logger;
  }

  private async ensureConnected(): Promise<Client> {
    if (this.clientInstance) {
      return this.clientInstance;
    }

    if (this.isConnecting) {
      while (this.isConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.clientInstance) {
        return this.clientInstance;
      }
    }

    this.isConnecting = true;
    try {
      if (this.config.transport === "mcp-stdio") {
        this.logger.debug(`Search Engine [${this.id}] spawning stdio: ${this.config.endpoint} with args ${JSON.stringify(this.config.args || [])}`);

        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) {
            env[k] = v;
          }
        }
        if (this.config.auth && this.config.auth.tokenEnv) {
          const tokenValue = process.env[this.config.auth.tokenEnv];
          if (tokenValue) {
            env[this.config.auth.tokenEnv] = tokenValue;
          }
        }

        this.stdioTransport = new StdioClientTransport({
          command: this.config.endpoint,
          args: this.config.args || [],
          env,
        });

        const client = new Client(
          { name: "toolconnector-search-mcp", version: TOOLCONNECTOR_VERSION },
          { capabilities: {} }
        );

        await client.connect(this.stdioTransport);
        this.clientInstance = client;
        this.logger.info(`Search Engine [${this.id}] connected via stdio`);
        return client;
      } else {
        const headers: Record<string, string> = {};
        if (this.config.auth && this.config.auth.tokenEnv) {
          const tokenValue = process.env[this.config.auth.tokenEnv];
          if (tokenValue) {
            if (this.config.auth.type === "bearer") {
              headers["Authorization"] = `Bearer ${tokenValue}`;
            } else if (this.config.auth.type === "basic") {
              headers["Authorization"] = `Basic ${Buffer.from(tokenValue).toString("base64")}`;
            } else if (this.config.auth.type === "header" && this.config.auth.headerName) {
              headers[this.config.auth.headerName] = tokenValue;
            }
          }
        }

        this.logger.debug(`Search Engine [${this.id}] connecting via HTTP/SSE to: ${this.config.endpoint}`);
        const connected = await connectMcpClient(this.config.endpoint, this.logger, { headers });
        this.connectedClient = connected;
        this.clientInstance = connected.client;
        this.logger.info(`Search Engine [${this.id}] connected via ${connected.transportType}`);
        return connected.client;
      }
    } catch (err) {
      this.logger.error(`Failed to connect to Search Engine [${this.id}]: ${String(err)}`);
      throw err;
    } finally {
      this.isConnecting = false;
    }
  }

  async search(args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();
    const timeoutMs = this.config.timeoutMs ?? 10000;

    const promise = client.request({
      method: "tools/call",
      params: {
        name: "search",
        arguments: args,
      },
    }) as Promise<any>;

    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Search Engine [${this.id}] request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    let response: any;
    try {
      response = await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.content || response.content.length === 0) {
      throw new Error(`Search engine [${this.id}] returned empty content`);
    }

    const textContent = response.content[0];
    if (textContent.type !== "text") {
      throw new Error(`Search engine [${this.id}] returned non-text content`);
    }

    try {
      return JSON.parse(textContent.text);
    } catch {
      return textContent.text;
    }
  }

  async close(): Promise<void> {
    const client = this.clientInstance;
    this.clientInstance = null;
    this.logger.debug(`Closing Search Engine [${this.id}] connection`);

    if (this.connectedClient) {
      await this.connectedClient.close();
      this.connectedClient = null;
    }

    if (this.stdioTransport) {
      await this.stdioTransport.close();
      this.stdioTransport = null;
    }

    if (client) {
      await client.close().catch(() => {});
    }
  }
}


export class SearchRegistry {
  private engines: Map<string, SearchEngine> = new Map();

  register(engine: SearchEngine): void {
    this.engines.set(engine.id, engine);
  }

  get(id: string): SearchEngine | undefined {
    return this.engines.get(id);
  }

  getAll(): SearchEngine[] {
    return Array.from(this.engines.values());
  }

  getEngineIds(): string[] {
    return Array.from(this.engines.keys());
  }

  clear(): void {
    this.engines.clear();
  }

  async search(engineId: string, args: Record<string, unknown>): Promise<unknown> {
    const engine = this.engines.get(engineId);
    if (!engine) {
      throw new Error(`Unknown engine: ${engineId}`);
    }
    return engine.search(args);
  }

  async closeAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.close().catch(() => {});
    }
  }
}
