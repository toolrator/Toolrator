# MCP Feature Compliance — Toolconnector

> **Protocol**: MCP 2026-07-28 (Official — released 2026-07-28)  
> **SDK**: `@modelcontextprotocol/server` + `@modelcontextprotocol/client` v2 (stable)  
> **Last updated**: 2026-08-18

This document tracks every MCP 2026-07-28 protocol feature and whether it is implemented in the toolconnector. The toolconnector acts as both:
- An **MCP Server** (exposed to the AI agent via stdio)
- An **MCP Client** (connects to remote MCP servers via HTTP)

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Implemented and tested |
| 🔧 | In progress |
| ❌ | Not implemented |
| ➖ | Not applicable to the toolconnector |
| ⏳ | Deferred (awaiting upstream spec stabilization / SDK support) |

---

## 1. Base Protocol (Stateless Core)

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 1.1 | Remove `initialize` / `initialized` handshake | SEP-2575 | ✅ | `mcp-connection.ts` | v2 SDK handles this. Connected with `versionNegotiation: { mode: 'auto' }`. |
| 1.2 | `_meta` on every request (protocolVersion, clientInfo, clientCapabilities) | SEP-2575 | ✅ | `mcp-connection.ts` | v2 SDK attaches `_meta` automatically when negotiation is active. |
| 1.3 | Remove `Mcp-Session-Id` header | SEP-2567 | ✅ | `mcp-connection.ts` | We never relied on session IDs — connections are stateless. |
| 1.4 | `server/discover` RPC | SEP-2575 | ✅ | `mcp-connection.ts` | Negotiated via `mode: 'auto'` which executes probe. |
| 1.5 | `UnsupportedProtocolVersionError` on version mismatch | SEP-2575 | ✅ | `errors.ts` | Detected and classified. |
| 1.6 | Version negotiation with legacy (2025-11-25) servers | — | ✅ | `mcp-connection.ts` | Handled automatically by v2 SDK fallback. |

---

## 2. Transport (Streamable HTTP)

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 2.1 | Streamable HTTP transport (primary) | — | ✅ | `mcp-connection.ts` | Already the primary transport. |
| 2.2 | `Mcp-Method` and `Mcp-Name` request headers | SEP-2243 | ✅ | `mcp-connection.ts` | Added automatically by SDK v2. |
| 2.3 | `x-mcp-header` custom headers from tool parameters | SEP-2243 | ➖ | — | This is a server-side concern. Toolconnector as a client passes them automatically. |
| 2.4 | Remove SSE stream resumability (`Last-Event-ID`) | SEP-2575 | ✅ | `mcp-connection.ts` | We don't use SSE resumability. |
| 2.5 | SSE transport (deprecated, 12-month window) | SEP-2596 | ✅ | `mcp-connection.ts` | Supported as fallback. Will be removed when deprecated period ends. |

---

## 3. State Management

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 3.1 | Stateless connections (no session-bound state) | SEP-2567 | ✅ | `external-client.ts` | Stateless — each call opens/closes a fresh connection. |
| 3.2 | Explicit tool-minted handles (basket_id, etc.) | SEP-2567 | ✅ | — | Transparent to the toolconnector — handles are just tool arguments. |

---

## 4. Caching & Tracing

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 4.1 | `ttlMs` on list responses | SEP-2549 | ✅ | `cache.ts` | Cached in-memory and evicts properly. |
| 4.2 | `cacheScope` ("public" / "private") | SEP-2549 | ✅ | `cache.ts` | Respects cache scope. |
| 4.3 | Client-side cache for `tools/list` | SEP-2549 | ✅ | `external-client.ts` | Bypasses connect step entirely when cache is warm. |
| 4.4 | `traceparent` / `tracestate` / `baggage` in `_meta` | SEP-414 | ➖ | — | OpenTelemetry propagation. Not implemented (optional). |

---

