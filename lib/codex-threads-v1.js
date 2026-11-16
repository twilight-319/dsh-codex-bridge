/**
 * Codex thread browser for DSH: list the machine's Codex threads, read one
 * thread's transcript, and continue the *same* thread across turns so the
 * prompt cache keeps hitting.
 *
 * Wire protocol (verified against codex-cli 0.166.0 on this machine,
 * `codex app-server --stdio`, JSON-RPC 2.0 newline framed):
 *   → initialize {clientInfo, capabilities}   ← {userAgent, codexHome, …}
 *   → initialized                              (notification)
 *   → thread/list  {limit, searchTerm?, cursor?, useStateDbOnly?}
 *                                              ← {data:[Thread], nextCursor, …}
 *   → thread/read  {threadId, includeTurns:true}
 *                                              ← {thread:{…, turns:[{items}]}}
 *   → thread/start {cwd, approvalPolicy, sandbox}          ← {thread:{id,…}}
 *   → thread/resume{threadId, excludeTurns:true, approvalPolicy, sandbox}
 *                                              ← {thread:{id,…}}  (loads the thread)
 *   → turn/start   {threadId, input:[{type:"text",text,text_elements:[]}]}
 *                                              ← {turn:{id,…}}
 *   ← item/completed {threadId, turnId, item:{type:"agentMessage", text, phase}}
 *   ← thread/tokenUsage/updated {threadId, turnId, tokenUsage:{last,total,…}}
 *   ← turn/completed {threadId, turn:{id,status,items,error,…}}
 *
 * Design notes:
 *  - One long-lived app-server process, lazily spawned, shared by list/read/send.
 *  - `make sure the thread is loaded` before the first turn of a thread
 *    (`thread/resume`) and remember the mapping input id → canonical id, so a
 *    second send on the same thread is a plain `turn/start` on a loaded thread
 *    (that reuse is what makes the prompt cache hit).
 *  - `list` prefers `useStateDbOnly:true` (the state DB is authoritative and
 *    fast) and falls back to the rollout scan variant when the DB is empty or
 *    rejected. See docs/codex-threads-notes.md for the measured differences.
 *  - Only this turn's assistant text is returned: ranked agentMessage items
 *    (final_answer > partial_answer > no phase); commentary and history never
 *    leak into `answer`.
 *  - Timeout / abort kills the whole process tree; a failed session is
 *    discarded and the next call spawns a fresh app-server (no auto-resume of
 *    the interrupted thread).
 *  - No `@deepseek-ai/*` imports and no local imports: `node:` built-ins only,
 *    so this module can be loaded inside the DSH host as-is.
 *
 * @module @local/dsh-codex-bridge/codex-threads-v1
 */
import { spawn, spawnSync } from 'node:child_process'

const CLIENT_INFO = Object.freeze({
  name: 'dsh-codex-bridge',
  title: 'DSH Codex Bridge',
  version: '0.1.0',
})

const DEFAULT_TURN_TIMEOUT_MS = 180_000
const DEFAULT_LIST_LIMIT = 100
/** One JSON-RPC frame that never gets a newline is treated as stream corruption. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024
const MAX_BAD_FRAMES = 5
const MAX_PAGES = 20
const MAX_BUFFERED_TURNS = 8
/** How long a timed-out / aborted turn may take to stop before the tree is killed. */
const INTERRUPT_GRACE_MS = 3_000

const PHASE_RANK = Object.freeze({ final_answer: 3, partial_answer: 2 })

/** Answer shapes for the server→client requests Codex may send while a turn runs. */
const SERVER_REQUEST_REPLIES = Object.freeze({
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
  'item/tool/requestUserInput': { answers: {} },
  'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function truncate(text, limit) {
  const value = typeof text === 'string' ? text : String(text)
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** @param {string} code @param {string} message @param {object} [extra] */
function threadsError(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra) Object.assign(error, extra)
  return error
}

function abortError(signal) {
  const error = new Error('codex thread send aborted')
  error.name = 'AbortError'
  error.code = 'aborted'
  error.cause = signal?.reason
  return error
}

/** Kill a Codex process and every child it spawned (its sandbox helpers). */
function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* process already gone */
  }
}

