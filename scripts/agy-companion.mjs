#!/usr/bin/env node
// agy-companion — quota-aware runtime for Antigravity CLI (agy) as a Claude Code subagent/teammate.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  ...(CONFIG.chains || {}),
};
const MODES = { code: null, review: 'plan' };
const PREAMBLE = {
  code: 'You are a coding agent delegated a task by an orchestrating Claude Code agent. Work autonomously; do not ask for approval. Your final message is returned verbatim to the orchestrator: keep it short (status, what changed, how verified, concerns).',
  review: 'You are a read-only analyst/reviewer delegated a task by an orchestrating Claude Code agent. Do NOT modify, create or delete any files and do not write plans for changes; answer directly. Your final message is returned verbatim to the orchestrator: lead with findings, cite file:line, keep it concise.',
};
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'quota_exhausted']);

// ---------- fs helpers ----------
fs.mkdirSync(JOBS, { recursive: true });
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson(f, v) {
  const tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, f); return; } catch (e) { if (i > 20) throw e; sleepSync(25); }
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
    try { const o = JSON.parse(lines[i]); if (o && 'status' in o) return o; } catch {}
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
function refreshLiveness(j) {
  if (j && !TERMINAL.has(j.status) && j.workerPid && !alive(j.workerPid) && Date.now() - Date.parse(j.createdAt) > 10_000)
    return updateJob(j.id, { status: 'failed', error: 'worker process died', endedAt: new Date().toISOString() });
  return j;
}
function render(j, { json } = {}) {
  if (json) return JSON.stringify(j, null, 2);
  const head = '[agy] job=' + j.id + (j.name ? ' name=' + j.name : '') + ' role=' + j.role + ' model=' + (j.model || '-') + ' status=' + j.status.toUpperCase()
    + (j.conversationId ? ' conversation=' + j.conversationId : '');
  if (j.status === 'done') return head + '\n' + (j.response || '').trim();
  if (j.status === 'quota_exhausted') return head + '\nQUOTA_EXHAUSTED: all models for role "' + j.role + '" are out of quota until ' + (j.resetAt || '?') + ' (' + fmtTime(j.resetAt) + '). Use a Claude agent instead.';
  if (j.status === 'failed' || j.status === 'cancelled') return head + '\n' + (j.error || '');
  return head + '\nstill running (' + Math.round((Date.now() - Date.parse(j.startedAt || j.createdAt)) / 1000) + 's). Next: node "' + SELF + '" wait ' + j.id;
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

async function cmdRun(o, { ask = false } = {}) {
  const name = ask ? o._.shift() : o.name;
  if (ask && !name) throw new Error('usage: ask <name> <prompt...>');
  let sess = name ? loadSessions()[name] : null;
  if (ask && !sess) throw new Error('no agy session named "' + name + '"; start one with: run --name ' + name + ' --role code|review ...');
  if (o.fresh && sess) { updateSession(name, null); sess = null; }
  const role = o.role || sess?.role || 'code';
  if (!CHAINS[role]) throw new Error('--role must be code or review (recon never goes to agy)');
  let prompt = o['prompt-file'] ? fs.readFileSync(o['prompt-file'], 'utf8') : o._.join(' ');
  if (!prompt.trim()) throw new Error('empty prompt');
  const cwd = path.resolve(o.cwd || sess?.cwd || process.cwd());
  const forced = o.model || null;
  const q = getQuota();
  const p = pickModel(role, q, { forced });
  const id = newJobId();
  const base = { id, name: name || null, role, cwd, forcedModel: forced, timeoutMin: Number(o['timeout-min'] || 30), conversationId: sess?.conversationId || null,
    createdAt: new Date().toISOString(), tried: [], attempts: [] };
  fs.writeFileSync(path.join(JOBS, id + '.prompt.md'), prompt);
  if (!p.model) {
    const j = { ...base, status: 'quota_exhausted', resetAt: p.resetAt, endedAt: base.createdAt };
    writeJson(jobFile(id), j); out(render(j, o)); process.exitCode = 4; return;
  }
  writeJson(jobFile(id), { ...base, status: 'queued' });
  if (name) updateSession(name, { role, cwd, lastJob: id, ...(sess ? {} : { createdAt: new Date().toISOString() }) });
  const w = spawn(process.execPath, [SELF, '_worker', id], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  w.unref();
  updateJob(id, { workerPid: w.pid });
  if (o.background) { out('[agy] job=' + id + (name ? ' name=' + name : '') + ' role=' + role + ' status=QUEUED\nNext: node "' + SELF + '" wait ' + id); return; }
  const j = await waitJob(id, Number(o['wait-sec'] || 540));
  out(render(j, o));
  if (j.status === 'quota_exhausted') process.exitCode = 4;
  else if (j.status === 'failed') process.exitCode = 1;
}

async function worker(id) {
  let j = updateJob(id, { status: 'running', startedAt: new Date().toISOString(), workerPid: process.pid });
  const promptText = fs.readFileSync(path.join(JOBS, id + '.prompt.md'), 'utf8');
  const logF = path.join(JOBS, id + '.log');
  let cid = j.conversationId;
  const tried = [];
  for (;;) {
    const q = getQuota();
    const p = pickModel(j.role, q, { exclude: tried, forced: j.forcedModel });
    if (!p.model) { updateJob(id, { status: 'quota_exhausted', resetAt: p.resetAt, endedAt: new Date().toISOString() }); return; }
    const model = p.model;
    tried.push(model);
    let text = cid ? promptText : PREAMBLE[j.role] + '\n\n---\n\n' + promptText;
    if (text.length > MAX_ARG_PROMPT) {
      const pf = path.join(JOBS, id + '.full-prompt.md');
      fs.writeFileSync(pf, text);
      text = 'Your full task is in the file ' + pf + ' — read it completely first, then do exactly what it says.';
    }
    const args = ['--model', model, '--output-format', 'json', '--dangerously-skip-permissions', '--print-timeout', j.timeoutMin + 'm'];
    if (MODES[j.role]) args.push('--mode', MODES[j.role]);
    if (cid) args.push('--conversation', cid);
    args.push('-p', text);
    j = updateJob(id, { model, tried });
    const [cmd, a] = agyCmd(args);
    const res = await new Promise((resolve) => {
      let buf = '';
      const ch = spawn(cmd, a, { cwd: j.cwd, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
      updateJob(id, { agyPid: ch.pid });
      const hard = setTimeout(() => { buf += '\n[companion] hard timeout, killing agy\n'; killTree(ch.pid); }, (j.timeoutMin + 2) * 60_000);
      ch.stdout.on('data', (d) => { buf += d; fs.appendFileSync(logF, d); });
      ch.stderr.on('data', (d) => { buf += d; fs.appendFileSync(logF, d); });
      ch.on('error', (e) => { clearTimeout(hard); resolve({ code: -1, buf: buf + '\n' + e.message }); });
      ch.on('close', (code) => { clearTimeout(hard); resolve({ code, buf }); });
    });
    if (loadJob(id).status === 'cancelled') return;
    const r = parseResult(res.buf);
    const attempt = { model, exit: res.code, status: r?.status || null, usage: r?.usage || null };
    j = updateJob(id, { attempts: [...(j.attempts || []), attempt] });
    if (r && r.status === 'SUCCESS') {
      cid = r.conversation_id || cid;
      updateJob(id, { status: 'done', response: r.response, conversationId: cid, usage: r.usage, endedAt: new Date().toISOString() });
      if (j.name) updateSession(j.name, { conversationId: cid, lastModel: model });
      return;
    }
    const errText = (r?.error || '') + '\n' + res.buf.slice(-2000);
    if (isQuotaError(errText)) {
      const g = groupOfModel(model);
      const fresh = getQuota({ refresh: true });
      const st = groupStatus(fresh, g);
      blockGroup(g, st.until || new Date(Date.now() + 60 * 60_000).toISOString());
      // Keep an existing conversation; a conversation created by a failed first turn is dropped.
      continue;
    }
    updateJob(id, { status: 'failed', error: (r?.error || res.buf.trim().slice(-1500) || 'agy exited with code ' + res.code), endedAt: new Date().toISOString() });
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
  const rows = ['| job | name | role | model | status | time |', '|---|---|---|---|---|---|'];
  for (const j of jobs) {
    const end = j.endedAt ? Date.parse(j.endedAt) : Date.now();
    rows.push('| ' + j.id + ' | ' + (j.name || '') + ' | ' + j.role + ' | ' + (j.model || '-') + ' | ' + j.status + ' | ' + Math.round((end - Date.parse(j.startedAt || j.createdAt)) / 1000) + 's |');
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

const HELP = 'agy-companion <command>\n' +
  '  run   --role code|review [--name N] [--fresh] [--cwd DIR] [--model M] [--timeout-min 30] [--background] [--wait-sec 540] [--prompt-file F | prompt...]\n' +
  '  ask   <name> [--prompt-file F | prompt...]     continue a named session (same conversation)\n' +
  '  wait  <job> [--wait-sec 540]                   block until the job ends or the wait elapses\n' +
  '  status [job] [--all] [--json] | result <job> | cancel [job]\n' +
  '  usage [--json]                                 quota per group + model each role would get\n' +
  '  pick  <role> [--refresh] [--json]               model for a role or QUOTA_EXHAUSTED (exit 4)\n' +
  '  sessions [--json] | forget <name>';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
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
    case 'forget': updateSession(o._[0], null); return out('forgot ' + o._[0]);
    case '_worker': return worker(o._[0]).catch((e) => updateJob(o._[0], { status: 'failed', error: 'worker crash: ' + e.stack, endedAt: new Date().toISOString() }));
    default: out(HELP); if (cmd && cmd !== 'help') process.exitCode = 64;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch((e) => { process.stderr.write('agy-companion: ' + e.message + '\n'); process.exitCode = 1; });
