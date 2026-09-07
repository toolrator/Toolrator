/**
 * Mock Auth Simulator
 *
 * Lightweight Hono HTTP server simulating the upstream auth service (the same
 * contract toolpanel implements) — i.e. the device-flow endpoints surfaced
 * by toolconnector's `manage_auth` tool:
 *   POST /v1/auth/login   — initiate login, create 2FA session
 *   POST /v1/auth/verify  — submit 2FA code, return API key
 *   GET  /health           — health check
 *
 * Test credentials:
 *   password: "testpassword"
 *   2FA code: "123456"
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_PASSWORD = "testpassword";
const TEST_2FA_CODE = "123456";
const SESSION_TTL_SECONDS = 3600; // 1 hour

// ---------------------------------------------------------------------------
// In-Memory State
// ---------------------------------------------------------------------------

interface PendingSession {
  email: string;
  expectedCode: string;
  expiresAt: number; // epoch ms
  apiKeyToReturn: string;
}

const pendingSessions = new Map<string, PendingSession>();

interface PendingDeviceCode {
  deviceCode: string;
  userCode: string;
  status: "pending" | "success" | "expired";
  expiresAt: number;
  apiKey: string;
  email: string;
}

const pendingDeviceCodes = new Map<string, PendingDeviceCode>();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createMockAuthApp(testApiKey: string): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "mock-auth-sim" }));

  app.get("/api/search", (c) => {
    return c.json({
      hits: [],
      total: 0,
      offset: 0,
      limit: 10,
      toolHits: [
        {
          name: "echo",
          description: "Echoes input",
          inputSchema: { type: "object" },
          compactSchema: "hello (string)",
          server_mcp_name: "acme/free-mcp",
          server_provider: "acme",
          server_tags: ["free", "test"],
          server_health_status: "healthy",
          server_health_last_checked: new Date().toISOString(),
        }
      ]
    });
  });

  // POST /api/auth/device/start
  app.post("/api/auth/device/start", (c) => {
    const deviceCode = `dev_${Math.random().toString(36).substring(2, 14)}`;
    const userCode = `TEST-1234`;
    const session: PendingDeviceCode = {
      deviceCode,
      userCode,
      status: "pending",
      expiresAt: Date.now() + 1800 * 1000,
      apiKey: testApiKey,
      email: "test@example.com",
    };
    pendingDeviceCodes.set(deviceCode, session);
    pendingDeviceCodes.set(userCode, session);

    return c.json({
      verification_uri: `http://127.0.0.1:${c.req.url.split("/")[2]}/device`,
      user_code: userCode,
      device_code: deviceCode,
      expires_in: 1800,
    });
  });

  // POST /api/auth/device/poll
  app.post("/api/auth/device/poll", async (c) => {
    const { device_code } = await c.req.json<{ device_code?: string }>();
    const session = pendingDeviceCodes.get(device_code || "");
    if (!session) {
      return c.json({ status: "expired" });
    }
    if (Date.now() > session.expiresAt) {
      pendingDeviceCodes.delete(device_code!);
      return c.json({ status: "expired" });
    }
    if (session.status === "success") {
      pendingDeviceCodes.delete(device_code!);
      return c.json({
        status: "success",
        api_key: session.apiKey,
        email: session.email,
      });
    }
    return c.json({ status: session.status });
  });

  // POST /api/auth/device/confirm
  app.post("/api/auth/device/confirm", async (c) => {
    const { user_code } = await c.req.json<{ user_code?: string }>();
    const session = pendingDeviceCodes.get((user_code || "").toUpperCase());
    if (!session) {
      return c.json({ error: "invalid_code" }, 400);
    }
    session.status = "success";
    return c.json({ success: true });
  });

  // POST /v1/auth/login
  app.post("/v1/auth/login", async (c) => {
    const body = await c.req.json<{ email?: string; password?: string }>();

    if (!body.email || !body.password) {
      return c.json({ error: "email and password are required" }, 400);
    }

    if (body.password !== TEST_PASSWORD) {
      return c.json({ error: "invalid credentials" }, 401);
    }

    // Create a pending 2FA session
    const sessionToken = `session_${Math.random().toString(36).substring(2, 14)}`;
    pendingSessions.set(sessionToken, {
      email: body.email,
      expectedCode: TEST_2FA_CODE,
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
      apiKeyToReturn: testApiKey,
    });

    return c.json({
      session_token: sessionToken,
      expires_in_seconds: SESSION_TTL_SECONDS,
    });
  });

  // POST /v1/auth/verify
  app.post("/v1/auth/verify", async (c) => {
    const body = await c.req.json<{ code?: string; session_token?: string }>();

    if (!body.code || !body.session_token) {
      return c.json({ error: "code and session_token are required" }, 400);
    }

    const session = pendingSessions.get(body.session_token);
    if (!session) {
      return c.json({ error: "invalid or expired session" }, 401);
    }

    if (Date.now() > session.expiresAt) {
      pendingSessions.delete(body.session_token);
      return c.json({ error: "2FA session has expired" }, 410);
    }

    if (body.code !== session.expectedCode) {
      return c.json({ error: "invalid 2FA code" }, 401);
    }

    // Success — clean up and return API key
    pendingSessions.delete(body.session_token);

    return c.json({
      api_key: session.apiKeyToReturn,
      email: session.email,
    });
  });

  return app;
}

/**
 * Start the mock auth server on the given port.
 * Returns an object with the base URL and a close function.
 */
export async function startMockAuthServer(
  port: number,
  testApiKey: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = createMockAuthApp(testApiKey);

  return new Promise((resolve) => {
    const serverInstance = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port },
      () => {
        const baseUrl = `http://127.0.0.1:${port}`;
        resolve({
          baseUrl,
          close: () =>
            new Promise<void>((res, rej) => {
              serverInstance.close((err?: Error) => {
                if (err) rej(err);
                else res();
              });
            }),
        });
      },
    );
  });
}
