require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const db = require("./src/db");
const dock = require("./src/docker");
const auth = require("./src/auth");
const { initScheduler } = require("./src/scheduler");

const PORT = process.env.MANAGER_PORT || 5600;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const CODE_RE = /^[a-z0-9][a-z0-9-]{2,19}$/;

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "please-change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 },
  })
);

function audit(action, req, instance, details = {}) {
  db.addAudit({
    action,
    user: (req.session && req.session.user && req.session.user.username) || "anonymous",
    instance: instance || "",
    timestamp: new Date().toISOString(),
    details,
  });
}

// ========== Auth ==========
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.getUser(username);
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  req.session.authed = true;
  req.session.user = { username: user.username, role: user.role };
  audit("login", req, null);
  return res.json({ ok: true, user: { username: user.username, role: user.role } });
});

app.post("/api/logout", (req, res) => {
  audit("logout", req, null);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  if (req.session && req.session.authed) {
    return res.json({ authed: true, user: req.session.user });
  }
  res.json({ authed: false });
});

app.put("/api/users/:username/password", auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword required" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  const user = db.getUser(req.params.username);
  if (!user || user.username !== (req.session.user && req.session.user.username)) {
    return res.status(403).json({ error: "Can only change your own password" });
  }
  if (!auth.verifyPassword(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  db.updateUserPassword(req.params.username, auth.hashPassword(newPassword));
  audit("change_password", req, null);
  res.json({ ok: true });
});

// ========== Users (admin only) ==========
app.get("/api/users", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(db.getUsers().map((u) => ({ username: u.username, role: u.role, createdAt: u.createdAt })));
});

app.post("/api/users", auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Username: 3-20 lowercase alphanumeric" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (db.getUser(username)) return res.status(409).json({ error: "Username already taken" });

  const user = db.createUser({
    username,
    passwordHash: auth.hashPassword(password),
    role: role === "admin" ? "admin" : "viewer",
    createdAt: new Date().toISOString(),
  });
  audit("create_user", req, null, { target: username });
  res.json({ username: user.username, role: user.role, createdAt: user.createdAt });
});

app.delete("/api/users/:username", auth.requireAuth, auth.requireAdmin, (req, res) => {
  if (req.params.username === (req.session.user && req.session.user.username)) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }
  const user = db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: "User not found" });
  db.deleteUser(req.params.username);
  audit("delete_user", req, null, { target: req.params.username });
  res.json({ ok: true });
});

// ========== Tags ==========
app.get("/api/tags", auth.requireAuth, (req, res) => {
  const tags = new Set();
  db.getInstances().forEach((i) => {
    if (i.tags) i.tags.forEach((t) => tags.add(t));
  });
  res.json([...tags].sort());
});

// ========== Instances ==========
app.get("/api/instances", auth.requireAuth, async (req, res) => {
  let list = db.getInstances();
  const q = (req.query.q || "").toLowerCase();
  const tag = req.query.tag || "";

  if (q) {
    list = list.filter(
      (i) => i.code.includes(q) || (i.ownerName || "").toLowerCase().includes(q)
    );
  }
  if (tag) {
    list = list.filter((i) => i.tags && i.tags.includes(tag));
  }

  const withStatus = await Promise.all(
    list.map(async (i) => {
      const stats = i.status === "running" ? await dock.getStats(i.code) : null;
      return { ...i, status: await dock.getStatus(i.code), stats };
    })
  );
  res.json(withStatus);
});

app.post("/api/instances", auth.requireAuth, async (req, res) => {
  const { code, ownerName, basicAuthUser, basicAuthPassword, timezone, tags, resourceLimits, n8nVersion } = req.body || {};

  if (!code || !CODE_RE.test(code)) {
    return res.status(400).json({ error: "Code must be 3-20 lowercase letters, numbers, or dashes." });
  }
  if (db.getByCode(code)) {
    return res.status(409).json({ error: "That code is already in use." });
  }
  if ((basicAuthUser && !basicAuthPassword) || (!basicAuthUser && basicAuthPassword)) {
    return res.status(400).json({ error: "Provide both a basic-auth username and password, or neither." });
  }
  if (resourceLimits) {
    if (resourceLimits.cpu && (resourceLimits.cpu < 0.1 || resourceLimits.cpu > 4)) {
      return res.status(400).json({ error: "CPU limit must be between 0.1 and 4 cores" });
    }
    if (resourceLimits.memory && (resourceLimits.memory < 128 || resourceLimits.memory > 8192)) {
      return res.status(400).json({ error: "Memory limit must be between 128 and 8192 MB" });
    }
  }

  try {
    const port = await dock.findAvailablePort(db.getAllPorts());
    await dock.createInstance({
      code, port, publicBaseUrl: PUBLIC_BASE_URL, basicAuthUser, basicAuthPassword,
      timezone, resourceLimits, n8nVersion,
    });
    const instance = db.createInstance({
      code, port,
      ownerName: ownerName || "",
      tags: tags || [],
      resourceLimits: resourceLimits || null,
      n8nVersion: n8nVersion || null,
      basicAuthUser: basicAuthUser || "",
      createdAt: new Date().toISOString(),
      status: "running",
    });
    audit("create_instance", req, code, { port, tags });
    res.json(instance);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create instance: " + err.message });
  }
});

