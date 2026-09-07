#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Toolhub search-quality evaluation (integration test)
// ---------------------------------------------------------------------------
// Boots a real toolhub instance against MeiliSearch, seeds the reference
// mockup catalog through the admin API, runs 32 server-surface queries plus
// 16 tool-surface queries and asserts the scores against a checked-in
// moving baseline (server weighted/p@3, tool p@3, intent accuracy).
//
// Usage:
//   node tests/search-eval.mjs [--baseline <file>] [--report <file>]
//                              [--tolerance <points>] [--update-baseline]
//                              [--catalog mock|real|<path>]
//
//   --catalog mock  checked-in 32-server synthetic fixture (default)
//   --catalog real  on-demand Smithery benchmark (tests/fixtures/real/catalog.json
//                   + tests/fixtures/real-queries.json). Generate it with:
//                     node tests/tools/fetch-smithery-catalog.mjs
//   --catalog <path>  any toolhub fixture catalog (uses real-queries.json)
//
// Env:
//   TOOLHUB_PORT          port for the spawned toolhub (default 7600)
//   MEILI_URL             MeiliSearch URL (default http://127.0.0.1:7700)
//   SEARCH_ADMIN_TOKEN    admin bearer token (default dev-admin-token)
//   TOOLHUB_EMBEDDING_PROVIDER  embedding provider (baselines are per provider)
//
// Exit codes:
//   0  pass (or baseline bootstrapped)
//   1  regression vs baseline, seed failure, or runtime error
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import {
  FIXTURES_DIR,
  CATALOG_PATH,
  REAL_CATALOG_PATH,
  REAL_QUERIES_PATH,
  REAL_BASELINE_PATH,
  startServer,
  waitForHealth,
  seedCatalog,
  readBaseline,
  writeBaseline,
} from "./eval-utils.mjs";

const DEFAULT_BASELINE = path.join(FIXTURES_DIR, "search-eval-baseline.json");

const LIMIT = 3;
// rank -> points (per query)
const POINTS = { 1: 1.0, 2: 0.6, 3: 0.35 };

// Tool-surface queries: ranked against `toolHits` (tool docs are never
// returned in `hits`; the server surface rolls tool evidence up).
const TOOL_QUERIES = [
  { q: "what is the uv index right now in berlin", targetTool: "get_uv_index", targetServer: "mock/weather-service" },
  { q: "post a message to the dev channel in slack", targetTool: "post_message", targetServer: "mock/slack-workspace" },
  { q: "generate an image of a cat in a space suit", targetTool: "generate_image", targetServer: "mock/image-generator" },
  { q: "search the news for ai regulation articles", targetTool: "search_news", targetServer: "mock/news-aggregator" },
  { q: "find free time slots tomorrow for a two hour meeting", targetTool: "find_free_slots", targetServer: "mock/calendar-scheduler" },
  { q: "turn on the living room lights", targetTool: "control_device", targetServer: "mock/smart-home" },
  { q: "check the backlink profile of my competitor site", targetTool: "get_backlinks", targetServer: "mock/seo-audit" },
  { q: "search the wiki for our api guidelines page", targetTool: "search_pages", targetServer: "mock/wiki-docs" },
  { q: "shorten this url for my newsletter", targetTool: "shorten_url", targetServer: "mock/qr-tools" },
  { q: "log my lunch and count the calories", targetTool: "track_meal", targetServer: "mock/fitness-tracker" },
  { q: "search podcasts about stoicism", targetTool: "search_podcasts", targetServer: "mock/podcast-tools" },
  { q: "get the delivery logs of yesterday's push campaign", targetTool: "get_delivery_logs", targetServer: "mock/notification-hub" },
  { q: "translate this email into french", targetTool: "translate_text", targetServer: "mock/translator" },
  { q: "get nutrition facts for a grilled chicken salad", targetTool: "get_nutrition_info", targetServer: "mock/nutrition-tracker" },
  { q: "create a playlist with taylor swift's top songs", targetTool: "create_playlist", targetServer: "mock/music-discovery" },
  { q: "check if my password hash is in a breach dataset", targetTool: "check_password_breach", targetServer: "mock/security-scanner" },
];

