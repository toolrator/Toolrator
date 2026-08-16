import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Logger } from "./config.js";
import { TOOLCONNECTOR_VERSION } from "./config.js";

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
