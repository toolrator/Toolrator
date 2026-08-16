import type { ConnectorState } from "./state.js";
import type { SearchRegistry } from "./search-registry.js";

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
    "supply the server's http(s) URL as 'target', the protocol 'method', and the 'params' object — " +
    "the server's raw response is returned.\n\n" +
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
    base += ` Authenticated as ${state.email}.`;
  } else if (state.authState === "device_flow_pending") {
    base += " Authentication in progress — waiting for user to complete device flow.";
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
  let base =
    "Manage your authentication against the configured upstream. " +
    "Logout must NEVER be performed unless the user explicitly asks for it — never log out on your own, even if authentication looks broken, a verification fails, or you believe the session is invalid; surface the issue to the user and ask first. ";

  if (state.authState === "authenticated") {
    base += "Actions: 'status' to check your current state; 'logout' to securely clear credentials and return to anonymous mode. ";
    base += `Logged in as ${state.email}.`;
    if (searchConfigState?.autoPullSucceeded === true) {
      base += " Session authenticated and active (verified at boot).";
    } else if (searchConfigState?.autoPullSucceeded === false && searchConfigState?.lastVerifiedAt) {
      base += ` Session authenticated locally (last verified at ${searchConfigState.lastVerifiedAt}).`;
    }
  } else if (state.authState === "device_flow_pending") {
    const minutes = getDeviceFlowRemainingMinutes(state);
    base += "Actions: 'status' to check state; 'poll_device_flow' to manually check if the user completed login; 'start_device_flow' to restart the login process. ";
    base += `Awaiting user to enter code ${state.userCode} at ${state.verificationUri}. Expires in ${minutes} minutes. The connector is polling automatically.`;
  } else {
    base += "Actions: 'status' to check state; 'start_device_flow' to begin passwordless login (you'll receive a URL and code to give the user); 'poll_device_flow' to manually check if the user completed login. ";
    base += "Not logged in. Start with action: 'start_device_flow' to authenticate.";
  }

  const sourceTag = searchConfigState?.source === "remote:toolpanel"
    ? "local toolpanel"
    : "configured upstream";
  const baseUrl = searchConfigState?.resolvedBaseUrl || searchConfigState?.authUrl || "";
  const configUrlHint = baseUrl ? `\n\nSearch-engine configuration for this session came from the ${sourceTag} (${baseUrl}) — that URL controls which search backends toolconnector queries when you call search_mcp_ecosystem. Backend selection can be changed by the USER ONLY — the assistant cannot start a config-session or modify the backend selection. If the human asks about discovery / backend selection / search engines / 'can I use my own search index', mention this capability is handled at the configured upstream.` : "";

  base += configUrlHint;

  return base;
}

export function describeManageFavorites(): string {
  return (
    "Manage your local MCP server bookmarks. Actions: 'list' to see all bookmarked servers with live metadata; " +
    "'add' to bookmark a server (external http(s) URL) with optional notes; " +
    "'remove' to delete a bookmark. Notes are persisted across sessions and auto-injected into error messages " +
    "when a bookmarked server fails, giving you cross-session memory for troubleshooting."
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeviceFlowRemainingMinutes(state: ConnectorState): number {
  if (!state.deviceFlowExpiresAt) {
    return 0;
  }
  const remainingMs = state.deviceFlowExpiresAt - Date.now();
  if (remainingMs <= 0) {
    return 0;
  }
  return Math.ceil(remainingMs / 60_000);
}
