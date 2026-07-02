const $ = (id) => document.getElementById(id);

let pollTimer = null;
let currentUser = null;
let currentLogsCode = null;
let currentPanel = "dashboard";

// ---------- helpers ----------
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

function showToast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " error" : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.className = "toast"; }, 3400);
}

function openModal(id) { $(id).classList.add("open"); }
function closeModal(id) { $(id).classList.remove("open"); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(d) {
  if (!d) return "";
  const t = new Date(d);
  return t.toLocaleDateString() + " " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------- auth ----------
async function checkSession() {
  try {
    const { authed, user } = await api("/api/session");
    if (authed) { currentUser = user; showApp(); } else { showLogin(); }
  } catch { showLogin(); }
}

function showLogin() {
  $("login-screen").style.display = "flex";
  $("app-screen").style.display = "none";
  clearInterval(pollTimer);
}

function showApp() {
  $("login-screen").style.display = "none";
  $("app-screen").style.display = "flex";
  $("sidebar-user").textContent = currentUser.username;
  if (currentUser.role !== "admin") {
    document.querySelectorAll(".admin-only").forEach((el) => el.style.display = "none");
  }
  switchPanel("dashboard");
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 10000);
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("login-user").value, password: $("login-pass").value }) });
    $("login-pass").value = "";
    await checkSession();
  } catch (err) { $("login-error").textContent = err.message; }
});

$("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  currentUser = null;
  showLogin();
});

// ---------- sidebar ----------
function switchPanel(name) {
  currentPanel = name;
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const panel = document.getElementById("panel-" + name);
  if (panel) panel.classList.add("active");
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.panel === name));
  refresh();
}

document.getElementById("sidebar-nav").addEventListener("click", (e) => {
  const item = e.target.closest("[data-panel]");
  if (item) switchPanel(item.dataset.panel);
});

// ---------- sidebar password change ----------
document.getElementById("sidebar-user").addEventListener("click", () => {
  $("password-form").reset();
  $("password-error").textContent = "";
  openModal("modal-password");
});

$("password-cancel").addEventListener("click", () => closeModal("modal-password"));

$("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("password-error").textContent = "";
  try {
    await api("/api/users/" + currentUser.username + "/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword: $("p-current").value, newPassword: $("p-new").value }),
    });
    closeModal("modal-password");
    showToast("Password changed");
  } catch (err) { $("password-error").textContent = err.message; }
});

// ---------- refresh ----------
function refresh() {
  switch (currentPanel) {
    case "dashboard": loadDashboard(); break;
    case "instances": loadInstances(); break;
    case "backups": loadBackups(); break;
    case "schedules": loadSchedules(); break;
    case "audit": loadAudit(); break;
    case "users": loadUsers(); break;
  }
}