const QUERIES = [
  { q: "my flight got cancelled, find me a hotel in Lisbon for tonight", target: "mock/travel-planner" },
  { q: "i want to buy dogecoin and bitcoin right now", target: "mock/crypto-prices" },
  { q: "how much calories does a hamburger have", target: "mock/nutrition-tracker" },
  { q: "any free time in my calendar tomorrow for a dentist appointment", target: "mock/calendar-scheduler" },
  { q: "summarize the long email thread about the Q3 budget", target: "mock/email-assistant" },
  { q: "check this python snippet for security problems", target: "mock/code-analyzer" },
  { q: "tell the dev team we deployed the fix", target: "mock/slack-workspace" },
  { q: "what's new in AI chip news this week", target: "mock/news-aggregator" },
  { q: "find me a good podcast about deep work", target: "mock/podcast-tools" },
  { q: "scan this link before i click it", target: "mock/security-scanner" },
  { q: "make a QR code for my cafe menu", target: "mock/qr-tools", intent: "tool" },
  { q: "how do i say thank you in Japanese", target: "mock/translator" },
  { q: "design a logo for my coffee startup", target: "mock/image-generator" },
  { q: "check the open rate of our last newsletter", target: "mock/marketing-studio" },
  { q: "find the contact info for Acme Corp sales", target: "mock/sales-crm" },
  { q: "which typescript mcp servers have the most stars", target: "mock/github-tools" },
  { q: "did i hit 10k steps today", target: "mock/fitness-tracker" },
  { q: "audit my website SEO and keyword rankings", target: "mock/seo-audit" },
  { q: "is the blue hoodie still in stock", target: "mock/shop-catalog" },
  { q: "how many visitors did my site get last month", target: "mock/web-analytics" },
  { q: "turn off the lights in the living room", target: "mock/smart-home" },
  { q: "what is the current price of apple stock", target: "mock/stock-market" },
  { q: "will it rain in Tokyo this weekend", target: "mock/weather-service" },
  { q: "how many users signed up last week", target: "mock/postgres-query" },
  { q: "write a wiki page documenting our API endpoints", target: "mock/wiki-docs" },
  { q: "find me a remote backend job", target: "mock/career-tools" },
  { q: "save the invoice pdf into my documents folder", target: "mock/file-storage" },
  { q: "send a push notification to all users about the maintenance", target: "mock/notification-hub" },
  { q: "put on some chill music for the party", target: "mock/music-discovery" },
  { q: "what is the player count of counter strike right now", target: "mock/game-library" },
  { q: "extract the main article from that blog post", target: "mock/web-scraper", intent: "tool" },
  { q: "what is the capital of Namibia", target: "mock/web-search" },
];

// ---------------------------------------------------------------------------
// Real-catalog mode: load queries from the on-demand Smithery benchmark.
// Queries whose targets are missing from the seeded catalog are dropped so a
// regenerated download (server drift) never hard-fails the gate.
// ---------------------------------------------------------------------------

function loadRealQueries() {
  if (!fs.existsSync(REAL_QUERIES_PATH)) {
    throw new Error(`Real-catalog queries not found: ${REAL_QUERIES_PATH}. Run the catalog fetch first.`);
  }
  const file = JSON.parse(fs.readFileSync(REAL_QUERIES_PATH, "utf8"));
  const serverQueries = Array.isArray(file.serverQueries) ? file.serverQueries : [];
  const toolQueries = Array.isArray(file.toolQueries) ? file.toolQueries : [];
  if (serverQueries.length + toolQueries.length < 3) {
    throw new Error("Real-catalog query set too small — expected >= 3 queries.");
  }
  return { QUERIES: serverQueries, TOOL_QUERIES: toolQueries };
}

