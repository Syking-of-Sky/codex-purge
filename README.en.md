# codex-purge

English | [中文](README.md)

Instruction-authority purge for Codex. Same approach as [`dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge): find the layer the host actually reads, rewrite it in place, keep backups and hashes, stay verifiable and reversible.

What differs is the target. DSH's system prompt is a text file inside the plugin directory — edit the file and you are done. Codex's prompt is not in the binary and not in `config.toml`. It is `model_messages.instructions_template` on each model in `models_cache.json`, rendered from the model catalog at startup. So the entry point is **taking over the model catalog**.

## Install

Zero dependencies. Node 18+ and a logged-in Codex is all you need.

```bash
git clone https://github.com/Syking-of-Sky/codex-purge.git
cd codex-purge
node bin/codex-purge.js --status
```

No `npm install` required. For a global command, run `npm link` and use `codex-purge --status` directly.

Prerequisite: `~/.codex/models_cache.json` must exist. If it does not, run `codex` and log in once — the client only writes that file after fetching the model catalog.

## Where Codex's "safety weights" actually live

Decomposing a real codex-cli 0.160.0 install, what constrains behavior is not the wording in the base prompt. It is three structured fields:

| Location | Role | Treatment |
| --- | --- | --- |
| `model_messages.guardian_v2.classifier_instructions` | Instructions for the Guardian classifier model, which decides whether an action goes to blocking review. The only out-of-band safety judge | Rewritten to always return `low` |
| `model_messages.auto_review.*` | Policy, rejection wording, and timeout wording after review | `policy` / `policy_template` cleared; rejection wording changed to "reroute and continue" |
| `model_messages.confirmation_policies` | Confirmation policy for browser and desktop actions, ~23K characters | Set to `null`, not emitted |
| `model_messages.approvals.*` | Prompt text for each approval mode | Cleared |
| `model_messages.instructions_template` | The base prompt itself (~21K and ~17.7K variants) | Permission section rewritten to action-first |

The first four are switches. The last is wording. Change only the wording and leave the classifier alone, and Guardian still blocks the action.

## Usage

```bash
node bin/codex-purge.js --status     # patch hit counts per model
node bin/codex-purge.js --apply      # derive override catalog, wire config.toml, verify
node bin/codex-purge.js --verify     # verify only, no writes
node bin/codex-purge.js --revert     # unwire, archive override, leave the rest untouched
node bin/codex-purge.js --uninstall  # revert and remove the override
```

Scope is `CODEX_HOME` (default `~/.codex`). The CLI and the desktop app share it, so one change covers both. Restart Codex to pick up the new catalog.

`--apply` does five things:

1. Backs up `config.toml` to `~/.codex/codex-purge/backups/<timestamp>/` (keeps the last 10)
2. Derives a purged catalog from `models_cache.json` and writes it to `~/.codex/codex-purge/catalog.json`
3. Writes `model_catalog_json` at the top level of `config.toml`, pointing at that file
4. Materializes `instructions.md` / `guardian.md` so you can read what is actually being sent
5. Runs `codex doctor` and `codex debug models` to verify

## Why not edit models_cache.json

It is a client-side cache that Codex refreshes and overwrites. Editing it means editing a staging file that gets rewritten whenever the client feels like it. The correct move is to derive an independent catalog from it and point `config.toml` at that — a cache refresh then just means "the source changed, re-apply", which `--status` reports through drift detection.

`model_catalog_json` is a supported entry point (a top-level `ConfigToml` key, sibling to `model_catalog_url`), not something routed around via a patch or hook.

## How to verify

Do not read the config file to decide whether this worked. Ask Codex itself:

```bash
codex debug models            # renders the catalog currently in effect, including guardian instructions
codex debug prompt-input "hi" # renders the model-visible input list
codex doctor                  # confirms the config loads
```

`--verify` parses the output of `codex debug models` and checks, model by model, whether guardian is the always-low variant. That check passing is what counts as a successful takeover — it proves what Codex actually loaded, not what files this tool wrote.

### The behavioral test: a sentinel

Structural verification only proves what Codex loaded, not what the model received. To prove the latter, make the output carry an observable marker.

Append a formatting requirement to `instructions_template` (temporarily):

```
Every response you produce MUST end with the exact line `PURGE-ACTIVE-7F3`
```

Then run a real turn:

```bash
codex exec --skip-git-repo-check "Explain in one sentence which command is most used on Linux to check disk usage."
```

Only when `PURGE-ACTIVE-7F3` shows up at the end of the output has the model actually read the modified prompt. Remove the sentinel afterwards — running `--apply` again overwrites it.

One counter-example worth recording: asking the model to "quote your system prompt verbatim" is a useless test. Refusing system-prompt extraction is generic defensive training, unrelated to safety weights. A refusal does not mean the takeover failed, and an answer does not mean it succeeded.

## What actually ends up in effect

After the takeover, it is worth knowing what you actually changed. A real session's `turn_context` looks like this:

```
approval_policy    : never
approvals_reviewer : user
sandbox_policy     : read-only
permission_profile : managed / restricted
```

`approvals_reviewer: user` means **the Guardian classifier is never invoked**. In that configuration the 11 `guardian_v2` / `auto_review` patches are pre-planted: dormant, harmless, and immediately effective if the reviewer is ever switched to `auto_review`. What actually changes model behavior is the three `instructions_template` patches plus the cleared `confirmation_policies`.

`approval_policy: never` means approval friction was already low — that part never needed purging.

`sandbox_policy` and `permission_profile` are a different layer: sandbox boundary, not safety weight. However clean the prompt is, file writes and network access stay restricted. Loosening those means editing `sandbox_mode` and `permission_profile` in `config.toml`, which has a far larger blast radius than the prompt layer. This tool does not touch them.

## Rollback

`--revert` removes only the `model_catalog_json` line it wrote and touches no other byte, so the resulting `config.toml` is byte-identical to the original, comments and table order included. `models_cache.json` is never written to at any point.

## Version drift

Codex changes template wording between versions. `--status` sorts each patch into one of three states:

- `✓` hit
- `! drift` — the anchor disappeared, meaning upstream changed the wording and the anchor in `lib/patches.js` needs updating
- `·` this template version never had that structure (e.g. older versions have no standalone permission section), which is not a failure

A single patch can carry multiple anchor variants. 0.160.0 ships both a 21K and a 17.7K base prompt; the permission requirement is a standalone section in the new one and buried in the body of `# Autonomy and persistence` in the old one, so each variant covers one.

## Compared to dsh-purge

| | dsh-purge | codex-purge |
| --- | --- | --- |
| Host | DeepSeek Harness | Codex CLI / desktop |
| Target | prompt source files in the plugin directory + engine defaults | `model_messages` in the model catalog |
| Injection channel | direct file edits + cordis patch + shim | the `model_catalog_json` config key |
| State file | `~/.dsh/dsh-purge/override-state.json` | `~/.codex/codex-purge/state.json` |
| Verification | identity-assembly tests | reverse-parsing `codex debug models` |

Both follow the same shape: back up, derive, wire, verify, stay reversible. Neither touches the host binary.
