/* BME Equipment App — core logic
   Talks to a Google Apps Script Web App backing a Google Sheet.
   Works offline: last-synced data is cached in localStorage, and writes
   made while offline are queued and sent once the connection returns. */

const CACHE_KEY = "bme_cache_v1";
const QUEUE_KEY = "bme_queue_v1";

const state = {
  equipment: [],
  issues: [],
  amc: [],
  dashboard: null,
  departments: [],
  currentDetailId: null,
  logCalMode: null, // 'calibration' | 'pm'
};

// ---------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------
function configured() {
  return API_URL && !API_URL.startsWith("PASTE_");
}

async function apiGet(action, params) {
  if (!configured()) throw new Error("not_configured");
  return apiGetJsonp(action, params);
}

// JSONP: load the response as a <script> tag instead of fetch(). Script-tag
// loads are never subject to CORS — this is the standard, reliable way to
// read from an Apps Script Web App cross-origin, since a plain fetch() GET
// can be blocked from reading the response even when the request itself
// succeeds (this is what was happening: the endpoint worked, the browser
// just wasn't allowed to hand the JSON back to our JavaScript).
let jsonpSeq = 0;
function apiGetJsonp(action, params) {
  return new Promise((resolve, reject) => {
    const callbackName = "bmeCb" + (jsonpSeq++) + "_" + Date.now();
    const script = document.createElement("script");

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, 15000);

    function cleanup() {
      clearTimeout(timeoutId);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = (data) => {
      cleanup();
      if (data && data.error) reject(new Error(data.error));
      else resolve(data);
    };

    const url = new URL(API_URL);
    url.searchParams.set("action", action);
    url.searchParams.set("callback", callbackName);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    script.src = url.toString();
    script.onerror = () => { cleanup(); reject(new Error("script_load_error")); };
    document.body.appendChild(script);
  });
}

// Writes still use fetch(), but in no-cors mode: the request is genuinely
// sent and Apps Script really does execute it and update the Sheet — we
// simply can't read the response back (same underlying CORS limitation as
// above, and JSONP can't do POST). So we treat "sent without a network
// error" as success, and rely on refreshing data afterward (via the JSONP
// reads above, which aren't affected) to reflect what actually happened.
async function apiPost(action, body) {
  if (!configured()) throw new Error("not_configured");
  await fetch(API_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...body }),
  });
  return { success: true };
}

// ---------------------------------------------------------------------
// Cache + offline queue
// ---------------------------------------------------------------------
function saveCache() {
  const payload = {
    equipment: state.equipment,
    issues: state.issues,
    amc: state.amc,
    dashboard: state.dashboard,
    syncedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch (e) { /* storage full — ignore */ }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; }
}
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function queueAction(action, body) {
  const q = getQueue();
  q.push({ action, body, queuedAt: new Date().toISOString() });
  setQueue(q);
}

async function flushQueue() {
  if (!navigator.onLine || !configured()) return;
  const q = getQueue();
  if (!q.length) return;
  const remaining = [];
  for (const item of q) {
    try {
      await apiPost(item.action, item.body);
    } catch (e) {
      remaining.push(item); // keep for next attempt
    }
  }
  setQueue(remaining);
  if (remaining.length < q.length) {
    showToast(`Synced ${q.length - remaining.length} pending change(s)`);
    await loadAllFromServer(true);
  }
}

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------
function departmentsFromEquipment() {
  const set = new Set();
  state.equipment.forEach((e) => e.department && set.add(e.department));
  return Array.from(set).sort();
}

function applyData(data) {
  state.equipment = data.equipment || [];
  state.issues = data.issues || [];
  state.amc = data.amc || [];
  state.departments = departmentsFromEquipment();
  populateDeptFilter();
  populateAssetIdOptions();
}

async function loadAllFromServer(silent) {
  if (!configured()) {
    if (!silent) showNotConfigured();
    return;
  }
  try {
    const [all, dash] = await Promise.all([apiGet("all"), apiGet("dashboard")]);
    applyData(all);
    state.dashboard = dash;
    saveCache();
    setOffline(false);
    renderCurrentScreen();
    updateLastSync(new Date());
  } catch (e) {
    if (!navigator.onLine) {
      setOffline(true);
    } else if (!silent) {
      showToast("Couldn't reach the server — showing last synced data.");
    }
  }
}

