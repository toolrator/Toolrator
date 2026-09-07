import { Hono } from "hono";
import { config } from "../config.js";
import { upstreamHealth } from "../lib/http.js";
import { layout, escapeHtml } from "../views/layout.js";
import { buildGlobalStatus } from "../globalStatus.js";

export const panelSearchAdmin = new Hono();

panelSearchAdmin.get("/panel/search/admin", async (c) => {
  const [health, globalStatus] = await Promise.all([upstreamHealth(), buildGlobalStatus()]);

  const baseUrl = escapeHtml(config.searchEngineBaseUrl);
  const healthPill = health.ok
    ? `<span class="status status-ok">Search engine: reachable${health.backend ? ` &middot; backend: <strong>${escapeHtml(health.backend)}</strong>` : ""}${typeof health.documentCount === "number" ? ` &middot; ${health.documentCount} docs` : ""}</span>`
    : `<span class="status status-bad">Search engine: unreachable at <code>${baseUrl}/health</code> &mdash; admin actions below will fail until it's started.</span>`;

  const body = `
    <header class="page-head">
      <h1>Toolhub Admin</h1>
      <p class="muted">Admin actions are proxied to <code>${baseUrl}/admin/*</code> with the configured <code>SEARCH_ADMIN_TOKEN</code>.</p>
      <div class="page-head-pills">${healthPill}</div>
    </header>
    <section class="card">
      <div class="card-head">
        <h2>Indexed MCP servers <span class="badge" data-admin-count>—</span></h2>
        <div class="card-actions">
          <input class="admin-filter" type="search" placeholder="Filter by name, tag, provider…" data-admin-filter aria-label="Filter servers" />
          <button class="btn btn-ghost" data-admin-refresh title="Reload the index from the engine">Refresh</button>
          <button class="btn btn-ghost" data-admin-add>+ Add server</button>
          <button class="btn btn-ghost" data-admin-reindex>Reindex all</button>
        </div>
      </div>
      <div class="form-msg" data-admin-msg role="status" aria-live="polite"></div>
      <div class="table-wrap">
        <table class="table">
           <thead>
             <tr>
               <th class="sortable" data-sort="mcp_name" aria-sort="none">mcp_name <span class="sort-arrow" aria-hidden="true"></span></th>
               <th class="sortable" data-sort="display_name" aria-sort="none">display_name <span class="sort-arrow" aria-hidden="true"></span></th>
               <th>tags</th>
               <th class="sortable" data-sort="provider" aria-sort="none">provider <span class="sort-arrow" aria-hidden="true"></span></th>
               <th>health</th>
               <th class="sortable" data-sort="updated_at" aria-sort="none">updated <span class="sort-arrow" aria-hidden="true"></span></th>
               <th></th>
             </tr>
           </thead>
          <tbody id="admin-rows" data-docs=""><tr><td colspan="7" class="muted admin-rows-loading">Loading…</td></tr></tbody>
        </table>
      </div>
    </section>
    <dialog class="modal" data-modal>
      <form class="form" data-admin-form>
        <header class="modal-head">
          <h3 data-modal-title>Add MCP server</h3>
          <button type="button" class="btn btn-ghost btn-sm" data-modal-close>Close</button>
        </header>
        <input type="hidden" name="__mode" value="add" />
        <input type="hidden" name="__original_name" value="" />
        <label class="field"><span>mcp_name *</span><input name="mcp_name" autocomplete="off" required /></label>
        <label class="field"><span>display_name *</span><input name="display_name" /></label>
        <label class="field"><span>tags (comma-separated, max 20)</span><input name="tags" placeholder="code, dev" /></label>
        <label class="field"><span>provider</span><input name="provider" /></label>
        <label class="field"><span>description (max 4096)</span><textarea name="description" rows="3"></textarea></label>
        <label class="field"><span>docs_url</span><input name="docs_url" type="url" /></label>
        <label class="field"><span>homepage_url</span><input name="homepage_url" type="url" /></label>
        <label class="field"><span>protocol_version</span><input name="protocol_version" /></label>
        <label class="field"><span>capabilities (JSON object, e.g. {"tools":[...]})</span><textarea name="capabilities" rows="3"></textarea></label>
        <label class="field"><span>health_status</span><input name="health_status" /></label>
        <label class="field"><span>updated_at (ISO; default now)</span><input name="updated_at" /></label>
        <footer class="modal-foot">
          <button class="btn btn-primary" type="submit">Save</button>
          <button class="btn btn-ghost" type="button" data-modal-close>Cancel</button>
        </footer>
      </form>
    </dialog>`;

  return c.html(layout({ title: "Toolhub Admin", active: "search-admin", body, globalStatus }));
});
