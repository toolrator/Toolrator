import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "./config.js";
import { OAuthStore } from "./oauth-store.js";

export const schemaTimestamps = {
  lastUpdated: 0,
  lastFetched: Date.now(),
};

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type AuthState = "anonymous" | "authenticated";

/** Which credential domain backs the authenticated state (unified model). */
export type CredentialType = "api_key" | "oauth_token";

export interface ConnectorState {
  authState: AuthState;
  /** Set when authState === "authenticated" — which domain is in use. */
  credentialType?: CredentialType;
  email?: string;
  apiKeyMask?: string;
  apiKey?: string;
}

type StateChangeCallback = () => void;

// ---------------------------------------------------------------------------
// Credential File Schema
//
// READ-ONLY. The legacy Toolrator device flow was the only writer of this
// file; it was removed with the flow. An API key now reaches the connector
// either through `CONNECTOR_API_KEY` (Priority 1 at boot) or a credentials.json
// the operator placed themselves (Priority 2). Nothing in the package writes
// it, and `logout` still deletes it.
// ---------------------------------------------------------------------------

interface CredentialFile {
  api_key: string;
  email: string;
  saved_at: string;
}

const CREDENTIAL_FILENAME = "credentials.json";

// ---------------------------------------------------------------------------
// State Manager
// ---------------------------------------------------------------------------

export class ConnectorStateManager {
  private state: ConnectorState;
  private listeners: StateChangeCallback[] = [];
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.state = { authState: "anonymous" };
  }

  getState(): ConnectorState {
    return { ...this.state };
  }

  onStateChange(callback: StateChangeCallback): void {
    this.listeners.push(callback);
  }

  /**
   * Initialise state from environment or saved credentials.
   * Call once at startup.
   */
  async init(configDir: string, envApiKey: string): Promise<void> {
    // Priority 1: explicit env var key
    if (envApiKey) {
      this.logger.info("API key provided via CONNECTOR_API_KEY environment variable");
      this.setState({
        authState: "authenticated",
        credentialType: "api_key",
        apiKey: envApiKey,
        apiKeyMask: maskKey(envApiKey),
      });
      return;
    }

    // Priority 2: credentials.json placed in the config dir (see the note on
    // CredentialFile — the package no longer writes this file).
    try {
      const creds = await this.loadCredentials(configDir);
      if (creds) {
        this.logger.info(`Loaded saved credentials for ${creds.email}`);
        this.setState({
          authState: "authenticated",
          credentialType: "api_key",
          apiKey: creds.api_key,
          apiKeyMask: maskKey(creds.api_key),
          email: creds.email,
        });
        return;
      }
    } catch {
      this.logger.debug("No saved credentials found");
    }

    // Priority 3: stored OAuth tokens (unified state — an OAuth-only session
    // is a full login even without an API key, so boot must reflect it).
    try {
      const entries = await new OAuthStore(configDir).allEntries();
      const entry = entries.find((e) => e.tokens?.access_token);
      if (entry) {
        this.logger.info(`Loaded stored OAuth connection for ${entry.target}`);
        // OAuthEntry carries no profile claims; email fills in on the first
        // verify-key/status refresh.
        this.setState({ authState: "authenticated", credentialType: "oauth_token" });
        return;
      }
    } catch {
      this.logger.debug("No stored OAuth connections found");
    }

    // Priority 4: anonymous
    this.logger.info("Starting in anonymous mode");
    this.setState({ authState: "anonymous" });
  }

  /**
   * Unified state: a successful OAuth login is a full login even without an
   * API key. Flips authState without touching any other fields; the OAuth
   * token itself lives in the OAuthStore, not here.
   */
  markOAuthAuthenticated(): void {
    if (this.state.authState === "authenticated" && this.state.credentialType === "api_key") {
      // Keep the API-key credential as the recorded domain — both are valid;
      // the API key remains the stronger/machine credential.
      return;
    }
    if (this.state.authState !== "authenticated" || this.state.credentialType !== "oauth_token") {
      this.setState({ ...this.state, authState: "authenticated", credentialType: "oauth_token" });
    }
  }

  /**
   * Logout: clear credentials and return to anonymous.
   */
  async logout(configDir: string): Promise<void> {
    await this.clearCredentials(configDir);
    try {
      await unlink(join(configDir, "search-engines.json"));
    } catch {
      // Ignore if it doesn't exist
    }
    this.setState({ authState: "anonymous" });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private setState(newState: ConnectorState): void {
    const prevState = this.state;
    this.state = { ...newState };

    const changed =
      prevState.authState !== newState.authState ||
      prevState.credentialType !== newState.credentialType ||
      prevState.email !== newState.email ||
      prevState.apiKeyMask !== newState.apiKeyMask;

    if (changed) {
      this.logger.debug(`State updated: authState=${newState.authState}, email=${newState.email}`);
      this.fireListeners();
    }
  }

  private fireListeners(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        this.logger.error("State change listener error", err);
      }
    }
  }

  private async loadCredentials(configDir: string): Promise<CredentialFile | null> {
    try {
      const filePath = join(configDir, CREDENTIAL_FILENAME);
      const raw = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || typeof parsed.api_key !== "string" || !parsed.api_key.trim()) {
        return null;
      }
      return {
        api_key: String(parsed.api_key).trim(),
        email: typeof parsed.email === "string" ? parsed.email.trim() : "",
        saved_at: typeof parsed.saved_at === "string" ? parsed.saved_at : "",
      };
    } catch {
      return null;
    }
  }

  private async clearCredentials(configDir: string): Promise<void> {
    try {
      const filePath = join(configDir, CREDENTIAL_FILENAME);
      await unlink(filePath);
      this.logger.debug(`Credentials cleared from ${filePath}`);
    } catch {
      // File may not exist — that's fine
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  if (!key || key.length < 8) {
    return "***";
  }
  const prefix = key.slice(0, Math.min(8, key.length));
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
