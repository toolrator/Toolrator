// ---------------------------------------------------------------------------
// toolhub — Tool Document Builder (D7 parent-child indexing)
// ---------------------------------------------------------------------------
// Derives one ToolDocument per tool of a server's capabilities.tools. Tool
// docs live in a dedicated `mcp_tools` index; each carries a semantic vector
// over `tool name + description + compact schema + parent server context`.
// IDs are stable and URL-safe ("{encoded_server}__{encoded_tool}") so tools
// can be upserted/deleted independently of their parent server.
// ---------------------------------------------------------------------------

import type { RawTool, SearchDocument, ToolDocument } from "./adapters/types.js";
import { generateCompactSchema } from "./compact-schema.js";

/** Tool index builder limits (defaults; overridable per server). */
export interface ToolBuildOptions {
  /** Max tools embedded per server (deterministic subset). */
  maxToolsEmbedded: number;
  /** Max tool description chars embedded. */
  maxToolDescChars: number;
  /** Max compact schema chars embedded. */
  maxToolSchemaChars: number;
  /** Max total semantic text chars per tool doc. */
  maxToolSemanticChars: number;
}

export const DEFAULT_TOOL_BUILD_OPTIONS: ToolBuildOptions = {
  maxToolsEmbedded: 64,
  maxToolDescChars: 1200,
  maxToolSchemaChars: 1200,
  maxToolSemanticChars: 8000,
};

/**
 * Builds tool documents for one server document. Deterministic: tools with
 * empty names are dropped, tools with descriptions sort first (stable), the
 * remaining are capped at maxToolsEmbedded preserving that order.
 */
export function buildToolDocumentsForServer(
  server: SearchDocument,
  options: ToolBuildOptions = DEFAULT_TOOL_BUILD_OPTIONS,
): ToolDocument[] {
  const rawTools = extractRawTools(server);
  const picked = pickTools(rawTools, options.maxToolsEmbedded);

  const updatedAt = server.updated_at ?? new Date().toISOString();
  return picked.map((tool) => {
    const description = truncateSafe(tool.description ?? "", options.maxToolDescChars);
    const schema = generateCompactSchema(tool.inputSchema, options.maxToolSchemaChars);
    const context = `${server.display_name}${server.provider ? ` by ${server.provider}` : ""}`;
    const semanticText = buildToolSemanticText(
      tool.name,
      description,
      schema,
      context,
      options.maxToolSemanticChars,
    );

    return {
      id: toolDocumentId(server.mcp_name, tool.name),
      server_mcp_name: server.mcp_name,
      server_display_name: server.display_name,
      tool_name: tool.name,
      tool_description: description,
      compact_schema: schema,
      provider: server.provider,
      tags: server.tags,
      health_status: server.health_status,
      server_base_url: server.base_url,
      server_provider: server.provider,
      server_health_last_checked: server.updated_at,
      updated_at: updatedAt,
      semantic_text: semanticText,
      content_hash: server.content_hash ? `${server.content_hash}:tools:${hashString(semanticText)}` : hashString(semanticText),
      has_vector: false,
    };
  });
}

/** Builds tool docs for many servers, flattened (order preserved). */
export function buildToolDocuments(
  servers: SearchDocument[],
  options: ToolBuildOptions = DEFAULT_TOOL_BUILD_OPTIONS,
): ToolDocument[] {
  return servers.flatMap((server) => buildToolDocumentsForServer(server, options));
}

function extractRawTools(server: SearchDocument): RawTool[] {
  if (!server.capabilities || typeof server.capabilities !== "object") return [];
  const tools = (server.capabilities as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is RawTool => !!t && typeof t === "object" && typeof (t as RawTool).name === "string")
    .map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: isRecord(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : undefined,
      annotations: isRecord(t.annotations) ? (t.annotations as Record<string, unknown>) : undefined,
    }));
}

function pickTools(tools: RawTool[], max: number): RawTool[] {
  const named = tools.filter((t) => t.name.trim().length > 0);
  // Stable sort: tools with descriptions first (crawl order preserved within groups)
  const withDesc = named.filter((t) => (t.description ?? "").trim().length > 0);
  const withoutDesc = named.filter((t) => (t.description ?? "").trim().length === 0);
  return [...withDesc, ...withoutDesc].slice(0, max);
}

function buildToolSemanticText(
  name: string,
  description: string,
  schema: string,
  context: string,
  maxChars: number,
): string {
  const parts = [`${name}`];
  if (description) parts.push(`: ${description}`);
  if (schema) parts.push(`. Input: ${schema}`);
  if (context) parts.push(` (${context})`);
  return truncateSafe(parts.join(""), maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateSafe(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const codePoints = Array.from(value);
  return codePoints.slice(0, Math.max(0, max - 1)).join("") + "…";
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Stable, URL-safe tool document id: "{encoded_server}__{encoded_tool}".
 * Server ids reuse the server-doc encoding (slashes -> "__", dots -> "_").
 * Tool names are sanitized to [a-z0-9_-]; collisions are avoided by a short
 * stable hash suffix when sanitization would merge two distinct names.
 */
export function toolDocumentId(serverMcpName: string, toolName: string): string {
  const serverId = encodeServerId(serverMcpName);
  const sanitized = sanitizeToolName(toolName);
  const toolId =
    sanitized.length > 160
      ? `${sanitized.slice(0, 160)}_${hashString(sanitized).slice(0, 6)}`
      : sanitized;
  return `${serverId}__${toolId}`;
}

export function encodeServerId(mcpName: string): string {
  return mcpName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]/g, "_")
    .replace(/\//g, "__")
    .replace(/\./g, "_");
}

export function sanitizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_");
}