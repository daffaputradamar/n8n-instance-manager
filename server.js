require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const db = require("./src/db");
const dock = require("./src/docker");
const { requireAuth } = require("./src/auth");

const PORT = process.env.MANAGER_PORT || 5600;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

const CODE_RE = /^[a-z0-9][a-z0-9-]{2,19}$/; // 3-20 chars, lowercase letters/digits/dashes

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

// ---------- Auth ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Invalid username or password" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed) });
});

// ---------- Instance API ----------
app.get("/api/instances", requireAuth, async (req, res) => {
  const list = db.getAll();
  const withStatus = await Promise.all(
    list.map(async (i) => ({ ...i, status: await dock.getStatus(i.code) }))
  );
  res.json(withStatus);
});

app.post("/api/instances", requireAuth, async (req, res) => {
  const { code, ownerName, basicAuthUser, basicAuthPassword, timezone } = req.body || {};

  if (!code || !CODE_RE.test(code)) {
    return res.status(400).json({
      error: "Code must be 3-20 lowercase letters, numbers, or dashes.",
    });
  }
  if (db.getByCode(code)) {
    return res.status(409).json({ error: "That code is already in use." });
  }
  if ((basicAuthUser && !basicAuthPassword) || (!basicAuthUser && basicAuthPassword)) {
    return res.status(400).json({ error: "Provide both a basic-auth username and password, or neither." });
  }

  try {
    const port = await dock.findAvailablePort(db.getAllPorts());
    await dock.createInstance({
      code,
      port,
      publicBaseUrl: PUBLIC_BASE_URL,
      basicAuthUser,
      basicAuthPassword,
      timezone,
    });
    const instance = db.create({
      code,
      port,
      ownerName: ownerName || "",
      basicAuthUser: basicAuthUser || "",
      createdAt: new Date().toISOString(),
      status: "running",
    });
    res.json(instance);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create instance: " + err.message });
  }
});

app.post("/api/instances/:code/start", requireAuth, async (req, res) => {
  try {
    await dock.startInstance(req.params.code);
    db.update(req.params.code, { status: "running" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/instances/:code/stop", requireAuth, async (req, res) => {
  try {
    await dock.stopInstance(req.params.code);
    db.update(req.params.code, { status: "stopped" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/instances/:code/restart", requireAuth, async (req, res) => {
  try {
    await dock.restartInstance(req.params.code);
    db.update(req.params.code, { status: "running" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/instances/:code", requireAuth, async (req, res) => {
  const removeVolume = req.query.removeData === "true";
  try {
    await dock.removeInstance(req.params.code, { removeVolume });
    db.remove(req.params.code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/instances/:code/logs", requireAuth, async (req, res) => {
  try {
    const tail = Number(req.query.tail) || 200;
    const logs = await dock.getLogs(req.params.code, tail);
    res.type("text/plain").send(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Static dashboard ----------
app.use("/m", express.static(path.join(__dirname, "public", "m")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`n8n-manager listening on :${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