## 5. Elicitation & Multi Round-Trip Requests (MRTR)

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 5.1 | Detect `resultType: "input_required"` from `tools/call` | SEP-2322 | ✅ | `external-client.ts` | Using low-level client `request` and `allowInputRequired: true`. |
| 5.2 | Format `inputRequests` for the AI agent | SEP-2322 | ✅ | `tools.ts` | Surfaces elicitation questions as tool result. |
| 5.3 | Accept `requestState` + `inputResponses` on retry | SEP-2322 | ✅ | `tools.ts` | Exposed via `mcp_server` passthrough — `tools/call` with `params { requestState, inputResponses }`. |
| 5.4 | Pass `inputResponses` + `requestState` to `tools/call` | SEP-2322 | ✅ | `external-client.ts` | Passed into client request parameters on retry. |
| 5.5 | `resultType: "complete"` on all normal results | SEP-2322 | ✅ | `tools.ts` | Treated properly. |

---

## 6. Tasks Extension

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 6.1 | Advertise `io.modelcontextprotocol/tasks` in client capabilities | SEP-2663 | ✅ | `mcp-connection.ts` | Configured `capabilities: { tasks: {} }`. |
| 6.2 | `tasks/get` (poll task status) | SEP-2663 | ✅ | `tools.ts` | Exposed via `mcp_server` passthrough (`method: "tasks/get"`). |
| 6.3 | `tasks/update` (send input to running task) | SEP-2663 | ✅ | `tools.ts` | Exposed via `mcp_server` passthrough (`method: "tasks/update"`, `params { taskId, status }`). |
| 6.4 | `tasks/cancel` (cancel running task) | SEP-2663 | ✅ | `tools.ts` | Exposed via `mcp_server` passthrough (`method: "tasks/cancel"`). |
| 6.5 | Detect task handle in `tools/call` response | SEP-2663 | ✅ | `tools.ts` | Returned in raw execution payload. |

---

## 7. Error Codes

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 7.1 | `-32002` → `-32602` (resource not found → Invalid Params) | SEP-2164 | ✅ | `errors.ts` | Mapped to `resource_not_found`. |
| 7.2 | `-32020` HeaderMismatch error | — | ✅ | `errors.ts` | Mapped to `header_mismatch`. |
| 7.3 | `-32021` MissingRequiredClientCapability error | — | ➖ | — | Translated by SDK 
| 7.4 | `-32022` UnsupportedProtocolVersion error | — | ✅ | `errors.ts` | Mapped to `unsupported_protocol_version`. |

---

## 8. Authorization

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 8.1 | Validate `iss` parameter on auth responses (RFC 9207) | SEP-2468 | ➖ | — | Toolconnector uses API key auth, not OAuth. |
| 8.2 | `application_type` during Dynamic Client Registration | SEP-837 | ➖ | — | Not using DCR. |
| 8.3 | Credential binding to issuing AS | SEP-2352 | ➖ | — | Not applicable. |

---

## 9. Schema & Validation

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 9.1 | JSON Schema 2020-12 (default if no `$schema` field) | SEP-2106 | ✅ | — | Toolconnector passes schemas through. |
| 9.2 | `outputSchema` on tool definitions | SEP-2106 | ✅ | `tools.ts` | Displayed when inspecting tools. |
| 9.3 | `structuredContent` in tool results | SEP-2106 | ✅ | `tools.ts` | Returned in raw JSON result payload. |
| 9.4 | Do NOT auto-dereference external `$ref` URIs | SEP-2106 | ✅ | — | We don't dereference schemas. |

---

## 10. Subscriptions & Notifications

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 10.1 | `subscriptions/listen` replaces HTTP GET + `resources/subscribe` | SEP-2575 | ➖ | — | Not applicable for our stateless proxy pattern. |
| 10.2 | `notifications/tools/list_changed` | — | ✅ | `index.ts` | Emitted when auth state changes. |
| 10.3 | Remove `ping` method | SEP-2575 | ✅ | — | We never used ping. |
| 10.4 | Remove `logging/setLevel` | SEP-2575 | ✅ | — | We never used this. |

---

## 11. Deprecated Features (still functional, plan migration)

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 11.1 | Roots (deprecated) | SEP-2577 | ➖ | — | We don't use Roots. |
| 11.2 | Sampling (deprecated) | SEP-2577 | ➖ | — | We don't use Sampling. |
| 11.3 | Logging (deprecated) | SEP-2577 | ➖ | — | We don't use the MCP Logging feature. |
| 11.4 | HTTP+SSE transport (deprecated) | SEP-2596 | ✅ | `mcp-connection.ts` | Supported as fallback. |

