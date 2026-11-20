import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMP = path.join(here, '..', 'scripts', 'agy-companion.mjs');
const MCP = path.join(here, '..', 'scripts', 'team-mcp.mjs');
const FAKE = path.join(here, 'fake-agy.mjs');
const TEAM = 'session-testteam';

function setup({ claudeMate = true, scenario = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyteam-'));
  const claude = path.join(dir, 'claude');
  const td = path.join(claude, 'teams', TEAM);
  fs.mkdirSync(path.join(td, 'inboxes'), { recursive: true });
  const members = [{ agentId: 'team-lead@' + TEAM, name: 'team-lead', agentType: 'team-lead', joinedAt: Date.now(), tmuxPaneId: 'leader', backendType: 'in-process' }];
  if (claudeMate) members.push({ agentId: 'impl-1@' + TEAM, name: 'impl-1', agentType: 'general-purpose', joinedAt: Date.now(), tmuxPaneId: 'in-process', backendType: 'in-process' });
  fs.writeFileSync(path.join(td, 'config.json'), JSON.stringify({ name: TEAM, leadAgentId: 'team-lead@' + TEAM, leadProcess: { pid: process.pid, pidSpace: 'HOME', claimedAt: Date.now() }, members }));
  const tasks = path.join(claude, 'tasks', TEAM);
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, '1.json'), JSON.stringify({ id: '1', subject: 'Do X', description: '', status: 'pending', blocks: [], blockedBy: [] }));
  const sc = path.join(dir, 'scenario.json');
  fs.writeFileSync(sc, JSON.stringify(scenario));
  const env = { ...process.env, AGY_CLAUDE_DIR: claude, AGY_STATE_DIR: path.join(dir, 'state'), AGY_BIN: FAKE, AGY_STUB_SCENARIO: sc, AGY_STUB_CALLS: path.join(dir, 'calls.jsonl'),
    AGY_USAGE_TTL_MS: '0', AGY_RETRY_DELAYS: '0', AGY_BRIDGE_POLL_MS: '200', CLAUDE_CODE_SESSION_ID: 'testteam-0000' };
  return { dir, claude, td, tasks, env };
}
const run = (e, ...args) => spawnSync(process.execPath, [COMP, ...args], { env: e.env, encoding: 'utf8', cwd: e.dir, timeout: 60000 });
const inbox = (e, name) => { try { return JSON.parse(fs.readFileSync(path.join(e.td, 'inboxes', name + '.json'), 'utf8')); } catch { return []; } };
const members = (e) => JSON.parse(fs.readFileSync(path.join(e.td, 'config.json'), 'utf8')).members;
const post = (e, to, from, text) => {
  const f = path.join(e.td, 'inboxes', to + '.json');
  const a = inbox(e, to); a.push({ from, text, timestamp: new Date().toISOString(), msgV: 1, msg_id: String(Math.random()), type: 'message', read: false });
  fs.writeFileSync(f, JSON.stringify(a));
};
async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return fn(); }
const sessions = (e) => JSON.parse(fs.readFileSync(path.join(e.env.AGY_STATE_DIR, 'sessions.json'), 'utf8'));
const cleanup = (e, name) => { try { const s = sessions(e)[name]; if (s?.bridgePid) process.kill(s.bridgePid); } catch {} };

test('team spawn joins the team, runs the task and reports to the lead inbox', async () => {
  const e = setup();
  const r = run(e, 'team', 'spawn', '--name', 'agy-impl-1', '--role', 'code', '--task', '1', 'build it');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /joined team session-testteam/);
  assert.doesNotMatch(r.stdout, /WARNING/);
  const m = members(e).find((x) => x.name === 'agy-impl-1');
  assert.equal(m.backendType, 'tmux');
  assert.equal(m.agentType, 'agy:code');
  const t = JSON.parse(fs.readFileSync(path.join(e.tasks, '1.json'), 'utf8'));
  assert.equal(t.owner, 'agy-impl-1'); assert.equal(t.status, 'in_progress');
  const rep = await until(() => inbox(e, 'team-lead').find((x) => x.from === 'agy-impl-1'));
  assert.ok(rep, 'report must reach the lead inbox');
  assert.match(rep.text, /OK from gemini-4-neon-medium/);
  assert.match(rep.summary, /^done: /);
  cleanup(e, 'agy-impl-1');
});