function bootFromCache() {
  const cached = loadCache();
  if (cached) {
    applyData(cached);
    state.dashboard = cached.dashboard;
    updateLastSync(cached.syncedAt ? new Date(cached.syncedAt) : null);
  }
}

function updateLastSync(date) {
  const el = document.getElementById("last-sync");
  if (!date) { el.textContent = configured() ? "Not synced yet" : "Not connected to a data source yet"; return; }
  el.textContent = "Last synced " + date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function showNotConfigured() {
  document.getElementById("last-sync").textContent =
    "Not connected yet — add your Apps Script URL to config.js";
}

// ---------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------
function statusClass(status) {
  if (status === "Overdue") return "overdue";
  if (status === "Due Soon") return "due-soon";
  if (status === "OK") return "ok";
  return "";
}

function worstStatus(eq) {
  const calStatus = eq.calibration && eq.calibration.status;
  const pmStatus = eq.pm && eq.pm.status;
  if (calStatus === "Overdue" || pmStatus === "Overdue") return "Overdue";
  if (calStatus === "Due Soon" || pmStatus === "Due Soon") return "Due Soon";
  if (calStatus === "OK" || pmStatus === "OK") return "OK";
  return "";
}

// ---------------------------------------------------------------------
// Rendering — Dashboard
// ---------------------------------------------------------------------
function renderDashboard() {
  const d = state.dashboard || {};
  setText("stat-total", d.equipmentTotal ?? state.equipment.length ?? "–");
  setText("cal-overdue", d.calibrationOverdue ?? 0);
  setText("cal-due-soon", d.calibrationDueSoon ?? 0);
  setText("pm-overdue", d.pmOverdue ?? 0);
  setText("pm-due-soon", d.pmDueSoon ?? 0);
  setText("issues-open", d.issuesOpen ?? 0);
}
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

// ---------------------------------------------------------------------
// Rendering — Equipment list
// ---------------------------------------------------------------------
function currentSearchTerm() { return (document.getElementById("search-input").value || "").trim().toLowerCase(); }
function currentDeptFilter() { return document.getElementById("dept-filter").value; }

function filteredEquipment(overrideStatusFilter) {
  const term = currentSearchTerm();
  const dept = currentDeptFilter();
  return state.equipment.filter((eq) => {
    if (dept && eq.department !== dept) return false;
    if (overrideStatusFilter) {
      const { type, status } = overrideStatusFilter;
      const s = type === "pm" ? eq.pm && eq.pm.status : eq.calibration && eq.calibration.status;
      if (s !== status) return false;
    }
    if (!term) return true;
    const hay = [eq.asset_id, eq.asset_name, eq.model, eq.department, eq.location, eq.make]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(term);
  });
}

let activeListFilter = null; // set when arriving from a dashboard drill-down

function renderEquipmentList() {
  const list = filteredEquipment(activeListFilter);
  const container = document.getElementById("equipment-list");
  const empty = document.getElementById("equipment-empty");
  const countEl = document.getElementById("equipment-count");
  countEl.textContent = activeListFilter
    ? `${list.length} ${activeListFilter.status.toLowerCase()} — ${activeListFilter.type === "pm" ? "PM" : "calibration"}`
    : `${list.length} of ${state.equipment.length} assets`;

  container.innerHTML = "";
  empty.classList.toggle("hidden", list.length > 0);

  list.forEach((eq) => {
    const status = activeListFilter
      ? (activeListFilter.type === "pm" ? eq.pm && eq.pm.status : eq.calibration && eq.calibration.status)
      : worstStatus(eq);
    const card = document.createElement("div");
    card.className = `eq-card status-${statusClass(status)}`;
    card.innerHTML = `
      <div class="eq-card-main">
        <span class="asset-tag">${escapeHtml(eq.asset_id || "")}</span>
        <div class="eq-name">${escapeHtml(eq.asset_name || "")}</div>
        <div class="eq-sub">${escapeHtml(eq.department || "")} · ${escapeHtml(eq.model || "")}</div>
      </div>
      ${status ? `<span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>` : ""}
    `;
    card.addEventListener("click", () => openDetail(eq.asset_id));
    container.appendChild(card);
  });
}

function populateDeptFilter() {
  const sel = document.getElementById("dept-filter");
  const current = sel.value;
  sel.innerHTML = '<option value="">All departments</option>' +
    state.departments.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  sel.value = state.departments.includes(current) ? current : "";
}

function populateAssetIdOptions() {
  const dl = document.getElementById("asset-id-options");
  dl.innerHTML = state.equipment.map((e) => `<option value="${escapeHtml(e.asset_id)}">`).join("");
}

// ---------------------------------------------------------------------
// Rendering — Equipment detail
// ---------------------------------------------------------------------
function openDetail(assetId) {
  state.currentDetailId = assetId;
  showScreen("detail");
}

function renderDetail() {
  const eq = state.equipment.find((e) => e.asset_id === state.currentDetailId);
  const el = document.getElementById("detail-content");
  if (!eq) { el.innerHTML = "<p>Asset not found.</p>"; return; }

  const cal = eq.calibration;
  const pm = eq.pm;

  el.innerHTML = `
    <div class="detail-header">
      <span class="asset-tag">${escapeHtml(eq.asset_id)}</span>
      <div class="detail-name">${escapeHtml(eq.asset_name || "")}</div>
      <div class="detail-desc">${escapeHtml(eq.asset_description || "")}</div>
    </div>

    <div class="spec-block">
      <h3>Location</h3>
      <div class="spec-row"><span class="spec-k">Department</span><span class="spec-v">${escapeHtml(eq.department || "—")}</span></div>
      <div class="spec-row"><span class="spec-k">Location</span><span class="spec-v">${escapeHtml(eq.location || "—")}</span></div>
      <h3>Identification</h3>
      <div class="spec-row"><span class="spec-k">Model</span><span class="spec-v">${escapeHtml(eq.model || "—")}</span></div>
      <div class="spec-row"><span class="spec-k">Serial No</span><span class="spec-v">${escapeHtml(String(eq.serial_no ?? "—"))}</span></div>
      <div class="spec-row"><span class="spec-k">Make</span><span class="spec-v">${escapeHtml(eq.make || "—")}</span></div>
      <div class="spec-row"><span class="spec-k">Risk category</span><span class="spec-v">${escapeHtml(eq.risk_category || "—")}</span></div>
      <h3>Vendor &amp; warranty</h3>
      <div class="spec-row"><span class="spec-k">Vendor</span><span class="spec-v">${escapeHtml(eq.vendor_details || "—")}</span></div>
      <div class="spec-row"><span class="spec-k">Warranty end</span><span class="spec-v">${escapeHtml(eq.warranty_end || "—")}</span></div>
    </div>

    <div class="spec-block">
      <h3>Calibration</h3>
      ${cal ? `
        <div class="spec-row"><span class="spec-k">Last done</span><span class="spec-v">${escapeHtml(cal.calibration_done_date || "—")}</span></div>
        <div class="spec-row"><span class="spec-k">Next due</span><span class="spec-v">${escapeHtml(cal.calibration_due_date || "—")}</span></div>
        <div class="spec-row"><span class="spec-k">Status</span><span class="spec-v">${cal.status ? `<span class="status-pill ${statusClass(cal.status)}">${escapeHtml(cal.status)}</span>` : "—"}</span></div>
      ` : `<div class="spec-row"><span class="spec-k">No calibration record</span></div>`}
    </div>

    <div class="spec-block">
      <h3>Preventive maintenance</h3>
      ${pm ? `
        <div class="spec-row"><span class="spec-k">Last PM</span><span class="spec-v">${escapeHtml(pm.last_pm_date || "—")}</span></div>
        <div class="spec-row"><span class="spec-k">Next due</span><span class="spec-v">${escapeHtml(pm.next_pm_due || "—")}</span></div>
        <div class="spec-row"><span class="spec-k">Status</span><span class="spec-v">${pm.status ? `<span class="status-pill ${statusClass(pm.status)}">${escapeHtml(pm.status)}</span>` : "—"}</span></div>
      ` : `<div class="spec-row"><span class="spec-k">Not yet tracked</span></div>`}
    </div>

    <div class="action-row">
      <button class="action-btn" id="detail-log-cal">Log calibration</button>
      <button class="action-btn" id="detail-log-pm">Log PM</button>
    </div>
    <div class="action-row" style="margin-top:8px;">
      <button class="action-btn warn" id="detail-log-issue">Log an issue for this asset</button>
    </div>
  `;

  document.getElementById("detail-log-cal").addEventListener("click", () => openLogCal("calibration", eq));
  document.getElementById("detail-log-pm").addEventListener("click", () => openLogCal("pm", eq));
  document.getElementById("detail-log-issue").addEventListener("click", () => openLogIssue(eq));
}

// ---------------------------------------------------------------------
// Log calibration / PM form
// ---------------------------------------------------------------------
function openLogCal(mode, eq) {
  state.logCalMode = mode;
  state.currentDetailId = eq.asset_id;
  document.getElementById("log-cal-title").textContent =
    mode === "pm" ? "Log completed PM" : "Log completed calibration";
  document.getElementById("log-cal-asset-label").value = `${eq.asset_id} — ${eq.asset_name}`;
  document.getElementById("log-cal-date-label").firstChild.textContent =
    mode === "pm" ? "PM done date" : "Calibration done date";
  document.getElementById("log-cal-due-wrap").classList.toggle("hidden", mode === "pm");
  document.getElementById("log-cal-freq-wrap").classList.toggle("hidden", mode !== "pm");
  document.getElementById("log-cal-date").value = "";
  document.getElementById("log-cal-due").value = "";
  document.getElementById("log-cal-remarks").value = "";
  showScreen("log-cal");
}

async function submitLogCal(evt) {
  evt.preventDefault();
  const mode = state.logCalMode;
  const assetId = state.currentDetailId;
  const doneDate = document.getElementById("log-cal-date").value;
  const remarks = document.getElementById("log-cal-remarks").value;

  const body = mode === "pm"
    ? { asset_id: assetId, last_pm_date: doneDate, frequency_months: Number(document.getElementById("log-cal-freq").value) || 6, remarks }
    : { asset_id: assetId, done_date: doneDate, due_date: document.getElementById("log-cal-due").value, remarks };

  const action = mode === "pm" ? "logPM" : "logCalibration";
  await sendOrQueue(action, body, "Saved. Will sync when online.");
  showScreen("detail");
}

// ---------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------
function renderIssuesList() {
  const activeSeg = document.querySelector("#issues-segmented .seg-btn.active");
  const filter = activeSeg ? activeSeg.dataset.filter : "Open";
  const list = state.issues
    .filter((i) => !filter || i.status === filter)
    .slice()
    .reverse();
  const container = document.getElementById("issues-list");
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = `<div class="empty-state">No ${filter ? filter.toLowerCase() + " " : ""}issues.</div>`;
    return;
  }
  list.forEach((issue) => {
    const priClass = (issue.priority || "").toLowerCase() === "critical" ? "priority-critical"
      : (issue.priority || "").toLowerCase() === "high" ? "priority-high" : "";
    const card = document.createElement("div");
    card.className = `issue-card ${priClass}`;
    card.innerHTML = `
      <div class="eq-card-main">
        <span class="asset-tag">${escapeHtml(issue.asset_id || "")}</span>
        <div class="eq-name">${escapeHtml(issue.asset_name || "")}</div>
        <div class="eq-sub">${escapeHtml(issue.description || "")}</div>
        <div class="eq-sub">${escapeHtml(issue.date_reported || "")} · ${escapeHtml(issue.reported_by || "")}</div>
      </div>
      <span class="status-pill ${(issue.status || "").toLowerCase()}">${escapeHtml(issue.status || "")}</span>
    `;
    card.addEventListener("click", () => toggleIssueStatus(issue));
    container.appendChild(card);
  });
}

