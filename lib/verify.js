import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { modelsOf, readJSON } from "./catalog.js";
import { getPath } from "./patches.js";
import { topLevelString } from "./toml.js";

export function codexBin(env = process.env) {
  if (env.CODEX_PURGE_CODEX) return env.CODEX_PURGE_CODEX;
  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return "codex";
}

export function runCodex(args, { home, timeout = 45000, env = process.env } = {}) {
  const bin = codexBin(env);
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    env: { ...env, CODEX_HOME: home || env.CODEX_HOME },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error ? String(res.error.message || res.error) : null,
  };
}

// 该模型是否已被清洗：guardian 分类器换成恒 low 版本
function guardianIsPurged(model) {
  const text = getPath(model, ["model_messages", "guardian_v2", "classifier_instructions"]);
  return typeof text === "string" && text.includes("Always return `low`");
}

function autoReviewIsPurged(model) {
  const ar = getPath(model, ["model_messages", "auto_review"]);
  if (!ar || typeof ar !== "object") return false;
  return (ar.policy === null || ar.policy === undefined) && (ar.policy_template === null || ar.policy_template === undefined);
}

export function verifyFiles(p) {
  const checks = [];
  const configText = fs.existsSync(p.config) ? fs.readFileSync(p.config, "utf8") : "";
  const wired = topLevelString(configText, "model_catalog_json");
  checks.push({
    name: "config.toml 已指向 override catalog",
    ok: !!wired && path.resolve(wired) === path.resolve(p.overrideCatalog),
    detail: wired ? `model_catalog_json = ${wired}` : "model_catalog_json 未设置",
  });

  let catalog = null;
  try {
    catalog = readJSON(p.overrideCatalog);
    checks.push({ name: "override catalog 可解析", ok: true, detail: p.overrideCatalog });
  } catch (e) {
    checks.push({ name: "override catalog 可解析", ok: false, detail: String(e.message || e) });
    return { checks, models: [] };
  }

  const models = modelsOf(catalog);
  const guarded = models.filter((m) => getPath(m, ["model_messages", "guardian_v2"]));
  const purgedGuardian = guarded.filter(guardianIsPurged);
  const reviewable = models.filter((m) => getPath(m, ["model_messages", "auto_review"]));
  const purgedReview = reviewable.filter(autoReviewIsPurged);

  checks.push({
    name: "guardian 分类器已改为恒 low",
    ok: guarded.length > 0 && purgedGuardian.length === guarded.length,
    detail: `${purgedGuardian.length}/${guarded.length} 个带 guardian 的模型`,
  });
  checks.push({
    name: "auto_review 策略已清空",
    ok: reviewable.length > 0 && purgedReview.length === reviewable.length,
    detail: `${purgedReview.length}/${reviewable.length} 个带 auto_review 的模型`,
  });
  return { checks, models };
}

// 用 codex 自身验证 override 是否真正生效
export function verifyLive(p, env) {
  const checks = [];

  const doctor = runCodex(["doctor"], { home: p.home, env, timeout: 60000 });
  const doctorText = doctor.stdout + doctor.stderr;
  const configOk = /✓\s+config\s+loaded|config\s+loaded/.test(doctorText);
  const configBad = /✗\s+config/.test(doctorText);
  checks.push({
    name: "codex doctor: config 可加载",
    ok: configOk && !configBad,
    detail: configBad ? firstLine(doctorText, /✗\s+config.*/) : "loaded",
  });

  const dbg = runCodex(["debug", "models"], { home: p.home, env, timeout: 60000 });
  if (!dbg.ok) {
    checks.push({
      name: "codex debug models: 读取生效目录",
      ok: false,
      detail: firstLine(dbg.stderr || dbg.stdout, /.*/) || `exit ${dbg.status}`,
    });
    return checks;
  }
  let live = null;
  try {
    live = JSON.parse(dbg.stdout);
  } catch (e) {
    checks.push({ name: "codex debug models: 输出可解析", ok: false, detail: String(e.message || e) });
    return checks;
  }
  const liveModels = modelsOf(live);
  const liveGuarded = liveModels.filter((m) => getPath(m, ["model_messages", "guardian_v2"]));
  const livePurged = liveGuarded.filter(guardianIsPurged);
  checks.push({
    name: "codex 实际加载的目录已是清洗版",
    ok: liveGuarded.length > 0 && livePurged.length === liveGuarded.length,
    detail: `${livePurged.length}/${liveGuarded.length} 个 guardian 已替换`,
  });
  return checks;
}

function firstLine(text, re) {
  const line = String(text || "")
    .split("\n")
    .find((l) => re.test(l));
  return line ? line.trim().slice(0, 160) : "";
}
