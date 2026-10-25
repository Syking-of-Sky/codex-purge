import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function sha256File(file) {
  try {
    const buf = await fsp.readFile(file);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export async function readState(statePath) {
  try {
    return JSON.parse(await fsp.readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writeState(statePath, state) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
}

export function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const KEEP_BACKUPS = 10;

// 备份 config.toml 到 backups/<stamp>/，返回备份目录
export async function backupConfig(configPath, backupsDir) {
  const dir = path.join(backupsDir, stamp());
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, "config.toml");
  await fsp.copyFile(configPath, target);
  await pruneBackups(backupsDir);
  return dir;
}

async function pruneBackups(backupsDir) {
  let entries;
  try {
    entries = await fsp.readdir(backupsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  while (dirs.length > KEEP_BACKUPS) {
    const victim = dirs.shift();
    await fsp.rm(path.join(backupsDir, victim), { recursive: true, force: true }).catch(() => {});
  }
}

export async function listBackups(backupsDir) {
  try {
    const entries = await fsp.readdir(backupsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function latestBackup(backupsDir) {
  const all = await listBackups(backupsDir);
  if (!all.length) return null;
  return path.join(backupsDir, all[0], "config.toml");
}

export function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
