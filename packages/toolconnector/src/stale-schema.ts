// ---------------------------------------------------------------------------
// In-band schema-staleness compensation.
//
// The MCP spec puts the refresh burden on the client: the server advertises
// `tools.listChanged` and sends `notifications/tools/list_changed`, and the
// client should re-fetch `tools/list`. In practice (2026) most harnesses
// snapshot the tool list at session start and ignore the notification —
// Claude Code (pre-2.1.0 / 2.1.211 regression), Cursor CLI, OpenAI Codex, etc.
//
// The server cannot force a refresh, but it CAN talk to the LLM in-band:
// when we know a client is looking at a stale tool list, we attach the
// current schema to the tool's responses — on validation errors ("this
// likely failed because...") and, once per tool, on successful calls —
// so the model self-corrects on its next call instead of failing forever.
//
// Nothing here changes what `tools/list` serves; for fresh clients this
// module is fully inert.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { schemaTimestamps } from "./state.js";

/**
 * True when the server has changed tool schemas since the client last
 * fetched the tools list (i.e. the client is looking at stale definitions).
 */
export function isSchemaStale(): boolean {
  return schemaTimestamps.lastUpdated > schemaTimestamps.lastFetched;
}

/**
 * The client re-fetched `tools/list` — everything it holds is current again.
 * Resets the once-per-tool notice bookkeeping for the next staleness epoch.
 */
export function markClientRefreshed(): void {
  schemaTimestamps.lastFetched = Date.now();
  informedTools.clear();
}

// ---------------------------------------------------------------------------
// Current-schema registry
//
// tools.ts registers each tool's live zod schema (on registration and on
// every hot update) so the transport layer can render the *current* schema
// into in-band hints without duplicating schema definitions.
// ---------------------------------------------------------------------------

const currentSchemas = new Map<string, z.ZodType>();

export function registerCurrentSchema(toolName: string, schema: unknown): void {
  if (schema && typeof (schema as z.ZodType).parse === "function") {
    currentSchemas.set(toolName, schema as z.ZodType);
  }
}

/** Render a tool's current input schema as JSON Schema (null if unknown). */
export function getCurrentSchemaJson(toolName: string): Record<string, unknown> | null {
  const schema = currentSchemas.get(toolName);
  if (!schema) return null;
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Once-per-tool bookkeeping (success notices only — a failing tool always
// gets the full appendix, because that is exactly when it is needed).
// ---------------------------------------------------------------------------

const informedTools = new Set<string>();

/** True if the success notice for this tool was already sent this epoch. */
export function alreadyInformed(toolName: string): boolean {
  return informedTools.has(toolName);
}

/** Record that the success notice for this tool has been sent. */
export function markInformed(toolName: string): void {
  informedTools.add(toolName);
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function schemaBlock(currentSchemaJson: Record<string, unknown> | null): string {
  if (!currentSchemaJson) {
    return "(current schema unavailable — reconnect to refresh the tools list)";
  }
  return JSON.stringify(currentSchemaJson);
}

/**
 * Appendix for a FAILED call: explains the likely root cause (stale harness
 * tool list), embeds the current schema, and tells the model what to do.
 * Intended for both JSON-RPC protocol errors (validation rejections) and
 * tool-level `isError` results.
 */
export function buildStaleErrorAppendix(
  toolName: string,
  sentArguments: unknown,
  currentSchemaJson: Record<string, unknown> | null,
): string {
  const parts = [
    `The arguments were validated against an OUTDATED schema for tool "${toolName}".`,
    `Likely cause: the client application has not refreshed its tools list since the server sent \`notifications/tools/list_changed\` (many clients currently ignore it), so the schema your harness shows for "${toolName}" is old.`,
  ];
  if (sentArguments !== undefined) {
    parts.push(`Arguments you sent: ${JSON.stringify(sentArguments)}`);
  }
  parts.push(`Current, correct input schema for "${toolName}": ${schemaBlock(currentSchemaJson)}`);
  parts.push(
    `Retry the call using the current schema above, and tell the user to refresh/reconnect this MCP server's tools so the client picks up the new definitions.`,
  );
  return parts.join("\n");
}

/**
 * Short notice appended to a SUCCESSFUL result of a stale-schema call —
 * once per tool per staleness epoch (until the client re-fetches tools/list).
 * The goal is to pre-empt the next failure (e.g. an enum value that was
 * renamed), not to bloat every response.
 */
export function buildStaleSuccessNotice(
  toolName: string,
  currentSchemaJson: Record<string, unknown> | null,
): string | null {
  if (informedTools.has(toolName)) return null;
  informedTools.add(toolName);
  return [
    `ℹ️ Note about tool "${toolName}": your client's tools list is outdated (the server sent \`notifications/tools/list_changed\`, which the client did not act on).`,
    `If a future call to this tool fails schema validation, that is why. Current input schema: ${schemaBlock(currentSchemaJson)}`,
    `Ask the user to refresh/reconnect the server's tools when convenient.`,
  ].join("\n");
}

/**
 * Convenience: how many tools have pending success notices this epoch
 * (used by tests to assert the reset behavior).
 */
export function informedToolCount(): number {
  return informedTools.size;
}
