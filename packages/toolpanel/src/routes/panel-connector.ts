import { Hono } from "hono";
import { readSearchEngines } from "../storage.js";
import { getWhoami } from "../whoami.js";
import { upstreamFetch } from "../lib/http.js";
import { layout, escapeHtml, escapeHtml as escape, relTimeAgo } from "../views/layout.js";
import { buildGlobalStatus } from "../globalStatus.js";

export const panelConnector = new Hono();

// Server-side fetch of the canonical search schema with a hardcoded fallback so the
// Reference panel in /panel/toolconnector never renders blank if /api/search/schema
// itself errors (it shouldn't, but defense in depth).
async function loadCanonicalSchema(): Promise<unknown> {
  try {
    const res = await upstreamFetch("/api/search/schema", { method: "GET" }, 2_000);
    if (res.status === 200) {
      const text = await res.text();
      return JSON.parse(text);
    }
  } catch {
    /* fall through */
  }
  return {
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    outputDescription: "Schema unavailable — /api/search/schema returned a non-2xx response.",
  };
}

panelConnector.get("/panel/toolconnector", async (c) => {
  const [engines, whoami, schema, globalStatus] = await Promise.all([
    readSearchEngines(),
    getWhoami(),
    loadCanonicalSchema(),
    buildGlobalStatus(),
  ]);
  const enginesJson = escapeHtml(JSON.stringify(engines));
  const schemaJson = escapeHtml(JSON.stringify(schema, null, 2));

  const apiKeyLine = `
    <section class="card">
      <h2>API key</h2>
      <p class="muted">${process.env.CONNECTOR_API_KEY
        ? "Environment variable <code>CONNECTOR_API_KEY</code> is set. toolconnector can use it directly to skip the device flow."
        : "No <code>CONNECTOR_API_KEY</code> in the panel's env. toolconnector will be forced to use the device flow at <a href=\"/device\">/device</a>."}</p>
    </section>`;

  const whoamiStatePill = (() => {
    switch (whoami.state) {
      case "fresh":
        return `<span class="status status-ok">Authentication successful &middot; last seen ${escape(relTimeAgo(whoami.lastVerifyKeyAt))}</span>`;
      case "recent":
        return `<span class="status status-muted">Last verify-key ok &middot; ${escape(relTimeAgo(whoami.lastVerifyKeyAt))}</span>`;
      case "failed":
        return `<span class="status status-bad">Last verify-key failed &middot; ${escape(relTimeAgo(whoami.lastErrorAt ?? whoami.lastVerifyKeyAt))}${whoami.lastErrorReason ? ` &middot; <code>${escape(whoami.lastErrorReason)}</code>` : ""}</span>`;
      default:
        return `<span class="status status-muted">Never seen a toolconnector on this panel</span>`;
    }
  })();

  const authCard = `
    <section class="card">
      <div class="card-head">
        <h2>Authentication</h2>
        <span class="badge" data-auth-verkey-count>${whoami.verifyKeyCount ?? 0} verify-key hits</span>
      </div>
      <div class="card-status">${whoamiStatePill}</div>
      <div class="kv-block">
        <div class="kv"><span class="k">Last seen at</span><code>${whoami.lastSeenAt ? new Date(whoami.lastSeenAt).toISOString() : "—"}</code></div>
        <div class="kv"><span class="k">Last verify-key</span><code>${whoami.lastVerifyKeyAt ? new Date(whoami.lastVerifyKeyAt).toISOString() : "—"}</code> ${whoami.lastVerifyKeyOk === true ? '<span class="status status-ok">ok</span>' : whoami.lastVerifyKeyOk === false ? '<span class="status status-bad">failed</span>' : ""}</div>
        <div class="kv"><span class="k">First seen</span><code>${whoami.firstSeenAt ? new Date(whoami.firstSeenAt).toISOString() : "—"}</code></div>
        <div class="kv"><span class="k">Bearer key #</span><code>${whoami.bearerPrefix ? `#${escape(whoami.bearerPrefix)}` : "—"}</code> <span class="muted hint">(sha256 prefix; the real key never leaves toolconnector)</span></div>
        <div class="kv"><span class="k">Last auto-pull</span><code>${whoami.lastAutoPullAt ? new Date(whoami.lastAutoPullAt).toISOString() : "—"}</code>${whoami.lastAutoPullAt ? ` <span class="muted hint"> &middot; ${whoami.lastEngineCount ?? 0} engines returned</span>` : ""}</div>
        ${whoami.lastErrorReason ? `<div class="kv"><span class="k">Last error</span><code>${escape(whoami.lastErrorReason)}</code> <span class="muted hint">at ${whoami.lastErrorAt ? new Date(whoami.lastErrorAt).toISOString() : "—"}</span></div>` : ""}
      </div>
      <p class="muted hint" style="margin-top:10px">Authorizing another connector is one click: <a href="/device">/device</a> (the panel's open device-flow page).</p>
    </section>`;

  const body = `
    <header class="page-head">
      <h1>Toolconnector</h1>
      <p class="muted">Configure the discovery sources your local <code>toolconnector</code> queries at boot. Saved to <code>toolpanel-config/search-engines.json</code> and served to the connector via <code>/api/connector/config/auto</code>.</p>
    </header>
    ${authCard}
    <section class="card">
      <div class="card-head">
        <h2>Search engines</h2>
        <div class="card-actions">
          <button class="btn btn-ghost" data-engine-add>+ Add engine</button>
          <button class="btn btn-primary" data-engine-save>Save</button>
        </div>
      </div>
      <div class="form-msg" data-engine-msg role="status" aria-live="polite"></div>
      <div id="engines-list" data-engines='${enginesJson}'></div>
    </section>
    ${apiKeyLine}
    <details class="card">
      <summary>Reference: search engine schema (what <code>schemaUrl</code> must return)</summary>
      <pre class="pre-scroll"><code>${schemaJson}</code></pre>
      <p class="muted">Toolpanel's own <code>/api/search/schema</code> returns this canonical shape, so pointing an engine's <code>schemaUrl</code> at <code>/api/search/schema</code> works out of the box.</p>
    </details>`;

  return c.html(layout({ title: "Toolconnector", active: "toolconnector", body, globalStatus }));
});
