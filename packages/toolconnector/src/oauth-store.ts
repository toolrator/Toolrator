import { mkdir, readFile, writeFile, rename, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// OAuth token store (toolconnector)
// ---------------------------------------------------------------------------
//
// Persists OAuth 2.1 credentials for external MCP servers in the connector's
// config dir (default ~/.toolconnector), mirroring the credentials.json model:
// plaintext JSON on disk, 0600 perms, atomic writes. Tokens are keyed by the
// authorization server's issuer (RFC 8707 §2.2 — client ids and tokens are
// unique per AS) with the target URL recorded alongside so one AS protecting
// several servers still resolves.
//
// Nothing here logs token material. Masking uses the same maskKey approach as
// state.ts. The code verifier (PKCE proof possession) is the security anchor
// for the paste-back flow: an intercepted authorization code is useless
// without it, which is why the verifier is persisted before the user is sent
// to the browser and never leaves the config dir.

export const TOOLCONNECTOR_CLIENT_ID =
  "https://toolrator.org/.well-known/oauth-client/toolconnector.json";

/** Fixed advertised redirect. Never bound — used only by the paste-back flow. */
export const PASTE_BACK_REDIRECT_URI = "http://127.0.0.1:49152/callback";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredClientInformation {
  client_id: string;
  [key: string]: unknown;
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface OAuthEntry {
  /** Authorization server issuer (canonical, from AS metadata). */
  issuer: string;
  /** MCP server(s) this credential was minted for (resource URL). */
  target: string;
  clientId: string;
  clientInformation?: StoredClientInformation;
  tokens?: StoredTokens;
  /** epoch ms — computed from expires_in at save time, if the AS sent it. */
  expiresAt?: number;
  savedAt: string;
}

export interface PendingGrant {
  target: string;
  /** CSRF state we generated for the authorization URL. */
  state: string;
  issuer: string;
  /** Present for paste-back (authorization-code) flows. */
  codeVerifier?: string;
  /** Present for RFC 8628 device flows. */
  deviceCode?: string;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  expiresAt: number;
}

const TOKENS_FILENAME = "oauth-tokens.json";
const PENDING_FILENAME = "oauth-pending.json";
const PENDING_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  try {
    await chmod(configDir, 0o700);
  } catch {
    // Windows/POSIX differences — best effort.
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Atomic 0600 write: write to a sibling temp file, set perms, rename over the
 * destination. On Windows chmod only honors the read-only bit; the ACL story
 * is best-effort — same trade-off as credentials.json in state.ts.
 */
async function writeJson0600(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    /* best effort */
  }
  await rename(tmp, filePath);
}

/** Constant-time string compare (state comparison on the OAuth callback). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function maskToken(token: string): string {
  if (!token || token.length < 8) return "***";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class OAuthStore {
  private readonly configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  private get tokensPath(): string {
    return join(this.configDir, TOKENS_FILENAME);
  }

  private get pendingPath(): string {
    return join(this.configDir, PENDING_FILENAME);
  }

  // -- token entries -------------------------------------------------------

  async allEntries(): Promise<OAuthEntry[]> {
    const data = await readJson<{ entries?: OAuthEntry[] }>(this.tokensPath);
    return data?.entries ?? [];
  }

  private async writeEntries(entries: OAuthEntry[]): Promise<void> {
    await ensureDir(this.configDir);
    await writeJson0600(this.tokensPath, { entries });
  }

  /**
   * SDK contract (SEP-2352): with ctx → the entry whose issuer matches;
   * without ctx → the most-recently-saved entry for this store's target.
   */
  async findEntry(issuer?: string, target?: string): Promise<OAuthEntry | undefined> {
    const entries = await this.allEntries();
    if (issuer) {
      return entries.find((e) => e.issuer === issuer);
    }
    if (target) {
      return entries
        .filter((e) => e.target === target)
        .sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1))[0];
    }
    return entries.sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1))[0];
  }

  async upsertEntry(entry: OAuthEntry): Promise<void> {
    const entries = await this.allEntries();
    const idx = entries.findIndex((e) => e.issuer === entry.issuer && e.target === entry.target);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    await this.writeEntries(entries);
  }

  /** Drops the entry and returns true when something was removed. */
  async removeEntry(issuer: string, target?: string): Promise<boolean> {
    const entries = await this.allEntries();
    const next = entries.filter((e) => !(e.issuer === issuer && (target ? e.target === target : true)));
    if (next.length === entries.length) return false;
    await this.writeEntries(next);
    return true;
  }

  // -- pending grant (single slot) ------------------------------------------

  async getPendingGrant(): Promise<PendingGrant | null> {
    const pending = await readJson<PendingGrant>(this.pendingPath);
    if (!pending) return null;
    if (pending.expiresAt < Date.now()) {
      await this.clearPendingGrant();
      return null;
    }
    return pending;
  }

  async setPendingGrant(grant: PendingGrant): Promise<void> {
    await ensureDir(this.configDir);
    await writeJson0600(this.pendingPath, grant);
  }

  async clearPendingGrant(): Promise<void> {
    try {
      await unlink(this.pendingPath);
    } catch {
      /* already gone */
    }
  }

  /**
   * Build the current pending grant into a fresh OAuthEntry. Caller supplies
   * the tokens + issuer; the grant provides target + client info + verifier.
   */
  async consumePendingGrant(tokens: StoredTokens, issuer: string): Promise<OAuthEntry | null> {
    const pending = await this.getPendingGrant();
    if (!pending) return null;
    await this.clearPendingGrant();
    const entry: OAuthEntry = {
      issuer,
      target: pending.target,
      clientId: pending.deviceCode ? TOOLCONNECTOR_CLIENT_ID : TOOLCONNECTOR_CLIENT_ID,
      clientInformation: { client_id: TOOLCONNECTOR_CLIENT_ID },
      tokens,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      savedAt: new Date().toISOString(),
    };
    await this.upsertEntry(entry);
    return entry;
  }
}
