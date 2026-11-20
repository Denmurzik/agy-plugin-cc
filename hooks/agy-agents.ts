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

/** What reached the agent since its last answer: the spawn prompt, or the messages that woke it. */
export function pendingInput(messages: readonly { role: string; text: string }[]): string {
  let i = messages.length
  while (i > 0 && messages[i - 1]?.role === 'user') i--
  return messages
    .slice(i)
    .map(m => m.text.replace(REMINDER, '').trim())
    .filter(t => t !== '')
    .join('\n\n---\n\n')
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

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    const agent = await agyAgent($, id)
    if (agent === null) return yield* next(e)

    const env = await $.process.hookEnv()
    const companion = (env.CLAUDE_PLUGIN_ROOT ?? '') + '/scripts/agy-companion.mjs'
    const read = await $.session.messages({ agentId: id })
    const { cwd, body } = splitHeader(pendingInput(Array.isArray(read) ? read : []))
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
