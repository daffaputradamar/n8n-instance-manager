const Docker = require("dockerode");
const fs = require("fs");
const path = require("path");
const http = require("http");

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});

const NETWORK = process.env.N8N_NETWORK || "n8n-manager-net";
const IMAGE = process.env.N8N_IMAGE || "n8nio/n8n:latest";
const PORT_MIN = Number(process.env.N8N_PORT_MIN || 5601);
const PORT_MAX = Number(process.env.N8N_PORT_MAX || 5699);
const BACKUP_DIR = path.join(__dirname, "..", "data", "backups");

function containerName(code) {
  return `n8n-${code}`;
}
function volumeName(code) {
  return `n8n-data-${code}`;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ---- image / network helpers ----
async function ensureImage(imageTag) {
  const tag = imageTag || IMAGE;
  const images = await docker.listImages({ filters: { reference: [tag] } });
  if (images.length > 0) return;
  await new Promise((resolve, reject) => {
    docker.pull(tag, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

async function findAvailablePort(assignedPorts) {
  const used = new Set(assignedPorts);
  const containers = await docker.listContainers({ all: true });
  for (const c of containers) {
    if (c.Ports) {
      for (const p of c.Ports) {
        if (p.PublicPort) used.add(p.PublicPort);
      }
    }
  }
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`No available port in range ${PORT_MIN}-${PORT_MAX}`);
}

// ---- instance lifecycle ----
async function createInstance({ code, port, publicBaseUrl, basicAuthUser, basicAuthPassword, timezone, resourceLimits, n8nVersion }) {
  const imageTag = n8nVersion || IMAGE;
  await ensureImage(imageTag);
  await docker.createVolume({ Name: volumeName(code) });

  const hostBase = publicBaseUrl.replace(/:\d+$/, "");
  const instanceUrl = `${hostBase}:${port}`;
  const env = [
    `WEBHOOK_URL=${instanceUrl}/`,
    `N8N_EDITOR_BASE_URL=${instanceUrl}/`,
    `GENERIC_TIMEZONE=${timezone || "Asia/Jakarta"}`,
    `N8N_SECURE_COOKIE=false`,
  ];
  if (basicAuthUser && basicAuthPassword) {
    env.push("N8N_BASIC_AUTH_ACTIVE=true");
    env.push(`N8N_BASIC_AUTH_USER=${basicAuthUser}`);
    env.push(`N8N_BASIC_AUTH_PASSWORD=${basicAuthPassword}`);
  }

  const hostCfg = {
    Binds: [`${volumeName(code)}:/home/node/.n8n`],
    RestartPolicy: { Name: "unless-stopped" },
    NetworkMode: NETWORK,
    PortBindings: { "5678/tcp": [{ HostPort: String(port) }] },
  };
  if (resourceLimits) {
    if (resourceLimits.cpu) hostCfg.NanoCPUs = resourceLimits.cpu * 1e9;
    if (resourceLimits.memory) hostCfg.Memory = resourceLimits.memory * 1024 * 1024;
  }

  const container = await docker.createContainer({
    Image: imageTag,
    name: containerName(code),
    Env: env,
    Labels: { "n8n-manager.code": code, "n8n-manager.version": imageTag },
    ExposedPorts: { "5678/tcp": {} },
    HostConfig: hostCfg,
  });
  await container.start();
  return container.id;
}

async function startInstance(code) {
  const c = docker.getContainer(containerName(code));
  await c.start();
}

async function stopInstance(code) {
  const c = docker.getContainer(containerName(code));
  await c.stop();
}

async function restartInstance(code) {
  const c = docker.getContainer(containerName(code));
  await c.restart();
}

async function removeInstance(code, { removeVolume } = {}) {
  const c = docker.getContainer(containerName(code));
  try { await c.stop(); } catch {}
  await c.remove({ force: true });
  if (removeVolume) {
    try { await docker.getVolume(volumeName(code)).remove(); } catch {}
  }
}

async function getStatus(code) {
  try {
    const c = docker.getContainer(containerName(code));
    const info = await c.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

// ---- monitoring ----
async function getStats(code) {
  try {
    const c = docker.getContainer(containerName(code));
    const stats = await c.stats({ stream: false });

    let cpuPercent = 0;
    try {
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const sysDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || stats.cpu_stats.system_cpu_usage);
      if (sysDelta > 0 && stats.cpu_stats.online_cpus > 0) {
        cpuPercent = (cpuDelta / sysDelta) * stats.cpu_stats.online_cpus * 100;
      }
    } catch {}

    let memUsage = 0, memLimit = 0;
    try {
      const cache = (stats.memory_stats.stats && stats.memory_stats.stats.cache) || 0;
      memUsage = stats.memory_stats.usage - cache;
      memLimit = stats.memory_stats.limit;
    } catch {}

    return {
      cpu: Math.round(cpuPercent * 100) / 100,
      memory: Math.round(memUsage / (1024 * 1024)),
      memoryLimit: Math.round(memLimit / (1024 * 1024)),
    };
  } catch {
    return { cpu: 0, memory: 0, memoryLimit: 0 };
  }
}

// ---- log demux ----
function demuxLogs(buffer) {
  let result = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);
    result += buffer.slice(start, end).toString("utf-8");
    offset = end;
  }
  return result || buffer.toString("utf-8");
}

async function getLogs(code, tail = 200) {
  const c = docker.getContainer(containerName(code));
  const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: true });
  return demuxLogs(buf);
}

// ---- backup / restore ----
async function createBackup(code) {
  ensureBackupDir();
  const zlib = require("zlib");
  const c = docker.getContainer(containerName(code));

  const tarStream = await c.getArchive({ path: "/home/node/.n8n" });
  const chunks = [];
  for await (const chunk of tarStream) chunks.push(chunk);
  const gz = zlib.gzipSync(Buffer.concat(chunks));

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fname = `${code}-${ts}.tar.gz`;
  const fpath = path.join(BACKUP_DIR, fname);
  fs.writeFileSync(fpath, gz);
  return {
    id: fname.replace(".tar.gz", ""),
    code,
    path: fpath,
    size: gz.length,
  };
}

async function restoreBackup(backupId) {
  ensureBackupDir();
  const zlib = require("zlib");
  const files = fs.readdirSync(BACKUP_DIR);
  const match = files.find((f) => f.startsWith(backupId));
  if (!match) throw new Error("Backup file not found");

  const code = match.split("-")[0];
  const c = docker.getContainer(containerName(code));
  await c.inspect(); // verify exists

  try { await c.stop(); } catch {}

  const fpath = path.join(BACKUP_DIR, match);
  const gz = fs.readFileSync(fpath);
  const tarData = zlib.gunzipSync(gz);
  await c.putArchive(tarData, { path: "/home/node/.n8n" });

  await c.start();
}

async function deleteBackupFile(backupId) {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR);
  const match = files.find((f) => f.startsWith(backupId));
  if (match) fs.unlinkSync(path.join(BACKUP_DIR, match));
}

