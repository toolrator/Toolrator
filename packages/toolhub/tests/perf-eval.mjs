#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Toolhub performance evaluation (integration benchmark)
// ---------------------------------------------------------------------------
// Boots a real toolhub instance, seeds the reference mockup catalog, then
// measures: boot/startup time, cold first query, seed throughput, single-user
// latency percentiles, concurrency throughput, and a soak phase with memory
// tracking. Asserts the results against a checked-in per-config baseline.
//
// Usage:
//   node tests/perf-eval.mjs [--config 1c2g|2c4g|host] [--baseline <file>]
//                            [--report <file>] [--update-baseline] [--force]
//                            [--quick] [--no-assert]
//   node tests/perf-eval.mjs --compare <report-2c4g> <report-1c2g>
//
// Env:
//   TOOLHUB_PORT          port for the spawned toolhub (default 7601)
//   MEILI_URL             MeiliSearch URL (default http://127.0.0.1:7702)
//   SEARCH_ADMIN_TOKEN    admin bearer token (default dev-admin-token)
//   PERF_QUICK=1          quick mode (shorter phases)
//
// Exit codes:
//   0  pass (or baseline bootstrapped)
//   1  regression vs baseline, compare ratio violation, or runtime error
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import {
  CATALOG_PATH,
  FIXTURES_DIR,
  startServer,
  waitForHealth,
  seedCatalog,
  readBaseline,
  writeBaseline,
} from "./eval-utils.mjs";

const DEFAULT_BASELINE = path.join(FIXTURES_DIR, "perf-baseline.json");

// Embedding provider is REQUIRED for this eval — deliberately no default
// (the old fallback silently ran the local ONNX model, a RAM hog on
// real-scale catalogs). Export it or run with --env-file-if-exists=.env.
const EMBEDDING_PROVIDER = process.env.TOOLHUB_EMBEDDING_PROVIDER;

// ---------------------------------------------------------------------------
// Resource configs
// ---------------------------------------------------------------------------

