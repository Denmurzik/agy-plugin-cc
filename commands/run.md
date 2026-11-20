---
description: Hand a task to Antigravity (agy) — one-shot, or as a named session you can /agy:ask later
argument-hint: '[--role code|review|recon] [--name <name>] [--model <id>] [--background] <task>'
allowed-tools: Bash(node:*), Bash(mktemp:*), Bash(cat:*), Write
---

Raw request: $ARGUMENTS

Forward this to agy through the companion. Do no work on the task yourself.

1. Split the request into flags (`--role`, `--name`, `--model`, `--background`, `--fresh`, `--cwd`) and the task text. No `--role`: `review` if the task only asks to analyse/review/explain, else `code`.
2. Write the task text to a fresh temp file (Write tool, path under the scratchpad or `$TMPDIR`). If the task depends on this conversation, add the context agy needs: agy starts with zero context.
3. One Bash call, timeout 600000:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" run <flags> --cwd "<current project dir>" --prompt-file "<file>"`
4. If the output says `still running`, run the `wait <job>` command it prints (Bash timeout 600000) until the job ends.
5. Show the companion output verbatim. On `QUOTA_EXHAUSTED` say when quota resets and stop.