function filterQueriesToCatalog(queries, toolQueries, catalog) {
  const servers = new Set(catalog.map((e) => e.mcp_name));
  const toolPairs = new Set(
    catalog.flatMap((e) => e.tools.map((t) => `${e.mcp_name}::${t.name}`))
  );
  const keepServer = queries.filter(
    (x) => servers.has(x.target) || (x.alternatives && x.alternatives.some((alt) => servers.has(alt)))
  );
  const keepTool = toolQueries.filter(
    (x) => toolPairs.has(`${x.targetServer}::${x.targetTool}`) || (x.alternatives && x.alternatives.some((alt) => toolPairs.has(alt)))
  );
  const dropped = queries.length - keepServer.length + toolQueries.length - keepTool.length;
  if (dropped > 0) {
    console.warn(`[eval] Dropped ${dropped} query(ies) whose targets are not in the seeded catalog (data drift).`);
  }
  return { QUERIES: keepServer, TOOL_QUERIES: keepTool };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Removes legacy flat-metric keys (and the old updatedAt, which
 * writeBaseline re-stamps) so provider-keyed baselines stay clean.
 */
function stripLegacy(file) {
  if (!file) return {};
  const next = { ...file };
  delete next.updatedAt;
  delete next.weighted;
  delete next.precisionAt1;
  delete next.precisionAt3;
  delete next.queries;
  return next;
}

function parseArgs(argv) {
  const args = { baseline: DEFAULT_BASELINE, report: path.join(process.cwd(), "search-eval-report.json"), tolerance: 0.5, updateBaseline: false, catalog: "mock" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--baseline") args.baseline = path.resolve(argv[++i]);
    else if (arg === "--report") args.report = path.resolve(argv[++i]);
    else if (arg === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (arg === "--update-baseline") args.updateBaseline = true;
    else if (arg === "--catalog") args.catalog = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.tolerance) || args.tolerance < 0) {
    throw new Error(`Invalid --tolerance: ${args.tolerance}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Search + scoring
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSearch(url, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(`[eval] search retry ${attempt}/${retries} for ${url}: ${err.message}`);
      await sleep(5000 * attempt);
    }
  }
}

async function runQueries(baseUrl, { queries, toolQueries }) {
  const results = [];
  const toolResults = [];
  let totalPoints = 0;
  let hit1 = 0;
  let hit3 = 0;
  let toolTotalPoints = 0;
  let toolHit1 = 0;
  let toolHit3 = 0;
  let intentCorrect = 0;
  let intentTotal = 0;
  let toolEvidence = 0;
  let falseTool = 0;

  for (const { q, target, intent, alternatives } of queries) {
    const url = `${baseUrl}/search?q=${encodeURIComponent(q)}&limit=${LIMIT}`;
    const data = await fetchSearch(url);
    const hits = data.hits ?? [];
    const toolHits = data.toolHits ?? [];

    const validTargets = [target, ...(alternatives || [])];
    const rank = hits.findIndex((h) => validTargets.includes(h.mcp_name)) + 1;
    const points = rank > 0 ? (POINTS[rank] ?? 0) : 0;
    totalPoints += points;
    if (rank === 1) hit1++;
    if (rank > 0 && rank <= 3) hit3++;

    const expectedIntent = intent ?? "server";
    const actualIntent = data.intent ?? "server";
    intentTotal++;
    if (actualIntent === expectedIntent) intentCorrect++;
    if (toolHits.length > 0) toolEvidence++;
    if (expectedIntent === "server" && actualIntent === "tool") falseTool++;

    results.push({
      query: q,
      target: validTargets.length > 1 ? `${target} (+${validTargets.length - 1} alts)` : target,
      rank: rank === 0 ? null : rank,
      points,
      intent: actualIntent,
      expectedIntent,
      intentConfidence: data.intentConfidence ?? null,
      toolHits: toolHits.length,
      top: hits.map((h, i) => `${i + 1}.${h.mcp_name}`).join(" | "),
    });
  }

  for (const { q, targetTool, targetServer, intent, alternatives } of toolQueries) {
    const url = `${baseUrl}/search?q=${encodeURIComponent(q)}&limit=${LIMIT}`;
    const data = await fetchSearch(url);
    const toolHits = data.toolHits ?? [];

    const primaryKey = `${targetServer}::${targetTool}`;
    const validToolKeys = [primaryKey, ...(alternatives || [])];
    const rank = toolHits.findIndex((h) => {
      const key = `${h.server_mcp_name}::${h.name}`;
      return validToolKeys.includes(key);
    }) + 1;

    const points = rank > 0 ? (POINTS[rank] ?? 0) : 0;
    toolTotalPoints += points;
    if (rank === 1) toolHit1++;
    if (rank > 0 && rank <= 3) toolHit3++;

    const expectedIntent = intent ?? "tool";
    const actualIntent = data.intent ?? "server";
    intentTotal++;
    if (actualIntent === expectedIntent) intentCorrect++;

    toolResults.push({
      query: q,
      target: validToolKeys.length > 1 ? `${primaryKey} (+${validToolKeys.length - 1} alts)` : primaryKey,
      rank: rank === 0 ? null : rank,
      points,
      intent: actualIntent,
      expectedIntent,
      intentConfidence: data.intentConfidence ?? null,
      toolHits: toolHits.length,
      top: toolHits.map((h, i) => `${i + 1}.${h.server_mcp_name}::${h.name}`).join(" | "),
    });
  }

  for (const r of [...results, ...toolResults]) {
    const mark = r.rank === 1 ? "HIT1" : r.rank === 2 ? "hit2" : r.rank === 3 ? "hit3" : "MISS";
    console.log(`[${mark}] rank=${r.rank ?? "-"} intent=${r.intent} ${r.query}`);
    console.log(`       expected: ${r.target}`);
    console.log(`       top:      ${r.top}`);
  }

  const n = queries.length;
  const tn = toolQueries.length;
  return {
    results,
    toolResults,
    metrics: {
      weighted: Math.round((totalPoints / n) * 100),
      precisionAt1: Math.round((hit1 / n) * 10000) / 10000,
      precisionAt3: Math.round((hit3 / n) * 10000) / 10000,
      queries: n,
      toolWeighted: Math.round((toolTotalPoints / tn) * 100),
      toolPrecisionAt1: Math.round((toolHit1 / tn) * 10000) / 10000,
      toolPrecisionAt3: Math.round((toolHit3 / tn) * 10000) / 10000,
      toolQueries: tn,
      intentAccuracy: Math.round((intentCorrect / intentTotal) * 100),
      toolEvidenceRate: Math.round((toolEvidence / n) * 100),
      falseToolRate: Math.round((falseTool / n) * 100),
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(process.env.TOOLHUB_PORT || 7600);
  const meiliUrl = process.env.MEILI_URL || "http://127.0.0.1:7700";
  const adminToken = process.env.SEARCH_ADMIN_TOKEN || "dev-admin-token";
  const baseUrl = `http://127.0.0.1:${port}`;

  // Embedding provider is REQUIRED for this eval — deliberately no default
  // (the old fallback silently ran the local ONNX model, a RAM hog on
  // real-scale catalogs). Export it or run with --env-file-if-exists=.env.
  const provider = process.env.TOOLHUB_EMBEDDING_PROVIDER;
  if (!provider) {
    console.error(
      "[eval] TOOLHUB_EMBEDDING_PROVIDER must be set explicitly (e.g. openai-compatible or local) — no default provider."
    );
    process.exit(1);
  }

  // Resolve catalog + queries. "real" (or a path) selects the on-demand
  // Smithery benchmark; anything else runs the checked-in mockup catalog.
  const realMode = args.catalog === "real" || (args.catalog !== "mock" && fs.existsSync(args.catalog));
  const catalogPath = realMode ? (args.catalog === "real" ? REAL_CATALOG_PATH : args.catalog) : CATALOG_PATH;
  if (realMode && !fs.existsSync(catalogPath)) {
    throw new Error(`Real catalog not found: ${catalogPath}. Run tests/tools/fetch-smithery-catalog.mjs first.`);
  }
  if (realMode && !args.baseline?.includes("baseline-real") && args.baseline === DEFAULT_BASELINE) {
    args.baseline = REAL_BASELINE_PATH;
  }

  const child = startServer({ port, meiliUrl, adminToken });
  let failed = false;
  try {
    await waitForHealth(baseUrl);
    const seedBody = await seedCatalog(baseUrl, adminToken, catalogPath);

    let queries = QUERIES;
    let toolQueries = TOOL_QUERIES;
    if (realMode) {
      const real = loadRealQueries();
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      ({ QUERIES: queries, TOOL_QUERIES: toolQueries } = filterQueriesToCatalog(real.QUERIES, real.TOOL_QUERIES, catalog));
    }

    const tQueriesStart = Date.now();
    const { results, toolResults, metrics } = await runQueries(baseUrl, { queries, toolQueries });
    const queriesDurationSec = ((Date.now() - tQueriesStart) / 1000).toFixed(1);

    console.log("\n=================================================");
    console.log(`catalog: ${realMode ? catalogPath : "mockup-catalog (synthetic)"} (${seedBody.indexed} servers)`);
    console.log(`query benchmark duration: ${queriesDurationSec}s (${(Number(queriesDurationSec) / (queries.length + toolQueries.length)).toFixed(2)}s/query avg)`);
    console.log(`server queries: ${metrics.queries}`);
    console.log(`  precision@1:  ${(metrics.precisionAt1 * metrics.queries).toFixed(0)}/${metrics.queries} (${(metrics.precisionAt1 * 100).toFixed(0)}%)`);
    console.log(`  precision@3:  ${(metrics.precisionAt3 * metrics.queries).toFixed(0)}/${metrics.queries} (${(metrics.precisionAt3 * 100).toFixed(0)}%)`);
    console.log(`  weighted:     ${metrics.weighted}/100 (rank1=1.0, rank2=0.6, rank3=0.35)`);
    console.log(`tool queries:  ${metrics.toolQueries}`);
    console.log(`  precision@1:  ${(metrics.toolPrecisionAt1 * metrics.toolQueries).toFixed(0)}/${metrics.toolQueries} (${(metrics.toolPrecisionAt1 * 100).toFixed(0)}%)`);
    console.log(`  precision@3:  ${(metrics.toolPrecisionAt3 * metrics.toolQueries).toFixed(0)}/${metrics.toolQueries} (${(metrics.toolPrecisionAt3 * 100).toFixed(0)}%)`);
    console.log(`  weighted:     ${metrics.toolWeighted}/100`);
    console.log(`intent accuracy: ${metrics.intentAccuracy}% (per-query expected intent)`);
    console.log(`tool evidence rate: ${metrics.toolEvidenceRate}% of server queries had tool hits`);
    console.log(`false tool intent:  ${metrics.falseToolRate}% of server queries classified as tool`);
    console.log("=================================================\n");

    // Baselines are keyed per provider AND model: different models embed into
    // different vector spaces, so their scores are not comparable.
    const remoteModel = process.env.TOOLHUB_EMBEDDING_MODEL || "text-embedding-3-small";
    const baselineKey = provider === "local" ? "local" : `${provider}/${remoteModel}`;
    const baselineFile = readBaseline(args.baseline);
    let baseline = baselineFile?.[baselineKey] ?? null;
    if (
      !baseline &&
      baselineFile &&
      provider === "local" &&
      typeof baselineFile.weighted === "number"
    ) {
      // Pre-provider baseline file (flat metrics) — treat as the local section
      // and migrate the file to provider-keyed sections immediately.
      baseline = baselineFile;
      writeBaseline(args.baseline, {
        ...stripLegacy(baselineFile),
        local: {
          weighted: baseline.weighted,
          precisionAt1: baseline.precisionAt1,
          precisionAt3: baseline.precisionAt3,
          queries: baseline.queries ?? queries.length,
        },
      });
      console.log("[eval] Migrated baseline to per-provider sections.");
    }
    let regression = false;

    // Existing baselines predate the tool surface + intent metrics. Treat a
    // section without the extended metrics as un-baselined and bootstrap it.
    const isExtended = baseline && typeof baseline.toolPrecisionAt3 === "number" && typeof baseline.intentAccuracy === "number";

    if (!baseline || !isExtended) {
      writeBaseline(args.baseline, {
        ...stripLegacy(baselineFile),
        [baselineKey]: { ...metrics, queries: queries.length, toolQueries: toolQueries.length },
      });
      console.log(`[eval] ${baseline ? "Extended" : "Bootstrapped"} baseline for "${baselineKey}" from this run.`);
    } else {
      const weightedFloor = baseline.weighted - args.tolerance;
      const p3Floor = baseline.precisionAt3 - args.tolerance / 100;
      const toolP3Floor = baseline.toolPrecisionAt3 - args.tolerance / 100;
      const intentFloor = baseline.intentAccuracy - 2;
      regression =
        metrics.weighted < weightedFloor ||
        metrics.precisionAt3 < p3Floor ||
        metrics.toolPrecisionAt3 < toolP3Floor ||
        metrics.intentAccuracy < intentFloor;

      console.log(`[eval] Baseline (${baselineKey}):  weighted=${baseline.weighted} (floor ${weightedFloor.toFixed(2)}), p@3=${baseline.precisionAt3} (floor ${p3Floor.toFixed(4)}), toolP@3=${baseline.toolPrecisionAt3} (floor ${toolP3Floor.toFixed(4)}), intent=${baseline.intentAccuracy} (floor ${intentFloor.toFixed(1)})`);
      if (regression) {
        console.error(`[eval] REGRESSION: weighted ${metrics.weighted} < ${weightedFloor}, p@3 ${metrics.precisionAt3} < ${p3Floor}, toolP@3 ${metrics.toolPrecisionAt3} < ${toolP3Floor}, or intent ${metrics.intentAccuracy} < ${intentFloor}`);
        failed = true;
      } else {
        console.log("[eval] PASS — scores within baseline tolerance.");
      }

      if (args.updateBaseline && !regression) {
        const changed =
          metrics.weighted !== baseline.weighted ||
          metrics.precisionAt1 !== baseline.precisionAt1 ||
          metrics.precisionAt3 !== baseline.precisionAt3 ||
          metrics.toolWeighted !== baseline.toolWeighted ||
          metrics.toolPrecisionAt1 !== baseline.toolPrecisionAt1 ||
          metrics.toolPrecisionAt3 !== baseline.toolPrecisionAt3 ||
          metrics.intentAccuracy !== baseline.intentAccuracy;
        if (changed) {
          writeBaseline(args.baseline, {
            ...stripLegacy(baselineFile),
            [baselineKey]: { ...metrics, queries: queries.length, toolQueries: toolQueries.length },
          });
        } else {
          console.log("[eval] Baseline unchanged — no commit needed.");
        }
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      embeddingProvider: provider,
      embeddingModel: remoteModel,
      metrics,
      baseline: baseline ? { weighted: baseline.weighted, precisionAt1: baseline.precisionAt1, precisionAt3: baseline.precisionAt3, toolPrecisionAt3: baseline.toolPrecisionAt3, intentAccuracy: baseline.intentAccuracy } : null,
      regression,
      results,
      toolResults,
    };
    fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
    console.log(`[eval] Report written to ${args.report}`);
  } catch (err) {
    console.error(`[eval] FAILED: ${err.message}`);
    failed = true;
  } finally {
    child.kill();
  }

  process.exit(failed ? 1 : 0);
}

main();