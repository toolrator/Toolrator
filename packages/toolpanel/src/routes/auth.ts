import { Hono } from "hono";
import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { readDeviceCodes, writeDeviceCodes } from "../storage.js";
import { layout, escapeHtml } from "../views/layout.js";
import { buildGlobalStatus } from "../globalStatus.js";
import {
  recordDeviceStart,
  recordDevicePoll,
  recordDeviceConfirm,
  recordVerifyKey,
} from "../whoami.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGITS = "0123456789";

function pick(chars: string, n: number): string {
  let out = "";
  const b = randomBytes(n);
  for (let i = 0; i < n; i++) out += chars[b[i]! % chars.length];
  return out;
}

function generateUserCode(): string {
  return `${pick(CODE_CHARS, 4)}-${pick(DIGITS, 4)}`;
}

const EXPIRES_SECONDS = 1_800;

export const auth = new Hono();

async function readBodyJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

// POST /api/auth/device/start
// Toolconnector (auth-client.ts:54) sends an empty POST with Content-Type: application/json.
// We tolerate an empty body.
auth.post("/api/auth/device/start", async (c) => {
  // Drain any body so the client doesn't see a stall on next request — tolerates
  // empty body, JSON body, or anything else without parsing strictly.
  await readBodyJson<unknown>(c).catch(() => null);

  const deviceCode = randomBytes(24).toString("hex");
  const userCode = generateUserCode();
  const now = Date.now();
  const codes = (await readDeviceCodes()).filter((x) => x.expiresAt > now);
  codes.push({
    deviceCode,
    userCode,
    status: "pending",
    expiresAt: now + EXPIRES_SECONDS * 1_000,
    createdAt: now,
    updatedAt: now,
  });
  await writeDeviceCodes(codes);
  void recordDeviceStart();
  return c.json(
    {
      verification_uri: `${config.publicUrl}/device`,
      user_code: userCode,
      device_code: deviceCode,
      expires_in: EXPIRES_SECONDS,
    },
    200,
  );
});

// POST /api/auth/device/poll
auth.post("/api/auth/device/poll", async (c) => {
  const body = (await readBodyJson<{ device_code?: string }>(c)) ?? {};
  const deviceCode = body?.device_code;
  if (!deviceCode) {
    return c.json({ error: "invalid_input", message: "device_code is required." }, 400);
  }
  void recordDevicePoll();

  const now = Date.now();
  const codes = await readDeviceCodes();
  const idx = codes.findIndex((x) => x.deviceCode === deviceCode);
  if (idx === -1 || codes[idx]!.expiresAt <= now) {
    const fresh = codes.filter((x) => x.expiresAt > now);
    await writeDeviceCodes(fresh);
    return c.json({ status: "expired" }, 200);
  }
  const entry = codes[idx]!;
  if (entry.status === "pending") return c.json({ status: "pending" }, 200);
  if (entry.status === "confirmed") {
    codes.splice(idx, 1);
    await writeDeviceCodes(codes);
    return c.json(
      {
        status: "success",
        api_key: config.apiKey || "toolpanel-local",
        email: "local@toolpanel",
      },
      200,
    );
  }
  return c.json({ status: "expired" }, 200);
});

// POST /api/auth/device/confirm (open mode; no session required)
// Body shape: { user_code: "ABCD-1234" }
auth.post("/api/auth/device/confirm", async (c) => {
  const body = (await readBodyJson<{ user_code?: string }>(c)) ?? {};
  const raw = (body?.user_code || "").trim();
  if (!raw) return c.json({ error: "invalid_input", message: "user_code is required." }, 400);
  const userCode = normalizeUserCode(raw);
  if (userCode.length !== 9 || userCode[4] !== "-") {
    return c.json({ error: "invalid_input", message: "user_code must be 8 chars (letters+digits), e.g. ABCD-1234." }, 400);
  }

  const now = Date.now();
  const codes = (await readDeviceCodes()).filter((x) => x.expiresAt > now);
  const entry = codes.find((x) => normalizeUserCode(x.userCode) === userCode && x.status === "pending");
  if (!entry) return c.json({ error: "invalid_code", message: "No pending device code matches that user_code." }, 404);
  entry.status = "confirmed";
  entry.updatedAt = now;
  await writeDeviceCodes(codes);
  void recordDeviceConfirm();
  return c.json({ success: true }, 200);
});

