#!/usr/bin/env node
// agy-companion — quota-aware runtime for Antigravity CLI (agy) as a Claude Code subagent/teammate.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as team from './team.mjs';

const SELF = fileURLToPath(import.meta.url);
const STATE = process.env.AGY_STATE_DIR || path.join(os.homedir(), '.claude', 'agy');
const JOBS = path.join(STATE, 'jobs');
const AGY = process.env.AGY_BIN || 'agy';
const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8')); } catch { return {}; } })();
const THRESHOLD = Number(process.env.AGY_QUOTA_THRESHOLD ?? CONFIG.threshold ?? 0.05);
const USAGE_TTL_MS = Number(process.env.AGY_USAGE_TTL_MS ?? 60_000);
const MAX_ARG_PROMPT = 20_000;

export const CHAINS = {
  code: ['gemini-4-neon-medium', 'claude-sonnet-5-5-medium', 'gemini-4-argon-medium'],
  review: ['gemini-4-argon-medium'],
  recon: ['gemini-4-hydrogen-medium', 'claude-sonnet-5-5-low'],
  ...(CONFIG.chains || {}),
};
const MODES = { code: null, review: 'plan', recon: 'plan' };
const SHELL_RULES = ' Shell rules: commands must never wait for input — always give rg/grep/find/cat an explicit path (e.g. `rg -n pattern .`), never read stdin, never start servers/watchers/pagers/interactive prompts; prefer your built-in search/read tools over shell for searching.';
const TEAM_PREAMBLE = (j) => 'You are "' + j.name + '", a member of a Claude Code agent team (team "' + j.team + '", lead "team-lead"; teammates are Claude agents and other agy agents). '
  + 'The MCP server "claude-team" gives you the team: send_message (to team-lead or a teammate by name), ask_lead (a blocking question — use it instead of guessing when a requirement is ambiguous or you are blocked), '
  + 'read_messages (new messages for you — check between major steps; the lead may redirect you), list_tasks / update_task (the shared task list). '
  + 'Always pass as="' + j.name + '" and team="' + j.team + '" to these tools. Your final answer of every turn is delivered to the lead automatically — do not also send it with send_message.';
const PREAMBLE = {
  code: 'You are a coding agent delegated a task by an orchestrating Claude Code agent. Work autonomously; do not ask for approval. Your final message is returned verbatim to the orchestrator: keep it short (status, what changed, how verified, concerns).' + SHELL_RULES,
  recon: 'You are a read-only investigator delegated a fact-finding task by an orchestrating Claude Code agent: search the code, read files and logs, collect facts. Do NOT modify, create or delete any files and do not write plans. Answer only what was asked, as a compact `file:line` table or at most 10 lines; no file dumps, no recommendations unless asked.' + SHELL_RULES,
  review: 'You are a read-only analyst/reviewer delegated a task by an orchestrating Claude Code agent. Do NOT modify, create or delete any files and do not write plans for changes; answer directly. Your final message is returned verbatim to the orchestrator: lead with findings, cite file:line, keep it concise.' + SHELL_RULES,
};
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'quota_exhausted']);

// ---------- fs helpers ----------
fs.mkdirSync(JOBS, { recursive: true });
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson(f, v) {
  const tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, f); return; } catch (e) { if (i > 200) throw e; sleepSync(25); }
  }
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withLock(name, fn) {
  const lock = path.join(STATE, name + '.lock');
  const t0 = Date.now();
  while (true) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() - t0 > 30_000) break;
      sleepSync(50);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}
const QUOTA_F = path.join(STATE, 'quota.json');
const SESS_F = path.join(STATE, 'sessions.json');
const jobFile = (id) => path.join(JOBS, id + '.json');
const loadJob = (id) => readJson(jobFile(id));
const updateJob = (id, patch) => withLock('job-' + id, () => { const j = { ...loadJob(id), ...patch }; writeJson(jobFile(id), j); return j; });
const loadSessions = () => readJson(SESS_F, {});
const updateSession = (name, patch) => withLock('sessions', () => {
  const s = loadSessions();
  s[name] = patch === null ? undefined : { ...(s[name] || {}), ...patch, updatedAt: new Date().toISOString() };
  if (patch === null) delete s[name];
  writeJson(SESS_F, s); return s[name];
});

// ---------- agy process ----------
function agyCmd(args) {
  return /\.(m?js)$/i.test(AGY) ? [process.execPath, [AGY, ...args]] : [AGY, args];
}
function runAgySync(args, opts = {}) {
  const [cmd, a] = agyCmd(args);
  const r = spawnSync(cmd, a, { encoding: 'utf8', timeout: opts.timeout ?? 90_000, windowsHide: true, cwd: opts.cwd, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}
export function parseResult(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (o && o.event === 'result' && o.result) return o.result;
      if (o && 'status' in o && !o.event) return o;
    } catch {}
  }
  return null;
}
export function isQuotaError(text) {
  return /RESOURCE_EXHAUSTED|\b429\b|quota|rate[ _-]?limit|limit (?:reached|exceeded)|exhausted/i.test(String(text || ''));
}

