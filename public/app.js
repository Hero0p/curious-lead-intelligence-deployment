/* =========================================================================
   Curious Media — Lead Intelligence (frontend)
   No build step: plain ES modules-free JS so `npm start` is the only command.
   ========================================================================= */

const SIGNAL_TYPES = [
  ["funding", "Funding"],
  ["launch", "Launch"],
  ["expansion", "Expansion"],
  ["leadership", "Leadership"],
  ["m_and_a", "M&A"],
  ["partnership", "Partnership"],
  ["financials", "Financials"],
  ["other", "Other"],
];

const STATUSES = [
  ["new", "New"],
  ["working", "Working"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["qualified", "Qualified"],
  ["won", "Won"],
  ["lost", "Lost"],
];

const KIND_ICON = {
  note: "✎", email: "✉", call: "☎", linkedin: "in",
  meeting: "◷", status: "→", claim: "★",
};

const state = {
  user: null,
  tab: "today",
  search: "",
  hygiene: new Set(),
  freshness: null,
  types: new Set(),
  statuses: new Set(),
  sort: "score",
  team: [],
  openLeadId: null,
  runPoll: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ── API ────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

// ── Formatting ─────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function timeAgo(iso) {
  if (!iso) return "—";
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(then)) return "—";
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function dateOnly(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

const typeLabel = (t) => (SIGNAL_TYPES.find((x) => x[0] === t) || [t, t])[1];
const statusLabel = (s) => (STATUSES.find((x) => x[0] === s) || [s, s])[1];

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function scoreClass(n) {
  if (n >= 80) return "hot";
  if (n >= 60) return "warm";
  if (n >= 40) return "cool";
  return "";
}

// ── Boot ───────────────────────────────────────────────────────────────────

(async function boot() {
  buildFilterChips();
  wireEvents();

  try {
    const { user } = await api("/api/auth/me");
    await enterApp(user);
  } catch {
    $("#login").hidden = false;
  }
})();

async function enterApp(user) {
  state.user = user;
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#me-name").textContent = user.name;
  $("#me-role").textContent = user.role === "admin" ? "Admin" : "Team";
  $("#tab-admin").hidden = user.role !== "admin";

  try {
    const { users } = await api("/api/admin/users");
    state.team = users.filter((u) => u.active);
  } catch { state.team = []; }

  await refresh();
}

function buildFilterChips() {
  $("#types").innerHTML = SIGNAL_TYPES.map(
    ([v, l]) => `<button class="chip" data-type="${v}">${l}</button>`
  ).join("");

  $("#statuses").innerHTML = STATUSES.map(
    ([v, l]) => `<button class="chip" data-status="${v}">${l}</button>`
  ).join("");
}

// ── Events ─────────────────────────────────────────────────────────────────

function wireEvents() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const errBox = $("#login-error");
    errBox.hidden = true;
    try {
      const { user } = await api("/api/auth/login", {
        method: "POST",
        body: { username: form.get("username"), password: form.get("password") },
      });
      await enterApp(user);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  $("#signout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.reload();
  });

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    state.tab = btn.dataset.tab;
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t === btn));
    $("#layout").classList.toggle("is-wide", state.tab === "admin");
    syncFilterVisibility();
    refresh();
  });

  let searchTimer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      renderContent();
    }, 260);
  });

  $("#filters").addEventListener("change", (e) => {
    const box = e.target.closest("[data-hygiene]");
    if (!box) return;
    box.checked ? state.hygiene.add(box.dataset.hygiene) : state.hygiene.delete(box.dataset.hygiene);
    renderContent();
  });

  $("#filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    if (chip.dataset.freshness) {
      const v = chip.dataset.freshness;
      state.freshness = state.freshness === v ? null : v;
      $$("#freshness .chip").forEach((c) =>
        c.classList.toggle("is-on", c.dataset.freshness === state.freshness)
      );
    } else if (chip.dataset.type) {
      toggleSet(state.types, chip.dataset.type, chip);
    } else if (chip.dataset.status) {
      toggleSet(state.statuses, chip.dataset.status, chip);
    } else return;

    renderContent();
  });

  $("#clear-filters").addEventListener("click", () => {
    state.search = "";
    state.hygiene.clear();
    state.freshness = null;
    state.types.clear();
    state.statuses.clear();
    $("#search").value = "";
    $$("#filters input[type=checkbox]").forEach((c) => (c.checked = false));
    $$("#filters .chip").forEach((c) => c.classList.remove("is-on"));
    renderContent();
  });

  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
  });
}

