import { Hono } from "hono";
import { config } from "../config.js";
import { readSearchEngines } from "../storage.js";
import { upstreamHealth } from "../lib/http.js";
import { getWhoami } from "../whoami.js";
import { layout, escapeHtml as escape, relTimeAgo } from "../views/layout.js";

export const landing = new Hono();

function pillClass(state: string): string {
  switch (state) {
    case "fresh": return "status-ok";
    case "recent": return "status-muted";
    case "failed": return "status-bad";
    default: return "status-muted";
  }
}

function toolconnectorPill(w: Awaited<ReturnType<typeof getWhoami>>): string {
  switch (w.state) {
    case "fresh":
      return `<div style="display: flex; flex-direction: column; gap: 4px;">
        <span class="status ${pillClass(w.state)}">
          Authentication successful &middot; last seen ${escape(relTimeAgo(w.lastVerifyKeyAt))}${w.bearerPrefix ? ` &middot; key #${escape(w.bearerPrefix)}` : ""}
        </span>
        <span class="kv-sub muted" style="margin-top: 0;">${w.verifyKeyCount ?? 0} verify-key call${(w.verifyKeyCount ?? 0) === 1 ? "" : "s"} on record${w.firstSeenAt ? ` &middot; first seen ${escape(relTimeAgo(w.firstSeenAt))}` : ""}.</span>
      </div>`;
    case "recent":
      return `<div style="display: flex; flex-direction: column; gap: 4px;">
        <span class="status ${pillClass(w.state)}">
          Last verify-key was successful &middot; ${escape(relTimeAgo(w.lastVerifyKeyAt))}${w.bearerPrefix ? ` &middot; key #${escape(w.bearerPrefix)}` : ""}
        </span>
        <span class="kv-sub muted" style="margin-top: 0;">Connector may be idle between runs. No action needed unless you expected it to be active.</span>
      </div>`;
    case "failed":
      return `<div style="display: flex; flex-direction: column; gap: 4px;">
        <span class="status ${pillClass(w.state)}">
          Last verify-key failed &middot; ${escape(relTimeAgo(w.lastErrorAt ?? w.lastVerifyKeyAt))}${w.lastErrorReason ? ` &middot; ${escape(w.lastErrorReason)}` : ""}
        </span>
        <span class="kv-sub muted" style="margin-top: 0;">Run <a href="/device">/device</a> to re-authorize, or check your <code>CONNECTOR_API_KEY</code>.</span>
      </div>`;
    case "never":
    default:
      return `<div style="display: flex; flex-direction: column; gap: 4px;">
        <span class="status ${pillClass("never")}">
          Never seen a toolconnector on this panel
        </span>
        <span class="kv-sub muted" style="margin-top: 0;">Start the connector with <code>TOOLPANEL_URL=${escape(config.publicUrl)}</code>.</span>
      </div>`;
  }
}

function renderCopyBlock(label: string, value: string): string {
  const safe = escape(value);
  return `<div class="kv kv-copy">
    <span class="k">${escape(label)}</span>
    <code data-copy="${safe}">${safe}</code>
    <button type="button" class="copy-btn" data-copy-btn="${safe}" aria-label="Copy ${escape(label)}">Copy</button>
    <span class="copy-confirm" data-copy-confirm aria-live="polite"></span>
  </div>`;
}

landing.get("/", async (c) => {
  const engines = await readSearchEngines();
  const whoami = await getWhoami();
  const health = await upstreamHealth();

  const tcActive = engines.length > 0 || config.apiKey.trim() !== "";
  const seActive = health.ok;
  const seReason = seActive
    ? ""
    : `Search engine unreachable at <code>${escape(config.searchEngineBaseUrl)}/health</code>.`;
  const tcReason = tcActive
    ? ""
    : `Configure at least one search engine in <a href="/panel/toolconnector\">Toolconnector</a>, or set <code>CONNECTOR_API_KEY</code> in the env.`;

  const tcConfigHint = `
    <div class="card-hint">
      Point your toolconnector at this panel:
      ${renderCopyBlock("TOOLPANEL_URL", `${config.publicUrl}`)}
      ${renderCopyBlock("CONNECTOR_SEARCH_CONFIG_MODE", "auto")}
    </div>`;

  const tcStatus = toolconnectorPill(whoami);

  const searchEngineStatus = seActive
    ? `<div class="kv">
        <span class="k">Search engine</span>
        <span class="status ${pillClass("fresh")}">
          reachable${health.backend ? ` &middot; backend: ${escape(health.backend)}` : ""}${health.documentCount ? ` &middot; ${health.documentCount} docs` : ""}
        </span>
      </div>`
    : `<div class="kv"><span class="k">Search engine</span><span class="status ${pillClass("never")}">unreachable</span></div>`;

  const tc = card(`/panel/toolconnector`, "Toolconnector", "Configure the search engines and discovery settings your local AI agent uses during boot.", tcActive, tcConfigHint + tcStatus, tcReason);
  const se = card(`/panel/search`, "Toolhub", "Run discovery queries, add/edit/remove MCP servers in the search index.", seActive, `<div class="card-hint"><div class="kv"><span class="k">URL</span><code>${escape(config.searchEngineBaseUrl)}</code></div>${searchEngineStatus}</div>`, seReason);

  const body = `
    <header class="hero">
      <div class="hero-badge">open-source control panel &middot; local-only</div>
      <h1 class="hero-title">Tool<span class="accent">panel</span></h1>
      <p class="hero-sub">
        A drop-in replacement for the public SaaS. Point your toolconnector at this panel and the AI agent reads its discovery configuration from here. Wrap your Toolhub with a small admin UI.
      </p>
      <div class="hero-meta">
        <div class="kv"><span class="k">Running at</span><code>${escape(config.publicUrl)}</code></div>
        <div class="kv">
          <span class="k">CONNECTOR_API_KEY</span>
          <code>${config.apiKey ? "set" : "unset (using open device-flow)"}</code>
        </div>
        ${searchEngineStatus}
        <div class="kv"><span class="k">Toolconnector</span>${tcStatus}</div>
      </div>
    </header>
    <div class="cards">
      ${tc}
      ${se}
    </div>
    <footer class="foot muted">
      Toolpanel is a template. No authentication &mdash; bind to <code>127.0.0.1</code> only.
    </footer>`;

  return c.html(layout({ title: "Home", active: "landing", body }));
});

function card(href: string, title: string, desc: string, active: boolean, statusHtml: string, reason: string): string {
  const button = active
    ? `<a href="${href}" class="btn btn-primary btn-lg">Open</a>`
    : `<button class="btn btn-primary btn-lg" disabled title="Unavailable">Unavailable</button>`;
  return `
    <section class="card ${active ? "card-active" : "card-inactive"}">
      <div class="card-head">
        <h2 class="card-title">${title}</h2>
        <span class="dot dot-${active ? "on" : "off"}" aria-hidden="true"></span>
      </div>
      <p class="card-desc">${desc}</p>
      ${statusHtml ? `<div class="card-status">${statusHtml}</div>` : ""}
      ${reason ? `<p class="card-reason">${reason}</p>` : ""}
      <div class="card-cta">${button}</div>
    </section>`;
}
