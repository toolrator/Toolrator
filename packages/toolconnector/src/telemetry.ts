// ---------------------------------------------------------------------------
// toolconnector — anonymous usage telemetry
// ---------------------------------------------------------------------------
//
// Answers "which MCP servers are actually used" with the minimum data that
// can answer it, and nothing else:
//
//   { name, action: "call" | "search", ok }   (+ connector version on the wire)
//
// `name` is the external server URL the agent called (or the search engine
// id). Privacy rules this module must keep:
//   - NEVER send query text, tool arguments, tool results, user identity,
//     hostnames, or anything free-form.
//   - No cookies, no identifiers, no local state beyond the in-memory queue.
//
// Abuse rules: the queue is bounded (oldest events dropped), batches are
// capped, failures are dropped (never retried into an unbounded backlog), and
// the whole thing is fire-and-forget — telemetry must never block or fail a
// tool call. Kill switch: TOOLRATOR_TELEMETRY=off|false|0|no.

export interface TelemetryEvent {
  /** External MCP server URL (call) or search engine id (search). */
  name: string;
  action: "call" | "search";
  ok: boolean;
}

export interface TelemetryOptions {
  /** Full endpoint URL (e.g. https://toolrator.org/api/usage/events). */
  endpoint: string;
  enabled: boolean;
  /** Connector version, sent as `v` for skew analysis. */
  version: string;
  /** Optional bearer token (the authenticated channel is the anti-abuse lever). */
  token?: string | null;
  logger?: { warn?: (message: string, ...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  /** Events kept in memory before the oldest are dropped (default 500). */
  maxQueue?: number;
  /** Batch size per POST (default 50). */
  maxBatch?: number;
  /** Flush cadence (default 60s). */
  flushIntervalMs?: number;
}

/** Kill-switch parsing shared with config. */
export function telemetryEnabledFromEnv(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return true;
  return !["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
}

export class TelemetryClient {
  private readonly queue: TelemetryEvent[] = [];
  private readonly maxQueue: number;
  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly logger: { warn?: (message: string, ...args: unknown[]) => void };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: TelemetryOptions) {
    this.maxQueue = options.maxQueue ?? 500;
    this.maxBatch = options.maxBatch ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 60_000;
    this.logger = options.logger ?? console;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Current queue depth (tests/diagnostics). */
  get pending(): number {
    return this.queue.length;
  }

  record(event: TelemetryEvent): void {
    if (!this.options.enabled) return;
    if (!event.name || (event.action !== "call" && event.action !== "search")) return;
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push(event);
    if (this.queue.length >= this.maxBatch) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * Extract a telemetry event from a tool call. Only the two popularity
   * signals are tracked: `mcp_server` calls (which server was used) and
   * `search_mcp_ecosystem` searches (which engine). Everything else —
   * auth flows, arguments, results — is ignored by design.
   */
  recordFromToolCall(toolName: string, args: unknown, result: unknown): void {
    if (!this.options.enabled) return;
    const a = (args ?? {}) as Record<string, unknown>;
    const ok = !((result as { isError?: unknown } | null)?.isError === true);
    if (toolName === "mcp_server" && typeof a.target === "string") {
      this.record({ name: a.target, action: "call", ok });
    } else if (toolName === "search_mcp_ecosystem" && typeof a.engine === "string") {
      this.record({ name: a.engine, action: "search", ok });
    }
  }

  /** POST one batch. Best-effort: failures drop the batch (bounded memory). */
  async flush(): Promise<void> {
    if (!this.options.enabled || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.maxBatch);
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
      await doFetch(this.options.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          events: batch.map((e) => ({ ...e, v: this.options.version })),
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      // Telemetry is best-effort: drop the batch and move on. It must never
      // retry into an unbounded backlog or surface errors to tool callers.
      this.logger.warn?.(`[telemetry] usage batch dropped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
