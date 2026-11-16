import { TASK_PATH, dispatchTask } from './task-api.js'
/**
 * DSH-side execution bridge: run one real DSH session programmatically and
 * expose it through a token-protected HTTP entry point.
 *
 * Route chosen after inspecting the live Host contracts (cordis inspect,
 * `host/Service`):
 *
 *   sessionController.create({ cwd?, agentPreset? }) -> { sessionId }
 *   sessionController.state({ sessionId }, signal)   -> { cursor, active, ... }
 *   sessionController.prompt({ requestId, sessionId, mode:'queue', content }, signal)
 *   sessionController.wait({ sessionId, timeoutMs, afterSeq, maxMessages }, signal)
 *   sessionController.cancel({ sessionId })
 *   sessionController.events({ address, maxMessages }, signal)
 *
 * That is exactly the create -> prompt -> wait -> cancel loop the Web GUI uses,
 * and unlike `subagents.startActivation` it needs no parent Agent.
 *
 * A profile-installed plugin cannot resolve bare `@deepseek-ai/*` specifiers and
 * cannot import Harness packages, so this module only uses `node:` builtins plus
 * services read from `ctx` at call time.
 *
 * @module dsh-codex-bridge/dsh-exec
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createExecutor, isInternalSessionId } from './session-executor.js'
export { createExecutor, isInternalSessionId }
import { mountBrowserRoute, mountNodeRoute } from './route-host-v2.js'

/**
 * Default execution route. Versioned because the DSH web-server route table
 * survives plugin reloads: a changed handler needs a new path, otherwise the
 * stale closure keeps serving until the app restarts.
 */
export const DEFAULT_EXECUTE_PATH = '/api/dsh-codex-bridge.v3.execute'

/** Default status route derived from the execution route. */
export const DEFAULT_STATUS_PATH = '/api/dsh-codex-bridge.v3.status'

/**
 * Live handler indirection shared across plugin module generations through
 * `globalThis`, so a reloaded plugin swaps the handler behind an already
 * mounted route instead of leaving the previous closure in place.
 * @type {Map<string, (request: Request) => Promise<Response>>}
 */
const routeHandlers = (globalThis.__dshCodexBridgeRouteHandlers ??= new Map())

const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const MAX_TASK_CHARS = 20_000
const MAX_TIMEOUT_MS = 600_000
const MIN_TIMEOUT_MS = 1_000
const DEFAULT_EXECUTE_TIMEOUT_MS = 300_000
const MAX_HTTP_BODY_BYTES = 100_000

/**
 * Token-files already generated in this process, keyed by path. Concurrent
 * callers share one generation attempt.
 * @type {Map<string, Promise<{ token: string, path: string }>>}
 */
const tokenFiles = new Map()

/** @param {unknown} logger */
function normalizeLogger(logger) {
  const bind = (name) => (typeof logger?.[name] === 'function' ? logger[name].bind(logger) : () => {})
  return { info: bind('info'), warn: bind('warn'), error: bind('error') }
}

/** @param {any} ctx @param {string} key */
function getService(ctx, key) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    /* service not ready */
  }
  try {
    const value = ctx[key]
    if (value !== undefined && value !== null) return value
  } catch {
    /* ignore */
  }
  return null
}

/** @param {string} token @param {string} candidate */
function constantTimeEqual(token, candidate) {
  const left = createHash('sha256').update(String(token), 'utf8').digest()
  const right = createHash('sha256').update(String(candidate), 'utf8').digest()
  return timingSafeEqual(left, right)
}

/** @param {unknown} value @param {number} [status] @param {Record<string,string>} [extra] */
function jsonResponse(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  })
}

