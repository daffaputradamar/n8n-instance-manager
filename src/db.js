const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "instances.json");

function ensureFile() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ instances: [] }, null, 2));
  }
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DB_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return { instances: [] };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function getAll() {
  return readAll().instances;
}

function getByCode(code) {
  return readAll().instances.find((i) => i.code === code) || null;
}

function create(instance) {
  const data = readAll();
  data.instances.push(instance);
  writeAll(data);
  return instance;
}

function update(code, patch) {
  const data = readAll();
  const idx = data.instances.findIndex((i) => i.code === code);
  if (idx === -1) return null;
  data.instances[idx] = { ...data.instances[idx], ...patch };
  writeAll(data);
  return data.instances[idx];
}

function getAllPorts() {
  return readAll().instances.map((i) => i.port).filter(Boolean);
}

function remove(code) {
  const data = readAll();
  data.instances = data.instances.filter((i) => i.code !== code);
  writeAll(data);
}

module.exports = { getAll, getByCode, create, update, remove, getAllPorts };