function toMillis(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : 0
}

function firstLine(text) {
  if (typeof text !== 'string') return ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

function sourceLabel(source) {
  if (typeof source === 'string') return source
  if (isPlainObject(source)) {
    if (typeof source.custom === 'string') return 'custom'
    if (source.subAgent !== undefined) return 'subAgent'
  }
  return undefined
}

function normalizeBin(input) {
  if (typeof input === 'string' && input !== '') return { command: input, prefix: [] }
  if (isPlainObject(input) && typeof input.command === 'string' && input.command !== '') {
    return { command: input.command, prefix: Array.isArray(input.prefix) ? input.prefix.map(String) : [] }
  }
  const fromEnv = process.env.CODEX_BRIDGE_CODEX_EXE
  if (typeof fromEnv === 'string' && fromEnv !== '') return { command: fromEnv, prefix: [] }
  throw new TypeError(
    'createCodexThreads: options.bin must be a command string or { command, prefix } (pass resolveCodexBin() from lib/codex.js)',
  )
}

function clampLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(Math.floor(parsed), 500)
}

function requireThreadId(value, method) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw threadsError('bad-request', `${method} requires a non-empty threadId string`)
  }
  return value
}

/** Every text-bearing part of a userMessage item, in order. */
function userMessageText(item) {
  const parts = Array.isArray(item.content) ? item.content : []
  const chunks = []
  for (const part of parts) {
    if (!isPlainObject(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') chunks.push(part.text)
    else if (part.type === 'localImage' || part.type === 'image') chunks.push('[image]')
    else if (part.type === 'audio' || part.type === 'localAudio') chunks.push('[audio]')
    else if (part.type === 'skill') chunks.push(`[skill:${typeof part.name === 'string' ? part.name : ''}]`)
    else if (typeof part.type === 'string') chunks.push(`[${part.type}]`)
  }
  return chunks.join('\n').trim()
}

/** A thread's display name: stored title, else the first line of `preview`. */
function threadName(thread) {
  if (typeof thread.name === 'string' && thread.name.trim() !== '') return thread.name
  const line = firstLine(thread.preview)
  if (line !== '') return line.length > 160 ? `${line.slice(0, 160)}…` : line
  return typeof thread.id === 'string' ? thread.id : ''
}

function mapThreadRow(row) {
  const mapped = {
    id: row.id,
    name: threadName(row),
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    // App-server reports Unix timestamps in seconds; JS callers get milliseconds.
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
  const source = sourceLabel(row.source)
  if (source !== undefined) mapped.source = source
  if (typeof row.model === 'string' && row.model !== '') mapped.model = row.model
  return mapped
}

/** Map `thread.read(...).thread` to the flat message list of the public contract. */
function readThreadMessages(thread) {
  const messages = []
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  for (const turn of turns) {
    if (!isPlainObject(turn)) continue
    const items = Array.isArray(turn.items) ? turn.items : []
    const turnFallbackAt = toMillis(turn.startedAt) || undefined
    const batch = []
    items.forEach((item, index) => {
      if (!isPlainObject(item) || typeof item.type !== 'string') return
      let role = null
      let text = ''
      if (item.type === 'userMessage') {
        role = 'user'
        text = userMessageText(item)
      } else if (item.type === 'agentMessage') {
        role = 'assistant'
        text = typeof item.text === 'string' ? item.text : ''
      }
      if (role === null || text === '') return
      const message = {
        id: typeof item.id === 'string' && item.id !== '' ? item.id : `${typeof turn.id === 'string' ? turn.id : 'turn'}:${index}`,
        role,
        text,
      }
      const at = typeof item.startedAtMs === 'number' ? item.startedAtMs : typeof item.completedAtMs === 'number' ? item.completedAtMs : turnFallbackAt
      if (typeof at === 'number') message.at = at
      if (role === 'assistant' && typeof item.phase === 'string') message.phase = item.phase
      batch.push({ index, message })
    })
    // Items are not guaranteed to be stored chronologically (tool items are
    // appended out of order); sort only the text messages by timestamp.
    batch.sort((a, b) => {
      const atA = typeof a.message.at === 'number' ? a.message.at : Number.POSITIVE_INFINITY
      const atB = typeof b.message.at === 'number' ? b.message.at : Number.POSITIVE_INFINITY
      if (atA !== atB) return atA < atB ? -1 : 1
      return a.index - b.index
    })
    for (const entry of batch) messages.push(entry.message)
  }
  return messages
}

/**
 * Rank one thread item as a candidate answer. `commentary` (progress narration)
 * and unknown phases are never answers; a missing phase is the legacy fallback.
 */
function messageRank(item) {
  if (!isPlainObject(item) || item.type !== 'agentMessage' || typeof item.text !== 'string') return 0
  const phase = item.phase
  if (phase === 'final_answer') return PHASE_RANK.final_answer
  if (phase === 'partial_answer') return PHASE_RANK.partial_answer
  if (phase === null || phase === undefined) return 1
  return 0
}

/** `thread/tokenUsage/updated` → the public `usage` object (per-turn `last` first). */
function normalizeTurnUsage(tokenUsage) {
  if (!isPlainObject(tokenUsage)) return null
  const last = isPlainObject(tokenUsage.last) ? tokenUsage.last : null
  const total = isPlainObject(tokenUsage.total) ? tokenUsage.total : null
  if (last === null && total === null) return null
  const pick = (key) => {
    if (last !== null && typeof last[key] === 'number') return last[key]
    if (total !== null && typeof total[key] === 'number') return total[key]
    return 0
  }
  return {
    inputTokens: pick('inputTokens'),
    cachedInputTokens: pick('cachedInputTokens'),
    outputTokens: pick('outputTokens'),
  }
}

/**
 * Create one Codex thread browser session.
 *
 * @param {{
 *   bin: string | { command: string, prefix?: string[] },
 *   cwd?: string,
 *   logger?: { warn?: (message: string) => void, debug?: (message: string) => void },
 * }} options
 * @returns {{
 *   list(request?: { limit?: number, searchTerm?: string }): Promise<{ threads: Array<{ id: string, name: string, cwd: string, createdAt: number, updatedAt: number, source?: string, model?: string }> }>,
 *   read(request: { threadId: string }): Promise<{ thread: { id: string, name: string, cwd: string, turns: Array<{ id: string, role: 'user'|'assistant'|'system', text: string, at?: number, phase?: string }> } }>,
 *   send(request: { threadId: string, text: string, timeoutMs?: number, signal?: AbortSignal }): Promise<{ threadId: string, answer: string, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number } | null, elapsedMs: number }>,
 *   startThread(request?: { cwd?: string }): Promise<{ threadId: string }>,
 *   dispose(): Promise<void>,
 * }}
 */
export function createCodexThreads(options = {}) {
  const bin = normalizeBin(options.bin)
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
  const logger = options.logger ?? {}

  const logDebug = (message) => {
    try {
      logger.debug?.(`codex-bridge(threads): ${message}`)
    } catch {
      /* a broken logger must not break the session */
    }
  }
  const logWarn = (message) => {
    try {
      logger.warn?.(`codex-bridge(threads): ${message}`)
    } catch {
      /* ignore */
    }
  }

  // ---- process / protocol state -------------------------------------------
  /** @type {null | ReturnType<typeof spawnSession>} */
  let session = null
  let startPromise = null
  let disposed = false
  let disposePromise = null
  let nextRequestId = 1
  /** @type {null | ReturnType<typeof makeTurnState>} */
  let activeTurn = null
  /** input thread id → canonical thread id returned by thread/resume. */
  const resumedThreads = new Map()
  /** Serializes turns; the app-server runs one turn at a time. */
  let sendChain = Promise.resolve()

  const logDebugSafe = (message) => logDebug(message)

  function sessionDeadError(s) {
    const reason = s?.deadReason
    return threadsError(
      'session-dead',
      reason ? `codex app-server session is dead (${reason.code}): ${reason.message}` : 'codex app-server session is dead',
    )
  }

  function writeFrame(s, frame) {
    const proc = s?.proc
    if (!proc || !proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded) throw sessionDeadError(s)
    proc.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  function requestRpc(method, params, targetSession = null) {
    const s = targetSession ?? session
    if (s === null || s.dead || !s.proc || s.proc.exitCode !== null) return Promise.reject(sessionDeadError(s))
    const id = nextRequestId++
    return new Promise((resolve, reject) => {
      s.pending.set(id, { resolve, reject, method })
      try {
        writeFrame(s, { jsonrpc: '2.0', id, method, params })
      } catch (error) {
        s.pending.delete(id)
        reject(error instanceof Error ? error : sessionDeadError(s))
      }
    })
  }

  function notify(s, method, params) {
    writeFrame(s, params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /** Mark the session unusable, reject every pending request and the active turn. */
  function markSessionDead(s, code, message) {
    if (s.dead) return
    s.dead = true
    s.deadReason = { code, message }
    logWarn(`session dead (${code}): ${truncate(message, 400)}`)
    for (const entry of s.pending.values()) entry.reject(sessionDeadError(s))
    s.pending.clear()
    if (activeTurn !== null && activeTurn.session === s && !activeTurn.settled) activeTurn.fail(sessionDeadError(s))
  }

  /** Kill the process tree, then mark the session dead. */
  function terminateSession(code, message) {
    const s = session
    session = null
    if (s === null) return
    if (s.proc) {
      try {
        killTree(s.proc.pid)
      } catch {
        /* already gone */
      }
    }
    markSessionDead(s, code, message)
    // A fresh process has no loaded threads; a later call resumes again.
    resumedThreads.clear()
  }

  // ---- stdout framing -----------------------------------------------------
  function onStdout(s, chunk) {
    s.buffer = s.buffer.length === 0 ? chunk : Buffer.concat([s.buffer, chunk])
    let offset = 0
    for (;;) {
      const newline = s.buffer.indexOf(0x0a, offset)
      if (newline === -1) break
      const frame = s.buffer.subarray(offset, newline)
      offset = newline + 1
      if (frame.length > MAX_FRAME_BYTES) {
        terminateSession('protocol-error', `json-rpc frame of ${frame.length} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`)
        return
      }
      const line = frame.toString('utf8').replace(/\r$/, '')
      if (line.trim() !== '') handleLine(s, line)
      if (session !== s) return
    }
    if (offset > 0) s.buffer = s.buffer.subarray(offset)
    if (s.buffer.length > MAX_FRAME_BYTES) {
      terminateSession('protocol-error', `json-rpc frame exceeded ${MAX_FRAME_BYTES} bytes without a newline`)
    }
  }

  function handleLine(s, line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      s.badFrames += 1
      logWarn(`unparsable stdio frame #${s.badFrames}: ${truncate(line, 200)} (${error instanceof Error ? error.message : String(error)})`)
      if (s.badFrames > MAX_BAD_FRAMES) terminateSession('protocol-error', `too many unparsable json-rpc frames (${s.badFrames})`)
      return
    }
    if (!isPlainObject(message)) return
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) handleServerRequest(s, message)
      else if (session === s) handleNotification(message.method, message.params ?? {})
      return
    }
    if (message.id !== undefined && message.id !== null) {
      handleResponse(s, message)
      return
    }
    logDebug(`ignored frame without method/id: ${truncate(line, 160)}`)
  }

  function handleResponse(s, message) {
    const entry = s.pending.get(message.id)
    if (!entry) {
      logDebug(`response for unknown request id ${String(message.id)}`)
      return
    }
    s.pending.delete(message.id)
    if (message.error) {
      const detail = isPlainObject(message.error) ? message.error.message ?? 'unknown error' : String(message.error)
      // "already has an active writer": the thread is open in another client
      // (Codex Desktop / another app-server). A normal, recoverable condition.
      const busy = /already has an active writer/i.test(detail)
      const code = busy ? 'thread-busy' : entry.method === 'turn/start' ? 'turn-start-rejected' : 'rpc-error'
      const extra = { rpcError: message.error, method: entry.method }
      if (isPlainObject(message.error) && typeof message.error.code === 'number') extra.rpcCode = message.error.code
      entry.reject(threadsError(code, `codex app-server error for ${entry.method}: ${detail}`, extra))
      return
    }
    entry.resolve(message.result)
  }

  function handleServerRequest(s, message) {
    const reply = Object.hasOwn(SERVER_REQUEST_REPLIES, message.method) ? SERVER_REQUEST_REPLIES[message.method] : undefined
    try {
      if (reply !== undefined) {
        logDebug(`declining server request ${message.method}`)
        writeFrame(s, { jsonrpc: '2.0', id: message.id, result: reply })
      } else {
        logWarn(`unsupported server request ${message.method}; replying -32601`)
        writeFrame(s, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not supported: ${message.method}` },
        })
      }
    } catch {
      /* session already dead: nothing to reply to */
    }
  }

  // ---- notifications ------------------------------------------------------
  function handleNotification(method, params) {
    switch (method) {
      case 'turn/completed':
        onTurnCompleted(params)
        return
      case 'item/completed':
        onItemCompleted(params)
        return
      case 'thread/tokenUsage/updated':
        onUsageUpdated(params)
        return
      case 'error':
        logWarn(`app-server error notification: ${truncate(JSON.stringify(params), 400)}`)
        return
      default:
        // thread/started, turn/started, status changes, rate limits, MCP startup…
        logDebug(`notification ${method}`)
    }
  }

  // ---- turn bookkeeping ---------------------------------------------------
  function makeTurnState(targetSession, threadId, signal, startedAt, timeoutMs) {
    return {
      session: targetSession,
      threadId,
      turnId: null,
      settled: false,
      signal,
      startedAt,
      timeoutMs,
      timer: null,
      abortListener: null,
      /** @type {Map<string, { rank: number, text: string }>} best agentMessage per turn id */
      texts: new Map(),
      /** @type {any} latest thread/tokenUsage/updated payload for this turn */
      usage: null,
      /** @type {Map<string, any>} turn/completed that raced ahead of the turn/start response */
      completions: new Map(),
      /** @type {((error: Error | null, value?: any) => void) | null} */
      finish: null,
      /** @type {((error: Error) => void) | null} */
      fail: null,
    }
  }

  function activeStateFor(params) {
    const state = activeTurn
    if (state === null || state.settled) return null
    const paramThread = params?.threadId
    if (typeof paramThread === 'string' && paramThread !== state.threadId) return null
    return state
  }

  function considerMessage(state, turnKey, item) {
    const rank = messageRank(item)
    if (rank === 0) return
    let best = state.texts.get(turnKey)
    if (best === undefined) {
      if (state.texts.size >= MAX_BUFFERED_TURNS) return
      best = { rank: 0, text: '' }
      state.texts.set(turnKey, best)
    }
    if (rank >= best.rank) {
      best.rank = rank
      best.text = item.text
    }
  }

  function onItemCompleted(params) {
    const state = activeStateFor(params)
    if (state === null) return
    const turnKey = params?.turnId
    if (typeof turnKey !== 'string') return
    if (state.turnId !== null && turnKey !== state.turnId) return
    considerMessage(state, turnKey, params.item)
  }

  function onUsageUpdated(params) {
    const state = activeStateFor(params)
    if (state === null) return
    const turnKey = params?.turnId
    if (typeof turnKey !== 'string') return
    if (state.turnId !== null && turnKey !== state.turnId) return
    // Last notification for this turn wins: it is the turn's final tally.
    state.usage = params.tokenUsage
  }

  function onTurnCompleted(params) {
    const state = activeStateFor(params)
    if (state === null) return
    const turn = params?.turn
    if (!isPlainObject(turn) || typeof turn.id !== 'string' || turn.id === '') return
    if (state.turnId === null) {
      // Completion raced ahead of the turn/start response. Buffer it *by turn id*.
      while (state.completions.size >= MAX_BUFFERED_TURNS) {
        const oldest = state.completions.keys().next().value
        if (oldest === undefined) break
        state.completions.delete(oldest)
      }
      state.completions.set(turn.id, params)
      return
    }
    if (turn.id !== state.turnId) return
    completeTurn(state, params)
  }

  function completeTurn(state, params) {
    if (state.settled) return
    const turn = params.turn
    for (const item of Array.isArray(turn.items) ? turn.items : []) considerMessage(state, turn.id, item)
    const digest = state.texts.get(turn.id) ?? null
    const usage = normalizeTurnUsage(state.usage)
    state.texts.clear()
    state.usage = null
    state.completions.clear()

    if (turn.status === 'completed') {
      const answer = digest === null ? '' : digest.text
      if (answer.trim() === '') {
        state.finish(
          threadsError('no-answer', 'codex turn completed without a usable agentMessage (final_answer/partial_answer/no-phase)', {
            turnId: turn.id,
            threadId: state.threadId,
          }),
          null,
        )
        return
      }
      state.finish(null, {
        threadId: state.threadId,
        answer,
        usage,
        elapsedMs: Date.now() - state.startedAt,
      })
      return
    }

    const turnError = isPlainObject(turn.error) ? turn.error : {}
    const detail = typeof turnError.message === 'string' && turnError.message !== '' ? turnError.message : `turn status=${String(turn.status)}`
    if (turn.status === 'failed') {
      state.finish(
        threadsError('turn-failed', `codex turn failed: ${detail}`, {
          codexErrorInfo: turnError.codexErrorInfo ?? null,
          additionalDetails: turnError.additionalDetails ?? null,
          turnStatus: turn.status,
          turnId: turn.id,
          threadId: state.threadId,
        }),
        null,
      )
      return
    }
    if (turn.status === 'interrupted') {
      state.finish(threadsError('turn-interrupted', `codex turn was interrupted: ${detail}`, { turnId: turn.id }), null)
      return
    }
    state.finish(threadsError('protocol-error', `unexpected turn/completed status ${JSON.stringify(turn.status)}`, { turnId: turn.id }), null)
  }

  // ---- process lifecycle --------------------------------------------------
  function spawnSession() {
    const s = {
      proc: null,
      buffer: Buffer.alloc(0),
      stderrTail: '',
      badFrames: 0,
      dead: false,
      deadReason: null,
      /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, method: string }>} */
      pending: new Map(),
    }
    const args = [...bin.prefix, 'app-server', '--stdio']
    logDebugSafe(`spawning ${bin.command} ${args.join(' ')} (cwd=${cwd})`)
    const proc = spawn(bin.command, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    s.proc = proc
    proc.on('error', (error) => {
      markSessionDead(s, 'spawn-failed', `failed to start codex app-server: ${error instanceof Error ? error.message : String(error)}`)
    })
    proc.on('close', (code, signal) => {
      if (session !== s) return // we killed it ourselves; terminateSession already handled it
      const detail = s.stderrTail.trim()
      markSessionDead(
        s,
        'appserver-exit',
        `codex app-server exited (code=${code === null ? 'null' : String(code)}${signal ? `, signal=${signal}` : ''})${
          detail === '' ? '' : `: ${truncate(detail, 800)}`
        }`,
      )
    })
    proc.stdout?.on('data', (chunk) => onStdout(s, chunk))
    proc.stderr?.on('data', (chunk) => {
      s.stderrTail += chunk.toString('utf8')
      if (s.stderrTail.length > MAX_STDERR_BYTES) s.stderrTail = s.stderrTail.slice(s.stderrTail.length - MAX_STDERR_BYTES)
    })
    proc.stdin?.on('error', (error) => {
      logDebug(`stdin error (ignored): ${error instanceof Error ? error.message : String(error)}`)
    })
    return s
  }

  async function ensureSession() {
    if (disposed) throw threadsError('disposed', 'codex thread session has been disposed')
    const current = session
    if (current !== null && !current.dead && current.proc !== null && current.proc.exitCode === null) return current
    if (startPromise !== null) return startPromise
    const boot = (async () => {
      if (session !== null) terminateSession('stale', 'replacing a dead app-server session')
      const s = spawnSession()
      session = s
      try {
        const initResult = await requestRpc('initialize', {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: false },
        }, s)
        logDebug(`initialized: ${truncate(JSON.stringify(initResult ?? {}), 300)}`)
        notify(s, 'initialized')
        return s
      } catch (error) {
        terminateSession('start-failed', error instanceof Error ? error.message : String(error))
        throw error
      }
    })()
    startPromise = boot
    try {
      return await boot
    } finally {
      if (startPromise === boot) startPromise = null
    }
  }

  // ---- serialization ------------------------------------------------------
  function acquireSendSlot() {
    const previous = sendChain
    let release
    sendChain = new Promise((resolve) => {
      release = resolve
    })
    return previous.then(() => release)
  }

  // ---- one turn -----------------------------------------------------------
  function runTurn(s, threadId, text, timeoutMs, signal, startedAt) {
    return new Promise((resolve, reject) => {
      const state = makeTurnState(s, threadId, signal, startedAt, timeoutMs)
      const finish = (error, value) => {
        if (state.settled) return
        state.settled = true
        if (state.timer !== null) {
          clearTimeout(state.timer)
          state.timer = null
        }
        if (state.abortListener !== null) {
          state.abortListener.signal.removeEventListener('abort', state.abortListener.fn)
          state.abortListener = null
        }
        if (activeTurn === state) activeTurn = null
        if (error) reject(error)
        else resolve(value)
      }
      state.finish = finish
      state.fail = (error) => finish(error)
      activeTurn = state

      state.timer = setTimeout(() => {
        if (state.settled) return
        finish(threadsError('timeout', `codex turn timed out after ${timeoutMs} ms`), null)
        terminateSession('timeout', `codex turn timed out after ${timeoutMs} ms`)
      }, timeoutMs)

      if (signal) {
        if (signal.aborted) {
          finish(abortError(signal), null)
          terminateSession('aborted', 'codex turn aborted before it started')
          return
        }
        const onAbort = () => {
          if (state.settled) return
          finish(abortError(signal), null)
          terminateSession('aborted', 'codex turn aborted by the caller')
        }
        signal.addEventListener('abort', onAbort, { once: true })
        state.abortListener = { signal, fn: onAbort }
      }

      void (async () => {
        try {
          const result = await requestRpc(
            'turn/start',
            {
              threadId,
              input: [{ type: 'text', text, text_elements: [] }],
            },
            s,
          )
          if (state.settled) return
          const turnId = result?.turn?.id
          if (typeof turnId !== 'string' || turnId === '') {
            const failure = threadsError('protocol-error', 'turn/start returned no turn id (a turn may already be running)')
            finish(failure, null)
            return
          }
          state.turnId = turnId
          const early = state.completions.get(turnId)
          if (early !== undefined) {
            state.completions.delete(turnId)
            completeTurn(state, early)
          }
        } catch (error) {
          const failure = error instanceof Error ? error : threadsError('rpc-error', String(error))
          if (!state.settled) finish(failure, null)
        }
      })()
    })
  }

  async function startTurn(inputThreadId, text, timeoutMs, signal) {
    const startedAt = Date.now()
    const s = await ensureSession()
    let threadId = resumedThreads.get(inputThreadId) ?? null
    if (threadId === null) {
      const resumed = await requestRpc(
        'thread/resume',
        {
          threadId: inputThreadId,
          excludeTurns: true,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
        s,
      )
      const canonical = typeof resumed?.thread?.id === 'string' && resumed.thread.id !== '' ? resumed.thread.id : inputThreadId
      threadId = canonical
      resumedThreads.set(inputThreadId, canonical)
      resumedThreads.set(canonical, canonical)
      logDebug(`resumed thread ${inputThreadId}${canonical === inputThreadId ? '' : ` -> ${canonical}`}`)
    }
    return runTurn(s, threadId, text, timeoutMs, signal, startedAt)
  }

  // ---- public surface -----------------------------------------------------
  async function list(request = {}) {
    if (!isPlainObject(request)) throw new TypeError('list(request) requires an object')
    const limit = clampLimit(request.limit)
    const searchTerm = typeof request.searchTerm === 'string' ? request.searchTerm.trim() : ''
    await ensureSession()
    const threads = []
    const seen = new Set()
    let useStateDbOnly = true
    let fallbackTried = false
    let cursor = null
    let pages = 0

    while (threads.length < limit && pages < MAX_PAGES) {
      const params = { limit: Math.min(Math.max(limit - threads.length, 1), 200), useStateDbOnly }
      if (searchTerm !== '') params.searchTerm = searchTerm
      if (cursor !== null) params.cursor = cursor
      let page
      try {
        page = await requestRpc('thread/list', params)
      } catch (error) {
        if (useStateDbOnly && !fallbackTried) {
          fallbackTried = true
          useStateDbOnly = false
          cursor = null
          pages = 0
          logDebug(`thread/list useStateDbOnly failed (${error instanceof Error ? error.message : String(error)}); retrying with the rollout scan`)
          continue
        }
        throw error
      }
      const rows = Array.isArray(page?.data) ? page.data : []
      if (useStateDbOnly && !fallbackTried && pages === 0 && rows.length === 0) {
        // State DB empty (fresh/migrated install) → use the rollout scan variant.
        fallbackTried = true
        useStateDbOnly = false
        continue
      }
      for (const row of rows) {
        if (!isPlainObject(row) || typeof row.id !== 'string' || row.id === '' || seen.has(row.id)) continue
        seen.add(row.id)
        threads.push(mapThreadRow(row))
        if (threads.length >= limit) break
      }
      pages += 1
      const next = typeof page?.nextCursor === 'string' && page.nextCursor !== '' ? page.nextCursor : null
      if (next === null || threads.length >= limit) break
      cursor = next
    }
    return { threads }
  }

  async function read(request = {}) {
    if (!isPlainObject(request)) throw new TypeError('read(request) requires an object')
    const threadId = requireThreadId(request.threadId, 'read')
    await ensureSession()
    const result = await requestRpc('thread/read', { threadId, includeTurns: true })
    const thread = isPlainObject(result?.thread) ? result.thread : null
    if (thread === null) throw threadsError('protocol-error', 'thread/read returned no thread')
    return {
      thread: {
        id: typeof thread.id === 'string' && thread.id !== '' ? thread.id : threadId,
        name: threadName(thread),
        cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
        turns: readThreadMessages(thread),
      },
    }
  }

  async function send(request = {}) {
    if (!isPlainObject(request)) throw new TypeError('send(request) requires an object')
    const threadId = requireThreadId(request.threadId, 'send')
    if (typeof request.text !== 'string' || request.text.trim() === '') {
      throw threadsError('bad-request', 'send requires a non-empty text string')
    }
    const requestedTimeout = Number(request.timeoutMs)
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : DEFAULT_TURN_TIMEOUT_MS
    const signal = request.signal
    if (signal?.aborted) throw abortError(signal)
    const release = await acquireSendSlot()
    try {
      if (signal?.aborted) throw abortError(signal)
      return await startTurn(threadId, request.text, timeoutMs, signal)
    } finally {
      release()
    }
  }

  /**
   * Create a persistent thread on the app-server (probe/diagnostic helper; the
   * Lead integration only needs list/read/send/dispose). The created thread is
   * materialised on disk, so it also shows up in later `list()` calls.
   */
  async function startThread(request = {}) {
    if (!isPlainObject(request)) throw new TypeError('startThread(request) requires an object')
    const targetCwd = typeof request.cwd === 'string' && request.cwd !== '' ? request.cwd : cwd
    await ensureSession()
    const result = await requestRpc('thread/start', { cwd: targetCwd, approvalPolicy: 'never', sandbox: 'read-only' })
    const threadId = result?.thread?.id
    if (typeof threadId !== 'string' || threadId === '') {
      throw threadsError('protocol-error', 'thread/start returned no thread id')
    }
    resumedThreads.set(threadId, threadId)
    logDebug(`started thread ${threadId} (cwd=${targetCwd})`)
    return { threadId }
  }

  function dispose() {
    if (disposePromise !== null) return disposePromise
    disposed = true
    const s = session
    session = null
    disposePromise = (async () => {
      if (s === null) return
      if (s.proc) {
        try {
          killTree(s.proc.pid)
        } catch {
          /* already gone */
        }
      }
      markSessionDead(s, 'disposed', 'codex thread session disposed by the caller')
      resumedThreads.clear()
      if (s.proc) {
        await new Promise((resolve) => {
          if (s.proc.exitCode !== null) {
            resolve()
            return
          }
          const timer = setTimeout(resolve, 2_000)
          timer.unref?.()
          s.proc.once('close', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    })()
    return disposePromise
  }

  return { list, read, send, startThread, dispose }
}
