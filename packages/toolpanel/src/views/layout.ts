export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export const escapeHtml = (s: unknown): string => {
  const amp = String.fromCharCode(38);
  const lt = String.fromCharCode(60);
  const gt = String.fromCharCode(62);
  const quot = amp + "quot;";
  const apos = String.fromCharCode(39) === "'" ? amp + "#39;" : amp + "#39;";
  return String(s ?? "")
    .replace(new RegExp(amp, "g"), amp + "amp;")
    .replace(new RegExp(lt, "g"), amp + "lt;")
    .replace(new RegExp(gt, "g"), amp + "gt;")
    .replace(new RegExp('"', "g"), quot)
    .replace(new RegExp("'", "g"), apos);
};

export const escapeAttr = escapeHtml;

// Compact relative-time formatter used across pages.
// Returns a stable string like "12s ago", "4m ago", "3h ago", "2d ago", "never".
export function relTimeAgo(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms)) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Toolconnector status summary used in the global status bar.
// Returns a small { pillClass, label, sub } struct so the same string can flow
// to the global-status bar and the per-card version with no duplication.
export interface ToolconnectorSummary {
  pillClass: "status-ok" | "status-muted" | "status-bad";
  label: string;
  sub: string;
}

export function summarizeToolconnector(args: {
  state: "fresh" | "recent" | "failed" | "never";
  lastVerifyKeyAt?: number;
  lastErrorAt?: number;
  lastErrorReason?: string;
  verifyKeyCount?: number;
  firstSeenAt?: number;
  bearerPrefix?: string;
}): ToolconnectorSummary {
  const t = relTimeAgo(args.lastVerifyKeyAt);
  const tc = relTimeAgo(args.lastErrorAt ?? args.lastVerifyKeyAt);
  switch (args.state) {
    case "fresh":
      return {
        pillClass: "status-ok",
        label: `Authentication successful · ${t}${args.bearerPrefix ? ` · key #${args.bearerPrefix}` : ""}`,
        sub: `${args.verifyKeyCount ?? 0} verify-key hits${args.firstSeenAt ? ` · first seen ${relTimeAgo(args.firstSeenAt)}` : ""}`,
      };
    case "recent":
      return {
        pillClass: "status-muted",
        label: `Last verify-key ok · ${t}${args.bearerPrefix ? ` · key #${args.bearerPrefix}` : ""}`,
        sub: "Connector may be idle between runs.",
      };
    case "failed":
      return {
        pillClass: "status-bad",
        label: `Last verify-key failed · ${tc}${args.lastErrorReason ? ` · ${args.lastErrorReason}` : ""}`,
        sub: "Run /device to re-authorize.",
      };
    case "never":
    default:
      return {
        pillClass: "status-muted",
        label: "Never seen a toolconnector",
        sub: "Start the connector with TOOLPANEL_URL=…",
      };
  }
}

// Shape of data the global status bar needs.
export interface GlobalStatus {
  searchEngine: {
    reachable: boolean;
    backend?: string | null;
    documentCount?: number | null;
    baseUrl: string;
  };
  toolconnector: ToolconnectorSummary | null;
}

export interface LayoutOptions {
  title: string;
  active?: "landing" | "toolconnector" | "search" | "search-admin" | "device";
  body: string;
  globalStatus?: GlobalStatus;
}

export function renderGlobalStatusBar(s: GlobalStatus | undefined): string {
  if (!s) return "";
  const se = s.searchEngine;
  const sePill = se.reachable
    ? `<span class="status status-ok">Search engine: reachable${se.backend ? ` · ${escapeHtml(se.backend)}` : ""}${se.documentCount ? ` · ${se.documentCount} docs` : ""}</span>`
    : `<span class="status status-bad">Search engine: unreachable</span>`;
  const tcPill = s.toolconnector
    ? `<span class="status ${s.toolconnector.pillClass}">Toolconnector: ${escapeHtml(s.toolconnector.label)}</span><span class="muted hint">${escapeHtml(s.toolconnector.sub)}</span>`
    : `<span class="status status-muted">Toolconnector: <em>(n/a)</em></span>`;
  return `<aside class="global-status" aria-label="System status overview">
    <div class="global-status-row">
      ${sePill}
      <span class="global-status-sep" aria-hidden="true">·</span>
      ${tcPill}
    </div>
  </aside>`;
}

export const layout = (opts: LayoutOptions): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)} : Toolpanel</title>
<link rel="stylesheet" href="/static/styles.css" />
</head>
<body>
<div class="shell">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <button type="button" class="nav-toggle" id="nav-toggle" aria-controls="primary-nav" aria-expanded="false" aria-label="Toggle navigation">
        <span class="nav-toggle-bar" aria-hidden="true"></span>
        <span class="nav-toggle-bar" aria-hidden="true"></span>
        <span class="nav-toggle-bar" aria-hidden="true"></span>
      </button>
      <a href="/" class="brand-link">Tool<span class="brand-accent">panel</span></a>
    </div>
    <nav class="nav" id="primary-nav">
      <a href="/" class="nav-link ${opts.active === "landing" ? "is-active" : ""}">Home</a>
      <a href="/panel/toolconnector" class="nav-link ${opts.active === "toolconnector" ? "is-active" : ""}">Toolconnector</a>
      <a href="/panel/search" class="nav-link ${opts.active === "search" ? "is-active" : ""}">Search</a>
      <a href="/panel/search/admin" class="nav-link ${opts.active === "search-admin" ? "is-active" : ""}">Search Admin</a>
      <a href="/device" class="nav-link ${opts.active === "device" ? "is-active" : ""}">Device Flow</a>
    </nav>
    <div class="sidebar-foot">
      <div class="pill pill-muted">open template</div>
    </div>
  </aside>
  <main class="content">
    ${renderGlobalStatusBar(opts.globalStatus)}
${opts.body}
  </main>
</div>
<script src="/static/app.js" defer></script>
</body>
</html>`;
