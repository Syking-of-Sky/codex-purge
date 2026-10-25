import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { paths, codexHome } from "./paths.js";
import { deriveCatalog, overallStatus, modelsOf, readJSON } from "./catalog.js";
import { ALL_PATCHES } from "./patches.js";
import { setTopLevel, topLevelString } from "./toml.js";
import {
  sha256File,
  readState,
  writeState,
  backupConfig,
  latestBackup,
  existsSync,
} from "./state.js";
import { verifyFiles, verifyLive, runCodex } from "./verify.js";

export { paths } from "./paths.js";
export { ALL_PATCHES } from "./patches.js";

export class PurgeError extends Error {}

export async function gatherState(env = process.env) {
  const p = paths(codexHome(env));
  const state = await readState(p.state);
  const configText = existsSync(p.config) ? await fsp.readFile(p.config, "utf8") : "";
  const wired = topLevelString(configText, "model_catalog_json");
  const sourceHash = await sha256File(p.sourceCatalog);
  const overrideHash = await sha256File(p.overrideCatalog);

  let summary = null;
  let modelCount = 0;
  if (existsSync(p.sourceCatalog)) {
    try {
      const src = readJSON(p.sourceCatalog);
      const derived = deriveCatalog(src);
      modelCount = modelsOf(src).length;
      summary = derived.summary;
    } catch {
      summary = null;
    }
  }

  return {
    home: p.home,
    config: p.config,
    sourceCatalog: p.sourceCatalog,
    overrideCatalog: p.overrideCatalog,
    hasSource: existsSync(p.sourceCatalog),
    hasOverride: existsSync(p.overrideCatalog),
    wired,
    wiredToUs: !!wired && path.resolve(wired) === path.resolve(p.overrideCatalog),
    sourceHash,
    overrideHash,
    state,
    summary,
    modelCount,
    drift: !!(state && sourceHash && state.sourceHash && state.sourceHash !== sourceHash),
  };
}

export function formatStatus(s) {
  const out = [];
  out.push("codex-purge 状态 / Status");
  out.push(`  CODEX_HOME        ${s.home}`);
  out.push(`  源目录 catalog    ${s.sourceCatalog}${s.hasSource ? "" : "  (缺失)"}`);
  out.push(`  override          ${s.overrideCatalog}${s.hasOverride ? "" : "  (未生成)"}`);
  out.push(`  config 接线       ${s.wired || "未设置"}${s.wiredToUs ? "  ✓ 指向本插件" : ""}`);
  out.push("");
  if (!s.hasSource) {
    out.push("  源 catalog 不存在：先运行一次 codex（登录后会自动拉取 models_cache.json）");
    return out.join("\n");
  }
  out.push(`  模型数 ${s.modelCount}`);
  const ov = s.summary ? overallStatus(s.summary) : { applied: 0, pending: 0, notApplicable: 0 };
  const applicable = s.modelCount * ALL_PATCHES.length - ov.notApplicable;
  out.push(`  补丁 ${ov.applied}/${applicable} 命中，${ov.pending} 处锚点漂移，共 ${ALL_PATCHES.length} 条`);
  out.push("");
  for (const patch of ALL_PATCHES) {
    const counts = (s.summary && s.summary[patch.id]) || {};
    const applied = (counts.applied || 0) + (counts.already || 0);
    const missing = counts.missing || 0;
    const na = counts.not_applicable || 0;
    const denom = s.modelCount - na;
    const mark = denom === 0 ? "·" : applied > 0 && missing === 0 ? "✓" : applied > 0 ? "!" : "✗";
    const detail =
      denom === 0 ? "该版本模板无此结构" : `${applied}/${denom} 命中${missing ? `, ${missing} 漂移` : ""}`;
    out.push(
      `  ${mark} [#${String(patch.id).padStart(2)}] ${patch.name.padEnd(30)} ${patch.layer.padEnd(13)} ${detail}`,
    );
  }
  out.push("");
  if (s.state?.appliedAt) {
    out.push(`  上次应用 ${s.state.appliedAt}  (codex ${s.state.codexVersion || "unknown"})`);
  } else {
    out.push("  尚未应用");
  }
  if (s.drift) out.push("  ! 源 catalog 已更新（codex 刷新了缓存），建议重新 apply");
  return out.join("\n");
}

