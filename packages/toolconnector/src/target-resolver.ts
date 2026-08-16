export type TargetKind = "direct_http";
export type TrustLevel = "external_connection";

export interface ResolvedTarget {
  kind: TargetKind;
  url: string;
  trustLevel: TrustLevel;
}

const MCP_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/i;

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidMcpName(value: string): boolean {
  return MCP_NAME_REGEX.test(value);
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