/** The signals feed has no outreach state, so those filters are hidden there. */
function syncFilterVisibility() {
  const outreachy = state.tab !== "signals";
  $$("#filters .filter-group")[0].hidden = !outreachy;   // outreach hygiene
  $$("#filters .filter-group")[3].hidden = !outreachy;   // status
  $("#search").placeholder = outreachy ? "Search company\u2026" : "Search company or headline\u2026";
}

function toggleSet(set, value, chip) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
  chip.classList.toggle("is-on", set.has(value));
}

// ── Refresh ────────────────────────────────────────────────────────────────

async function refresh() {
  await Promise.all([loadStats(), renderContent()]);
}

async function loadStats() {
  try {
    const data = await api("/api/stats");
    for (const [key, value] of Object.entries(data.stats)) {
      const el = $(`[data-stat="${key}"]`);
      if (el) el.textContent = value;
    }
    $('[data-count="today"]').textContent = data.stats.newIn24h;
    $('[data-count="all"]').textContent = data.totals.leads;
    $('[data-count="mine"]').textContent = data.totals.mine;
    state.schedule = data.schedule;
    state.run = data.run;
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

function currentQuery() {
  const p = new URLSearchParams();
  p.set("tab", state.tab === "signals" ? "all" : state.tab);
  if (state.search) p.set("q", state.search);
  if (state.freshness) p.set("freshness", state.freshness);
  if (state.types.size) p.set("types", [...state.types].join(","));
  if (state.statuses.size) p.set("status", [...state.statuses].join(","));
  if (state.hygiene.size) p.set("hygiene", [...state.hygiene].join(","));
  p.set("sort", state.sort);
  return p.toString();
}

async function renderContent() {
  const content = $("#content");
  if (state.tab === "admin") return renderAdmin();
  if (state.tab === "signals") return renderSignals();

  content.innerHTML = `<div class="empty"><p>Loading…</p></div>`;

  let leads;
  try {
    ({ leads } = await api(`/api/leads?${currentQuery()}`));
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Couldn't load leads</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  if (!leads.length) return content.replaceChildren(emptyState());

  content.innerHTML = `
    <div class="list-head">
      <p>${leads.length} lead${leads.length === 1 ? "" : "s"}${
        state.tab === "today" ? " with something new since yesterday" : ""
      }</p>
      <div class="list-head-actions">
        <select class="sort-select" id="sort">
          <option value="score">Sort: signal strength</option>
          <option value="recent">Sort: newest signal</option>
          <option value="followup">Sort: follow-up date</option>
          <option value="company">Sort: company A–Z</option>
        </select>
      </div>
    </div>
    <div class="cards">${leads.map(leadCard).join("")}</div>`;

  $("#sort").value = state.sort;
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderContent();
  });

  $(".cards").addEventListener("click", onCardClick);
}

function emptyState() {
  const div = document.createElement("div");
  div.className = "empty";

  const copy = {
    today: [
      "Nothing new since the last refresh",
      `The next cycle runs at 2am and 2pm. Check All Leads for what's still open.`,
    ],
    all: [
      "No leads match these filters",
      "Loosen the filters, or run a cycle from the Admin tab to pull fresh coverage.",
    ],
    mine: [
      "You haven't claimed anything yet",
      "Open All Leads and claim the ones you want to own. They'll collect here.",
    ],
  }[state.tab] || ["Nothing here yet", ""];

  div.innerHTML = `<h2>${esc(copy[0])}</h2><p>${esc(copy[1])}</p>`;

  if (state.tab !== "today") {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Clear filters";
    btn.addEventListener("click", () => $("#clear-filters").click());
    div.appendChild(btn);
  }
  return div;
}

// ── Lead card ──────────────────────────────────────────────────────────────

function leadCard(lead) {
  const owner = lead.owner_name
    ? `<span class="owner"><span class="avatar">${esc(initials(lead.owner_name))}</span>${esc(lead.owner_name)}</span>`
    : `<span class="owner"><span class="avatar unclaimed">?</span>Unclaimed</span>`;

  const followup = lead.next_followup_at
    ? `<span class="sep">·</span>Follow up ${esc(dateOnly(lead.next_followup_at))}`
    : "";

  const contact = lead.contact_name
    ? `<span class="sep">·</span>${esc(lead.contact_name)}${lead.contact_role ? ` (${esc(lead.contact_role)})` : ""}`
    : "";

  const signals = lead.signals
    .map(
      (s) => `
      <div class="sig-row">
        <span class="type-tag type-${esc(s.signal_type)}">${esc(typeLabel(s.signal_type))}</span>
        <div class="sig-body">
          <p class="sig-title">${esc(s.title || "Untitled article")}</p>
          <p class="sig-sub">${esc(s.summary || "")}</p>
          ${s.why_it_matters ? `<p class="sig-why">${esc(s.why_it_matters)}</p>` : ""}
        </div>
      </div>`
    )
    .join("");

  return `
    <article class="lead" data-id="${lead.id}">
      <div class="lead-top">
        <div>
          <h3 class="lead-name">
            ${esc(lead.company)}
            <span class="tag tag-${esc(lead.status)}">${esc(statusLabel(lead.status))}</span>
            ${lead.new_count > 0 ? `<span class="tag tag-fresh">${lead.new_count} new</span>` : ""}
          </h3>
          <p class="lead-meta">
            ${lead.signal_count} signal${lead.signal_count === 1 ? "" : "s"}
            <span class="sep">·</span>last ${esc(timeAgo(lead.last_signal_at))}
            ${contact}${followup}
          </p>
        </div>
        <span class="score ${scoreClass(lead.score)}">${lead.score}<small>score</small></span>
      </div>

      ${signals ? `<div class="lead-signals">${signals}</div>` : ""}

      <div class="lead-foot">
        ${owner}
        <div class="lead-actions">
          ${
            lead.owner_id === state.user.id
              ? `<button class="btn btn-sm" data-act="release" data-id="${lead.id}">Release</button>`
              : lead.owner_id
              ? ""
              : `<button class="btn btn-sm" data-act="claim" data-id="${lead.id}">Claim</button>`
          }
          <button class="btn btn-sm btn-primary" data-act="open" data-id="${lead.id}">Open</button>
        </div>
      </div>
    </article>`;
}

async function onCardClick(e) {
  const actionBtn = e.target.closest("[data-act]");
  if (actionBtn) {
    e.stopPropagation();
    const id = actionBtn.dataset.id;
    if (actionBtn.dataset.act === "open") return openDrawer(id);
    try {
      await api(`/api/leads/${id}/claim`, {
        method: "POST",
        body: { release: actionBtn.dataset.act === "release" },
      });
      toast(actionBtn.dataset.act === "release" ? "Released" : "Claimed");
      refresh();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const card = e.target.closest(".lead");
  if (card) openDrawer(card.dataset.id);
}

// ── Signals feed ───────────────────────────────────────────────────────────

async function renderSignals() {
  const content = $("#content");
  content.innerHTML = `<div class="empty"><p>Loading…</p></div>`;

  const p = new URLSearchParams();
  if (state.search) p.set("q", state.search);
  if (state.freshness) p.set("freshness", state.freshness);
  if (state.types.size) p.set("types", [...state.types].join(","));

  let signals, breakdown;
  try {
    [{ signals }, breakdown] = await Promise.all([
      api(`/api/signals?${p}`),
      api("/api/signals/breakdown"),
    ]);
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Couldn't load signals</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  if (!signals.length) {
    content.innerHTML = `<div class="empty">
      <h2>No signals stored yet</h2>
      <p>Run a cycle from the Admin tab to pull articles from your watchlist.</p>
    </div>`;
    return;
  }

  const spread = breakdown.byType
    .map((t) => `<span class="type-tag type-${esc(t.signal_type)}">${esc(typeLabel(t.signal_type))} ${t.n}</span>`)
    .join(" ");

  content.innerHTML = `
    <div class="list-head">
      <p>${signals.length} article${signals.length === 1 ? "" : "s"} · last 30 days: ${spread}</p>
    </div>
    <div class="feed">
      ${signals
        .map(
          (s) => `
        <article class="feed-item">
          <div class="feed-top">
            <div>
              <span class="feed-company">${esc(s.company)}</span>
              <h3 class="feed-title"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || "Untitled article")}</a></h3>
              ${s.summary ? `<p class="feed-sub">${esc(s.summary)}</p>` : ""}
              ${s.why_it_matters ? `<p class="sig-why">${esc(s.why_it_matters)}</p>` : ""}
              <p class="feed-meta">
                <span class="type-tag type-${esc(s.signal_type)}">${esc(typeLabel(s.signal_type))}</span>
                <span>${esc(s.site || "")}</span>
                ${s.author ? `<span>· ${esc(s.author)}</span>` : ""}
                <span>· ${esc(timeAgo(s.published || s.created_at))}</span>
              </p>
            </div>
            <span class="score ${scoreClass(s.score)}">${s.score}<small>score</small></span>
          </div>
        </article>`
        )
        .join("")}
    </div>`;
}

// ── Drawer ─────────────────────────────────────────────────────────────────

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  state.openLeadId = null;
}