/** @param {Request} request */
function bearerToken(request) {
  const header = request.headers.get('authorization')
  if (typeof header !== 'string') return null
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/** @param {unknown} token */
async function resolveToken(token) {
  if (typeof token === 'function') return await token()
  if (token && typeof token.then === 'function') return await token
  return typeof token === 'string' && token !== '' ? token : null
}

/**
 * Default token file location.
 * @returns {string}
 */
function defaultTokenPath() {
  return join(homedir(), '.dsh', 'codex-bridge', 'http-token')
}

/** @param {string} tokenPath */
async function readValidToken(tokenPath) {
  const raw = await readFile(tokenPath, 'utf8')
  const token = raw.trim().toLowerCase()
  return TOKEN_PATTERN.test(token) ? token : null
}

/**
 * Write the token atomically with best-effort 0600 permissions.
 * @param {string} tokenPath
 * @param {string} token
 * @param {{ warn: (...args: unknown[]) => void }} log
 */
async function writeTokenFile(tokenPath, token, log) {
  const directory = join(tokenPath, '..')
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {})
  await chmod(directory, 0o700).catch(() => {})
  const temporary = `${tokenPath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => {})
    await rename(temporary, tokenPath)
    await chmod(tokenPath, 0o600).catch(() => {})
  } catch (error) {
    await unlink(temporary).catch(() => {})
    log.warn(`codex-bridge: cannot write token file ${tokenPath}: ${error?.message ?? error}`)
    throw error
  }
}

/**
 * Ensure the bridge HTTP bearer token exists.
 *
 * The token is 32 random bytes hex-encoded (64 lowercase hex characters). The
 * file is created on first use, reused afterwards, regenerated when its content
 * is not a valid token, and never read from or written to any config file.
 *
 * @param {{ path?: string, logger?: { warn?: (...args: unknown[]) => void } }} [options]
 * @returns {Promise<{ token: string, path: string }>}
 */
export async function ensureTokenFile(options = {}) {
  const tokenPath = typeof options.path === 'string' && options.path !== '' ? options.path : defaultTokenPath()
  const log = normalizeLogger(options.logger)
  const pending = tokenFiles.get(tokenPath)
  if (pending) return pending
  const attempt = (async () => {
    const existing = await readValidToken(tokenPath).catch(() => null)
    if (existing) return { token: existing, path: tokenPath }
    let invalid = false
    try {
      await readFile(tokenPath, 'utf8')
      invalid = true
    } catch {
      /* missing file: normal first run */
    }
    if (invalid) log.warn(`codex-bridge: token file ${tokenPath} is invalid, regenerating`)
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    await writeTokenFile(tokenPath, token, log)
    return { token, path: tokenPath }
  })()
  const shared = attempt.catch((error) => {
    tokenFiles.delete(tokenPath)
    throw error
  })
  tokenFiles.set(tokenPath, shared)
  return shared
}

/**
 * Validate one `/execute` request body.
 * @param {unknown} body
 * @returns {{ ok: true, value: { task: string, cwd?: string, timeoutMs?: number, reasoningEffort?: string, reason?: string, sessionId?: string } } | { ok: false, error: string }}
 */
function parseExecuteRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const record = /** @type {Record<string, unknown>} */ (body)
  const task = record.task
  if (typeof task !== 'string' || task.trim() === '') {
    return { ok: false, error: 'task is required and must be a non-empty string' }
  }
  if (task.length > MAX_TASK_CHARS) {
    return { ok: false, error: `task must be at most ${MAX_TASK_CHARS} characters` }
  }
  /** @type {{ task: string, cwd?: string, timeoutMs?: number, reasoningEffort?: string, reason?: string, sessionId?: string }} */
  const value = { task }
  if(record.clientCallId!==undefined) { if(typeof record.clientCallId!=='string'||record.clientCallId.length>120)return {ok:false,error:'invalid clientCallId'}; value.clientCallId=record.clientCallId }
  if (record.sessionId !== undefined && record.sessionId !== null) {
    if (typeof record.sessionId !== 'string' || record.sessionId.trim() !== record.sessionId || record.sessionId === '') {
      return { ok: false, error: 'sessionId must be a non-empty exact string when provided' }
    }
    value.sessionId = record.sessionId
  }
  if (record.reasoningEffort !== undefined && record.reasoningEffort !== null) {
    if (typeof record.reasoningEffort !== 'string' || record.reasoningEffort.trim() !== record.reasoningEffort || record.reasoningEffort === '') {
      return { ok: false, error: 'reasoningEffort must be a non-empty exact string when provided' }
    }
    value.reasoningEffort = record.reasoningEffort
  }
  if (record.reason !== undefined && record.reason !== null) {
    if (typeof record.reason !== 'string' || record.reason.length > 500) {
      return { ok: false, error: 'reason must be a string of at most 500 characters when provided' }
    }
    value.reason = record.reason
  }
  if (record.cwd !== undefined && record.cwd !== null) {
    if (typeof record.cwd !== 'string' || record.cwd.trim() === '') {
      return { ok: false, error: 'cwd must be a non-empty string when provided' }
    }
    value.cwd = record.cwd
  }
  if (record.timeoutMs !== undefined && record.timeoutMs !== null) {
    const timeoutMs = Number(record.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      return { ok: false, error: `timeoutMs must be a number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` }
    }
    value.timeoutMs = Math.floor(timeoutMs)
  }
  return { ok: true, value }
}

/**
 * Map one executor result to an HTTP status.
 * @param {{ stopReason?: unknown }} result
 * @returns {{ status: number, error: string }}
 */
function failureFor(result) {
  const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'unknown'
  if (stopReason === 'timeout') return { status: 504, error: 'timeout' }
  if (stopReason === 'cancelled') return { status: 408, error: 'cancelled' }
  if (stopReason === 'input-required') return { status: 409, error: 'input-required' }
  return { status: 500, error: `session-stopped:${stopReason}` }
}

/**
 * Build the Fetch handler answering both the execute and the status route.
 *
 * `token` may be the token string, a lazy getter, or a promise for it. An
 * unavailable token never throws out of the route: it logs a warning and
 * answers 500, because the route must stay sample-able while the token file is
 * still being generated.
 *
 * @param {{
 *   executor: { execute: (input: { task: string, cwd?: string, timeoutMs?: number, reasoningEffort?: string, reason?: string }) => Promise<{ sessionId: string | null, text: string, elapsedMs: number, stopReason: string }> },
 *   token: string | null | (() => string | null | Promise<string | null>) | Promise<string | null>,
 *   logger?: { warn?: (...args: unknown[]) => void },
 *   allowExecute?: boolean,
 * }} options
 * @returns {(request: Request) => Promise<Response>}
 */
function resultResponse(result) {
  const base = {
    sessionId: result?.sessionId ?? null,
    elapsedMs: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : 0,
    stopReason: result?.stopReason ?? 'unknown',
    ...(result?.workspaceId ? { workspaceId: result.workspaceId } : {}),
    ...(result?.execution ? { execution: result.execution } : {}),
  }
  if (result?.stopReason === 'needs-input' && result.needsInput?.requestId && Array.isArray(result.needsInput.questions)) {
    return jsonResponse({ ok: true, ...base, needsInput: true, question: result.needsInput })
  }
  if (result?.stopReason === 'completed' && typeof result.text === 'string' && typeof result.sessionId === 'string') {
    return jsonResponse({ ok: true, ...base, text: result.text })
  }
  const failure = failureFor(result)
  return jsonResponse({ ok: false, ...base, error: failure.error,
    ...(result?.stopReason === 'input-required' ? { message: 'DSH 会话正在等待人工审批；请打开该原生会话处理，勿重新提交原任务。可在执行权限设置为后续新会话选择完全权限或自动审核。' } : {}),
  }, failure.status)
}

export function createHttpHandler({ executor, token, logger, allowExecute = true } = /** @type {any} */ ({})) {
  const log = normalizeLogger(logger)

  return async function handleRequest(request) {
    try {
      let expected = null
      try {
        expected = await resolveToken(token)
      } catch (error) {
        log.warn(`codex-bridge: cannot resolve HTTP token: ${error?.message ?? error}`)
        return jsonResponse({ ok: false, error: 'token-unavailable' }, 500)
      }
      if (typeof expected !== 'string' || expected === '') {
        log.warn('codex-bridge: HTTP token is not available yet')
        return jsonResponse({ ok: false, error: 'token-unavailable' }, 500)
      }
      const provided = bearerToken(request)
      if (!provided || !constantTimeEqual(expected, provided)) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' })
      }

      const method = String(request.method ?? 'GET').toUpperCase()
      if (method === 'GET' || method === 'HEAD') {
        // Optional, read-only policy summary: lets the Codex side learn which
        // exact reasoning efforts it may choose for the next execution.
        let policy = null
        if (executor && typeof executor.describePolicy === 'function') {
          try {
            policy = await executor.describePolicy()
          } catch (error) {
            policy = { ok: false, error: 'policy-unavailable', message: String(error?.message ?? error) }
          }
        }
        return jsonResponse({
          ok: true,
          pid: process.pid,
          sessions: executor?.sessionCount?.() ?? 0,
          version: executor?.version ?? null,
          ...(policy === null ? {} : { policy }),
        })
      }
      if (method !== 'POST') {
        return jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET, HEAD, POST' })
      }
      // The status route is a read-only probe. Sharing one handler with the
      // execute route previously let a POST to the status path start a session.
      if (allowExecute !== true) {
        return jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET, HEAD' })
      }

      const raw = await request.text()
      if (raw.length > MAX_HTTP_BODY_BYTES) {
        return jsonResponse({ ok: false, error: 'body-too-large' }, 400)
      }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return jsonResponse({ ok: false, error: 'invalid-json' }, 400)
      }
      const parsed = parseExecuteRequest(body)
      if (parsed.ok === false) return jsonResponse({ ok: false, error: parsed.error }, 400)

      if (!executor || typeof executor.execute !== 'function') {
        log.warn('codex-bridge: execute route is up but no executor was wired')
        return jsonResponse({ ok: false, error: 'executor-unavailable' }, 500)
      }

      const result = await executor.execute(parsed.value)
      return resultResponse(result)
    } catch (error) {
      // Policy/availability failures carry an explicit status and a user-readable
      // message; never surface an unexpected internal stack or credential detail.
      const status = Number(error?.statusCode ?? error?.status)
      if (Number.isInteger(status) && status >= 400 && status < 600 && typeof error?.message === 'string') {
        log.warn(`codex-bridge: execute route rejected: ${error.message}`)
        return jsonResponse({ ok: false, error: error.code || 'execution-rejected', message: error.message, ...(error.sessionId ? { sessionId: error.sessionId } : {}), ...(error.stopReason ? { stopReason: error.stopReason } : {}) }, status)
      }
      log.warn(`codex-bridge: execute route failed: ${error?.message ?? error}`)
      return jsonResponse({ ok: false, error: 'internal-error' }, 500)
    }
  }
}

/**
 * Bearer-authenticated route for answering a relayed question.
 * Body: { sessionId: string, answers: [{ id, selected?: string[], custom?: string }], timeoutMs?: number }
 */
export function createAnswerHandler({ executor, token, logger } = /** @type {any} */ ({})) {
  const log = normalizeLogger(logger)
  return async function handleAnswer(request) {
    try {
      let expected = null
      try { expected = await resolveToken(token) } catch { return jsonResponse({ ok: false, error: 'token-unavailable' }, 500) }
      if (typeof expected !== 'string' || expected === '') return jsonResponse({ ok: false, error: 'token-unavailable' }, 500)
      const provided = bearerToken(request)
      if (!provided || !constantTimeEqual(expected, provided)) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' })
      }
      const method = String(request.method ?? 'GET').toUpperCase()
      if (method !== 'POST') return jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST' })
      if (!executor || typeof executor.answer !== 'function') return jsonResponse({ ok: false, error: 'executor-unavailable' }, 500)
      const raw = await request.text()
      if (raw.length > MAX_HTTP_BODY_BYTES) return jsonResponse({ ok: false, error: 'body-too-large' }, 400)
      let body
      try { body = JSON.parse(raw) } catch { return jsonResponse({ ok: false, error: 'invalid-json' }, 400) }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
      if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') return jsonResponse({ ok: false, error: 'sessionId is required' }, 400)
      if (typeof body.requestId !== 'string' || !body.requestId.trim()) return jsonResponse({ ok: false, error: 'requestId is required; reconnect MCP and use question.requestId' }, 400)
      if (body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1000 || body.timeoutMs > 600000)) return jsonResponse({ ok: false, error: 'invalid-timeout' }, 400)
      const result = await executor.answer({ sessionId: body.sessionId, requestId: body.requestId, answers: body.answers, timeoutMs: body.timeoutMs, ...(typeof body.clientCallId==='string' && body.clientCallId.length<=120 ? {clientCallId:body.clientCallId} : {}) })
      return resultResponse(result)
    } catch (error) {
      const status = Number(error?.statusCode ?? error?.status)
      if (Number.isInteger(status) && status >= 400 && status < 600 && typeof error?.message === 'string') {
        log.warn(`codex-bridge: answer route rejected: ${error.message}`)
        return jsonResponse({ ok: false, error: error.code || 'answer-rejected', message: error.message, ...(error.sessionId ? { sessionId: error.sessionId } : {}), ...(error.stopReason ? { stopReason: error.stopReason } : {}) }, status)
      }
      log.warn(`codex-bridge: answer route failed: ${error?.message ?? error}`)
      return jsonResponse({ ok: false, error: 'internal-error' }, 500)
    }
  }
}

/** @param {string} executePath */
function deriveStatusPath(executePath) {
  if (/\.execute\/?$/.test(executePath)) return executePath.replace(/\.execute\/?$/, '.status')
  if (/\/execute\/?$/.test(executePath)) return executePath.replace(/\/execute\/?$/, '/status')
  return `${executePath.replace(/\/$/, '')}.status`
}

/**
 * Read a Node request body with a hard cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ tooLarge: boolean, body: Buffer }>}
 */
async function readNodeBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_HTTP_BODY_BYTES) {
      req.resume()
      return { tooLarge: true, body: Buffer.alloc(0) }
    }
    chunks.push(buffer)
  }
  return { tooLarge: false, body: Buffer.concat(chunks) }
}

/** @param {import('node:http').IncomingMessage} req @param {Buffer} body */
function toFetchRequest(req, body) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item))
    } else {
      headers.append(name, String(value))
    }
  }
  const method = String(req.method ?? 'GET').toUpperCase()
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  /** @type {RequestInit} */
  const init = { method, headers }
  if (body.length > 0 && method !== 'GET' && method !== 'HEAD') init.body = body
  return new Request(url, init)
}

/**
 * Adapt the Fetch handler to the Node `IncomingMessage`/`ServerResponse`
 * contract that `webServer` handler routes use. Resource routes are NOT usable
 * for the execute entry: `serveResource` answers 405 to every non-GET/HEAD
 * request without reading the body.
 * @param {(request: Request) => Promise<Response>} fetchHandler
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ReturnType<typeof normalizeLogger>} log
 */
async function serveNodeRequest(fetchHandler, req, res, log) {
  try {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method === 'CONNECT' || method === 'TRACE' || method === 'TRACK') {
      res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
      return
    }
    let body = Buffer.alloc(0)
    if (method !== 'GET' && method !== 'HEAD') {
      const read = await readNodeBody(req)
      if (read.tooLarge) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'body-too-large' }))
        return
      }
      body = read.body
    }
    const response = await fetchHandler(toFetchRequest(req, body))
    /** @type {Record<string, string>} */
    const headers = {}
    response.headers.forEach((value, name) => {
      headers[name] = value
    })
    const payload = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, headers)
    res.end(payload)
  } catch (error) {
    log.warn(`codex-bridge: HTTP handler failed: ${error?.message ?? error}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'internal-error' }))
    } else {
      res.destroy()
    }
  }
}

