---
description: Show active and recent Antigravity (agy) jobs, or one job in full
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status $ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" sessions`

Show both outputs as-is. No extra prose.