async function openDrawer(id) {
  state.openLeadId = id;
  const drawer = $("#drawer");
  drawer.hidden = false;
  $("#drawer-backdrop").hidden = false;
  drawer.innerHTML = `<div class="drawer-body"><div class="empty"><p>Loading…</p></div></div>`;

  let lead;
  try {
    ({ lead } = await api(`/api/leads/${id}`));
  } catch (err) {
    drawer.innerHTML = `<div class="drawer-body"><div class="empty"><h2>Couldn't open this lead</h2><p>${esc(err.message)}</p></div></div>`;
    return;
  }

  drawer.innerHTML = drawerHtml(lead);
  wireDrawer(lead);
}

function drawerHtml(lead) {
  const teamOptions = [`<option value="">Unclaimed</option>`]
    .concat(
      state.team.map(
        (u) =>
          `<option value="${u.id}" ${u.id === lead.owner_id ? "selected" : ""}>${esc(u.display_name)}</option>`
      )
    )
    .join("");

  const statusOptions = STATUSES.map(
    ([v, l]) => `<option value="${v}" ${v === lead.status ? "selected" : ""}>${esc(l)}</option>`
  ).join("");

  return `
  <div class="drawer-head">
    <button class="drawer-close" id="drawer-x" aria-label="Close">×</button>
    <h2>${esc(lead.company)}</h2>
    <p class="lead-meta">
      <span class="tag tag-${esc(lead.status)}">${esc(statusLabel(lead.status))}</span>
      <span class="sep">·</span>${lead.signals.length} signal${lead.signals.length === 1 ? "" : "s"}
      <span class="sep">·</span>last ${esc(timeAgo(lead.last_signal_at))}
      <span class="sep">·</span>score ${lead.score}
    </p>
  </div>

  <div class="drawer-body">

    <section class="block">
      <h3>Ownership</h3>
      <div class="grid-2">
        <label class="field"><span>Status</span><select id="d-status">${statusOptions}</select></label>
        <label class="field"><span>Owner</span><select id="d-owner">${teamOptions}</select></label>
        <label class="field"><span>Next follow-up</span>
          <input type="date" id="d-followup" value="${esc(dateOnly(lead.next_followup_at))}" /></label>
        <label class="field"><span>Last contacted</span>
          <input value="${esc(lead.last_contacted_at ? timeAgo(lead.last_contacted_at) : "Never")}" disabled /></label>
      </div>
    </section>

    <section class="block">
      <h3>Contact on file</h3>
      <div class="grid-2">
        <label class="field"><span>Name</span><input id="d-cname" value="${esc(lead.contact_name || "")}" placeholder="Priya Sharma" /></label>
        <label class="field"><span>Role</span><input id="d-crole" value="${esc(lead.contact_role || "")}" placeholder="Head of Marketing" /></label>
        <label class="field"><span>Email</span><input id="d-cemail" type="email" value="${esc(lead.contact_email || "")}" placeholder="priya@company.com" /></label>
        <label class="field"><span>Phone</span><input id="d-cphone" value="${esc(lead.contact_phone || "")}" placeholder="+91…" /></label>
      </div>
      <button class="btn btn-primary" id="d-save">Save changes</button>
    </section>

    <section class="block">
      <h3>Log outreach</h3>
      <div class="log-tabs" id="d-kinds">
        <button class="chip is-on" data-kind="note">Note</button>
        <button class="chip" data-kind="email">Email</button>
        <button class="chip" data-kind="call">Call</button>
        <button class="chip" data-kind="linkedin">LinkedIn</button>
        <button class="chip" data-kind="meeting">Meeting</button>
      </div>
      <label class="field">
        <textarea id="d-note" placeholder="What did you send, and what came back?"></textarea>
      </label>
      <div class="grid-2">
        <label class="field"><span>Set next follow-up</span><input type="date" id="d-nextdate" /></label>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn-primary btn-block" id="d-log">Log it</button>
        </div>
      </div>
    </section>

    <section class="block">
      <h3>Activity</h3>
      <div class="timeline" id="d-timeline">${timelineHtml(lead.activity)}</div>
    </section>

    <section class="block">
      <h3>All signals</h3>
      <div class="sig-list">
        ${
          lead.signals.length
            ? lead.signals
                .map(
                  (s) => `
          <div class="sig-card">
            <span class="type-tag type-${esc(s.signal_type)}">${esc(typeLabel(s.signal_type))}</span>
            <span class="score ${scoreClass(s.score)}" style="float:right">${s.score}<small>score</small></span>
            <p class="sig-title" style="margin-top:8px">
              <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || "Untitled article")}</a>
            </p>
            ${s.summary ? `<p class="sig-sub">${esc(s.summary)}</p>` : ""}
            ${s.why_it_matters ? `<p class="sig-why">${esc(s.why_it_matters)}</p>` : ""}
            <p class="feed-meta">${esc(s.site || "")}${s.author ? ` · ${esc(s.author)}` : ""} · ${esc(timeAgo(s.published || s.created_at))}</p>
          </div>`
                )
                .join("")
            : `<p class="sig-sub">No articles stored for this company yet.</p>`
        }
      </div>
    </section>
  </div>`;
}

