require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const http = require("http");
const { createProxyMiddleware } = require("http-proxy-middleware");

const db = require("./src/db");
const dock = require("./src/docker");
const { requireAuth } = require("./src/auth");

const PORT = process.env.PORT || 8000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

// Codes can't collide with the manager's own routes
const RESERVED = new Set(["api", "health", "manager", "", "m"]);
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

  if (!code || !CODE_RE.test(code) || RESERVED.has(code)) {
    return res.status(400).json({
      error: "Code must be 3-20 lowercase letters, numbers, or dashes, and can't be a reserved word.",
    });
  }
  if (db.getByCode(code)) {
    return res.status(409).json({ error: "That code is already in use." });
  }
  if ((basicAuthUser && !basicAuthPassword) || (!basicAuthUser && basicAuthPassword)) {
    return res.status(400).json({ error: "Provide both a basic-auth username and password, or neither." });
  }

  try {
    await dock.createInstance({
      code,
      publicBaseUrl: PUBLIC_BASE_URL,
      basicAuthUser,
      basicAuthPassword,
      timezone,
    });
    const instance = db.create({
      code,
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

// ---------- Dynamic proxy: /{code}/* -> that user's n8n container ----------
const n8nProxy = createProxyMiddleware({
  ws: true,
  changeOrigin: true,
  logLevel: "warn",
  router: (req) => {
    let code = req.url.split("/")[1];
    // If the code isn't a known instance, try the Referer header
    if (!db.getByCode(code)) {
      const referer = req.headers.referer || "";
      const m = referer.match(/\/([a-z0-9][a-z0-9-]{2,19})\//);
      if (m && db.getByCode(m[1])) code = m[1];
    }
    return `http://${dock.containerName(code)}:5678`;
  },
  pathRewrite: (path, req) => {
    const first = path.split("/")[1];
    // Only strip the first path segment if it's a valid instance code
    if (first && /^[a-z0-9][a-z0-9-]{2,19}$/.test(first) && db.getByCode(first)) {
      return path.replace(/^\/[^/]+/, "") || "/";
    }
    return path;
  },
  onError: (err, req, res) => {
    if (res.writeHead) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Instance unreachable: " + err.message);
    }
  },
});

app.use(
  "/:code",
  async (req, res, next) => {
    let code = req.params.code;
    if (RESERVED.has(code)) return next(); // let it fall through (404 if nothing else matched)

    // If the code isn't a known instance, try the Referer header
    if (!db.getByCode(code)) {
      const referer = req.headers.referer || "";
      const m = referer.match(/\/([a-z0-9][a-z0-9-]{2,19})\//);
      if (m && db.getByCode(m[1])) code = m[1];
    }

    const inst = db.getByCode(code);
    if (!inst) return res.status(404).send(`No instance found for code "${code}".`);
    const status = await dock.getStatus(code);
    if (status !== "running") {
      return res.status(503).send(`This n8n instance ("${code}") is currently stopped.`);
    }
    next();
  },
  n8nProxy
);

const server = http.createServer(app);
server.on("upgrade", n8nProxy.upgrade);

server.listen(PORT, () => {
  console.log(`n8n-manager listening on :${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
