import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";

const WHOAMI_PATH = join(config.configDir, "whoami.json");

const WhoamiSchema = z
  .object({
    // First time (ms epoch) we recorded any verify-key hit from the connector.
    firstSeenAt: z.number().int().nonnegative().optional(),
    // Most recent time (ms epoch) we saw the toolconnector call an upstream endpoint.
    lastSeenAt: z.number().int().nonnegative().optional(),
    // Endpoint paths (without query) we have been called on.
    lastEndpoints: z.array(z.string()).max(10).optional(),
    // SHA-256 prefix of the most-recent bearer token seen (so the user can confirm
    // the connector is using the right key without us storing the key itself).
    bearerPrefix: z.string().optional(),
    // Whether the last /api/auth/verify-key call returned 200.
    lastVerifyKeyOk: z.boolean().optional(),
    lastVerifyKeyAt: z.number().int().nonnegative().optional(),
    // Whether the last /api/connector/config/auto call returned 200.
    lastAutoPullOk: z.boolean().optional(),
    lastAutoPullAt: z.number().int().nonnegative().optional(),
    // Count of engines last returned by /api/connector/config/auto.
    lastEngineCount: z.number().int().nonnegative().optional(),
    // Lifetime successful verify-key count (incremented only on ok=true).
    verifyKeyCount: z.number().int().nonnegative().optional(),
    // Most recent failure reason + timestamp (for the "Last verify-key failed X ago" UI).
    lastErrorReason: z.string().optional(),
    lastErrorAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type Whoami = z.infer<typeof WhoamiSchema>;

// State enum surfaced to the UI. Fixed ladder (no rolling cadence) per product call.
//   fresh   — last verify-key ok=true AND < FRESH_MS ago → "Authentication successful · last seen X"
//   recent  — last verify-key ok=true but older            → "Last seen X (no problems)"
//   failed  — last verify-key was ok=false, no success in between → "Last verify-key failed X · <reason>"
//   never   — no verify-key was ever recorded               → "Never seen a toolconnector on this panel"
export type ToolconnectorState = "fresh" | "recent" | "failed" | "never";

const FRESH_MS = 5 * 60 * 1000; // 5 minutes — connector should hit verify-key on every boot

export interface ToolconnectorStatus extends Whoami {
  connected: boolean;
  state: ToolconnectorState;
}

async function readWhoami(): Promise<Whoami> {
  try {
    const raw = await readFile(WHOAMI_PATH, "utf8");
    const parsed = WhoamiSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

// Atomic-ish write: only the original .json file remains if anything fails.
async function writeWhoamiRaw(patch: Partial<Whoami>): Promise<Whoami> {
  const current = await readWhoami();
  const next: Whoami = { ...current, ...patch, lastSeenAt: Date.now() };
  const tmp = `${WHOAMI_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(tmp, WHOAMI_PATH);
  } catch (err) {
    // Best-effort cleanup — don't crash panel startup if the tmp is left behind.
    try { await (await import("node:fs/promises")).unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
  return next;
}

// SHA-256 hash, first 8 hex chars. Used only to display a non-reversible fingerprint.
export async function bearerFingerprint(bearer: string): Promise<string> {
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(bearer).digest("hex").slice(0, 8);
  } catch {
    return "";
  }
}

export async function recordVerifyKey(ok: boolean, bearer: string): Promise<void> {
  let patch: Partial<Whoami>;
  if (ok) {
    const prefix = bearer ? await bearerFingerprint(bearer) : undefined;
    const cur = await readWhoami();
    patch = {
      lastVerifyKeyOk: true,
      lastVerifyKeyAt: Date.now(),
      lastEndpoints: ["/api/auth/verify-key"],
      bearerPrefix: prefix ?? cur.bearerPrefix,
      verifyKeyCount: (cur.verifyKeyCount ?? 0) + 1,
      firstSeenAt: cur.firstSeenAt ?? Date.now(),
      // A successful verify-key clears the last-error state.
      lastErrorReason: undefined,
      lastErrorAt: undefined,
    };
  } else {
    const reason = bearer ? "invalid bearer's connector state" : "missing bearer";
    patch = {
      lastVerifyKeyOk: false,
      lastVerifyKeyAt: Date.now(),
      lastEndpoints: ["/api/auth/verify-key"],
      lastErrorReason: reason,
      lastErrorAt: Date.now(),
    };
  }
  try {
    await writeWhoamiRaw(patch);
  } catch {
    // Don't fail toolconnector's request when our own audit log can't persist.
  }
}

export async function recordAutoPullOk(ok: boolean, engineCount: number): Promise<void> {
  try {
    await writeWhoamiRaw({
      lastAutoPullOk: ok,
      lastAutoPullAt: Date.now(),
      lastEngineCount: engineCount,
      lastEndpoints: ["/api/connector/config/auto"],
    });
  } catch { /* ignore */ }
}

export async function recordDeviceStart(): Promise<void> {
  try {
    await writeWhoamiRaw({ lastEndpoints: ["/api/auth/device/start"] });
  } catch { /* ignore */ }
}

export async function recordDevicePoll(): Promise<void> {
  try {
    await writeWhoamiRaw({ lastEndpoints: ["/api/auth/device/poll"] });
  } catch { /* ignore */ }
}

export async function recordDeviceConfirm(): Promise<void> {
  try {
    await writeWhoamiRaw({ lastEndpoints: ["/api/auth/device/confirm"] });
  } catch { /* ignore */ }
}

export async function getWhoami(): Promise<ToolconnectorStatus> {
  const w = await readWhoami();
  const now = Date.now();
  let state: ToolconnectorState;
  if (w.lastVerifyKeyAt === undefined) {
    state = "never";
  } else if (w.lastVerifyKeyOk === true && now - w.lastVerifyKeyAt < FRESH_MS) {
    state = "fresh";
  } else if (w.lastVerifyKeyOk === true) {
    state = "recent";
  } else {
    // lastVerifyKeyOk === false (or undefined) but a record exists → treat as failed
    state = "failed";
  }
  return {
    ...w,
    state,
    connected: state === "fresh",
  };
}
