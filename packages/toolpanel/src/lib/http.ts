import { config } from "../config.js";

const TIMEOUT_DEFAULT = 5_000;

export interface UpstreamError extends Error {
  status: number;
  body: unknown;
}

export async function upstreamFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = TIMEOUT_DEFAULT,
): Promise<Response> {
  const url = `${config.searchEngineBaseUrl}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.searchAdminToken}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return await fetch(url, { ...init, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function upstreamJson<T = unknown>(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = TIMEOUT_DEFAULT,
): Promise<{ status: number; data: T | null; text: string }> {
  try {
    const res = await upstreamFetch(path, init, timeoutMs);
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data, text };
  } catch {
    return { status: 503, data: null, text: "upstream unreachable" };
  }
}

export async function upstreamHealth(): Promise<{ ok: boolean; status?: string; backend?: string; documentCount?: number }> {
  const { status, data } = await upstreamJson<{ status: string; backend: string; documentCount: number }>("/health", {}, 2_000);
  if (status === 200 && data && data.status === "ok") {
    return { ok: true, status: data.status, backend: data.backend, documentCount: data.documentCount };
  }
  return { ok: false };
}
