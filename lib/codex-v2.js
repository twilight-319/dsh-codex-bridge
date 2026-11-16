/**
 * Codex exec runner: one fresh, ephemeral, read-only Codex turn per consult.
 *
 * Verified contract on this machine (codex-cli 0.166.0):
 *   codex exec --json --skip-git-repo-check --ephemeral -C <cwd> -s read-only \
 *     -c approval_policy="never" [--output-schema <file>] [-m <model>] \
 *     [-c model_reasoning_effort=<effort>] -o <file> "<delivery note>"
 * The real prompt goes to stdin: Codex appends a piped stdin as a `<stdin>`
 * block after the argv prompt, so long contexts never hit the Windows
 * command-line limit and the bundled 0.153.4 payload behaves too.
 * `--output-schema` is enforced by the model, so `-o` holds strict JSON.
 *
 * @module @local/dsh-codex-bridge/codex
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createAppServerSession } from './appserver.js'

const PLATFORM_REL = 'vendor/x86_64-pc-windows-msvc/bin/codex.exe'
const DEFAULT_TIMEOUT_MS = 240_000

/** Resolve the native Codex executable once; `.cmd` shims break stdin piping. */
let cachedBin = null

function probeExe(path) {
  try {
    return existsSync(path) && statSync(path).isFile() ? path : null
  } catch {
    return null
  }
}

function exeCandidates() {
  const candidates = []
  const fromEnv = process.env.CODEX_BRIDGE_CODEX_EXE
  if (fromEnv) candidates.push(fromEnv)
  // Prefer the PATH install (0.166.x here): its `exec` accepts long stdin
  // prompts. The profile-bundled payload (0.153.4) is a last resort — its
  // `exec` hangs when the prompt is passed as `-`, so the runner below sends a
  // short argv instruction plus the real prompt on stdin instead.
  if (process.platform === 'win32') {
    const located = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true })
    const lines = (located.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    for (const shim of lines) {
      const dir = dirname(shim)
      candidates.push(join(dir, 'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64', PLATFORM_REL))
      candidates.push(join(dir, 'node_modules/@openai/codex-win32-x64', PLATFORM_REL))
      candidates.push(join(dir, 'node_modules/@openai/codex/bin/codex.exe'))
    }
  }
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) candidates.push(join(profileDir, 'node_modules/@openai/codex-win32-x64', PLATFORM_REL))
  return candidates
}

/**
 * @returns {{ command: string, prefix: string[], source: string } | null}
 */
export function resolveCodexBin(override) {
  if (cachedBin !== null && !override) return cachedBin
  const attempted = []
  const tryPath = (path) => {
    if (!path) return null
    attempted.push(path)
    const exe = probeExe(path)
    if (exe) return { command: exe, prefix: [], source: 'native' }
    return null
  }
  const resolved = tryPath(override) ?? exeCandidates().map(tryPath).find(Boolean)
  if (resolved) {
    cachedBin = resolved
    return resolved
  }
  // Fall back to the PATH shim: works for argv prompts, not for long stdin prompts.
  const onPath = process.platform === 'win32' ? spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true }) : null
  if (onPath !== null && onPath.status === 0 && (onPath.stdout ?? '').trim() !== '') {
    const command = (onPath.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
    const fallback = { command, prefix: [], source: 'path' }
    cachedBin = fallback
    return fallback
  }
  return null
}

/** Kill a Codex process and every child it spawned (its sandbox helpers). */
export function killTree(pid) {
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

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function tail(text, limit) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`
}

/** Parse the JSONL event stream for diagnostics when `-o` is empty. */
function parseEvents(stdout) {
  let answer = ''
  let usage = null
  let threadId = ''
  let failure = ''
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      answer = event.item.text
    }
    if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') usage = event.usage
    if (event.type === 'turn.failed') failure = JSON.stringify(event.error ?? event)
    if (event.type === 'error' && typeof event.message === 'string') failure = event.message
  }
  return { answer, usage, threadId, failure }
}

/** Bounded FIFO semaphore so concurrent consults cannot exhaust the Codex quota. */
class Semaphore {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.queue = []
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(() => this.release())
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null }
      if (signal) {
        entry.onAbort = () => {
          const index = this.queue.indexOf(entry)
          if (index !== -1) this.queue.splice(index, 1)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.queue.push(entry)
    }).then(() => {
      this.active += 1
      return () => this.release()
    })
  }

  release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
      next.resolve()
    }
  }
}

function abortError(signal) {
  const error = new Error('codex consult aborted')
  error.name = 'AbortError'
  error.cause = signal?.reason
  return error
}

function pruneRuns(dir, keep) {
  try {
    const files = readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
    for (const file of files.slice(0, Math.max(0, files.length - keep))) {
      try {
        unlinkSync(join(dir, file))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Persist one consult (prompt/answer/meta/stderr tail) for debugging. */
function recordRun({ kind, prompt, answer, meta, stderr, runnerDir, logRuns, logger }) {
  if (!logRuns) return
  const runsDir = join(runnerDir, 'runs')
  try {
    mkdirSync(runsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(
      join(runsDir, `${stamp}-${kind ?? 'consult'}.json`),
      JSON.stringify(
        {
          kind,
          prompt: prompt.length > 20_000 ? `${prompt.slice(0, 20_000)}…` : prompt,
          answer,
          meta,
          stderr: tail(stderr, 4_000),
        },
        null,
        2,
      ),
      'utf8',
    )
    pruneRuns(runsDir, 40)
  } catch (error) {
    logger?.warn?.(`codex-bridge: failed to log run: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** App-server usage is camelCase; the tool meta uses the exec event shape. */
function sessionUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
  }
}

