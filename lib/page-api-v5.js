/**
 * Browser-facing API for the bridge page.
 *
 * The page is a normal central panel (`main` keyed slot), so its data must come
 * from a Host route the *browser* may call. `ctx.connection.fetch.register`
 * serves exactly that: same-origin, already authenticated by the Host/Origin
 * check, and separate from the external `webServer` bearer routes that Codex's
 * MCP server uses.
 *
 *   GET  /api/dsh-codex-bridge.page   → status snapshot + recent consults
 *   POST /api/dsh-codex-bridge.page   → { action: 'consult', kind, prompt, context? }
 *
 * The bearer token for the external route is never returned to the page.
 *
 * @module @local/dsh-codex-bridge/page-api
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertResultShape, SCHEMAS } from './schemas.js'
import { buildPrompt, parseAnswer } from './prompts.js'
import { groupByProject, readSessions } from './ledger.js'

export const PAGE_API_PATH = '/api/dsh-codex-bridge.v2.page'
export const CODEX_API_PATH = '/api/dsh-codex-bridge.v2.codex'
const MAX_PROMPT_CHARS = 20_000
const MAX_RUNS = 12
const CONSULT_KINDS = new Set(['decide', 'plan', 'ask'])

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: HEADERS })
}

/** Memoize `codex --version` (a 295 MB binary is expensive to start twice). */
function createVersionProbe(logger) {
  let cached = null
  return (bin) => {
    if (cached !== null) return cached
    if (typeof bin?.command !== 'string' || bin.command === '') return (cached = '')
    try {
      const result = spawnSync(bin.command, ['--version'], { encoding: 'utf8', timeout: 8_000, windowsHide: true })
      const text = `${result.stdout ?? ''} ${result.stderr ?? ''}`.trim()
      const match = /codex-cli\s+(\S+)/.exec(text)
      cached = match ? match[1] : text.split(/\r?\n/)[0] ?? ''
    } catch (error) {
      logger?.warn?.(`codex-bridge(page): codex --version failed: ${error instanceof Error ? error.message : String(error)}`)
      cached = ''
    }
    return cached
  }
}

