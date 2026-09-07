import { Hono } from "hono";
import { config } from "../config.js";
import { upstreamHealth } from "../lib/http.js";
import { layout, escapeHtml } from "../views/layout.js";
import { buildGlobalStatus } from "../globalStatus.js";

export const panelSearch = new Hono();

panelSearch.get("/panel/search", async (c) => {
  const [health, globalStatus] = await Promise.all([upstreamHealth(), buildGlobalStatus()]);
  const baseUrl = escapeHtml(config.searchEngineBaseUrl);
  const healthPill = health.ok
    ? `<span class="status status-ok" data-search-health-pill>
         Search engine: reachable
         ${health.backend ? `&middot; backend: <strong>${escapeHtml(health.backend)}</strong>` : ""}
         ${typeof health.documentCount === "number" ? ` &middot; ${health.documentCount} docs` : ""}
       </span>`
    : `<span class="status status-bad" data-search-health-pill>
         Search engine: unreachable at <code>${baseUrl}/health</code>
         &mdash; start <code>packages/toolhub</code> or check <code>SEARCH_ENGINE_BASE_URL</code>
       </span>`;

  const body = `
    <header class="page-head">
      <h1>Toolhub Search</h1>
      <p class="muted">Discovery queries are proxied to <code>${baseUrl}</code>. Submit a search to see matching servers and tools.</p>
      <div class="page-head-pills">${healthPill}</div>
    </header>
    <section class="card">
      <form class="form-inline" data-search-form>
        <label class="field field-grow">
          <span>Query</span>
          <input name="q" type="text" placeholder="github, weather, finance..." required />
        </label>
        <label class="field">
          <span>Tags (comma)</span>
          <input name="tags" type="text" placeholder="code, dev" />
        </label>
        <label class="field">
          <span>Provider</span>
          <input name="provider" type="text" placeholder="acme" />
        </label>
        <label class="field">
          <span>Limit</span>
          <input name="limit" type="number" min="1" max="100" value="20" />
        </label>
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div class="facets" data-facets></div>
    </section>
    <section class="card">
      <h2>Results</h2>
      <div class="results" data-results aria-live="polite" aria-busy="false">
        <p class="muted">Run a search to see results here.</p>
      </div>
      <div class="pagination" data-pagination hidden></div>
    </section>`;

  return c.html(layout({ title: "Toolhub Search", active: "search", body, globalStatus }));
});
