/** Real session orchestration. Cursor-scoped evidence and one lock per owned session. */
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { recordStart, recordEnd, recordState, readSessions } from './ledger.js'

const owned = (globalThis.__dshCodexBridgeOwnedSessions ??= new Set())
export function isInternalSessionId(id) { return typeof id === 'string' && owned.has(id) }
const reject = (message, code, status = 409) => Object.assign(new Error(message), { code, status })
const eventOf = (record) => record?.event ?? record
const seqOf = (record) => eventOf(record)?.seq
const textOf = (records) => {
  let text = ''
  for (const record of records) {
    const event = eventOf(record)
    if (event?.type !== 'assistant/message') continue
    const value = (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    if (value.trim()) text = value
  }
  return text
}
const budgetOf = (value, fallback = 300000) => {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1000 || value > 600000) throw reject('timeoutMs 必须是 1000~600000 的整数。', 'invalid-timeout', 400)
  return value
}
const serviceOf = (ctx, key) => { try { return ctx.get?.(key) ?? ctx[key] } catch { return ctx[key] } }

export function createExecutor({ ctx, config = {}, policy, relay, logger } = {}) {
  const active = new Map()
  const continuations = new Map()
  const metadata = new Map()
  const calls = new Set()
  const approvals = new Set()
  let disposed = false
  async function checkLive(sessionId) {
    if (!disposed) return
    if (sessionId) await cancel(sessionId)
    throw reject('执行桥已卸载，准备中的任务已取消。', 'executor-disposed', 503)
  }
  // Restore ownership from the plugin's own ledger, never from arbitrary DSH sessions.
  for (const entry of readSessions({ limit: 10000 })) if (entry.sessionId.startsWith('session-')) {
    owned.add(entry.sessionId)
    metadata.set(entry.sessionId, { cwd: entry.cwd, workspaceId: entry.workspaceId, execution: entry.execution ? { ...entry.execution, selection: { provider: entry.execution.provider, model: entry.execution.model, ...(entry.execution.reasoningEffort ? { reasoningEffort: entry.execution.reasoningEffort } : {}) } } : undefined })
  }
  const controllerService = () => {
    const service = serviceOf(ctx, 'sessionController')
    if (!service?.create || !service?.prompt || !service?.wait || !service?.state || !service?.cancel) throw reject('DSH sessionController 不可用。', 'executor-unavailable', 503)
    return service
  }
  async function cancel(sessionId) {
    clearContinuation(sessionId)
    relay?.cancel?.(sessionId)
    try { await controllerService().cancel({ sessionId }) } catch (error) { logger?.warn?.(`codex-bridge: cancel failed for ${sessionId}: ${error?.message}`) }
  }
  function clearContinuation(sessionId) {
    const previous = continuations.get(sessionId)
    if (previous) clearTimeout(previous.timer)
    continuations.delete(sessionId)
    return previous
  }
  function hold(sessionId, entry) {
    clearContinuation(sessionId)
    const question = relay?.questionFor(sessionId)
    if (!question) throw reject('提问已取消或过期。', 'question-not-pending')
    const timer = setTimeout(() => {
      continuations.delete(sessionId)
      void cancel(sessionId)
      recordEnd({ sessionId, stopReason: 'timeout', elapsedMs: Date.now() - entry.startedAt, text: '', error: '提问等待回答超时。' })
    }, Math.max(1, question.expiresAt - Date.now()))
    timer.unref?.()
    continuations.set(sessionId, { ...entry, timer })
    recordState({ sessionId, state: 'needs-input', question })
    return question
  }
  async function waitForTurn(sessionId, entry, signal, deadline) {
    const service = controllerService()
    const bySeq = new Map()
    let cursor = entry.cursor
    while (true) {
      signal.throwIfAborted()
      if (Date.now() >= deadline) return { records: [...bySeq.values()], cursor, stopReason: 'timeout' }
      const waited = await service.wait({ sessionId, afterSeq: cursor, timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())), maxMessages: 200 }, signal)
      signal.throwIfAborted()
      let records = waited?.output?.records ?? []
      // History is supplementary only. Never let a previous turn/end or answer
      // complete the current call, even when the history API returns all turns.
      if (service.events) {
        const page = await service.events({ address: { kind: 'session', sessionId }, maxMessages: 500 }, signal)
        records = records.concat(page?.records ?? [])
      }
      for (const record of records) {
        const seq = seqOf(record)
        if (Number.isFinite(seq) && seq > entry.baseline) bySeq.set(seq, record)
      }
      const current = [...bySeq.values()].sort((a, b) => seqOf(a) - seqOf(b))
      const end = current.filter((r) => eventOf(r)?.type === 'turn/end').at(-1)
      if (end) return { records: current, cursor, stopReason: eventOf(end).data?.reason?.kind ?? 'unknown' }
      if (relay?.questionFor(sessionId)) return { records: current, cursor, stopReason: 'needs-input' }
      if (waited?.reason === 'input-required') return { records: current, cursor, stopReason: 'input-required' }
      if (Number.isFinite(waited?.state?.cursor)) cursor = waited.state.cursor
      // Never call idle a success without terminal evidence. Also avoid a tight
      // spin during the prompt-admission window when wait returns immediately.
      if (waited?.reason === 'idle') await new Promise((yes) => setTimeout(yes, 50))
    }
  }
  async function run(sessionId, entry, action, timeoutMs, callerSignal) {
    if (active.has(sessionId)) throw reject('该 DSH 会话已有任务正在执行。', 'session-busy')
    const controller = new AbortController()
    active.set(sessionId, controller)
    const onAbort = () => controller.abort(callerSignal.reason ?? new Error('cancelled'))
    callerSignal?.addEventListener?.('abort', onAbort, { once: true })
    if (callerSignal?.aborted) onAbort()
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('执行超时'), { code: 'DSH_EXEC_TIMEOUT' })), timeoutMs)
    timer.unref?.()
    let result
    try {
      await checkLive(sessionId)
      controller.signal.throwIfAborted()
      await action(controller.signal)
      result = await waitForTurn(sessionId, entry, controller.signal, Date.now() + timeoutMs)
    } catch (error) {
      if (!entry.admitted && error.status) { active.delete(sessionId); throw error }
      result = { records: [], stopReason: controller.signal.aborted ? (controller.signal.reason?.code === 'DSH_EXEC_TIMEOUT' ? 'timeout' : 'cancelled') : 'error' }
      logger?.warn?.(`codex-bridge: ${sessionId} stopped: ${error?.message}`)
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener?.('abort', onAbort)
      // Keep the lock during cancellation and result bookkeeping below.
    }
    try {
      const text = textOf(result.records)
      const meta = metadata.get(sessionId) ?? {}
      if (result.stopReason === 'needs-input') {
        const question = hold(sessionId, { ...entry, cursor: result.cursor })
        return { sessionId, ...meta, text, elapsedMs: Date.now() - entry.startedAt, stopReason: 'needs-input', needsInput: question }
      }
      clearContinuation(sessionId)
      if (result.stopReason === 'input-required') {
        approvals.add(sessionId)
        recordState({ sessionId, state: 'input-required' })
        return { sessionId, ...meta, text, elapsedMs: Date.now() - entry.startedAt, stopReason: 'input-required' }
      }
      approvals.delete(sessionId)
      if (result.stopReason !== 'completed') await cancel(sessionId)
      recordEnd({ sessionId, text, stopReason: result.stopReason, elapsedMs: Date.now() - entry.startedAt })
      return { sessionId, ...meta, text, elapsedMs: Date.now() - entry.startedAt, stopReason: result.stopReason }
    } finally { active.delete(sessionId) }
  }
  async function executeInner(input = {}, attempt = {}) {
    if (disposed) throw reject('执行桥已卸载。', 'executor-disposed', 503)
    if (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 20000) throw reject('task 必须是最多 20000 字符的非空文本。', 'invalid-task', 400)
    const timeoutMs = budgetOf(input.timeoutMs, config.timeoutMs ?? 300000)
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    const checkReady = async (id) => {
      if (input.signal?.aborted || Date.now() >= deadline) {
        if (id) {
          await cancel(id)
          recordEnd({ sessionId: id, stopReason: input.signal?.aborted ? 'cancelled' : 'timeout', text: '', elapsedMs: Date.now() - startedAt })
        }
        throw Object.assign(reject('执行准备阶段已超时或取消，未提交任务。', 'preparation-timeout', 504), { sessionId: id, stopReason: 'timeout' })
      }
      await checkLive(id)
    }
    const service = controllerService()
    let sessionId = input.sessionId
    attempt.sessionId = sessionId
    if (sessionId) {
      if (!owned.has(sessionId)) throw reject('只能复用执行桥创建的会话。', 'session-not-bridge-owned')
      if (active.has(sessionId)) throw reject('该会话已有任务执行中。', 'session-busy')
      if (continuations.has(sessionId) || relay?.questionFor(sessionId)) throw reject('该会话正在等待 dsh_answer。', 'session-waiting-input')
      if (input.cwd !== undefined || input.reasoningEffort !== undefined || input.reason !== undefined) throw reject('复用会话沿用工作目录与模型策略，请勿传 cwd/reasoningEffort/reason。', 'reuse-policy-override', 400)
    } else {
      input.signal?.throwIfAborted()
      const execution = await policy?.resolveExecution({ ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}), ...(input.reason !== undefined ? { reason: input.reason } : {}) })
      await checkReady()
      let cwd = input.cwd ?? config.cwd ?? process.cwd()
      let workspaceId
      if (cwd) {
        cwd = resolve(cwd)
        if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw reject('cwd 必须是现有目录。', 'invalid-cwd', 400)
        workspaceId = (await serviceOf(ctx, 'workspaceRegistry')?.resolveByPath?.(cwd))?.id
      }
      await checkReady()
      input.signal?.throwIfAborted()
      const created = await service.create({ ...(workspaceId ? { workspaceId } : cwd ? { cwd } : {}), agentPreset: config.preset ?? 'standard' })
      sessionId = created?.sessionId
      attempt.sessionId = sessionId
      if (typeof sessionId !== 'string' || !sessionId) throw reject('DSH 未返回 sessionId。', 'session-create-failed', 500)
      owned.add(sessionId)
      metadata.set(sessionId, { cwd, workspaceId, execution })
      // Ownership and provenance exist before any model selection or prompt.
      recordStart({ sessionId, task: input.task, cwd, workspaceId, execution, preset: config.preset ?? 'standard', timeoutMs })
      try {
        await checkReady(sessionId)
        if (execution) {
          await policy.applyAccess(sessionId, execution.permissionMode)
          await checkReady(sessionId)
          await policy.apply(sessionId, execution.selection)
          await checkReady(sessionId)
        }
        input.signal?.throwIfAborted()
      } catch (error) {
        await cancel(sessionId)
        recordEnd({ sessionId, stopReason: error.stopReason ?? 'error', text: '', error: error.message })
        error.sessionId = sessionId
        throw error
      }
    }
    await checkReady(sessionId)
    input.onSession?.({ sessionId, ...metadata.get(sessionId) })
    const entry = { startedAt, baseline: 0, cursor: 0 }
    // Acquire the run lock BEFORE the asynchronous state sample; another caller
    // cannot enqueue a second prompt while admission is in progress.
    return run(sessionId, entry, async (signal) => {
      const baseline = await service.state({ sessionId }, signal)
      await checkReady(sessionId)
      signal.throwIfAborted()
      if (baseline?.running || baseline?.pendingInput?.length) throw reject('原生会话仍活跃或等待输入，拒绝插入消息。', 'session-busy')
      if (!Number.isFinite(baseline?.cursor)) throw reject('DSH 未提供事件游标。', 'cursor-unavailable', 503)
      entry.baseline = baseline.cursor
      entry.cursor = baseline.cursor
      const meta = metadata.get(sessionId) ?? {}
      recordStart({ sessionId, task: input.task, ...meta, timeoutMs })
      input.onSession?.({ sessionId, baseline: baseline.cursor, ...metadata.get(sessionId) })
      entry.admitted = true
      attempt.admitted = true
      await service.prompt({ requestId: input.dispatchRequestId ?? randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: input.task }] }, signal)
    }, Math.max(1, deadline - Date.now()), input.signal)
  }
  async function execute(input = {}) {
    const timeoutMs = budgetOf(input.timeoutMs, config.timeoutMs ?? 300000)
    let timer
    const attempt = {}
    const work = executeInner(input, attempt).catch(error => {
      // Only settled pre-session admission failures prove that no prompt was submitted.
      // The outer timeout race has no such guarantee, including late create completions.
      if (!attempt.admitted && !attempt.sessionId) error.notDispatched = true
      throw error
    })
    const timeout = new Promise((_, no) => {
      timer = setTimeout(() => no(Object.assign(reject('执行预算耗尽；准备中的会话返回后会被取消，不会提交任务。', 'timeout', 504), { stopReason: 'timeout', ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}) })), timeoutMs + 100)
      timer.unref?.()
    })
    // A Host create API has no AbortSignal. Keep its late completion tracked
    // even after returning a deadline failure, so dispose waits for its cleanup.
    calls.add(work)
    void work.finally(() => calls.delete(work)).catch(() => {})
    try { return await Promise.race([work, timeout]) } finally { clearTimeout(timer) }
  }
  async function answer(input = {}) {
    if (disposed) throw reject('执行桥已卸载。', 'executor-disposed', 503)
    if (active.has(input.sessionId)) throw reject('该会话已有任务执行中。', 'session-busy')
    const entry = continuations.get(input.sessionId)
    if (!owned.has(input.sessionId) || !entry) throw reject('该桥接会话没有待回答的问题。', 'no-pending-question')
    const timeoutMs = budgetOf(input.timeoutMs)
    // Validate synchronously before acquiring/removing anything. Invalid answers
    // leave the current question intact, and consumption is exactly once.
    relay.answer(input.sessionId, input.requestId, input.answers)
    clearContinuation(input.sessionId)
    recordState({ sessionId: input.sessionId, state: 'running' })
    return run(input.sessionId, entry, async () => {}, timeoutMs, input.signal)
  }
  async function dispose() {
    disposed = true
    const paused = [...continuations.keys()]
    for (const id of paused) {
      clearContinuation(id)
      await cancel(id)
      recordEnd({ sessionId: id, stopReason: 'cancelled', text: '', error: '执行桥重载/卸载，待答请求失效；不会自动重跑。' })
    }
    for (const id of approvals) {
      await cancel(id)
      recordEnd({ sessionId: id, stopReason: 'cancelled', text: '', error: '执行桥卸载，待审批任务已取消。' })
    }
    approvals.clear()
    for (const [id, controller] of active) { controller.abort(new Error('executor disposed')); await cancel(id) }
    await Promise.allSettled([...calls])
  }
  const tracked = (fn) => (...args) => {
    const call = fn(...args)
    calls.add(call)
    void call.finally(() => calls.delete(call)).catch(() => {})
    return call
  }
  return { execute: tracked(execute), answer: tracked(answer), dispose, cancel,
    metadataOf: id => metadata.get(id),
    validateAnswer: input => relay.validate(input.sessionId,input.requestId,input.answers),
    async observe(sessionId, baseline, { signal: callerSignal, timeoutMs = 5000 } = {}) {
      if (!owned.has(sessionId)) throw reject('会话不属于执行桥。', 'session-not-bridge-owned')
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw reject('观察预算无效。', 'invalid-observation-timeout', 400)
      const controller = new AbortController()
      const abort = () => controller.abort(callerSignal.reason ?? new Error('observation cancelled'))
      callerSignal?.addEventListener('abort', abort, { once: true })
      if (callerSignal?.aborted) abort()
      const timer = setTimeout(() => controller.abort(Object.assign(new Error('宿主状态观察超时。'), { code: 'observation-timeout' })), timeoutMs)
      let onAbort
      try {
        const stopped = new Promise((_, no) => {
          onAbort = () => no(controller.signal.reason)
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) onAbort()
        })
        const read = (async () => {
          controller.signal.throwIfAborted()
          const service = controllerService()
          const state = await service.state({ sessionId }, controller.signal)
          controller.signal.throwIfAborted()
          const page = await service.events?.({ address: { kind: 'session', sessionId }, maxMessages: 500 }, controller.signal)
          controller.signal.throwIfAborted()
          const records = (page?.records ?? []).filter(r => Number.isFinite(seqOf(r)) && seqOf(r) > baseline)
          const end = records.filter(r => eventOf(r)?.type === 'turn/end').at(-1)
          return { running: state?.running, pendingInput: state?.pendingInput, questionPending: Boolean(relay?.questionFor(sessionId)), ...(end ? { result: { sessionId, text: textOf(records), stopReason: eventOf(end).data?.reason?.kind ?? 'unknown', ...metadata.get(sessionId) } } : {}) }
        })()
        // Bound even an incompatible host method that ignores its AbortSignal.
        return await Promise.race([read, stopped])
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', onAbort)
      }
    }, isInternalSession: isInternalSessionId }
}
