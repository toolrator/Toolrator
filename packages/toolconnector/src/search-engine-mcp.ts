import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { connectMcpClient, type ConnectedMcpClient } from "./mcp-connection.js";
import type { SearchEngine } from "./search-engine.js";
import type { SearchEngineConfig } from "./search-config.js";
import type { Logger } from "./config.js";
import { TOOLCONNECTOR_VERSION } from "./config.js";
import type { EngineSchema } from "./schema-cache.js";

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

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Search Engine [${this.id}] request timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const response = await Promise.race([promise, timeoutPromise]);

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
