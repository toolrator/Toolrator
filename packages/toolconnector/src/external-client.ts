import type { Logger } from "./config.js";
import { connectMcpClient } from "./mcp-connection.js";
import { mcpCache } from "./cache.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// External MCP Client
// ---------------------------------------------------------------------------
// Makes direct connections to external MCP servers using the official MCP SDK
// client. This exposes the FULL protocol surface (tools, resources, prompts)
// over both the modern Streamable HTTP transport and the legacy HTTP+SSE
// transport, with automatic protocol-version negotiation and session
// lifecycle management handled by the SDK.
//
// Connects directly to external MCP servers, not through any intermediate
// router or proxy.
//
// Each call opens a fresh connection and tears it down afterwards. This keeps
// the client stateless and avoids the stale-session bugs that plagued the
// previous hand-rolled implementation. Protocol negotiation is handled automatically by the SDK.
// ---------------------------------------------------------------------------

export class ExternalMcpClient {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Execute a tool on an external MCP server (live). */
  async callTool(
    url: string,
    toolName: string,
    args: Record<string, unknown>,
    requestState?: string,
    inputResponses?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      return await conn.client.request(
        {
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
            inputResponses,
            requestState,
          },
        },
        {
          allowInputRequired: true,
        }
      );
    } finally {
      await conn.close();
    }
  }

  async executeTask(
    url: string,
    method: "tasks/get" | "tasks/update" | "tasks/cancel",
    params: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      const clientAny = conn.client as any;
      if (typeof clientAny._requestWithSchemaViaCodec === "function") {
        const codec = clientAny._negotiatedWireCodec();
        return await clientAny._requestWithSchemaViaCodec(codec, { method, params }, z.any());
      }
      return await conn.client.request({ method: method as any, params });
    } finally {
      await conn.close();
    }
  }

  /** Forward any app-level JSON-RPC method to an external MCP server (raw passthrough). */
  async requestRaw(
    url: string,
    method: string,
    params: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      const clientAny = conn.client as any;
      if (typeof clientAny._requestWithSchemaViaCodec === "function") {
        const codec = clientAny._negotiatedWireCodec();
        return await clientAny._requestWithSchemaViaCodec(codec, { method, params }, z.any());
      }
      return await conn.client.request({ method: method as any, params });
    } finally {
      await conn.close();
    }
  }

  /** List the tools advertised by an external MCP server. */
  async listTools(url: string, headers?: Record<string, string>): Promise<unknown> {
    const headerSuffix = headers && Object.keys(headers).length > 0 ? `:${JSON.stringify(headers)}` : "";
    const cacheKey = `tools:${url}${headerSuffix}`;
    const cached = mcpCache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Returning cached tools for ${url}`);
      return cached;
    }

    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      const res = await conn.client.listTools();
      const ttlMs = (res as any).ttlMs;
      if (typeof ttlMs === "number" && ttlMs > 0) {
        mcpCache.set(cacheKey, res, ttlMs, (res as any).cacheScope);
      }
      return res;
    } finally {
      await conn.close();
    }
  }

  /** List the resources exposed by an external MCP server. */
  async listResources(url: string, headers?: Record<string, string>): Promise<unknown> {
    const headerSuffix = headers && Object.keys(headers).length > 0 ? `:${JSON.stringify(headers)}` : "";
    const cacheKey = `resources:${url}${headerSuffix}`;
    const cached = mcpCache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Returning cached resources for ${url}`);
      return cached;
    }

    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      const res = await conn.client.listResources();
      const ttlMs = (res as any).ttlMs;
      if (typeof ttlMs === "number" && ttlMs > 0) {
        mcpCache.set(cacheKey, res, ttlMs, (res as any).cacheScope);
      }
      return res;
    } finally {
      await conn.close();
    }
  }

  /** Read the contents of a specific resource from an external MCP server. */
  async readResource(url: string, uri: string, headers?: Record<string, string>): Promise<unknown> {
    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      return await conn.client.readResource({ uri });
    } finally {
      await conn.close();
    }
  }

  /** List the prompts exposed by an external MCP server. */
  async listPrompts(url: string, headers?: Record<string, string>): Promise<unknown> {
    const headerSuffix = headers && Object.keys(headers).length > 0 ? `:${JSON.stringify(headers)}` : "";
    const cacheKey = `prompts:${url}${headerSuffix}`;
    const cached = mcpCache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Returning cached prompts for ${url}`);
      return cached;
    }

    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      const res = await conn.client.listPrompts();
      const ttlMs = (res as any).ttlMs;
      if (typeof ttlMs === "number" && ttlMs > 0) {
        mcpCache.set(cacheKey, res, ttlMs, (res as any).cacheScope);
      }
      return res;
    } finally {
      await conn.close();
    }
  }

  /** Fetch a specific prompt (with optional arguments) from an external MCP server. */
  async getPrompt(
    url: string,
    name: string,
    args?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const conn = await connectMcpClient(url, this.logger, { headers });
    try {
      return await conn.client.getPrompt({ name, arguments: args });
    } finally {
      await conn.close();
    }
  }
}
