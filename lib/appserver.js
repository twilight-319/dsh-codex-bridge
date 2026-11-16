/**
 * Persistent Codex session over `codex app-server --stdio` (JSON-RPC 2.0, newline framed).
 *
 * One long-lived app-server process + one ephemeral thread, reused across turns,
 * so a consult only pays the model latency and keeps the conversation context.
 *
 * Wire protocol verified on this machine (codex-cli 0.166.0):
 *   → initialize {clientInfo, capabilities}   ← {userAgent, codexHome, …}
 *   → initialized                              (notification)
 *   → thread/start {cwd, ephemeral, approvalPolicy:"never", sandbox}
 *                                              ← {thread:{id,…}, …} + thread/started
 *   → turn/start {threadId, input:[{type:"text",text,text_elements:[]}], outputSchema?, model?, effort?}
 *                                              ← {turn:{id,…}} + turn/started
 *   ← item/completed {item:{type:"agentMessage", text, phase}, threadId, turnId}
 *   ← thread/tokenUsage/updated {threadId, turnId, tokenUsage:{last,total,modelContextWindow}}
 *   ← turn/completed {threadId, turn:{id, status, items, error, durationMs}}
 *
 * Server → client requests (approvals, elicitation) are always answered: declining
 * means "do not act", which never blocks the turn. Unknown server requests get a
 * JSON-RPC -32601 error so the server is never left waiting.
 *
 * This module imports only `node:` built-ins plus `killTree` from `lib/codex.js`
 * (no `@deepseek-ai/*` — the plugin runs inside the DSH host and must stay
 * dependency-free).
 *
 * @module @local/codex-bridge/appserver
 */
import { spawn } from 'node:child_process'
import { killTree } from './codex.js'

const DEFAULT_TIMEOUT_MS = 240_000
/** How long to wait for `turn/interrupt` to finish the turn before killing the tree. */
const INTERRUPT_GRACE_MS = 3_000
/** A single JSON-RPC frame that never gets a newline is treated as stream corruption. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024
const MAX_BAD_FRAMES = 5
const MAX_BUFFERED_TURNS = 8

const CLIENT_INFO = Object.freeze({
  name: 'dsh-codex-bridge',
  title: 'DSH Codex Bridge',
  version: '0.1.0',
})

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/** Answer shapes for the server→client requests Codex may send while a turn runs. */
const SERVER_REQUEST_REPLIES = Object.freeze({
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
  'item/tool/requestUserInput': { answers: {} },
  'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
})

const PHASE_RANK = Object.freeze({ final_answer: 3, partial_answer: 2 })
/** @param {string} code @param {string} message @param {object} [extra] */
function bridgeError(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra) Object.assign(error, extra)
  return error
}

function abortError(signal) {
  const error = new Error('codex consult aborted')
  error.name = 'AbortError'
  error.code = 'aborted'
  error.cause = signal?.reason
  return error
}