app.put("/api/instances/:code/limits", auth.requireAuth, async (req, res) => {
  const { resourceLimits } = req.body || {};
  if (!resourceLimits) return res.status(400).json({ error: "resourceLimits required" });
  if (resourceLimits.cpu && (resourceLimits.cpu < 0.1 || resourceLimits.cpu > 4)) {
    return res.status(400).json({ error: "CPU limit must be between 0.1 and 4 cores" });
  }
  if (resourceLimits.memory && (resourceLimits.memory < 128 || resourceLimits.memory > 8192)) {
    return res.status(400).json({ error: "Memory limit must be between 128 and 8192 MB" });
  }
  const inst = db.getByCode(req.params.code);
  if (!inst) return res.status(404).json({ error: "Instance not found" });

  db.updateInstance(req.params.code, { resourceLimits });
  audit("update_limits", req, req.params.code, resourceLimits);
  res.json({ ok: true, resourceLimits });
});

app.post("/api/instances/:code/start", auth.requireAuth, async (req, res) => {
  try {
    await dock.startInstance(req.params.code);
    db.updateInstance(req.params.code, { status: "running" });
    audit("start_instance", req, req.params.code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/instances/:code/stop", auth.requireAuth, async (req, res) => {
  try {
    await dock.stopInstance(req.params.code);
    db.updateInstance(req.params.code, { status: "stopped" });
    audit("stop_instance", req, req.params.code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/instances/:code/restart", auth.requireAuth, async (req, res) => {
  try {
    await dock.restartInstance(req.params.code);
    db.updateInstance(req.params.code, { status: "running" });
    audit("restart_instance", req, req.params.code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/instances/:code", auth.requireAuth, async (req, res) => {
  const removeVolume = req.query.removeData === "true";
  try {
    await dock.removeInstance(req.params.code, { removeVolume });
    db.removeInstance(req.params.code);
    audit("delete_instance", req, req.params.code, { removeVolume });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/instances/:code/logs", auth.requireAuth, async (req, res) => {
  try {
    const tail = Number(req.query.tail) || 200;
    const logs = await dock.getLogs(req.params.code, tail);
    res.type("text/plain").send(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/instances/:code/stats", auth.requireAuth, async (req, res) => {
  try {
    const stats = await dock.getStats(req.params.code);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Version ----
app.put("/api/instances/:code/version", auth.requireAuth, async (req, res) => {
  const { n8nVersion } = req.body || {};
  if (!n8nVersion) return res.status(400).json({ error: "n8nVersion required" });
  const inst = db.getByCode(req.params.code);
  if (!inst) return res.status(404).json({ error: "Instance not found" });

  try {
    await dock.updateVersion(req.params.code, n8nVersion);
    db.updateInstance(req.params.code, { n8nVersion });
    audit("update_version", req, req.params.code, { version: n8nVersion });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Backup ----
app.post("/api/instances/:code/backup", auth.requireAuth, async (req, res) => {
  try {
    const result = await dock.createBackup(req.params.code);
    const backup = db.createBackup({
      id: result.id,
      code: req.params.code,
      timestamp: new Date().toISOString(),
      size: result.size,
    });
    audit("create_backup", req, req.params.code, { backupId: result.id });
    res.json(backup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Clone ----
app.post("/api/instances/:code/clone", auth.requireAuth, async (req, res) => {
  const { targetCode } = req.body || {};
  if (!targetCode || !CODE_RE.test(targetCode)) {
    return res.status(400).json({ error: "Valid targetCode required" });
  }
  if (db.getByCode(targetCode)) {
    return res.status(409).json({ error: "Target code already in use" });
  }
  const source = db.getByCode(req.params.code);
  if (!source) return res.status(404).json({ error: "Source instance not found" });

  try {
    // Create target instance
    const port = await dock.findAvailablePort(db.getAllPorts());
    await dock.createInstance({
      code: targetCode, port, publicBaseUrl: PUBLIC_BASE_URL,
      timezone: source.timezone || undefined,
    });
    const inst = db.createInstance({
      code: targetCode, port,
      ownerName: source.ownerName || "",
      tags: source.tags || [],
      resourceLimits: source.resourceLimits || null,
      n8nVersion: source.n8nVersion || null,
      basicAuthUser: source.basicAuthUser || "",
      createdAt: new Date().toISOString(),
      status: "running",
    });

    // Clone workflows via n8n API
    const result = await dock.cloneInstance(req.params.code, targetCode);
    audit("clone_instance", req, targetCode, { source: req.params.code, ...result });
    res.json({ instance: inst, ...result });
  } catch (err) {
    res.status(500).json({ error: "Clone failed: " + err.message });
  }
});

// ========== Backups ==========
app.get("/api/backups", auth.requireAuth, (req, res) => {
  const code = req.query.code || "";
  res.json(db.getBackups(code));
});

app.post("/api/backups/:id/restore", auth.requireAuth, async (req, res) => {
  try {
    await dock.restoreBackup(req.params.id);
    audit("restore_backup", req, null, { backupId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/backups/:id", auth.requireAuth, async (req, res) => {
  try {
    await dock.deleteBackupFile(req.params.id);
    db.removeBackup(req.params.id);
    audit("delete_backup", req, null, { backupId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Schedules ==========
app.get("/api/schedules", auth.requireAuth, (req, res) => {
  res.json(db.getSchedules());
});

app.post("/api/schedules", auth.requireAuth, (req, res) => {
  const { name, type, instanceCode, interval } = req.body || {};
  if (!name || !type || !interval) return res.status(400).json({ error: "name, type, interval required" });
  if (!["start", "stop", "restart"].includes(type)) return res.status(400).json({ error: "type must be start/stop/restart" });
  if (interval < 1) return res.status(400).json({ error: "interval must be at least 1 minute" });

  const schedule = db.createSchedule({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    type,
    instanceCode: instanceCode || "*",
    interval,
    enabled: true,
    lastRun: null,
    createdAt: new Date().toISOString(),
  });
  audit("create_schedule", req, null, { scheduleId: schedule.id });
  res.json(schedule);
});

app.put("/api/schedules/:id", auth.requireAuth, (req, res) => {
  const { name, type, instanceCode, interval } = req.body || {};
  const patch = {};
  if (name) patch.name = name;
  if (type) {
    if (!["start", "stop", "restart"].includes(type)) return res.status(400).json({ error: "type must be start/stop/restart" });
    patch.type = type;
  }
  if (instanceCode !== undefined) patch.instanceCode = instanceCode;
  if (interval) {
    if (interval < 1) return res.status(400).json({ error: "interval must be at least 1 minute" });
    patch.interval = interval;
  }
  const updated = db.updateSchedule(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: "Schedule not found" });
  audit("update_schedule", req, null, { scheduleId: req.params.id });
  res.json(updated);
});

app.delete("/api/schedules/:id", auth.requireAuth, (req, res) => {
  const s = db.getSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "Schedule not found" });
  db.removeSchedule(req.params.id);
  audit("delete_schedule", req, null, { scheduleId: req.params.id });
  res.json({ ok: true });
});

app.post("/api/schedules/:id/toggle", auth.requireAuth, (req, res) => {
  const s = db.getSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "Schedule not found" });
  const updated = db.updateSchedule(req.params.id, { enabled: !s.enabled });
  audit("toggle_schedule", req, null, { scheduleId: req.params.id, enabled: !s.enabled });
  res.json(updated);
});

// ========== Bulk operations ==========
app.post("/api/bulk", auth.requireAuth, async (req, res) => {
  const { action, codes } = req.body || {};
  if (!action || !codes || !Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: "action and codes array required" });
  }
  if (!["start", "stop", "restart", "delete"].includes(action)) {
    return res.status(400).json({ error: "action must be start/stop/restart/delete" });
  }

  const results = [];
  for (const code of codes) {
    try {
      switch (action) {
        case "start":
          await dock.startInstance(code);
          db.updateInstance(code, { status: "running" });
          break;
        case "stop":
          await dock.stopInstance(code);
          db.updateInstance(code, { status: "stopped" });
          break;
        case "restart":
          await dock.restartInstance(code);
          db.updateInstance(code, { status: "running" });
          break;
        case "delete":
          await dock.removeInstance(code, { removeVolume: false });
          db.removeInstance(code);
          break;
      }
      results.push({ code, ok: true });
    } catch (err) {
      results.push({ code, ok: false, error: err.message });
    }
  }
  audit("bulk_" + action, req, null, { codes, results });
  res.json({ results });
});

// ========== Audit log ==========
app.get("/api/audit", auth.requireAuth, (req, res) => {
  const limit = Number(req.query.limit) || 200;
  const offset = Number(req.query.offset) || 0;
  res.json(db.getAudit(limit, offset));
});

// ========== Health ==========
app.get("/health", (req, res) => res.json({ ok: true }));

// ========== Static dashboard ==========
app.use("/m", express.static(path.join(__dirname, "public", "m")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`n8n-manager listening on :${PORT}`);
  initScheduler();
});
