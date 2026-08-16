import type { Logger } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeviceFlowStartResponse {
  verification_uri: string;
  user_code: string;
  device_code: string;
  expires_in: number;
}

interface DeviceFlowPollResponse {
  status: "pending" | "success" | "expired";
  api_key?: string;
  email?: string;
}

// ---------------------------------------------------------------------------
// Auth Client (device-flow login)
// ---------------------------------------------------------------------------
//
// Handles authentication against the configured account/backend upstream
// (CONNECTOR_UPSTREAM_URL / authUrl). This client deals only with login,
// API-key issuance, and credential state.

export class AuthClient {
  private readonly logger: Logger;
  private apiKey: string = "";
  private baseUrl: string;

  /**
   * Constructs an AuthClient pinned to the *resolved* upstream URL (toolpanel
   * when alive, else the configured `CONNECTOR_UPSTREAM_URL`). The caller is expected
   * to have already run `pickRemoteBaseUrl` and passed the resulting baseUrl.
   *
   * The `authUrl` parameter is retained for diagnostic / description
   * surfaces (so callers can still report what the env originally pointed
   * at, vs. what is currently being talked to).
   *
   * Use `setUpstream()` to re-pin at runtime (e.g. after a re-resolve).
   */
  constructor(baseUrl: string, _authUrl: string, logger: Logger) {
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  /** The currently-pinned upstream URL this client talks to. */
  get upstreamUrl(): string {
    return this.baseUrl;
  }

  /** Re-pin the client to a different upstream after a re-resolve. */
  setUpstream(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  clearApiKey(): void {
    this.apiKey = "";
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async startDeviceFlow(): Promise<DeviceFlowStartResponse> {
    const url = `${this.baseUrl}/api/auth/device/start`;
    this.logger.debug(`Start device flow: ${url}`);

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to start device flow (${response.status}): ${body}`);
    }

    return (await response.json()) as DeviceFlowStartResponse;
  }

  async pollDeviceFlow(deviceCode: string): Promise<DeviceFlowPollResponse> {
    const url = `${this.baseUrl}/api/auth/device/poll`;
    this.logger.debug(`Poll device flow: ${url}`);

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to poll device flow (${response.status}): ${body}`);
    }

    return (await response.json()) as DeviceFlowPollResponse;
  }

  // -------------------------------------------------------------------------
  // HTTP Helpers
  // -------------------------------------------------------------------------

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 30_000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
