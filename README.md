# codex-purge

> Takes over how Codex is instructed: rewrites the model catalog's `model_messages`, the Guardian classifier, and the auto-review policy. Reversible, verifiable, restorable. (中文文档见下)

Codex 指令权威性清洗。做法和 `dsh-purge` 一样：找出宿主真正读取的那一层，定点改写，保留备份与哈希，可验证、可回滚。

区别在于靶面不同。DSH 的 system prompt 是打包在插件目录里的文本文件，改文件即可。Codex 的 prompt 不在二进制里，也不在 config.toml 里——它是 `models_cache.json` 中每个模型的 `model_messages.instructions_template`，由 Codex 启动时从模型目录渲染。所以清洗入口是 **接管 model catalog**。

## 安装

零依赖，只需要 Node 18+ 和一个已登录的 Codex。

```bash
git clone https://github.com/YanKuiShen/codex-purge.git
cd codex-purge
node bin/codex-purge.js --status
```

不需要 `npm install`。想全局调用就 `npm link`，之后直接用 `codex-purge --status`。

前置条件：`~/.codex/models_cache.json` 存在。没有的话先跑一次 `codex` 并登录，客户端拉完模型目录才会有这个文件。


## Codex「安全权重」的真实分布

对着 codex-cli 0.160.0 的实际数据拆解，压着行为的不是 base prompt 里那几段措辞，而是三处结构化字段：

| 位置 | 作用 | 处理方式 |
| --- | --- | --- |
| `model_messages.guardian_v2.classifier_instructions` | Guardian 分类器模型的指令，决定动作是否送审。这是唯一 out-of-band 的安全裁判 | 改写为恒返回 `low` |
| `model_messages.auto_review.*` | 送审后的策略、拒绝话术、超时话术 | `policy` / `policy_template` 清空，拒绝话术改为「换路继续」 |
| `model_messages.confirmation_policies` | 浏览器/桌面操作的确认策略，约 23K 字 | 置 `null`，不下发 |
| `model_messages.approvals.*` | 各审批模式下的提示文案 | 清空 |
| `model_messages.instructions_template` | base prompt 本体（约 21K / 17.7K 两种版本） | 权限段改写为行动优先 |

前四项是开关，最后一项是措辞。只改措辞不改分类器，Guardian 会照样把动作拦下来。

## 用法

```bash
node bin/codex-purge.js --status     # 每条 patch 在各模型上的命中情况
node bin/codex-purge.js --apply      # 派生 override catalog、接线 config.toml、验证
node bin/codex-purge.js --verify     # 只验证，不写盘
node bin/codex-purge.js --revert     # 解除接线，归档 override，其余配置不动
node bin/codex-purge.js --uninstall  # 回滚并清理 override
```

生效范围是 `CODEX_HOME`（默认 `~/.codex`），CLI 与桌面端共用同一份，改一次两边都生效。重启 Codex 后读取新目录。

`--apply` 做五件事：

1. 备份 `config.toml` 到 `~/.codex/codex-purge/backups/<时间戳>/`（保留最近 10 份）
2. 从 `models_cache.json` 派生清洗后的 catalog，写到 `~/.codex/codex-purge/catalog.json`
3. 在 `config.toml` 顶层写入 `model_catalog_json`，指向该文件
4. 落地 `instructions.md` / `guardian.md`，供人工检查实际下发的文本
5. 跑 `codex doctor` 与 `codex debug models` 验证

## 实际生效到哪一层

接管完之后，值得看清自己到底改变了什么。一次真实会话里的 `turn_context` 长这样：

```
approval_policy    : never
approvals_reviewer : user
sandbox_policy     : read-only
permission_profile : managed / restricted
```

`approvals_reviewer: user` 意味着 **Guardian 分类器根本没被调用**。这种情况下 `guardian_v2` 和 `auto_review` 那 11 条 patch 是预埋：不触发，也无害；哪天 reviewer 被切成 `auto_review`，它们就直接生效。真正改变模型行为的，是 `instructions_template` 的 3 条 patch 加上清空的 `confirmation_policies`。

