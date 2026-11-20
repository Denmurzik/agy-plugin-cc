---
name: antigravity
description: Delegate coding, review/analysis or recon (code search, fact-finding) work to Antigravity CLI (agy, Gemini 4 Neon/Argon + Claude via Google AI Pro quota) as a peer worker — one-shot or as a named, resumable teammate — with quota-aware model fallback. Use proactively whenever a self-contained code task or review/analysis could run on agy instead of a Claude subagent and agy still has quota; also when the user mentions agy/Antigravity/Gemini as a worker or asks for a second opinion from agy. Recon goes to agy too when it is a real survey (several questions batched into one task); a single grep you can run yourself stays local.
---

# Antigravity (agy) as a peer worker

agy is a full coding agent on a separate subscription quota (Google AI Pro). Treat it as an **equal** of a Claude subagent, not as a reviewer of Claude's work. Prefer it for delegable work while it has quota: that saves the user's Claude limits.

Companion: `C="$HOME/.claude/agy/agy-companion.mjs"` — always `node "$C" …`.

## What goes to agy

Default chains below; the user may override them in `~/.claude/agy/config.json` (`node "$C" usage` shows what each role gets now).

| Work | agy role | Model chain (auto) |
|---|---|---|
| Implementation against a clear spec, bugfix, tests, mechanical multi-file change | `code` | gemini-4-neon-medium → claude-sonnet-5-5-medium → gemini-4-argon-medium |
| Review, analysis, architecture/debug reasoning, explaining code (read-only) | `review` (`--mode plan`) | gemini-4-argon-medium only |
| Recon: code search, "where is X", collecting facts, reading logs (read-only, answer as `file:line` table / ≤10 lines) | `recon` (`--mode plan`) | gemini-4-hydrogen-medium → claude-sonnet-5-5-low |

Never to agy:
- **One-line recon** you can answer with a single grep yourself — an agy call costs ≥12k tokens and ~10 s; batch recon questions into one `recon` task instead.
- **Second opinion** on work already done — only when the user explicitly asks for agy's opinion.
- Small edits (1–2 lines), work that hinges on decisions made in this conversation, final acceptance/verification — those stay with Claude.
- Tiny tasks: every agy call costs ≥12k input tokens of its own system prompt. Batch small things into one task.

## Quota

Before routing, `node "$C" pick code` / `pick review` (≈5 s, 0 tokens): prints a model, or `QUOTA_EXHAUSTED <reset>` with exit 4. Exhausted → do the work with a Claude agent and do not try agy for that role until the reset time. `node "$C" usage` shows the full table. The companion falls back along the chain by itself, also mid-session (same conversation, next model).

## How to call

**One-shot** (you need one answer back): write the task to a temp file, then one Bash call (timeout 600000):
`node "$C" run --role code|review|recon --cwd "<project dir>" --prompt-file "<file>"`
It waits up to 9 min; if it prints `still running`, call the printed `wait <job>` again. Use `--background` and later `wait` to run it beside other work.

**Teammate** (you will send follow-ups, or it works beside other teammates): put agy on this session's agent team — one Bash call, no `Agent` spawn:
```
node "$C" team spawn --name agy-impl-3 --role code|review|recon --cwd "<abs dir — a worktree for code in git repos>" [--task <task-list id>] --prompt-file "<task file>"
```
It is then a real member: `ListAgents` shows it, `SendMessage` to its name reaches it (same agy conversation), its report arrives by itself as a message from it. agy gets team tools (MCP server `claude-team`): it can ask you a blocking question (`QUESTION (I am blocked…` — answer with `SendMessage`), message peers, read new messages mid-turn, update its task. Stop: `SendMessage` `{type: "shutdown_request"}` or `node "$C" team stop <name>`; `node "$C" team ls` shows what each agy teammate is doing.
The lead only polls its inbox while a Claude teammate exists — if `team spawn` warns about it, spawn `Agent({ name: "agy-hub", subagent_type: "agy:agy-hub", model: "haiku", prompt: "hold" })` once.

**Resumable without a team:** `node "$C" run --name <n> …`, then `node "$C" ask <n> --prompt-file F` (or `/agy:ask`). The `agy:agy-proxy` agent is the legacy relay for setups where the native team mode is unavailable.

## Writing the task for agy

agy knows nothing about this conversation and cannot use Claude Code tools (no TaskList, SendMessage, skills). The task must stand alone:
- goal in one line; exact paths it owns (everything else read-only); constraints that apply;
- what "done" looks like and the command that verifies it;
- for `code` in a git repo: "Commit your work on the current branch with a plain message, no co-author trailers";
- a report file path for anything long; the final answer ≤15 lines: `STATUS: DONE | DONE_WITH_CONCERNS | BLOCKED`, commits, test result, concerns;
- shell rules: never start servers/watchers/interactive prompts; give long commands a timeout.

## Writers and isolation

- In a git repo a writing agy gets its own worktree (teamlead `wt add`, or `git worktree add`) as `--cwd`; it commits there; you review and land it.
- Outside git: name the files it owns; nothing else may write them meanwhile.
- At most 2 writing agy sessions at once.

## After agy reports

agy's report is a claim, not proof: check the diff/commits and run the verification yourself (or have a Claude reviewer do it) before calling the work done. `node "$C" status` lists jobs, `result <job>` the full answer, `cancel <job>` stops one. Slash commands: `/agy:run`, `/agy:ask`, `/agy:status`, `/agy:result`, `/agy:cancel`, `/agy:usage`.
