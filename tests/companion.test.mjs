import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMP = path.join(here, '..', 'scripts', 'agy-companion.mjs');
const FAKE = path.join(here, 'fake-agy.mjs');

function env(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyt-'));
  const sc = path.join(dir, 'scenario.json');
  fs.writeFileSync(sc, JSON.stringify(scenario));
  return { dir, calls: path.join(dir, 'calls.jsonl'),
    env: { ...process.env, AGY_STATE_DIR: path.join(dir, 'state'), AGY_BIN: FAKE, AGY_STUB_SCENARIO: sc, AGY_STUB_CALLS: path.join(dir, 'calls.jsonl'), AGY_USAGE_TTL_MS: '0' } };
}
const run = (e, ...args) => spawnSync(process.execPath, [COMP, ...args], { env: e.env, encoding: 'utf8', cwd: e.dir, timeout: 60000 });
const calls = (e) => fs.existsSync(e.calls) ? fs.readFileSync(e.calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => !c.args.includes('/usage')) : [];

const lib = await import(pathToFileURL(COMP).href);

test('normalizeUsage groups buckets by id', () => {
  const g = lib.normalizeUsage({ command: { data: { groups: [
    { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.5, reset_time: 'x' }] },
    { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: 'x' }] },
    { name: 'Gemini 4 Argon', buckets: [{ id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.2, reset_time: 'x' }] },
  ] } } });
  assert.deepEqual(Object.keys(g).sort(), ['3p', 'argon', 'gemini']);
  assert.equal(g.argon.buckets[0].remaining, 0.2);
});

test('pickModel walks the chain and skips groups under threshold', () => {
  const fut = new Date(Date.now() + 3600e3).toISOString();
  const q = { groups: { gemini: { buckets: [{ window: '5h', remaining: 0.04, reset: fut }] }, '3p': { buckets: [{ window: '5h', remaining: 0.5, reset: fut }] } }, blocked: {} };
  assert.equal(lib.pickModel('code', q).model, 'claude-sonnet-5-5-medium');
  q.blocked['3p'] = fut;
  assert.equal(lib.pickModel('code', q).model, 'gemini-4-argon-medium');
  q.blocked.argon = fut;
  const p = lib.pickModel('code', q);
  assert.equal(p.model, null);
  assert.equal(p.resetAt, fut);
  assert.equal(lib.pickModel('review', { groups: {}, blocked: {} }).model, 'gemini-4-argon-medium');
  assert.throws(() => lib.pickModel('recon', q));
});

test('isQuotaError', () => {
  assert.ok(lib.isQuotaError('RESOURCE_EXHAUSTED (code 429)'));
  assert.ok(!lib.isQuotaError('PERMISSION_DENIED (code 403)'));
});

test('code run falls back to next model on quota error and blocks the group', () => {
  const e = env({ models: { 'gemini-4-hydrogen-medium': 'quota' } });
  const r = run(e, 'run', '--role', 'code', 'do', 'it');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /status=DONE/);
  assert.match(r.stdout, /OK from claude-sonnet-5-5-medium mode=default/);
  const c = calls(e);
  assert.deepEqual(c.map((x) => x.args[x.args.indexOf('--model') + 1]), ['gemini-4-hydrogen-medium', 'claude-sonnet-5-5-medium']);
  assert.ok(c.every((x) => x.args.includes('--dangerously-skip-permissions')));
  assert.ok(!c[1].args.includes('--conversation'), 'failed first turn conversation must not be resumed');
  const q = JSON.parse(fs.readFileSync(path.join(e.dir, 'state', 'quota.json'), 'utf8'));
  assert.ok(q.blocked.gemini);
});

test('all quota exhausted -> exit 4 and agy is not called', () => {
  const e = env({ usage: { gemini: [0.01, 0.5], '3p': [0.9, 0.02], argon: [0.0] } });
  const r = run(e, 'run', '--role', 'code', 'x');
  assert.equal(r.status, 4);
  assert.match(r.stdout, /QUOTA_EXHAUSTED/);
  assert.equal(calls(e).length, 0);
  const u = run(e, 'usage');
  assert.match(u.stdout, /code: QUOTA_EXHAUSTED/);
});

test('review role uses argon in plan mode; never other models', () => {
  const e = env({ usage: { argon: [0.01] } });
  const r = run(e, 'run', '--role', 'review', 'x');
  assert.equal(r.status, 4);
  const e2 = env({});
  const r2 = run(e2, 'run', '--role', 'review', 'look');
  assert.match(r2.stdout, /OK from gemini-4-argon-medium mode=plan/);
});

test('named session: ask continues the same conversation, even across a model switch', () => {
  const e = env({});
  const r1 = run(e, 'run', '--role', 'code', '--name', 'agy-impl-1', 'first');
  const cid = r1.stdout.match(/conversation=(\S+)/)[1];
  fs.writeFileSync(path.join(e.dir, 'scenario.json'), JSON.stringify({ models: { 'gemini-4-hydrogen-medium': 'quota' } }));
  const r2 = run(e, 'ask', 'agy-impl-1', 'second');
  assert.match(r2.stdout, new RegExp('conv=' + cid));
  assert.match(r2.stdout, /claude-sonnet-5-5-medium/);
  const c = calls(e);
  assert.equal(c.at(-1).args[c.at(-1).args.indexOf('--conversation') + 1], cid);
  assert.match(run(e, 'sessions').stdout, /agy-impl-1/);
  assert.equal(run(e, 'ask', 'nope', 'x').status, 1);
});

test('long prompt goes through a file', () => {
  const e = env({});
  const pf = path.join(e.dir, 'p.md');
  fs.writeFileSync(pf, 'y'.repeat(30000));
  const r = run(e, 'run', '--role', 'code', '--prompt-file', pf);
  assert.match(r.stdout, /status=DONE/);
  const p = calls(e)[0].args.at(-1);
  assert.match(p, /Your full task is in the file/);
});

test('background job can be waited on and cancelled', () => {
  const e = env({ models: { 'gemini-4-hydrogen-medium': 'sleep' } });
  const r = run(e, 'run', '--role', 'code', '--background', 'x');
  const id = r.stdout.match(/job=(\S+)/)[1];
  const w = run(e, 'wait', id, '--wait-sec', '4');
  assert.match(w.stdout, /still running/);
  assert.match(run(e, 'cancel', id).stdout, /cancelled/);
  assert.match(run(e, 'status', id).stdout, /CANCELLED/);
});
