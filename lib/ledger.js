/**
 * Append-only ledger of DSH sessions started by Codex through the reverse bridge.
 *
 * Required because those sessions are created programmatically (sessionController)
 * and never attached to a workspace, so the main sidebar has no row for them.
 * The ledger is the durable record the "Codex" conversation view lists; live
 * state (`running`) is derived by folding start/end lines per session id.
 *
 * File: ~/.dsh/codex-bridge/codex-sessions.jsonl (best effort, never throws).
 *
 * @module @local/dsh-codex-bridge/ledger
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Only this process's admitted work may be labelled live. Historical start-only
// lines cannot prove a task is still running after restart or ledger rotation.
const liveStates = (globalThis.__dshCodexBridgeLedgerLive ??= new Map())
const MAX_BYTES = 4 * 1024 * 1024
const MAX_TASK_CHARS = 4_000
const MAX_TEXT_CHARS = 4_000

export function ledgerPath() {
  return join(homedir(), '.dsh', 'codex-bridge', 'codex-sessions.jsonl')
}

function rotateIfNeeded(path) {
  try {
    if (!existsSync(path)) return
    if (statSync(path).size <= MAX_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {
    /* rotation is best effort */
  }
}

function clip(value, limit) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * Append one ledger line. Never throws: a broken ledger must not fail execution.
 * @param {Record<string, unknown>} record
 */
export function appendLedger(record) {
  try {
    const path = ledgerPath()
    mkdirSync(dirname(path), { recursive: true })
    rotateIfNeeded(path)
    appendFileSync(path, `${JSON.stringify({ v: 1, at: Date.now(), ...record })}\n`, 'utf8')
  } catch {
    /* best effort */
  }
}

/** Project the resolved model policy into a small, secret-free ledger block. */
function executionOf(execution) {
  if (!execution || typeof execution !== 'object' || !execution.selection || typeof execution.selection !== 'object') return undefined
  const selection = execution.selection
  if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
  return {
    provider: clip(selection.provider, 120),
    model: clip(selection.model, 200),
    ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: clip(selection.reasoningEffort, 80) } : {}),
    policyRevision: Number(execution.policyRevision) || 0,
    modelMode: typeof execution.modelMode === 'string' ? clip(execution.modelMode, 40) : '',
    effortMode: typeof execution.effortMode === 'string' ? clip(execution.effortMode, 40) : '',
    effortSource: typeof execution.effortSource === 'string' ? clip(execution.effortSource, 40) : '',
    ...(typeof execution.permissionMode === 'string' ? { permissionMode: clip(execution.permissionMode, 40) } : {}),
    ...(typeof execution.reason === 'string' && execution.reason !== '' ? { reason: clip(execution.reason, 500) } : {}),
  }
}

/** Start record for one reverse-bridge execution. */
export function recordStart({ sessionId, task, cwd, preset, timeoutMs, workspaceId, execution }) {
  const model = executionOf(execution)
  liveStates.set(sessionId, 'running')
  appendLedger({
    phase: 'start',
    sessionId: String(sessionId ?? ''),
    task: clip(task, MAX_TASK_CHARS),
    cwd: typeof cwd === 'string' ? cwd : '',
    preset: typeof preset === 'string' ? preset : '',
    timeoutMs: Number(timeoutMs) || 0,
    ...(typeof workspaceId === 'string' && workspaceId !== '' ? { workspaceId } : {}),
    ...(model ? { execution: model } : {}),
  })
}

/** Nonterminal state is durable but never a fabricated terminal result. */
export function recordState({ sessionId, state, question }) {
  liveStates.set(sessionId, state)
  appendLedger({ phase: 'state', sessionId, state, ...(question ? { question } : {}) })
}

/** Terminal record for one reverse-bridge execution. */
export function recordEnd({ sessionId, stopReason, elapsedMs, text, error }) {
  liveStates.delete(sessionId)
  appendLedger({
    phase: 'end',
    sessionId: String(sessionId ?? ''),
    stopReason: typeof stopReason === 'string' ? stopReason : 'unknown',
    elapsedMs: Number(elapsedMs) || 0,
    text: clip(text, MAX_TEXT_CHARS),
    ...(error ? { error: clip(error, 1_000) } : {}),
  })
}

/**
 * Read and fold the ledger: one entry per session, newest first.
 * @param {{ limit?: number }} [options]
 */
export function readSessions({ limit = 200, includeArchive = false } = {}) {
  const path = ledgerPath()
  let raw = ''
  try {
    raw = (includeArchive && existsSync(`${path}.1`) ? readFileSync(`${path}.1`, 'utf8') + '\n' : '') + (existsSync(path) ? readFileSync(path, 'utf8') : '')
  } catch {
    return []
  }
  const byId = new Map()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.startsWith('{')) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!['start', 'state', 'end'].includes(record.phase)) continue
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    if (sessionId === '') continue
    const current = byId.get(sessionId) ?? { sessionId }
    if (record.phase === 'start') {
      current.task = typeof record.task === 'string' ? record.task : current.task ?? ''
      current.cwd = typeof record.cwd === 'string' && record.cwd ? record.cwd : current.cwd ?? ''
      current.preset = typeof record.preset === 'string' && record.preset ? record.preset : current.preset ?? ''
      current.state = 'running'
      delete current.endedAt
      delete current.stopReason
      delete current.text
      delete current.error
      delete current.question
      current.timeoutMs = Number(record.timeoutMs) || current.timeoutMs || 0
      if (record.execution && typeof record.execution === 'object') current.execution = record.execution
      if (typeof record.workspaceId === 'string' && record.workspaceId !== '') current.workspaceId = record.workspaceId
      current.startedAt = Number(record.at) || current.startedAt || 0
    } else if (record.phase === 'state') {
      current.state = record.state
      if (record.question) current.question = record.question
      else delete current.question
    } else if (record.phase === 'end') {
      current.state = record.stopReason
      delete current.question
      current.endedAt = Number(record.at) || current.endedAt || 0
      current.stopReason = typeof record.stopReason === 'string' ? record.stopReason : current.stopReason ?? ''
      current.elapsedMs = Number(record.elapsedMs) || current.elapsedMs || 0
      current.text = typeof record.text === 'string' ? record.text : current.text ?? ''
      if (typeof record.error === 'string') current.error = record.error
    }
    byId.set(sessionId, current)
  }
  for (const session of byId.values()) {
    if (!session.endedAt && !liveStates.has(session.sessionId)) {
      session.state = 'unknown'
      delete session.question
    }
  }
  const sessions = [...byId.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return sessions.slice(0, Math.max(1, limit))
}

/** Group sessions by working directory (project). */
export function groupByProject(sessions) {
  const groups = new Map()
  for (const session of sessions) {
    const cwd = session.cwd || ''
    const key = cwd || '(未指定工作目录)'
    const group = groups.get(key) ?? { cwd, key, sessions: [], lastAt: 0 }
    group.sessions.push(session)
    group.lastAt = Math.max(group.lastAt, session.startedAt || 0, session.endedAt || 0)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt)
}

