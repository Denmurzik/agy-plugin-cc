// Claude Code agent-team file protocol (teams/<team>/config.json, inboxes/<name>.json, tasks/<team>/<id>.json).
// Lets a non-Claude process (agy) be a real team member: it shows in ListAgents, SendMessage reaches it,
// and its messages land in the lead's inbox. Locks are compatible with proper-lockfile (mkdir "<file>.lock").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLAUDE_DIR = process.env.AGY_CLAUDE_DIR || path.join(os.homedir(), '.claude');
export const LEAD = 'team-lead';
const teamsDir = () => path.join(CLAUDE_DIR, 'teams');
export const teamDir = (team) => path.join(teamsDir(), team);
export const configPath = (team) => path.join(teamDir(team), 'config.json');
export const inboxPath = (team, name) => path.join(teamDir(team), 'inboxes', name + '.json');
export const tasksDir = (team) => path.join(CLAUDE_DIR, 'tasks', team);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function readJson(f, d = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeAtomic(f, v) {
  const tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  for (let i = 0; ; i++) { try { fs.renameSync(tmp, f); return; } catch (e) { if (i > 200) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; } sleepSync(25); } }
}
export function withFileLock(file, fn) {
  const lock = file + '.lock';
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code === 'ENOENT') { fs.mkdirSync(path.dirname(file), { recursive: true }); continue; }
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() - t0 > 15_000) throw new Error('lock timeout: ' + lock);
      sleepSync(20 + Math.random() * 30);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

export function sessionTeam(sessionId = process.env.CLAUDE_CODE_SESSION_ID) {
  return sessionId ? 'session-' + sessionId.replace(/-/g, '').slice(0, 8) : null;
}
export function resolveTeam(explicit) {
  const team = explicit || process.env.AGY_TEAM_NAME || sessionTeam();
  if (!team) throw new Error('cannot tell which team: run this from a Claude Code session (CLAUDE_CODE_SESSION_ID) or pass --team');
  if (!fs.existsSync(configPath(team))) throw new Error('team "' + team + '" has no config.json — the session has no agent team yet');
  return team;
}
export const getConfig = (team) => readJson(configPath(team));
export function updateConfig(team, fn) {
  const f = configPath(team);
  return withFileLock(f, () => { const c = readJson(f); if (!c) throw new Error('no team config ' + f); const r = fn(c); writeAtomic(f, c); return r; });
}
export const isAgyMember = (m) => typeof m?.agentType === 'string' && m.agentType.startsWith('agy');
export function findMember(team, name) { return getConfig(team)?.members?.find((m) => m.name === name) || null; }
// In-process Claude teammates keep the lead's inbox poller running (it only polls while it has teammates in memory).
export function claudeTeammates(team) {
  return (getConfig(team)?.members || []).filter((m) => m.name !== LEAD && m.backendType === 'in-process');
}
const COLORS = ['green', 'cyan', 'yellow', 'magenta', 'blue', 'red'];
export function addMember(team, { name, role, cwd, model }) {
  return updateConfig(team, (c) => {
    c.members = (c.members || []).filter((m) => m.name !== name || !isAgyMember(m));
    if (c.members.some((m) => m.name === name)) throw new Error('a non-agy member named "' + name + '" already exists');
    const member = { agentId: name + '@' + team, name, agentType: 'agy:' + role, model: model || undefined, joinedAt: Date.now(), tmuxPaneId: 'agy:' + name,
      cwd, subscriptions: [], backendType: 'tmux', color: COLORS[c.members.length % COLORS.length] };
    c.members.push(member);
    return member;
  });
}
export function removeMember(team, name) {
  try { return updateConfig(team, (c) => { const n = c.members.length; c.members = c.members.filter((m) => !(m.name === name && isAgyMember(m))); return n !== c.members.length; }); }
  catch { return false; }
}

// ---- mailbox ----
export function postMessage(team, to, from, text, { summary } = {}) {
  const f = inboxPath(team, to);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const msg = { from, text, ...(summary ? { summary } : {}), timestamp: new Date().toISOString(), msgV: 1, msg_id: crypto.randomUUID(), type: 'message', read: false };
  withFileLock(f, () => { const a = readJson(f, []); writeAtomic(f, [...(Array.isArray(a) ? a : []), msg]); });
  return msg;
}
// Returns unread messages; marks the ones accepted by pick() read (pick defaults to all).
export function takeUnread(team, name, pick = () => true) {
  const f = inboxPath(team, name);
  if (!fs.existsSync(f)) return [];
  return withFileLock(f, () => {
    const a = readJson(f, []);
    if (!Array.isArray(a)) return [];
    const taken = [];
    for (const m of a) if (!m.read && pick(m)) { m.read = true; taken.push(m); }
    if (taken.length) writeAtomic(f, a);
    return taken;
  });
}
export function peekUnread(team, name) {
  const a = readJson(inboxPath(team, name), []);
  return Array.isArray(a) ? a.filter((m) => !m.read) : [];
}
export function protocolOf(m) {
  try { const o = JSON.parse(m.text); return o && typeof o === 'object' && typeof o.type === 'string' ? o : null; } catch { return null; }
}

// ---- tasks ----
export function listTasks(team) {
  const d = tasksDir(team);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => /^\d+\.json$/.test(f)).map((f) => readJson(path.join(d, f))).filter(Boolean)
    .filter((t) => t.status !== 'deleted').sort((a, b) => Number(a.id) - Number(b.id));
}
export function updateTask(team, id, patch) {
  const d = tasksDir(team);
  const f = path.join(d, String(id) + '.json');
  if (!fs.existsSync(f)) throw new Error('no task #' + id);
  return withFileLock(path.join(d, '.lock'), () => { const t = readJson(f); Object.assign(t, patch); writeAtomic(f, t); return t; });
}