function truncate(text, limit) {
  const value = typeof text === 'string' ? text : String(text)
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Map `thread/tokenUsage/updated`'s payload to the consult `usage` object. */
function normalizeUsage(tokenUsage) {
  if (!isPlainObject(tokenUsage)) return null
  const last = isPlainObject(tokenUsage.last) ? tokenUsage.last : isPlainObject(tokenUsage.total) ? tokenUsage.total : null
  if (!last && !isPlainObject(tokenUsage.total)) return null
  const pick = (key) => {
    const value = last?.[key] ?? tokenUsage.total?.[key]
    return typeof value === 'number' ? value : null
  }
  return {
    totalTokens: pick('totalTokens'),
    inputTokens: pick('inputTokens'),
    cachedInputTokens: pick('cachedInputTokens'),
    cacheWriteInputTokens: pick('cacheWriteInputTokens'),
    outputTokens: pick('outputTokens'),
    reasoningOutputTokens: pick('reasoningOutputTokens'),
    modelContextWindow: typeof tokenUsage.modelContextWindow === 'number' ? tokenUsage.modelContextWindow : null,
    // Full session counters, for diagnostics.
    total: isPlainObject(tokenUsage.total) ? tokenUsage.total : null,
  }
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

/**
 * Create one persistent Codex app-server session.
 *
 * @param {{
 *   bin: { command: string, prefix?: string[] },
 *   cwd: string,
 *   sandbox: 'read-only' | 'workspace-write' | 'danger-full-access',
 *   model?: string,
 *   effort?: string,
 *   logger?: { warn?: (message: string) => void, debug?: (message: string) => void },
 * }} options
 * @returns {{
 *   readonly threadId: string | null,
 *   readonly alive: boolean,
 *   consult(request: { prompt: string, schema?: object, signal?: AbortSignal, timeoutMs?: number, model?: string, effort?: string }): Promise<{ answer: string, usage: object | null, elapsedMs: number, threadId: string }>,
 *   dispose(): Promise<void>,
 * }}
 */
export function createAppServerSession(options = {}) {
  const bin = options.bin
  if (!isPlainObject(bin) || typeof bin.command !== 'string' || bin.command === '') {
    throw new TypeError('createAppServerSession: options.bin.command is required (resolveCodexBin() from lib/codex.js)')
  }
  if (typeof options.cwd !== 'string' || options.cwd === '') {
    throw new TypeError('createAppServerSession: options.cwd is required')
  }
  const sandbox = options.sandbox ?? 'read-only'
  if (!SANDBOX_MODES.has(sandbox)) {
    throw new TypeError(`createAppServerSession: unsupported sandbox ${JSON.stringify(sandbox)}`)
  }
  const cwd = options.cwd
  const prefix = Array.isArray(bin.prefix) ? bin.prefix : []
  const configuredModel = typeof options.model === 'string' && options.model !== '' ? options.model : ''
  const configuredEffort = typeof options.effort === 'string' && options.effort !== '' ? options.effort : ''
  const logger = options.logger ?? {}

  const logDebug = (message) => {
    try {
      logger.debug?.(`codex-bridge(appserver): ${message}`)
    } catch {
      /* a broken logger must not break the session */
    }
  }
  const logWarn = (message) => {
    try {
      logger.warn?.(`codex-bridge(appserver): ${message}`)
    } catch {
      /* ignore */
    }
  }

  // ---- process / protocol state -------------------------------------------
  let child = null
  let dead = false
  /** @type {{ code: string, message: string } | null} */
  let deadReason = null
  let disposed = false
  let disposePromise = null
  let startPromise = null
  let threadId = null
  let nextRequestId = 1
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, method: string }>} */
  const pending = new Map()
  /** Raw bytes not yet terminated by a newline (includes a possibly partial UTF-8 sequence). */
  let frameBuffer = Buffer.alloc(0)
  let stderrTail = ''
  let badFrames = 0

  // ---- turn serialization (one turn in flight per session) ----------------
  let busy = false
  /** @type {Array<{ resolve: (release: () => void) => void, reject: (error: Error) => void, signal?: AbortSignal, onAbort?: () => void }>} */
  const waiters = []
  /** @type {null | ReturnType<typeof makeTurnState>} */
  let active = null

  const isAlive = () => !disposed && !dead && child !== null && child.exitCode === null

  function deadError() {
    const reason = deadReason
    return bridgeError(
      'session-dead',
      reason
        ? `codex app-server session is dead (${reason.code}): ${reason.message}`
        : 'codex app-server session is dead',
    )
  }

  function writeFrame(frame) {
    const proc = child
    if (!proc || !proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded) throw deadError()
    proc.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  function sendRequest(method, params) {
    if (!child) return Promise.reject(deadError())
    const id = nextRequestId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      try {
        writeFrame({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : bridgeError('session-dead', String(error)))
      }
    })
  }

  function notify(method, params) {
    writeFrame(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /** Mark the session unusable, reject every pending request and drain the queue. */
  function markDead(code, message) {
    if (dead) return false
    dead = true
    deadReason = { code, message }
    logDebug(`session dead (${code}): ${message}`)
    const makeError = () => bridgeError(code === 'disposed' ? 'session-dead' : code, message)
    for (const entry of pending.values()) entry.reject(makeError())
    pending.clear()
    if (active !== null && !active.settled) active.fail(makeError())
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      detachWaiter(waiter)
      waiter.reject(bridgeError('session-dead', `codex app-server session is dead (${code}): ${message}`))
    }
    return true
  }

  /** Kill the process tree, then mark the session dead (idempotent). */
  function terminateSession(code, message) {
    const proc = child
    child = null
    if (proc) {
      try {
        killTree(proc.pid)
      } catch {
        /* already gone */
      }
    }
    markDead(code, message)
  }

  // ---- stdout framing -----------------------------------------------------
  /**
   * Incremental framing on raw bytes: append, split at 0x0A, decode each frame.
   * Splitting bytes (not a decoded string) keeps a multi-byte UTF-8 sequence that
   * straddles two chunks intact, and gives exact byte bounds for both a single
   * frame and the unterminated remainder.
   */
  function onStdout(chunk) {
    frameBuffer = frameBuffer.length === 0 ? chunk : Buffer.concat([frameBuffer, chunk])
    let offset = 0
    for (;;) {
      const newline = frameBuffer.indexOf(0x0a, offset)
      if (newline === -1) break
      const frame = frameBuffer.subarray(offset, newline)
      offset = newline + 1
      if (frame.length > MAX_FRAME_BYTES) {
        terminateSession('protocol-error', `json-rpc frame of ${frame.length} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`)
        return
      }
      const line = frame.toString('utf8').replace(/\r$/, '')
      if (line.trim() !== '') handleLine(line)
      if (dead) return
    }
    if (offset > 0) frameBuffer = frameBuffer.subarray(offset)
    if (frameBuffer.length > MAX_FRAME_BYTES) {
      terminateSession('protocol-error', `json-rpc frame exceeded ${MAX_FRAME_BYTES} bytes without a newline`)
    }
  }

  function handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      badFrames += 1
      logWarn(`unparsable stdio frame #${badFrames}: ${truncate(line, 200)} (${error instanceof Error ? error.message : String(error)})`)
      if (badFrames > MAX_BAD_FRAMES) terminateSession('protocol-error', `too many unparsable json-rpc frames (${badFrames})`)
      return
    }
    if (!isPlainObject(message)) return
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) handleServerRequest(message)
      else handleNotification(message.method, message.params ?? {})
      return
    }
    if (message.id !== undefined && message.id !== null) {
      handleResponse(message)
      return
    }
    logDebug(`ignored frame without method/id: ${truncate(line, 160)}`)
  }

  function handleResponse(message) {
    const entry = pending.get(message.id)
    if (!entry) {
      logDebug(`response for unknown request id ${String(message.id)}`)
      return
    }
    pending.delete(message.id)
    if (message.error) {
      const detail = isPlainObject(message.error) ? message.error.message ?? 'unknown error' : String(message.error)
      // A rejected turn/start is an ordinary RPC error: the turn never began, so the
      // session keeps working. Any other rejected request leaves the stream state
      // uncertain → protocol error (callers treat that as terminal).
      const code = entry.method === 'turn/start' ? 'turn-start-rejected' : 'protocol-error'
      const error = bridgeError(code, `app-server error for ${entry.method}: ${detail}`, {
        rpcError: message.error,
      })
      entry.reject(error)
      return
    }
    entry.resolve(message.result)
  }

  function handleServerRequest(message) {
    const reply = Object.hasOwn(SERVER_REQUEST_REPLIES, message.method) ? SERVER_REQUEST_REPLIES[message.method] : undefined
    try {
      if (reply !== undefined) {
        logDebug(`declining server request ${message.method}`)
        writeFrame({ jsonrpc: '2.0', id: message.id, result: reply })
      } else {
        logWarn(`unsupported server request ${message.method}; replying -32601`)
        writeFrame({
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
        onAgentMessage(params)
        return
      case 'thread/tokenUsage/updated':
        onTokenUsage(params)
        return
      case 'error':
        logWarn(`app-server error notification: ${truncate(JSON.stringify(params), 400)}`)
        return
      default:
        // thread/started, turn/started, status changes, rate limits, MCP startup…
        logDebug(`notification ${method}`)
    }
  }

  function activeStateFor(params) {
    const state = active
    if (state === null || state.settled) return null
    const paramThread = params?.threadId
    const sessionThread = state.threadId ?? threadId
    if (typeof paramThread === 'string' && sessionThread !== null && paramThread !== sessionThread) return null
    return state
  }

  /**
   * Keep only what answer selection needs: the best-ranked agentMessage text per
   * turn. Non-agentMessage items, deltas and full item payloads are never stored,
   * so a chatty turn costs O(1) memory per turn (bounded number of turn keys).
   */
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

  function onAgentMessage(params) {
    const state = activeStateFor(params)
    if (state === null) return
    const turnKey = params?.turnId
    if (typeof turnKey !== 'string') return
    if (state.turnId !== null && turnKey !== state.turnId) return
    considerMessage(state, turnKey, params.item)
  }

  function onTokenUsage(params) {
    const state = activeStateFor(params)
    if (state === null) return
    const turnKey = params?.turnId
    if (typeof turnKey !== 'string') return
    if (state.turnId !== null && turnKey !== state.turnId) return
    if (!state.usage.has(turnKey) && state.usage.size >= MAX_BUFFERED_TURNS) return
    state.usage.set(turnKey, params.tokenUsage)
  }

  function onTurnCompleted(params) {
    const state = activeStateFor(params)
    if (state === null) return
    const turn = params?.turn
    if (!isPlainObject(turn) || typeof turn.id !== 'string' || turn.id === '') return
    if (state.turnId === null) {
      // Completion raced ahead of the turn/start response. Buffer it *by turn id* so
      // a later unrelated completion cannot overwrite the matching one.
      while (state.completions.size >= MAX_BUFFERED_TURNS) {
        const oldest = state.completions.keys().next().value
        if (oldest === undefined) break
        state.completions.delete(oldest)
      }
      state.completions.set(turn.id, params)
      return
    }
    if (turn.id !== state.turnId) return // another turn's notification: never mix
    completeTurn(state, params)
  }

  function completeTurn(state, params) {
    if (state.settled) return
    const turn = params.turn
    // Feed the completion's summary items through the same ranking as the stream;
    // they are chronological, so a later same-rank text still wins.
    for (const item of Array.isArray(turn.items) ? turn.items : []) considerMessage(state, turn.id, item)
    const digest = state.texts.get(turn.id) ?? null
    const usage = normalizeUsage(state.usage.get(turn.id))
    state.texts.clear()
    state.usage.clear()
    state.completions.clear()

    if (state.aborting) {
      state.finish(abortError(state.signal), null)
      terminateSession('aborted', 'codex turn was interrupted because the caller aborted the consult')
      return
    }

    if (turn.status === 'completed') {
      const answer = digest === null ? '' : digest.text
      if (answer.trim() === '') {
        state.finish(
          bridgeError('no-answer', 'codex turn completed without a usable agentMessage (final_answer/partial_answer/no-phase)', {
            turnId: turn.id,
            threadId: threadId ?? undefined,
          }),
          null,
        )
        return
      }
      state.finish(null, {
        answer,
        usage,
        elapsedMs: Date.now() - state.startedAt,
        threadId: threadId ?? state.threadId ?? '',
      })
      return
    }

    const turnError = isPlainObject(turn.error) ? turn.error : {}
    const detail = typeof turnError.message === 'string' && turnError.message !== '' ? turnError.message : `turn status=${String(turn.status)}`
    if (turn.status === 'failed') {
      state.finish(
        bridgeError('turn-failed', `codex turn failed: ${detail}`, {
          codexErrorInfo: turnError.codexErrorInfo ?? null,
          additionalDetails: turnError.additionalDetails ?? null,
          turnStatus: turn.status,
          turnId: turn.id,
        }),
        null,
      )
      return
    }
    if (turn.status === 'interrupted') {
      state.finish(bridgeError('turn-interrupted', `codex turn was interrupted: ${detail}`, { turnId: turn.id }), null)
      return
    }
    state.finish(
      bridgeError('protocol-error', `unexpected turn/completed status ${JSON.stringify(turn.status)}`, { turnId: turn.id }),
      null,
    )
    terminateSession('protocol-error', `unexpected turn/completed status ${JSON.stringify(turn.status)}`)
  }

  // ---- process lifecycle --------------------------------------------------
  function spawnChild() {
    const args = [...prefix, 'app-server', '--stdio']
    logDebug(`spawning ${bin.command} ${args.join(' ')} (cwd=${cwd})`)
    frameBuffer = Buffer.alloc(0)
    stderrTail = ''
    badFrames = 0
    const proc = spawn(bin.command, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = proc
    proc.on('error', (error) => {
      markDead('spawn-failed', `failed to start codex app-server: ${error instanceof Error ? error.message : String(error)}`)
    })
    proc.on('close', (code, signal) => {
      if (child !== proc) return // we killed it ourselves; terminateSession already marked dead
      const detail = stderrTail.trim()
      markDead(
        'appserver-exit',
        `codex app-server exited (code=${code === null ? 'null' : String(code)}${signal ? `, signal=${signal}` : ''})${
          detail === '' ? '' : `: ${truncate(detail, 800)}`
        }`,
      )
    })
    proc.stdout?.on('data', onStdout)
    proc.stderr?.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8')
      if (stderrTail.length > MAX_STDERR_BYTES) stderrTail = stderrTail.slice(stderrTail.length - MAX_STDERR_BYTES)
    })
    proc.stdin?.on('error', (error) => {
      logDebug(`stdin error (ignored): ${error instanceof Error ? error.message : String(error)}`)
    })
    return proc
  }

  function ensureStarted() {
    if (dead) return Promise.reject(deadError())
    if (startPromise !== null) return startPromise
    startPromise = (async () => {
      spawnChild()
      const initResult = await sendRequest('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false },
      })
      logDebug(`initialized: ${truncate(JSON.stringify(initResult ?? {}), 300)}`)
      notify('initialized')
      const threadStartParams = {
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox,
      }
      if (configuredModel !== '') threadStartParams.model = configuredModel
      const startResult = await sendRequest('thread/start', threadStartParams)
      const startedId = startResult?.thread?.id
      if (typeof startedId !== 'string' || startedId === '') {
        terminateSession('protocol-error', 'thread/start returned no thread id')
        throw deadError()
      }
      threadId = startedId
      logDebug(`thread started: ${startedId}`)
      return startedId
    })().catch((error) => {
      if (!dead) {
        // A failed handshake leaves the process unusable; keep the session dead but
        // surface the original error to this first consult.
        terminateSession('start-failed', error instanceof Error ? error.message : String(error))
      }
      throw error
    })
    return startPromise
  }

  // ---- serialization ------------------------------------------------------
  function detachWaiter(waiter) {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.onAbort = undefined
    }
  }

  function releaseSlot() {
    busy = false
    const next = waiters.shift()
    if (!next) return
    detachWaiter(next)
    busy = true
    next.resolve(releaseSlot)
  }

  function acquireSlot(signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (!busy) {
      busy = true
      return Promise.resolve(releaseSlot)
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined }
      if (signal) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index !== -1) waiters.splice(index, 1)
          detachWaiter(waiter)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      waiters.push(waiter)
    })
  }

  // ---- one turn -----------------------------------------------------------
  function makeTurnState(startedAt, signal, timeoutMs) {
    return {
      settled: false,
      aborting: false,
      startedAt,
      signal,
      timeoutMs,
      threadId: null,
      turnId: null,
      timer: null,
      graceTimer: null,
      abortListener: null,
      /** @type {Map<string, { rank: number, text: string }>} best agentMessage per turn */
      texts: new Map(),
      /** @type {Map<string, any>} usage payload per turn */
      usage: new Map(),
      /** @type {Map<string, any>} turn/completed that raced ahead of the turn/start response */
      completions: new Map(),
      /** @type {((error: Error | null, value?: any) => void) | null} */
      finish: null,
      /** @type {((error: Error) => void) | null} */
      fail: null,
    }
  }

  function startAbort(state) {
    if (state.settled || state.aborting) return
    state.aborting = true
    // No turn id yet (still spawning/handshaking, or the start response is in
    // flight): there is nothing to interrupt, but the session is still terminal
    // after an abort of an accepted consult (contract: abort ⇒ dead).
    if (state.turnId === null) {
      const reason =
        child === null
          ? 'codex consult aborted before the app-server process started'
          : 'codex consult aborted before the turn started'
      state.finish(abortError(state.signal), null)
      if (!dead) {
        if (child !== null) terminateSession('aborted', reason)
        else markDead('aborted', reason)
      }
      return
    }
    try {
      sendRequest('turn/interrupt', { threadId: state.threadId ?? threadId, turnId: state.turnId }).catch(() => {})
    } catch {
      /* the grace timer below still kills the tree */
    }
    state.graceTimer = setTimeout(() => {
      if (state.settled) return
      state.finish(abortError(state.signal), null)
      terminateSession('aborted', `codex turn did not stop within ${INTERRUPT_GRACE_MS} ms of turn/interrupt`)
    }, INTERRUPT_GRACE_MS)
  }

  function runTurn(request, startedAt) {
    const requestedTimeout = Number(request.timeoutMs)
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const state = makeTurnState(startedAt, request.signal, timeoutMs)
      const finish = (error, value) => {
        if (state.settled) return
        state.settled = true
        if (state.timer !== null) {
          clearTimeout(state.timer)
          state.timer = null
        }
        if (state.graceTimer !== null) {
          clearTimeout(state.graceTimer)
          state.graceTimer = null
        }
        if (state.abortListener !== null) {
          state.abortListener.signal.removeEventListener('abort', state.abortListener.fn)
          state.abortListener = null
        }
        if (active === state) active = null
        if (error) reject(error)
        else resolve(value)
      }
      state.finish = finish
      state.fail = (error) => finish(error)
      active = state

      state.timer = setTimeout(() => {
        if (state.settled) return
        finish(bridgeError('timeout', `codex consult timed out after ${timeoutMs} ms`), null)
        terminateSession('timeout', `codex consult timed out after ${timeoutMs} ms`)
      }, timeoutMs)

      const onAbort = () => startAbort(state)
      if (request.signal) {
        if (request.signal.aborted) {
          onAbort()
          return
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        state.abortListener = { signal: request.signal, fn: onAbort }
      }

      void (async () => {
        try {
          await ensureStarted()
          if (state.settled) return
          state.threadId = threadId
          const params = {
            threadId,
            input: [{ type: 'text', text: request.prompt, text_elements: [] }],
          }
          const model = typeof request.model === 'string' && request.model !== '' ? request.model : configuredModel
          if (model !== '') params.model = model
          const effort = typeof request.effort === 'string' && request.effort !== '' ? request.effort : configuredEffort
          if (effort !== '') params.effort = effort
          if (isPlainObject(request.schema)) params.outputSchema = request.schema
          const result = await sendRequest('turn/start', params)
          if (state.settled) return
          const turnId = result?.turn?.id
          if (typeof turnId !== 'string' || turnId === '') {
            // The server may already be running a turn we cannot address: terminal.
            const message = 'turn/start returned no turn id (a turn may already be running)'
            finish(bridgeError('protocol-error', message), null)
            terminateSession('protocol-error', message)
            return
          }
          state.turnId = turnId
          const early = state.completions.get(turnId)
          if (early !== undefined) {
            state.completions.delete(turnId)
            completeTurn(state, early)
          }
        } catch (error) {
          const failure = error instanceof Error ? error : bridgeError('transport-error', String(error))
          if (!state.settled) finish(failure, null)
          // A rejected turn/start is an ordinary RPC error (no turn began) — the
          // session stays usable. Anything else that is not already a dead-session
          // error leaves the stream state unknown, so the session becomes terminal.
          if (!dead && failure.code !== 'turn-start-rejected') {
            terminateSession('protocol-error', `consult failed: ${failure.message}`)
          }
        }
      })()
    })
  }

  // ---- public surface -----------------------------------------------------
  async function consult(request) {
    if (!isPlainObject(request)) throw new TypeError('consult(request) requires an object')
    if (typeof request.prompt !== 'string' || request.prompt === '') {
      throw bridgeError('bad-request', 'consult requires a non-empty prompt string')
    }
    if (dead) throw deadError()
    const startedAt = Date.now()
    const release = await acquireSlot(request.signal)
    try {
      if (dead) throw deadError()
      return await runTurn(request, startedAt)
    } finally {
      release()
    }
  }

  function dispose() {
    if (disposePromise !== null) return disposePromise
    disposed = true
    const proc = child
    child = null
    disposePromise = (async () => {
      if (proc !== null) {
        try {
          killTree(proc.pid)
        } catch {
          /* already gone */
        }
      }
      markDead('disposed', 'app-server session disposed by the caller')
      if (proc !== null) {
        await new Promise((resolve) => {
          if (proc.exitCode !== null) {
            resolve()
            return
          }
          const timer = setTimeout(resolve, 2_000)
          timer.unref?.()
          proc.once('close', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    })()
    return disposePromise
  }

  return {
    get threadId() {
      return threadId
    },
    get alive() {
      return isAlive()
    },
    consult,
    dispose,
  }
}
