import type { ConnectorState } from "./state.js";
import type { SearchRegistry } from "./search-engines.js";

// ---------------------------------------------------------------------------
// Dynamic Description Generators (LLM-Optimized)
// ---------------------------------------------------------------------------

export function describeSearchMcpEcosystem(
  state: ConnectorState,
  registry?: SearchRegistry,
): string {
  const base =
    "Search the MCP ecosystem using one of the available search engines.\n" +
    "Pick an engine and provide arguments matching its schema.";

  if (!registry || registry.getAll().length === 0) {
    return base;
  }

  let desc = "Search the MCP ecosystem using one of the available search engines.\n" +
    "Pick an engine and provide arguments matching its schema.\n\n" +
    "Available engines:\n";

  for (const engine of registry.getAll()) {
    desc += `\n── ${engine.id} ("${engine.label}")\n`;
    desc += `   Schema: ${JSON.stringify(engine.schema.inputSchema)}\n`;
    if (engine.schema.outputDescription) {
      desc += `   Output: ${engine.schema.outputDescription}\n`;
    }
    if (engine.notes && engine.notes.trim() !== "") {
      desc += `   Notes: "${engine.notes}"\n`;
    }
  }

  return desc;
}

export function describeMcpServer(state: ConnectorState): string {
  let base = (
    "Interact with any external MCP server. This is a generic JSON-RPC passthrough: " +
    "supply the server's http(s) URL as 'target', the protocol 'method', the optional 'params' object, " +
    "and optional 'headers' — the server's raw response is returned.\n\n" +
    "Authentication: preferred is manage_auth with action 'start_oauth' — the connector performs a " +
    "standard OAuth 2.1 login, stores the tokens, and attaches them automatically on every call to " +
    "that server (also on 401 retries). Only use the 'headers' parameter as a LAST RESORT for servers " +
    "with no OAuth surface and no stored credentials (e.g. { 'Authorization': 'Bearer <token>' } or " +
    "{ 'x-api-key': '<key>' }); explicit headers override the stored OAuth tokens.\n\n" +
    "Common methods:\n" +
    "- 'tools/list' — list the server's tools. Summarized automatically when there are more than 6 " +
    "(each tool shows a 'param_hint' listing its parameters) to save context.\n" +
    "- 'tools/call' — call a tool: params { name, arguments }. A long-running call may return " +
    "'_meta.task_id' — poll it with 'tasks/get'.\n" +
    "- 'resources/list', 'resources/read' (params { uri }), 'prompts/list', 'prompts/get' (params { name, arguments }).\n" +
    "- 'tasks/get' (params { taskId }), 'tasks/update' (params { taskId, status }), 'tasks/cancel' (params { taskId }).\n" +
    "Any other app-level method is forwarded as-is. Protocol plumbing ('initialize', 'ping', 'notifications/*') " +
    "is blocked — the connector manages the connection."
  );

  if (state.authState === "authenticated") {
    base += state.credentialType === "oauth_token"
      ? " Authenticated via OAuth 2.1."
      : ` Authenticated as ${state.email || "a saved API key"}.`;
  } else {
    base += " Currently in anonymous mode. Use manage_auth to authenticate.";
  }
  return base;
}

export function describeManageAuth(
  state: ConnectorState,
  searchConfigState?: {
    autoPullSucceeded?: boolean;
    lastVerifiedAt?: string;
    authUrl?: string;
    toolpanelUrl?: string;
    resolvedBaseUrl?: string;
    source?: string;
  },
): string {
  const toolratorMcpUrl = searchConfigState?.authUrl
    ? `${searchConfigState.authUrl.replace(/\/+$/, "")}/mcp`
    : undefined;
  let base =
    "Manage your authentication against the configured upstream. " +
    "Logout actions ('logout', 'oauth_logout') must NEVER be performed unless the user explicitly asks for it — never log out on your own, even if authentication looks broken, a verification fails, or you believe the session is invalid; surface the issue to the user and ask first. " +
    "OAuth actions let you sign in to the Toolrator cloud (or any MCP server that fronts an OAuth 2.1 authorization server) with standard OAuth: the connector discovers the server's authorization metadata, runs the device or paste-back flow, stores the tokens locally, and attaches them automatically on every call. " +
    "After a successful OAuth login the remote search-engine configuration is re-pulled with the new token and applied automatically — no restart needed.\n\n" +
    "SEARCH CONFIG: If the user asks to change Toolrator-hosted engines, authenticate with 'start_oauth' " +
    "(default scopes) to " +
    (toolratorMcpUrl ? `the configured MCP endpoint ${toolratorMcpUrl}` : "the configured Toolrator MCP endpoint") +
    " and use 'mcp_server' with that target to call 'manage_search_engines', then call 'status' to refresh. " +
    "Never assume a fixed host. " +
    "The user can also edit 'search-engines.json' manually or use a configured toolpanel.";

  if (state.authState === "authenticated") {
    base += " Actions: 'status' to check your current state; 'oauth_status' to list stored OAuth connections (tokens shown masked); 'logout' to securely clear credentials and return to anonymous mode; 'oauth_logout' to remove stored OAuth tokens.";
    base += state.credentialType === "oauth_token"
      ? " Logged in via OAuth 2.1."
      : ` Logged in as ${state.email}.`;
    if (searchConfigState?.autoPullSucceeded === true) {
      base += " Session authenticated and active (verified at boot).";
    } else if (searchConfigState?.autoPullSucceeded === false && searchConfigState?.lastVerifiedAt) {
      base += ` Session authenticated locally (last verified at ${searchConfigState.lastVerifiedAt}).`;
    }
  } else {
    base += " Actions: 'status' to check state; 'start_oauth' to begin the OAuth 2.1 login against the Toolrator cloud — opens a URL for the user to approve (device code or paste-back, handled automatically); 'oauth_status' to inspect stored OAuth connections. " +
      "Not logged in. Start with action: 'start_oauth' to authenticate.";
  }

  const sourceTag = searchConfigState?.source === "remote:toolpanel"
    ? "local toolpanel"
    : "configured upstream";
  const baseUrl = searchConfigState?.resolvedBaseUrl || searchConfigState?.authUrl || "";
  const configUrlHint = baseUrl ? `\n\nSearch-engine configuration for this session came from the ${sourceTag} (${baseUrl}) — that URL controls which search backends toolconnector queries when you call search_mcp_ecosystem. Backend selection can be changed by the USER ONLY — the assistant cannot start a config-session or modify the backend selection. If the human asks about discovery / backend selection / search engines / 'can I use my own search index', mention this capability is handled at the configured upstream.` : "";

  base += configUrlHint;

  return base;
}