// GET /api/auth/device/status?user_code=ABCD-1234 — used by the /device page
// Returns the current state of a device code (so the user can watch it move
// from pending → success).
auth.get("/api/auth/device/status", async (c) => {
  const raw = (c.req.query("user_code") || "").toUpperCase();
  if (!raw) return c.json({ error: "invalid_input", message: "user_code is required." }, 400);
  const userCode = normalizeUserCode(raw);
  const now = Date.now();
  const codes = (await readDeviceCodes()).filter((x) => x.expiresAt > now);
  const entry = codes.find((x) => normalizeUserCode(x.userCode) === userCode);
  if (!entry) return c.json({ status: "unknown" }, 200);
  return c.json({ status: entry.status, expires_at: entry.expiresAt }, 200);
});

// Normalize "ABCD-1234", "abcd1234", "abcd 1234", "AB-CD-12-34" all to "ABCD-1234"
function normalizeUserCode(input: string): string {
  const stripped = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (stripped.length !== 8) return input.trim().toUpperCase();
  return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}`;
}

// POST /api/auth/verify-key (open mode: any non-empty bearer is valid)
auth.post("/api/auth/verify-key", async (c) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) {
    void recordVerifyKey(false, "");
    return c.json({ valid: false, reason: "missing" }, 401);
  }
  void recordVerifyKey(true, bearer);
  return c.json(
    {
      valid: true,
      user: {
        id: "toolpanel-local",
        email: "local@toolpanel",
        role: "admin",
        status: "active",
        name: "Toolpanel Local",
      },
    },
    200,
  );
});

// GET /device — the page a human opens to confirm a user_code.
// Supports ?user_code=... so toolconnector's verification_uri may itself
// carry the code in the future; auto-fills the input.
auth.get("/device", async (c) => {
  const initialCode = escapeHtml((c.req.query("user_code") || "").toUpperCase());
  const globalStatus = await buildGlobalStatus();

  const body = `
    <section class="card card-device">
      <header class="device-head">
        <div class="device-emblem" aria-hidden="true"></div>
        <div>
          <h1>Authorize your toolconnector</h1>
          <p class="muted">Enter the 8-character code your AI agent printed (e.g. <code>ABCD-1234</code>). The agent is polling — once you confirm here, it picks up the credentials automatically.</p>
        </div>
      </header>

      <form class="form device-form" data-device-confirm autocomplete="off">
        <label class="field device-code-field">
          <span class="field-label">User code</span>
          <div class="device-code-input" data-code-input>
            <input
              type="text"
              inputmode="text"
              name="user_code"
              class="device-code-input__slot"
              maxlength="4"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              aria-label="first four characters"
              data-code-slot="0"
              ${initialCode ? `value="${initialCode.slice(0,4)}"` : ""}
              required
            />
            <span class="device-code-dash" aria-hidden="true">-</span>
            <input
              type="text"
              inputmode="numeric"
              name="user_code_digits"
              class="device-code-input__slot"
              maxlength="4"
              autocomplete="off"
              spellcheck="false"
              aria-label="last four digits"
              data-code-slot="1"
              ${initialCode ? `value="${initialCode.slice(5,9)}"` : ""}
              required
            />
          </div>
          <input type="hidden" name="user_code_combined" data-code-combined />
        </label>

        <div class="device-actions">
          <button class="btn btn-primary btn-lg" type="submit" data-device-submit>Confirm</button>
          <button class="btn btn-ghost" type="button" data-device-paste>Paste</button>
        </div>

        <div class="form-msg" data-device-msg role="status" aria-live="polite"></div>
      </form>

      <section class="device-state" data-device-state hidden>
        <div class="device-state-row">
          <span class="dot" data-state-dot></span>
          <span data-state-text>Waiting…</span>
        </div>
        <p class="hint muted" data-state-hint></p>
      </section>

      <details class="device-help">
        <summary>Where do I get a code?</summary>
        <p class="muted">
          Your AI agent calls <code>manage_auth</code> with <code>action: "start_device_flow"</code> on the toolconnector. It prints a URL and an 8-char code — this is that URL. Just paste/type the code, hit Confirm, and the agent will pick up the credentials in the next poll (≤ 60 s).
        </p>
        <p class="muted">
          Open mode: toolpanel does not require a login. Anyone with the user_code (typically only you, the local user) can confirm.
        </p>
      </details>
    </section>`;

  return c.html(layout({ title: "Authorize toolconnector", active: "device", body, globalStatus }));
});
