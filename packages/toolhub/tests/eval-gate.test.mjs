import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_DEFAULTS,
  GATED_METRICS,
  evaluateGate,
  nextBaselineSection,
  mean,
  stdev,
  historyForMetric,
} from "./eval-gate.mjs";

// Helpers -------------------------------------------------------------------

function metrics(overrides = {}) {
  return {
    weighted: 80,
    precisionAt3: 0.875,
    toolPrecisionAt3: 0.9375,
    intentAccuracy: 63,
    ...overrides,
  };
}

// Legacy-style baseline section: canonical scores only, no __history.
function legacySection(overrides = {}) {
  return {
    weighted: 80,
    precisionAt1: 0.7188,
    precisionAt3: 0.875,
    queries: 32,
    toolWeighted: 86,
    toolPrecisionAt1: 0.75,
    toolPrecisionAt3: 0.9375,
    toolQueries: 16,
    intentAccuracy: 63,
    toolEvidenceRate: 100,
    falseToolRate: 0,
    ...overrides,
  };
}

function sectionWithHistory(values, canonical = null) {
  const history = values.map((v) => ({
    weighted: v.w,
    precisionAt3: v.p3,
    toolPrecisionAt3: v.tp3,
    intentAccuracy: v.intent,
  }));
  return {
    ...(canonical ?? {
      weighted: values[values.length - 1].w,
      precisionAt3: values[values.length - 1].p3,
      toolPrecisionAt3: values[values.length - 1].tp3,
      intentAccuracy: values[values.length - 1].intent,
    }),
    __history: history,
  };
}

// mean / stdev ----------------------------------------------------------------

test("mean of empty array is 0", () => {
  assert.equal(mean([]), 0);
});

test("mean computes the average", () => {
  assert.equal(mean([80, 82]), 81);
});

test("stdev of fewer than two values is 0", () => {
  assert.equal(stdev([80]), 0);
  assert.equal(stdev([]), 0);
});

test("stdev is the population standard deviation", () => {
  assert.ok(Math.abs(stdev([78, 80, 82]) - Math.sqrt(8 / 3)) < 1e-12);
});

// historyForMetric ------------------------------------------------------------

test("legacy section without history falls back to canonical score", () => {
  const values = historyForMetric(legacySection(), "weighted");
  assert.deepEqual(values, [80]);
});

test("history is capped at historyLimit entries", () => {
  const section = sectionWithHistory(
    Array.from({ length: 15 }, (_, i) => ({ w: 70 + i, p3: 0.8, tp3: 0.9, intent: 60 }))
  );
  const values = historyForMetric(section, "weighted", { ...GATE_DEFAULTS, historyLimit: 10 });
  assert.equal(values.length, 10);
  assert.equal(values[0], 75); // oldest kept entry is 70+5
  assert.equal(values[9], 84);
});

// evaluateGate ----------------------------------------------------------------

test("steady performance passes", () => {
  const r = evaluateGate({ metrics: metrics(), baselineSection: legacySection() });
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.failedMetrics, []);
  assert.deepEqual(r.warnedMetrics, []);
});

test("legacy baseline behaves like the old tolerance band (one rank flip = warn, not fail)", () => {
  // Canonical 80, no history -> mean 80, sigma 0, spread = minJitter(2).
  // passFloor 78, failFloor 76 -> 78 passes, 76 warns, 74 fails.
  assert.equal(evaluateGate({ metrics: metrics({ weighted: 78 }), baselineSection: legacySection() }).verdict, "pass");
  const w = evaluateGate({ metrics: metrics({ weighted: 76 }), baselineSection: legacySection() });
  assert.equal(w.verdict, "warn");
  assert.deepEqual(w.warnedMetrics, ["weighted"]);
  const f = evaluateGate({ metrics: metrics({ weighted: 74 }), baselineSection: legacySection() });
  assert.equal(f.verdict, "fail");
  assert.deepEqual(f.failedMetrics, ["weighted"]);
});