function timelineHtml(activity) {
  if (!activity || !activity.length)
    return `<p class="sig-sub">Nothing logged yet. The first note goes here.</p>`;

  return activity
    .map(
      (a) => `
    <div class="tl-item">
      <span class="tl-kind">${esc(KIND_ICON[a.kind] || "•")}</span>
      <div class="tl-body">
        <p>${esc(a.body)}</p>
        <p class="tl-meta">${esc(a.user_name || "Someone")} · ${esc(a.kind)} · ${esc(timeAgo(a.created_at))}</p>
      </div>
    </div>`
    )
    .join("");
}

function wireDrawer(lead) {
  $("#drawer-x").addEventListener("click", closeDrawer);

  let kind = "note";
  $("#d-kinds").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    kind = chip.dataset.kind;
    $$("#d-kinds .chip").forEach((c) => c.classList.toggle("is-on", c === chip));
  });

  $("#d-save").addEventListener("click", async () => {
    try {
      await api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        body: {
          status: $("#d-status").value,
          owner_id: $("#d-owner").value ? Number($("#d-owner").value) : null,
          next_followup_at: $("#d-followup").value || null,
          contact_name: $("#d-cname").value,
          contact_role: $("#d-crole").value,
          contact_email: $("#d-cemail").value,
          contact_phone: $("#d-cphone").value,
        },
      });
      toast("Saved");
      await openDrawer(lead.id);
      loadStats();
    } catch (err) { toast(err.message, true); }
  });

  $("#d-log").addEventListener("click", async () => {
    const body = $("#d-note").value.trim();
    if (!body) return toast("Write something before logging it.", true);
    try {
      await api(`/api/leads/${lead.id}/activity`, {
        method: "POST",
        body: { kind, body, next_followup_at: $("#d-nextdate").value || undefined },
      });
      toast("Logged");
      await openDrawer(lead.id);
      refresh();
    } catch (err) { toast(err.message, true); }
  });
}

