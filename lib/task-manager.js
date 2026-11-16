import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { digest, taskError } from './task-store.js'
import { workspaceEvidence, verifyTask } from './task-verifier.js'
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REVIEW_REQUIRED'])
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
export function createTaskManager({ store, executor, profiles = {}, verificationService, reviewer, maxConcurrency = 2 }) {
  const epoch = randomUUID(), jobs = new Map(), busyProjects = new Set(), cancelledCalls = new Map()
  let closing = false, wakePending = false
  for (const t of store.list()) if (!terminal.has(t.state)) {
    t.state = 'RECONCILING'; t.revision++; t.updatedAt = Date.now()
    t.run.question = null; t.run.recoveryReason = 'host-restarted'; store.commit(t, 'run.interrupted')
  }
  const get = id => { const t = store.get(id); if (!t) throw taskError('任务不存在。', 'task-not-found', 404); return t }
  function save(t, type) { t.revision++; t.updatedAt = Date.now(); return store.commit(t, type) }
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
  async function finish(id, result, controller) {
    let t = get(id)
    t.run.sessionId = result.sessionId ?? t.run.sessionId
    t.run.result = result; t.run.execution = result.execution ?? t.run.execution
    if (result.stopReason === 'needs-input') {
      t.state = 'WAITING_INPUT'; t.run.question = result.needsInput; save(t, 'run.waiting_input'); return
    }
    if (result.stopReason === 'input-required') { t.state = 'WAITING_APPROVAL'; save(t, 'run.waiting_approval'); return }
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
    } else if (result.stopReason === 'cancelled') {
      const observed = await executor.observe(t.run.sessionId,t.run.baseline ?? 0).catch(()=>null)
      if (observed?.result?.stopReason === 'completed') return finish(id,observed.result,controller)
      t.state = observed?.running === false ? 'CANCELLED' : 'RECONCILING'
    } else {
      const observed=await executor.observe(t.run.sessionId,t.run.baseline??0).catch(()=>null)
      if(observed?.result?.stopReason==='completed')return finish(id,observed.result,controller)
      t.state=observed?.running===false?'FAILED':'RECONCILING'
    }
    save(t, 'run.finished')
  }
  async function launch(id, answer) {
    const t = get(id), controller = new AbortController()
    const remaining = t.run.deadline - Date.now()
    if (remaining <= 0) { t.state = 'FAILED'; t.run.outcome = 'budget-exhausted'; save(t, 'run.finished'); return }
    jobs.set(id, { controller }); busyProjects.add(t.cwd)
    const timer=setTimeout(()=>controller.abort(new Error('task budget exhausted')),remaining);timer.unref?.()
    const promise = (async () => {
      try {
        t.state = 'RUNNING'; t.run.epoch = epoch; save(t, answer ? 'run.continued' : 'run.started')
        if (!answer) { t.run.before = await workspaceEvidence(t.cwd); save(t,'workspace.baseline') }
        controller.signal.throwIfAborted()
        t.run.dispatchIntent=true;save(t,'run.dispatch_intent')
        const result = answer ? await executor.answer({ ...answer, sessionId: t.run.sessionId, timeoutMs: Math.min(600000, Math.max(1000, remaining)), signal: controller.signal }) : await executor.execute({
          task: t.goal, cwd: t.cwd, dispatchRequestId:t.run.dispatchRequestId, ...(t.reasoningEffort ? {reasoningEffort:t.reasoningEffort,reason:t.reason} : {}), ...(t.sessionId ? { sessionId: t.sessionId, cwd: undefined } : {}),
          timeoutMs: Math.min(600000, Math.max(1000, t.run.deadline - Date.now())), signal: controller.signal,
          onSession(meta) { const current = get(id); Object.assign(current.run, meta); save(current, 'run.session_bound') },
        })
        await finish(id, result, controller)
      } catch (error) {
        const current = get(id)
        // No terminal acknowledgement means cancellation/dispatch may be uncertain.
        current.state = !current.run.dispatchIntent && controller.signal.aborted ? 'CANCELLED' : error.status ? 'FAILED' : 'RECONCILING'; current.run.error = { code: error.code ?? 'execution-error', status:error.status, message:error.status ? error.message : '执行状态不确定' }
        save(current, 'run.uncertain')
      } finally { clearTimeout(timer); jobs.delete(id); busyProjects.delete(t.cwd); schedule() }
    })()
    jobs.get(id).promise = promise
    return promise
  }
  const api = {
    epoch,
    async submit(raw) {
      if (closing) throw taskError('任务核心正在停止。', 'task-manager-closing', 503)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw taskError('参数必须是对象。')
      const allowed = ['goal','cwd','idempotencyKey','verificationProfile','review','timeoutMs','sessionId','reasoningEffort','reason','clientCallId','plan','acceptance']
      if (Object.keys(raw).some(k => !allowed.includes(k))) throw taskError('未知任务字段。')
      if (typeof raw.goal !== 'string' || !raw.goal.trim() || raw.goal.length > 20000) throw taskError('goal 必须是 1 至 20000 字符。')
      if (typeof raw.idempotencyKey !== 'string' || !raw.idempotencyKey.trim() || raw.idempotencyKey.length > 200) throw taskError('idempotencyKey 必填，最多 200 字符。')
      if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw taskError('cwd 必须是目录字符串。')
      if (raw.review !== undefined && typeof raw.review !== 'boolean') throw taskError('review 必须是布尔值。')
      if(raw.plan!==undefined && (typeof raw.plan!=='string'||raw.plan.length>20000)) throw taskError('plan 无效。')
      if(raw.acceptance!==undefined && (!Array.isArray(raw.acceptance)||raw.acceptance.length>30||raw.acceptance.some(x=>typeof x!=='string'||x.length>2000)))throw taskError('acceptance 无效。')
      const timeoutMs = raw.timeoutMs ?? 300000
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw taskError('timeoutMs 必须是 1000 至 600000 整数。')
      const cwd = resolve(raw.cwd ?? process.cwd()), key = digest({ cwd, key: raw.idempotencyKey }), payloadHash = digest(canonical({ ...raw, cwd, timeoutMs }))
      const find = () => store.list().find(t => t.submissionKey === key)
      let existing = find()
      if (existing) { if (existing.payloadHash !== payloadHash) throw taskError('同一幂等键的内容发生变化。', 'idempotency-conflict', 409); return existing }
      if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw taskError('cwd 必须存在。')
      if (raw.verificationProfile !== undefined && !Object.hasOwn(profiles, raw.verificationProfile)) throw taskError('验证配置不存在。')
      // Recheck after the async directory probe: concurrent submissions must converge.
      existing = find()
      if (existing) { if (existing.payloadHash !== payloadHash) throw taskError('幂等键冲突。', 'idempotency-conflict',409); return existing }
      const taskId = 'task-' + randomUUID(), runId = 'run-' + randomUUID()
      const t = { schemaVersion: 1, taskId, activeRunId: runId, cwd, goal: raw.goal, sessionId: raw.sessionId,
        reasoningEffort:raw.reasoningEffort, reason:raw.reason, plan:raw.plan ?? null, acceptance:raw.acceptance ?? [], review: raw.review === true, profile: raw.verificationProfile ? structuredClone(profiles[raw.verificationProfile]) : null,
        clientCallId:raw.clientCallId, submissionKey: key, payloadHash, state: 'QUEUED', revision: 1, createdAt: Date.now(), updatedAt: Date.now(),
        run: { runId, attempt: 1, dispatchRequestId: randomUUID(), deadline: Date.now() + timeoutMs, epoch, verification: { status: 'pending' } } }
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
      if (t.state === 'QUEUED') { t.state = 'CANCELLED'; t.run.outcome = 'not-dispatched'; save(t,'run.finished'); schedule(); return get(taskId) }
      t.state = 'CANCEL_REQUESTED'; save(t,'run.cancel_requested')
      const job = jobs.get(taskId)
      if (job) { job.controller.abort(new Error('user cancelled')); return get(taskId) }
      if (t.run.sessionId) { await executor.cancel(t.run.sessionId); return api.reconcile({ taskId }) }
      t.state = 'RECONCILING'; return save(t,'run.uncertain')
    },
    retry({taskId,idempotencyKey,goal}) {
      if(closing)throw taskError('任务核心正在停止。','task-manager-closing',503)
      const t=get(taskId)
      if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>200)throw taskError('重试需要幂等键。')
      if(goal!==undefined&&(typeof goal!=='string'||!goal.trim()||goal.length>20000))throw taskError('修复任务无效。')
      const key=digest(idempotencyKey),payloadHash=digest(goal??t.goal)
      const prior=t.retryKeys?.[key]
      if(prior){if(prior.payloadHash!==payloadHash)throw taskError('重试内容冲突。','idempotency-conflict',409);return t}
      if(!terminal.has(t.state)||jobs.has(taskId))throw taskError('先完成当前运行或对账。','task-busy',409)
      if(t.run.attempt>=3)throw taskError('已达到两轮修复上限。','retry-budget-exhausted',409)
      t.history=[...(t.history??[]),t.run]
      t.sessionId=t.run.sessionId
      t.goal=goal??t.goal
      t.run={runId:'run-'+randomUUID(),attempt:t.run.attempt+1,dispatchRequestId:randomUUID(),deadline:Date.now()+300000,epoch,verification:{status:'pending'}}
      t.activeRunId=t.run.runId;t.state='QUEUED'
      t.retryKeys={...(t.retryKeys??{}),[key]:{payloadHash,runId:t.activeRunId}}
      save(t,'run.retry_created');schedule();return t
    },
    async answer({ taskId, runId, requestId, answers }) {
      const t = get(taskId)
      if (t.activeRunId !== runId || t.state !== 'WAITING_INPUT' || t.run.question?.requestId !== requestId) throw taskError('当前问题标识不匹配。', 'question-request-mismatch',409)
      if (t.run.epoch !== epoch) throw taskError('旧宿主问题已失效。', 'question-expired',409)
      // The executor validates answers synchronously; preserve the pending question on rejection.
      if (jobs.has(taskId)) throw taskError('会话忙。','session-busy',409)
      executor.validateAnswer({sessionId:t.run.sessionId,requestId,answers});
      await launch(taskId,{ requestId, answers }); return get(taskId)
    },
    async reconcile({ taskId }) {
      let t = get(taskId)
      if (terminal.has(t.state) || jobs.has(taskId)) return t
      if (!t.run.sessionId) return t
      const observation = await executor.observe(t.run.sessionId,t.run.baseline ?? 0).catch(() => null)
      if(t.state==='CANCEL_REQUESTED' && observation?.running===false && !observation.result) {t.state='CANCELLED';t.run.outcome='cancelled';save(t,'run.finished');schedule()}
      else if (observation?.result) { await finish(taskId,observation.result,new AbortController()); schedule() }
      else { t = get(taskId); t.state = 'RECONCILING'; t.run.observation = observation; save(t,'recovery.observed') }
      return get(taskId)
    },
    async legacyExecute(input) {
      if(input.sessionId) {
        if(input.cwd!==undefined||input.reasoningEffort!==undefined||input.reason!==undefined)throw taskError('复用会话不能覆盖 cwd/reasoningEffort/reason。','reuse-policy-override',400)
        if(store.list().some(t=>(t.sessionId===input.sessionId||t.run.sessionId===input.sessionId)&&(!terminal.has(t.state)||jobs.has(t.taskId))))throw taskError('该会话仍在执行或等待输入。','session-busy',409)
      }
      const meta = input.sessionId ? executor.metadataOf(input.sessionId) : null
      const initial = await api.submit({ goal: input.task, cwd: input.cwd ?? meta?.cwd, sessionId: input.sessionId, timeoutMs: input.timeoutMs, reasoningEffort:input.reasoningEffort, reason:input.reason,clientCallId:input.clientCallId, idempotencyKey: input.clientCallId ?? randomUUID() })
      const abort = () => { void api.cancel({ taskId: initial.taskId }).catch(() => {}) }
      input.signal?.addEventListener('abort',abort,{once:true})
      try {
        while (true) {
          if (input.signal?.aborted) abort()
          const t = get(initial.taskId)
          if (t.run.result && !jobs.has(t.taskId)) return { ...t.run.result, taskId: t.taskId, runId: t.activeRunId }
          if (['FAILED','CANCELLED','RECONCILING'].includes(t.state) && !jobs.has(t.taskId)) throw Object.assign(taskError(t.run.error?.message ?? '任务结果需要核对。',t.run.error?.code ?? 'task-uncertain',t.run.error?.status ?? 409),{sessionId:t.run.sessionId})
          await new Promise(r => setTimeout(r,25))
        }
      } finally { input.signal?.removeEventListener('abort',abort) }
    },
    async legacyAnswer(input) {
      const t = store.list().find(t => t.run.sessionId === input.sessionId && t.state === 'WAITING_INPUT')
      if (!t) throw taskError('当前没有待答任务。','no-pending-question',409)
      t.run.deadline=Date.now()+(input.timeoutMs??300000)
      if(input.clientCallId)t.clientCallId=input.clientCallId
      save(t,'run.answer_call_bound')
      await api.answer({ taskId:t.taskId,runId:t.activeRunId,requestId:input.requestId,answers:input.answers })
      return get(t.taskId).run.result
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
      for (const t of store.list()) if (!terminal.has(t.state)) await api.cancel({ taskId:t.taskId }).catch(() => {})
      await Promise.allSettled([...jobs.values()].map(j => j.promise))
      await executor.dispose(); try {store.checkpoint()} finally {store.close()}
    },
  }
  return api
}
