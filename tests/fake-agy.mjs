#!/usr/bin/env node
// Fake agy for tests. Scenario JSON in $AGY_STUB_SCENARIO:
// { usage: {gemini:[w5h,weekly], '3p':[..], argon:[weekly]}, models: { "<model>": "ok" | "quota" | "fail" | "sleep" } }
import fs from 'node:fs';
const args = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(process.env.AGY_STUB_SCENARIO, 'utf8'));
fs.appendFileSync(process.env.AGY_STUB_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const p = get('-p');
const reset = new Date(Date.now() + 3600_000).toISOString();
if (p === '/usage') {
  const u = sc.usage || {};
  const b = (id, w, f) => ({ id, window: w, remaining_fraction: f, reset_time: reset });
  const groups = [
    { name: 'Gemini Models', buckets: [b('gemini-weekly', 'weekly', u.gemini?.[1] ?? 1), b('gemini-5h', '5h', u.gemini?.[0] ?? 1)] },
    { name: 'Claude and GPT models', buckets: [b('3p-weekly', 'weekly', u['3p']?.[1] ?? 1), b('3p-5h', '5h', u['3p']?.[0] ?? 1)] },
    { name: 'Gemini 4 Argon', buckets: [b('gemini-argon-wtu-weekly', 'weekly', u.argon?.[0] ?? 1)] },
  ];
  console.log(JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: '', command: { name: 'usage', data: { groups } } }));
  process.exit(0);
}
const model = get('--model');
const beh = sc.models?.[model] || 'ok';
const cid = get('--conversation') || 'conv-' + Math.random().toString(16).slice(2, 8);
if (beh === 'sleep') { setTimeout(() => {}, 600000); }
else if (beh === 'quota') {
  console.log('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): quota exceeded","status":"RESOURCE_EXHAUSTED","error_code":429}');
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'Resource has been exhausted (e.g. check quota).' }));
  process.exit(1);
} else if (beh === 'fail') {
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'boom' }));
  process.exit(1);
} else {
  console.log(JSON.stringify({ conversation_id: cid, status: 'SUCCESS', response: 'OK from ' + model + ' mode=' + (get('--mode') || 'default') + ' conv=' + cid + ' plen=' + p.length, usage: { total_tokens: 1 } }));
}
