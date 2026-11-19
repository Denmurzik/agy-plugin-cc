# agy-plugin-cc — Antigravity CLI inside Claude Code

Use [Antigravity CLI](https://antigravity.google) (`agy`) from Claude Code as a **peer worker**: a one-shot subagent, or a **named teammate** you can message again — on your Google AI subscription quota instead of your Claude limits.

- **Quota-aware.** Before every call it reads `agy /usage` (free, 0 tokens) and walks a model chain, skipping any model whose quota group is below 5 %. A quota error mid-session switches to the next model **in the same conversation**. When every model of a role is out, it returns `QUOTA_EXHAUSTED` with the reset time and does not call agy until then.
- **Two roles.** `code` (writes files, commits) and `review` (read-only, `--mode plan`). Recon is intentionally not delegated.
- **Resumable sessions.** `name → conversation_id` registry; follow-ups continue the same agy conversation.
- **Background jobs** with status / wait / result / cancel; a 30-minute hard timeout.
- **Transient-error recovery.** Network drops (`EOF`, "network issue") and malformed function calls are retried automatically in the same conversation with a "continue where you stopped" turn (3 tries, 15/45/90 s; `AGY_RETRY_DELAYS`). An error after agy already gave its final `STATUS:` answer counts as done with a warning. A failed job reports the error kind, whether agy changed the workspace (new commits / dirty files) and agy's last text. agy's own log per job: `~/.claude/agy/jobs/<job>.agy.log`.
- **Teammate proxy.** `agy:agy-proxy` (a haiku relay) makes agy a regular named member of a Claude Code agent team.
- Runs agy with `--dangerously-skip-permissions` — agy executes commands without asking. Give it a git worktree for writing work.

## Requirements

- Claude Code with plugin support; Node.js 18+.
- `agy` on `PATH`, logged in (`agy` once interactively). Check: `agy -p /usage --output-format json`.
  In Git Bash use `MSYS_NO_PATHCONV=1` for that manual check.

## Install

```
/plugin marketplace add Denmurzik/agy-plugin-cc
/plugin install agy@agy-plugin-cc
```
Restart Claude Code. A SessionStart hook writes the stable entry point `~/.claude/agy/agy-companion.mjs`.

## Use

| Command | What it does |
|---|---|
| `/agy:usage` | Quota per group and the model each role would get now |
| `/agy:run [--role code\|review] [--name N] [--background] <task>` | Hand a task to agy (one-shot or a named session) |
| `/agy:ask <name> <message>` | Follow-up in a named session |
| `/agy:status [job]`, `/agy:result <job>`, `/agy:cancel [job]` | Jobs |

The `agy:antigravity` skill lets Claude delegate to agy on its own when a self-contained code or review task fits.

As a teammate: spawn `subagent_type: "agy:agy-proxy"` with a `name`; the prompt starts with
```
agy-name: agy-impl-1
agy-role: code
agy-cwd: /abs/path/to/worktree
---
<self-contained task>
```
then `SendMessage` to it for follow-ups.

CLI (what everything above calls):
```
node ~/.claude/agy/agy-companion.mjs run --role code --cwd . --prompt-file task.md
node ~/.claude/agy/agy-companion.mjs ask agy-impl-1 "fix the failing test"
node ~/.claude/agy/agy-companion.mjs usage | pick code | status | wait <job> | result <job> | cancel <job> | sessions
```
Exit code 4 = `QUOTA_EXHAUSTED`.

## Model chains

Defaults (Google AI Pro, agy 1.5.x model ids — see `agy models`):

| Role | Chain |
|---|---|
| `code` | gemini-4-neon-medium → claude-sonnet-5-5-medium → gemini-4-argon-medium |
| `review` | gemini-4-argon-medium |

Override in `~/.claude/agy/config.json`:
```json
{ "threshold": 0.05, "chains": { "code": ["gemini-4-neon-high", "gemini-3.8-flash-high"], "review": ["gemini-4-argon-high"] } }
```
Quota groups are inferred from the model id: `gemini-4-argon*` → Argon, other `gemini*` → Gemini, everything else → Claude/GPT.

Env: `AGY_BIN` (agy binary), `AGY_STATE_DIR` (default `~/.claude/agy`), `AGY_QUOTA_THRESHOLD`, `AGY_USAGE_TTL_MS` (usage cache, default 60000).

## Tests

`node --test` (from the repo root) — runs against a fake agy (`tests/fake-agy.mjs`), no quota used.

## License

MIT