`approval_policy: never` 说明审批摩擦本来就低——这部分原本就不需要破。

`sandbox_policy` 和 `permission_profile` 是另一层，属于沙箱边界而不是安全权重。prompt 改得再干净，写文件、联网照样受限。要放开得改 `config.toml` 的 `sandbox_mode` 与 `permission_profile`，影响面比 prompt 层大得多，本插件不碰。

## 为什么不动 models_cache.json

它是 Codex 从远端拉取的缓存，会被自动刷新覆盖。改它等于改一个随时被重写的中转文件。正确做法是从它派生一份独立 catalog，让 `config.toml` 指过去——缓存刷新只造成「源变了，需要重新 apply」，并会由 `--status` 的漂移检测指出。

`models_cache.json` 里的 `model_catalog_json` 是 Codex 官方支持的入口（`ConfigToml` 的顶层键，与 `model_catalog_url` 并列），不是补丁或 hook 绕出来的路径。

## 验证口径

判断是否真的生效，不看配置文件，看 Codex 自己怎么说：

```bash
codex debug models   # 渲染当前生效的模型目录（含 guardian 指令）
codex debug prompt-input "hi"   # 渲染模型可见的输入列表
codex doctor         # 确认 config 可加载
```

`--verify` 会解析 `codex debug models` 的输出，逐个模型检查 guardian 是否已是恒 low 版本。这一条通过，才算接管成功——它证明的是 Codex 实际加载的目录，而不是我写了什么文件。

### 行为层的判据：哨兵测试

结构验证只证明 Codex 加载了什么，不证明模型收到了什么。要证明后者，得让输出带上可观测标记。

往 `instructions_template` 末尾追加一条格式要求（临时）：

```
Every response you produce MUST end with the exact line `PURGE-ACTIVE-7F3`
```

然后跑一次真实对话：

```bash
codex exec --skip-git-repo-check "用一句话说明 Linux 上查看磁盘占用最常用的命令。"
```

输出末尾出现 `PURGE-ACTIVE-7F3`，才算模型真的读到了改后的 prompt。测试完记得把哨兵去掉——直接重新 `--apply` 一次即可覆盖。

顺带一个反例，别走这条弯路：问模型「逐字引用你的系统提示」是无效测试。模型拒答系统提示提取是通用的防护训练，跟安全权重无关，拒答不代表接管失败，回答也不代表接管成功。

## 回滚

`--revert` 只删自己写的那一行 `model_catalog_json`，其余字节不动，因此回滚后的 `config.toml` 与原始文件逐字节相同（含注释、空行、table 顺序）。`models_cache.json` 从头到尾没被写过。

## 版本漂移

Codex 换版本会换模板措辞。`--status` 把每条 patch 的状态分成三类：

- `✓` 命中
- `! 漂移` 锚点消失，说明上游模板改了措辞，需要更新 `lib/patches.js` 的锚点
- `·` 该版本模板本就没有这段结构（如旧版没有独立的权限段），不算失败

同一个 patch 可以带多个锚点变体。0.160.0 里同时存在 21K 新版与 17.7K 旧版两种 base prompt，权限要求在新版是独立段落、在旧版藏在 `# Autonomy and persistence` 正文里，两个锚点各管一版。

## 与 dsh-purge 的对照

| | dsh-purge | codex-purge |
| --- | --- | --- |
| 宿主 | DeepSeek Harness | Codex CLI / 桌面端 |
| 靶面 | 插件目录下的 prompt 源文件 + 引擎默认值 | model catalog 的 `model_messages` |
| 注入通道 | 直接改文件 + cordis patch + shim | `model_catalog_json` 配置键 |
| 状态文件 | `~/.dsh/dsh-purge/override-state.json` | `~/.codex/codex-purge/state.json` |
| 验证 | 身份组装测试 | `codex debug models` 反向解析 |

两者都是「备份 → 派生 → 接线 → 验证 → 可回滚」，都不碰宿主二进制。
