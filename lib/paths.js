import os from "node:os";
import path from "node:path";

export function codexHome(env = process.env) {
  const raw = env.CODEX_HOME;
  if (raw && raw.trim()) return path.resolve(expandHome(raw.trim()));
  return path.join(os.homedir(), ".codex");
}

export function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function paths(home = codexHome()) {
  const root = path.join(home, "codex-purge");
  return {
    home,
    root,
    config: path.join(home, "config.toml"),
    // Codex 拉取的远端模型目录缓存；instructions_template 等 prompt 的原始来源
    sourceCatalog: path.join(home, "models_cache.json"),
    // 本插件派生并维护的 override 目录；config.toml 的 model_catalog_json 指向它
    overrideCatalog: path.join(root, "catalog.json"),
    instructions: path.join(root, "instructions.md"),
    guardian: path.join(root, "guardian.md"),
    state: path.join(root, "state.json"),
    backups: path.join(root, "backups"),
    sessions: path.join(home, "sessions"),
  };
}

export const CATALOG_KEYS = ["models_cache", "catalog_json"];