function readRuns(runsDir) {
  try {
    const files = readdirSync(runsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const path = join(runsDir, file)
        try {
          return { file, path, mtime: statSync(path).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_RUNS)
    return files.map((entry) => {
      let record = null
      try {
        record = JSON.parse(readFileSync(entry.path, 'utf8'))
      } catch {
        return { file: entry.file, at: entry.mtime, kind: 'unknown', broken: true }
      }
      const meta = record.meta ?? {}
      const usage = meta.usage ?? {}
      return {
        file: entry.file,
        at: entry.mtime,
        kind: record.kind ?? 'consult',
        mode: meta.mode ?? 'exec',
        elapsedMs: meta.elapsedMs ?? 0,
        model: meta.model ?? 'native',
        effort: meta.effort ?? 'native',
        cwd: meta.cwd ?? '',
        threadId: meta.threadId ?? '',
        fallbackReason: meta.fallbackReason ?? '',
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        preview: typeof record.answer === 'string' ? record.answer.slice(0, 500) : '',
      }
    })
  } catch {
    return []
  }
}

function appPluginState() {
  const home = homedir()
  const configPath = join(home, '.codex', 'config.toml')
  const cacheRoot = join(home, '.codex', 'plugins', 'cache', 'personal', 'dsh-bridge')
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json')
  let configEntry = false
  try {
    configEntry = readFileSync(configPath, 'utf8').includes('[plugins."dsh-bridge@personal"]')
  } catch {
    /* no codex config */
  }
  let versions = []
  try {
    versions = readdirSync(cacheRoot).filter((name) => /^\d+\.\d+\.\d+/.test(name))
  } catch {
    /* not installed */
  }
  let marketplace = false
  try {
    const parsed = JSON.parse(readFileSync(marketplacePath, 'utf8'))
    marketplace = Array.isArray(parsed.plugins) && parsed.plugins.some((plugin) => plugin?.name === 'dsh-bridge')
  } catch {
    /* no personal marketplace */
  }
  return {
    marketplace,
    configEntry,
    installed: versions.length > 0,
    version: versions.sort().at(-1) ?? '',
    pluginName: 'dsh-bridge@personal',
    tools: ['mcp__dsh_bridge__dsh_execute', 'mcp__dsh_bridge__dsh_answer', 'mcp__dsh_bridge__dsh_status'],
  }
}

/**
 * @param {{
 *   ctx: any,
 *   runner: { stats?: () => any, consult: (request: any) => Promise<any> },
 *   config: any,
 *   logger?: any,
 *   runsDir?: string,
 * }} options
 */
export function createPageApi({ ctx, runner, config, logger, runsDir } = /** @type {any} */ ({})) {
  const connection = (typeof ctx?.get === 'function' ? ctx.get('connection') : undefined) ?? ctx?.connection
  const registry = connection?.fetch
  if (!registry || typeof registry.register !== 'function') {
    logger?.warn?.('codex-bridge(page): ctx.connection.fetch is unavailable; the bridge page has no data source')
    return () => {}
  }
  const probeVersion = createVersionProbe(logger)
  const effectiveRunsDir = runsDir ?? join(homedir(), '.dsh', 'codex-bridge', 'runs')
  // Page-initiated consults are for quick questions: cap them so a stalled local
  // gateway surfaces as a readable error instead of an endless spinner.
  const pageTimeoutMs = Math.max(15_000, Math.min(Number(config.timeoutMs) || 120_000, 120_000))

  const resolveBin = () => {
    try {
      // index.js passes the resolver through config-like scope to avoid importing twice.
      return config.resolveBin?.() ?? null
    } catch {
      return null
    }
  }

  const snapshot = (request) => {
    let origin = ''
    try {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
      if (webServer && typeof webServer.getOrigin === 'function') origin = webServer.getOrigin()
    } catch {
      /* keep default */
    }
    try {
      const host = request?.headers?.get?.('host')
      if (host) origin = `http://${host}`
    } catch {
      /* ignore */
    }
    const resolvedBin = resolveBin()
    const stats = typeof runner?.stats === 'function' ? runner.stats() : { mode: config.sessionMode, sessions: [] }
    return {
      ok: true,
      version: config.pluginVersion ?? '0.3.0',
      codex: {
        bin: resolvedBin?.command ?? '',
        binSource: resolvedBin?.source ?? '',
        version: resolvedBin ? probeVersion(resolvedBin) : '',
        model: config.model || 'native',
        effort: config.reasoningEffort || 'native',
        sandbox: config.sandbox,
        sessionMode: config.sessionMode,
        maxSessions: config.maxSessions,
        sessions: (stats.sessions ?? []).map((session) => ({
          key: session.key ?? '',
          cwd: session.cwd ?? '',
          busy: Boolean(session.busy),
          alive: Boolean(session.alive),
          threadId: session.threadId ?? null,
          lastUsed: session.lastUsed ?? 0,
        })),
        pageSession: (() => {
          const entry = (stats.sessions ?? []).find((session) => String(session.key ?? '').startsWith('page-console|'))
          if (!entry) return null
          return { alive: Boolean(entry.alive), busy: Boolean(entry.busy), threadId: entry.threadId ?? null }
        })(),
      },
      reverse: {
        enabled: config.reverseBridge !== false,
        executePath: config.executePath ?? '/api/dsh-codex-bridge.execute',
        statusPath: config.statusPath ?? '/api/dsh-codex-bridge.status',
        origin,
        tokenPath: join(homedir(), '.dsh', 'codex-bridge', 'http-token'),
        tokenReady: existsSync(join(homedir(), '.dsh', 'codex-bridge', 'http-token')),
        pid: process.pid,
      },
      appPlugin: appPluginState(),
      runs: readRuns(effectiveRunsDir),
    }
  }

  const consult = async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, error: 'invalid-json' }, 400)
    }
    const action = typeof body?.action === 'string' ? body.action : 'consult'
    if (action === 'reset') {
      if (typeof runner?.resetSession !== 'function') return json({ ok: false, error: 'reset is unavailable' }, 501)
      try {
        const dropped = await runner.resetSession('page-console')
        return json({ ok: true, action: 'reset', dropped })
      } catch (error) {
        logger?.warn?.(`codex-bridge(page): reset failed: ${error instanceof Error ? error.message : String(error)}`)
        return json({ ok: false, error: 'reset-failed' }, 500)
      }
    }
    if (action !== 'consult') return json({ ok: false, error: 'unknown action' }, 400)
    const kind = typeof body?.kind === 'string' ? body.kind : ''
    if (!CONSULT_KINDS.has(kind)) return json({ ok: false, error: 'kind must be decide, plan or ask' }, 400)
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt === '') return json({ ok: false, error: 'prompt is required' }, 400)
    if (prompt.length > MAX_PROMPT_CHARS) return json({ ok: false, error: `prompt exceeds ${MAX_PROMPT_CHARS} characters` }, 400)
    const context = typeof body?.context === 'string' ? body.context.trim() : ''
    const field = kind === 'plan' ? 'task' : 'question'
    const built = buildPrompt(
      kind,
      { [field]: prompt, ...(context ? { context } : {}) },
      {
        cwd: process.cwd(),
        date: new Date().toISOString().slice(0, 10),
        mode: config.sandbox === 'danger-full-access' ? 'full repository access' : 'text only, no shell',
      },
    )
    try {
      const result = await runner.consult({
        prompt: built,
        schema: SCHEMAS[kind],
        cwd: process.cwd(),
        kind,
        effort: 'low',
        timeoutMs: pageTimeoutMs,
        // The page gets its own persistent consultant thread: app-server works
        // even when the one-shot `codex exec` path stalls on this machine, and
        // successive questions remember earlier ones.
        sessionKey: 'page-console',
      })
      const parsed = parseAnswer(result.answer)
      if (parsed.ok === false) {
        return json({ ok: false, error: `codex answered with non-JSON (${parsed.reason})` }, 502)
      }
      const value = assertResultShape(kind, parsed.value)
      const usage = result.meta?.usage ?? {}
      return json({
        ok: true,
        kind,
        value,
        meta: {
          elapsedMs: result.meta?.elapsedMs ?? 0,
          model: result.meta?.model ?? 'native',
          mode: result.meta?.mode ?? 'exec',
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`codex-bridge(page): consult failed: ${message}`)
      const readable = /timed out/i.test(message)
        ? `页面咨询超时（${Math.round(pageTimeoutMs / 1000)}s）：本机 Codex 网关可能正忙，稍后重试，或改用会话里的 codex_* 工具。`
        : message
      return json({ ok: false, error: readable }, 502)
    }
  }

  const handler = async (request) => {
    const method = String(request.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') return json(snapshot(request))
    if (method === 'POST') return consult(request)
    return json({ ok: false, error: 'method-not-allowed' }, 405)
  }

  // Sessions Codex started through the reverse bridge: they are not attached to
  // any workspace, so the sidebar never shows them. The "Codex" conversation
  // view reads this index instead.
  const sessionsService = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
    } catch {
      return null
    }
  })()
  const isLive = (sessionId) => {
    try {
      return Boolean(sessionsService?.get?.(sessionId))
    } catch {
      return false
    }
  }
  const codexIndex = () => {
    const sessions = readSessions({ limit: 200 }).map((session) => {
      const live = isLive(session.sessionId)
      const ended = Number(session.endedAt) > 0
      let status = session.state === 'running' ? 'running' : session.state === 'needs-input' || session.state === 'input-required' ? 'waiting' : 'unknown'
      if (ended) {
        const reason = session.stopReason || ''
        status = reason === 'completed' ? 'done' : reason === 'error' ? 'failed' : 'interrupted'
      }
      // A live Session object does not prove an Agent is currently executing.
      return { ...session, live, status }
    })
    const projects = groupByProject(sessions).map((group) => ({
      cwd: group.cwd,
      name: group.cwd ? group.cwd.split(/[\\/]/).filter(Boolean).pop() ?? group.cwd : '（未指定工作目录）',
      lastAt: group.lastAt,
      count: group.sessions.length,
      running: group.sessions.filter((session) => session.status === 'running').length,
      sessions: group.sessions.slice(0, 60),
    }))
    return {
      ok: true,
      generatedAt: Date.now(),
      count: sessions.length,
      running: sessions.filter((session) => session.status === 'running').length,
      projects,
    }
  }

  return {
    handle: handler,
    codex: () => json(codexIndex()),
    paths: { page: PAGE_API_PATH, codex: CODEX_API_PATH },
  }
}