export async function apply({ verify = true, env = process.env } = {}) {
  const p = paths(codexHome(env));
  const logs = [];

  if (!existsSync(p.sourceCatalog)) {
    throw new PurgeError(
      `源 catalog 不存在：${p.sourceCatalog}\n先运行一次 codex（登录后会自动拉取模型目录），再执行 apply。`,
    );
  }
  if (!existsSync(p.config)) {
    throw new PurgeError(`config.toml 不存在：${p.config}`);
  }

  const src = readJSON(p.sourceCatalog);
  const derived = deriveCatalog(src);

  await fsp.mkdir(p.root, { recursive: true });
  const backupDir = await backupConfig(p.config, p.backups);
  logs.push(`备份 config.toml → ${backupDir}`);

  await fsp.writeFile(p.overrideCatalog, JSON.stringify(derived.catalog) + "\n");
  logs.push(`写入 override catalog → ${p.overrideCatalog}`);

  const configText = await fsp.readFile(p.config, "utf8");
  const wired = setTopLevel(configText, "model_catalog_json", p.overrideCatalog);
  if (wired.changed) {
    await fsp.writeFile(p.config, wired.text);
    logs.push(`接线 config.toml: model_catalog_json = ${p.overrideCatalog}`);
  } else {
    logs.push("config.toml 接线已是最新");
  }

  await writeAssets(p, derived);

  const state = {
    version: 1,
    appliedAt: new Date().toISOString(),
    codexVersion: detectCodexVersion(p, env),
    sourceHash: await sha256File(p.sourceCatalog),
    overrideHash: await sha256File(p.overrideCatalog),
    backupDir,
    patches: Object.fromEntries(
      ALL_PATCHES.map((patch) => {
        const counts = derived.summary[patch.id] || {};
        const status = (counts.applied || 0) > 0 ? "applied" : (counts.already || 0) > 0 ? "already" : "missing";
        return [patch.id, status];
      }),
    ),
  };
  await writeState(p.state, state);
  logs.push(`写入状态 → ${p.state}`);

  const result = { logs, summary: derived.summary, state, checks: [] };
  if (verify) {
    result.checks = [...verifyFiles(p).checks, ...verifyLive(p, env)];
  }
  return result;
}

async function writeAssets(p, derived) {
  // 供 --edit 直接改的落地视图：取主模型的模板
  const models = modelsOf(derived.catalog);
  const primary =
    models.find((m) => m.slug === "gpt-6-astra") ||
    models.find((m) => m.model_messages?.guardian_v2) ||
    models[0];
  if (primary?.model_messages?.instructions_template) {
    await fsp.writeFile(
      p.instructions,
      `<!-- codex-purge: ${primary.slug} 的 instructions_template 落地副本。改动后需重新 apply。 -->\n` +
        primary.model_messages.instructions_template,
    );
  }
  const guardian = primary?.model_messages?.guardian_v2?.classifier_instructions;
  if (guardian) {
    await fsp.writeFile(
      p.guardian,
      `<!-- codex-purge: guardian 分类器指令（恒 low）。改动后需重新 apply。 -->\n` + guardian,
    );
  }
}

function detectCodexVersion(p, env) {
  const r = runCodex(["--version"], { home: p.home, env, timeout: 20000 });
  const m = /codex-cli\s+([\w.\-]+)/.exec(r.stdout + r.stderr);
  return m ? m[1] : null;
}

export async function revert({ env = process.env } = {}) {
  const p = paths(codexHome(env));
  const logs = [];
  if (!existsSync(p.config)) throw new PurgeError(`config.toml 不存在：${p.config}`);

  const configText = await fsp.readFile(p.config, "utf8");
  const wired = topLevelString(configText, "model_catalog_json");
  if (wired && path.resolve(wired) === path.resolve(p.overrideCatalog)) {
    const { unsetTopLevel } = await import("./toml.js");
    const r = unsetTopLevel(configText, "model_catalog_json");
    if (r.changed) {
      await fsp.writeFile(p.config, r.text);
      logs.push("已移除 config.toml 的 model_catalog_json 接线（其余内容未动）");
    }
  } else if (wired) {
    logs.push(`config.toml 的 model_catalog_json 指向他处（${wired}），未改动`);
  } else {
    logs.push("config.toml 无 model_catalog_json，无需回滚");
  }

  if (existsSync(p.overrideCatalog)) {
    const keep = path.join(p.root, "catalog.reverted.json");
    await fsp.rename(p.overrideCatalog, keep);
    logs.push(`override catalog 已归档 → ${keep}`);
  }

  const backup = await latestBackup(p.backups);
  const state = (await readState(p.state)) || {};
  await writeState(p.state, {
    ...state,
    version: 1,
    appliedAt: null,
    revertedAt: new Date().toISOString(),
    patches: {},
  });
  logs.push("状态已标记为未应用");

  const checks = verifyFiles(p).checks;
  return { logs, backup, checks };
}

export async function uninstall({ env = process.env } = {}) {
  const p = paths(codexHome(env));
  const r = await revert({ env });
  await fsp.rm(p.overrideCatalog, { force: true }).catch(() => {});
  return r;
}

export { verifyFiles, verifyLive, runCodex };
