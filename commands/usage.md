---
description: Show Antigravity (agy) quota per model group and which model each role would get now
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" usage`

Show the output as-is (a Markdown table plus one line per role). No extra prose.
