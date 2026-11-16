// Isolated unit tests: child HOME must be a unique temporary directory.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
if (!process.argv.includes('--child')) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-executor-'))
  try { const child = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...process.env, USERPROFILE: home, HOME: home }, stdio: 'inherit' }); assert.equal(child.status, 0) }
  finally { rmSync(home, { recursive: true, force: true }) }
} else {
  const keepAlive = setInterval(() => {}, 1000)
  const { createExecutor } = await import('../lib/session-executor.js')
  const { createQuestionRelay } = await import('../lib/question-relay.js')
  const { readSessions } = await import('../lib/ledger.js')
  const sessions = new Map(); let listener; let prompts = 0; let cancels = 0
  let nextMode = 'done'
  const push = (s, type, data) => { const event = { seq: ++s.seq, type, data }; s.records.push({ event }); return event }
  const complete = (s, text) => { push(s, 'assistant/message', { message: { content: [{ type: 'text', text }] } }); push(s, 'turn/end', { reason: { kind: 'completed' } }); s.running = false }
  const service = {
    async create() { const id = 'session-' + randomUUID(); sessions.set(id, { seq: 0, records: [], running: false, mode: nextMode }); return { sessionId: id } },
    async state({ sessionId }) { const s = sessions.get(sessionId); return { cursor: s.seq, active: true, running: s.running, pendingInput: [] } },
    async prompt({ sessionId, content }) {
      prompts++; const s = sessions.get(sessionId); s.running = true; s.reads = 0
      if (s.mode === 'questions') {
        const ask = () => listener({ agent: { id: sessionId }, questions: [{ id: 'same-id', question: '?', options: [{ label: 'A' }, { label: 'B' }] }] })
        s.held = (async () => { await ask(); await ask(); complete(s, 'second-answer-completed') })().catch(() => {})
      } else if (s.mode === 'done') s.nextText = content[0].text
    },
    async wait({ sessionId }, signal) {
      const s = sessions.get(sessionId)
      if (s.mode === 'timeout') return new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true }))
      if (s.nextText && ++s.reads === 2) { complete(s, s.nextText); s.nextText = null }
      await new Promise(r => setTimeout(r, 5))
      return { state: { cursor: s.seq }, reason: s.running ? 'timeout' : 'idle', output: { records: [] } }
    },
    async events({ address }) { return { records: sessions.get(address.sessionId).records } },
    async cancel({ sessionId }) { cancels++; sessions.get(sessionId).running = false },
  }
  const ctx = { sessionController: service, on(name, fn) { listener = fn; return () => {} } }
  const relay = createQuestionRelay({ ctx, isBridgeSession: id => sessions.has(id), ttlMs: 2000 })
  const executor = createExecutor({ ctx, relay })
  const first = await executor.execute({ task: 'first', cwd: process.cwd(), timeoutMs: 2000 })
  assert.equal(first.text, 'first')
  const follow = await executor.execute({ sessionId: first.sessionId, task: 'second', timeoutMs: 2000 })
  assert.equal(follow.text, 'second', 'must not return old assistant/turn end')
  assert.equal(readSessions()[0].cwd, process.cwd(), 'reuse retains project')
  await assert.rejects(executor.execute({ sessionId: 'not-owned', task: 'x' }), { code: 'session-not-bridge-owned' })
  await assert.rejects(executor.execute({ sessionId: first.sessionId, task: 'x', cwd: process.cwd() }), { code: 'reuse-policy-override' })
  const one = executor.execute({ sessionId: first.sessionId, task: 'lock', timeoutMs: 2000 })
  await assert.rejects(executor.execute({ sessionId: first.sessionId, task: 'blocked' }), { code: 'session-busy' }); await one
  nextMode = 'questions'
  const paused = await executor.execute({ task: 'ask twice', timeoutMs: 2000 })
  assert.equal(paused.stopReason, 'needs-input'); assert.equal(readSessions()[0].state, 'needs-input')
  await assert.rejects(executor.answer({ sessionId: paused.sessionId, requestId: 'wrong', answers: [] }), { code: 'question-request-mismatch' })
  const second = await executor.answer({ sessionId: paused.sessionId, requestId: paused.needsInput.requestId, answers: [{ id: 'same-id', selected: ['B'] }] })
  assert.equal(second.stopReason, 'needs-input'); assert.notEqual(second.needsInput.requestId, paused.needsInput.requestId)
  await assert.rejects(executor.answer({ sessionId: paused.sessionId, requestId: paused.needsInput.requestId, answers: [{ id: 'same-id', selected: ['A'] }] }), { code: 'question-request-mismatch' })
  const final = await executor.answer({ sessionId: paused.sessionId, requestId: second.needsInput.requestId, answers: [{ id: 'same-id', selected: ['A'] }] })
  assert.equal(final.text, 'second-answer-completed'); assert.equal(final.stopReason, 'completed')
  await assert.rejects(executor.answer({ sessionId: paused.sessionId, requestId: second.needsInput.requestId, answers: [] }), { code: 'no-pending-question' })
  nextMode = 'timeout'
  const timed = await executor.execute({ task: 'timeout', timeoutMs: 1000 })
  assert.equal(timed.stopReason, 'timeout'); assert.ok(cancels > 0)
  sessions.get(timed.sessionId).mode = 'done'
  assert.equal((await executor.execute({ sessionId: timed.sessionId, task: 'after-timeout', timeoutMs: 2000 })).text, 'after-timeout')
  nextMode = 'questions'
  const closing = await executor.execute({ task: 'dispose paused', timeoutMs: 2000 })
  await executor.dispose(); relay.dispose()
  assert.equal(sessions.get(closing.sessionId).running, false)
  assert.ok(prompts >= 7)
  for (const stage of ['create', 'applyAccess', 'apply']) {
    let release, reached
    const gate = new Promise(r => { release = r })
    const atStage = new Promise(r => { reached = r })
    const block = async () => { reached(); await gate }
    let localPrompts = 0, localCancels = 0
    const local = { ...service,
      async create() { if (stage === 'create') await block(); return { sessionId: 'session-race-' + randomUUID() } },
      async prompt() { localPrompts++ }, async cancel() { localCancels++ },
    }
    const e = createExecutor({ ctx: { sessionController: local }, policy: {
      resolveExecution: async () => ({ permissionMode: 'full-access', selection: {} }),
      applyAccess: async () => { if (stage === 'applyAccess') await block() },
      apply: async () => { if (stage === 'apply') await block() },
    } })
    const executing = e.execute({ task: 'dispose-race', cwd: process.cwd() })
    const expected = assert.rejects(executing, { code: 'executor-disposed' })
    await atStage; const disposing = e.dispose(); release(); await disposing; await expected
    assert.equal(localPrompts, 0, stage + ' never prompts after dispose')
    assert.ok(localCancels > 0, stage + ' cancels created session')
  }
  for (const stage of ['create', 'applyAccess', 'state']) {
    let localPrompts = 0, localCancels = 0
    const delayed = () => new Promise(r => setTimeout(r, 1200))
    const id = 'session-late-' + randomUUID()
    const e = createExecutor({ ctx: { sessionController: { ...service,
      async create() { if (stage === 'create') await delayed(); return { sessionId: id } },
      async state() { if (stage === 'state') await delayed(); return { cursor: 0, running: false, pendingInput: [] } },
      async prompt() { localPrompts++ }, async cancel() { localCancels++ },
    } }, policy: { resolveExecution: async () => ({ selection: {} }), applyAccess: async () => { if (stage === 'applyAccess') await delayed() }, apply: async () => {} } })
    await assert.rejects(e.execute({ task: 'late-create', timeoutMs: 1000 }), { status: 504 })
    await e.dispose()
    assert.equal(localPrompts, 0); assert.ok(localCancels > 0)
    assert.equal(readSessions().find(s => s.sessionId === id).stopReason, 'timeout')
  }
  const approvalService = { ...service, async create() { return { sessionId: 'session-approval-' + randomUUID() } }, async state() { return { cursor: 0, running: false, pendingInput: [] } }, async prompt() {}, async events() { return { records: [] } }, async wait() { return { reason: 'input-required', state: { cursor: 1 } } }, async cancel() { cancels++ } }
  const approvalExecutor = createExecutor({ ctx: { sessionController: approvalService } })
  const beforeApprovalCancel = cancels
  assert.equal((await approvalExecutor.execute({ task: 'approval' })).stopReason, 'input-required')
  assert.equal(readSessions()[0].state, 'input-required')
  assert.equal(approvalExecutor.activity().approvals,1)
  const approvalId=readSessions()[0].sessionId
  await approvalExecutor.cancel(approvalId)
  assert.equal(approvalExecutor.activity().approvals,1, 'cancel acknowledgement alone is not stopped evidence')
  await approvalExecutor.observe(approvalId,0)
  assert.equal(approvalExecutor.activity().approvals,0, 'confirmed stopped approval cleans maintenance activity')
  await approvalExecutor.dispose(); assert.ok(cancels > beforeApprovalCancel)
  // Exercise the actual session adapter through the task manager in the isolated child HOME.
  const {createTaskManager}=await import('../lib/task-manager.js')
  const {createTaskStore}=await import('../lib/task-store.js')
  const {homedir}=await import('node:os')
  nextMode='done'
  const integratedExecutor=createExecutor({ctx})
  const manager=createTaskManager({store:createTaskStore(join(homedir(),'task-test')),executor:integratedExecutor})
  const submitted=await manager.submit({goal:'integrated',cwd:process.cwd(),idempotencyKey:'adapter'})
  for(let i=0;i<200 && manager.get(submitted.taskId).state!=='REVIEW_REQUIRED';i++)await new Promise(r=>setTimeout(r,10))
  const integrated=manager.get(submitted.taskId)
  assert.equal(integrated.run.result.text,'integrated')
  assert.equal(integrated.run.baseline,0)
  assert.ok(integrated.run.sessionId.startsWith('session-'))
  await assert.rejects(manager.legacyExecute({task:'override',sessionId:integrated.run.sessionId,cwd:process.cwd()}),{code:'reuse-policy-override'})
  const repaired=await manager.retry({taskId:integrated.taskId,idempotencyKey:'repair-1',goal:'fixed'})
  for(let i=0;i<200 && manager.get(submitted.taskId).state!=='REVIEW_REQUIRED';i++)await new Promise(r=>setTimeout(r,10))
  const fixed=manager.get(submitted.taskId)
  assert.equal(fixed.history[0].result.text,'integrated')
  assert.equal(fixed.run.result.text,'fixed')
  assert.notEqual(fixed.activeRunId,integrated.activeRunId)
  assert.equal((await manager.retry({taskId:integrated.taskId,idempotencyKey:'repair-1',goal:'fixed'})).activeRunId,repaired.activeRunId)
  await manager.dispose()
  nextMode='questions'
  const cancelRelay=createQuestionRelay({ctx,isBridgeSession:id=>sessions.has(id)})
  const cancelExecutor=createExecutor({ctx,relay:cancelRelay})
  const awaiting=await cancelExecutor.execute({task:'cancel question'})
  assert.equal(awaiting.stopReason,'needs-input')
  await cancelExecutor.cancel(awaiting.sessionId)
  sessions.get(awaiting.sessionId).mode='done'
  assert.equal((await cancelExecutor.execute({task:'after cancellation',sessionId:awaiting.sessionId})).text,'after cancellation')
  await cancelExecutor.dispose();cancelRelay.dispose()
  clearInterval(keepAlive)
  console.log('PASS: cursor isolation, lock, strict reuse, two questions, stale requestId, timeout cleanup and dispose.')
}
