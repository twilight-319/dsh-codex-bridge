/**
 * Browser API for the Codex mirror page: projects → threads → transcript → send.
 *
 * Data comes from a live `codex app-server` through `lib/codex-threads-v1.js`, so
 * "continue this conversation" reuses the existing Codex thread (prompt-cache
 * friendly) instead of starting a new one.
 *
 *   GET  /api/dsh-codex-bridge.v3.codex          → { ok, projects: [...] }
 *   GET  /api/dsh-codex-bridge.v3.codex.thread   → { ok, thread: {...} }  (?id=)
 *   POST /api/dsh-codex-bridge.v3.codex.send     → { ok, threadId, answer, usage, elapsedMs }
 *
 * The entry (index.js) mounts these routes on every plugin load; registration
 * failures (an older route still alive) are tolerated.
 *
 * @module @local/dsh-codex-bridge/codex-ui
 */
export const PROJECTS_PATH = '/api/dsh-codex-bridge.v3.codex'
export const THREAD_PATH = '/api/dsh-codex-bridge.v3.codex.thread'
export const SEND_PATH = '/api/dsh-codex-bridge.v3.codex.send'

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: HEADERS })
}

function basename(path) {
  if (typeof path !== 'string' || path === '') return '（未指定工作目录）'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

function groupProjects(threads) {
  const groups = new Map()
  for (const thread of threads) {
    const cwd = thread.cwd || ''
    const key = cwd || '(none)'
    const group = groups.get(key) ?? { cwd, name: basename(cwd), threads: [], lastAt: 0 }
    group.threads.push({
      id: thread.id,
      name: thread.name || '（未命名会话）',
      createdAt: thread.createdAt || 0,
      updatedAt: thread.updatedAt || 0,
      source: thread.source || '',
      model: thread.model || '',
    })
    group.lastAt = Math.max(group.lastAt, thread.updatedAt || 0, thread.createdAt || 0)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.threads.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    group.count = group.threads.length
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * @param {{ ctx: any, logger?: any, bin: { command: string, prefix?: string[] } | null, client: () => any }} options
 */
export function createCodexUi({ logger, bin, client } = /** @type {any} */ ({})) {
  const log = logger ?? {}

  const projects = async () => {
    const threads = await client()
    const { threads: rows } = await threads.list({ limit: 200 })
    const projects = groupProjects(rows)
    return json({ ok: true, updatedAt: Date.now(), projects })
  }

  const thread = async (request) => {
    let id = ''
    try {
      id = new URL(request.url).searchParams.get('id') ?? ''
    } catch {
      id = ''
    }
    if (id === '') return json({ ok: false, error: 'id is required' }, 400)
    try {
      const threads = await client()
      const record = await threads.read({ threadId: id })
      return json({ ok: true, thread: record.thread })
    } catch (error) {
      log.warn?.(`codex-bridge(codex-ui): read ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  const send = async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, error: 'invalid-json' }, 400)
    }
    const threadId = typeof body?.threadId === 'string' ? body.threadId : ''
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (threadId === '' || text === '') return json({ ok: false, error: 'threadId and text are required' }, 400)
    if (text.length > 20_000) return json({ ok: false, error: 'text exceeds 20000 characters' }, 400)
    try {
      const threads = await client()
      const result = await threads.send({ threadId, text, timeoutMs: 300_000 })
      return json({ ok: true, ...result })
    } catch (error) {
      log.warn?.(`codex-bridge(codex-ui): send failed: ${error instanceof Error ? error.message : String(error)}`)
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  return { paths: { projects: PROJECTS_PATH, thread: THREAD_PATH, send: SEND_PATH }, projects, thread, send, bin }
}