// ========== PANEL: Dashboard ==========
async function loadDashboard() {
  try {
    const list = await api("/api/instances");
    const running = list.filter((i) => i.status === "running").length;
    const stopped = list.filter((i) => i.status === "stopped").length;
    let totalCpu = 0, totalMem = 0;
    list.forEach((i) => {
      if (i.stats) { totalCpu += i.stats.cpu; totalMem += i.stats.memory; }
    });
    $("dashboard-stats").innerHTML = `
      <div class="stat-card"><div class="stat-value">${list.length}</div><div class="stat-label">Total instances</div></div>
      <div class="stat-card running"><div class="stat-value">${running}</div><div class="stat-label">Running</div></div>
      <div class="stat-card"><div class="stat-value">${stopped}</div><div class="stat-label">Stopped</div></div>
      <div class="stat-card accent"><div class="stat-value">${totalCpu.toFixed(1)}</div><div class="stat-label">Total CPU %</div></div>
      <div class="stat-card accent"><div class="stat-value">${totalMem}</div><div class="stat-label">Total memory (MB)</div></div>`;

    $("dashboard-list").innerHTML = list.length === 0
      ? `<div class="empty-state">No instances yet. <a href="#" onclick="switchPanel('instances')">Create one</a></div>`
      : list.sort((a, b) => a.code.localeCompare(b.code)).map((i) => {
          const running = i.status === "running";
          const url = instanceUrl(i);
          return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);gap:16px">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              <span class="status-dot ${running ? "running" : ""}"></span>
              <span style="font-family:var(--mono);font-weight:600;font-size:14px">${esc(i.code)}</span>
              ${i.tags && i.tags.length ? i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("") : ""}
              ${i.stats ? `<span style="font-size:11px;color:var(--text-muted)">CPU ${i.stats.cpu.toFixed(1)}% | Mem ${i.stats.memory}MB</span>` : ""}
            </div>
            <a href="${url}" target="_blank" rel="noopener" style="font-size:13px;flex-shrink:0">Open &#8599;</a>
          </div>`;
        }).join("");
  } catch (err) { if (err.message.includes("signed in")) showLogin(); }
}

// ========== PANEL: Instances ==========
async function loadInstances() {
  try {
    const q = ($("inst-search").value || "").trim();
    const tag = ($("inst-tag-filter").value || "");
    let url = "/api/instances";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (tag) params.set("tag", tag);
    if ([...params].length) url += "?" + params.toString();

    const list = await api(url);
    renderInstances(list);
  } catch (err) { if (err.message.includes("signed in")) showLogin(); }
}

async function loadTags() {
  try {
    const tags = await api("/api/tags");
    const sel = $("inst-tag-filter");
    sel.innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  } catch {}
}

$("inst-search").addEventListener("input", loadInstances);
$("inst-tag-filter").addEventListener("change", loadInstances);

function instanceUrl(inst) {
  const origin = window.location.origin;
  const base = origin.replace(/:\d+$/, "");
  return base + ":" + inst.port + "/";
}

function renderInstances(list) {
  const wrap = $("instance-list");
  if (list.length === 0) {
    wrap.innerHTML = '<div class="empty-state">No instances found. <button class="btn" onclick="$(\'new-instance-btn\').click()">+ New instance</button></div>';
    return;
  }
  wrap.innerHTML = list.sort((a, b) => a.code.localeCompare(b.code)).map((i) => {
    const running = i.status === "running";
    const url = instanceUrl(i);
    return `
    <div class="instance-card" data-code="${esc(i.code)}">
      <div class="instance-check"><input type="checkbox" data-code="${esc(i.code)}" /></div>
      <div class="instance-main">
        <div class="instance-top">
          <span class="status-dot ${running ? "running" : ""}"></span>
          <span class="instance-code">${esc(i.code)}</span>
          ${i.ownerName ? `<span class="instance-owner">— ${esc(i.ownerName)}</span>` : ""}
          ${i.tags && i.tags.length ? i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("") : ""}
        </div>
        <div class="instance-url"><a href="${url}" target="_blank" rel="noopener">${url}</a></div>
        <div class="instance-meta">
          <span>Port ${i.port}</span>
          ${i.n8nVersion ? `<span>${esc(i.n8nVersion)}</span>` : ""}
          ${i.resourceLimits ? `<span>CPU ${i.resourceLimits.cpu || "-"} | Mem ${i.resourceLimits.memory || "-"}MB</span>` : ""}
          ${i.stats ? `<span>CPU ${i.stats.cpu.toFixed(1)}% | Mem ${i.stats.memory}MB/${i.stats.memoryLimit}MB</span>` : ""}
        </div>
      </div>
      <div class="instance-actions">
        ${running ? '<button class="btn btn-ghost btn-sm" data-a="stop">Stop</button>' : '<button class="btn btn-ghost btn-sm" data-a="start">Start</button>'}
        <button class="btn btn-ghost btn-sm" data-a="restart">Restart</button>
        <button class="btn btn-ghost btn-sm" data-a="backup">Backup</button>
        <button class="btn btn-ghost btn-sm" data-a="clone">Clone</button>
        <button class="btn btn-ghost btn-sm" data-a="version">Version</button>
        <button class="btn btn-ghost btn-sm" data-a="logs">Logs</button>
        <button class="btn btn-danger btn-sm" data-a="delete">Delete</button>
      </div>
    </div>`;
  }).join("");
  updateBulkBar();
}

function updateBulkBar() {
  const checked = document.querySelectorAll("#instance-list input[type=checkbox]:checked");
  const bar = $("bulk-bar");
  $("bulk-count").textContent = checked.length + " selected";
  bar.classList.toggle("show", checked.length > 0);
}

document.addEventListener("change", (e) => {
  if (e.target.matches("#instance-list input[type=checkbox]")) updateBulkBar();
});

// Bulk actions
document.getElementById("bulk-bar").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-bulk]");
  if (!btn) return;
  const action = btn.dataset.bulk;
  const checked = [...document.querySelectorAll("#instance-list input[type=checkbox]:checked")].map((c) => c.dataset.code);
  if (checked.length === 0) return;
  if (action === "delete" && !confirm(`Delete ${checked.length} instances?`)) return;
  try {
    const res = await api("/api/bulk", { method: "POST", body: JSON.stringify({ action, codes: checked }) });
    showToast(`${res.results.filter((r) => r.ok).length}/${checked.length} succeeded`);
    loadInstances();
  } catch (err) { showToast(err.message, true); }
});

// Instance actions
$("instance-list").addEventListener("click", async (e) => {
  if (e.target.matches("input[type=checkbox]")) return;
  const btn = e.target.closest("[data-a]");
  if (!btn) return;
  const card = e.target.closest(".instance-card");
  const code = card.dataset.code;
  const act = btn.dataset.a;

  if (act === "logs") return openLogs(code);
  if (act === "delete") return openDelete(code);
  if (act === "backup") return createBackup(code);
  if (act === "clone") return openClone(code);
  if (act === "version") return openVersion(code);

  btn.disabled = true;
  try {
    await api("/api/instances/" + code + "/" + act, { method: "POST" });
    showToast(code + ": " + act + " done");
    loadInstances();
  } catch (err) { showToast(err.message, true); }
  btn.disabled = false;
});

// Create instance
$("new-instance-btn").addEventListener("click", () => { $("create-form").reset(); $("create-error").textContent = ""; openModal("modal-create"); });
$("create-cancel").addEventListener("click", () => closeModal("modal-create"));

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("create-error").textContent = "";
  const btn = $("create-submit");
  btn.disabled = true;
  btn.textContent = "Creating...";
  try {
    const tags = ($("f-tags").value || "").split(",").map((t) => t.trim()).filter(Boolean);
    const cpu = $("f-cpu").value ? Number($("f-cpu").value) : null;
    const mem = $("f-mem").value ? Number($("f-mem").value) : null;
    await api("/api/instances", {
      method: "POST",
      body: JSON.stringify({
        code: $("f-code").value.trim().toLowerCase(),
        ownerName: $("f-owner").value.trim(),
        tags: tags.length ? tags : undefined,
        resourceLimits: (cpu || mem) ? { cpu: cpu || undefined, memory: mem || undefined } : undefined,
        n8nVersion: $("f-version").value.trim() || undefined,
        timezone: $("f-tz").value.trim() || undefined,
        basicAuthUser: $("f-user").value.trim() || undefined,
        basicAuthPassword: $("f-pass").value || undefined,
      }),
    });
    closeModal("modal-create");
    showToast("Instance created");
    loadInstances();
    loadTags();
  } catch (err) { $("create-error").textContent = err.message; }
  btn.disabled = false;
  btn.textContent = "Create instance";
});

// Delete
let pendingDelete = null;
function openDelete(code) { pendingDelete = code; $("delete-sub").textContent = 'Stop and remove container "' + code + '"'; $("delete-remove-data").checked = false; openModal("modal-delete"); }
$("delete-cancel").addEventListener("click", () => { closeModal("modal-delete"); pendingDelete = null; });
$("delete-confirm").addEventListener("click", async () => {
  if (!pendingDelete) return;
  const rm = $("delete-remove-data").checked;
  try {
    await api("/api/instances/" + pendingDelete + "?removeData=" + rm, { method: "DELETE" });
    showToast(pendingDelete + " deleted");
    closeModal("modal-delete");
    pendingDelete = null;
    loadInstances();
    loadTags();
  } catch (err) { showToast(err.message, true); }
});

// Backup
async function createBackup(code) {
  try {
    await api("/api/instances/" + code + "/backup", { method: "POST" });
    showToast("Backup created for " + code);
    loadBackups();
  } catch (err) { showToast(err.message, true); }
}

// Clone
function openClone(code) { $("clone-source").value = code; $("clone-code").value = ""; $("clone-error").textContent = ""; openModal("modal-clone"); }
$("clone-cancel").addEventListener("click", () => closeModal("modal-clone"));
$("clone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("clone-error").textContent = "";
  const source = $("clone-source").value;
  const target = $("clone-code").value.trim().toLowerCase();
  try {
    const res = await api("/api/instances/" + source + "/clone", { method: "POST", body: JSON.stringify({ targetCode: target }) });
    closeModal("modal-clone");
    showToast("Cloned to " + target + " (" + res.workflowsImported + " workflows)");
    loadInstances();
  } catch (err) { $("clone-error").textContent = err.message; }
});

// Version
function openVersion(code) { $("v-code").value = code; $("v-tag").value = "n8nio/n8n:latest"; $("version-error").textContent = ""; openModal("modal-version"); }
$("version-cancel").addEventListener("click", () => closeModal("modal-version"));
$("version-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("version-error").textContent = "";
  try {
    await api("/api/instances/" + $("v-code").value + "/version", { method: "PUT", body: JSON.stringify({ n8nVersion: $("v-tag").value.trim() }) });
    closeModal("modal-version");
    showToast("Version updated");
    loadInstances();
  } catch (err) { $("version-error").textContent = err.message; }
});

// Logs
async function openLogs(code) { currentLogsCode = code; $("logs-title").textContent = "Logs — " + code; $("logs-content").textContent = "Loading..."; openModal("modal-logs"); await refreshLogs(); }
async function refreshLogs() {
  if (!currentLogsCode) return;
  try {
    const res = await fetch("/api/instances/" + currentLogsCode + "/logs?tail=200");
    $("logs-content").textContent = await res.text() || "(no output)";
    $("logs-content").scrollTop = $("logs-content").scrollHeight;
  } catch (err) { $("logs-content").textContent = "Failed: " + err.message; }
}
$("logs-refresh").addEventListener("click", refreshLogs);
$("logs-close").addEventListener("click", () => { closeModal("modal-logs"); currentLogsCode = null; });

// ========== PANEL: Backups ==========
async function loadBackups() {
  try {
    const list = await api("/api/backups");
    const wrap = $("backup-list");
    if (list.length === 0) { wrap.innerHTML = '<div class="empty-state">No backups yet. Use the Backup button on an instance card.</div>'; return; }
    wrap.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Instance</th><th>Created</th><th>Size</th><th></th></tr></thead><tbody>' +
      list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).map((b) => `
        <tr>
          <td style="font-family:var(--mono);font-weight:600">${esc(b.code)}</td>
          <td>${fmtDate(b.timestamp)}</td>
          <td>${(b.size / 1024 / 1024).toFixed(2)} MB</td>
          <td style="text-align:right">
            <button class="btn btn-ghost btn-sm" data-restore="${esc(b.id)}">Restore</button>
            <button class="btn btn-danger btn-sm" data-delbackup="${esc(b.id)}">Delete</button>
          </td>
        </tr>`).join("") + '</tbody></table></div>';
  } catch {}
}
$("backup-list").addEventListener("click", async (e) => {
  const rb = e.target.closest("[data-restore]");
  if (rb) {
    if (!confirm("Restore this backup? This will overwrite instance data.")) return;
    try { await api("/api/backups/" + rb.dataset.restore + "/restore", { method: "POST" }); showToast("Backup restored"); loadInstances(); }
    catch (err) { showToast(err.message, true); }
  }
  const db = e.target.closest("[data-delbackup]");
  if (db) {
    try { await api("/api/backups/" + db.dataset.delbackup, { method: "DELETE" }); showToast("Backup deleted"); loadBackups(); }
    catch (err) { showToast(err.message, true); }
  }
});

// ========== PANEL: Schedules ==========
async function loadSchedules() {
  try {
    const list = await api("/api/schedules");
    const wrap = $("schedule-list");
    if (list.length === 0) { wrap.innerHTML = '<div class="empty-state">No schedules yet. <button class="btn" onclick="$(\'new-schedule-btn\').click()">+ New</button></div>'; return; }
    wrap.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Action</th><th>Instance</th><th>Every</th><th>Last Run</th><th></th></tr></thead><tbody>
      ${list.map((s) => `
        <tr>
          <td style="font-weight:600">${esc(s.name)}</td>
          <td><span class="tag">${s.type}</span></td>
          <td style="font-family:var(--mono)">${esc(s.instanceCode)}</td>
          <td>${s.interval} min</td>
          <td style="color:var(--text-muted);font-size:12px">${s.lastRun ? fmtDate(s.lastRun) : "Never"}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-sched-toggle="${esc(s.id)}">${s.enabled ? "Disable" : "Enable"}</button>
            <button class="btn btn-danger btn-sm" data-sched-del="${esc(s.id)}">Delete</button>
          </td>
        </tr>`).join("")}
      </tbody></table></div>`;
  } catch {}
}
$("new-schedule-btn").addEventListener("click", () => {
  $("schedule-form").reset(); $("schedule-error").textContent = ""; openModal("modal-schedule");
});
$("schedule-cancel").addEventListener("click", () => closeModal("modal-schedule"));
$("schedule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("schedule-error").textContent = "";
  try {
    await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        name: $("s-name").value.trim(),
        type: $("s-type").value,
        instanceCode: $("s-code").value.trim(),
        interval: Number($("s-interval").value),
      }),
    });
    closeModal("modal-schedule");
    showToast("Schedule created");
    loadSchedules();
  } catch (err) { $("schedule-error").textContent = err.message; }
});
$("schedule-list").addEventListener("click", async (e) => {
  const tb = e.target.closest("[data-sched-toggle]");
  if (tb) {
    try { await api("/api/schedules/" + tb.dataset.schedToggle + "/toggle", { method: "POST" }); loadSchedules(); }
    catch (err) { showToast(err.message, true); }
  }
  const db = e.target.closest("[data-sched-del]");
  if (db) {
    if (!confirm("Delete this schedule?")) return;
    try { await api("/api/schedules/" + db.dataset.schedDel, { method: "DELETE" }); showToast("Schedule deleted"); loadSchedules(); }
    catch (err) { showToast(err.message, true); }
  }
});