// ── Admin ──────────────────────────────────────────────────────────────────

async function renderAdmin() {
  const content = $("#content");
  content.innerHTML = `<div class="empty"><p>Loading…</p></div>`;

  let companies, sites, users, runs, topics;
  try {
    [{ companies }, { sites }, { users }, runs, { topics }] = await Promise.all([
      api("/api/admin/companies"),
      api("/api/admin/sites"),
      api("/api/admin/users"),
      api("/api/admin/runs"),
      api("/api/admin/topics"),
    ]);
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Admin unavailable</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  const activeTopics = topics.filter((t) => t.active).length;

  content.innerHTML = `
    <div id="admin-root">
    <div class="admin-block" style="margin-bottom:16px">
      <div class="runbar">
        <div>
          <h3>Collection cycle</h3>
          <p class="hint" id="run-hint">
            ${runs.queryCount} queries per cycle (${companies.filter((c) => c.active).length} companies ×
            ${sites.filter((s) => s.active).length} sources).
            Scheduled ${esc(state.schedule ? state.schedule.cron : "0 2,14 * * *")} (${esc(state.schedule ? state.schedule.timezone : "")}).
            ${runs.hasNewsKey ? "" : "<strong>NEWSAPI_AI_KEY is missing from .env.</strong>"}
            ${runs.hasGeminiKey ? "" : "Gemini key not set — signals will be classified by keyword only."}
          </p>
        </div>
        <button class="btn btn-primary" id="run-now" ${runs.running ? "disabled" : ""}>
          ${runs.running ? "Running…" : "Run a cycle now"}
        </button>
      </div>
      <div id="run-progress"></div>
      <table class="mini" style="margin-top:14px">
        <thead><tr><th>Started</th><th>Trigger</th><th>Fetched</th><th>New</th><th>Errors</th><th>Status</th></tr></thead>
        <tbody>
          ${
            runs.runs.length
              ? runs.runs
                  .map(
                    (r) => `<tr>
                      <td>${esc(timeAgo(r.started_at))}</td>
                      <td>${esc(r.trigger)}</td>
                      <td>${r.fetched}</td>
                      <td>${r.new_signals}</td>
                      <td>${r.errors}</td>
                      <td>${esc(r.status)}${r.message ? ` — ${esc(r.message)}` : ""}</td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="6">No cycles have run yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>

    <div class="admin-grid">

      <section class="admin-block">
        <h3>Companies watched</h3>
        <p class="hint">Every company here becomes a lead. Add name variants so nothing is missed.</p>
        <div class="row-list">
          ${companies
            .map(
              (c) => `<div class="row ${c.active ? "" : "is-off"}">
                <div class="row-main">
                  <strong>${esc(c.name)}</strong>
                  <span>${esc(c.keywords.join(", "))} · ${c.signal_count || 0} signals</span>
                </div>
                <div class="row-actions">
                  <button class="btn btn-sm" data-co-toggle="${c.id}" data-active="${c.active ? 0 : 1}">${c.active ? "Pause" : "Resume"}</button>
                  <button class="btn btn-sm btn-danger" data-co-del="${c.id}" data-name="${esc(c.name)}">Remove</button>
                </div>
              </div>`
            )
            .join("")}
        </div>
        <div class="inline-form">
          <input id="co-name" placeholder="Company name" />
          <input id="co-keys" placeholder="Name variants, comma separated" />
          <button class="btn btn-primary" id="co-add">Add</button>
        </div>
      </section>

      <section class="admin-block">
        <h3>News sources</h3>
        <p class="hint">Domains queried for every company on the watchlist.</p>
        <div class="row-list">
          ${sites
            .map(
              (s) => `<div class="row ${s.active ? "" : "is-off"}">
                <div class="row-main"><strong>${esc(s.domain)}</strong><span>${esc(s.name)}</span></div>
                <div class="row-actions">
                  <button class="btn btn-sm" data-site-toggle="${s.id}" data-active="${s.active ? 0 : 1}">${s.active ? "Pause" : "Resume"}</button>
                  <button class="btn btn-sm btn-danger" data-site-del="${s.id}" data-name="${esc(s.domain)}">Remove</button>
                </div>
              </div>`
            )
            .join("")}
        </div>
        <div class="inline-form">
          <input id="site-domain" placeholder="livemint.com" />
          <button class="btn btn-primary" id="site-add">Add</button>
        </div>
      </section>

      <section class="admin-block">
        <h3>Topic narrowing</h3>
        <p class="hint">
          ${activeTopics ? `${activeTopics} of ${topics.length} keywords active — an article must also mention one of them.`
                         : `Off. Every article mentioning a company is kept. Turn on to keep only business events.`}
        </p>
        <div class="row-actions">
          <button class="btn" id="topics-on">Require topic keywords</button>
          <button class="btn" id="topics-off">Keep everything</button>
        </div>
      </section>

      <section class="admin-block">
        <h3>Team</h3>
        <p class="hint">Members can work leads. Admins can also change the watchlist.</p>
        <div class="row-list">
          ${users
            .map(
              (u) => `<div class="row ${u.active ? "" : "is-off"}">
                <div class="row-main"><strong>${esc(u.display_name)}</strong><span>@${esc(u.username)} · ${esc(u.role)}</span></div>
                <div class="row-actions">
                  ${
                    u.id === state.user.id
                      ? `<span class="sig-sub">you</span>`
                      : `<button class="btn btn-sm" data-user-toggle="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? "Deactivate" : "Reactivate"}</button>`
                  }
                </div>
              </div>`
            )
            .join("")}
        </div>
        <div class="inline-form">
          <input id="u-name" placeholder="Display name" />
          <input id="u-user" placeholder="username" />
          <input id="u-pass" type="password" placeholder="password" />
          <select id="u-role"><option value="member">Member</option><option value="admin">Admin</option></select>
          <button class="btn btn-primary" id="u-add">Add teammate</button>
        </div>
      </section>
    </div>
    </div>`;

  wireAdmin();
  if (runs.running) pollRun();
}

function wireAdmin() {
  const root = $("#admin-root");

  const reload = () => { renderAdmin(); loadStats(); };
  const guard = async (fn) => {
    try { await fn(); reload(); }
    catch (err) { toast(err.message, true); }
  };

  $("#run-now").addEventListener("click", async () => {
    try {
      await api("/api/admin/run", { method: "POST" });
      toast("Cycle started");
      $("#run-now").disabled = true;
      $("#run-now").textContent = "Running…";
      pollRun();
    } catch (err) { toast(err.message, true); }
  });

  $("#co-add").addEventListener("click", () =>
    guard(async () => {
      const name = $("#co-name").value.trim();
      if (!name) throw new Error("Give the company a name.");
      const keywords = $("#co-keys").value.trim();
      await api("/api/admin/companies", {
        method: "POST",
        body: { name, keywords: keywords || name },
      });
      toast(`${name} added to the watchlist`);
    })
  );

  $("#site-add").addEventListener("click", () =>
    guard(async () => {
      const domain = $("#site-domain").value.trim();
      if (!domain) throw new Error("Enter a domain, like livemint.com.");
      await api("/api/admin/sites", { method: "POST", body: { domain } });
      toast(`${domain} added`);
    })
  );

  $("#u-add").addEventListener("click", () =>
    guard(async () => {
      await api("/api/admin/users", {
        method: "POST",
        body: {
          display_name: $("#u-name").value.trim(),
          username: $("#u-user").value.trim(),
          password: $("#u-pass").value,
          role: $("#u-role").value,
        },
      });
      toast("Teammate added");
    })
  );

  $("#topics-on").addEventListener("click", () =>
    guard(() => api("/api/admin/topics/toggle-all", { method: "POST", body: { active: true } }))
  );
  $("#topics-off").addEventListener("click", () =>
    guard(() => api("/api/admin/topics/toggle-all", { method: "POST", body: { active: false } }))
  );

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    if (btn.dataset.coToggle)
      return guard(() =>
        api(`/api/admin/companies/${btn.dataset.coToggle}`, {
          method: "PATCH",
          body: { active: btn.dataset.active === "1" },
        })
      );

    if (btn.dataset.coDel) {
      if (!confirm(`Remove ${btn.dataset.name}? Its signals and outreach history go too.`)) return;
      return guard(() => api(`/api/admin/companies/${btn.dataset.coDel}`, { method: "DELETE" }));
    }

    if (btn.dataset.siteToggle)
      return guard(() =>
        api(`/api/admin/sites/${btn.dataset.siteToggle}`, {
          method: "PATCH",
          body: { active: btn.dataset.active === "1" },
        })
      );

    if (btn.dataset.siteDel) {
      if (!confirm(`Stop watching ${btn.dataset.name}?`)) return;
      return guard(() => api(`/api/admin/sites/${btn.dataset.siteDel}`, { method: "DELETE" }));
    }

    if (btn.dataset.userToggle)
      return guard(() =>
        api(`/api/admin/users/${btn.dataset.userToggle}`, {
          method: "PATCH",
          body: { active: btn.dataset.active === "1" },
        })
      );
  });
}

function pollRun() {
  clearInterval(state.runPoll);
  state.runPoll = setInterval(async () => {
    let data;
    try { data = await api("/api/admin/runs"); }
    catch { return clearInterval(state.runPoll); }

    const box = $("#run-progress");
    if (!box) return clearInterval(state.runPoll);

    if (data.running && data.current) {
      const c = data.current;
      const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      box.innerHTML = `
        <p class="hint" style="margin:12px 0 0">
          ${c.done} of ${c.total} queries · ${c.fetched} articles fetched · ${c.errors} errors
        </p>
        <div class="progress"><div style="width:${pct}%"></div></div>`;
    } else {
      clearInterval(state.runPoll);
      toast("Cycle finished");
      renderAdmin();
      loadStats();
    }
  }, 2000);
}
