import fs from "node:fs";
import { promises as fsp } from "node:fs";
import {
  INSTRUCTION_PATCHES,
  MESSAGE_PATCHES,
  ALL_PATCHES,
  getPath,
  setPath,
} from "./patches.js";

export function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function readJSONAsync(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

export function modelsOf(catalog) {
  if (!catalog) return [];
  if (Array.isArray(catalog.models)) return catalog.models;
  if (Array.isArray(catalog)) return catalog;
  return [];
}

// 对单个 instructions_template 应用文本 patch
function applyTarget(template, target) {
  if (target.find) {
    if (!template.includes(target.find)) {
      return template.includes(target.replace) ? { status: "already" } : null;
    }
    return { status: "applied", text: template.split(target.find).join(target.replace) };
  }
  if (target.start && target.end) {
    const i = template.indexOf(target.start);
    if (i < 0) return null;
    const j = template.indexOf(target.end, i + target.start.length);
    if (j < 0) return null;
    if (template.slice(i, j) === target.replace) return { status: "already" };
    return { status: "applied", text: template.slice(0, i) + target.replace + template.slice(j) };
  }
  return null;
}

function applyInstructionPatch(template, patch) {
  if (typeof template !== "string" || template.length === 0) {
    return { status: "missing_target", text: template };
  }
  // 该模板不涉及此结构：版本差异，不是漂移
  if (patch.probe && !template.includes(patch.probe)) {
    return { status: "not_applicable", text: template };
  }
  let text = template;
  let hit = null;
  for (const target of patch.targets || []) {
    const r = applyTarget(text, target);
    if (!r) continue;
    hit = r;
    if (r.text) text = r.text;
    if (r.status === "applied") break;
  }
  if (!hit) return { status: "missing", text: template };
  return { status: hit.status, text };
}

// 从源 catalog 派生 override catalog，返回 { catalog, perModel, summary }
export function deriveCatalog(sourceCatalog) {
  const catalog = structuredClone(sourceCatalog);
  const models = modelsOf(catalog);
  const perModel = [];

  for (const model of models) {
    const slug = model.slug || model.model || "(unnamed)";
    const mm = model.model_messages;
    const statuses = {};

    for (const patch of INSTRUCTION_PATCHES) {
      if (!mm) {
        statuses[patch.id] = "no_model_messages";
        continue;
      }
      const r = applyInstructionPatch(mm.instructions_template, patch);
      statuses[patch.id] = r.status;
      if (r.status === "applied") mm.instructions_template = r.text;
    }

    for (const patch of MESSAGE_PATCHES) {
      if (!mm) {
        statuses[patch.id] = "no_model_messages";
        continue;
      }
      const current = getPath(mm, patch.path);
      const target = typeof patch.value === "function" ? patch.value(current) : patch.value;
      if (JSON.stringify(current) === JSON.stringify(target)) {
        statuses[patch.id] = "already";
      } else {
        setPath(mm, patch.path, target);
        statuses[patch.id] = "applied";
      }
    }

    perModel.push({ slug, statuses });
  }

  const summary = {};
  for (const patch of ALL_PATCHES) {
    const counts = {};
    for (const m of perModel) {
      const s = m.statuses[patch.id] || "skipped";
      counts[s] = (counts[s] || 0) + 1;
    }
    summary[patch.id] = counts;
  }

  return { catalog, perModel, summary };
}

// 把 patch 的原始值抓出来，供回滚与状态展示使用
export function captureOriginals(sourceCatalog) {
  const models = modelsOf(sourceCatalog);
  const out = [];
  for (const model of models) {
    const mm = model.model_messages;
    if (!mm) continue;
    const record = { slug: model.slug || model.model || "(unnamed)", template: null, fields: [] };
    if (typeof mm.instructions_template === "string") record.template = mm.instructions_template;
    for (const patch of MESSAGE_PATCHES) {
      const current = getPath(mm, patch.path);
      if (current !== undefined) record.fields.push({ id: patch.id, path: patch.path, value: current });
    }
    out.push(record);
  }
  return out;
}

export function overallStatus(summary) {
  let applied = 0;
  let pending = 0;
  let notApplicable = 0;
  for (const patch of ALL_PATCHES) {
    const counts = summary[patch.id] || {};
    applied += (counts.applied || 0) + (counts.already || 0);
    pending += counts.missing || 0;
    notApplicable += counts.not_applicable || 0;
  }
  return { applied, pending, notApplicable };
}