test("stable history narrows the band: small dip warns, big dip fails", () => {
  // Scores 79..81 -> mean 80, sigma ~0.816, spread = max(2, 2*0.816) = 2.
  const section = sectionWithHistory([
    { w: 80, p3: 0.875, tp3: 0.9375, intent: 63 },
    { w: 81, p3: 0.875, tp3: 0.9375, intent: 63 },
    { w: 79, p3: 0.875, tp3: 0.9375, intent: 63 },
  ]);
  const r = evaluateGate({ metrics: metrics({ weighted: 77 }), baselineSection: section });
  assert.equal(r.verdict, "warn");
  // Jumpier history widens the band: 74 is within jitter of a 70..84 spread.
  const jumpy = sectionWithHistory([
    { w: 70, p3: 0.8, tp3: 0.9, intent: 55 },
    { w: 84, p3: 0.9, tp3: 0.95, intent: 70 },
    { w: 77, p3: 0.85, tp3: 0.92, intent: 62 },
  ]);
  const r2 = evaluateGate({ metrics: metrics({ weighted: 74 }), baselineSection: jumpy });
  assert.equal(r2.verdict, "pass");
});

test("score at the pass floor boundary passes, one below warns", () => {
  const section = sectionWithHistory([
    { w: 80, p3: 0.875, tp3: 0.9375, intent: 63 },
    { w: 80, p3: 0.875, tp3: 0.9375, intent: 63 },
  ]);
  // mean 80, sigma 0, spread 2 -> passFloor 78.
  assert.equal(evaluateGate({ metrics: metrics({ weighted: 78 }), baselineSection: section }).verdict, "pass");
  assert.equal(evaluateGate({ metrics: metrics({ weighted: 77 }), baselineSection: section }).verdict, "warn");
});

test("collapse across all metrics fails", () => {
  const r = evaluateGate({
    metrics: metrics({ weighted: 50, precisionAt3: 0.5, toolPrecisionAt3: 0.5, intentAccuracy: 30 }),
    baselineSection: legacySection(),
  });
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.failedMetrics.sort(), ["intentAccuracy", "precisionAt3", "toolPrecisionAt3", "weighted"]);
});

test("ratio metrics use their own quantization cushion (one query ≈ 0.031)", () => {
  // p@3 0.875, sigma 0, spread max(0.03, 0) = 0.03 -> passFloor 0.845.
  const r = evaluateGate({ metrics: metrics({ precisionAt3: 0.844 }), baselineSection: legacySection() });
  assert.equal(r.verdict, "warn");
  assert.equal(r.perMetric.precisionAt3.passFloor, 0.845);
});

test("warn/fail band is twice the pass band", () => {
  const r = evaluateGate({ metrics: metrics({ weighted: 75 }), baselineSection: legacySection() });
  // passFloor 78, failFloor 76 -> 75 fails.
  assert.equal(r.verdict, "fail");
  assert.equal(r.perMetric.weighted.failFloor, 76);
});

test("detail line mentions every metric", () => {
  const r = evaluateGate({ metrics: metrics(), baselineSection: legacySection() });
  for (const m of GATED_METRICS) assert.ok(r.detail.includes(m.label));
});

// nextBaselineSection ----------------------------------------------------------

test("bootstrap: run without baseline seeds canonical scores and history", () => {
  const { section, changed } = nextBaselineSection({
    baselineSection: null,
    metrics: metrics(),
    verdict: "pass",
  });
  assert.equal(section.weighted, 80);
  assert.equal(section.toolPrecisionAt3, 0.9375);
  assert.equal(section.__history.length, 1);
  assert.equal(changed, true);
});

test("improvement rattles the canonical score up instantly", () => {
  const { section, notes } = nextBaselineSection({
    baselineSection: legacySection(),
    metrics: metrics({ weighted: 82 }),
    verdict: "pass",
  });
  assert.equal(section.weighted, 82);
  assert.ok(notes.some((n) => n.includes("ratchet up")));
});

test("single sub-canonical run does NOT move the canonical score down", () => {
  const { section, notes } = nextBaselineSection({
    baselineSection: legacySection(),
    metrics: metrics({ weighted: 78 }),
    verdict: "warn",
  });
  assert.equal(section.weighted, 80, "one low run must not lower the bar");
  assert.ok(!notes.some((n) => n.includes("new normal")));
});

