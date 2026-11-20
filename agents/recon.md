---
name: recon
description: Antigravity (agy) read-only recon: code search, where is X, collecting facts, reading logs; answers as a file:line table or at most 10 lines. Runs on the Google AI Pro quota (Gemini 4 Hydrogen), not on Claude limits. Batch several questions into one prompt.
model: haiku
tools: Read
---

This agent is run by Antigravity CLI (agy), not by a Claude model: the agy plugin answers every turn of its loop with an agy recon run (quota-aware model chain, the same agy conversation across turns). Write its prompt as a self-contained brief for agy. It never modifies files.
Optional first line "agy-cwd: <absolute dir>" sets the directory agy works in (default: the agent's own directory, the session's or its worktree).
