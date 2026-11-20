#!/usr/bin/env node
// MCP server "claude-team" for agy: lets an agy agent act as a member of a Claude Code agent team —
// message the lead / teammates, ask the lead a blocking question, read its inbox, use the shared task list.
// stdio JSON-RPC 2.0, newline-delimited; no dependencies.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const team = await import(pathToFileURL(path.join(here, 'team.mjs')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ID_PROPS = {
  as: { type: 'string', description: 'Your own team member name (given in your instructions).' },
  team: { type: 'string', description: 'Team name (given in your instructions).' },
};
const TOOLS = [
  { name: 'team_info', description: 'Who you are on the Claude Code agent team: team, lead, members, your task.', inputSchema: { type: 'object', properties: { ...ID_PROPS } } },
  { name: 'send_message', description: 'Send a message to the team lead ("team-lead") or a teammate by name. Not for your final report — that is delivered automatically.',
    inputSchema: { type: 'object', properties: { ...ID_PROPS, to: { type: 'string' }, message: { type: 'string' }, summary: { type: 'string', description: '5-10 word preview' } }, required: ['to', 'message'] } },
  { name: 'ask_lead', description: 'Ask the team lead a blocking question and wait for the answer (default up to 15 min). Use when a requirement is ambiguous or you are blocked, instead of guessing.',
    inputSchema: { type: 'object', properties: { ...ID_PROPS, question: { type: 'string' }, timeout_min: { type: 'number' } }, required: ['question'] } },
  { name: 'read_messages', description: 'Read (and mark read) new messages sent to you by the lead or teammates since your turn started.', inputSchema: { type: 'object', properties: { ...ID_PROPS } } },
  { name: 'list_tasks', description: 'The shared task list of the team: id, subject, status, owner, blockedBy.', inputSchema: { type: 'object', properties: { ...ID_PROPS } } },
  { name: 'update_task', description: 'Update a task on the shared list: take it (owner = you), set status pending|in_progress, or set activeForm (a short "what I am doing now"). Completion is decided by the lead from your report.',
    inputSchema: { type: 'object', properties: { ...ID_PROPS, id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress'] }, activeForm: { type: 'string' }, take: { type: 'boolean' } }, required: ['id'] } },
];

function identity(args) {
  const name = process.env.AGY_TEAM_MEMBER || args.as;
  const teamName = process.env.AGY_TEAM_NAME || args.team;
  if (!name || !teamName) throw new Error('You are not on a Claude Code agent team (no team/member identity). Ignore the team tools.');
  const m = team.findMember(teamName, name);
  if (!m || !team.isAgyMember(m)) throw new Error('"' + name + '" is not an agy member of team "' + teamName + '"');
  return { name, teamName };
}
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

async function call(nameOfTool, args = {}) {
  const { name, teamName } = identity(args);
  switch (nameOfTool) {
    case 'team_info': {
      const cfg = team.getConfig(teamName);
      return text({ you: name, team: teamName, lead: team.LEAD, members: cfg.members.map((m) => ({ name: m.name, type: m.agentType, backend: m.backendType })),
        yourTasks: team.listTasks(teamName).filter((t) => t.owner === name).map((t) => ({ id: t.id, subject: t.subject, status: t.status })) });
    }
    case 'send_message': {
      const to = String(args.to || '').trim();
      const cfg = team.getConfig(teamName);
      if (to !== team.LEAD && !cfg.members.some((m) => m.name === to)) throw new Error('no member "' + to + '"; members: ' + cfg.members.map((m) => m.name).join(', '));
      if (to === name) throw new Error('cannot message yourself');
      team.postMessage(teamName, to, name, String(args.message), { summary: args.summary });
      return text('sent to ' + to);
    }
    case 'ask_lead': {
      const sent = team.postMessage(teamName, team.LEAD, name, 'QUESTION (I am blocked until you answer — reply with SendMessage to "' + name + '"):\n' + args.question, { summary: 'question from ' + name });
      const deadline = Date.now() + Math.min(Number(args.timeout_min || 15), 60) * 60_000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const got = team.takeUnread(teamName, name, (m) => m.from === team.LEAD && !team.protocolOf(m) && m.timestamp >= sent.timestamp);
        if (got.length) return text('Answer from the lead:\n' + got.map((m) => m.text).join('\n\n'));
      }
      return text('No answer from the lead within the time limit. Proceed with your best judgment, and state the assumption you made in your final report.');
    }
    case 'read_messages': {
      const got = team.takeUnread(teamName, name, (m) => { const p = team.protocolOf(m); return !p || p.type === 'task_assignment'; });
      return text(got.length ? got.map((m) => 'From ' + m.from + ' (' + m.timestamp + '):\n' + m.text).join('\n\n---\n\n') : 'No new messages.');
    }
    case 'list_tasks':
      return text(team.listTasks(teamName).map((t) => ({ id: t.id, subject: t.subject, status: t.status, owner: t.owner || null, blockedBy: t.blockedBy || [] })));
    case 'update_task': {
      const patch = {};
      if (args.take) patch.owner = name;
      if (args.status) { if (!['pending', 'in_progress'].includes(args.status)) throw new Error('status must be pending or in_progress'); patch.status = args.status; }
      if (args.activeForm) patch.activeForm = String(args.activeForm).slice(0, 120);
      const t = team.listTasks(teamName).find((x) => String(x.id) === String(args.id));
      if (!t) throw new Error('no task #' + args.id);
      if (t.owner && t.owner !== name && !args.take) throw new Error('task #' + args.id + ' is owned by ' + t.owner);
      const r = team.updateTask(teamName, args.id, patch);
      return text({ id: r.id, status: r.status, owner: r.owner, activeForm: r.activeForm });
    }
    default: throw new Error('unknown tool ' + nameOfTool);
  }
}

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'claude-team', version: '1.0.0' } } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try { return send({ jsonrpc: '2.0', id, result: await call(params.name, params.arguments || {}) }); }
      catch (e) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } }); }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
