// Persistent trusted-device store for the BuildID host.
// File: <userData>/trusted.json — { devices: [{ id, name, secret, addedAt, lastSeen }] }

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let filePath = null;
let cache = { devices: [] };

function init(userDataDir) {
  filePath = path.join(userDataDir, 'trusted.json');
  try {
    if (fs.existsSync(filePath)) {
      cache = JSON.parse(fs.readFileSync(filePath, 'utf8')) || { devices: [] };
      if (!Array.isArray(cache.devices)) cache.devices = [];
    }
  } catch (e) {
    console.warn('[trust] failed to read store, starting empty:', e.message);
    cache = { devices: [] };
  }
}

function persist() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[trust] failed to write store:', e.message);
  }
}

function list() {
  return cache.devices.map(({ secret, ...rest }) => rest); // never expose secret to UI
}

function listFull() {
  return cache.devices.slice();
}

function addOrUpdate({ id, name }) {
  if (!id || !name) throw new Error('id_and_name_required');
  let entry = cache.devices.find((d) => d.id === id);
  if (!entry) {
    entry = {
      id,
      name,
      secret: crypto.randomBytes(32).toString('base64url'),
      addedAt: Date.now(),
      lastSeen: Date.now(),
    };
    cache.devices.push(entry);
  } else {
    entry.name = name;
    entry.lastSeen = Date.now();
  }
  persist();
  return entry;
}

function touch(id) {
  const entry = cache.devices.find((d) => d.id === id);
  if (entry) {
    entry.lastSeen = Date.now();
    persist();
  }
}

function remove(id) {
  const before = cache.devices.length;
  cache.devices = cache.devices.filter((d) => d.id !== id);
  if (cache.devices.length !== before) persist();
}

module.exports = { init, list, listFull, addOrUpdate, touch, remove };
