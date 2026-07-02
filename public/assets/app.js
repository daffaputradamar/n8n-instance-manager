const el = (id) => document.getElementById(id);

let currentLogsCode = null;
let pollTimer = null;

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* logs endpoint returns text */ }
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

function showToast(message, isError = false) {
  const t = el("toast");
  t.textContent = message;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.className = "toast"; }, 3200);
}

function openModal(id) { el(id).classList.add("open"); }
function closeModal(id) { el(id).classList.remove("open"); }

// ---------- auth ----------
async function checkSession() {
  const { authed } = await api("/api/session");
  if (authed) showApp(); else showLogin();
}

function showLogin() {
  el("login-screen").style.display = "flex";
  el("app-screen").style.display = "none";
  clearInterval(pollTimer);
}

function showApp() {
  el("login-screen").style.display = "none";
  el("app-screen").style.display = "block";
  loadInstances();
  clearInterval(pollTimer);
  pollTimer = setInterval(loadInstances, 8000);
}

el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("login-error").textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: el("login-user").value,
        password: el("login-pass").value,
      }),
    });
    el("login-pass").value = "";
    showApp();
  } catch (err) {
    el("login-error").textContent = err.message;
  }
});

el("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

// ---------- instance list ----------
async function loadInstances() {
  try {
    const list = await api("/api/instances");
    renderInstances(list);
  } catch (err) {
    if (err.message.includes("signed in")) showLogin();
  }
}

function routeUrl(code) {
  return `${window.location.origin}/${code}/`;
}

function renderInstances(list) {
  el("instance-count").textContent = `Instances (${list.length})`;
  const wrap = el("instance-list");

  if (list.length === 0) {
    wrap.innerHTML = `
      <div class="empty-state">
        No instances yet. Each one is its own n8n container — separate credentials, separate workflows.
        <div><button class="btn" onclick="document.getElementById('new-instance-btn').click()">+ New instance</button></div>
      </div>`;
    return;
  }

  wrap.innerHTML = list
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((inst) => {
      const running = inst.status === "running";
      const url = routeUrl(inst.code);
      return `
      <div class="instance-card" data-code="${inst.code}">
        <div class="instance-main">
          <div class="instance-code-row">
            <span class="status-dot ${running ? "running" : ""}"></span>
            <span class="instance-code">${inst.code}</span>
            ${inst.ownerName ? `<span class="instance-owner">— ${escapeHtml(inst.ownerName)}</span>` : ""}
          </div>
          <div class="instance-route">
            <span class="prompt">$</span> curl <a href="${url}" target="_blank" rel="noopener">${url}</a>
            <span class="cursor"></span>
          </div>
        </div>
        <div class="instance-actions">
          ${running
            ? `<button class="btn btn-ghost btn-sm" data-action="stop">Stop</button>`
            : `<button class="btn btn-ghost btn-sm" data-action="start">Start</button>`}
          <button class="btn btn-ghost btn-sm" data-action="restart">Restart</button>
          <button class="btn btn-ghost btn-sm" data-action="logs">Logs</button>
          <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
        </div>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

el("instance-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const card = e.target.closest(".instance-card");
  const code = card.dataset.code;
  const action = btn.dataset.action;

  if (action === "logs") return openLogs(code);
  if (action === "delete") return openDeleteConfirm(code);

  btn.disabled = true;
  try {
    await api(`/api/instances/${code}/${action}`, { method: "POST" });
    showToast(`${code}: ${action} done`);
    loadInstances();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

el("refresh-btn").addEventListener("click", loadInstances);

// ---------- create modal ----------
el("new-instance-btn").addEventListener("click", () => {
  el("create-form").reset();
  el("create-error").textContent = "";
  openModal("create-modal");
});
el("create-cancel").addEventListener("click", () => closeModal("create-modal"));

el("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("create-error").textContent = "";
  const submitBtn = el("create-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating…";
  try {
    await api("/api/instances", {
      method: "POST",
      body: JSON.stringify({
        code: el("f-code").value.trim().toLowerCase(),
        ownerName: el("f-owner").value.trim(),
        basicAuthUser: el("f-user").value.trim(),
        basicAuthPassword: el("f-pass").value,
      }),
    });
    closeModal("create-modal");
    showToast("Instance created");
    loadInstances();
  } catch (err) {
    el("create-error").textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create instance";
  }
});

// ---------- logs modal ----------
async function openLogs(code) {
  currentLogsCode = code;
  el("logs-title").textContent = `Logs — ${code}`;
  el("logs-content").textContent = "Loading…";
  openModal("logs-modal");
  await refreshLogs();
}

async function refreshLogs() {
  if (!currentLogsCode) return;
  try {
    const res = await fetch(`/api/instances/${currentLogsCode}/logs?tail=200`);
    const text = await res.text();
    el("logs-content").textContent = text || "(no output yet)";
    const box = el("logs-content");
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    el("logs-content").textContent = "Failed to load logs: " + err.message;
  }
}

el("logs-refresh").addEventListener("click", refreshLogs);
el("logs-close").addEventListener("click", () => { closeModal("logs-modal"); currentLogsCode = null; });

// ---------- delete modal ----------
let pendingDeleteCode = null;

function openDeleteConfirm(code) {
  pendingDeleteCode = code;
  el("delete-sub").textContent = `This stops and removes the container for "${code}".`;
  el("delete-remove-data").checked = false;
  openModal("delete-modal");
}

el("delete-cancel").addEventListener("click", () => { closeModal("delete-modal"); pendingDeleteCode = null; });

el("delete-confirm").addEventListener("click", async () => {
  if (!pendingDeleteCode) return;
  const removeData = el("delete-remove-data").checked;
  try {
    await api(`/api/instances/${pendingDeleteCode}?removeData=${removeData}`, { method: "DELETE" });
    showToast(`${pendingDeleteCode} deleted`);
    closeModal("delete-modal");
    pendingDeleteCode = null;
    loadInstances();
  } catch (err) {
    showToast(err.message, true);
  }
});

// close modals on backdrop click
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.classList.remove("open");
  });
});

checkSession();
