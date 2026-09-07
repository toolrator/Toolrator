export type TargetKind = "direct_http";
export type TrustLevel = "external_connection";

export interface ResolvedTarget {
  kind: TargetKind;
  url: string;
  trustLevel: TrustLevel;
  originalTarget?: string;
}

const MCP_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/i;
const SMITHERY_SERVER_REGEX = /^https?:\/\/registry\.smithery\.ai\/servers\/([^/?#]+(?:\/[^/?#]+)?)$/i;

const registryResolutionCache = new Map<string, string>();

export function clearRegistryResolutionCache(): void {
  registryResolutionCache.clear();
}

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
