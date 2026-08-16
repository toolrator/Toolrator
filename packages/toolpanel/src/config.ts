import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Read an environment variable. Accepts either a single key or an array of
 * keys (the first non-empty match wins).
 */
function env(keyOrKeys: string | string[], fallback: string): string {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  for (const key of keys) {
    const v = process.env[key];
    if (v && v.trim() !== "") return v;
  }
  return fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const host = env("HOST", "127.0.0.1");
const port = envInt("PORT", 7800);

const publicUrl =
  env("TOOLPANEL_PUBLIC_URL", "").trim() ||
  `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

const configDir = resolve(env("TOOLPANEL_CONFIG_DIR", join(process.cwd(), "toolpanel-config")));

try {
  mkdirSync(configDir, { recursive: true });
} catch {
  // exists or unable — fine for read paths
}

if (host !== "127.0.0.1" && host !== "localhost") {
  console.warn(
    `\n[toolpanel] WARNING: HOST=${host}. Toolpanel has NO authentication and should not be exposed to a network.\n`,
  );
}

export const config = {
  host,
  port,
  publicUrl: publicUrl.replace(/\/+$/, ""),
  configDir,
  searchEngineBaseUrl: env("SEARCH_ENGINE_BASE_URL", "http://127.0.0.1:7600").replace(/\/+$/, ""),
  searchAdminToken: env("SEARCH_ADMIN_TOKEN", "dev-admin-token"),
  /** API key advertised by the panel for toolconnector. */
  apiKey: env("CONNECTOR_API_KEY", ""),
  /**
   * Product name used in toolpanel's in-UI tool-name hints. Defaults to
   * `toolconnector`. Override via `CONNECTOR_PRODUCT_NAME`.
   */
  productName: env("CONNECTOR_PRODUCT_NAME", "toolconnector"),
} as const;

export type AppConfig = typeof config;
