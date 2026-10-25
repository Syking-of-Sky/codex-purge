// config.toml 的外科式编辑：只动顶层键，保留全部注释、空行、table 段与键序。
// Codex 的 ConfigToml 把顶层键与 [table] 分开解析，一旦进入 table 段，
// 后面的裸键就属于该 table。因此所有顶层写入都必须落在第一个 table 头之前。

const TABLE_RE = /^\s*\[/;

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function keyLineRegex(key) {
  // 只匹配行首（无缩进也算）的 `key =`，且 key 前不能有别的字符
  return new RegExp(`^(\\s*)(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(\\s*=\\s*)(.*)$`);
}

function splitTrailingComment(rest) {
  // 基本字符串内部的 # 不算注释
  let inStr = false;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === '"' && rest[i - 1] !== "\\") inStr = !inStr;
    else if (ch === "#" && !inStr) {
      return { value: rest.slice(0, i).trimEnd(), comment: rest.slice(i) };
    }
  }
  return { value: rest.trimEnd(), comment: "" };
}

export function headerEnd(lines) {
  // 返回第一个 table 头的行下标；没有 table 时返回 lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (TABLE_RE.test(lines[i])) return i;
  }
  return lines.length;
}

export function getTopLevel(text, key) {
  const lines = text.split("\n");
  const end = headerEnd(lines);
  const re = keyLineRegex(key);
  for (let i = 0; i < end; i += 1) {
    const m = re.exec(lines[i]);
    if (m) {
      const { value } = splitTrailingComment(m[4]);
      return { line: i, value: value.trim(), raw: lines[i] };
    }
  }
  return null;
}

export function setTopLevel(text, key, value) {
  const serialized = tomlString(value);
  const lines = text.split("\n");
  const end = headerEnd(lines);
  const re = keyLineRegex(key);

  for (let i = 0; i < end; i += 1) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const prev = lines[i];
    const { comment } = splitTrailingComment(m[4]);
    lines[i] = `${m[1]}${m[2]}${m[3]}${serialized}${comment ? " " + comment : ""}`;
    return { text: lines.join("\n"), changed: lines[i] !== prev, existed: true };
  }

  // 不存在：插到 table 段之前的最后一行非空内容之后，保持视觉整齐
  let insertAt = end;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, `${key} = ${serialized}`);
  return { text: lines.join("\n"), changed: true, existed: false };
}

export function unsetTopLevel(text, key) {
  const lines = text.split("\n");
  const end = headerEnd(lines);
  const re = keyLineRegex(key);
  for (let i = 0; i < end; i += 1) {
    if (re.test(lines[i])) {
      const removed = lines.splice(i, 1)[0];
      return { text: lines.join("\n"), changed: true, removed };
    }
  }
  return { text, changed: false, removed: null };
}

export function topLevelString(text, key) {
  const hit = getTopLevel(text, key);
  if (!hit) return null;
  const v = hit.value;
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}
