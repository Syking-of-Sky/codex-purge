#!/usr/bin/env node

import * as core from "../lib/index.js";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

function line(mark, text) {
  console.log(`  ${mark} ${text}`);
}

async function main() {
  if (has("--help") || has("-h")) {
    console.log(`codex-purge — 接管 Codex 的指令与安全权重（可逆）

用法：
  codex-purge --status      查看 patch 命中情况与接线状态
  codex-purge --apply       派生 override catalog、接线 config.toml、写入状态
  codex-purge --revert      解除接线并归档 override（其余配置不动）
  codex-purge --verify      只用 codex 自省命令验证当前是否生效
  codex-purge --uninstall   回滚并删除 override 文件
  codex-purge --help        帮助

可选：
  --no-verify     apply 后跳过 codex doctor / debug models 验证
  CODEX_HOME=...  指定 Codex 主目录（默认 ~/.codex）
  CODEX_PURGE_CODEX=/path/to/codex  指定 codex 可执行文件`);
    return;
  }

  if (has("--verify")) {
    const s = await core.gatherState();
    const p = core.paths();
    console.log("codex-purge 验证 / Verify");
    console.log("");
    for (const c of core.verifyFiles(p).checks) line(c.ok ? "✓" : "✗", `${c.name} — ${c.detail}`);
    for (const c of core.verifyLive(p, process.env)) line(c.ok ? "✓" : "✗", `${c.name} — ${c.detail}`);
    console.log("");
    console.log(`  接线：${s.wired || "未设置"}`);
    return;
  }

  if (has("--apply")) {
    const s = await core.gatherState();
    console.log(core.formatStatus(s));
    console.log("");
    let result;
    try {
      result = await core.apply({ verify: !has("--no-verify") });
    } catch (e) {
      console.error(`[ERROR] ${e.message}`);
      process.exit(1);
    }
    for (const l of result.logs) line("✓", l);
    console.log("");
    for (const [id, status] of Object.entries(result.state.patches)) {
      const patch = core.ALL_PATCHES.find((x) => String(x.id) === String(id));
      const mark = status === "applied" ? "✓" : status === "already" ? "-" : "!";
      const label = status === "applied" ? "已清洗" : status === "already" ? "已是最新" : "锚点漂移";
      line(mark, `patch #${id} ${patch ? patch.name : ""} — ${label}`);
    }
    if (result.checks.length) {
      console.log("");
      console.log("  验证 / verify");
      for (const c of result.checks) line(c.ok ? "✓" : "✗", `${c.name} — ${c.detail}`);
    }
    console.log("");
    console.log("完成。重启 Codex（CLI 或桌面端）后生效 / restart Codex to take effect.");
    return;
  }

  if (has("--revert")) {
    const { logs, backup } = await core.revert();
    console.log("codex-purge 回滚 / Revert");
    for (const l of logs) line("✓", l);
    if (backup) line("-", `最近备份仍保留：${backup}`);
    console.log("");
    console.log("回滚完成。重启 Codex 后恢复原行为 / restart Codex to restore.");
    return;
  }

  if (has("--uninstall")) {
    const { logs } = await core.uninstall();
    console.log("codex-purge 卸载 / Uninstall");
    for (const l of logs) line("✓", l);
    console.log("");
    console.log("已回滚并清理 override。备份目录保留，可手动删除。");
    return;
  }

  const s = await core.gatherState();
  console.log(core.formatStatus(s));
  console.log("");
  console.log("默认只读。使用 --apply 应用清洗。");
}

main().catch((e) => {
  console.error("[codex-purge] error:", e && e.stack ? e.stack : e);
  process.exit(1);
});