/** Failures where a one-shot `codex exec` retry is worth one attempt. */
const FALLBACK_CODES = new Set(['session-dead', 'appserver-exit', 'start-failed', 'spawn-failed', 'transport-error', 'protocol-error', 'no-answer'])

/**
 * Whether the failure looks like a Codex login/credential problem (HTTP 401,
 * "unauthorized", expired token, ...). Long-lived app-server sessions can keep a
 * stale in-memory credential after the CLI refreshes `auth.json`, so the bridge
 * restarts its session once for these failures instead of failing the consult.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAuthFailure(error) {
  if (error === null || typeof error !== 'object') return false
  const parts = []
  for (const key of ['message', 'codexErrorInfo', 'additionalDetails']) {
    const value = /** @type {any} */ (error)[key]
    if (typeof value === 'string') parts.push(value)
    else if (value !== undefined && value !== null) {
      try { parts.push(JSON.stringify(value)) } catch { /* ignore */ }
    }
  }
  // Deliberately narrow: a bare "401" can appear in unrelated counts/output.
  return /http[^\d]{0,10}401|"httpstatuscode"\s*:\s*401|\b401\s+unauthoriz|unauthoriz|not logged in|authentication (?:failed|required)|login required|invalid[_ ]?\w*api[_ ]?key|oauth/i.test(parts.join(' '))
}

/** Actionable error for a Codex login/credential failure. */
function authRequiredError(error) {
  const detail = error instanceof Error ? error.message : String(error)
  return Object.assign(
    new Error(`Codex 登录态失效或未授权（401）：请在 Codex App 重新登录后重试；桥接不会自动切换模型或绕过登录。原始错误：${detail}`),
    { code: 'codex-auth-required', cause: error },
  )
}

/**
 * Create the shared runner used by every bridge tool.
 *
 * Two transports share one API:
 * - `app-server` (default): one long-lived `codex app-server` process and one
 *   ephemeral thread per (agent, cwd), so successive consults keep context.
 * - `exec`: one fresh process per consult; also the automatic fallback when a
 *   persistent session dies in a way a fresh turn can recover from.
 *
 * @param {{
 *   codexPath?: string, model?: string, reasoningEffort?: string, sandbox?: string,
 *   timeoutMs?: number, maxConcurrency?: number, logRuns?: boolean, runnerDir?: string,
 *   sessionMode?: 'app-server' | 'exec', maxSessions?: number, sessionIdleMs?: number,
 *   logger?: { warn?: (message: string) => void, debug?: (message: string) => void },
 * }} config
 */
