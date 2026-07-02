const Docker = require("dockerode");

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});

const NETWORK = process.env.N8N_NETWORK || "n8n-manager-net";
const IMAGE = process.env.N8N_IMAGE || "n8nio/n8n:latest";
const PORT_MIN = Number(process.env.N8N_PORT_MIN || 5601);
const PORT_MAX = Number(process.env.N8N_PORT_MAX || 5699);

function containerName(code) {
  return `n8n-${code}`;
}
function volumeName(code) {
  return `n8n-data-${code}`;
}

async function ensureImage() {
  const images = await docker.listImages({ filters: { reference: [IMAGE] } });
  if (images.length > 0) return;
  await new Promise((resolve, reject) => {
    docker.pull(IMAGE, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

async function findAvailablePort(assignedPorts) {
  // Check which ports are actually in use on the host
  const used = new Set(assignedPorts);
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`No available port in range ${PORT_MIN}-${PORT_MAX}`);
}

async function createInstance({ code, port, publicBaseUrl, basicAuthUser, basicAuthPassword, timezone }) {
  await ensureImage();
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

  const container = await docker.createContainer({
    Image: IMAGE,
    name: containerName(code),
    Env: env,
    Labels: { "n8n-manager.code": code },
    ExposedPorts: { "5678/tcp": {} },
    HostConfig: {
      Binds: [`${volumeName(code)}:/home/node/.n8n`],
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: NETWORK,
      PortBindings: {
        "5678/tcp": [{ HostPort: String(port) }],
      },
    },
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
  try {
    await c.stop();
  } catch (e) {
    // already stopped, ignore
  }
  await c.remove({ force: true });
  if (removeVolume) {
    try {
      await docker.getVolume(volumeName(code)).remove();
    } catch (e) {
      // volume may already be gone
    }
  }
}

async function getStatus(code) {
  try {
    const c = docker.getContainer(containerName(code));
    const info = await c.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch (e) {
    return "missing";
  }
}

// Docker multiplexes stdout/stderr into frames of [8 byte header][payload]
// when the container was created without a TTY. Demux so logs read cleanly.
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

module.exports = {
  createInstance,
  startInstance,
  stopInstance,
  restartInstance,
  removeInstance,
  getStatus,
  getLogs,
  containerName,
  volumeName,
  findAvailablePort,
  PORT_MIN,
  PORT_MAX,
};