async function toggleIssueStatus(issue) {
  if (issue.status !== "Open") return;
  if (!confirm(`Mark ${issue.issue_id} as resolved?`)) return;
  issue.status = "Resolved"; // optimistic
  renderIssuesList();
  await sendOrQueue("updateIssueStatus", { issue_id: issue.issue_id, status: "Resolved" }, "Marked resolved.");
}

function openLogIssue(eq) {
  document.getElementById("issue-form").reset();
  if (eq) {
    document.getElementById("issue-asset-id").value = eq.asset_id;
    document.getElementById("issue-asset-name").value = eq.asset_name;
    document.getElementById("issue-department").value = eq.department;
  }
  showScreen("log-issue");
}

function autofillIssueAsset() {
  const id = document.getElementById("issue-asset-id").value.trim();
  const eq = state.equipment.find((e) => e.asset_id === id);
  document.getElementById("issue-asset-name").value = eq ? eq.asset_name : "";
  document.getElementById("issue-department").value = eq ? eq.department : "";
}

async function submitIssue(evt) {
  evt.preventDefault();
  const body = {
    asset_id: document.getElementById("issue-asset-id").value.trim(),
    asset_name: document.getElementById("issue-asset-name").value,
    department: document.getElementById("issue-department").value,
    reported_by: document.getElementById("issue-reported-by").value.trim(),
    priority: document.getElementById("issue-priority").value,
    description: document.getElementById("issue-description").value.trim(),
    notes: document.getElementById("issue-notes").value.trim(),
  };
  await sendOrQueue("addIssue", body, "Issue logged.");
  showScreen("dashboard");
}

