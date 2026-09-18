// ---------------------------------------------------------------------------
// Dynamic quality gate for toolhub evaluations (search-eval + future evals)
// ---------------------------------------------------------------------------
// Replaces the fixed `baseline - tolerance` band with a floor derived from the
// model's own recent score history. Embedding models are not static: small
// run-to-run drift is normal, so the gate distinguishes three bands:
//
//   pass  — score at or above the model's recent dynamic floor
//   warn  — below the dynamic floor but inside the model's observed jitter
//           (passes CI with a loud warning; one bad day is not a regression)
//   fail  — below anything the model has recently scored (real collapse)
//
// The floor is `mean(history) - spread`, where `spread` grows with the
// observed standard deviation (jumpy model -> wider band) and is clamped to a
// minimum cushion that covers score quantization (one rank flip on the 32-query
// fixture is ~2 weighted points, so the minimum cushion is 2).
//
// Decay safety: the canonical baseline never follows scores down immediately.
// A lower value is only accepted as the new normal after `warnBands`
// consecutive sub-canonical runs. Moving up is always allowed instantly
// (ratchet-up). A real collapse (fail verdict) never touches the baseline.
// ---------------------------------------------------------------------------

// Tunables. Overridable per call via the `defaults` argument; search-eval maps
// CLI flags onto these. No magic numbers anywhere else.
export const GATE_DEFAULTS = {
  // Recent runs remembered per metric (per model) inside the baseline file.
  historyLimit: 10,
  // Floor = mean - jitterMultiplier * sigma. 2 ≈ "deeper than the usual
  // wobble starts to look like a trend".
  jitterMultiplier: 2,
  // Minimum cushion per metric kind, covering quantization jitter:
  // - "points":  0..100 integer scores (weighted)   — one rank flip ≈ 2 pts
  // - "percent": 0..100 integer scores (intent)     — one query ≈ 2 pts
  // - "ratio":   0..1 four-decimal scores (p@3)     — one query ≈ 0.031
  minJitter: { points: 2, percent: 2, ratio: 0.03 },
  // Consecutive sub-canonical runs required before a lower value is accepted
  // as the new normal (slow downward ratchet).
  warnBands: 2,
};

// The four metrics the gate defends. Order is display order.
export const GATED_METRICS = [
  { key: "weighted", kind: "points", label: "weighted" },
  { key: "precisionAt3", kind: "ratio", label: "p@3" },
  { key: "toolPrecisionAt3", kind: "ratio", label: "toolP@3" },
  { key: "intentAccuracy", kind: "percent", label: "intent" },
];

export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Builds the gate input for one metric from a baseline section.
 *
 * History entries live at `section.__history` (array of score objects, oldest
 * first). Baselines written before the dynamic gate have no history — for
 * those, the canonical score acts as a one-entry pseudo history so the very
 * first gated run behaves like the old fixed band (cushion around baseline).
 */
export function historyForMetric(section, key, defaults = GATE_DEFAULTS) {
  const history = Array.isArray(section?.__history) ? section.__history : [];
  const values = history
    .slice(-defaults.historyLimit)
    .map((h) => h[key])
    .filter((v) => typeof v === "number");
  if (values.length > 0) return values;
  // Pseudo history from the canonical score (legacy baseline section).
  const canonical = section?.[key];
  return typeof canonical === "number" ? [canonical] : [];
}

/**
 * Evaluates all gated metrics for one run.
 *
 * @param {object} params
 * @param {object} params.metrics        current run's metrics (same keys as GATED_METRICS)
 * @param {object} params.baselineSection  the model's baseline section (may be legacy, may be null)
 * @param {object} [params.defaults]     tunables (GATE_DEFAULTS merged)
 * @returns gate result: verdict, per-metric floors/verdicts, display line
 */
