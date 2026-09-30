import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Logger } from "./config.js";
import { TOOLCONNECTOR_VERSION } from "./config.js";
import { OAuthStore, maskToken } from "./oauth-store.js";
import { buildSdkProvider } from "./oauth-client.js";
import { z } from "zod";

export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class McpCache {
  private cache = new Map<string, CacheEntry<any>>();

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    // toolconnector runs locally, per user, one process — so a response the
    // upstream marked "private" is still safe to keep in this in-memory map for
    // the life of the process. The distinction is therefore not modelled here.
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export const mcpCache = new McpCache();


export type TargetKind = "direct_http";
export type TrustLevel = "external_connection";

export interface ResolvedTarget {
  kind: TargetKind;
  url: string;
  trustLevel: TrustLevel;
  originalTarget?: string;
}

const SMITHERY_SERVER_REGEX = /^https?:\/\/registry\.smithery\.ai\/servers\/([^/?#]+(?:\/[^/?#]+)?)$/i;

const registryResolutionCache = new Map<string, string>();

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveTarget(target: string): ResolvedTarget {
  const trimmed = target.trim();

  if (isHttpUrl(trimmed)) {
    return {
      kind: "direct_http",
      url: trimmed,
      trustLevel: "external_connection",
    };
  }

  throw new Error(
    `Invalid target: "${target}". Provide an external http(s) URL (e.g. "http://localhost:8080/mcp").`
  );
}

/**
 * Resolves an external MCP target URL, automatically translating known registry
 * listing URLs (such as Smithery metadata endpoints) to their live deployment endpoints.
 */
export async function resolveTargetAsync(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedTarget> {
  const base = resolveTarget(target);
  const match = base.url.match(SMITHERY_SERVER_REGEX);
  if (!match) {
    return base;
  }

  const cached = registryResolutionCache.get(base.url);
  if (cached) {
    return {
      kind: "direct_http",
      url: cached,
      trustLevel: "external_connection",
      originalTarget: base.url,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetchImpl(base.url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as {
        deploymentUrl?: string;
        remote?: boolean;
        connections?: Array<{ type?: string; deploymentUrl?: string }>;
      };

      const resolvedEndpoint =
        data.deploymentUrl ||
        data.connections?.find((c) => c.deploymentUrl)?.deploymentUrl;

      if (resolvedEndpoint && typeof resolvedEndpoint === "string" && isHttpUrl(resolvedEndpoint)) {
        registryResolutionCache.set(base.url, resolvedEndpoint.trim());
        return {
          kind: "direct_http",
          url: resolvedEndpoint.trim(),
          trustLevel: "external_connection",
          originalTarget: base.url,
        };
      }

      if (data.remote === false) {
        throw new Error(
          `MCP server at "${base.url}" is marked as local-only (stdio) on Smithery and does not expose a remote HTTP endpoint.`
        );
      }
    }
  } catch (err: any) {
    if (err.message && err.message.includes("marked as local-only")) {
      throw err;
    }
    // Fall back to the original URL if registry lookup fails
  }

  return base;
}


// ---------------------------------------------------------------------------
// Shared MCP connection helper
// ---------------------------------------------------------------------------
// Wraps the official MCP SDK client. Connecting through this helper gives us
// the ENTIRE protocol surface (tools, resources, prompts, notifications,
// resumability, protocol-version negotiation, session lifecycle) for free,
// and it stays spec-compliant automatically as the SDK is updated.
//
// Per the MCP specification we try the modern Streamable HTTP transport first
// and fall back to the legacy HTTP+SSE transport for older servers.
// ---------------------------------------------------------------------------

const CLIENT_INFO = { name: "toolconnector", version: TOOLCONNECTOR_VERSION };

export interface McpConnectOptions {
  /** Extra headers attached to every outbound request (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * OAuth provider (SDK OAuthClientProvider shape) attached to both
   * transports. When present, the transport injects the bearer token on every
   * request and runs the SDK's auth() flow on 401 (silent refresh). Only set
   * when the caller did NOT supply explicit Authorization headers — explicit
   * caller headers always win.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authProvider?: any;
  /**
   * Called with the response headers of every HTTP response. Used to capture
   * side-channel headers without coupling the caller to the transport internals.
   */
  onResponseHeaders?: (headers: Headers) => void;
}

export interface ConnectedMcpClient {
  client: Client;
  transportType: "streamable-http" | "sse";
  /** Terminate the session and tear down the transport. Never throws. */
  close: () => Promise<void>;
}

function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid MCP server URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported protocol: ${parsed.protocol}. Only http: and https: are supported.`,
    );
  }
  return parsed;
}

/**
 * Connect to a remote MCP server using the official SDK client.
 *
 * The returned client has already negotiated the protocol and is
 * ready to issue tools/resources/prompts calls. Callers are responsible for
 * invoking `close()` when finished.
 */
export async function connectMcpClient(
  url: string,
  logger: Logger,
  opts: McpConnectOptions = {},
): Promise<ConnectedMcpClient> {
  const parsed = validateUrl(url);

  const fetchImpl = opts.onResponseHeaders
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (input: any, init?: any) => {
        const res = await fetch(input, init);
        try {
          opts.onResponseHeaders?.(res.headers);
        } catch {
          /* never let header inspection break the actual request */
        }
        return res;
      })
    : undefined;

  const requestInit = opts.headers ? { headers: opts.headers } : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authProviderOpt = opts.authProvider
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { authProvider: opts.authProvider as any }
    : {};

  // Attempt 1 — modern Streamable HTTP transport.
  try {
    const client = new Client(CLIENT_INFO, {
      versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false },
      capabilities: {
        tasks: {},
      },
    });
    const transport = new StreamableHTTPClientTransport(parsed, {
      requestInit,
      ...authProviderOpt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: fetchImpl as any,
    });
    await client.connect(transport);
    logger.debug(`Connected via Streamable HTTP: ${url}`);
    return {
      client,
      transportType: "streamable-http",
      close: async () => {
        await client.close().catch(() => {
          /* ignore teardown errors */
        });
      },
    };
  } catch (streamErr) {
    logger.debug(
      `Streamable HTTP connect failed for ${url} (${String(streamErr)}); trying SSE fallback`,
    );

    // Attempt 2 — legacy HTTP+SSE transport.
    try {
      const client = new Client(CLIENT_INFO, {
        versionNegotiation: { mode: "auto" },
        inputRequired: { autoFulfill: false },
        capabilities: {
          tasks: {},
        },
      });
      const transport = new SSEClientTransport(parsed, {
        requestInit,
        ...authProviderOpt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetch: fetchImpl as any,
      });
      await client.connect(transport);
      logger.debug(`Connected via SSE: ${url}`);
      return {
        client,
        transportType: "sse",
        close: async () => {
          await client.close().catch(() => {
            /* ignore teardown errors */
          });
        },
      };
    } catch (sseErr) {
      throw new Error(
        `Failed to connect to MCP server at ${url}. ` +
          `Streamable HTTP error: ${String(streamErr)}; SSE error: ${String(sseErr)}`,
      );
    }
  }
}


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
  private readonly oauthStore: OAuthStore | null;

  constructor(logger: Logger, configDir?: string) {
    this.logger = logger;
    // OAuth store is optional: when no configDir is provided (tests), the
    // OAuth path is inert and behavior matches pre-OAuth versions.
    this.oauthStore = configDir ? new OAuthStore(configDir) : null;
  }

  /**
   * Resolve connect options for a target: explicit headers win (they are used
   * verbatim, no OAuth provider); otherwise attach the stored OAuth provider
   * for the target when one exists so the transport injects + refreshes the
   * bearer token transparently.
   */
  private async connectOpts(
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ headers?: Record<string, string>; authProvider?: unknown }> {
    if (headers && Object.keys(headers).length > 0) return { headers };
    if (!this.oauthStore) return {};
    const entry = await this.oauthStore.findEntry(undefined, url);
    if (!entry?.tokens?.access_token) return {};
    this.logger.debug(`Using stored OAuth token for ${url} (${maskToken(entry.tokens.access_token)})`);
    return { authProvider: buildSdkProvider({ store: this.oauthStore, logger: this.logger, target: url }) };
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
    const conn = await connectMcpClient(url, this.logger, await this.connectOpts(url, headers));
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
    return this.requestRaw(url, method, params, headers);
  }

  /** Forward any app-level JSON-RPC method to an external MCP server (raw passthrough). */
  async requestRaw(
    url: string,
    method: string,
    params: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const conn = await connectMcpClient(url, this.logger, await this.connectOpts(url, headers));
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
    return this.listCached("tools", url, headers, (client) => client.listTools());
  }

  /** List the resources exposed by an external MCP server. */
  async listResources(url: string, headers?: Record<string, string>): Promise<unknown> {
    return this.listCached("resources", url, headers, (client) => client.listResources());
  }

  /** List the prompts exposed by an external MCP server. */
  async listPrompts(url: string, headers?: Record<string, string>): Promise<unknown> {
    return this.listCached("prompts", url, headers, (client) => client.listPrompts());
  }

  private async listCached(
    kind: "tools" | "resources" | "prompts",
    url: string,
    headers: Record<string, string> | undefined,
    list: (client: Client) => Promise<unknown>,
  ): Promise<unknown> {
    const connectOpts = await this.connectOpts(url, headers);
    const headerSuffix = connectOpts.headers && Object.keys(connectOpts.headers).length > 0 ? `:${JSON.stringify(connectOpts.headers)}` : "";
    const cacheKey = `${kind}:${url}${headerSuffix}`;
    const cached = mcpCache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Returning cached ${kind} for ${url}`);
      return cached;
    }

    const conn = await connectMcpClient(url, this.logger, connectOpts);
    try {
      const res = await list(conn.client);
      const ttlMs = (res as any).ttlMs;
      if (typeof ttlMs === "number" && ttlMs > 0) {
        mcpCache.set(cacheKey, res, ttlMs);
      }
      return res;
    } finally {
      await conn.close();
    }
  }

  /** Read the contents of a specific resource from an external MCP server. */
  async readResource(url: string, uri: string, headers?: Record<string, string>): Promise<unknown> {
    const conn = await connectMcpClient(url, this.logger, await this.connectOpts(url, headers));
    try {
      return await conn.client.readResource({ uri });
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
    const conn = await connectMcpClient(url, this.logger, await this.connectOpts(url, headers));
    try {
      return await conn.client.getPrompt({ name, arguments: args });
    } finally {
      await conn.close();
    }
  }
}