const CONFIGS = {
  "1c2g": { cpus: 1, memoryMb: 2048, maxOldSpace: "1536", numThreads: 1, rssPeakMaxMb: 1900 },
  "2c4g": { cpus: 2, memoryMb: 4096, maxOldSpace: "3072", numThreads: 2, rssPeakMaxMb: 3900 },
  host: { cpus: null, memoryMb: null, maxOldSpace: null, numThreads: null, rssPeakMaxMb: null },
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    config: "host",
    baseline: DEFAULT_BASELINE,
    report: path.join(process.cwd(), "search-perf-report.json"),
    updateBaseline: false,
    force: false,
    quick: false,
    noAssert: false,
    compare: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") args.config = argv[++i];
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++i]);
    else if (arg === "--report") args.report = path.resolve(argv[++i]);
    else if (arg === "--update-baseline") args.updateBaseline = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--quick") args.quick = true;
    else if (arg === "--no-assert") args.noAssert = true;
    else if (arg === "--compare") args.compare = [path.resolve(argv[++i]), path.resolve(argv[++i])];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!CONFIGS[args.config]) throw new Error(`Unknown --config: ${args.config}`);
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function pStats(arr) {
  if (arr.length === 0) return { samples: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  // NOTE: no Math.max(...arr) spread here — soak runs collect >100k samples and
  // spreading them as arguments overflows the call stack ("Maximum call stack
  // size exceeded" on faster hosts).
  let max = -Infinity;
  for (const v of arr) if (v > max) max = v;
  return {
    samples: arr.length,
    avg: round(avg),
    p50: round(percentile(arr, 50)),
    p90: round(percentile(arr, 90)),
    p95: round(percentile(arr, 95)),
    p99: round(percentile(arr, 99)),
    max: round(max),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function doSearch(baseUrl, q) {
  const res = await fetch(`${baseUrl}/search?q=${encodeURIComponent(q)}&limit=3`);
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  await res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Query pool
// ---------------------------------------------------------------------------

function typo(s) {
  const lower = s.toLowerCase();
  if (lower.length < 3) return lower;
  const i = 1 + Math.floor(Math.random() * (lower.length - 2));
  const arr = lower.split("");
  [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
  return arr.join("");
}

const SEMANTIC_QUERIES = [
  "my flight got cancelled, find me a hotel in Lisbon for tonight",
  "how much calories does a hamburger have",
  "summarize the long email thread about the Q3 budget",
  "check this python snippet for security problems",
  "find me a good podcast about deep work",
  "design a logo for my coffee startup",
  "is the blue hoodie still in stock",
  "what is the current price of apple stock",
  "how many users signed up last week",
  "write a wiki page documenting our API endpoints",
];

const OUT_OF_DOMAIN = [
  "what is the capital of Namibia",
  "recipe for pasta carbonara",
  "best hiking trails in norway",
  "convert 100 usd to eur",
];

function buildPool(catalog) {
  const titles = catalog.map((c) => c.display_name);
  const typos = titles.slice(0, 8).map(typo);
  return { titles, typos, semantic: SEMANTIC_QUERIES, ood: OUT_OF_DOMAIN, all: [...titles, ...typos, ...SEMANTIC_QUERIES, ...OUT_OF_DOMAIN] };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function latencyPhase(baseUrl, pool, samples) {
  const seen = new Set();
  let expectedHits = 0;
  const lat = [];
  const hitLat = [];
  const missLat = [];
  for (let i = 0; i < samples; i++) {
    const q = pool[Math.floor(Math.random() * pool.length)];
    const t0 = performance.now();
    await doSearch(baseUrl, q);
    const ms = performance.now() - t0;
    lat.push(ms);
    if (seen.has(q)) {
      expectedHits++;
      hitLat.push(ms);
    } else {
      seen.add(q);
      missLat.push(ms);
    }
  }
  return { lat, expectedHits, hitLat, missLat };
}

async function runLoad(baseUrl, pool, concurrency, durationMs, bucketMs = 10000) {
  const start = Date.now();
  let ok = 0;
  let errors = 0;
  const lats = [];
  const bucketCount = Math.max(1, Math.ceil(durationMs / bucketMs));
  const buckets = new Array(bucketCount).fill(0);
  const worker = async () => {
    while (Date.now() - start < durationMs) {
      const q = pool[Math.floor(Math.random() * pool.length)];
      const t0 = performance.now();
      try {
        await doSearch(baseUrl, q);
        ok++;
        lats.push(performance.now() - t0);
        const b = Math.floor((Date.now() - start) / bucketMs);
        if (b >= 0 && b < bucketCount) buckets[b]++;
      } catch {
        errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const durationSec = (Date.now() - start) / 1000;
  const stats = pStats(lats);
  return {
    concurrency,
    durationSec: round(durationSec),
    rps: round(ok / durationSec),
    errors,
    errorRate: round(errors / Math.max(1, ok + errors), 4),
    buckets,
    ...stats,
  };
}

async function sampleRss(pid, samples, durationMs, intervalMs = 5000) {
  if (process.platform !== "linux") return;
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    try {
      const s = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = s.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) samples.push(round(Number(m[1]) / 1024));
    } catch {
      // process gone — stop sampling
      return;
    }
    await sleep(intervalMs);
  }
}

function countOccurrences(lines, needle) {
  return lines.filter((l) => l.includes(needle)).length;
}

function parseModelLoadMs(lines) {
  for (const l of lines) {
    const m = l.match(/Model loaded successfully in (\d+)ms/);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Baseline handling
// ---------------------------------------------------------------------------

const DEFAULT_ERROR_RATE_MAX = 0.005;
const DEFAULT_RSS_GROWTH_MAX_PCT = 0.2;

function currentEmbeddingModel(provider) {
  return provider === "openai-compatible"
    ? process.env.TOOLHUB_EMBEDDING_MODEL || "text-embedding-3-small"
    : process.env.TOOLHUB_LOCAL_EMBEDDING_MODEL || "Xenova/multilingual-e5-small";
}

function bootstrapSection(config, metrics) {
  const cfg = CONFIGS[config];
  return {
    provider: EMBEDDING_PROVIDER,
    model: currentEmbeddingModel(EMBEDDING_PROVIDER),
    bootMaxMs: Math.max(30000, Math.ceil(metrics.bootMs * 1.5)),
    coldQueryMaxMs: Math.max(30000, Math.ceil(metrics.coldQueryMs * 1.5)),
    seedMaxMs: Math.max(60000, Math.ceil(metrics.seedMs * 2)),
    p95MaxMs: Math.max(1000, Math.ceil(metrics.latency.p95 * 1.5)),
    p99MaxMs: Math.max(3000, Math.ceil(metrics.latency.p99 * 1.5)),
    throughputRpsFloor: Object.fromEntries(
      metrics.throughput.map((t) => [String(t.concurrency), Math.max(1, Math.floor(t.rps * 0.5))]),
    ),
    soakRpsFloor: Math.max(1, Math.floor(metrics.soak.rpsAvg * 0.5)),
    errorRateMax: DEFAULT_ERROR_RATE_MAX,
    rssGrowthMaxPct: DEFAULT_RSS_GROWTH_MAX_PCT,
    rssPeakMaxMb: cfg.rssPeakMaxMb ?? 0,
  };
}

function assertMetrics(config, metrics, thresholds) {
  const failures = [];
  const check = (label, value, limit, kind = ">=") => {
    const ok = kind === ">=" ? value >= limit : value <= limit;
    const op = kind === ">=" ? ">=" : "<=";
    if (!ok) failures.push(`${label}: ${round(value)} ${op} ${round(limit)} (${config})`);
  };
  check("boot", metrics.bootMs, thresholds.bootMaxMs, "<=");
  check("cold query", metrics.coldQueryMs, thresholds.coldQueryMaxMs, "<=");
  check("seed", metrics.seedMs, thresholds.seedMaxMs, "<=");
  check("latency p95", metrics.latency.p95, thresholds.p95MaxMs, "<=");
  check("latency p99", metrics.latency.p99, thresholds.p99MaxMs, "<=");
  for (const t of metrics.throughput) {
    const floor = thresholds.throughputRpsFloor?.[String(t.concurrency)];
    if (floor != null) check(`throughput@${t.concurrency} rps`, t.rps, floor);
  }
  check("soak rps", metrics.soak.rpsAvg, thresholds.soakRpsFloor);
  check("soak error rate", metrics.soak.errorRate, thresholds.errorRateMax ?? DEFAULT_ERROR_RATE_MAX, "<=");
  if (metrics.soak.rss && metrics.soak.rss.growthPct != null) {
    check("rss growth", metrics.soak.rss.growthPct, thresholds.rssGrowthMaxPct ?? DEFAULT_RSS_GROWTH_MAX_PCT, "<=");
  }
  if (metrics.soak.rss && metrics.soak.rss.peakMb != null && thresholds.rssPeakMaxMb) {
    check("rss peak", metrics.soak.rss.peakMb, thresholds.rssPeakMaxMb, "<=");
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Report + summary
// ---------------------------------------------------------------------------

function buildSummary(config, metrics, thresholds, failures) {
  const rows = [
    ["boot", `${metrics.bootMs}ms`, thresholds ? `${thresholds.bootMaxMs}ms` : "-", !thresholds || metrics.bootMs <= thresholds.bootMaxMs],
    ["cold query", `${metrics.coldQueryMs}ms`, thresholds ? `${thresholds.coldQueryMaxMs}ms` : "-", !thresholds || metrics.coldQueryMs <= thresholds.coldQueryMaxMs],
    ["seed (32 docs)", `${metrics.seedMs}ms`, thresholds ? `${thresholds.seedMaxMs}ms` : "-", !thresholds || metrics.seedMs <= thresholds.seedMaxMs],
    ["model load", metrics.modelLoadMs != null ? `${metrics.modelLoadMs}ms` : "n/a", "-", null],
    ["latency avg/p50/p90/p95/p99", `${metrics.latency.avg}/${metrics.latency.p50}/${metrics.latency.p90}/${metrics.latency.p95}/${metrics.latency.p99}ms`, thresholds ? `p95<=${thresholds.p95MaxMs}ms` : "-", !thresholds || metrics.latency.p95 <= thresholds.p95MaxMs],
    ["cache hit rate (est.)", `${(metrics.latency.cacheHitRate * 100).toFixed(0)}%`, "-", null],
    ["lexical fallbacks", String(metrics.lexicalFallbacks), "-", null],
    ...metrics.throughput.map((t) => [`throughput @${t.concurrency}`, `${t.rps} rps (p50 ${t.p50}ms, p99 ${t.p99}ms, err ${(t.errorRate * 100).toFixed(1)}%)`, thresholds?.throughputRpsFloor?.[String(t.concurrency)] != null ? `floor ${thresholds.throughputRpsFloor[String(t.concurrency)]} rps` : "-", thresholds?.throughputRpsFloor?.[String(t.concurrency)] == null || t.rps >= thresholds.throughputRpsFloor[String(t.concurrency)]]),
    ["soak @10", `${metrics.soak.rpsAvg} rps (buckets ${metrics.soak.rpsMin}-${metrics.soak.rpsMax}, err ${(metrics.soak.errorRate * 100).toFixed(1)}%)`, thresholds ? `floor ${thresholds.soakRpsFloor} rps` : "-", !thresholds || metrics.soak.rpsAvg >= thresholds.soakRpsFloor],
  ];
  if (metrics.soak.rss) {
    const rssTxt = metrics.soak.rss.peakMb != null ? `${metrics.soak.rss.peakMb}MB / ${(metrics.soak.rss.growthPct * 100).toFixed(1)}%` : "n/a (non-linux)";
    rows.push(["rss peak/growth", rssTxt, thresholds ? `peak<=${thresholds.rssPeakMaxMb}MB` : "-", !thresholds || metrics.soak.rss.peakMb == null || (metrics.soak.rss.growthPct <= (thresholds?.rssGrowthMaxPct ?? 0.2) && metrics.soak.rss.peakMb <= (thresholds?.rssPeakMaxMb ?? Infinity))]);
  }
  const lines = [`## Toolhub Perf Eval (\`${config}\`)`, "", "| metric | value | threshold |", "|---|---|---|"];
  for (const [name, value, thr] of rows) lines.push(`| ${name} | ${value} | ${thr} |`);
  if (failures.length > 0) {
    lines.push("", "**FAILED:**");
    for (const f of failures) lines.push(`- ${f}`);
  } else {
    lines.push("", "PASS — within baseline.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compare mode
// ---------------------------------------------------------------------------

function runCompare(args) {
  const [r2c4g, r1c2g] = args.compare.map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
  const rps2 = r2c4g.metrics?.soak?.rpsAvg;
  const rps1 = r1c2g.metrics?.soak?.rpsAvg;
  if (rps2 == null || rps1 == null) {
    throw new Error(`compare failed: reports must contain soak.rpsAvg (got ${JSON.stringify(r2c4g.metrics?.soak)}, ${JSON.stringify(r1c2g.metrics?.soak)})`);
  }
  const ratio = rps2 / rps1;
  console.log(`[perf] 2c4g/1c2g soak RPS ratio: ${ratio.toFixed(2)} (floor 1.30)`);
  if (ratio < 1.3) {
    console.error("[perf] FAIL: 2c4g throughput is not at least 1.3x 1c2g throughput.");
    return 1;
  }
  console.log("[perf] PASS — 2c4g scales as expected over 1c2g.");
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.compare) {
    try {
      process.exit(runCompare(args));
    } catch (err) {
      console.error(`[perf] FAILED: ${err.message}`);
      process.exit(1);
    }
  }

  if (!EMBEDDING_PROVIDER) {
    console.error(
      "[perf] TOOLHUB_EMBEDDING_PROVIDER must be set explicitly (e.g. openai-compatible or local) — no default provider."
    );
    process.exit(1);
  }

  const config = CONFIGS[args.config];
  const quick = args.quick || ["1", "true", "yes"].includes(String(process.env.PERF_QUICK).toLowerCase());
  const port = Number(process.env.TOOLHUB_PORT || 7601);
  const meiliUrl = process.env.MEILI_URL || "http://127.0.0.1:7702";
  const adminToken = process.env.SEARCH_ADMIN_TOKEN || "dev-admin-token";
  const baseUrl = `http://127.0.0.1:${port}`;

  const extraEnv = {};
  if (config.numThreads) extraEnv.TOOLHUB_ONNX_THREADS = String(config.numThreads);
  if (config.maxOldSpace) {
    extraEnv.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--max-old-space-size=${config.maxOldSpace}`].filter(Boolean).join(" ");
  }

  const child = startServer({ port, meiliUrl, adminToken, extraEnv });
  let failed = false;
  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    const pool = buildPool(catalog);

    // Boot + cold query (first query embeds -> includes ONNX model load)
    const tBoot = performance.now();
    await waitForHealth(baseUrl, 120000);
    const bootMs = Math.round(performance.now() - tBoot);
    console.log(`[perf] Boot -> healthy in ${bootMs}ms`);

    const tCold = performance.now();
    await doSearch(baseUrl, pool.semantic[0]);
    const coldQueryMs = Math.round(performance.now() - tCold);
    console.log(`[perf] Cold first query: ${coldQueryMs}ms`);

    // Seed
    const tSeed = performance.now();
    await seedCatalog(baseUrl, adminToken);
    const seedMs = Math.round(performance.now() - tSeed);
    console.log(`[perf] Seeded 32 documents in ${seedMs}ms`);

    // Warm-up (discarded)
    for (let i = 0; i < 20; i++) await doSearch(baseUrl, pool.all[Math.floor(Math.random() * pool.all.length)]);

    // Latency (sequential)
    const latencyN = quick ? 80 : 200;
    const latRes = await latencyPhase(baseUrl, pool.all, latencyN);
    const latency = {
      ...pStats(latRes.lat),
      cacheHitRate: round(latRes.expectedHits / Math.max(1, latRes.lat.length), 4),
      cacheHitAvg: latRes.hitLat.length ? round(latRes.hitLat.reduce((a, b) => a + b, 0) / latRes.hitLat.length) : null,
      cacheMissAvg: latRes.missLat.length ? round(latRes.missLat.reduce((a, b) => a + b, 0) / latRes.missLat.length) : null,
    };
    console.log(`[perf] Latency (c=1, ${latency.samples} samples): avg ${latency.avg}ms p50 ${latency.p50}ms p95 ${latency.p95}ms p99 ${latency.p99}ms max ${latency.max}ms (cache-hit est ${(latency.cacheHitRate * 100).toFixed(0)}%)`);

    // Throughput
    const levels = quick ? [5, 10] : [5, 10, 20];
    const loadDurationMs = quick ? 10000 : 20000;
    const throughput = [];
    for (const c of levels) {
      const r = await runLoad(baseUrl, pool.all, c, loadDurationMs);
      throughput.push({ concurrency: c, rps: r.rps, p50: r.p50, p95: r.p95, p99: r.p99, max: r.max, errors: r.errors, errorRate: r.errorRate, samples: r.samples });
      console.log(`[perf] Throughput @${c} concurrent: ${r.rps} rps (p50 ${r.p50}ms, p99 ${r.p99}ms, ${r.errors} errors)`);
    }

    // Soak + RSS
    const soakMs = quick ? 20000 : 60000;
    const bucketSec = 10;
    const rssSamples = [];
    const rssPromise = sampleRss(child.pid, rssSamples, soakMs + 5000);
    const soak = await runLoad(baseUrl, pool.all, 10, soakMs, bucketSec * 1000);
    await rssPromise;
    const rpsBuckets = soak.buckets.map((b) => round(b / bucketSec));
    const rss = {
      samples: rssSamples.length,
      startMb: rssSamples.length ? rssSamples[0] : null,
      endMb: rssSamples.length ? rssSamples[rssSamples.length - 1] : null,
      peakMb: rssSamples.length ? Math.max(...rssSamples) : null,
      growthPct: rssSamples.length && rssSamples[0] > 0 ? round((rssSamples[rssSamples.length - 1] - rssSamples[0]) / rssSamples[0], 4) : null,
    };
    const soakMetrics = {
      concurrency: 10,
      rpsAvg: soak.rps,
      rpsMin: rpsBuckets.length ? Math.min(...rpsBuckets) : null,
      rpsMax: rpsBuckets.length ? Math.max(...rpsBuckets) : null,
      rpsBuckets,
      errors: soak.errors,
      errorRate: soak.errorRate,
      rss,
    };
    console.log(`[perf] Soak @10 for ${soak.durationSec}s: ${soak.rps} rps avg (buckets ${rpsBuckets.join(",")}), ${soak.errors} errors` + (rss.peakMb != null ? `, rss peak ${rss.peakMb}MB growth ${(rss.growthPct * 100).toFixed(1)}%` : ", rss n/a (non-linux)"));

    // Server-derived signals
    const lexicalFallbacks = countOccurrences([...child.serverLog, ...child.serverErrLog], "Falling back to lexical search");
    const modelLoadMs = parseModelLoadMs(child.serverLog);
    console.log(`[perf] Lexical fallbacks during run: ${lexicalFallbacks} (semantic capacity signal)`);

    const metrics = {
      bootMs,
      coldQueryMs,
      seedMs,
      modelLoadMs,
      lexicalFallbacks,
      latency,
      throughput,
      soak: soakMetrics,
    };

    const thresholds = args.config === "host" ? null : readBaseline(args.baseline)?.[args.config] ?? null;
    let failures = [];

    if (args.config === "host" || args.noAssert) {
      console.log("[perf] Host/no-assert mode — reporting only.");
    } else if (!thresholds) {
      // Bootstrap this config section
      const baseline = readBaseline(args.baseline) ?? {};
      baseline[args.config] = bootstrapSection(args.config, metrics);
      writeBaseline(args.baseline, baseline);
      console.log(`[perf] No baseline for ${args.config} — bootstrapped from this run.`);
    } else {
      // Baselines are per embedding provider AND model: thresholds recorded
      // with one provider/model are not comparable to runs using another
      // (different vector space), so mismatched sections only produce reports.
      const sectionProvider = thresholds.provider ?? "local";
      const sectionModel = thresholds.model ?? null;
      const currentProvider = EMBEDDING_PROVIDER;
      const currentModel = currentEmbeddingModel(currentProvider);
      if (sectionProvider !== currentProvider || (sectionModel && sectionModel !== currentModel)) {
        console.log(`[perf] Baseline for ${args.config} was recorded with provider/model "${sectionProvider}/${sectionModel}" (current "${currentProvider}/${currentModel}") — informational run, assertion skipped.`);
        failures = [];
      } else {
        failures = assertMetrics(args.config, metrics, thresholds);
        const p99Ratio = metrics.latency.p99 / Math.max(1, metrics.latency.p50);
        const warnings = [];
        if (p99Ratio > 4) warnings.push(`p99/p50 ratio ${p99Ratio.toFixed(1)} > 4 (host noise?)`);

        console.log(`[perf] Baseline: p95<=${thresholds.p95MaxMs}ms soakRps>=${thresholds.soakRpsFloor} boot<=${thresholds.bootMaxMs}ms`);
        if (failures.length > 0) {
          for (const f of failures) console.error(`[perf] FAIL: ${f}`);
          failed = true;
        } else {
          console.log("[perf] PASS — within baseline tolerance.");
        }
        for (const w of warnings) console.warn(`[perf] WARN: ${w}`);
      }

      if (args.updateBaseline && (!failed || args.force)) {
        const baseline = readBaseline(args.baseline) ?? {};
        baseline[args.config] = bootstrapSection(args.config, metrics);
        writeBaseline(args.baseline, baseline);
        console.log(`[perf] Baseline updated for ${args.config}.`);
        if (args.force) {
          failures = [];
          failed = false;
        }
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      config: args.config,
      embeddingProvider: EMBEDDING_PROVIDER,
      quick,
      metrics,
      thresholds,
      passed: failures.length === 0,
      failures,
    };
    fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
    console.log(`[perf] Report written to ${args.report}`);

    const summary = buildSummary(args.config, metrics, thresholds, failures);
    console.log("\n" + summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
    }
  } catch (err) {
    console.error(`[perf] FAILED: ${err.stack || err.message}`);
    failed = true;
  } finally {
    child.kill();
  }

  process.exit(failed ? 1 : 0);
}

main();