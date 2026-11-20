// agy agents as real Claude Code agents: subagent types agy:code, agy:review and agy:recon.
// The engine runs them like any subagent or teammate (agent list, SendMessage, TaskStop, idle
// reports), but every model request of their loop is answered here by Antigravity CLI through the
// companion; no Claude model is called. agy's progress streams into the agent's view as thinking.
import type { EngineInterface, Register } from 'claude-code'

type Role = 'code' | 'review' | 'recon'
type AgyAgent = { role: Role; name: string; cwd: string }

const ROLES: Record<string, Role> = { 'agy:code': 'code', 'agy:review': 'review', 'agy:recon': 'recon' }
const known = new Map<string, AgyAgent | null>()

async function agyAgent($: EngineInterface, id: string): Promise<AgyAgent | null> {
  const hit = known.get(id)
  if (hit !== undefined) return hit
  const info = (await $.agent.list()).find(a => a.id === id)
  if (info === undefined) return null
  const role = ROLES[info.type]
  const agent = role === undefined ? null : { role, name: info.name ?? info.id, cwd: info.cwd }
  known.set(id, agent)
  return agent
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const ENVELOPE = /<teammate-message\s+([^>]*)>\n?([\s\S]*?)\n?<\/teammate-message>/g

type Msg = { role: string; text: string; toolResults?: readonly unknown[] }
/** One message that woke the agent: plain text, or a team protocol frame (task_assignment, shutdown_request…). */
export type Incoming = { from: string; text: string; protocol?: Record<string, unknown> }

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(name + '="([^"]*)"').exec(attrs)?.[1]
}

/** The messages since the agent's last answer, unwrapped from the engine's teammate envelopes. */
export function incoming(messages: readonly Msg[]): Incoming[] {
  let i = messages.length
  while (i > 0 && messages[i - 1]?.role === 'user') i--
  const out: Incoming[] = []
  for (const m of messages.slice(i)) {
    const text = m.text.replace(REMINDER, '').trim()
    if (text === '') continue
    let matched = false
    for (const env of text.matchAll(ENVELOPE)) {
      matched = true
      const from = attr(env[1] ?? '', 'teammate_id') ?? 'team-lead'
      const body = (env[2] ?? '').trim()
      let protocol: Record<string, unknown> | undefined
      try {
        const p: unknown = JSON.parse(body)
        if (typeof p === 'object' && p !== null && typeof (p as { type?: unknown }).type === 'string') protocol = p as Record<string, unknown>
      } catch { /* plain text */ }
      out.push({ from, text: body, ...(protocol === undefined ? {} : { protocol }) })
    }
    if (!matched) out.push({ from: 'team-lead', text })
  }
  return out
}

/** Whether the newest user message only carries tool results (our own SendMessage came back). */
export function onlyToolResults(messages: readonly Msg[]): boolean {
  const last = messages[messages.length - 1]
  return last?.role === 'user' && (last.toolResults?.length ?? 0) > 0 && last.text.replace(REMINDER, '').trim() === ''
}

/** The prompt for agy: plain messages as they are, a first task assignment as a task, other frames dropped. */
export function promptFrom(items: readonly Incoming[], hasAnswered: boolean): string {
  const parts: string[] = []
  for (const it of items) {
    const p = it.protocol
    if (p === undefined) parts.push(it.from === 'team-lead' ? it.text : 'Message from teammate ' + it.from + ':\n' + it.text)
    else if (p.type === 'task_assignment' && !hasAnswered) parts.push('Your task #' + String(p.taskId) + ': ' + String(p.subject ?? '') + '\n' + String(p.description ?? ''))
  }
  return parts.join('\n\n---\n\n').trim()
}

