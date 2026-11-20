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
const STREAM = get('--output-format') === 'stream-json';
if (STREAM) {
  const origLog = console.log;
  console.log = (s) => {
    if (typeof s === 'string' && s.startsWith('{')) {
      const o = JSON.parse(s);
      if (!o.event) return origLog(JSON.stringify({ event: 'result', result: o }));
    }
    origLog(s);
  };
}
let beh = sc.models?.[model] || 'ok';
if (Array.isArray(beh)) {
  const n = fs.readFileSync(process.env.AGY_STUB_CALLS, 'utf8').trim().split('\n').filter((l) => JSON.parse(l).args.includes(model)).length - 1;
  beh = beh[Math.min(n, beh.length - 1)];
}
const cid = get('--conversation') || 'conv-' + Math.random().toString(16).slice(2, 8);
if (STREAM) console.log(JSON.stringify({ event: 'init', conversation_id: cid }));
if (beh === 'sleep') { setTimeout(() => {}, 600000); }
else if (beh === 'hang') { setTimeout(() => {}, 600000); }
else if (beh === 'hang-tool') {
  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm run test:int' } } } }));
  setTimeout(() => {}, 600000);
}
else if (beh === 'quota') {
  console.log('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): quota exceeded","status":"RESOURCE_EXHAUSTED","error_code":429}');
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'Resource has been exhausted (e.g. check quota).' }));
  process.exit(1);
} else if (beh === 'capacity') {
  console.log('AGY_ERROR: {"short_error":"UNAVAILABLE (code 503): No capacity available for model ' + model + ' on the server","status":"UNAVAILABLE","error_code":503,"retryable":true}');
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'No capacity available for model ' + model + ' on the server' }));
  process.exit(3);
} else if (beh === 'quota-progress') {
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' } }));
  console.log('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429}');
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'Individual quota reached.' }));
  process.exit(3);
} else if (beh === 'eof-progress') {
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' } }));
  console.log('AGY_ERROR: {"short_error":"request failed: EOF","status":"UNKNOWN","retryable":true}');
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: 'partial', error: 'There was a network issue connecting to the server, please try again.' }));
  process.exit(3);
} else if (beh === 'eof' || beh === 'eof-final' || beh === 'malformed') {
  if (beh !== 'malformed') console.log('AGY_ERROR: {"short_error":"agent executor error: request failed: Post \\"https://x/v1internal:streamGenerateContent?alt=sse\\": EOF","status":"UNKNOWN","error_code":2,"retryable":true}');
  const error = beh === 'malformed' ? 'Your previous response contained an improperly formatted function call: Malformed function call: Function call is empty' : 'There was a network issue connecting to the server, please try again.';
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: beh === 'eof-final' ? 'STATUS: DONE\nall good' : 'working on it', error }));
  process.exit(3);
} else if (beh === 'print-timeout') {
  console.log('AGY_ERROR: {"short_error":"print timeout after 30m0s with the turn still in progress; the response is partial","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}');
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'The stream was interrupted. Please continue the task you were working on.' }));
  process.exit(3);
} else if (beh === 'write-fail') {
  fs.writeFileSync('agy-was-here.txt', 'x');
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'boom' }));
  process.exit(1);
} else if (beh === 'fail') {
  console.log(JSON.stringify({ conversation_id: cid, status: 'ERROR', response: '', error: 'boom' }));
  process.exit(1);
} else {
  console.log(JSON.stringify({ conversation_id: cid, status: 'SUCCESS', response: 'OK from ' + model + ' mode=' + (get('--mode') || 'default') + ' conv=' + cid + ' plen=' + p.length, usage: { total_tokens: 1 } }));
}
