import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "./config.js";

export const schemaTimestamps = {
  lastUpdated: 0,
  lastFetched: Date.now(),
};

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type AuthState = "anonymous" | "device_flow_pending" | "authenticated";

export interface ConnectorState {
  authState: AuthState;
  email?: string;
  apiKeyMask?: string;
  apiKey?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  deviceFlowExpiresAt?: number;
}

type StateChangeCallback = () => void;

// ---------------------------------------------------------------------------
// Credential File Schema
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
        apiKey: envApiKey,
        apiKeyMask: maskKey(envApiKey),
      });
      return;
    }

    // Priority 2: saved credentials
    try {
      const creds = await this.loadCredentials(configDir);
      if (creds) {
        this.logger.info(`Loaded saved credentials for ${creds.email}`);
        this.setState({
          authState: "authenticated",
          apiKey: creds.api_key,
          apiKeyMask: maskKey(creds.api_key),
          email: creds.email,
        });
        return;
      }
    } catch {
      this.logger.debug("No saved credentials found");
    }

    // Priority 3: anonymous
    this.logger.info("Starting in anonymous mode");
    this.setState({ authState: "anonymous" });
  }

  beginDeviceFlow(
    deviceCode: string,
    userCode: string,
    verificationUri: string,
    expiresInSeconds: number,
  ): void {
    this.setState({
      authState: "device_flow_pending",
      deviceCode,
      userCode,
      verificationUri,
      deviceFlowExpiresAt: Date.now() + expiresInSeconds * 1000,
    });
  }

  /**
   * Complete authentication after 2FA verification succeeds.
   */
  async completeAuthentication(
    configDir: string,
    apiKey: string,
    email: string,
  ): Promise<void> {
    await this.saveCredentials(configDir, apiKey, email);
    this.setState({
      authState: "authenticated",
      apiKey,
      apiKeyMask: maskKey(apiKey),
      email,
    });
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
      prevState.email !== newState.email ||
      prevState.apiKeyMask !== newState.apiKeyMask ||
      prevState.deviceCode !== newState.deviceCode ||
      prevState.userCode !== newState.userCode;

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

  async saveCredentials(configDir: string, apiKey: string, email: string): Promise<void> {
    try {
      await mkdir(configDir, { recursive: true });
      const payload: CredentialFile = {
        api_key: apiKey,
        email,
        saved_at: new Date().toISOString(),
      };
      const filePath = join(configDir, CREDENTIAL_FILENAME);
      await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
      this.logger.debug(`Credentials saved to ${filePath}`);
    } catch (err) {
      this.logger.warn(`Failed to save credentials: ${String(err)}`);
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
