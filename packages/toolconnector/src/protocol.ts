// ---------------------------------------------------------------------------
// toolconnector — MCP protocol version negotiation (stdio transport shim)
// ---------------------------------------------------------------------------
//
// `serveStdio` classifies a claim-less `initialize` opening as a 2025-era
// connection and answers with the legacy InitializeResult claiming
// `2025-11-25` — even when the client asked for a modern revision. A modern
// (2026-07-28-only) client then refuses the connection: "Server's protocol
// version is not supported: 2025-11-25".
//
// This transport-level shim performs real version negotiation on the legacy
// `initialize` reply:
//   - when the requested version is one we support, the reply echoes it;
//   - modern replies additionally get the 2026-07-28 result shape
//     (`resultType: "complete"` + serverInfo in `_meta`);
//   - when the requested version is NOT supported, the SDK's server-chosen
//     fallback reply is left untouched (classic MCP negotiation rule).
//
// Stateless 2026-07-28 openings (`server/discover`, claim-carrying requests)
// are served natively by the SDK and never pass through here.

/** Every protocol revision this connector can speak. */
// The SDK negotiates these legacy codecs itself, including its internal
// negotiated version. Rewriting only the reply would leave server and client
// disagreeing about the wire revision after initialization.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05",
] as const;

/** The current (stateless) revision — replies for it use the modern shape. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export interface ServerIdentity {
  name: string;
  version: string;
}

/** The piece of a transport this shim wraps (method syntax: bivariant params). */
export interface NegotiableTransport {
  onmessage?(message: unknown): void;
  send(message: unknown): unknown;
}

/**
 * Pure rewrite of an InitializeResult. Exported for tests.
 * Returns the same object, mutated.
 */
export function negotiateInitializeResult(
  result: Record<string, unknown>,
  requested: string,
  serverInfo: ServerIdentity,
): Record<string, unknown> {
  const supported = SUPPORTED_PROTOCOL_VERSIONS as readonly string[];
  if (supported.includes(requested) && result.protocolVersion !== requested) {
    result.protocolVersion = requested;
  }
  if (result.protocolVersion === MODERN_PROTOCOL_VERSION) {
    result.resultType = "complete";
    const meta = (result._meta ?? {}) as Record<string, unknown>;
    meta[SERVER_INFO_META_KEY] = serverInfo;
    result._meta = meta;
  }
  return result;
}

/**
 * Install the negotiation shim on a stdio transport. Call AFTER the
 * transport's message handler is attached (i.e. after `serveStdio`), so the
 * shim wraps the SDK's handler and writer.
 */
export function installInitializeNegotiation(
  transport: NegotiableTransport,
  serverInfo: ServerIdentity,
  maxTracked = 50,
): void {
  const pending = new Map<string, string>();

  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message: unknown) => {
    if (message && typeof message === "object") {
      const m = message as { method?: unknown; id?: unknown; params?: { protocolVersion?: unknown } };
      if (m.method === "initialize" && m.id !== undefined && typeof m.params?.protocolVersion === "string") {
        if (pending.size >= maxTracked) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) pending.delete(oldest);
        }
        pending.set(String(m.id), m.params.protocolVersion);
      }
    }
    originalOnMessage?.call(transport, message);
  };

  const originalSend = transport.send.bind(transport);
  transport.send = async (message: unknown): Promise<void> => {
    try {
      const m = message as { id?: unknown; result?: Record<string, unknown> } | undefined;
      if (m && typeof m === "object" && m.id !== undefined && m.result && typeof m.result === "object") {
        const requested = pending.get(String(m.id));
        if (requested !== undefined) {
          pending.delete(String(m.id));
          negotiateInitializeResult(m.result, requested, serverInfo);
        }
      }
    } catch {
      // Negotiation must never break the response path.
    }
    await originalSend(message);
  };
}
