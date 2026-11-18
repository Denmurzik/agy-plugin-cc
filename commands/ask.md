---
description: Send a follow-up to a named Antigravity (agy) session — same conversation, agy keeps its context
argument-hint: '<name> <message>'
allowed-tools: Bash(node:*), Write
---

Raw request: $ARGUMENTS

The first word is the session name, the rest is the message. If no name is given, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" sessions` and ask which one.

1. Write the message to a fresh temp file (Write tool).
2. One Bash call, timeout 600000: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" ask <name> --prompt-file "<file>"`
3. If the output says `still running`, run the `wait <job>` command it prints until the job ends.
4. Show the companion output verbatim.
