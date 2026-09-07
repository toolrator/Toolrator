#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Shared helpers for toolhub integration evaluations (quality + perf).
// Extracted from tests/search-eval.mjs so both evals boot, seed and query
// the same real toolhub instance identically.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(SCRIPT_DIR, "..");
export const FIXTURES_DIR = path.join(SCRIPT_DIR, "fixtures");
export const CATALOG_PATH = path.join(FIXTURES_DIR, "mockup-catalog.json");
export const REAL_CATALOG_PATH = path.join(FIXTURES_DIR, "real", "catalog.json");
export const REAL_QUERIES_PATH = path.join(FIXTURES_DIR, "real-queries.json");
export const REAL_BASELINE_PATH = path.join(FIXTURES_DIR, "search-eval-baseline-real.json");

// ---------------------------------------------------------------------------
// Toolhub server lifecycle
// ---------------------------------------------------------------------------

export function serverCommand() {
  const distEntry = path.join(PKG_ROOT, "dist", "server.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry], label: "dist/server.js" };
  }
  const tsxCli = path.join(PKG_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const srcEntry = path.join(PKG_ROOT, "src", "server.ts");
  if (fs.existsSync(tsxCli)) {
    return { cmd: process.execPath, args: [tsxCli, srcEntry], label: "tsx src/server.ts" };
  }
  throw new Error("No server entry found: build first (dist/server.js) or install tsx.");
}

/**
 * Spawns a toolhub server instance. The returned child exposes
 * `child.serverLog` (stdout lines) and `child.serverErrLog` (stderr lines)
 * for evaluation scripts that need to inspect server output.
 */
export function startServer({ port, meiliUrl, adminToken, extraEnv = {} }) {
  const { cmd, args, label } = serverCommand();
  console.log(`[eval] Starting toolhub via ${label} on port ${port} (meili: ${meiliUrl})`);
  const child = spawn(cmd, args, {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(port),
      SEARCH_BACKEND: "meilisearch",
      MEILI_URL: meiliUrl,
      SEARCH_ADMIN_TOKEN: adminToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.serverLog = [];
  child.serverErrLog = [];
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) {
        child.serverLog.push(line);
        console.log(`[toolhub] ${line}`);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) {
        child.serverErrLog.push(line);
        console.error(`[toolhub:err] ${line}`);
      }
    }
  });
  return child;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForHealth(baseUrl, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") return body;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(1000);
  }
  throw new Error(`toolhub not healthy within ${timeoutMs}ms (last error: ${lastErr?.message ?? "unknown"})`);
}

// ---------------------------------------------------------------------------
// Catalog seeding through the admin API
// ---------------------------------------------------------------------------

export async function seedCatalog(baseUrl, adminToken, catalogPath = CATALOG_PATH) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const documents = catalog.map((entry) => ({
    mcp_name: entry.mcp_name,
    display_name: entry.display_name,
    description: entry.description,
    tags: entry.tags,
    provider: entry.provider,
    docs_url: entry.docs_url,
    homepage_url: entry.homepage_url,
    capabilities: { tools: entry.tools },
  }));
  const payload = JSON.stringify({ documents });
  const url = new URL(`${baseUrl}/admin/reindex`);
  const t0 = Date.now();
  const body = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${adminToken}`,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`catalog reindex failed: HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`catalog reindex response not JSON: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  if (body.indexed !== documents.length) {
    throw new Error(`catalog reindex incomplete: ${JSON.stringify(body)}`);
  }
  console.log(`[eval] Seeded catalog in ${elapsedSec}s: ${body.indexed} documents indexed, ${body.skipped} skipped`);
  return body;
}

// ---------------------------------------------------------------------------
// Baseline handling
// ---------------------------------------------------------------------------

export function readBaseline(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeBaseline(file, data) {
  const baseline = { updatedAt: new Date().toISOString(), ...data };
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`[eval] Baseline ${file}`);
  return baseline;
}