/**
 * Register the execute + status HTTP routes on the Host web server.
 *
 * `ctx.webServer.register({ kind:'exact', path, handler })` is the primary
 * carrier: it is a raw Node `IncomingMessage`/`ServerResponse` route on the same
 * listener as the Web GUI, and named routes do not apply browser auth, so an
 * external loopback caller reaches it with only the bridge bearer token. A
 * `resource` (Fetch) route cannot be used for the execute entry: the web server
 * answers 405 to every non-GET/HEAD request on resource routes without reading
 * the body. When `webServer` is not mounted, it falls back to
 * `ctx.connection.fetch.register(...)`, which is documented as serving
 * already-authenticated browser traffic and may reject external callers with
 * 401.
 *
 * @param {{
 *   ctx: any,
 *   executor: any,
 *   token?: string | null,
 *   logger?: any,
 *   path?: string,
 * }} options
 * @returns {() => void}
 */
export function registerHttpRoute({ ctx, executor, token, logger, path, taskManager } = /** @type {any} */ ({})) {
  const log = normalizeLogger(logger)
  const executePath = typeof path === 'string' && path.startsWith('/') ? path : DEFAULT_EXECUTE_PATH
  const statusPath = deriveStatusPath(executePath)
  const answerPath = /\.execute\/?$/.test(executePath) ? executePath.replace(/\.execute\/?$/, '.answer') : `${executePath.replace(/\/$/, '')}.answer`

  let currentToken = typeof token === 'string' && token !== '' ? token : null
  let tokenReady = currentToken !== null
  if (!tokenReady) {
    ensureTokenFile({ logger: log })
      .then((result) => {
        currentToken = result.token
        tokenReady = true
        log.info(`codex-bridge: HTTP token ready at ${result.path}`)
      })
      .catch((error) => {
        log.warn(`codex-bridge: cannot prepare HTTP token: ${error?.message ?? error}`)
      })
  }

  const executeHandler = createHttpHandler({
    executor,
    logger: log,
    token: () => (tokenReady ? currentToken : null),
    allowExecute: true,
  })
  // A read-only handler for the status path: POST there must never execute.
  const statusHandler = createHttpHandler({
    executor,
    logger: log,
    token: () => (tokenReady ? currentToken : null),
    allowExecute: false,
  })
  // Publish the live handlers first: a route mounted by an earlier generation
  // resolves through this map, so the newest code serves even when the route
  // table cannot be re-registered.
  const answerHandler = createAnswerHandler({ executor, logger: log, token: () => (tokenReady ? currentToken : null) })
  const taskHandler = async request => {
    const expected = tokenReady ? currentToken : null
    const provided = bearerToken(request)
    if (!expected || !provided || !constantTimeEqual(expected,provided)) return jsonResponse({ok:false,error:'unauthorized'},401)
    if (request.method !== 'POST') return jsonResponse({ok:false,error:'method-not-allowed'},405)
    try {
      const raw=await request.text()
      if(raw.length>MAX_HTTP_BODY_BYTES) return jsonResponse({ok:false,error:'body-too-large'},400)
      return jsonResponse({ok:true,value:await dispatchTask(taskManager(),JSON.parse(raw))})
    } catch(error) { return jsonResponse({ok:false,error:error.code ?? 'task-operation-failed',message:error.status ? error.message : '任务操作失败'},error.status ?? (error instanceof SyntaxError ? 400 : 500)) }
  }
  if(taskManager) routeHandlers.set(TASK_PATH,taskHandler)
  routeHandlers.set(executePath, executeHandler)
  routeHandlers.set(statusPath, statusHandler)
  routeHandlers.set(answerPath, answerHandler)
  const dispatchFor = (path, fallback) => (req, res) => {
    const current = routeHandlers.get(path) || (() => Promise.resolve(jsonResponse({ ok: false, error: 'bridge-unloaded' }, 503)))
    return serveNodeRequest(current, req, res, log)
  }
  const dispatchExecute = dispatchFor(executePath, executeHandler)
  const dispatchStatus = dispatchFor(statusPath, statusHandler)
  const dispatchAnswer = dispatchFor(answerPath, answerHandler)

  // Route table survives plugin reloads, so mount once; later generations swap
  // the handler through `routeHandlers`. If the host does tear routes down, the
  // returned disposers keep this registration removable.
  const unpublish = () => {
    for (const [key, value] of [[TASK_PATH,taskHandler], [executePath, executeHandler], [statusPath, statusHandler], [answerPath, answerHandler]]) {
      if (routeHandlers.get(key) === value) routeHandlers.delete(key)
    }
  }
  const disposers = []
  const executeDispose = mountNodeRoute(ctx, executePath, dispatchExecute)
  if (executeDispose) {
    disposers.push(executeDispose)
    if(taskManager) { const d=mountNodeRoute(ctx,TASK_PATH,dispatchFor(TASK_PATH,taskHandler)); if(d)disposers.push(d) }

    const statusDispose = mountNodeRoute(ctx, statusPath, dispatchStatus)
    if (statusDispose) disposers.push(statusDispose)
    const answerDispose = mountNodeRoute(ctx, answerPath, dispatchAnswer)
    if (answerDispose) disposers.push(answerDispose)
    log.info(`codex-bridge: webServer routes mounted: POST ${executePath}, GET ${statusPath}, POST ${answerPath}`)
    return () => {
      unpublish()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }
  const fetchDispatch = (path) => (request) => {
    const handler = routeHandlers.get(path)
    return handler ? handler(request) : jsonResponse({ ok: false, error: 'bridge-unloaded' }, 503)
  }
  if(taskManager) mountBrowserRoute(ctx,TASK_PATH,['POST'],fetchDispatch(TASK_PATH))
  mountBrowserRoute(ctx, executePath, ['GET', 'POST'], fetchDispatch(executePath))
  mountBrowserRoute(ctx, statusPath, ['GET'], fetchDispatch(statusPath))
  mountBrowserRoute(ctx, answerPath, ['POST'], fetchDispatch(answerPath))
  log.info(`codex-bridge: connection.fetch routes mounted: ${executePath}, ${statusPath}, ${answerPath}`)
  return unpublish
}

