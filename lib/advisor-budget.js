import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest } from './task-store.js'

export const MANUAL_ADVISOR_MARKER = '@codex'

const advisorError = (code, message) => Object.assign(new Error(message), { code })

// Use the native host's live-agent and open-turn contract. Model arguments
// cannot designate a different turn or grant permission for a manual call.
export function nativeAdvisorScope(agents, agent) {
  const session = agent?.session
  if (!session || typeof agent.id !== 'string' || agent.status !== 'running' ||
      agents?.get?.(agent.id) !== agent || agents?.currentInitiator?.() !== agent ||
      typeof session.eventAt !== 'function' || session.header?.origin === 'subagent') return null
  const start = agents.turnBoundaryOf?.(session)?.openTurnStartSeq
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(session.seq)) return null
  const opening = session.eventAt(start)
  if (opening?.type !== 'turn/start' || !Number.isSafeInteger(opening.data?.turn) ||
      !Number.isSafeInteger(session.header?.createdAt)) return null

  let human = null
  for (let seq = session.seq - 1; seq > start; seq--) {
    const event = session.eventAt(seq)
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      human = { seq, content: event.data.content }
      break
    }
  }
  if (!human) return null
  const firstText = Array.isArray(human.content) ? human.content.find(block => block?.type === 'text')?.text : ''
  const directive = typeof firstText === 'string' && firstText.trimStart().split(/\r?\n/, 1)[0].trimEnd() === MANUAL_ADVISOR_MARKER
  const turnKey = digest([agent.id, session.header.createdAt, opening.data.turn])
  return { turnKey, sessionId: agent.id, turn: opening.data.turn, manualSeq: directive ? human.seq : null }
}

function writeNew(path, value) {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// Reserve before invoking the runner. A lost result or an interrupted write
// leaves a used reservation, so a second process or reload cannot double-send.
export function createAdvisorBudget(directory, { logRuns = true } = {}) {
  return function reserve(scope, { kind, reason, question, input }) {
    const source = scope.manualSeq === null ? 'automatic' : 'manual'
    const id = digest([scope.turnKey, scope.manualSeq])
    const consultationId = 'consult-' + id
    const fingerprint = digest([kind, input])
    const claimPath = join(directory, id + '.claim.json')
    const resultPath = join(directory, id + '.result.json')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const startedAt = Date.now()
    const record = { consultationId, source, kind, fingerprint, startedAt }
    if (logRuns) Object.assign(record, { sessionId: scope.sessionId, turn: scope.turn, reason, question })

    try {
      writeNew(claimPath, record)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const claim = readRecord(claimPath)
      const previous = readRecord(resultPath)
      if (claim?.fingerprint === fingerprint && previous?.status === 'completed' && previous.value) {
        return { consultationId, source, replay: previous.value }
      }
      if (!previous) {
        throw advisorError('ADVISOR_IN_PROGRESS_OR_UNKNOWN', '本次咨询已登记，正在执行或结果未确认。保留已有结果并继续可确定的部分。')
      }
      throw advisorError('ADVISOR_BUDGET_USED', '本次专家咨询机会已用完。继续落实已有建议，或请用户发起一次新咨询。')
    }

    return {
      consultationId, source,
      finish(status, value) {
        const result = { consultationId, status, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt }
        if (logRuns && value) result.value = value
        writeNew(resultPath, result)
      },
    }
  }
}
