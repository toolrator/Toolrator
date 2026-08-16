#!/usr/bin/env node

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { config } from "./config.js";
import { auth } from "./routes/auth.js";
import { connector } from "./routes/connector.js";
import { search } from "./routes/search.js";
import { landing } from "./routes/landing.js";
import { panelConnector } from "./routes/panel-connector.js";
import { panelSearch } from "./routes/panel-search.js";
import { panelSearchAdmin } from "./routes/panel-search-admin.js";
import { status } from "./routes/status.js";
import { wellKnown } from "./routes/well-known.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const app = new Hono();

// Static assets at /static/*
app.get("/static/*", async (c) => {
  const rel = c.req.path.replace(/^\/static\//, "");
  // Prevent path traversal
  const safe = rel.replace(/\\/g, "/").replace(/(\.{1,2}\/)+/g, "");
  if (!safe || safe.includes("..")) return c.notFound();
  const abs = join(publicDir, safe);
  try {
    const buf = await readFile(abs);
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" },
    });
  } catch {
    return c.notFound();
  }
});

app.route("/", wellKnown);
app.route("/", auth);
app.route("/", connector);
app.route("/", search);
app.route("/", status);
app.route("/", landing);
app.route("/", panelConnector);
app.route("/", panelSearch);
app.route("/", panelSearchAdmin);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[toolpanel] unhandled:", err);
  return c.json({ error: "server_error", message: (err as Error).message }, 500);
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`\n  Toolpanel`);
  console.log(`  → http://${config.host}:${info.port}`);
  console.log(`  → public URL: ${config.publicUrl}`);
  console.log(`  → liveness:  ${config.publicUrl}/.well-known/toolpanel-alive`);
  console.log(`  → search engine: ${config.searchEngineBaseUrl}`);
  console.log(`  → config dir: ${config.configDir}\n`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.warn(`  WARNING: toolpanel has NO authentication; binding HOST=${config.host} exposes it.\n`);
  }
});