// ---------- quota ----------
export function groupOfModel(m) {
  if (/^gemini-4-argon/.test(m)) return 'argon';
  if (/^gemini/.test(m)) return 'gemini';
  return '3p';
}
function groupOfBucket(id, groupName) {
  if (/^gemini-argon/.test(id) || /argon/i.test(groupName)) return 'argon';
  if (/^3p/.test(id) || /claude|gpt/i.test(groupName)) return '3p';
  return 'gemini';
}
export function normalizeUsage(parsed) {
  const groups = {};
  for (const g of parsed?.command?.data?.groups || []) {
    for (const b of g.buckets || []) {
      const key = groupOfBucket(b.id || '', g.name || '');
      (groups[key] ||= { name: g.name, buckets: [] }).buckets.push({ id: b.id, window: b.window, remaining: Number(b.remaining_fraction ?? 1), reset: b.reset_time });
    }
  }
  return groups;
}
function fetchUsage() {
  const r = runAgySync(['-p', '/usage', '--output-format', 'json'], { timeout: 60_000 });
  const parsed = parseResult(r.out);
  if (!parsed || parsed.status !== 'SUCCESS' || !parsed.command) return { ok: false, error: (r.out || String(r.error || '')).slice(-500) };
  return { ok: true, groups: normalizeUsage(parsed) };
}
export function getQuota({ refresh = false } = {}) {
  return withLock('quota', () => {
    const q = readJson(QUOTA_F, { fetchedAt: 0, groups: {}, blocked: {} });
    q.blocked ||= {};
    if (refresh || Date.now() - (q.fetchedAt || 0) > USAGE_TTL_MS) {
      const u = fetchUsage();
      if (u.ok) { q.groups = u.groups; q.fetchedAt = Date.now(); q.lastError = null; }
      else q.lastError = u.error;
    }
    for (const [g, until] of Object.entries(q.blocked)) if (Date.parse(until) <= Date.now()) delete q.blocked[g];
    writeJson(QUOTA_F, q);
    return q;
  });
}
function blockGroup(group, until) {
  withLock('quota', () => {
    const q = readJson(QUOTA_F, { fetchedAt: 0, groups: {}, blocked: {} });
    q.blocked ||= {};
    q.blocked[group] = until;
    writeJson(QUOTA_F, q);
  });
}
// Returns {ok:true} or {ok:false, until:ISO|null, why}
export function groupStatus(q, group) {
  if (q.blocked?.[group] && Date.parse(q.blocked[group]) > Date.now()) return { ok: false, until: q.blocked[group], why: 'quota error' };
  const g = q.groups?.[group];
  if (!g) return { ok: true, why: 'no usage data' };
  const low = g.buckets.filter((b) => b.remaining < THRESHOLD && Date.parse(b.reset) > Date.now());
  if (!low.length) return { ok: true };
  const until = low.map((b) => b.reset).sort().pop();
  return { ok: false, until, why: low.map((b) => b.window + ' ' + Math.round(b.remaining * 100) + '%').join(', ') };
}
export function pickModel(role, q, { exclude = [], forced = null } = {}) {
  const chain = forced ? [forced] : CHAINS[role];
  if (!chain) throw new Error('unknown role ' + role);
  const resets = [];
  for (const m of chain) {
    if (exclude.includes(m)) continue;
    const s = groupStatus(q, groupOfModel(m));
    if (s.ok) return { model: m };
    if (s.until) resets.push(s.until);
  }
  return { model: null, resetAt: resets.sort()[0] || null };
}

