import { createTaskTuner, normalizeTuning } from './task-tuning.js'
import { taskBudgets, LEGACY_MAX_MS } from './task-budget.js'
import { hostStopped as stopped, deriveTermination } from './task-termination.js'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { digest, taskError } from './task-store.js'
import { workspaceEvidence, verifyTask } from './task-verifier.js'
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REVIEW_REQUIRED'])
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
export function createTaskManager({ store, executor, profiles = {}, verificationService, reviewer, maxConcurrency = 2, taskDefaultTimeoutMs, taskMaxTimeoutMs, executionPolicy, tuningHistory }) {
  const budgets = taskBudgets({ taskDefaultTimeoutMs, taskMaxTimeoutMs, executionPolicy, tuningHistory })
  const tuner = executionPolicy ? createTaskTuner({policy:executionPolicy,history:()=>store.list(),config:tuningHistory,budgets}) : null
  const epoch = randomUUID(), jobs = new Map(), busyProjects = new Set(), cancelledCalls = new Map(), waitingTimers = new Map(), cancelCalls = new Map(), reconciliations = new Map()
  let closing = false, wakePending = false, maintenance = null
  function checkAdmission() {
    if (closing) throw taskError('任务核心正在停止。', 'task-manager-closing', 503)
    if (maintenance) throw taskError('维护排空中，暂不接收新任务；已有任务继续执行。', 'maintenance-draining', 409)
  }
  function maintenanceSnapshot() {
    const tasks = store.list().filter(t => !terminal.has(t.state)).map(t => ({ taskId: t.taskId, runId: t.activeRunId, state: t.state }))
    const adapter = executor.activity?.() ?? {}
    const ready = tasks.length === 0 && jobs.size === 0 && cancelCalls.size === 0 && reconciliations.size === 0 && !Object.values(adapter).some(n => n > 0)
    return { draining: Boolean(maintenance), epoch, ready, tasks, jobs: jobs.size, cancelCalls: cancelCalls.size, reconciliations: reconciliations.size, adapter }
  }
  function progress(id, runId, value) {
    const t = get(id)
    if (t.activeRunId !== runId || terminal.has(t.state) || !Number.isSafeInteger(value.seq) || value.seq <= (t.run.progress?.seq ?? t.run.baseline ?? -1)) return
    // Throttle writes to at most one per 2s; state transitions always persist.
    if (t.run.progress && Date.now() - t.run.progress.observedAt < 2000) return
    t.run.progress = { seq: value.seq, eventType: String(value.eventType ?? ''), observedAt: Date.now(), lastActivityAt: value.lastActivityAt, timeSource: value.timeSource }
    save(t, 'run.progress')
  }
  for (const t of store.list()) {
    if (terminal.has(t.state) && t.run.cancelReason && stopped(t.run.observation)) {
      const decision = deriveTermination(t.run, t.run.observation, t.run.result)
      if (decision.kind === 'stopped' && (t.state !== decision.state || t.run.outcome !== decision.outcome)) {
        t.run.hostResult = t.run.observation.result ?? t.run.hostResult
        t.run.hostStopReason = t.run.hostResult?.stopReason
        t.state = decision.state; t.run.outcome = decision.outcome
        t.run.result = { ...t.run.result, sessionId: t.run.sessionId, stopReason: decision.stopReason }
        t.revision++; t.updatedAt = Date.now(); store.commit(t, 'run.attribution_corrected')
      }
    }
    const unconfirmedFailure = t.state === 'FAILED' && t.run.dispatchIntent && !stopped(t.run.observation) && (t.run.error?.status || t.run.outcome === 'budget-exhausted' && t.run.question)
    if (terminal.has(t.state) && !unconfirmedFailure) continue
    if (unconfirmedFailure && t.run.outcome === 'budget-exhausted') { t.run.cancelRequestedAt = Date.now(); t.run.cancelReason = 'budget-exhausted' }

    t.state = 'RECONCILING'; t.revision++; t.updatedAt = Date.now()
    // Older candidates stored cancellation only as an event/state. Preserve that intent.
    if (!t.run.cancelRequestedAt) {
      const cancellation = store.events(t.taskId).findLast(e => e.runId === t.activeRunId && e.type === 'run.cancel_requested')
      if (cancellation) { t.run.cancelRequestedAt = cancellation.at; t.run.cancelReason = 'user' }
    }
    t.run.question = null; t.run.recoveryReason = unconfirmedFailure ? 'legacy-failure-unconfirmed' : 'host-restarted'; store.commit(t, 'run.interrupted')
  }
  const get = id => { const t = store.get(id); if (!t) throw taskError('任务不存在。', 'task-not-found', 404); return t }
  function save(t, type) { if (terminal.has(t.state) && !t.run.endedAt) { t.run.endedAt=Date.now(); t.run.timing={...t.run.timing,totalMs:Date.now()-(t.run.startedAt??t.createdAt)} } t.revision++; t.updatedAt = Date.now(); return store.commit(t, type) }
  function clearWaiting(id) {
    clearTimeout(waitingTimers.get(id))
    waitingTimers.delete(id)
  }
  async function observeRun(t) {
    try {
      const observation = await executor.observe(t.run.sessionId, t.run.baseline ?? 0)
      t.run.observation = observation ?? null
      if (observation?.result) { t.run.hostResult = observation.result; t.run.hostStopReason = observation.result.stopReason }
      delete t.run.observationError
      return observation
    } catch (error) {
      t.run.observation = null
      t.run.observationError = { code: error.code ?? 'observation-failed', name: error.name ?? 'Error', message: String(error.message ?? '宿主状态观察失败。').slice(0, 500), at: Date.now() }
      return null
    } finally {
      const current = get(t.taskId)
      if (current.activeRunId === t.activeRunId) {
        t.revision = current.revision
        for (const key of ['cancelRequestedAt', 'cancelReason']) if (current.run[key] !== undefined) t.run[key] = current.run[key]
      }
    }
  }
  function recordCancelIntent(id, runId, reason) {
    const t = get(id)
    if (t.activeRunId !== runId || terminal.has(t.state)) return t
    clearWaiting(id)
    t.run.cancelRequestedAt ??= Date.now(); t.run.cancelReason ??= reason
    t.run.question = null; t.state = 'CANCEL_REQUESTED'
    return save(t, reason === 'user' ? 'run.cancel_requested' : 'run.budget_exhausted')
  }
  function confirmStopped(t, observation = { running: false, pendingInput: [] }) {
    const decision = deriveTermination(t.run, observation, t.run.adapterResult ?? t.run.result)
    if (decision.kind !== 'stopped') throw new Error('stop evidence required')
    t.run.question = null; t.state = decision.state; t.run.outcome = decision.outcome
    const { needsInput, question, ...previous } = t.run.result ?? {}
    t.run.result = { ...previous, sessionId: t.run.sessionId, text: previous.text ?? '', stopReason: decision.stopReason }
  }
  async function sendCancel(id, runId) {
    const key = runId
    if (cancelCalls.has(key)) return cancelCalls.get(key)
    const call = (async () => {
      let t = get(id)
      if (t.activeRunId !== runId || terminal.has(t.state) || !t.run.cancelRequestedAt || !t.run.sessionId) return
      t.run.cancelAttempts = (t.run.cancelAttempts ?? 0) + 1
      t.run.cancelLastAttemptAt = Date.now(); save(t, 'run.cancel_sending')
      let error
      try { await executor.cancel(t.run.sessionId) } catch (cause) { error = { code: cause.code ?? 'cancel-failed', message: String(cause.message ?? '取消请求失败。').slice(0, 500) } }
      t = get(id)
      if (t.activeRunId !== runId) return
      if (error) t.run.cancelError = error
      else { delete t.run.cancelError; t.run.cancelSentAt = Date.now() }
      save(t, error ? 'run.cancel_failed' : 'run.cancel_sent')
    })()
    cancelCalls.set(key, call)
    try { return await call } finally { if (cancelCalls.get(key) === call) cancelCalls.delete(key) }
  }
  function armWaiting(t) {
    clearWaiting(t.taskId)
    // Legacy input waits retain their native question TTL and fresh answer budget.
    const deadline = t.run.budgetMode === 'legacy-execution' ? t.run.question?.expiresAt : t.run.deadline
    if (!Number.isFinite(deadline)) return
    const timer = setTimeout(() => {
      waitingTimers.delete(t.taskId)
      void expireRun(t.taskId, t.activeRunId, t.run.budgetMode === 'legacy-execution' ? 'question-expired' : 'budget-exhausted').catch(() => {})
    }, Math.max(1, deadline - Date.now()))
    timer.unref?.(); waitingTimers.set(t.taskId, timer)
  }
  async function expireRun(id, runId, reason = 'budget-exhausted') {
    let t = get(id)
    if (t.activeRunId !== runId || terminal.has(t.state)) return t
    t = recordCancelIntent(id, runId, reason)
    const job = jobs.get(id)
    if (job) { job.controller.abort(Object.assign(new Error(reason), { code: 'TASK_BUDGET_EXHAUSTED' })); return get(id) }
    if (!t.run.dispatchIntent && !t.run.sessionId) { confirmStopped(t); save(t, 'run.finished'); schedule(); return get(id) }
    if (t.run.sessionId) return api.reconcile({ taskId: id })
    t.state = 'RECONCILING'; return save(t, 'run.uncertain')
  }
  function schedule() {
    if (wakePending || closing) return
    wakePending = true
    queueMicrotask(() => {
      wakePending = false
      if (closing) return
      for (const t of store.list()) {
        if (jobs.size >= maxConcurrency) break
        if (t.state !== 'QUEUED' || busyProjects.has(t.cwd)) continue
        if (store.list().some(other => other.taskId !== t.taskId && other.cwd === t.cwd && !terminal.has(other.state) && other.state !== 'QUEUED')) continue
        void launch(t.taskId)
      }
    })
  }
  async function finish(id, result, controller, knownObservation) {
    let t = get(id)
    if (result.stopReason === 'timeout' && !t.run.cancelRequestedAt) t = recordCancelIntent(id, t.activeRunId, 'budget-exhausted')
    if (!knownObservation) t.run.adapterResult = result
    if (knownObservation?.result) { t.run.hostResult = knownObservation.result; t.run.hostStopReason = knownObservation.result.stopReason; t.run.observation = knownObservation }
    t.run.sessionId = result.sessionId ?? t.run.sessionId
    t.run.result = result; t.run.execution = result.execution ?? t.run.execution
    if (result.stopReason === 'needs-input' && !t.run.cancelRequestedAt) {
      t.state = 'WAITING_INPUT'; t.run.question = result.needsInput; save(t, 'run.waiting_input'); armWaiting(t); return
    }
    if (result.stopReason === 'input-required' && !t.run.cancelRequestedAt) { t.state = 'WAITING_APPROVAL'; save(t, 'run.waiting_approval'); armWaiting(t); return }
    t.run.question = null; t.run.outcome = result.stopReason
    if (result.stopReason === 'completed') {
      t.state = 'VERIFYING'; save(t, 'verification.started')
      t.run.after = await workspaceEvidence(t.cwd)
      try { t.run.verification = await verifyTask({ cwd: t.cwd, profile: t.profile, service: verificationService, signal: controller.signal }) }
      catch { t.run.verification = { status: 'unavailable', checks: [], artifacts: [] } }
      if (t.review && reviewer && !controller.signal.aborted) {
        try { t.run.review = await reviewer(t, controller.signal) } catch { t.run.review = { verdict: 'unavailable' } }
      }
      // Cancellation after execution completion never fabricates a cancelled execution.
      t.state = t.run.verification.status === 'failed' ? 'FAILED' : t.run.verification.status === 'passed' && (!t.review || t.run.review?.verdict === 'approve') ? 'SUCCEEDED' : 'REVIEW_REQUIRED'
      t.run.evidenceHash = digest({ before: t.run.before, after: t.run.after, verification: t.run.verification, review: t.run.review })
    } else {
      const observed = knownObservation ?? await observeRun(t)
      if (knownObservation?.result) { t.run.observation = knownObservation; t.run.hostResult = knownObservation.result; t.run.hostStopReason = knownObservation.result.stopReason }
      const decision = deriveTermination(t.run, observed, result)
      if (decision.kind === 'completed') return finish(id, decision.result, controller, observed)
      if (decision.kind === 'stopped') confirmStopped(t, observed)
      else t.state = 'RECONCILING'
    }
    save(t, 'run.finished')
  }
  async function launch(id, answer) {
    const t = get(id), controller = new AbortController()
    const remaining = t.run.deadline - Date.now()
    if (remaining <= 0) return expireRun(id, t.activeRunId)
    clearWaiting(id)
    jobs.set(id, { controller }); busyProjects.add(t.cwd)
    const timer = setTimeout(() => { void expireRun(id, t.activeRunId).catch(error => controller.abort(error)) }, remaining); timer.unref?.()
    const promise = (async () => {
      try {
        t.state = 'RUNNING'; t.run.epoch = epoch; save(t, answer ? 'run.continued' : 'run.started')
        if (!answer) { const before = await workspaceEvidence(t.cwd); const current = get(id); current.run.before = before; save(current, 'workspace.baseline') }
        controller.signal.throwIfAborted()
        if (t.run.tuning) await tuner.validateFrozen(t.run.tuning.resolved.execution)
        controller.signal.throwIfAborted()
        const dispatch = get(id); dispatch.run.dispatchIntent = true; save(dispatch, 'run.dispatch_intent')
        const taskMode = t.run.budgetMode !== 'legacy-execution'
        const execute = taskMode && executor.executeTask ? executor.executeTask : executor.execute
        const answerCall = taskMode && executor.answerTask ? executor.answerTask : executor.answer
        const remainingBudget = () => Math.max(taskMode ? 1 : 1000, t.run.deadline - Date.now())
        const onProgress = value => progress(id, t.activeRunId, value)
        const onEvidence = value => {const current=get(id);if(current.activeRunId!==t.activeRunId||!current.run.tuning||current.run.tuning.observed?.seq===value.seq)return;const matches=['provider','model','reasoningEffort'].every(k=>value.selection[k]===current.run.tuning.resolved.execution.selection[k]);current.run.tuning.observed={...value,matches,everMismatch:current.run.tuning.observed?.everMismatch===true||!matches};save(current,'run.selection_observed')}
        const result = answer ? await answerCall({ ...answer, sessionId: t.run.sessionId, timeoutMs: remainingBudget(), signal: controller.signal, onProgress, onEvidence, frozenExecution: t.run.tuning?.resolved.execution, frozenExecution: t.run.tuning?.resolved.execution }) : await execute({
          task: t.goal, cwd: t.cwd, dispatchRequestId:t.run.dispatchRequestId, ...(!t.run.tuning && t.reasoningEffort ? {reasoningEffort:t.reasoningEffort,reason:t.reason} : {}), ...(t.sessionId ? { sessionId: t.sessionId, cwd: undefined } : {}),
          timeoutMs: remainingBudget(), signal: controller.signal, onProgress, onEvidence, frozenExecution: t.run.tuning?.resolved.execution,
          onSession(meta) { const current = get(id); if (current.activeRunId !== t.activeRunId) return; Object.assign(current.run, meta); if(current.run.tuning && meta.execution?.application) {current.run.tuning.applied=meta.execution.application;if(current.run.tuning.observed?.status!=='request-confirmed')current.run.tuning.observed=meta.execution.application.observed??{status:'unknown'}} save(current, 'run.session_bound') },
        })
        await finish(id, result, controller)
      } catch (error) {
        const current = get(id)
        current.run.error = { code: error.code ?? 'execution-error', status: error.status, message: error.status ? error.message : '执行状态不确定' }
        if ((!current.run.dispatchIntent || error.notDispatched === true) && !current.run.sessionId) {
          if (current.run.cancelRequestedAt) confirmStopped(current)
          else current.state = 'FAILED'
          save(current, 'run.finished')
        } else {
          // HTTP status is not evidence that dispatch or cleanup has stopped.
          const observation = current.run.sessionId ? await observeRun(current) : null
          if (observation?.result) await finish(id, observation.result, controller, observation)
          else {
            if (stopped(observation)) {
              if (current.run.cancelRequestedAt) confirmStopped(current, observation)
              else { current.state = 'FAILED'; current.run.outcome = error.code ?? 'execution-error' }
            } else current.state = 'RECONCILING'
            save(current, 'run.uncertain')
          }
        }
      } finally { clearTimeout(timer); jobs.delete(id); busyProjects.delete(t.cwd); schedule() }
    })()
    jobs.get(id).promise = promise
    return promise
  }
  const api = {
    epoch,
    maintenanceStatus: () => maintenanceSnapshot(),
    maintenanceBegin() {
      if (!maintenance) maintenance = { token: randomUUID(), startedAt: Date.now() }
      const snapshot = { ...maintenanceSnapshot(), ...maintenance }
      if (!snapshot.ready) throw Object.assign(taskError('维护排空中：仍有任务或清理工作，禁止重载。', 'maintenance-busy', 409), { maintenance: snapshot })
      return snapshot
    },
    maintenanceEnd({ token } = {}) {
      if (!maintenance || token !== maintenance.token) throw taskError('维护凭据已失效。', 'maintenance-token-mismatch', 409)
      maintenance = null
      return maintenanceSnapshot()
    },
    async wait({ taskId, runId, afterRevision, waitMs = 10000, signal } = {}) {
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000 || (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0))) throw taskError('waitMs 必须是0~25000整数，afterRevision必须非负整数。')
      const first = get(taskId), revision = afterRevision ?? first.revision
      const deadline = Date.now() + waitMs
      while (true) {
        signal?.throwIfAborted()
        const task = get(taskId)
        if (runId && task.activeRunId !== runId) return { task, reason: 'run-changed' }
        if (terminal.has(task.state) || ['WAITING_INPUT','WAITING_APPROVAL'].includes(task.state)) return { task, reason: 'settled-or-input' }
        if (task.revision !== revision) return { task, reason: 'changed' }
        if (Date.now() >= deadline) return { task, reason: 'wait-expired' }
        await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())))
      }
    },
    async preview(raw) {
      if(!tuner) throw taskError('任务调优服务不可用。','tuning-unavailable',503)
      normalizeTuning(raw)
      const cwd=resolve(raw.cwd??process.cwd())
      if(raw.verificationProfile!==undefined && !Object.hasOwn(profiles,raw.verificationProfile))throw taskError('验证配置不存在。')
      return tuner.resolve(raw,{cwd,profile:profiles[raw.verificationProfile]??null})
    },
    async submit(raw, { legacy = false } = {}) {
      if (closing) throw taskError('任务核心正在停止。', 'task-manager-closing', 503)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw taskError('参数必须是对象。')
      const allowed = ['goal','cwd','idempotencyKey','verificationProfile','review','timeoutMs','sessionId','reasoningEffort','reason','clientCallId','plan','acceptance','provider','model','tuning']
      if (Object.keys(raw).some(k => !allowed.includes(k))) throw taskError('未知任务字段。')
      if (typeof raw.goal !== 'string' || !raw.goal.trim() || raw.goal.length > 20000) throw taskError('goal 必须是 1 至 20000 字符。')
      if (typeof raw.idempotencyKey !== 'string' || !raw.idempotencyKey.trim() || raw.idempotencyKey.length > 200) throw taskError('idempotencyKey 必填，最多 200 字符。')
      if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw taskError('cwd 必须是目录字符串。')
      if (raw.review !== undefined && typeof raw.review !== 'boolean') throw taskError('review 必须是布尔值。')
      if(raw.plan!==undefined && (typeof raw.plan!=='string'||raw.plan.length>20000)) throw taskError('plan 无效。')
      if(raw.acceptance!==undefined && (!Array.isArray(raw.acceptance)||raw.acceptance.length>30||raw.acceptance.some(x=>typeof x!=='string'||x.length>2000)))throw taskError('acceptance 无效。')
      normalizeTuning(raw)
      const requested=JSON.parse(JSON.stringify({...raw,cwd:resolve(raw.cwd??process.cwd())}))
      let timeoutMs = raw.timeoutMs ?? (legacy ? 300000 : budgets.taskDefaultTimeoutMs)
      const maximum = legacy ? LEGACY_MAX_MS : budgets.taskMaxTimeoutMs
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw taskError('timeoutMs 必须是正整数且至少1000。')
      const cwd = resolve(raw.cwd ?? process.cwd()), key = digest({ cwd, key: raw.idempotencyKey }), payloadHash = digest(canonical(requested))
      const find = () => store.list().find(t => t.submissionKey === key)
      const matches = existing => existing.requestHashVersion===2 ? existing.payloadHash===payloadHash : existing.payloadHash===digest(canonical({...raw,cwd,timeoutMs:raw.timeoutMs??existing.run.budgetMs??300000}))
      let existing = find()
      if (existing) { if (!matches(existing)) throw taskError('同一幂等键的内容发生变化。', 'idempotency-conflict', 409); return existing }
      if(timeoutMs>maximum)throw taskError('timeoutMs超过当前授权上限。')
      checkAdmission()
      if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw taskError('cwd 必须存在。')
      if (raw.verificationProfile !== undefined && !Object.hasOwn(profiles, raw.verificationProfile)) throw taskError('验证配置不存在。')
      const decision = !legacy && tuner ? await tuner.resolve(raw,{cwd,profile:raw.verificationProfile?profiles[raw.verificationProfile]:null}) : null
      if(decision)timeoutMs=decision.resolved.timeoutMs
      // Recheck after the async directory probe: concurrent submissions must converge.
      existing = find()
      if (existing) { if (!matches(existing)) throw taskError('幂等键冲突。', 'idempotency-conflict',409); return existing }
      checkAdmission()
      const taskId = 'task-' + randomUUID(), runId = 'run-' + randomUUID()
      const t = { schemaVersion: 1, taskId, activeRunId: runId, cwd, goal: raw.goal, sessionId: raw.sessionId,
        reasoningEffort:raw.reasoningEffort, reason:raw.reason, plan:raw.plan ?? null, acceptance:raw.acceptance ?? [], review: raw.review === true, profile: raw.verificationProfile ? structuredClone(profiles[raw.verificationProfile]) : null,
        requestHashVersion:2, requestedInput:requested, clientCallId:raw.clientCallId, submissionKey: key, payloadHash, state: 'QUEUED', revision: 1, createdAt: Date.now(), updatedAt: Date.now(),
        run: { runId, ...(decision?{tuning:decision}:{}), startedAt:Date.now(), budgetMs: timeoutMs, budgetMode: legacy ? 'legacy-execution' : 'wall-clock', attempt: 1, dispatchRequestId: randomUUID(), deadline: Date.now() + timeoutMs, epoch, verification: { status: 'pending' } } }
      if(raw.clientCallId && cancelledCalls.has(raw.clientCallId)) {t.state='CANCELLED';t.run.outcome='not-dispatched'}
      store.commit(t, 'task.created'); schedule(); return structuredClone(t)
    },
    get,
    list({ cursor = 0, limit = 50 } = {}) {
      if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw taskError('分页参数无效。')
      const rows = store.list().sort((a,b) => b.createdAt - a.createdAt)
      return { tasks: rows.slice(cursor,cursor+limit), nextCursor: cursor+limit < rows.length ? cursor+limit : null }
    },
    events({ taskId, cursor = 0 }) { get(taskId); if (!Number.isInteger(cursor) || cursor < 0) throw taskError('cursor 无效。'); const events = store.events(taskId,cursor).slice(0,200); return { events, cursor: events.at(-1)?.seq ?? cursor } },
    async cancel({ taskId, clientCallId }) {
      if(!taskId && clientCallId) {
        taskId=store.list().find(t=>t.clientCallId===clientCallId)?.taskId
        if(!taskId) {
          for(const [key,at] of cancelledCalls)if(Date.now()-at>600000)cancelledCalls.delete(key)
          if(cancelledCalls.size>=1024)throw taskError('取消缓存已满。','cancel-capacity',503)
          cancelledCalls.set(clientCallId,Date.now());return {state:'CANCEL_REQUESTED',clientCallId}
        }
      }
      let t = get(taskId)
      if (terminal.has(t.state)) return t
      clearWaiting(taskId)
      if (t.state === 'QUEUED') { t.state = 'CANCELLED'; t.run.outcome = 'not-dispatched'; save(t,'run.finished'); schedule(); return get(taskId) }
      t = recordCancelIntent(taskId, t.activeRunId, 'user')
      const job = jobs.get(taskId)
      if (job) { job.controller.abort(new Error('user cancelled')); return get(taskId) }
      if (t.run.sessionId) return api.reconcile({ taskId })
      t.state = 'RECONCILING'; return save(t,'run.uncertain')
    },
    async retry({taskId,idempotencyKey,goal}) {
      checkAdmission()
      const t=get(taskId)
      if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>200)throw taskError('重试需要幂等键。')
      if(goal!==undefined&&(typeof goal!=='string'||!goal.trim()||goal.length>20000))throw taskError('修复任务无效。')
      const key=digest(idempotencyKey),payloadHash=digest(goal??t.goal)
      const prior=t.retryKeys?.[key]
      if(prior){if(prior.payloadHash!==payloadHash)throw taskError('重试内容冲突。','idempotency-conflict',409);return t}
      if(!terminal.has(t.state)||jobs.has(taskId))throw taskError('先完成当前运行或对账。','task-busy',409)
      if(t.run.attempt>=3)throw taskError('已达到两轮修复上限。','retry-budget-exhausted',409)
      const beforeRevision=t.revision,beforeRunId=t.activeRunId
      if(t.run.tuning)await tuner.validateFrozen(t.run.tuning.resolved.execution)
      checkAdmission()
      const refreshed=get(taskId)
      if(refreshed.revision!==beforeRevision||refreshed.activeRunId!==beforeRunId)throw taskError('任务已变化，请重试。','retry-conflict',409)
      t.history=[...(t.history??[]),t.run]
      t.sessionId=t.run.sessionId
      t.goal=goal??t.goal
      t.run={runId:'run-'+randomUUID(),...(t.run.tuning?{tuning:{...structuredClone(t.run.tuning),applied:{status:'not-applied'},observed:{status:'unknown'}}}:{}),startedAt:Date.now(),budgetMode:t.run.budgetMode ?? 'wall-clock',budgetMs:t.run.budgetMs ?? 300000,attempt:t.run.attempt+1,dispatchRequestId:randomUUID(),deadline:Date.now()+(t.run.budgetMs ?? 300000),epoch,verification:{status:'pending'}}
      t.activeRunId=t.run.runId;t.state='QUEUED'
      t.retryKeys={...(t.retryKeys??{}),[key]:{payloadHash,runId:t.activeRunId}}
      save(t,'run.retry_created');schedule();return t
    },
    async answer({ taskId, runId, requestId, answers }) {
      const t = get(taskId)
      if (t.activeRunId !== runId || t.state !== 'WAITING_INPUT' || t.run.question?.requestId !== requestId) throw taskError('当前问题标识不匹配。', 'question-request-mismatch',409)
      if (t.run.epoch !== epoch) throw taskError('旧宿主问题已失效。', 'question-expired',409)
      if (Date.now() >= t.run.deadline) return expireRun(taskId, runId)
      // The executor validates answers synchronously; preserve the pending question on rejection.
      if (jobs.has(taskId)) throw taskError('会话忙。','session-busy',409)
      executor.validateAnswer({sessionId:t.run.sessionId,requestId,answers});
      void launch(taskId,{ requestId, answers }).catch(() => {})
      return get(taskId)
    },
    async reconcile({ taskId }) {
      const initial = get(taskId), key = initial.activeRunId
      if (terminal.has(initial.state) || jobs.has(taskId) || !initial.run.sessionId) return initial
      if (reconciliations.has(key)) return reconciliations.get(key)
      const work = (async () => {
        let t = get(taskId), revision = t.revision
        let observation = await observeRun(t)
        if (get(taskId).revision !== revision) return get(taskId)
        // Persist the observation before sending anything, including cancellation failure diagnosis.
        save(t, 'recovery.observed')
        if (t.run.cancelRequestedAt && observation?.result?.stopReason !== 'completed' && !stopped(observation)) {
          await sendCancel(taskId, key)
          t = get(taskId); revision = t.revision
          observation = await observeRun(t)
          if (get(taskId).revision !== revision) return get(taskId)
          save(t, 'recovery.observed')
        }
        if (observation?.result) await finish(taskId, observation.result, new AbortController(), observation)
        else if (t.run.cancelRequestedAt && stopped(observation)) { confirmStopped(t, observation); save(t, 'run.finished') }
        else if (stopped(observation) && (t.run.error || t.run.outcome && t.run.outcome !== 'completed')) { confirmStopped(t, observation); save(t, 'run.finished') }
        else { t.state = 'RECONCILING'; save(t, 'recovery.observed') }
        schedule(); return get(taskId)
      })()
      reconciliations.set(key, work)
      try { return await work } finally { if (reconciliations.get(key) === work) reconciliations.delete(key) }
    },
    async legacyExecute(input) {
      if(input.sessionId) {
        if(input.cwd!==undefined||input.reasoningEffort!==undefined||input.reason!==undefined)throw taskError('复用会话不能覆盖 cwd/reasoningEffort/reason。','reuse-policy-override',400)
        if(store.list().some(t=>(t.sessionId===input.sessionId||t.run.sessionId===input.sessionId)&&(!terminal.has(t.state)||jobs.has(t.taskId))))throw taskError('该会话仍在执行或等待输入。','session-busy',409)
      }
      const meta = input.sessionId ? executor.metadataOf(input.sessionId) : null
      const initial = await api.submit({ goal: input.task, cwd: input.cwd ?? meta?.cwd, sessionId: input.sessionId, timeoutMs: input.timeoutMs, reasoningEffort:input.reasoningEffort, reason:input.reason,clientCallId:input.clientCallId, idempotencyKey: input.clientCallId ?? randomUUID() }, { legacy: true })
      const abort = () => { void api.cancel({ taskId: initial.taskId }).catch(() => {}) }
      input.signal?.addEventListener('abort',abort,{once:true})
      try {
        while (true) {
          if (input.signal?.aborted) abort()
          const t = get(initial.taskId)
          if (t.run.result && (terminal.has(t.state) || ['WAITING_INPUT','WAITING_APPROVAL'].includes(t.state)) && !jobs.has(t.taskId)) return { ...t.run.result, taskId: t.taskId, runId: t.activeRunId }
          if (['FAILED','CANCELLED','RECONCILING'].includes(t.state) && !jobs.has(t.taskId)) throw Object.assign(taskError(t.run.error?.message ?? '任务结果需要核对。',t.run.error?.code ?? 'task-uncertain',t.run.error?.status ?? 409),{sessionId:t.run.sessionId})
          await new Promise(r => setTimeout(r,25))
        }
      } finally { input.signal?.removeEventListener('abort',abort) }
    },
    async legacyAnswer(input) {
      const t = store.list().find(t => t.run.sessionId === input.sessionId && t.state === 'WAITING_INPUT')
      if (!t) throw taskError('当前没有待答任务。','no-pending-question',409)
      const budget = input.timeoutMs ?? 300000
      if (!Number.isInteger(budget) || budget < 1000 || budget > 600000) throw taskError('回答执行预算无效。')
      if (t.run.budgetMode === 'legacy-execution') t.run.deadline=Date.now()+budget
      if(input.clientCallId)t.clientCallId=input.clientCallId
      save(t,'run.answer_call_bound')
      await api.answer({ taskId:t.taskId,runId:t.activeRunId,requestId:input.requestId,answers:input.answers })
      while (jobs.has(t.taskId)) await new Promise(resolve => setTimeout(resolve, 25))
      const updated = get(t.taskId)
      if (updated.state === 'RECONCILING') throw Object.assign(taskError('回答后的执行状态待核对。','task-uncertain',409), { sessionId: updated.run.sessionId })
      return updated.run.result
    },
    review({taskId,runId,expectedRevision,evidenceHash,decision}) {
      const t=get(taskId)
      if(t.state!=='REVIEW_REQUIRED'||t.activeRunId!==runId||t.revision!==expectedRevision||t.run.evidenceHash!==evidenceHash)throw taskError('验收证据或任务版本已变化。','review-conflict',409)
      if(!['accept','changes_requested'].includes(decision))throw taskError('验收决定无效。')
      t.run.humanReview={decision,at:Date.now(),source:'authenticated-browser'}
      if(decision==='accept')t.state='SUCCEEDED'
      return save(t,'review.recorded')
    },
    async dispose() {
      closing = true
      for (const id of waitingTimers.keys()) clearWaiting(id)
      for (const t of store.list()) if (!terminal.has(t.state)) await api.cancel({ taskId:t.taskId }).catch(() => {})
      await Promise.allSettled([...jobs.values()].map(j => j.promise))
      await Promise.allSettled([...cancelCalls.values(), ...reconciliations.values()])
      await executor.dispose(); try {store.checkpoint()} finally {store.close()}
    },
  }
  return api
}
