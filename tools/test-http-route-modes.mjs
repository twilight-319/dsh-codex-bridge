// Contract test for the two bearer routes: the status path must be read-only and
// the execute path must stay the only route able to start a session.
import assert from 'node:assert/strict'
import { createHttpHandler, createAnswerHandler } from '../lib/dsh-exec-v4.js'

const token = 'a'.repeat(64)
const calls = { execute: 0 }
const executor = {
  async execute(input) {
    calls.execute += 1
    return { sessionId: 'session-test', text: `ok:${input.task}`, elapsedMs: 1, stopReason: 'completed' }
  },
  async describePolicy() {
    return { revision: 1, effortMode: 'adaptive', model: 'p/deepseek', reasoningEfforts: ['low', 'high'], allowedEfforts: ['low'] }
  },
}
const logger = { warn() {}, info() {} }
const statusOnly = createHttpHandler({ executor, token, logger, allowExecute: false })
const full = createHttpHandler({ executor, token, logger, allowExecute: true })
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

// 1. Status path: GET works and exposes the policy; POST is refused and never executes.
let response = await statusOnly(new Request('http://127.0.0.1/api/x.status', { method: 'GET', headers: auth }))
assert.equal(response.status, 200)
assert.equal((await response.json()).policy.effortMode, 'adaptive')
response = await statusOnly(new Request('http://127.0.0.1/api/x.status', {
  method: 'POST', headers: auth, body: JSON.stringify({ task: 'must not run' }),
}))
assert.equal(response.status, 405)
assert.equal(response.headers.get('allow'), 'GET, HEAD')
assert.equal(calls.execute, 0, 'POST to the status path must not execute')

// 2. Missing/incorrect bearer is rejected on both paths.
for (const handler of [statusOnly, full]) {
  response = await handler(new Request('http://127.0.0.1/api/x.status', { method: 'GET' }))
  assert.equal(response.status, 401)
}

// 3. Execute path: invalid JSON / invalid effort are rejected before execution.
response = await full(new Request('http://127.0.0.1/api/x.execute', { method: 'POST', headers: auth, body: '{' }))
assert.equal(response.status, 400)
assert.equal(calls.execute, 0)
response = await full(new Request('http://127.0.0.1/api/x.execute', {
  method: 'POST', headers: auth, body: JSON.stringify({ task: 'x', reasoningEffort: 5 }),
}))
assert.equal(response.status, 400)
assert.equal(calls.execute, 0)

// 4. Execute path runs the task and returns the execution metadata.
response = await full(new Request('http://127.0.0.1/api/x.execute', {
  method: 'POST', headers: auth, body: JSON.stringify({ task: 'run me', reasoningEffort: 'high', reason: 'test' }),
}))
const body = await response.json()
assert.equal(response.status, 200)
assert.equal(body.ok, true)
assert.equal(body.text, 'ok:run me')
assert.equal(calls.execute, 1)
// 5. A run that stops for a human decision returns an actionable 409, not a bare code.
const waiting = createHttpHandler({
  executor: { async execute() { return { sessionId: 'session-wait', text: '', elapsedMs: 5, stopReason: 'input-required' } } },
  token,
  logger,
  allowExecute: true,
})
response = await waiting(new Request('http://127.0.0.1/api/x.execute', {
  method: 'POST', headers: auth, body: JSON.stringify({ task: 'needs approval' }),
}))
const waitingBody = await response.json()
assert.equal(response.status, 409)
assert.equal(waitingBody.error, 'input-required')
assert.equal(waitingBody.sessionId, 'session-wait')
assert.match(waitingBody.message, /人工审批/)
assert.match(waitingBody.message, /执行权限/)

for (const stopReason of ['error', 'timeout', 'cancelled', 'unknown', 'idle', 'input-required']) {
  for (const kind of ['execute', 'answer']) {
    const handler = kind === 'answer' ? createAnswerHandler : createHttpHandler
    const handle = handler({ token, executor: { [kind]: async () => ({ sessionId: 'session-failed', stopReason, text: 'must-not-succeed' }) } })
    const response = await handle(new Request('http://127.0.0.1/api/test', { method: 'POST', headers: auth, body: JSON.stringify({ task: 'x', sessionId: 'session-failed', requestId: 'q1', answers: [] }) }))
    const body = await response.json()
    assert.equal(body.ok, false, kind + ':' + stopReason)
    assert.equal(body.sessionId, 'session-failed')
    assert.equal(body.stopReason, stopReason)
    assert.ok(response.status >= 400)
  }
}
const answerHandler = createAnswerHandler({ token, executor: { answer: async () => { throw new Error('must not call') } } })
assert.equal((await answerHandler(new Request('http://127.0.0.1/api/test', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'session-a', answers: [] }) }))).status, 400)

console.log('PASS: status route is read-only, execute route rejects invalid input before running, bearer required, input-required is actionable.')
