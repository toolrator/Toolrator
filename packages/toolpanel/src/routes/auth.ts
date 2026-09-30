import { Hono } from "hono";
import type { Context } from "hono";
import { recordVerifyKey } from "../whoami.js";

export const auth = new Hono();

async function readBodyJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// verify-key
// ---------------------------------------------------------------------------

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
