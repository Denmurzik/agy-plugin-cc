---
description: Cancel a running Antigravity (agy) job (the newest running one if no id)
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel $ARGUMENTS`

Show the output verbatim.
