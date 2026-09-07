#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Download a realistic MCP-server benchmark catalog from the public Smithery
// registry (https://registry.smithery.ai) and adapt it to the toolhub
// fixture format (mockup-catalog.json shape).
//
// The data is authentic: real server names, descriptions and tool schemas as
// published by the MCP server authors. It is fetched on demand and NOT
// committed to the repository — treat it as a local benchmark artifact.
//
// Usage:
//   node tests/tools/fetch-smithery-catalog.mjs [options]
//
// Options:
//   --max-servers <n>   servers to keep after filtering/sorting (default 400)
//   --min-tools <n>     drop servers with fewer than n tools (default 1)
//   --max-list-pages <n> limit list pagination (0 = all, default 0) — for tests
//   --delay-ms <n>      polite delay between requests (default 150)
//   --out <path>        output catalog file (default tests/fixtures/real/catalog.json)
//
// Env:
//   SMITHERY_LIST_PAGE_SIZE  list page size (default 100)
//
// Selection policy (deterministic): the API pages by useCount desc (max 5
// pages x 100 = the 500 most-used servers). From those, keep unique entries
// sorted by useCount desc then qualifiedName asc, capped at --max-servers.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_OUT = path.join(PKG_ROOT, "tests", "fixtures", "real", "catalog.json");

const API_BASE = "https://registry.smithery.ai";
const MAX_TOOLS_PER_SERVER = 64; // matches TOOLHUB_MAX_TOOLS_EMBEDDED

const args = {
  maxServers: 400,
  minTools: 1,
  maxListPages: 0,
  delayMs: 150,
  out: DEFAULT_OUT,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--max-servers") args.maxServers = Number(process.argv[++i]);
  else if (a === "--min-tools") args.minTools = Number(process.argv[++i]);
  else if (a === "--max-list-pages") args.maxListPages = Number(process.argv[++i]);
  else if (a === "--delay-ms") args.delayMs = Number(process.argv[++i]);
  else if (a === "--out") args.out = path.resolve(process.argv[++i]);
  else throw new Error(`Unknown argument: ${a}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt <= retries) {
      const retryAfter = Number(res.headers.get("retry-after") || 0) || 2000 * attempt;
      console.warn(`[fetch] 429 on ${url} — backing off ${retryAfter}ms (attempt ${attempt}/${retries})`);
      await sleep(retryAfter);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

async function fetchList() {
  const pageSize = Number(process.env.SMITHERY_LIST_PAGE_SIZE || 100);
  const all = [];
  let page = 1;
  let total = null;
  while (true) {
    const url = `${API_BASE}/servers?page=${page}&pageSize=${pageSize}`;
    const body = await getJson(url);
    all.push(...body.servers);
    total = body.pagination.totalCount;
    if (page >= body.pagination.totalPages) break;
    if (args.maxListPages > 0 && page >= args.maxListPages) break;
    page++;
    await sleep(args.delayMs);
  }
  return { all, total };
}

async function fetchDetail(qualifiedName) {
  const url = `${API_BASE}/servers/${encodeURIComponent(qualifiedName)}`;
  const body = await getJson(url);
  return body;
}

function sanitizeText(text, cap) {
  if (!text || typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim().slice(0, cap);
}

function toEntry(server, detail) {
  const namespace = sanitizeText(server.namespace, 64) || "smithery";
  const displayName = sanitizeText(server.displayName, 120) || server.qualifiedName;
  const tools = (detail.tools ?? [])
    .filter((t) => t && typeof t.name === "string" && t.name.trim())
    .slice(0, MAX_TOOLS_PER_SERVER)
    .map((t) => ({
      name: sanitizeText(t.name, 200),
      description: sanitizeText(t.description, 1200),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {} },
    }));
  return {
    slug: server.qualifiedName.split("/").filter(Boolean).join("-") || server.qualifiedName,
    mcp_name: server.qualifiedName,
    display_name: displayName,
    description: sanitizeText(server.description, 4096),
    tags: [namespace, ...(detail.verified ? ["verified"] : [])],
    provider: namespace,
    docs_url: null,
    homepage_url: server.homepage ? server.homepage : null,
    base_path: null,
    tools,
  };
}

async function main() {
  console.log(`[fetch] Walking list (maxPages=${args.maxListPages || "all"})...`);
  const { all, total } = await fetchList();
  console.log(`[fetch] Listed ${all.length}/${total} servers`);

  const byKey = new Map();
  for (const s of all) if (!byKey.has(s.qualifiedName)) byKey.set(s.qualifiedName, s);
  const unique = [...byKey.values()];

  const verified = unique
    .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName));

  const selected = verified.slice(0, args.maxServers);
  console.log(`[fetch] unique=${unique.length} (API pages cap the list at ~500), keeping ${selected.length} (max ${args.maxServers})`);

  const entries = [];
  const skipped = { noDetail: 0, noTools: 0 };
  let i = 0;
  for (const s of selected) {
    i++;
    try {
      const detail = await fetchDetail(s.qualifiedName);
      const entry = toEntry(s, detail);
      if (entry.tools.length < args.minTools) {
        skipped.noTools++;
        continue;
      }
      entries.push(entry);
      console.log(`[fetch] [${i}/${selected.length}] ${entry.mcp_name} (${entry.tools.length} tools)`);
    } catch (err) {
      skipped.noDetail++;
      console.warn(`[fetch] detail failed for ${s.qualifiedName}: ${err.message}`);
    }
    await sleep(args.delayMs);
  }

  if (entries.length === 0) throw new Error("No entries produced — nothing to write.");

  const catalog = entries.sort((a, b) => a.mcp_name.localeCompare(b.mcp_name));
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(catalog, null, 2) + "\n");

  const provenancePath = path.join(path.dirname(args.out), "provenance.json");
  fs.writeFileSync(
    provenancePath,
    JSON.stringify(
      {
        source: "Smithery public registry API",
        sourceUrl: `${API_BASE}/servers`,
        fetchedAt: new Date().toISOString(),
        totalListed: total,
        totalUnique: unique.length,
        apiPageCap: 500,
        requested: args.maxServers,
        delivered: catalog.length,
        skipped,
        toolsIndexed: catalog.reduce((n, e) => n + e.tools.length, 0),
        selection: "unique records from the API list (sorted by useCount desc then qualifiedName asc, capped at max-servers)",
        notice: "Data is authentic MCP server metadata from Smithery/the respective authors. For local benchmarking only; not redistributed.",
      },
      null,
      2
    ) + "\n"
  );

  const toolCount = catalog.reduce((n, e) => n + e.tools.length, 0);
  console.log(`[fetch] Wrote ${catalog.length} servers / ${toolCount} tools -> ${args.out}`);
  console.log(`[fetch] Provenance -> ${provenancePath}`);
}

main().catch((err) => {
  console.error(`[fetch] FAILED: ${err.stack || err.message}`);
  process.exit(1);
});