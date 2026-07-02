const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function colFile(name) {
  return path.join(DATA_DIR, name + ".json");
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readCol(name) {
  ensureDir();
  const f = colFile(name);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return [];
  }
}

function writeCol(name, data) {
  ensureDir();
  const f = colFile(name);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}

// ---------- users ----------
function getUsers() {
  return readCol("users");
}
function getUser(username) {
  return getUsers().find((u) => u.username === username) || null;
}
function createUser(user) {
  const users = getUsers();
  users.push(user);
  writeCol("users", users);
  return user;
}
function deleteUser(username) {
  const users = getUsers().filter((u) => u.username !== username);
  writeCol("users", users);
}
function updateUserPassword(username, passwordHash) {
  const users = getUsers();
  const u = users.find((u) => u.username === username);
  if (!u) return null;
  u.passwordHash = passwordHash;
  writeCol("users", users);
  return u;
}

// ---------- instances ----------
function getInstances() {
  return readCol("instances");
}
function getByCode(code) {
  return getInstances().find((i) => i.code === code) || null;
}
function createInstance(instance) {
  const instances = getInstances();
  instances.push(instance);
  writeCol("instances", instances);
  return instance;
}
function updateInstance(code, patch) {
  const instances = getInstances();
  const idx = instances.findIndex((i) => i.code === code);
  if (idx === -1) return null;
  instances[idx] = { ...instances[idx], ...patch };
  writeCol("instances", instances);
  return instances[idx];
}
function removeInstance(code) {
  const instances = getInstances().filter((i) => i.code !== code);
  writeCol("instances", instances);
}
function getAllPorts() {
  return getInstances().map((i) => i.port).filter(Boolean);
}

// ---------- audit ----------
function addAudit(entry) {
  const log = readCol("audit");
  log.push(entry);
  writeCol("audit", log);
}
function getAudit(limit = 200, offset = 0) {
  const log = readCol("audit");
  return log
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(offset, offset + limit);
}

// ---------- backups ----------
function getBackups(code) {
  const all = readCol("backups");
  return code ? all.filter((b) => b.code === code) : all;
}
function createBackup(backup) {
  const all = readCol("backups");
  all.push(backup);
  writeCol("backups", all);
  return backup;
}
function getBackup(id) {
  return readCol("backups").find((b) => b.id === id) || null;
}
function removeBackup(id) {
  const all = readCol("backups").filter((b) => b.id !== id);
  writeCol("backups", all);
}

// ---------- schedules ----------
function getSchedules() {
  return readCol("schedules");
}
function getSchedule(id) {
  return getSchedules().find((s) => s.id === id) || null;
}
function createSchedule(schedule) {
  const all = getSchedules();
  all.push(schedule);
  writeCol("schedules", all);
  return schedule;
}
function updateSchedule(id, patch) {
  const all = getSchedules();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch };
  writeCol("schedules", all);
  return all[idx];
}
function removeSchedule(id) {
  const all = getSchedules().filter((s) => s.id !== id);
  writeCol("schedules", all);
}

// ---------- seed default admin ----------
function seedAdmin() {
  const crypto = require("crypto");
  const users = getUsers();
  if (users.length === 0) {
    const username = process.env.ADMIN_USER || "admin";
    const password = process.env.ADMIN_PASSWORD || "admin";
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    createUser({
      username,
      passwordHash: salt + ":" + hash,
      role: "admin",
      createdAt: new Date().toISOString(),
    });
  }
}
seedAdmin();

module.exports = {
  // users
  getUsers,
  getUser,
  createUser,
  deleteUser,
  updateUserPassword,
  // instances
  getInstances: getInstances,
  getByCode,
  createInstance,
  updateInstance,
  removeInstance,
  getAllPorts,
  // audit
  addAudit,
  getAudit,
  // backups
  getBackups,
  createBackup,
  getBackup,
  removeBackup,
  // schedules
  getSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  removeSchedule,
};