test('lead follow-up continues the same agy conversation; shutdown_request is approved', async () => {
  const e = setup();
  run(e, 'team', 'spawn', '--name', 'agy-impl-2', 'first');
  await until(() => inbox(e, 'team-lead').some((x) => x.from === 'agy-impl-2'));
  const cid = sessions(e)['agy-impl-2'].conversationId;
  assert.ok(cid);
  post(e, 'agy-impl-2', 'team-lead', 'second');
  const rep2 = await until(() => inbox(e, 'team-lead').filter((x) => x.from === 'agy-impl-2').length === 2);
  assert.ok(rep2);
  assert.match(inbox(e, 'team-lead').filter((x) => x.from === 'agy-impl-2')[1].text, new RegExp('conv=' + cid));
  post(e, 'agy-impl-2', 'team-lead', JSON.stringify({ type: 'shutdown_request', requestId: 'shutdown-1@agy-impl-2', from: 'team-lead', timestamp: new Date().toISOString() }));
  const ok = await until(() => inbox(e, 'team-lead').find((x) => { try { return JSON.parse(x.text).type === 'shutdown_approved'; } catch { return false; } }));
  assert.ok(ok);
  assert.equal(JSON.parse(ok.text).requestId, 'shutdown-1@agy-impl-2');
  assert.ok(!members(e).some((x) => x.name === 'agy-impl-2'), 'member removed from the team');
});

test('harness notifications are not forwarded to agy', async () => {
  const e = setup();
  run(e, 'team', 'spawn', '--name', 'agy-impl-3', 'first');
  await until(() => inbox(e, 'team-lead').some((x) => x.from === 'agy-impl-3'));
  post(e, 'agy-impl-3', 'team-lead', JSON.stringify({ type: 'idle_notification', from: 'x' }));
  await new Promise((r) => setTimeout(r, 1500));
  const calls = fs.readFileSync(path.join(e.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => !c.args.includes('/usage'));
  assert.equal(calls.length, 1);
  cleanup(e, 'agy-impl-3');
});

test('warns when no Claude teammate keeps the lead inbox poller alive; quota exhausted refuses to join', () => {
  const e = setup({ claudeMate: false });
  const r = run(e, 'team', 'spawn', '--name', 'agy-impl-4', 'x');
  assert.match(r.stdout, /WARNING: no Claude teammate is running/);
  assert.match(r.stdout, /agy:code/);
  cleanup(e, 'agy-impl-4');
  const e2 = setup({ scenario: { usage: { gemini: [0.01, 1], '3p': [0.01, 1], argon: [0.0] } } });
  const r2 = run(e2, 'team', 'spawn', '--name', 'agy-impl-5', 'x');
  assert.equal(r2.status, 4);
  assert.match(r2.stdout, /QUOTA_EXHAUSTED/);
  assert.ok(!members(e2).some((x) => x.name === 'agy-impl-5'));
});

test('team MCP: identity from env, send_message, update_task, ask_lead gets the reply', async () => {
  const e = setup();
  run(e, 'team', 'spawn', '--name', 'agy-impl-6', 'x');
  await until(() => inbox(e, 'team-lead').some((x) => x.from === 'agy-impl-6'));
  cleanup(e, 'agy-impl-6');
  const p = spawn(process.execPath, [MCP], { env: { ...e.env, AGY_TEAM_NAME: TEAM, AGY_TEAM_MEMBER: 'agy-impl-6' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const rpc = (id, method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const res = (id) => until(() => out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === id), 20000);
  rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal((await res(1)).result.serverInfo.name, 'claude-team');
  rpc(2, 'tools/call', { name: 'send_message', arguments: { to: 'impl-1', message: 'hi from agy' } });
  await res(2);
  assert.equal(inbox(e, 'impl-1')[0].from, 'agy-impl-6');
  rpc(3, 'tools/call', { name: 'update_task', arguments: { id: '1', take: true, status: 'in_progress', activeForm: 'working' } });
  await res(3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.tasks, '1.json'), 'utf8')).owner, 'agy-impl-6');
  rpc(4, 'tools/call', { name: 'ask_lead', arguments: { question: 'table or line?', timeout_min: 1 } });
  const q = await until(() => inbox(e, 'team-lead').find((x) => x.from === 'agy-impl-6' && /table or line/.test(x.text)));
  assert.ok(q);
  post(e, 'agy-impl-6', 'team-lead', 'line');
  const a = await res(4);
  assert.match(a.result.content[0].text, /Answer from the lead:\nline/);
  rpc(5, 'tools/call', { name: 'send_message', arguments: { to: 'nobody', message: 'x' } });
  assert.equal((await res(5)).result.isError, true);
  p.kill();
});
