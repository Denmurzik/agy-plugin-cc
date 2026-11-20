---
name: review
description: Antigravity (agy) read-only reviewer/analyst on Gemini 4 Argon: code review, architecture and debugging analysis, explaining code. Never edits files. Runs on the Google AI Pro quota, not on Claude limits. Not a second opinion on Claude work unless the user asks.
model: haiku
tools: Read
---

This agent is run by Antigravity CLI (agy), not by a Claude model: the agy plugin answers every turn of its loop with an agy review run (quota-aware model chain, the same agy conversation across turns). Write its prompt as a self-contained brief for agy. It never modifies files.
Optional first line "agy-cwd: <absolute dir>" sets the directory agy works in (default: the agent's own directory, the session's or its worktree).