export function evaluateGate({ metrics, baselineSection, defaults = {} }) {
  const d = { ...GATE_DEFAULTS, ...defaults };
  const perMetric = {};
  const failedMetrics = [];
  const warnedMetrics = [];

  for (const m of GATED_METRICS) {
    const value = metrics[m.key];
    const history = historyForMetric(baselineSection, m.key, d);
    const mAvg = mean(history);
    const sigma = stdev(history);
    const minJitter = d.minJitter[m.kind] ?? 0;
    const spread = Math.max(minJitter, d.jitterMultiplier * sigma);
    const passFloor = mAvg - spread;
    const failFloor = mAvg - 2 * spread;

    let verdict;
    if (typeof value !== "number") {
      verdict = "pass"; // metric not produced by this run — nothing to judge
    } else if (value >= passFloor) {
      verdict = "pass";
    } else if (value >= failFloor) {
      verdict = "warn";
      warnedMetrics.push(m.key);
    } else {
      verdict = "fail";
      failedMetrics.push(m.key);
    }

    perMetric[m.key] = {
      label: m.label,
      kind: m.kind,
      value,
      mean: round(mAvg, 4),
      sigma: round(sigma, 4),
      spread: round(spread, 4),
      passFloor: round(passFloor, 4),
      failFloor: round(failFloor, 4),
      historyPoints: history.length,
      verdict,
    };
  }

  const verdict = failedMetrics.length > 0 ? "fail" : warnedMetrics.length > 0 ? "warn" : "pass";

  const detail = GATED_METRICS.map((m) => {
    const p = perMetric[m.key];
    return `${m.label} ${p.value} (floor ${p.passFloor} warn / ${p.failFloor} fail)`;
  }).join(", ");

  return { verdict, perMetric, failedMetrics, warnedMetrics, detail };
}

/**
 * Computes the next baseline section after a run.
 *
 * Rules:
 *  - history: append the run's gated scores unless the newest history entry is
 *    identical (dedupe — steady state must not produce bot commits). Failed
 *    runs are never recorded (an anomaly is not the model's normal). The
 *    history is capped at `historyLimit`.
 *  - canonical scores ratchet up instantly; they only follow scores down after
 *    `warnBands` consecutive sub-canonical runs (verified against real history,
 *    including the run being recorded now).
 *  - verdict "fail": canonical unchanged (unless force).
 *  - force: canonical := current for all metrics and history resets to just
 *    this run (a deliberate re-floor describes the new model state only).
 *
 * @returns {object} { section, changed, notes }
 */
export function nextBaselineSection({ baselineSection, metrics, verdict, defaults = {}, force = false }) {
  const d = { ...GATE_DEFAULTS, ...defaults };
  const notes = [];
  const prev = baselineSection ?? {};
  const prevHistory = Array.isArray(prev.__history) ? prev.__history : [];

  const entry = Object.fromEntries(GATED_METRICS.map((m) => [m.key, metrics[m.key]]));
  const newest = prevHistory[prevHistory.length - 1];
  const isDuplicate =
    newest !== undefined && GATED_METRICS.every((m) => newest[m.key] === entry[m.key]);

  let history;
  if (force) {
    history = [entry];
    notes.push("forced re-floor: history reset to this run");
  } else if (verdict === "fail") {
    history = prevHistory; // anomalies are not recorded
    notes.push("fail verdict: history unchanged");
  } else if (isDuplicate) {
    history = prevHistory; // steady state — nothing new to remember
  } else {
    history = [...prevHistory, entry].slice(-d.historyLimit);
  }

  // Canonical scores: ratchet up instantly; follow down only after
  // `warnBands` consecutive sub-canonical runs. Evidence for the downward
  // check is independent of history dedupe: a repeated identical dip (e.g.
  // 78, 78 against canonical 80) is two data points, not "nothing happened".
  // Dedupe only avoids file churn from appending the newest entry twice.
  const section = { ...prev };
  const evidence = [...prevHistory.slice(-(d.warnBands - 1)), entry];
  for (const m of GATED_METRICS) {
    const now = entry[m.key];
    if (typeof prev[m.key] !== "number") {
      // Bootstrap: no canonical score yet — this run defines it.
      section[m.key] = now;
      continue;
    }
    const was = prev[m.key];
    if (now > was) {
      if (now !== was) notes.push(`${m.key}: ratchet up ${was} -> ${now}`);
      section[m.key] = now;
    } else if (now < was) {
      const subCanonical =
        verdict !== "fail" && evidence.length >= d.warnBands && evidence.every((h) => h[m.key] < was);
      if (subCanonical) {
        notes.push(`${m.key}: ${d.warnBands} consecutive sub-canonical runs — new normal ${was} -> ${now}`);
        section[m.key] = now;
      }
    }
  }
  if (force) {
    for (const m of GATED_METRICS) section[m.key] = entry[m.key];
  }

  section.__history = history;
  const changed =
    force ||
    (!isDuplicate && verdict !== "fail") ||
    GATED_METRICS.some((m) => section[m.key] !== prev[m.key]);

  return { section, changed, notes };
}