// ---------------------------------------------------------------------
// Send now, or queue for later if offline / unreachable
// ---------------------------------------------------------------------
async function sendOrQueue(action, body, successMessage) {
  if (!configured()) {
    showToast("Connect the app to your Sheet first (see config.js).");
    return;
  }
  if (!navigator.onLine) {
    queueAction(action, body);
    showToast("Saved offline. Will sync when back online.");
    return;
  }
  try {
    await apiPost(action, body);
    showToast(successMessage);
    await loadAllFromServer(true);
  } catch (e) {
    queueAction(action, body);
    showToast("Couldn't reach the server — saved offline instead.");
  }
}

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------
const NAV_SCREENS = ["dashboard", "equipment", "issues"];

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  document.getElementById(`screen-${name}`).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.screen === name));
  document.getElementById("topbar-title").textContent = {
    dashboard: "BME Equipment", equipment: "Equipment", issues: "Issues",
    detail: "Asset detail", "log-issue": "Log issue", "log-cal": "Log entry",
  }[name] || "BME Equipment";
  document.getElementById("search-row").classList.toggle("hidden", name !== "equipment");
  renderCurrentScreenFor(name);
  window.scrollTo(0, 0);
}

function renderCurrentScreenFor(name) {
  if (name === "dashboard") renderDashboard();
  if (name === "equipment") renderEquipmentList();
  if (name === "detail") renderDetail();
  if (name === "issues") renderIssuesList();
}
function renderCurrentScreen() {
  const visible = document.querySelector(".screen:not(.hidden)");
  if (visible) renderCurrentScreenFor(visible.id.replace("screen-", ""));
}