/** Optional header lines on top of a prompt: "agy-cwd: <dir>" (and the legacy proxy header). */
export function splitHeader(text: string): { cwd?: string; body: string } {
  const lines = text.split('\n')
  let cwd: string | undefined
  let i = 0
  while (i < lines.length) {
    const m = /^\s*agy-(cwd|name|role)\s*:\s*(.*)$/i.exec(lines[i] ?? '')
    if (m === null) break
    if (m[1]?.toLowerCase() === 'cwd' && (m[2] ?? '').trim() !== '') cwd = (m[2] ?? '').trim()
    i++
  }
  if (i > 0 && (lines[i] ?? '').trim() === '---') i++
  return { ...(cwd === undefined ? {} : { cwd }), body: lines.slice(i).join('\n').trim() }
}

type Done = { status: string; model: string | null; header: string; text: string }

let seq = 0

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    const agent = await agyAgent($, id)
    if (agent === null) return yield* next(e)

    const read = await $.session.messages({ agentId: id })
    const messages = Array.isArray(read) ? read : []
    const quiet = (text: string) => ({ turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null })

    // Our own SendMessage (a shutdown approval) came back: the turn is over, agy is not asked.
    if (onlyToolResults(messages)) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return quiet('')
    }
    const items = incoming(messages)
    // A shutdown request is approved natively, as the teammate's own SendMessage.
    const shutdown = items.find(it => it.protocol?.type === 'shutdown_request')
    if (shutdown !== undefined) {
      const input = { to: shutdown.from, message: { type: 'shutdown_response', request_id: String(shutdown.protocol?.requestId ?? shutdown.protocol?.request_id ?? ''), approve: true } }
      const callId = 'toolu_agy_' + Date.now().toString(36) + (seq++).toString(36)
      yield { kind: 'tool', index: 0, id: callId, name: 'SendMessage' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SendMessage', input }], stopReason: 'tool_use', usage: null }
    }
    const hasAnswered = messages.some(m => m.role === 'assistant')
    const prompt = promptFrom(items, hasAnswered)
    // Only harness notifications woke it (a task assignment of work it already did, an idle ping): no agy run.
    if (prompt === '') {
      const text = hasAnswered ? 'ok' : 'No task received yet.'
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return quiet(text)
    }

    const env = await $.process.hookEnv()
    const companion = (env.CLAUDE_PLUGIN_ROOT ?? '') + '/scripts/agy-companion.mjs'
    const { cwd, body } = splitHeader(prompt)
    const input = body === '' ? 'Continue.' : body
    const argv = ['node', companion, 'run', '--name', 'cc-' + id, '--role', agent.role, '--cwd', cwd ?? agent.cwd, '--stream', '--prompt-stdin']

    let jobId: string | undefined
    let done: Done | undefined
    let buf = ''
    yield { kind: 'thinking', index: 0, text: 'agy · ' + agent.role + ' · starting\n' }
    try {
      for await (const piece of $.process.spawn({ argv, env, input })) {
        if (piece.stream !== 'stdout') continue
        buf += piece.text
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          nl = buf.indexOf('\n')
          if (line.startsWith('@job ')) jobId = line.slice(5).trim()
          else if (line.startsWith('@progress ')) yield { kind: 'thinking', index: 0, text: 'agy · ' + line.slice(10) + '\n' }
          else if (line.startsWith('@done ')) {
            try { done = JSON.parse(line.slice(6)) as Done } catch { /* keep looking */ }
          }
        }
      }
    } finally {
      // interrupted or stopped (TaskStop, Esc): stop agy too, the companion runs it detached
      if (done === undefined && jobId !== undefined) {
        await $.process.run(['node', companion, 'cancel', jobId], { env }).catch(() => undefined)
      }
    }

    const answer = done === undefined
      ? 'agy FAILED: the companion ended without a result' + (jobId === undefined ? ' (could not start agy: is node/agy on PATH?)' : ' (job ' + jobId + ')') + '.'
      : (done.status === 'done' ? done.text : done.header.replace(/^\[agy\]\s*/, '') + '\n' + done.text)
    yield { kind: 'text', index: 1, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })
}