---

## 12. SDK v2 Migration

| # | Change | Status | Location | Notes |
|---|--------|--------|----------|-------|
| 12.1 | `@modelcontextprotocol/sdk` → `@modelcontextprotocol/server` + `@modelcontextprotocol/client` | ✅ | `package.json` | Migrated successfully. |
| 12.2 | `McpServer.tool()` → `registerTool()` | ✅ | `tools.ts` | Handled properly with standard schema. |
| 12.3 | `McpError` → JSON-RPC error classification | ✅ | `errors.ts` | Uses standard JSON-RPC error codes and structured error mapping. |
| 12.4 | `StdioServerTransport` → `@modelcontextprotocol/server/stdio` | ✅ | `index.ts` | Updated. |
| 12.5 | `Client` → `@modelcontextprotocol/client` | ✅ | `mcp-connection.ts` | Updated. |
| 12.6 | `SSEClientTransport` removal | ✅ | `mcp-connection.ts` | Maintained as fallback on client. |
| 12.7 | `zod ^3.23.0` → `zod ^4.2.0` | ✅ | `package.json`, `tools.ts` | Updated to Zod v4. |
| 12.8 | `extra` → `ctx` (handler context) | ✅ | `index.ts` | Updated context argument usage. |

---

## 13. Payments (x402 / SEP-2009)

> **Status**: ⏳ Deferred — not in the `2026-07-28` core spec. Documented for visibility so developers know it is on the roadmap.

Enables MCP servers to charge for tool/prompt/resource access via x402 (stablecoin micropayments) over Streamable HTTP. SEP-2009 proposes a protocol-agnostic payment framework with **X402 Protocol v2** as the first supported payment protocol.

> ⚠️ **Spec churn / competitor draft**: SEP-2009 (error code `-32803`, proof-of-payment via `X-Payment` header) and SEP-2007 (error code `-32402`, signed *authorization* via a `payment` field / `_meta["x402/payment"]`) are competing drafts. SEP-2007's *authorization* model is currently favored (x402 settles via facilitator, it does not send a completed payment proof). The exact wire format is **not finalized**. Toolconnector will not lock an implementation until the draft stabilizes and the MCP client SDK (v2) exposes a payment hook.

| # | Feature | Spec Ref | Status | Location | Notes |
|---|---------|----------|--------|----------|-------|
| 13.1 | Declare `payment` capability in `initialize` / `_meta` | SEP-2009 | ⏳ | — | `capabilities.payment.protocols: ["x402"]`. Optional; discoverable via `tools/list` too. |
| 13.2 | Surface payment metadata via `payments/list` | SEP-2009 | ⏳ | — | Protocols, versions, schemes, ToS/privacy links. |
| 13.3 | Detect `-32803` "Payment Required" challenge | SEP-2009 | ⏳ | `errors.ts` | Distinct from Toolrator's own credit/usage error handling; must not collapse into it. |
| 13.4 | Sign payment (EIP-3009 `transferWithAuthorization`) | x402 v2 | ⏳ | — | Client-side, external path only. Requires wallet. |
| 13.5 | Retry `tools/call` with x402 payload | SEP-2009 | ⏳ | — | Either `X-Payment` header or structured `payment` field, pending draft resolution. |
| 13.6 | Verify + settle via facilitator (`/verify`, `/settle`, `/supported`) | x402 v2 | ⏳ | — | Server-side concern when acting as host. |
| 13.7 | Code-level spend policy (max amount, network, budget) | — | ⏳ | — | Hard caps checked **before** signing; never prompt-only. |

**Guiding constraints (deferred plan):**
- **Opt-in & off by default** — no wallet configured → capability absent.
- **External path only** (`ExternalMcpClient`); the existing connector proxy path is untouched.
- **Prefer hosted/escrow wallets** (e.g. CDP Server Wallet in TEE) over a raw `X402_PRIVATE_KEY` in a local `npx` process.
- **Never silent** — return a distinct `payment_required` structured error and surface the `txHash`/receipt to the agent.