// ---------- args ----------
function parseArgs(argv) {
  const o = { _: [] };
  const flags = new Set(['background', 'json', 'fresh', 'refresh', 'all']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) o[k] = v;
      else if (flags.has(k)) o[k] = true;
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '?';

// ---------- jobs ----------
function newJobId() { return new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12) + '-' + crypto.randomBytes(2).toString('hex'); }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const MAX_REVIVALS = 5;
function refreshLiveness(j) {
  if (!j || TERMINAL.has(j.status) || !j.workerPid || alive(j.workerPid) || Date.now() - Date.parse(j.createdAt) < 10_000) return j;
  // The worker died (killed with its parent's process tree, crashed, machine slept…). Restart it: it continues the
  // same agy conversation, so work agy already did is kept.
  return withLock('revive-' + j.id, () => {
    const cur = loadJob(j.id);
    if (TERMINAL.has(cur.status) || alive(cur.workerPid)) return cur;
    if ((cur.revivals || 0) >= MAX_REVIVALS) return updateJob(j.id, { status: 'failed', errorKind: 'worker_died', error: 'worker process died ' + (MAX_REVIVALS + 1) + ' times', changes: null, endedAt: new Date().toISOString() });
    if (cur.agyPid && alive(cur.agyPid)) killTree(cur.agyPid);
    try { fs.appendFileSync(path.join(JOBS, j.id + '.log'), '\n[companion ' + new Date().toISOString() + '] worker died — restarting it (revival ' + ((cur.revivals || 0) + 1) + ')\n'); } catch {}
    const w = spawnWorker(j.id);
    return updateJob(j.id, { workerPid: w.pid, revivals: (cur.revivals || 0) + 1, status: 'running' });
  });
}
function spawnWorker(id) {
  const w = spawn(process.execPath, [SELF, '_worker', id], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  w.unref();
  return w;
}
function render(j, { json } = {}) {
  if (json) return JSON.stringify(j, null, 2);
  const head = '[agy] job=' + j.id + (j.name ? ' name=' + j.name : '') + ' role=' + j.role + ' model=' + (j.model || '-') + ' status=' + j.status.toUpperCase()
    + (j.conversationId ? ' conversation=' + j.conversationId : '');
  if (j.status === 'done') return head + (j.warning ? '\nWARNING: ' + j.warning : '') + '\n' + (j.response || '').trim();
  if (j.status === 'quota_exhausted') return head + '\nQUOTA_EXHAUSTED: all models for role "' + j.role + '" are out of quota until ' + (j.resetAt || '?') + ' (' + fmtTime(j.resetAt) + '). Use a Claude agent instead.';
  if (j.status === 'failed') {
    const c = j.changes;
    return head + '\nERROR (' + (j.errorKind || 'error') + (j.retryable ? ', retryable' : '') + (j.retries ? ', after ' + j.retries + ' auto-retries' : '') + '): ' + (j.error || '').trim()
      + (c ? '\nWORKSPACE: ' + (c.changed ? c.commits.length + ' new commit(s)' + (c.commits.length ? ': ' + c.commits.slice(0, 5).join('; ') : '') + ', ' + c.dirtyFiles + ' uncommitted file(s) — agy DID work; inspect before re-running' : 'no changes') : '')
      + (j.response ? '\nLAST AGY TEXT:\n' + j.response.trim() : '')
      + (j.conversationId && j.name ? '\nTo continue the same conversation: ask ' + j.name + ' "continue"' : '');
  }
  if (j.status === 'cancelled') return head + '\n' + (j.error || '');
  const pr = j.progress;
  const prog = pr ? ' — now: ' + pr.step + ' (last agy activity ' + Math.round((Date.now() - Date.parse(pr.at)) / 1000) + 's ago)' : '';
  return head + '\nstill running (' + Math.round((Date.now() - Date.parse(j.startedAt || j.createdAt)) / 1000) + 's)' + prog + '. Next: node "' + SELF + '" wait ' + j.id;
}
async function waitJob(id, sec) {
  const t0 = Date.now();
  let j = loadJob(id);
  while (j && !TERMINAL.has(j.status) && Date.now() - t0 < sec * 1000) { await sleep(2000); j = refreshLiveness(loadJob(id)); }
  return j;
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// Creates a job and starts its worker. Returns the job (status queued, or quota_exhausted without running agy).
export function startJob({ name = null, role, cwd, prompt, forcedModel = null, timeoutMin, team = null }) {
  const sess = name ? loadSessions()[name] : null;
  if (!CHAINS[role]) throw new Error('--role must be code, review or recon');
  if (!String(prompt || '').trim()) throw new Error('empty prompt');
  const p = pickModel(role, getQuota(), { forced: forcedModel });
  const id = newJobId();
  const base = { id, name, role, cwd, team, forcedModel, timeoutMin: Number(timeoutMin || process.env.AGY_TIMEOUT_MIN || CONFIG.timeoutMin || 120),
    conversationId: sess?.conversationId || null, createdAt: new Date().toISOString(), tried: [], attempts: [] };
  fs.writeFileSync(path.join(JOBS, id + '.prompt.md'), prompt);
  if (!p.model) {
    const j = { ...base, status: 'quota_exhausted', resetAt: p.resetAt, endedAt: base.createdAt };
    writeJson(jobFile(id), j);
    return j;
  }
  writeJson(jobFile(id), { ...base, status: 'queued' });
  if (name) updateSession(name, { role, cwd, lastJob: id, ...(team ? { team } : {}), ...(sess ? {} : { createdAt: new Date().toISOString() }) });
  const w = spawnWorker(id);
  return updateJob(id, { workerPid: w.pid });
}

async function cmdRun(o, { ask = false } = {}) {
  const name = ask ? o._.shift() : o.name;
  if (ask && !name) throw new Error('usage: ask <name> <prompt...>');
  let sess = name ? loadSessions()[name] : null;
  if (ask && !sess) throw new Error('no agy session named "' + name + '"; start one with: run --name ' + name + ' --role code|review|recon ...');
  if (o.fresh && sess) { updateSession(name, null); sess = null; }
  const role = o.role || sess?.role || 'code';
  const prompt = o['prompt-file'] ? fs.readFileSync(o['prompt-file'], 'utf8') : o._.join(' ');
  const cwd = path.resolve(o.cwd || sess?.cwd || process.cwd());
  const job = startJob({ name: name || null, role, cwd, prompt, forcedModel: o.model || null, timeoutMin: o['timeout-min'], team: sess?.team || null });
  if (job.status === 'quota_exhausted') { out(render(job, o)); process.exitCode = 4; return; }
  if (o.background) { out('[agy] job=' + job.id + (name ? ' name=' + name : '') + ' role=' + role + ' status=QUEUED\nNext: node "' + SELF + '" wait ' + job.id); return; }
  const j = await waitJob(job.id, Number(o['wait-sec'] || 540));
  out(render(j, o));
  if (j.status === 'quota_exhausted') process.exitCode = 4;
  else if (j.status === 'failed') process.exitCode = 1;
}

export function classifyError(r, buf) {
  const text = (r?.error || '') + '\n' + String(buf || '').slice(-4000);
  if (/\[companion\] stalled/.test(text)) return { kind: 'stalled', retryable: true };
  if (isQuotaError(text) && !/network issue|EOF|Malformed function call/i.test(r?.error || '')) return { kind: 'quota', retryable: false };
  let agyErr = null;
  const m = String(buf || '').match(/AGY_ERROR: (\{.*\})/g);
  if (m) { try { agyErr = JSON.parse(m.at(-1).slice('AGY_ERROR: '.length)); } catch {} }
  if (/No capacity available|\b503\b|overloaded|try again later/i.test(text) && !/\bEOF\b/.test(r?.error || '')) return { kind: 'capacity', retryable: true };
  if (/Malformed function call|improperly formatted function call/i.test(text)) return { kind: 'malformed_call', retryable: true };
  if (/network issue|\bEOF\b|connection reset|UNAVAILABLE|\b50[234]\b|deadline exceeded|stream (?:closed|error)/i.test(text)) return { kind: 'network', retryable: true };
  if (/print[ _]timeout|DEADLINE_EXCEEDED|stream was interrupted/i.test(text)) return { kind: 'turn_timeout', retryable: true };
  if (/hard timeout/i.test(text)) return { kind: 'timeout', retryable: false };
  if (agyErr?.retryable) return { kind: 'transient', retryable: true };
  return { kind: 'error', retryable: false };
}
// agy sometimes errors AFTER writing its final answer (EOF / malformed call on the closing turn).
export function looksFinal(response) {
  return /^\s*STATUS:\s*(DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT)\b/im.test(String(response || ''));
}
function gitSnap(cwd) {
  const g = (...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const h = g('rev-parse', 'HEAD');
  if (h.status !== 0) return null;
  return { head: h.stdout.trim(), dirty: g('status', '--porcelain').stdout.split('\n').filter(Boolean).length };
}
function workspaceChanges(cwd, before) {
  if (!before) return null;
  const after = gitSnap(cwd);
  if (!after) return null;
  const commits = before.head === after.head ? [] : spawnSync('git', ['-C', cwd, 'log', '--oneline', '--no-decorate', before.head + '..' + after.head], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  return { commits, dirtyFiles: after.dirty, changed: commits.length > 0 || after.dirty !== before.dirty };
}
const IDLE_SEC = Number(process.env.AGY_IDLE_SEC || (CONFIG.idleMin ?? 20) * 60);
const TOOL_IDLE_SEC = Number(process.env.AGY_TOOL_IDLE_SEC || (CONFIG.toolIdleMin ?? 60) * 60);
// Read-only roles never run long builds: a command quiet for this long is hung (e.g. waiting on stdin).
const ROLE_TOOL_IDLE_SEC = { recon: Number(process.env.AGY_RECON_TOOL_IDLE_SEC || (CONFIG.reconToolIdleMin ?? 3) * 60), review: Number(process.env.AGY_REVIEW_TOOL_IDLE_SEC || (CONFIG.reviewToolIdleMin ?? 15) * 60) };
const STALL_MSG = (t) => 'Your previous turn was stopped by the orchestrator because it made no progress for a long time' + (t ? ' while this command was running: ' + t.name + ' ' + t.detail : '') + '. Do NOT rerun that command as-is. First check why it hung (a service it needs may be down — e.g. Docker/DB not running; an interactive prompt; a watcher). Give long commands an explicit timeout. If a required service is unavailable, stop and report STATUS: BLOCKED with the reason. Otherwise continue the task from where you stopped without redoing finished steps.';
const RETRY_DELAYS_S = (process.env.AGY_RETRY_DELAYS || (CONFIG.retryDelays || [15, 30, 60, 120, 240, 300]).join(',')).split(',').map(Number);
const CONTINUE_MSG = 'Your previous turn was cut off by a connection / tool-call error on the agy side (not by you). Continue the task from exactly where you stopped — check the workspace state first, do not redo steps that are already done. If the task is already complete, just give your final answer in the required format.';

async function worker(id) {
  let j = updateJob(id, { status: 'running', startedAt: new Date().toISOString(), workerPid: process.pid });
  const promptText = fs.readFileSync(path.join(JOBS, id + '.prompt.md'), 'utf8');
  const logF = path.join(JOBS, id + '.log');
  const before = gitSnap(j.cwd);
  let cid = j.conversationId || (j.revivals ? j.turnConversationId : null) || null;
  const tried = [];
  let model = null;
  let switchModel = true;
  let retries = 0;
  let pendingText = j.revivals && cid ? CONTINUE_MSG : null; // "continue" turn after a transient error or a worker restart
  let lastResponse = '';
  const saveCid = (c) => { if (!c || c === cid) return; cid = c; updateJob(id, { conversationId: cid }); if (j.name) updateSession(j.name, { conversationId: cid }); };
  for (;;) {
    if (switchModel) {
      switchModel = false;
      const p = pickModel(j.role, getQuota(), { exclude: tried, forced: j.forcedModel });
      if (!p.model) { updateJob(id, { status: 'quota_exhausted', resetAt: p.resetAt, endedAt: new Date().toISOString() }); return; }
      model = p.model;
      tried.push(model);
    }
    let text = pendingText || (cid ? promptText : (j.team ? TEAM_PREAMBLE(j) + '\n\n' : '') + PREAMBLE[j.role] + '\n\n---\n\n' + promptText);
    if (text.length > MAX_ARG_PROMPT) {
      const pf = path.join(JOBS, id + '.full-prompt.md');
      fs.writeFileSync(pf, text);
      text = 'Your full task is in the file ' + pf + ' — read it completely first, then do exactly what it says.';
    }
    let stalledTool = null;
    let turnSteps = 0; // tool steps completed in this turn
    let turnCid = null; // conversation of this turn, known from the stream's init event
    const args = ['--model', model, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', j.timeoutMin + 'm', '--log-file', path.join(JOBS, id + '.agy.log')];
    if (MODES[j.role]) args.push('--mode', MODES[j.role]);
    if (cid) args.push('--conversation', cid);
    args.push('-p', text);
    j = updateJob(id, { model, tried });
    fs.appendFileSync(logF, '\n[companion ' + new Date().toISOString() + '] model=' + model + (cid ? ' conversation=' + cid : '') + (pendingText ? ' (continue after error, retry ' + retries + ')' : '') + '\n');
    const [cmd, a] = agyCmd(args);
    const res = await new Promise((resolve) => {
      let buf = '';
      let pending = '';
      let lastEvent = Date.now();
      let activeTool = null; // { name, detail, since } while a tool step is ACTIVE
      let lastProgressWrite = 0;
      let lastStep = null;
      const ch = spawn(cmd, a, { cwd: j.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(j.team ? { AGY_TEAM_NAME: j.team, AGY_TEAM_MEMBER: j.name } : {}) } });
      updateJob(id, { agyPid: ch.pid, progress: { at: new Date().toISOString(), step: 'starting' } });
      const hard = setTimeout(() => { buf += '\n[companion] hard timeout, killing agy\n'; killTree(ch.pid); }, (j.timeoutMin + 2) * 60_000);
      const onEvent = (ev) => {
        lastEvent = Date.now();
        if (ev.event === 'init' && ev.conversation_id) { turnCid = ev.conversation_id; if (!cid) updateJob(id, { turnConversationId: turnCid }); }
        const su = ev.step_update;
        if (su?.step_type === 'tool' && su.state === 'DONE') turnSteps++;
        if (su?.step_type === 'tool') {
          const p = su.tool_info?.parameters || {};
          const detail = String(p.CommandLine || p.command || p.AbsolutePath || p.TargetFile || p.Query || '').slice(0, 160);
          activeTool = su.state === 'ACTIVE' ? { name: su.tool_name, detail, since: activeTool?.since || Date.now() } : null;
        } else if (su) activeTool = null;
        const step = activeTool ? activeTool.name + (activeTool.detail ? ': ' + activeTool.detail : '') : (su?.step_type || ev.event || 'event');
        if (step !== lastStep || Date.now() - lastProgressWrite > 5000) {
          lastProgressWrite = Date.now(); lastStep = step;
          updateJob(id, { progress: { at: new Date().toISOString(), step, steps: su?.step_index ?? null } });
        }
      };
      const onData = (d) => {
        buf += d; fs.appendFileSync(logF, d);
        pending += d;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const l of lines) { if (l.startsWith('{')) { try { onEvent(JSON.parse(l)); } catch {} } }
      };
      // Stall watchdog: agy sometimes hangs forever after an internal stream EOF.
      const idle = setInterval(() => {
        const quiet = (Date.now() - lastEvent) / 1000;
        const limit = activeTool ? Math.min(TOOL_IDLE_SEC, ROLE_TOOL_IDLE_SEC[j.role] ?? TOOL_IDLE_SEC) : IDLE_SEC;
        if (quiet > limit) {
          buf += '\n[companion] stalled: no agy progress for ' + Math.round(quiet) + 's' + (activeTool ? ' while running ' + activeTool.name + ' ' + activeTool.detail : '') + ', killing agy\n';
          fs.appendFileSync(logF, '\n[companion] stalled (' + Math.round(quiet) + 's quiet' + (activeTool ? ', tool ' + activeTool.name + ' ' + activeTool.detail : '') + ')\n');
          stalledTool = activeTool;
          clearInterval(idle);
          killTree(ch.pid);
        }
      }, Math.min(15_000, IDLE_SEC * 250));
      const fin = (r) => { clearTimeout(hard); clearInterval(idle); resolve(r); };
      ch.stdout.on('data', onData);
      ch.stderr.on('data', (d) => { buf += d; fs.appendFileSync(logF, d); });
      ch.on('error', (e) => fin({ code: -1, buf: buf + '\n' + e.message }));
      ch.on('close', (code) => fin({ code, buf }));
    });
    if (loadJob(id).status === 'cancelled') return;
    const r = parseResult(res.buf);
    const err = r?.status === 'SUCCESS' ? null : classifyError(r, res.buf);
    const attempt = { model, exit: res.code, status: r?.status || null, error: err?.kind || null, continued: !!pendingText, usage: r?.usage || null };
    j = updateJob(id, { attempts: [...(j.attempts || []), attempt] });
    if (r?.response?.trim()) lastResponse = r.response;
    const done = (extra = {}) => {
      updateJob(id, { status: 'done', response: lastResponse || r?.response || '', usage: r?.usage, endedAt: new Date().toISOString(), ...extra });
      if (j.name) updateSession(j.name, { conversationId: cid, lastModel: model });
    };
    if (!err) { saveCid(r.conversation_id); return done(); }
    if (err.kind === 'quota') {
      // Same text again on the next model of the chain (the turn did nothing). A conversation
      // created by a failed first turn is dropped; an existing one is continued.
      const g = groupOfModel(model);
      const st = groupStatus(getQuota({ refresh: true }), g);
      blockGroup(g, st.until || new Date(Date.now() + 60 * 60_000).toISOString());
      // Quota ran out in the middle of real work: keep that conversation and tell the next model to continue it.
      if (turnSteps > 0) { saveCid(r?.conversation_id || turnCid); pendingText = CONTINUE_MSG; }
      switchModel = true;
      continue;
    }
    saveCid(r?.conversation_id || turnCid); // the turn may have done real work — never lose its conversation
    if (looksFinal(r?.response)) return done({ warning: 'agy reported an error after its final answer (' + err.kind + '): ' + (r?.error || '').slice(0, 300) });
    if (turnSteps > 0) retries = 0; // the turn moved the work forward — the retry budget counts consecutive empty failures only
    if (err.kind === 'capacity') {
      // Server has no capacity for this model right now: continue on the next model of the chain if there is one.
      const p = pickModel(j.role, getQuota(), { exclude: tried, forced: j.forcedModel });
      if (p.model) { model = p.model; tried.push(model); }
    }
    if (err.retryable && retries < RETRY_DELAYS_S.length) {
      const delay = RETRY_DELAYS_S[retries++];
      updateJob(id, { progress: { at: new Date().toISOString(), step: 'retrying after ' + err.kind + ' in ' + delay + 's (' + retries + '/' + RETRY_DELAYS_S.length + ')' } });
      await sleep(delay * 1000);
      if (loadJob(id).status === 'cancelled') return;
      pendingText = cid ? (err.kind === 'stalled' ? STALL_MSG(stalledTool) : CONTINUE_MSG) : null;
      continue;
    }
    updateJob(id, { status: 'failed', errorKind: err.kind, retryable: err.retryable, retries,
      error: (r?.error || res.buf.trim().slice(-1500) || 'agy exited with code ' + res.code),
      response: lastResponse, changes: workspaceChanges(j.cwd, before), endedAt: new Date().toISOString() });
    return;
  }
}

function cmdUsage(o) {
  const q = getQuota({ refresh: true });
  if (o.json) return out(JSON.stringify(q, null, 2));
  const rows = ['| Группа | Лимит | Осталось | Сброс |', '|---|---|---|---|'];
  for (const [k, g] of Object.entries(q.groups || {}))
    for (const b of g.buckets) rows.push('| ' + g.name + ' | ' + b.window + ' | ' + (b.remaining * 100).toFixed(1) + '% | ' + fmtTime(b.reset) + ' |');
  out(rows.join('\n'));
  for (const role of Object.keys(CHAINS)) {
    const p = pickModel(role, q);
    out('- ' + role + ': ' + (p.model ? p.model : 'QUOTA_EXHAUSTED до ' + fmtTime(p.resetAt)));
  }
  for (const [g, u] of Object.entries(q.blocked || {})) out('- blocked ' + g + ' до ' + fmtTime(u));
  if (q.lastError) out('- usage fetch error: ' + q.lastError.slice(0, 300));
}
function cmdPick(o) {
  const role = o._[0] || o.role;
  const p = pickModel(role, getQuota({ refresh: !!o.refresh }));
  out(o.json ? JSON.stringify(p) : (p.model || 'QUOTA_EXHAUSTED ' + (p.resetAt || '')));
  if (!p.model) process.exitCode = 4;
}
function listJobs() {
  return fs.readdirSync(JOBS).filter((f) => /^[\w-]+\.json$/.test(f)).map((f) => refreshLiveness(readJson(path.join(JOBS, f)))).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function cmdStatus(o) {
  if (o._[0]) { const j = refreshLiveness(loadJob(o._[0])); if (!j) throw new Error('no job ' + o._[0]); return out(render(j, o)); }
  let jobs = listJobs();
  if (!o.all) jobs = jobs.filter((j) => !TERMINAL.has(j.status) || Date.now() - Date.parse(j.createdAt) < 24 * 3600_000).slice(0, 20);
  if (o.json) return out(JSON.stringify(jobs.map(({ response, ...r }) => r), null, 2));
  const rows = ['| job | name | role | model | status | error | time |', '|---|---|---|---|---|---|---|'];
  for (const j of jobs) {
    const end = j.endedAt ? Date.parse(j.endedAt) : Date.now();
    rows.push('| ' + j.id + ' | ' + (j.name || '') + ' | ' + j.role + ' | ' + (j.model || '-') + ' | ' + j.status + (j.warning ? ' (warning)' : '') + ' | ' + (j.status === 'failed' ? (j.errorKind || 'error') + (j.retryable ? ' (retryable)' : '') + (j.changes?.changed ? ', workspace changed' : '') : ((j.attempts || []).filter((a) => a.error).map((a) => a.error).join(',') + (!TERMINAL.has(j.status) && j.progress ? ' now: ' + String(j.progress.step).slice(0, 60) : ''))) + ' | ' + Math.round((end - Date.parse(j.startedAt || j.createdAt)) / 1000) + 's |');
  }
  out(jobs.length ? rows.join('\n') : 'no agy jobs');
}
function cmdCancel(o) {
  const id = o._[0] || listJobs().find((j) => !TERMINAL.has(j.status))?.id;
  if (!id) return out('no running agy job');
  const j = loadJob(id);
  if (!j) throw new Error('no job ' + id);
  if (TERMINAL.has(j.status)) return out('job ' + id + ' already ' + j.status);
  updateJob(id, { status: 'cancelled', error: 'cancelled by user', endedAt: new Date().toISOString() });
  killTree(j.agyPid); killTree(j.workerPid);
  out('cancelled ' + id);
}
function cmdSessions(o) {
  const s = loadSessions();
  if (o.json) return out(JSON.stringify(s, null, 2));
  const names = Object.keys(s);
  if (!names.length) return out('no agy sessions');
  out(['| name | role | conversation | last model | cwd | updated |', '|---|---|---|---|---|---|',
    ...names.map((n) => '| ' + n + ' | ' + s[n].role + ' | ' + (s[n].conversationId || '-') + ' | ' + (s[n].lastModel || '-') + ' | ' + s[n].cwd + ' | ' + fmtTime(s[n].updatedAt) + ' |')].join('\n'));
}


// ---------- agy as a native agent-team member ----------
const BRIDGE_POLL_MS = Number(process.env.AGY_BRIDGE_POLL_MS || 1500);
function bridgeAlive(sess) { return !!sess?.bridgePid && alive(sess.bridgePid); }
function spawnBridge(teamName, name) {
  const b = spawn(process.execPath, [SELF, '_bridge', teamName, name], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  b.unref();
  updateSession(name, { bridgePid: b.pid });
  return b.pid;
}
// Restart bridges that died while their member is still on the team (called opportunistically by every command).
function reviveBridges() {
  for (const [name, s] of Object.entries(loadSessions())) {
    if (!s?.team || bridgeAlive(s)) continue;
    let m = null; try { m = team.findMember(s.team, name); } catch {}
    if (m && team.isAgyMember(m)) withLock('bridge-' + name, () => { if (!bridgeAlive(loadSessions()[name])) spawnBridge(s.team, name); });
  }
}
function messageToPrompt(m) {
  const p = team.protocolOf(m);
  if (p?.type === 'task_assignment') return 'The lead assigned you task #' + p.taskId + ': ' + p.subject + (p.description ? '\n' + p.description : '');
  return (m.from && m.from !== team.LEAD ? 'Message from teammate ' + m.from + ':\n' : '') + m.text;
}
function reportText(j) {
  const head = render(j);
  return head.replace(/^\[agy\] [^\n]*\n?/, '').trim() || head;
}
function reportSummary(j) {
  const st = j.status === 'done' ? (j.warning ? 'done (warning)' : 'done') : j.status;
  const first = String(j.response || j.error || '').split('\n').find((l) => l.trim()) || '';
  return (st + ': ' + first).slice(0, 120);
}

async function cmdTeam(o) {
  const sub = o._.shift();
  if (sub === 'spawn') {
    const name = o.name || o._.shift();
    if (!name || !/^[\w.-]{1,64}$/.test(name)) throw new Error('--name <name> required (letters, digits, - _ .)');
    const role = o.role || 'code';
    if (!CHAINS[role]) throw new Error('--role must be code, review or recon');
    const teamName = team.resolveTeam(o.team);
    const prompt = o['prompt-file'] ? fs.readFileSync(o['prompt-file'], 'utf8') : o._.join(' ');
    if (!prompt.trim()) throw new Error('empty task: pass --prompt-file or text');
    const p = pickModel(role, getQuota(), { forced: o.model || null });
    if (!p.model) { out('QUOTA_EXHAUSTED: no agy model for role "' + role + '" until ' + (p.resetAt || '?') + ' (' + fmtTime(p.resetAt) + ') — use a Claude teammate instead.'); process.exitCode = 4; return; }
    const cwd = path.resolve(o.cwd || process.cwd());
    const old = loadSessions()[name];
    if (old?.team && old.team !== teamName && bridgeAlive(old)) throw new Error('the name "' + name + '" is in use by an agy teammate of another session (' + old.team + '); pick another name');
    if (old?.bridgePid && alive(old.bridgePid)) killTree(old.bridgePid);
    updateSession(name, null);
    updateSession(name, { role, cwd, team: teamName, forcedModel: o.model || null, timeoutMin: o['timeout-min'] || null, createdAt: new Date().toISOString(), taskId: o.task || null });
    team.addMember(teamName, { name, role, cwd, model: p.model });
    if (o.task) { try { team.updateTask(teamName, o.task, { owner: name, status: 'in_progress' }); } catch (e) { out('note: task #' + o.task + ' not updated: ' + e.message); } }
    team.postMessage(teamName, name, team.LEAD, prompt, { summary: 'initial task' });
    spawnBridge(teamName, name);
    const lines = [name + ' joined team ' + teamName + ' as an agy ' + role + ' teammate (model ' + p.model + ') and is working.',
      'Its report arrives as a message from ' + name + '. Follow-ups: SendMessage to "' + name + '". Stop it: SendMessage a shutdown_request, or: node "' + SELF + '" team stop ' + name + '.'];
    if (!team.claudeTeammates(teamName).length) lines.push('WARNING: no Claude teammate is running, so the lead does not poll its inbox and agy reports would wait. Spawn the keep-alive first: Agent({ name: "agy-hub", subagent_type: "agy:agy-hub", model: "haiku", prompt: "hold" }).');
    out(lines.join('\n'));
    return;
  }
  if (sub === 'stop') {
    const name = o._.shift();
    const s = loadSessions()[name];
    if (!s?.team) throw new Error('no agy teammate named ' + name);
    stopMember(s.team, name, 'stopped by lead');
    out('stopped ' + name);
    return;
  }
  if (sub === 'ls' || !sub) {
    const rows = Object.entries(loadSessions()).filter(([, s]) => s?.team).map(([n, s]) => {
      const j = s.lastJob ? loadJob(s.lastJob) : null;
      return '| ' + n + ' | ' + s.team + ' | ' + s.role + ' | ' + (bridgeAlive(s) ? 'up' : 'down') + ' | ' + (j ? j.status + (j.progress && !TERMINAL.has(j.status) ? ' — ' + String(j.progress.step).slice(0, 50) : '') : '-') + ' |';
    });
    out(rows.length ? ['| name | team | role | bridge | last job |', '|---|---|---|---|---|', ...rows].join('\n') : 'no agy teammates');
    return;
  }
  throw new Error('usage: team spawn|stop|ls');
}
function stopMember(teamName, name, why) {
  const s = loadSessions()[name];
  const j = s?.lastJob ? loadJob(s.lastJob) : null;
  if (j && !TERMINAL.has(j.status)) { updateJob(j.id, { status: 'cancelled', error: why, endedAt: new Date().toISOString() }); killTree(j.agyPid); killTree(j.workerPid); }
  team.removeMember(teamName, name);
  if (s?.bridgePid && s.bridgePid !== process.pid && alive(s.bridgePid)) killTree(s.bridgePid);
  updateSession(name, { bridgePid: null, stoppedAt: new Date().toISOString() });
}

async function bridge(teamName, name) {
  const logF = path.join(STATE, 'bridge-' + name + '.log');
  const log = (m) => { try { fs.appendFileSync(logF, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
  process.on('uncaughtException', (e) => log('exception (ignored): ' + (e?.stack || e)));
  updateSession(name, { bridgePid: process.pid });
  log('bridge up for ' + name + ' on ' + teamName);
  let leadGoneSince = null;
  for (;;) {
    await sleep(BRIDGE_POLL_MS);
    const sess = loadSessions()[name];
    if (!sess || sess.team !== teamName || (sess.bridgePid && sess.bridgePid !== process.pid)) { log('superseded, exiting'); return; }
    const cfg = team.getConfig(teamName);
    if (!cfg || !cfg.members?.some((m) => m.name === name && team.isAgyMember(m))) { log('no longer a member, exiting'); stopMember(teamName, name, 'removed from team'); return; }
    const leadPid = cfg.leadProcess?.pid;
    if (leadPid && !alive(leadPid)) { leadGoneSince ??= Date.now(); if (Date.now() - leadGoneSince > 15 * 60_000) { log('lead gone, exiting'); stopMember(teamName, name, 'lead session ended'); return; } }
    else leadGoneSince = null;

    // Shutdown requests are handled at once, even mid-turn.
    const shut = team.takeUnread(teamName, name, (m) => team.protocolOf(m)?.type === 'shutdown_request');
    if (shut.length) {
      const req = team.protocolOf(shut[0]);
      stopMember(teamName, name, 'shutdown requested');
      team.postMessage(teamName, team.LEAD, name, JSON.stringify({ type: 'shutdown_approved', requestId: req.requestId, from: name, timestamp: new Date().toISOString(), paneId: 'agy:' + name, backendType: 'tmux' }));
      log('shutdown approved');
      return;
    }

    let j = sess.lastJob ? refreshLiveness(loadJob(sess.lastJob)) : null;
    if (j && !TERMINAL.has(j.status)) continue; // agy is working; new messages wait (agy can read them via read_messages)
    if (j && sess.reportedJob !== j.id) {
      team.postMessage(teamName, team.LEAD, name, reportText(j), { summary: reportSummary(j) });
      updateSession(name, { reportedJob: j.id });
      log('reported job ' + j.id + ' (' + j.status + ')');
      if (sess.taskId && j.status !== 'done') { try { team.updateTask(teamName, sess.taskId, { activeForm: name + ': ' + j.status }); } catch {} }
      continue;
    }
    // Ignore harness notifications that are not instructions; everything else becomes the next agy turn.
    const msgs = team.takeUnread(teamName, name, (m) => { const p = team.protocolOf(m); return !p || p.type === 'task_assignment'; });
    team.takeUnread(teamName, name, (m) => { const t = team.protocolOf(m)?.type; return t && t !== 'shutdown_request' && t !== 'task_assignment'; });
    if (!msgs.length) continue;
    const prompt = msgs.map(messageToPrompt).join('\n\n---\n\n');
    const job = startJob({ name, role: sess.role, cwd: sess.cwd, prompt, forcedModel: sess.forcedModel || null, timeoutMin: sess.timeoutMin, team: teamName });
    log('started job ' + job.id + ' (' + job.status + ') for ' + msgs.length + ' message(s)');
    if (job.status === 'quota_exhausted') { team.postMessage(teamName, team.LEAD, name, reportText(job), { summary: 'quota exhausted' }); updateSession(name, { reportedJob: job.id }); }
  }
}

const HELP = 'agy-companion <command>\n' +
  '  run   --role code|review|recon [--name N] [--fresh] [--cwd DIR] [--model M] [--timeout-min 120] [--background] [--wait-sec 540] [--prompt-file F | prompt...]\n' +
  '  ask   <name> [--prompt-file F | prompt...]     continue a named session (same conversation)\n' +
  '  wait  <job> [--wait-sec 540]                   block until the job ends or the wait elapses\n' +
  '  status [job] [--all] [--json] | result <job> | cancel [job]\n' +
  '  usage [--json]                                 quota per group + model each role would get\n' +
  '  pick  <role> [--refresh] [--json]               model for a role or QUOTA_EXHAUSTED (exit 4)\n' +
  '  sessions [--json] | forget <name>\n' +
  '  team spawn --name N --role code|review|recon [--cwd DIR] [--task ID] [--team T] [--model M] (--prompt-file F | text)\n' +
  '  team stop <name> | team ls                       agy as a native member of the current Claude Code agent team';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (cmd && !cmd.startsWith('_')) { try { reviveBridges(); } catch {} }
  switch (cmd) {
    case 'run': return cmdRun(o);
    case 'ask': return cmdRun(o, { ask: true });
    case 'wait': { const j = await waitJob(o._[0], Number(o['wait-sec'] || 540)); if (!j) throw new Error('no job ' + o._[0]); out(render(j, o)); if (j.status === 'quota_exhausted') process.exitCode = 4; return; }
    case 'status': return cmdStatus(o);
    case 'result': { const j = loadJob(o._[0]); if (!j) throw new Error('no job ' + o._[0]); return out(render(j, o)); }
    case 'cancel': return cmdCancel(o);
    case 'usage': return cmdUsage(o);
    case 'pick': return cmdPick(o);
    case 'sessions': return cmdSessions(o);
    case 'team': return cmdTeam(o);
    case '_bridge': return bridge(o._[0], o._[1]);
    case 'forget': updateSession(o._[0], null); return out('forgot ' + o._[0]);
    case '_worker':
      process.on('uncaughtException', (e) => { try { fs.appendFileSync(path.join(JOBS, o._[0] + '.log'), '\n[companion] worker exception (ignored): ' + (e?.stack || e) + '\n'); } catch {} });
      return worker(o._[0]).catch((e) => updateJob(o._[0], { status: 'failed', error: 'worker crash: ' + e.stack, endedAt: new Date().toISOString() }));
    default: out(HELP); if (cmd && cmd !== 'help') process.exitCode = 64;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch((e) => { process.stderr.write('agy-companion: ' + e.message + '\n'); process.exitCode = 1; });
