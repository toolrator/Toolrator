// Toolpanel client islands. Plain JS, no build pipeline.
// Wired via data-* attributes in the server-rendered HTML.

(function () {
  "use strict";

  // ----- tiny helpers --------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  };
  const msg = (node, text, kind) => {
    if (!node) return;
    node.textContent = text || "";
    node.classList.remove("ok", "err");
    if (kind) node.classList.add(kind);
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&", "<": "<", ">": ">", '"': "&quot;", "'": "&#39;" })[m]);

  async function jget(url) { const r = await fetch(url, { headers: { Accept: "application/json" } }); return r.json().catch(() => ({})).then((d) => ({ status: r.status, data: d })); }
  async function jpost(url, body, method = "POST") {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body ?? {}) });
    return r.json().catch(() => ({})).then((d) => ({ status: r.status, data: d }));
  }
  async function jdel(url) { const r = await fetch(url, { method: "DELETE", headers: { Accept: "application/json" } }); return r.json().catch(() => ({})).then((d) => ({ status: r.status, data: d })); }

  // ----- device confirm page ------------------------------------------------

  (() => {
    const form = document.querySelector("[data-device-confirm]");
    if (!form) return;

    const slotLetters = form.querySelector('[data-code-slot="0"]');
    const slotDigits = form.querySelector('[data-code-slot="1"]');
    const combined = form.querySelector("[data-code-combined]");
    const pasteBtn = form.querySelector("[data-device-paste]");
    const submitBtn = form.querySelector("[data-device-submit]");
    const m = form.querySelector("[data-device-msg]");
    const stateBox = document.querySelector("[data-device-state]");
    const stateDot = document.querySelector("[data-state-dot]");
    const stateText = document.querySelector("[data-state-text]");
    const stateHint = document.querySelector("[data-state-hint]");

    const LETTERS = /^[A-Z]{4}$/;
    const DIGITS = /^[0-9]{4}$/;

    function normalizeLetters(v) {
      return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    }
    function normalizeDigits(v) {
      return (v || "").toUpperCase().replace(/[^0-9]/g, "").slice(0, 4);
    }

    function combinedCode() {
      const L = normalizeLetters(slotLetters.value);
      const D = normalizeDigits(slotDigits.value);
      return L.length === 4 && D.length === 4 ? `${L}-${D}` : "";
    }

    function syncValid() {
      const L = normalizeLetters(slotLetters.value);
      const D = normalizeDigits(slotDigits.value);
      slotLetters.classList.toggle("is-valid", LETTERS.test(L));
      slotLetters.classList.toggle("is-invalid", L.length > 0 && !LETTERS.test(L));
      slotDigits.classList.toggle("is-valid", DIGITS.test(D));
      slotDigits.classList.toggle("is-invalid", D.length > 0 && !DIGITS.test(D));
      const ok = combinedCode() !== "";
      submitBtn.disabled = !ok;
      combined.value = combinedCode();
      return ok;
    }

    // Auto-tab from letters → digits when the letters slot is full.
    slotLetters.addEventListener("input", () => {
      slotLetters.value = normalizeLetters(slotLetters.value);
      syncValid();
      if (slotLetters.value.length === 4) slotDigits.focus();
    });
    slotDigits.addEventListener("input", () => {
      slotDigits.value = normalizeDigits(slotDigits.value);
      syncValid();
      if (slotDigits.value.length === 4) submitBtn.focus();
    });

    // Backspace from an empty digits slot jumps back to letters.
    slotDigits.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && slotDigits.value.length === 0) {
        e.preventDefault();
        slotLetters.focus();
        slotLetters.setSelectionRange(slotLetters.value.length, slotLetters.value.length);
      }
    });

    // Paste anywhere distributes: "ABCD-1234" / "abcd 1234" / "ABCD1234" all OK.
    [slotLetters, slotDigits].forEach((s) => {
      s.addEventListener("paste", (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData || {}).getData("text") || "";
        const cleaned = pasted.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (cleaned.length === 8) {
          slotLetters.value = cleaned.slice(0, 4);
          slotDigits.value = cleaned.slice(4, 8);
          syncValid();
          submitBtn.focus();
        } else if (cleaned.length === 4 && s === slotLetters) {
          // user pasted just the letters half
          slotLetters.value = cleaned;
          syncValid();
          slotDigits.focus();
        } else {
          // fall back to letting the slot handle it (only 4 chars fit anyway)
          s.value = (s === slotLetters ? normalizeLetters(pasted) : normalizeDigits(pasted)).slice(0, 4);
          syncValid();
        }
      });
    });

    if (pasteBtn) {
      pasteBtn.addEventListener("click", async () => {
        try {
          const text = await navigator.clipboard.readText();
          const cleaned = (text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (cleaned.length === 8) {
            slotLetters.value = cleaned.slice(0, 4);
            slotDigits.value = cleaned.slice(4, 8);
            syncValid();
            submitBtn.focus();
            return;
          }
          msg(m, "Clipboard doesn’t contain an 8-char code.", "err");
        } catch {
          msg(m, "Clipboard read blocked — paste with Ctrl+V in the input instead.", "err");
        }
      });
    }

    // Keyboard shortcut: Enter anywhere submits if valid.
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && combinedCode()) {
        e.preventDefault();
        submitBtn.click();
      }
    });

    function setState(kind, text, hint) {
      stateBox.hidden = false;
      stateBox.classList.remove("is-success", "is-pending", "is-error");
      if (kind) stateBox.classList.add(`is-${kind}`);
      stateDot.className = "dot";
      if (kind === "success") stateDot.classList.add("dot-on");
      else if (kind === "pending") stateDot.classList.add("dot-waiting");
      else if (kind === "error") stateDot.classList.add("dot-off");
      stateText.textContent = text;
      stateHint.textContent = hint || "";
    }

    let pollTimer = null;
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    function startPolling(userCode) {
      stopPolling();
      const tick = async () => {
        const { status, data } = await jget(`/api/auth/device/status?user_code=${encodeURIComponent(userCode)}`);
        if (status !== 200 || !data) return;
        if (data.status === "confirmed") {
          setState("success", "Confirmed — your toolconnector is authorized.", "The agent has already claimed the code and received its API key. You can close this page.");
          stopPolling();
        } else if (data.status === "unknown") {
          // Could have been consumed already (the success response evicts the row).
          // Treat as success — the agent picked it up.
          setState("success", "Confirmed — your toolconnector is authorized.", "Your agent already polled and received its API key. You can close this page.");
          stopPolling();
        } else if (data.status === "pending") {
          setState("pending", "Waiting for your AI agent to poll…", "The agent polls roughly every 60 s. Leave this page open until it picks up the credentials.");
        }
      };
      tick();
      pollTimer = setInterval(tick, 4000);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = combinedCode();
      if (!code) {
        msg(m, "Enter the full 8-character code.", "err");
        return;
      }
      submitBtn.disabled = true;
      msg(m, "Confirming…");
      const { status, data } = await jpost("/api/auth/device/confirm", { user_code: code });
      submitBtn.disabled = false;
      if (status === 200 && data && data.success) {
        msg(m, "Confirmed.", "ok");
        setState("pending", "Waiting for your AI agent to poll…", "The agent polls roughly every 60 s. Leave this page open until it picks up the credentials.");
        startPolling(code);
      } else if (status === 404) {
        msg(m, (data && data.message) || "No pending device code matches that input.", "err");
        setState("error", "Code not found.", "Make sure your AI agent just ran start_device_flow, then re-enter the new code.");
      } else {
        msg(m, (data && data.message) || "Confirm failed.", "err");
        setState("error", "Could not confirm the code.", (data && data.message) || "Try again.");
      }
    });

    syncValid();
    setTimeout(() => slotLetters.focus(), 100);

    // If the URL has a query (?user_code=ABCD-1234), the server pre-fills both
    // slots — auto-validate, and offer a one-tap confirm.
    if (combinedCode() && typeof navigator !== "undefined" && navigator.clipboard) {
      submitBtn.focus();
    }
  })();

  // ----- toolconnector search-engines editor --------------------------------

  const TRANSPORTS = ["http", "mcp-http", "mcp-sse", "mcp-stdio"];
  const AUTH_TYPES = ["bearer", "basic", "header"];

  // Shared drag state for the connector editor's drag-to-reorder handler.
  // Set on dragstart and cleared on dragend.
  const dragState = { row: null };

  function renderEngineRow(engine, list, opts = {}) {
    const row = el("div", { class: "engine", dataset: { id: engine.id } });
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", (e) => {
      row.classList.add("is-dragging");
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(engine.id || "")); } catch {}
      dragState.row = row;
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
      $$(".engine.is-drag-target", list).forEach((n) => n.classList.remove("is-drag-target"));
      dragState.row = null;
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragState.row || dragState.row === row) return;
      // Decide whether to drop above or below the hovered row.
      const rect = row.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      row.classList.toggle("is-drag-target", true);
      row.dataset.dropSide = above ? "above" : "below";
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-drag-target"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragState.row || dragState.row === row) return;
      row.classList.remove("is-drag-target");
      const above = row.dataset.dropSide === "above";
      if (above) row.parentNode.insertBefore(dragState.row, row);
      else row.parentNode.insertBefore(dragState.row, row.nextSibling);
    });

    const head = el("div", { class: "engine-head", style: "cursor: pointer; user-select: none; transition: margin 0.15s;" });
    const dragHandle = el("button", {
      type: "button",
      class: "engine-drag-handle",
      title: "Drag to reorder",
      "aria-label": "Drag to reorder this engine",
      onclick: (ev) => { ev.preventDefault(); row.draggable && row.dispatchEvent(new DragEvent("dragstart")); },
    }, "⠿");
    head.appendChild(dragHandle);
    
    const titleDiv = el("div", { class: "engine-title" });
    const chevron = el("span", { style: "display: inline-block; width: 16px; margin-right: 6px; font-size: 0.8rem; transition: transform 0.15s; text-align: center;" }, "▼");
    const titleText = el("span", { class: "engine-title-text" }, engine.label || engine.id || "new engine");
    titleDiv.appendChild(chevron);
    titleDiv.appendChild(titleText);
    head.appendChild(titleDiv);
    
    const removeBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: (e) => { e.stopPropagation(); row.remove(); } }, "Remove");
    head.appendChild(removeBtn);
    row.appendChild(head);

    const grid = el("div", { class: "engine-grid" });

    // Collapse logic
    head.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const collapsed = row.classList.toggle("is-collapsed");
      grid.style.display = collapsed ? "none" : "";
      chevron.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
      head.style.marginBottom = collapsed ? "0" : "";
    });

    // Start collapsed by default
    row.classList.add("is-collapsed");
    grid.style.display = "none";
    chevron.style.transform = "rotate(-90deg)";
    head.style.marginBottom = "0";

    const make = (n, label, kind, value, attrs = {}) =>
      el("label", { class: "field" }, el("span", {}, label),
        kind === "select"
          ? el("select", { dataset: { field: n }, ...attrs }, ...value.map((v) => el("option", { value: v, ...(v === value.selected ? { selected: "selected" } : {}) }, v)))
          : kind === "checkbox"
            ? el("input", { type: "checkbox", dataset: { field: n }, ...(value ? { checked: true } : {}), ...attrs })
            : el("input", { type: kind || "text", dataset: { field: n }, value: value ?? "", ...attrs }),
      );

    // Section: identity
    const idField = make("id", "id", "text", engine.id, { placeholder: "my-engine", });
    const labelField = make("label", "label", "text", engine.label, { placeholder: "My Engine" });
    grid.appendChild(section("Identity", idField, labelField));

    // Section: connection
    const transField = el("label", { class: "field" }, el("span", {}, "transport"),
      el("select", { dataset: { field: "transport" }, onchange: () => onTransportCb(row.querySelector('[data-field="transport"]').value, row) },
        ...TRANSPORTS.map((t) => el("option", { value: t, ...(t === engine.transport ? { selected: "selected" } : {}) }, t)),
      ),
    );
    const endpointField = make("endpoint", engine.transport === "mcp-stdio" ? "endpoint (command, e.g. npx)" : "endpoint (URL)", "text", engine.endpoint, { placeholder: "http://localhost:7600/search" });
    grid.appendChild(section("Connection", transField, endpointField));

    // Hidden args/schema rows (filled by transport)
    row._args = engine.args?.join(", ");
    row._schemaUrl = engine.schemaUrl ?? "";
    const argsLine = el("div", { class: "engine-row args" });
    const schemaLine = el("div", { class: "engine-row schema" });
    grid.appendChild(section("Transport options", argsLine, schemaLine));

    // Section: auth
    const authTypeSel = el("select", { dataset: { field: "auth.type" }, onchange: () => onAuthTypeCb(row.querySelector('[data-field="auth.type"]').value, row) },
      el("option", { value: "" }, "none"), ...AUTH_TYPES.map((t) => el("option", { value: t, ...((engine.auth && engine.auth.type === t) ? { selected: "selected" } : {}) }, t)),
    );
    const tokenField = make("auth.tokenEnv", "tokenEnv (env var name)", "text", engine.auth?.tokenEnv || "", { placeholder: "ENV_VAR_NAME" });
    const headerField = make("auth.headerName", "headerName", "text", engine.auth?.headerName || "", { placeholder: "X-My-Header" });
    grid.appendChild(section("Auth", el("label", { class: "field" }, el("span", {}, "auth.type"), authTypeSel), tokenField, headerField));

    // Section: behaviour
    const notes = el("label", { class: "field field-wide" }, el("span", {}, "notes (visible to AI)"), el("textarea", { dataset: { field: "notes" } }, (engine.notes || "") ));
    const timeout = make("timeoutMs", "timeoutMs (ms)", "number", engine.timeoutMs ?? 10000, { min: "1", max: "60000" });
    const enabledWrap = el("label", { class: "field checkbox" }, el("input", { type: "checkbox", dataset: { field: "enabled" }, ...(engine.enabled === false ? {} : { checked: true }) }), el("span", {}, "enabled"));
    grid.appendChild(section("Behaviour", notes, timeout, enabledWrap));

    row.appendChild(grid);
    list.appendChild(row);

    onTransportCb(engine.transport, row);
    onAuthTypeCb(engine.auth?.type || "", row);
    return row;
  }

  function section(title, ...children) {
    const s = el("div", { class: "engine-section" });
    s.appendChild(el("div", { class: "engine-section-title" }, title));
    const inner = el("div", { class: "engine-section-body" });
    children.forEach((c) => inner.appendChild(c));
    s.appendChild(inner);
    return s;
  }

  function onTransportCb(t, row) {
    const argsLine = row.querySelector(".engine-row.args");
    const schemaLine = row.querySelector(".engine-row.schema");
    if (!argsLine) return;
    argsLine.innerHTML = "";
    if (schemaLine) schemaLine.innerHTML = "";
    if (t === "mcp-stdio") {
      const f = el("label", { class: "field" }, el("span", {}, "args (comma-separated)"), el("input", { type: "text", dataset: { field: "args" }, value: row._args ?? "" }));
      argsLine.appendChild(f);
    } else {
      const f = el("label", { class: "field" }, el("span", {}, "schemaUrl"), el("input", { type: "url", dataset: { field: "schemaUrl" }, value: row._schemaUrl ?? "", placeholder: "/api/search/schema" }));
      if (schemaLine) schemaLine.appendChild(f);
    }
  }

  function onAuthTypeCb(t, row) {
    const headerField = row.querySelector('[data-field="auth.headerName"]')?.closest("label.field");
    if (headerField) headerField.style.display = t === "header" ? "" : "none";
  }

  function initToolconnector() {
    const list = $("#engines-list");
    const addBtn = $("[data-engine-add]");
    const saveBtn = $("[data-engine-save]");
    const m = $("[data-engine-msg]");
    if (!list) return;

    function clearErrors() {
      $$(".engine .is-invalid", list).forEach((n) => n.classList.remove("is-invalid"));
      $$(".engine .field-error", list).forEach((n) => n.remove());
    }
    function showFieldError(row, fieldName, message) {
      if (!row) return;
      const input = row.querySelector(`[data-field="${CSS.escape(fieldName)}"]`) || row.querySelector(`[data-field^="${CSS.escape(fieldName)}."]`);
      if (!input) return;
      input.classList.add("is-invalid");
      const label = input.closest("label.field");
      if (!label) return;
      let err = label.querySelector(".field-error");
      if (!err) {
        err = el("span", { class: "field-error" });
        label.appendChild(err);
      }
      err.textContent = message;
    }

    let initial = [];
    try { initial = JSON.parse(list.dataset.engines || "[]"); } catch {}
    initial.forEach((e) => renderEngineRow(e, list));
    addBtn?.addEventListener("click", () => {
      const row = renderEngineRow({ id: "", label: "", transport: "http", endpoint: "", timeoutMs: 10000, enabled: true }, list);
      // Auto-scroll the new row into view so the user doesn't have to hunt for it.
      if (row && typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ behavior: "smooth", block: "nearest" });
        // Focus the id input so editing starts immediately.
        const idInput = row.querySelector('[data-field="id"]');
        if (idInput) setTimeout(() => idInput.focus(), 250);
      }
    });
    saveBtn?.addEventListener("click", async () => {
      clearErrors();
      const rows = $$(".engine", list);
      const engines = rows.map((row) => {
        const get = (n) => row.querySelector(`[data-field="${n}"]`);
        const val = (n) => (get(n) ? get(n).value.trim() : "");
        const engine = {
          id: val("id"),
          label: val("label"),
          transport: val("transport"),
          endpoint: val("endpoint"),
          timeoutMs: Number.parseInt(val("timeoutMs") || "10000", 10) || 10000,
          enabled: get("enabled")?.checked ?? true,
        };
        if (val("schemaUrl")) engine.schemaUrl = val("schemaUrl");
        if (val("notes")) engine.notes = val("notes");
        const argsVal = val("args");
        if (argsVal) engine.args = argsVal.split(",").map((s) => s.trim()).filter(Boolean);
        const authType = val("auth.type");
        if (authType) {
          const auth = { type: authType };
          if (val("auth.tokenEnv")) auth.tokenEnv = val("auth.tokenEnv");
          if (authType === "header" && val("auth.headerName")) auth.headerName = val("auth.headerName");
          engine.auth = auth;
        }
        return engine;
      });
      // Dropping rows whose id/label/endpoint are empty client-side is the historical
      // behavior — server validation will catch everything else and report per-field.
      const dropped = rows.length - engines.length;
      msg(m, "Saving…");
      const { status, data } = await jpost("/api/connector/config", { searchEngines: engines }, "PUT");
      if (status === 200 && data && data.success) {
        const base = `Saved ${engines.length} engine${engines.length === 1 ? "" : "s"}.`;
        msg(m, dropped > 0 ? `${base} (${dropped} row${dropped === 1 ? "" : "s"} skipped — each needs an id, label, and endpoint)` : base, "ok");
      } else if (data && Array.isArray(data.invalid) && data.invalid.length) {
        // Per-field server validation: highlight each offending field on the matching row.
        let firstBadRow = null;
        for (const err of data.invalid) {
          const row = rows[err.index] ?? null;
          if (!row) continue;
          if (!firstBadRow) firstBadRow = row;
          const field = err.field?.split(".")[0] ?? "__row__";
          if (field === "__row__" || !field) {
            // Generic row-level error (duplicate id, etc.) — surface on id input as a stand-in.
            showFieldError(row, "id", err.message);
          } else {
            showFieldError(row, field, err.message);
          }
        }
        const n = data.invalid.length;
        msg(m, `Save failed: ${n} field${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} fixing (highlighted below).`, "err");
        if (firstBadRow && typeof firstBadRow.scrollIntoView === "function") {
          firstBadRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      } else {
        msg(m, (data && data.message) || "Save failed.", "err");
      }
    });
  }
  initToolconnector();

  // ----- mobile nav hamburger ------------------------------------------------

  function initNavToggle() {
    const toggle = $("#nav-toggle");
    if (!toggle) return;
    const sidebar = $("#sidebar");
    const nav = $("#primary-nav");
    if (!sidebar || !nav) return;
    function setOpen(open) {
      sidebar.classList.toggle("is-nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    toggle.addEventListener("click", () => {
      const open = !sidebar.classList.contains("is-nav-open");
      setOpen(open);
    });
    nav.addEventListener("click", (e) => {
      if (e.target instanceof HTMLAnchorElement) setOpen(false);
    });
    document.addEventListener("click", (e) => {
      if (!sidebar.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
    if (window.matchMedia) {
      const mq = window.matchMedia("(max-width: 760px)");
      const handler = (mql) => { if (!mql.matches) setOpen(false); };
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", handler);
      else if (typeof mq.addListener === "function") mq.addListener(handler);
    }
  }
  initNavToggle();

  // ----- copy-to-clipboard buttons (landing-page env hints) ----------------

  function initCopyButtons() {
    const buttons = $$("[data-copy-btn]");
    if (!buttons.length) return;
    buttons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = btn.getAttribute("data-copy-btn") || "";
        const confirm = btn.parentElement?.querySelector("[data-copy-confirm]");
        let ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            ok = true;
          } else {
            const ta = document.createElement("textarea");
            ta.value = text; ta.setAttribute("readonly", "");
            ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select(); ta.setSelectionRange(0, text.length);
            ok = document.execCommand("copy");
            document.body.removeChild(ta);
          }
        } catch { ok = false; }
        if (ok) {
          btn.classList.add("is-copied");
          if (confirm) { confirm.textContent = "copied"; setTimeout(() => { confirm.textContent = ""; }, 1200); }
          setTimeout(() => btn.classList.remove("is-copied"), 1200);
        } else if (confirm) {
          confirm.textContent = "copy failed — select the code and Ctrl+C";
        }
      });
    });
  }
  initCopyButtons();

  // ----- search panel --------------------------------------------------------
  //
  // Four distinct result states, all rendered into [data-results]:
  //   - success                    → server / tool cards
  //   - no-results (200 empty)     → friendly empty state with the query echoed
  //   - upstream-error (4xx/5xx)   → red panel with HTTP status + upstreamMessage
  //   - upstream-unreachable (503) → red panel with the network-error message
  // Plus: a CSS-only spinner while waiting, clickable facet chips that
  // resubmit, "Clear filters", and Prev/Next pagination using offset/limit.

  function initSearch() {
    const form = $("[data-search-form]");
    const results = $("[data-results]");
    const facets = $("[data-facets]");
    const pagination = $("[data-pagination]");
    if (!form) return;

    const qInput = form.elements["q"];
    const tagsInput = form.elements["tags"];
    const providerInput = form.elements["provider"];
    const limitInput = form.elements["limit"];

    let activeOffset = 0; // mutated by Prev/Next clicks
    let activeFilters = { tags: [], provider: "" }; // currently-applied filters (for faceting)

    function readLimit() {
      const n = Number.parseInt(limitInput.value || "20", 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
    }

    async function runSearch(offset = 0) {
      activeOffset = offset;
      const q = String(qInput.value || "").trim();
      if (!q) {
        renderError(results, { kind: "input", message: "Enter a search query." });
        if (pagination) pagination.hidden = true;
        return;
      }
      const body = { q, limit: readLimit(), offset: activeOffset };
      const tagsRaw = String(tagsInput.value || "");
      const provider = String(providerInput.value || "").trim();
      if (tagsRaw) body.tags = tagsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (provider) body.provider = provider;
      activeFilters = { tags: body.tags || [], provider: body.provider || "" };

      results.setAttribute("aria-busy", "true");
      results.innerHTML = "";
      results.appendChild(spinnerEl("Searching…"));
      if (pagination) pagination.hidden = true;

      const { status, data } = await jpost("/api/search", body);
      results.setAttribute("aria-busy", "false");

      if (!data || status !== 200) {
        renderError(results, envelopeToErrorState(status, data));
        return;
      }

      renderFacets(data.facets || {}, facets, body);
      const hits = data.hits || [];
      const toolHits = data.toolHits || [];
      if (!hits.length) {
        renderEmpty(results, q, activeFilters);
      } else {
        renderHits(hits, toolHits, results);
      }
      const page = data.pagination || null;
      const total = page && typeof page.total === "number" ? page.total : hits.length;
      renderPagination(pagination, { total, limit: body.limit || readLimit() }, currentOffset, hits.length, runSearch);
    }

    form.addEventListener("submit", (e) => { e.preventDefault(); runSearch(0); });

    // Initial facets load (so chips are visible before any search).
    jget("/api/facets").then(({ status, data }) => {
      if (status === 200 && data) renderFacets(data.facets || {}, facets, null);
    });

    // Allow Enter in any field to submit.
    for (const f of [tagsInput, providerInput, limitInput]) {
      if (f) f.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(0); } });
    }
  }

  function spinnerEl(label) {
    return el("div", { class: "spinner-wrap" },
      el("span", { class: "spinner", "aria-hidden": "true" }),
      el("span", { class: "muted" }, label || "Loading…"),
    );
  }

  // Normalize a jpost response into a small descriptor used by renderError.
  function envelopeToErrorState(status, data) {
    if (!data || typeof data !== "object") {
      return { kind: "unknown", status, message: "Unexpected response from toolpanel." };
    }
    const err = String(data.error || "");
    if (err === "upstream_unreachable") {
      return { kind: "unreachable", status, message: data.message || "Search engine not reachable.", upstreamMessage: data.upstreamMessage, upstreamUrl: data.upstreamUrl };
    }
    if (err === "upstream_error") {
      return { kind: "upstream", status, upstreamStatus: data.upstreamStatus, message: data.message || "Search engine error.", upstreamMessage: data.upstreamMessage, upstreamUrl: data.upstreamUrl };
    }
    if (err === "invalid_input") {
      return { kind: "input", status, message: data.message || "Invalid input." };
    }
    // Fallback: surface whatever we got.
    return { kind: "unknown", status, message: data.message || `HTTP ${status}`, upstreamMessage: data.upstreamMessage };
  }

  function renderError(container, e) {
    if (!container) return;
    container.innerHTML = "";
    const box = el("div", { class: `result-error result-error--${e.kind}` });
    box.appendChild(el("div", { class: "result-error-head" },
      el("span", { class: "result-error-pill" }, e.kind === "unreachable" ? "UNREACHABLE"
        : e.kind === "upstream" ? `UPSTREAM HTTP ${e.upstreamStatus ?? e.status ?? "?"}`
        : e.kind === "input" ? "INVALID INPUT"
        : `HTTP ${e.status ?? "?"}`),
    ));
    box.appendChild(el("p", { class: "result-error-msg" }, e.message || "Search failed."));
    if (e.upstreamMessage) box.appendChild(el("p", { class: "result-error-upstream" }, `Upstream said: ${e.upstreamMessage}`));
    if (e.upstreamUrl) box.appendChild(el("p", { class: "result-error-url muted" }, `Upstream: ${e.upstreamUrl}`));
    if (e.kind === "unreachable") {
      box.appendChild(el("p", { class: "result-error-hint muted" },
        "Start the MCP Search Engine (e.g. ",
        el("code", {}, "cd packages/mcp-search-engine && SEARCH_BACKEND=memory npm run dev"),
        ") and check that ",
        el("code", {}, "SEARCH_ENGINE_BASE_URL"),
        " in toolpanel's env points at it.",
      ));
    }
    container.appendChild(box);
  }

  function renderEmpty(container, q, filters) {
    if (!container) return;
    container.innerHTML = "";
    const box = el("div", { class: "result-empty" });
    box.appendChild(el("p", {}, `No matching MCP servers for `, el("code", {}, q || "your query"), "."));
    const active = [];
    if (filters.provider) active.push(`provider=${filters.provider}`);
    if (filters.tags && filters.tags.length) active.push(`tags=${filters.tags.join(",")}`);
    if (active.length) box.appendChild(el("p", { class: "muted" }, `Active filters: ${active.join(" · ")}. Try widening or clearing them.`));
    else box.appendChild(el("p", { class: "muted" }, "Try a broader query, or check the index at /panel/search/admin."));
    container.appendChild(box);
  }

  function renderFacets(f, container, currentBody) {
    if (!container) return;
    container.innerHTML = "";
    const groups = [
      { key: "tags", label: "tag", single: false, toValue: (k) => k },
      { key: "provider", label: "provider", single: true, toValue: (k) => k },
    ];
    let anyShown = false;
    for (const g of groups) {
      const data = f[g.key];
      if (!data || typeof data !== "object") continue;
      const entries = Object.entries(data).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 30);
      if (!entries.length) continue;
      anyShown = true;
      const groupEl = el("div", { class: "facet-group" }, el("span", { class: "facet-group-title" }, g.label));
      for (const [k, v] of entries) {
        const chip = el("button", {
          type: "button",
          class: "facet",
          onclick: () => applyFacet(g, k),
          title: `Filter by ${g.label}: ${k}`,
        }, k, " ", el("span", { class: "facet-count" }, String(v)));
        groupEl.appendChild(chip);
      }
      container.appendChild(groupEl);
    }
    if (!anyShown) {
      container.appendChild(el("p", { class: "muted", style: "font-size:0.82rem" }, "No facet data from the search engine."));
      return;
    }
    // "Clear filters" appears only when there's an active filter.
    const form = document.querySelector("[data-search-form]");
    const hasFilter = form && (String(form.elements["tags"]?.value || "").trim() || String(form.elements["provider"]?.value || "").trim());
    if (currentBody && hasFilter) {
      const clear = el("button", { type: "button", class: "facet facet-clear", title: "Clear all filters" },
        el("span", {}, "Clear filters"), el("span", { class: "facet-count" }, "×"));
      clear.addEventListener("click", () => {
        const f2 = document.querySelector("[data-search-form]");
        if (!f2) return;
        f2.elements["tags"].value = "";
        f2.elements["provider"].value = "";
        f2.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      container.appendChild(clear);
    }
  }

  function applyFacet(group, value) {
    const form = document.querySelector("[data-search-form]");
    if (!form) return;
    if (group.key === "provider") {
      form.elements["provider"].value = value;
    } else if (group.key === "tags") {
      const cur = String(form.elements["tags"].value || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!cur.includes(value)) cur.push(value);
      form.elements["tags"].value = cur.join(", ");
    }
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  function renderHits(hits, toolHits, container) {
    container.innerHTML = "";
    if (!hits.length) { container.appendChild(el("p", { class: "muted" }, "No matching servers.")); return; }
    const toolsByServer = {};
    for (const t of toolHits || []) (toolsByServer[t.server_mcp_name] ||= []).push(t);
    for (const h of hits) {
      const card = el("div", { class: "hit" },
        el("div", { class: "hit-head" },
          el("span", { class: "hit-name" }, h.display_name || h.mcp_name),
          el("span", { class: "hit-mcp" }, h.mcp_name),
        ),
        h.description ? el("p", { class: "hit-desc" }, h.description) : null,
        h.tags && h.tags.length ? el("div", { class: "hit-tags" }, ...h.tags.map((t) => el("span", { class: "badge" }, t))) : null,
      );
      const tools = toolsByServer[h.mcp_name] || [];
      if (tools.length) {
        const toolsEl = el("div", { class: "hit-tools" });
        for (const t of tools) toolsEl.appendChild(el("div", { class: "tool-hit" }, el("div", { class: "tool-hit-name" }, t.name), t.compactSchema ? el("div", { class: "tool-hit-schema" }, t.compactSchema) : null, t.description ? el("div", { class: "muted", style: "font-size:0.8rem;margin-top:2px" }, t.description) : null));
        card.appendChild(toolsEl);
      }
      container.appendChild(card);
    }
  }

  function renderPagination(container, page, currentOffset, hitsShown, runSearch) {
    if (!container) return;
    container.innerHTML = "";
    if (!page || typeof page.total !== "number" || typeof page.limit !== "number") { container.hidden = true; return; }
    const { total, limit } = page;
    if (total <= limit) { container.hidden = true; return; }
    container.hidden = false;
    const from = currentOffset + 1;
    const to = currentOffset + hitsShown;
    container.appendChild(el("div", { class: "pagination-bar" },
      el("span", { class: "pagination-info muted" }, `Showing ${from}–${to} of ${total}`),
      el("div", { class: "pagination-buttons" },
        el("button", {
          type: "button",
          class: "btn btn-ghost btn-sm",
          disabled: currentOffset <= 0,
          onclick: () => runSearch(Math.max(0, currentOffset - limit)),
        }, "Prev"),
        el("button", {
          type: "button",
          class: "btn btn-ghost btn-sm",
          disabled: currentOffset + limit >= total,
          onclick: () => runSearch(currentOffset + limit),
        }, "Next"),
      ),
    ));
  }
  initSearch();

  // ----- search admin ---------------------------------------------------------
  //
  // Loads via /api/search/admin (no server-side data-docs injection).
  // Uses the unified error envelope (envelopeToErrorState) on every action.
  // Supports the manual Refresh button and the filter input.

  function initSearchAdmin() {
    const rows = $("#admin-rows");
    const addBtn = $("[data-admin-add]");
    const reindexBtn = $("[data-admin-reindex]");
    const refreshBtn = $("[data-admin-refresh]");
    const filterInput = $("[data-admin-filter]");
    const m = $("[data-admin-msg]");
    const modal = $("[data-modal]");
    const modalForm = $("[data-admin-form]");
    const modalTitle = $("[data-modal-title]");
    const closeBtns = $$("[data-modal-close]");
    const countEl = $("[data-admin-count]");
    if (!rows || !modal) return;

    let docs = [];
    let filterQuery = "";
    // Sort state: { key, dir } — dir "asc" | "desc". Clicking the same header toggles.
    let sortState = { key: "mcp_name", dir: "asc" };

    function sortDocs(list) {
      const { key, dir } = sortState;
      const sign = dir === "asc" ? 1 : -1;
      const isDate = key === "updated_at";
      const val = (d) => {
        if (isDate) return d.updated_at ? new Date(d.updated_at).getTime() || 0 : 0;
        const v = d[key];
        return typeof v === "string" ? v.toLowerCase() : (v ?? "");
      };
      return [...list].sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va < vb) return -1 * sign;
        if (va > vb) return 1 * sign;
        // Tie-breaker keeps ordering stable & meaningful.
        return String(a.mcp_name || "").localeCompare(String(b.mcp_name || ""));
      });
    }

    function syncSortHeaders() {
      $$("th.sortable").forEach((th) => {
        const isActive = th.dataset.sort === sortState.key;
        th.setAttribute("aria-sort", isActive ? (sortState.dir === "asc" ? "ascending" : "descending") : "none");
        const arrow = th.querySelector(".sort-arrow");
        if (arrow) arrow.textContent = isActive ? (sortState.dir === "asc" ? "▲" : "▼") : "";
      });
    }

    function matchesFilter(d) {
      if (!filterQuery) return true;
      const q = filterQuery.toLowerCase();
      const hay = [
        d.mcp_name || "",
        d.display_name || "",
        d.provider || "",
        d.health_status || "",
        (d.tags || []).join(" "),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    }

    function rerender() {
      rows.innerHTML = "";
      const filtered = docs.filter(matchesFilter);
      if (countEl) {
        countEl.textContent = filterQuery
          ? `${filtered.length}/${docs.length}`
          : String(docs.length);
      }
      if (!docs.length) {
        rows.appendChild(el("tr", {}, el("td", { colspan: 8, class: "admin-empty" },
          el("div", { class: "admin-empty-inner" },
            el("p", { class: "muted" }, "No indexed MCP servers yet."),
            el("p", { class: "hint muted" }, "Click ", el("strong", {}, "+ Add server"), " to index one, or seed via the mcp-search-engine directly."),
          ),
        )));
        return;
      }
      if (!filtered.length) {
        rows.appendChild(el("tr", {}, el("td", { colspan: 7, class: "muted", style: "text-align:center;padding:14px" },
          `No servers match "${filterQuery}".`,
          el("button", { type: "button", class: "btn btn-ghost btn-sm", style: "margin-left:10px", onclick: () => { if (filterInput) { filterInput.value = ""; filterQuery = ""; rerender(); } } }, "Clear filter"),
        )));
        return;
      }
      for (const d of sortDocs(filtered)) {
        const tags = (d.tags || []).map((t) => el("span", { class: "badge" }, t));
        const tagCells = tags.length ? tags : [document.createTextNode("\u2014")];
        const tr = el("tr", {},
          el("td", {}, el("code", {}, d.mcp_name || "")),
          el("td", {}, d.display_name || ""),
          el("td", {}, ...tagCells),
          el("td", {}, d.provider || ""),
          el("td", {}, d.health_status || ""),
          el("td", {}, d.updated_at ? new Date(d.updated_at).toLocaleDateString() : ""),
          el("td", { class: "cell-actions" },
            el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => openEdit(d) }, "Edit"),
            el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => del(d.mcp_name) }, "Delete"),
          ),
        );
        rows.appendChild(tr);
      }
    }

    function setLoading() {
      rows.innerHTML = "";
      rows.appendChild(el("tr", {}, el("td", { colspan: 8, class: "admin-rows-loading" }, spinnerEl("Loading index…"))));
      if (countEl) countEl.textContent = "…";
    }

    function renderLoadError(e, isInitial) {
      rows.innerHTML = "";
      const td = el("td", { colspan: 8 });
      const box = el("div", { class: `result-error result-error--${e.kind}`, style: "margin: 0" });
      box.appendChild(el("div", { class: "result-error-head" },
        el("span", { class: "result-error-pill" }, e.kind === "unreachable" ? "UNREACHABLE"
          : e.kind === "upstream" ? `UPSTREAM HTTP ${e.upstreamStatus ?? e.status ?? "?"}`
          : e.kind === "input" ? "INVALID INPUT"
          : `HTTP ${e.status ?? "?"}`),
      ));
      box.appendChild(el("p", { class: "result-error-msg" }, e.message || `Could not ${isInitial ? "load" : "reload"} the index.`));
      if (e.upstreamMessage) box.appendChild(el("p", { class: "result-error-upstream" }, `Upstream said: ${e.upstreamMessage}`));
      if (e.upstreamUrl) box.appendChild(el("p", { class: "result-error-url muted" }, `Upstream: ${e.upstreamUrl}`));
      box.appendChild(el("p", { class: "result-error-hint muted" },
        "Start the MCP Search Engine (e.g. ",
        el("code", {}, "cd packages/mcp-search-engine && SEARCH_BACKEND=memory npm run dev"),
        ") and check ",
        el("code", {}, "SEARCH_ENGINE_BASE_URL"),
        " in toolpanel's env.",
      ));
      td.appendChild(box);
      rows.appendChild(el("tr", {}, td));
      if (countEl) countEl.textContent = "!";
    }

    function open() { modal.showModal(); }
    function close() { modal.close(); resetForm(); }
    function resetForm() {
      modalForm.reset();
      modalForm.elements["__mode"].value = "add";
      modalForm.elements["__original_name"].value = "";
      modalForm.elements["mcp_name"].disabled = false;
      modalForm.querySelectorAll("[data-field-error]").forEach((n) => n.remove());
      modalForm.querySelectorAll(".is-invalid").forEach((n) => n.classList.remove("is-invalid"));
      modalTitle.textContent = "Add MCP server";
    }
    function showFieldError(name, message) {
      const input = modalForm.elements[name];
      if (!input) return;
      input.classList.add("is-invalid");
      const label = input.closest("label.field");
      if (!label) return;
      let err = label.querySelector("[data-field-error]");
      if (!err) {
        err = el("span", { class: "field-error", "data-field-error": "" });
        label.appendChild(err);
      }
      err.textContent = message;
    }
    function openEdit(d) {
      resetForm();
      modalTitle.textContent = "Edit MCP server";
      modalForm.elements["__mode"].value = "edit";
      modalForm.elements["__original_name"].value = d.mcp_name;
      modalForm.elements["mcp_name"].value = d.mcp_name;
      modalForm.elements["mcp_name"].disabled = true;
      modalForm.elements["display_name"].value = d.display_name || "";
      modalForm.elements["tags"].value = (d.tags || []).join(", ");
      modalForm.elements["provider"].value = d.provider || "";
      modalForm.elements["description"].value = d.description || "";
      modalForm.elements["docs_url"].value = d.docs_url || "";
      modalForm.elements["homepage_url"].value = d.homepage_url || "";
      modalForm.elements["base_url"].value = d.base_url || "";
      modalForm.elements["protocol_version"].value = d.protocol_version || "";
      modalForm.elements["capabilities"].value = d.capabilities ? JSON.stringify(d.capabilities, null, 2) : "";
      modalForm.elements["health_status"].value = d.health_status || "";
      modalForm.elements["updated_at"].value = d.updated_at || "";
      open();
    }
    async function del(name) {
      if (!name || !confirm(`Delete ${name} from the search index?`)) return;
      msg(m, `Deleting ${name}…`);
      const { status, data } = await jdel(`/api/search/admin?name=${encodeURIComponent(name)}`);
      if (status === 200) {
        msg(m, `Deleted ${name}.`, "ok");
        await reload();
      } else {
        const e = envelopeToErrorState(status, data);
        msg(m, `Delete failed: ${e.message}${e.upstreamMessage ? ` (${e.upstreamMessage})` : ""}`, "err");
      }
    }
    async function reload(isInitial = false) {
      if (isInitial) setLoading(); else msg(m, "Reloading index…");
      const { status, data } = await jget("/api/search/admin");
      if (status === 200 && data) {
        docs = Array.isArray(data) ? data : (data?.documents || data?.items || []);
        if (!isInitial) msg(m, `Loaded ${docs.length} server(s).`, "ok");
        rerender();
      } else {
        const e = envelopeToErrorState(status, data);
        renderLoadError(e, isInitial);
        if (!isInitial) msg(m, `Reload failed: ${e.message}`, "err");
      }
    }
    async function doReindex() {
      if (!docs.length) {
        msg(m, "Nothing to reindex — the local list is empty.", "err");
        return;
      }
      if (!confirm(`Reindex all ${docs.length} server(s)? This replaces the entire upstream search index with the current list.`)) return;
      msg(m, `Reindexing ${docs.length} server(s)…`);
      const { status, data } = await jpost("/api/search/admin/reindex", { documents: docs });
      if (status === 200) msg(m, "Reindexed.", "ok");
      else {
        const e = envelopeToErrorState(status, data);
        msg(m, `Reindex failed: ${e.message}${e.upstreamMessage ? ` (${e.upstreamMessage})` : ""}`, "err");
      }
    }

    modalForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      modalForm.querySelectorAll("[data-field-error]").forEach((n) => n.remove());
      modalForm.querySelectorAll(".is-invalid").forEach((n) => n.classList.remove("is-invalid"));
      const fd = new FormData(modalForm);
      let capabilitiesValue;
      const capabilitiesRaw = fd.get("capabilities");
      if (capabilitiesRaw) {
        try {
          capabilitiesValue = JSON.parse(capabilitiesRaw);
        } catch {
          showFieldError("capabilities", "Invalid JSON — fix the syntax, or clear the field.");
          return;
        }
      }
      const doc = {
        mcp_name: fd.get("mcp_name"),
        display_name: fd.get("display_name"),
        tags: String(fd.get("tags") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20),
        provider: fd.get("provider") || undefined,
        description: fd.get("description") || undefined,
        docs_url: fd.get("docs_url") || undefined,
        homepage_url: fd.get("homepage_url") || undefined,
        base_url: fd.get("base_url") || undefined,
        protocol_version: fd.get("protocol_version") || undefined,
        capabilities: capabilitiesValue,
        health_status: fd.get("health_status") || undefined,
        updated_at: fd.get("updated_at") || new Date().toISOString(),
      };
      msg(m, "Saving…");
      const { status, data } = await jpost("/api/search/admin", { documents: [doc] });
      if (status === 200) {
        msg(m, `Saved ${doc.mcp_name}.`, "ok");
        close();
        await reload();
      } else {
        const e = envelopeToErrorState(status, data);
        if (e.kind === "input" || (e.upstreamStatus && e.upstreamStatus >= 400 && e.upstreamStatus < 500)) {
          // Likely a validation error — show message in-msg and try to surface upstreamMessage on field.
          msg(m, `Save failed: ${e.message}${e.upstreamMessage ? ` — ${e.upstreamMessage}` : ""}`, "err");
        } else {
          msg(m, `Save failed: ${e.message}${e.upstreamMessage ? ` (${e.upstreamMessage})` : ""}`, "err");
        }
      }
    });

    addBtn?.addEventListener("click", () => { resetForm(); open(); });
    reindexBtn?.addEventListener("click", doReindex);
    refreshBtn?.addEventListener("click", () => reload(false));
    if (filterInput) {
      filterInput.addEventListener("input", () => {
        filterQuery = filterInput.value.trim();
        rerender();
      });
    }
    closeBtns.forEach((b) => b.addEventListener("click", close));
    $$("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sortState.key === key) {
          sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        } else {
          sortState.key = key;
          sortState.dir = "asc";
        }
        syncSortHeaders();
        rerender();
      });
    });
    syncSortHeaders();
    reload(true);
  }
  initSearchAdmin();
})();