test("warnBands consecutive sub-canonical runs accept the new normal", () => {
  // History already holds one sub-canonical run (78); the run being judged is
  // also 78 -> two consecutive sub-canonical runs.
  const section = sectionWithHistory([{ w: 78, p3: 0.875, tp3: 0.9375, intent: 63 }], {
    weighted: 80,
    precisionAt3: 0.875,
    toolPrecisionAt3: 0.9375,
    intentAccuracy: 63,
  });
  const { section: next, notes } = nextBaselineSection({
    baselineSection: section,
    metrics: metrics({ weighted: 78 }),
    verdict: "warn",
  });
  assert.equal(next.weighted, 78);
  assert.ok(notes.some((n) => n.includes("new normal")));
});

test("failed runs are never recorded in history and never move the baseline", () => {
  const prev = legacySection();
  prev.__history = [{ weighted: 80, precisionAt3: 0.875, toolPrecisionAt3: 0.9375, intentAccuracy: 63 }];
  const { section, changed } = nextBaselineSection({
    baselineSection: prev,
    metrics: metrics({ weighted: 50 }),
    verdict: "fail",
  });
  assert.equal(section.weighted, 80);
  assert.equal(section.__history.length, 1, "collapse must not poison the history");
  assert.equal(changed, false);
});

test("steady-state duplicate run does not mark the baseline changed", () => {
  const prev = legacySection();
  prev.__history = [
    { weighted: 80, precisionAt3: 0.875, toolPrecisionAt3: 0.9375, intentAccuracy: 63 },
  ];
  const { changed, section } = nextBaselineSection({
    baselineSection: prev,
    metrics: metrics(),
    verdict: "pass",
  });
  assert.equal(changed, false);
  assert.equal(section.__history.length, 1);
});

test("new score variant is recorded in history even when canonical does not move", () => {
  const prev = legacySection();
  prev.__history = [
    { weighted: 80, precisionAt3: 0.875, toolPrecisionAt3: 0.9375, intentAccuracy: 63 },
  ];
  const { changed, section } = nextBaselineSection({
    baselineSection: prev,
    metrics: metrics({ weighted: 79 }),
    verdict: "warn",
  });
  assert.equal(changed, true, "history growth counts as a change (bot can commit)");
  assert.equal(section.__history.length, 2);
  assert.equal(section.weighted, 80, "canonical still untouched after one dip");
});

test("history is capped while appending", () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    weighted: 80 + (i % 2),
    precisionAt3: 0.875,
    toolPrecisionAt3: 0.9375,
    intentAccuracy: 63,
  }));
  const prev = { ...legacySection(), __history: history };
  const { section } = nextBaselineSection({
    baselineSection: prev,
    metrics: metrics({ weighted: 79 }),
    verdict: "warn",
  });
  assert.equal(section.__history.length, GATE_DEFAULTS.historyLimit);
  assert.equal(section.__history[0].weighted, 81, "oldest entry rotated out");
});

test("force re-floor resets canonical and history to this run only", () => {
  const prev = legacySection();
  prev.__history = [{ weighted: 80, precisionAt3: 0.875, toolPrecisionAt3: 0.9375, intentAccuracy: 63 }];
  const { section, notes } = nextBaselineSection({
    baselineSection: prev,
    metrics: metrics({ weighted: 76, precisionAt3: 0.85, toolPrecisionAt3: 0.9, intentAccuracy: 60 }),
    verdict: "warn",
    force: true,
  });
  assert.equal(section.weighted, 76);
  assert.equal(section.precisionAt3, 0.85);
  assert.equal(section.toolPrecisionAt3, 0.9);
  assert.equal(section.intentAccuracy, 60);
  assert.equal(section.__history.length, 1);
  assert.equal(section.__history[0].weighted, 76);
  assert.ok(notes.some((n) => n.includes("forced re-floor")));
});

test("downward acceptance uses real history including the current run", () => {
  // warnBands=2: one prior sub-canonical run (77) + current run 78, both < 80
  // -> new normal accepted (both of the last two runs are sub-canonical).
  const section = sectionWithHistory([{ w: 77, p3: 0.875, tp3: 0.9375, intent: 63 }], {
    weighted: 80,
    precisionAt3: 0.875,
    toolPrecisionAt3: 0.9375,
    intentAccuracy: 63,
  });
  const { section: next } = nextBaselineSection({
    baselineSection: section,
    metrics: metrics({ weighted: 78 }),
    verdict: "warn",
  });
  assert.equal(next.weighted, 78);
});