function setOffline(isOffline) {
  document.getElementById("offline-banner").classList.toggle("hidden", !isOffline);
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), 3200);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => { activeListFilter = null; showScreen(btn.dataset.screen); });
});

document.getElementById("search-btn").addEventListener("click", () => {
  const row = document.getElementById("search-row");
  if (document.getElementById("screen-equipment").classList.contains("hidden")) {
    activeListFilter = null;
    showScreen("equipment");
  } else {
    row.classList.toggle("hidden");
  }
});

document.getElementById("search-input").addEventListener("input", renderEquipmentList);
document.getElementById("dept-filter").addEventListener("change", renderEquipmentList);

document.querySelectorAll(".status-row[data-filter-type]").forEach((row) => {
  row.addEventListener("click", () => {
    activeListFilter = { type: row.dataset.filterType, status: row.dataset.filterStatus };
    showScreen("equipment");
  });
});
document.getElementById("row-open-issues").addEventListener("click", () => showScreen("issues"));
document.getElementById("log-issue-btn").addEventListener("click", () => openLogIssue(null));

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.back));
});
document.getElementById("log-cal-back").addEventListener("click", () => showScreen("detail"));

document.getElementById("issue-form").addEventListener("submit", submitIssue);
document.getElementById("issue-asset-id").addEventListener("change", autofillIssueAsset);
document.getElementById("log-cal-form").addEventListener("submit", submitLogCal);

document.querySelectorAll("#issues-segmented .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#issues-segmented .seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderIssuesList();
  });
});

window.addEventListener("online", () => { setOffline(false); flushQueue(); loadAllFromServer(true); });
window.addEventListener("offline", () => setOffline(true));

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
bootFromCache();
renderDashboard();
showScreen("dashboard");
if (!navigator.onLine) setOffline(true);
loadAllFromServer();
flushQueue();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
