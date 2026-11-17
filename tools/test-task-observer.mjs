import test from 'node:test'
import assert from 'node:assert/strict'
import { observeTask } from '../lib/task-observer.js'

const snapshot = (state = 'RUNNING', run = 'run-one', reason = 'wait-expired') => ({ reason, task: { taskId: 'task-one', activeRunId: run, state, run: { result: state === 'REVIEW_REQUIRED' ? { stopReason: 'completed', text: 'done' } : undefined } } })
function clock() {
  let time = 0
  return { now: () => time, sleep: async ms => { time += ms }, advance: ms => { time += ms } }
}

test('multiple compatibility HTTP expiries produce one observer result and bind the original run', async () => {
  const c = clock(), requests = [], outputs = []
  const result = await observeTask({ taskId: 'task-one' }, async input => {
    requests.push(input); c.advance(input.waitMs)
    return requests.length < 6 ? snapshot() : snapshot('REVIEW_REQUIRED', 'run-one', 'settled-or-input')
  }, c).then(value => { outputs.push(value); return value })
  assert.equal(requests.length, 6)
  assert.equal(outputs.length, 1, 'HTTP timeouts must not become intermediate tool/model responses')
  assert.equal(requests[0].runId, undefined)
  assert.ok(requests.slice(1).every(x => x.runId === 'run-one' && x.taskId === 'task-one'))
  assert.equal(result.task.run.result.stopReason, 'completed')
  assert.equal(result.observation.httpAwaitCalls, 6)
  assert.equal(result.observation.externalCodexUsage, 'unknown')
})

test('observation window has a finite deadline and never extends execution budget', async () => {
  const c = clock(), requests = []
  const result = await observeTask({ taskId: 'task-one', observationMs: 120000 }, async input => {
    requests.push(input); c.advance(input.waitMs); return snapshot()
  }, c)
  assert.deepEqual(requests.map(x => x.waitMs), [55000, 55000, 10000])
  assert.ok(requests.every(x => !('timeoutMs' in x) && !('goal' in x) && !('idempotencyKey' in x)))
  assert.equal(result.reason, 'observation-expired')
  assert.equal(result.observation.elapsedMs, 120000)
})

test('questions, approvals, reconciliation, workflow pauses and host shutdown return immediately', async () => {
  for (const state of ['WAITING_INPUT', 'WAITING_APPROVAL', 'RECONCILING', 'WORKFLOW_PAUSED', 'FAILED', 'CANCELLED', 'REVIEW_REQUIRED', 'SUCCEEDED']) {
    let calls = 0
    const value = snapshot(state, 'run-one', 'settled-or-input')
    value.task.question = { requestId: 'question-one' }
    const result = await observeTask({ taskId: 'task-one' }, async () => { calls++; return value })
    assert.equal(calls, 1); assert.equal(result.task.question.requestId, 'question-one')
  }
  const result = await observeTask({ taskId: 'task-one' }, async () => snapshot('RUNNING', 'run-one', 'host-closing'))
  assert.equal(result.reason, 'host-closing')
})

test('run changes never cause observation to silently follow a replacement run', async () => {
  const c = clock(); let calls = 0
  const result = await observeTask({ taskId: 'task-one' }, async input => {
    c.advance(input.waitMs); return snapshot('RUNNING', ++calls === 1 ? 'run-one' : 'run-two')
  }, c)
  assert.equal(calls, 2); assert.equal(result.reason, 'run-changed')
  const immediate = await observeTask({ taskId: 'task-one', runId: 'original' }, async () => snapshot())
  assert.equal(immediate.reason, 'run-changed')
})

test('disconnect, abort and invalid responses do not resubmit or retry unknown work', async () => {
  let calls = 0
  await assert.rejects(observeTask({ taskId: 'task-one' }, async () => { calls++; throw new Error('connection lost') }), /connection lost/)
  assert.equal(calls, 1)
  for (const value of [null, { reason: 'wait-expired' }, { ...snapshot(), task: { ...snapshot().task, taskId: 'other' } }]) {
    await assert.rejects(observeTask({ taskId: 'task-one' }, async () => value), /响应无效/)
  }
  const controller = new AbortController()
  await assert.rejects(observeTask({ taskId: 'task-one', signal: controller.signal }, async () => { controller.abort(); return snapshot() }), { name: 'AbortError' })
  await assert.rejects(observeTask({ taskId: 'task-one', signal: controller.signal }, async () => { assert.fail('aborted observation must not request') }), { name: 'AbortError' })
})

test('zero window checks once and early-expiry hosts cannot spin without delay', async () => {
  const c = clock(); let calls = 0
  const zero = await observeTask({ taskId: 'task-one', observationMs: 0 }, async input => { assert.equal(input.waitMs, 0); return snapshot() }, c)
  assert.equal(zero.reason, 'observation-expired')
  const result = await observeTask({ taskId: 'task-one', observationMs: 3000 }, async () => { calls++; return snapshot() }, c)
  assert.equal(calls, 3); assert.equal(result.observation.elapsedMs, 3000)
})

test('invalid observer budgets fail before any HTTP request', async () => {
  for (const input of [{ taskId: '' }, { taskId: 'task-one', runId: '' }, { taskId: 'task-one', observationMs: -1 }, { taskId: 'task-one', observationMs: 600001 }, { taskId: 'task-one', requestWaitMs: 0 }, { taskId: 'task-one', requestWaitMs: 55001 }]) {
    await assert.rejects(observeTask(input, async () => assert.fail('invalid observer input must not request')))
  }
})
