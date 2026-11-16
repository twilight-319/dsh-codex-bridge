// Acceptance regressions use an isolated HOME and deterministic host substitutes.
// They reproduce host contracts/fault windows, not a Windows DSH live acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
if (!process.argv.includes('--child')) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-acceptance-home-'))
  try {
    const child = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'inherit', timeout: 30000 })
    if (child.error) throw child.error
    process.exitCode = child.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  const { createExecutor } = await import('../lib/session-executor.js')
  const { createTaskManager } = await import('../lib/task-manager.js')
  const { createTaskStore } = await import('../lib/task-store.js')
  const delay = ms => new Promise(r => setTimeout(r, ms))
  async function until(predicate) {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(10) }
    assert.fail('condition did not settle')
  }
  async function fixture(t, overrides = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-acceptance-'))
    const store = createTaskStore(join(dir, 'store'))
    const counts = { execute: 0, answer: 0, cancel: 0 }
    let observation = { running: false, pendingInput: [] }
    const executor = {
      async execute(input) {
        counts.execute++
        input.onSession({ sessionId: 'session-fixture', baseline: 7 })
        return { sessionId: 'session-fixture', text: 'done', stopReason: 'completed' }
      },
      async answer() { counts.answer++; return { sessionId: 'session-fixture', text: 'answered', stopReason: 'completed' } },
      validateAnswer() {},
      async cancel() { counts.cancel++; observation = { running: false, pendingInput: [] } },
      async observe() { return observation },
      metadataOf() {}, async dispose() {}, ...overrides,
    }
    const manager = createTaskManager({ store, executor })
    let owner = manager
    t.after(async () => { await owner.dispose(); await rm(dir, { recursive: true, force: true }) })
    const submit = extra => manager.submit({ goal: 'fixture', cwd: dir, idempotencyKey: randomUUID(), ...extra })
    return { manager, executor, store, counts, dir, submit, setOwner: manager => { owner = manager }, setObservation: v => { observation = v } }
  }
  async function waiting(t, stopOnCancel = true) {
    let f
    f = await fixture(t, {
      async execute(input) {
        f.counts.execute++; input.onSession({ sessionId: 'session-question', baseline: 7 })
        return { sessionId: 'session-question', stopReason: 'needs-input', needsInput: { requestId: 'question-1', expiresAt: Date.now() + 60000, questions: [{ id: 'q', question: '?' }] } }
      },
      async cancel() { f.counts.cancel++; if (stopOnCancel) f.setObservation({ running: false, pendingInput: [] }) },
    })
    f.setObservation({ running: false, pendingInput: ['q'] })
    return f
  }
  function expire(f, id) {
    const t = f.manager.get(id); t.run.deadline = Date.now() - 1; t.revision++
    f.store.commit(t, 'fixture.deadline_advanced')
  }

  test('BETA1-01 strict host requires bounded signals for state AND events', async t => {
    let phase = 'normal', reads = 0
    const id = 'session-' + randomUUID()
    const service = {
      async create() { return { sessionId: id } }, async prompt() {}, async cancel() {},
      async state(_, signal) { signal.throwIfAborted(); reads++; if (phase === 'hang') return new Promise(() => {}); if (phase === 'error') throw Object.assign(new Error('host-read-failed'), { code: 'host-read-failed' }); return { cursor: 0, running: false, pendingInput: [] } },
      async events(_, signal) { signal.throwIfAborted(); reads++; return { records: [{ event: { seq: 8, type: 'turn/end', data: { reason: { kind: 'completed' } } } }] } },
      async wait(_, signal) { signal.throwIfAborted(); return { state: { cursor: 8 }, output: { records: [] } } },
    }
    const executor = createExecutor({ ctx: { sessionController: service } })
    t.after(() => executor.dispose())
    await executor.execute({ task: 'fixture', timeoutMs: 1000 })
    const observation = await executor.observe(id, 7)
    assert.equal(observation.running, false); assert.equal(observation.result.stopReason, 'completed')
    assert.ok(reads >= 4)
    phase = 'hang'
    await assert.rejects(executor.observe(id, 7, { timeoutMs: 20 }), { code: 'observation-timeout' })
    const controller = new AbortController(); controller.abort(Object.assign(new Error('caller-abort'), { code: 'caller-abort' }))
    await assert.rejects(executor.observe(id, 7, { signal: controller.signal }), { code: 'caller-abort' })
  })

  test('BETA1-02 status 504 after binding stays uncertain and blocks the next same-project task', async t => {
    let f
    f = await fixture(t, { async execute(input) {
      f.counts.execute++; input.onSession({ sessionId: 'session-dispatched', baseline: 7 })
      if (f.counts.execute === 1) throw Object.assign(new Error('late dispatch'), { status: 504, code: 'timeout' })
      return { sessionId: 'session-next', stopReason: 'completed', text: 'next' }
    } })
    f.setObservation({ running: true, pendingInput: [] })
    const first = await f.submit(); await until(() => f.manager.get(first.taskId).state === 'RECONCILING' || f.manager.get(first.taskId).state === 'FAILED')
    assert.equal(f.manager.get(first.taskId).state, 'RECONCILING')
    const second = await f.submit(); await delay(30)
    assert.equal(f.counts.execute, 1); assert.equal(f.manager.get(second.taskId).state, 'QUEUED')
    await assert.rejects(f.manager.retry({ taskId: first.taskId, idempotencyKey: 'unsafe' }), { code: 'task-busy' })
    f.setObservation({ running: false, pendingInput: [] })
    await f.manager.reconcile({ taskId: first.taskId })
    await until(() => f.counts.execute === 2)
    assert.equal(f.manager.get(first.taskId).state, 'FAILED')
  })

  test('BETA1-02 late session binding after 504 cannot free the project before cleanup', async t => {
    let f, bind
    f = await fixture(t, { async execute(input) { f.counts.execute++; bind = input.onSession; throw Object.assign(new Error('create still pending'), { status: 504 }) } })
    const first = await f.submit(); await until(() => ['RECONCILING','FAILED'].includes(f.manager.get(first.taskId).state))
    assert.equal(f.manager.get(first.taskId).state, 'RECONCILING')
    bind({ sessionId: 'session-late', baseline: 7 }); f.setObservation({ running: true })
    const second = await f.submit(); await delay(20)
    await f.manager.reconcile({ taskId: first.taskId })
    assert.equal(f.counts.execute, 1); assert.equal(f.manager.get(second.taskId).state, 'QUEUED')
  })

  test('BETA1-01 observation errors remain visible and do not become stop evidence', async t => {
    let f
    f = await fixture(t, { async execute(input) { f.counts.execute++; input.onSession({sessionId:'s'}); throw Object.assign(new Error('timeout'), { status:504 }) }, async observe() { throw Object.assign(new TypeError('signal required'), { code: 'host-contract' }) } })
    const task = await f.submit(); await until(() => ['RECONCILING','FAILED'].includes(f.manager.get(task.taskId).state))
    await f.manager.reconcile({taskId:task.taskId})
    const current = f.manager.get(task.taskId)
    assert.equal(current.state,'RECONCILING'); assert.equal(current.run.observationError.code,'host-contract'); assert.equal(current.run.observationError.name,'TypeError')
  })

  test('BETA1-03 expired answer cancels the pending question before recording terminal timeout', async t => {
    const f = await waiting(t), task = await f.submit()
    await until(() => f.manager.get(task.taskId).state === 'WAITING_INPUT')
    expire(f, task.taskId)
    const result = await f.manager.answer({ taskId: task.taskId, runId: task.activeRunId, requestId: 'question-1', answers: [] })
    assert.equal(f.counts.answer, 0); assert.equal(f.counts.cancel, 1)
    assert.equal(result.state, 'FAILED'); assert.equal(result.run.outcome, 'budget-exhausted'); assert.equal(result.run.question,null)
  })

  test('BETA1-03 expired question without stop evidence holds the project until a later reconcile', async t => {
    const f = await waiting(t, false), task = await f.submit()
    await until(() => f.manager.get(task.taskId).state === 'WAITING_INPUT'); expire(f, task.taskId)
    const result = await f.manager.answer({ taskId: task.taskId, runId: task.activeRunId, requestId: 'question-1', answers: [] })
    assert.equal(result.state,'RECONCILING'); assert.equal(f.counts.cancel,1); assert.equal(f.counts.answer,0)
    const queued = await f.submit(); await delay(30)
    assert.equal(f.counts.execute,1); assert.equal(f.manager.get(queued.taskId).state,'QUEUED')
    f.setObservation({running:false,pendingInput:[]})
    assert.equal((await f.manager.reconcile({taskId:task.taskId})).state,'FAILED')
    await until(() => f.counts.execute===2)
  })

  test('new task waiting budget expires without requiring the user to answer', async t => {
    const f = await waiting(t), task = await f.submit({timeoutMs:1000})
    await until(() => f.manager.get(task.taskId).state === 'WAITING_INPUT')
    await until(() => f.manager.get(task.taskId).state === 'FAILED')
    assert.equal(f.counts.cancel,1); assert.equal(f.counts.answer,0)
  })

  test('legacy dsh_answer retains its fresh execution budget after a long human wait', async t => {
    const f = await waiting(t)
    const initial = await f.manager.legacyExecute({task:'legacy',cwd:f.dir,timeoutMs:1000})
    const task = f.store.list()[0]; expire(f,task.taskId)
    const result = await f.manager.legacyAnswer({sessionId:initial.sessionId,requestId:'question-1',answers:[],timeoutMs:1000})
    assert.equal(result.stopReason,'completed'); assert.equal(f.counts.answer,1); assert.equal(f.counts.cancel,0)
  })

  test('persisted cancellation survives failed observation and manager restart', async t => {
    const f = await waiting(t, false), task = await f.submit()
    await until(() => f.manager.get(task.taskId).state === 'WAITING_INPUT')
    await f.manager.cancel({taskId:task.taskId})
    await f.manager.reconcile({taskId:task.taskId})
    assert.equal(f.manager.get(task.taskId).state,'RECONCILING')
    const recovered = createTaskManager({store:f.store,executor:f.executor}); f.setOwner(recovered)
    f.setObservation({running:false,pendingInput:[]})
    assert.equal((await recovered.reconcile({taskId:task.taskId})).state,'CANCELLED')
  })
  test('explicit pre-session rejection can terminate without blocking later work', async t => {
    let f
    f = await fixture(t, { async execute() {
      f.counts.execute++
      if (f.counts.execute === 1) throw Object.assign(new Error('policy rejected'), { status: 400, notDispatched: true })
      return {sessionId:'s',text:'next',stopReason:'completed'}
    } })
    const first = await f.submit(); await until(() => f.manager.get(first.taskId).state === 'FAILED')
    await f.submit(); await until(() => f.counts.execute === 2)
  })

  test('upgrade quarantines an older candidate FAILED status-504 record without stop evidence', async t => {
    const f = await fixture(t)
    f.store.commit({taskId:'old-failure',activeRunId:'old-run',cwd:f.dir,state:'FAILED',revision:1,run:{runId:'old-run',dispatchIntent:true,sessionId:'old-session',baseline:7,error:{status:504}}},'fixture.old_failure')
    const recovered = createTaskManager({store:f.store,executor:f.executor}); f.setOwner(recovered)
    f.setObservation({running:true,pendingInput:[]})
    assert.equal(recovered.get('old-failure').state,'RECONCILING')
    assert.equal(recovered.get('old-failure').run.recoveryReason,'legacy-failure-unconfirmed')
    await recovered.submit({goal:'queued',cwd:f.dir,idempotencyKey:'queued'})
    await delay(20); assert.equal(f.counts.execute,0)
    f.setObservation({running:false,pendingInput:[]})
    assert.equal((await recovered.reconcile({taskId:'old-failure'})).state,'FAILED')
    await until(() => f.counts.execute===1)
  })

  test('upgrade recovers cancellation intent written only as an old candidate event', async t => {
    const f = await fixture(t)
    const old={taskId:'old-cancel',activeRunId:'r',cwd:f.dir,state:'CANCEL_REQUESTED',revision:1,run:{runId:'r',sessionId:'s',baseline:7}}
    f.store.commit(old,'run.cancel_requested'); old.state='RECONCILING'; old.revision++
    f.store.commit(old,'recovery.observed')
    const recovered=createTaskManager({store:f.store,executor:f.executor}); f.setOwner(recovered)
    f.setObservation({running:false,pendingInput:[]})
    assert.equal((await recovered.reconcile({taskId:old.taskId})).state,'CANCELLED')
  })

}