export function createRunner(config = {}) {
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrency ?? 2))
  const runnerDir = config.runnerDir ?? join(homedir(), '.dsh', 'codex-bridge')
  const mode = config.sessionMode === 'exec' ? 'exec' : 'app-server'
  const maxSessions = Math.max(1, Number(config.maxSessions ?? 3))
  const sessionIdleMs = Math.max(60_000, Number(config.sessionIdleMs ?? 900_000))
  /** @type {Map<string, { session: ReturnType<typeof createAppServerSession>, cwd: string, lastUsed: number, busy: boolean }>} */
  const sessions = new Map()
  let disposed = false

  const base = () => ({
    model: config.model ?? '',
    effort: config.reasoningEffort ?? '',
    sandbox: config.sandbox ?? 'read-only',
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    codexPath: config.codexPath ?? '',
    logRuns: config.logRuns !== false,
    logger: config.logger,
  })

  async function evict(key) {
    const entry = sessions.get(key)
    if (!entry) return
    sessions.delete(key)
    try {
      await entry.session.dispose()
    } catch (error) {
      config.logger?.warn?.(`codex-bridge: disposing app-server session failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const idleTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of sessions) {
      if (entry.busy || now - entry.lastUsed <= sessionIdleMs) continue
      void evict(key)
    }
  }, 60_000)
  idleTimer.unref?.()

  async function ensureSession(key, cwd) {
    const existing = sessions.get(key)
    if (existing && existing.session.alive) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing) sessions.delete(key)
    const deadline = Date.now() + 60_000
    while (sessions.size >= maxSessions) {
      const idle = [...sessions.entries()]
        .filter(([, entry]) => !entry.busy)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (idle) {
        await evict(idle[0])
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`codex-bridge: all ${maxSessions} app-server sessions are busy; retry when one finishes`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const bin = resolveCodexBin(config.codexPath ?? '')
    if (!bin) {
      throw new Error('codex CLI not found: install Codex CLI or set codexPath to the native codex executable')
    }
    const options = base()
    const session = createAppServerSession({
      bin,
      cwd,
      sandbox: options.sandbox,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      logger: options.logger,
    })
    const entry = { session, cwd, lastUsed: Date.now(), busy: false }
    sessions.set(key, entry)
    config.logger?.debug?.(`codex-bridge: opened app-server session for ${key}`)
    return entry
  }

  async function consultPersistent(request, options, retried = false) {
    const key = `${request.sessionKey}|${request.cwd ?? ''}`
    const entry = await ensureSession(key, request.cwd ?? process.cwd())
    entry.busy = true
    try {
      const result = await entry.session.consult({
        prompt: request.prompt,
        schema: request.schema,
        signal: request.signal,
        timeoutMs: request.timeoutMs ?? options.timeoutMs,
        ...(request.model ?? options.model ? { model: request.model ?? options.model } : {}),
        ...(request.effort ?? options.effort ? { effort: request.effort ?? options.effort } : {}),
      })
      const meta = {
        elapsedMs: result.elapsedMs,
        exitCode: 0,
        timedOut: false,
        sandbox: options.sandbox,
        cwd: request.cwd ?? process.cwd(),
        model: request.model || options.model || 'native',
        effort: request.effort || options.effort || 'native',
        usage: sessionUsage(result.usage),
        threadId: result.threadId ?? null,
        mode: 'app-server',
        bin: 'native',
      }
      recordRun({ kind: request.kind, prompt: request.prompt, answer: result.answer, meta, stderr: '', runnerDir, logRuns: options.logRuns, logger: options.logger })
      if (result.answer === '') throw Object.assign(new Error('codex app-server completed without an answer'), { code: 'no-answer' })
      return { answer: result.answer, meta }
    } catch (error) {
      if (isAuthFailure(error)) {
        // A refreshed CLI credential does not reach an app-server process that
        // already holds a stale token. Recreate the session and try once.
        if (!retried) {
          config.logger?.warn?.('codex-bridge: Codex credential rejected (401); restarting app-server session and retrying once')
          await evict(key)
          return await consultPersistent(request, options, true)
        }
        throw authRequiredError(error)
      }
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (!FALLBACK_CODES.has(code)) throw error
      config.logger?.warn?.(`codex-bridge: persistent session failed (${code}); falling back to codex exec: ${error.message}`)
      await evict(key)
      let fallback
      try {
        fallback = await runOnce({
          ...request,
          ...options,
          runnerDir,
          kind: request.kind,
        })
      } catch (fallbackError) {
        if (isAuthFailure(fallbackError)) throw authRequiredError(fallbackError)
        throw fallbackError
      }
      fallback.meta.mode = 'exec-fallback'
      fallback.meta.fallbackReason = `${code}: ${error.message}`
      recordRun({
        kind: request.kind,
        prompt: request.prompt,
        answer: fallback.answer,
        meta: fallback.meta,
        stderr: '',
        runnerDir,
        logRuns: options.logRuns,
        logger: options.logger,
      })
      return fallback
    } finally {
      entry.busy = false
      entry.lastUsed = Date.now()
    }
  }

  return {
    /**
     * Run one consult.
     * @param {{
     *   prompt: string, schema?: object, cwd?: string, model?: string, effort?: string,
     *   timeoutMs?: number, signal?: AbortSignal, kind?: string, sessionKey?: string,
     * }} request
     */
    async consult(request) {
      if (disposed) throw new Error('codex-bridge: runner has been disposed')
      const release = await semaphore.acquire(request.signal)
      try {
        const options = base()
        if (mode === 'app-server' && typeof request.sessionKey === 'string' && request.sessionKey !== '') {
          return await consultPersistent(request, options)
        }
        try {
          return await runOnce({ ...request, ...options, runnerDir })
        } catch (error) {
          if (isAuthFailure(error)) throw authRequiredError(error)
          throw error
        }
      } finally {
        release()
      }
    },
    /** Diagnostics for the bridge page. */
    stats() {
      return {
        mode,
        sessions: [...sessions.entries()].map(([key, entry]) => ({
          key,
          cwd: entry.cwd,
          busy: entry.busy,
          alive: entry.session.alive,
          threadId: entry.session.threadId ?? null,
          lastUsed: entry.lastUsed,
        })),
      }
    },
    /** Drop every session created under one logical key (e.g. the page console). */
    async resetSession(sessionKey) {
      if (typeof sessionKey !== 'string' || sessionKey === '') return 0
      const prefix = `${sessionKey}|`
      const keys = [...sessions.keys()].filter((key) => key.startsWith(prefix))
      await Promise.allSettled(keys.map((key) => evict(key)))
      return keys.length
    },
    async dispose() {
      if (disposed) return
      disposed = true
      clearInterval(idleTimer)
      await Promise.allSettled([...sessions.keys()].map((key) => evict(key)))
    },
  }
}

async function runOnce(options) {
  const { prompt, schema, cwd, model, effort, sandbox, timeoutMs, codexPath, runnerDir, logRuns, signal, kind, logger } = options
  const bin = resolveCodexBin(codexPath)
  if (!bin) {
    throw new Error('codex CLI not found: set Codex path in the plugin settings or install Codex CLI so `where codex` resolves')
  }
  const workDir = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
  const schemaPath = join(workDir, 'schema.json')
  const answerPath = join(workDir, 'last-message.txt')
  if (schema) writeFileSync(schemaPath, JSON.stringify(schema), 'utf8')
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    cwd ?? process.cwd(),
    '-s',
    sandbox,
    '-c',
    'approval_policy="never"',
    '-o',
    answerPath,
  ]
  if (schema) args.push('--output-schema', schemaPath)
  if (model) args.push('-m', model)
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`)
  // The prompt itself travels on stdin; argv only carries the delivery note, so
  // arbitrarily long contexts never hit the Windows command-line limit and both
  // 0.153.x and 0.166.x behave. (`-` as the prompt argument hangs 0.153.x.)
  args.push('The complete instructions are inside the <stdin> block. Follow them exactly and reply with only the requested output.')

  const startedAt = Date.now()
  const stdoutChunks = []
  const stderrChunks = []
  let stdoutSize = 0
  let stderrSize = 0

  const child = spawn(bin.command, [...bin.prefix, ...args], {
    cwd: cwd ?? process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let timedOut = false
  let exitCode = null
  let timer = null
  let abortListener = null
  let settled = false
  const done = new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (abortListener && signal) signal.removeEventListener('abort', abortListener)
      if (error) reject(error)
      else resolve()
    }
    timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      finish(new Error(`codex consult timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    if (signal) {
      abortListener = () => {
        killTree(child.pid)
        finish(abortError(signal))
      }
      if (signal.aborted) abortListener()
      else signal.addEventListener('abort', abortListener, { once: true })
    }
    child.on('error', (error) => finish(new Error(`failed to start codex: ${error.message}`)))
    child.on('close', (code) => {
      exitCode = code
      finish(null)
    })
  })

  child.stdout?.on('data', (chunk) => {
    if (stdoutSize > 8 * 1024 * 1024) return
    stdoutSize += chunk.length
    stdoutChunks.push(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    if (stderrSize > 256 * 1024) return
    stderrSize += chunk.length
    stderrChunks.push(chunk)
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(prompt)

  try {
    await done
  } catch (error) {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw error
  }

  const elapsedMs = Date.now() - startedAt
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  const events = parseEvents(stdout)
  const answer = readText(answerPath).trim() !== '' ? readText(answerPath).trim() : events.answer
  const meta = {
    elapsedMs,
    exitCode,
    timedOut,
    sandbox,
    cwd: cwd ?? process.cwd(),
    model: model || 'native',
    effort: effort || 'native',
    usage: events.usage ?? null,
    threadId: events.threadId || null,
    bin: bin.source,
  }
  recordRun({ kind, prompt, answer, meta, stderr, runnerDir, logRuns, logger })
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  if (answer === '') {
    const detail = events.failure || tail(stderr, 800) || `exit code ${exitCode}`
    throw new Error(`codex returned no answer (${detail})`)
  }
  return { answer, meta }
}

/** Compact one-line run summary used in tool output footers. */
export function describeRun(meta) {
  const seconds = (meta.elapsedMs / 1000).toFixed(1)
  const usage = meta.usage
  const tokens = usage
    ? ` · ${Math.round((usage.input_tokens ?? 0) / 1000)}k in / ${usage.output_tokens ?? 0} out`
    : ''
  return `Codex ${meta.model} · ${seconds}s${tokens} · sandbox ${meta.sandbox}`
}
