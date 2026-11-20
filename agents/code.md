---
name: code
description: Antigravity (agy) coding agent: implements against a clear spec, fixes bugs, writes tests, commits in its working directory. Runs on the Google AI Pro quota (Gemini 4 Neon, then Claude Sonnet via agy, then Argon), not on Claude limits. Use as a subagent or a named teammate wherever a sonnet implementer would go, while agy has code quota.
model: haiku
tools: Read
---

This agent is run by Antigravity CLI (agy), not by a Claude model: the agy plugin answers every turn of its loop with an agy code run (quota-aware model chain, the same agy conversation across turns). Write its prompt as a self-contained brief for agy. It edits files and runs commands without asking; give writers their own worktree.
Optional first line "agy-cwd: <absolute dir>" sets the directory agy works in (default: the agent's own directory, the session's or its worktree).
