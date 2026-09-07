import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const pathEngines = join(config.configDir, "search-engines.json");
const pathDevice = join(config.configDir, "device-codes.json");

export const SearchEngineAuthSchema = z
  .object({
    type: z.enum(["bearer", "basic", "header"]),
    tokenEnv: z.string().optional(),
    headerName: z.string().optional(),
  })
  .strict();

export const SearchEngineSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/, "id must match ^[a-z0-9-]+$")
      .max(64)
      .min(1),
    label: z.string().max(80).min(1),
    transport: z.enum(["http", "mcp-http", "mcp-sse", "mcp-stdio"]),
    endpoint: z.string().min(1),
    args: z.array(z.string()).optional(),
    schemaUrl: z.string().optional(),
    auth: SearchEngineAuthSchema.optional(),
    notes: z.string().max(500).optional(),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
    enabled: z.boolean().default(true),
  })
  .strict();

export type SearchEngine = z.infer<typeof SearchEngineSchema>;

export async function readSearchEngines(): Promise<SearchEngine[]> {
  const raw = await readJson<unknown[]>(pathEngines, []);
  if (!Array.isArray(raw)) return [];
  const out: SearchEngine[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = SearchEngineSchema.safeParse(item);
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id);
      out.push(parsed.data);
    }
  }
  return out;
}

export async function writeSearchEngines(engines: SearchEngine[]): Promise<void> {
  // Enforce uniqueness + validation server-side before persisting.
  const deduped: SearchEngine[] = [];
  const seen = new Set<string>();
  for (const e of engines) {
    const parsed = SearchEngineSchema.safeParse(e);
    if (!parsed.success) throw new Error(`Invalid engine "${e?.id}": ${parsed.error.issues.map((i) => i.message).join(", ")}`);
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    deduped.push(parsed.data);
  }
  await writeJson(pathEngines, deduped);
}

const DeviceCodeSchema = z
  .object({
    deviceCode: z.string(),
    userCode: z.string(),
    status: z.enum(["pending", "confirmed"]).default("pending"),
    expiresAt: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

export type DeviceCode = z.infer<typeof DeviceCodeSchema>;

export async function readDeviceCodes(): Promise<DeviceCode[]> {
  const raw = await readJson<unknown[]>(pathDevice, []);
  if (!Array.isArray(raw)) return [];
  const out: DeviceCode[] = [];
  for (const item of raw) {
    const parsed = DeviceCodeSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function writeDeviceCodes(codes: DeviceCode[]): Promise<void> {
  await writeJson(pathDevice, codes);
}

export async function pruneExpiredDeviceCodes(): Promise<DeviceCode[]> {
  const now = Date.now();
  const fresh = (await readDeviceCodes()).filter((c) => c.expiresAt > now);
  await writeDeviceCodes(fresh);
  return fresh;
}