// ---- version management ----
async function updateVersion(code, imageTag) {
  await ensureImage(imageTag);
  const inst = await docker.getContainer(containerName(code)).inspect().catch(() => null);
  if (!inst) throw new Error("Instance not found");

  await stopInstance(code);
  await docker.getContainer(containerName(code)).remove({ force: true });

  const hostPort = inst.HostConfig.PortBindings["5678/tcp"]
    ? inst.HostConfig.PortBindings["5678/tcp"][0].HostPort
    : null;

  const env = [...(inst.Config.Env || [])];

  const hostCfg = {
    Binds: inst.HostConfig.Binds || [],
    RestartPolicy: inst.HostConfig.RestartPolicy || { Name: "unless-stopped" },
    NetworkMode: inst.HostConfig.NetworkMode,
  };
  if (hostPort) hostCfg.PortBindings = { "5678/tcp": [{ HostPort: hostPort }] };
  if (inst.HostConfig.NanoCPUs) hostCfg.NanoCPUs = inst.HostConfig.NanoCPUs;
  if (inst.HostConfig.Memory) hostCfg.Memory = inst.HostConfig.Memory;

  const container = await docker.createContainer({
    Image: imageTag,
    name: containerName(code),
    Env: env,
    Labels: { ...inst.Config.Labels, "n8n-manager.version": imageTag },
    ExposedPorts: { "5678/tcp": {} },
    HostConfig: hostCfg,
  });
  await container.start();
}

// ---- cloning via n8n API ----
function n8nReq(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) opts.headers["Content-Length"] = Buffer.byteLength(body);

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

async function cloneInstance(sourceCode, targetCode) {
  // Get source instance port
  const source = docker.getContainer(containerName(sourceCode));
  const info = await source.inspect();
  const port = info.HostConfig.PortBindings["5678/tcp"]
    ? Number(info.HostConfig.PortBindings["5678/tcp"][0].HostPort)
    : null;
  if (!port) throw new Error("Could not determine source port");

  // Export workflows from source
  const exportRes = await n8nReq(port, "GET", "/rest/workflows?limit=250");
  if (exportRes.status >= 400) throw new Error("Export failed: " + exportRes.status);
  let workflows = (exportRes.data && exportRes.data.data) || [];

  // For each workflow, get full definition
  const fullWorkflows = [];
  for (const w of workflows) {
    const detail = await n8nReq(port, "GET", `/rest/workflows/${w.id}`);
    if (detail.status < 400 && detail.data) {
      fullWorkflows.push(detail.data);
    }
  }

  // Import into target
  if (fullWorkflows.length === 0) return { workflowsImported: 0 };

  const targetPort = info.HostConfig.PortBindings["5678/tcp"]
    ? Number(info.HostConfig.PortBindings["5678/tcp"][0].HostPort)
    : null;
  if (!targetPort) throw new Error("Could not determine target port");

  let imported = 0;
  for (const w of fullWorkflows) {
    const createRes = await n8nReq(
      port,
      "POST",
      "/rest/workflows",
      JSON.stringify({ name: w.name || "Cloned workflow", nodes: w.nodes, connections: w.connections, settings: w.settings })
    );
    if (createRes.status < 400) imported++;
  }
  return { workflowsImported: imported };
}

module.exports = {
  containerName,
  volumeName,
  findAvailablePort,
  createInstance,
  startInstance,
  stopInstance,
  restartInstance,
  removeInstance,
  getStatus,
  getLogs,
  getStats,
  createBackup,
  restoreBackup,
  deleteBackupFile,
  updateVersion,
  cloneInstance,
  PORT_MIN,
  PORT_MAX,
};