// ========== PANEL: Audit ==========
async function loadAudit() {
  try {
    const list = await api("/api/audit");
    $("audit-table").querySelector("tbody").innerHTML = list.map((e) => `
      <tr>
        <td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">${fmtDate(e.timestamp)}</td>
        <td>${esc(e.user)}</td>
        <td><span class="tag">${esc(e.action)}</span></td>
        <td style="font-family:var(--mono);font-size:12px">${esc(e.instance || "-")}</td>
        <td style="font-size:11px;color:var(--text-muted)">${esc(JSON.stringify(e.details || {}))}</td>
      </tr>`).join("");
  } catch {}
}

// ========== PANEL: Users ==========
async function loadUsers() {
  try {
    const list = await api("/api/users");
    const wrap = $("user-list");
    wrap.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>
      ${list.map((u) => `
        <tr>
          <td style="font-weight:600">${esc(u.username)}</td>
          <td><span class="tag">${esc(u.role)}</span></td>
          <td>${fmtDate(u.createdAt)}</td>
          <td style="text-align:right">
            ${u.username !== currentUser.username ? `<button class="btn btn-danger btn-sm" data-deluser="${esc(u.username)}">Delete</button>` : `<span style="color:var(--text-muted);font-size:11px">you</span>`}
          </td>
        </tr>`).join("")}
      </tbody></table></div>`;
  } catch (err) { if (err.message.includes("Admin")) showToast("Admin access required", true); }
}
$("new-user-btn").addEventListener("click", () => { $("user-form").reset(); $("user-error").textContent = ""; openModal("modal-user"); });
$("user-cancel").addEventListener("click", () => closeModal("modal-user"));
$("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("user-error").textContent = "";
  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        username: $("u-name").value.trim().toLowerCase(),
        password: $("u-pass").value,
        role: $("u-role").value,
      }),
    });
    closeModal("modal-user");
    showToast("User created");
    loadUsers();
  } catch (err) { $("user-error").textContent = err.message; }
});
$("user-list").addEventListener("click", async (e) => {
  const db = e.target.closest("[data-deluser]");
  if (db) {
    if (!confirm("Delete user " + db.dataset.deluser + "?")) return;
    try { await api("/api/users/" + db.dataset.deluser, { method: "DELETE" }); showToast("User deleted"); loadUsers(); }
    catch (err) { showToast(err.message, true); }
  }
});

// ========== Init ==========
document.querySelectorAll(".modal-backdrop").forEach((el) => {
  el.addEventListener("click", (e) => { if (e.target === el) el.classList.remove("open"); });
});
checkSession();
