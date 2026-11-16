import assert from 'node:assert/strict'
import { createQuestionRelay } from '../lib/question-relay.js'
let listener, disposed = 0
const ctx = { on(name, fn, prepend) { assert.equal(name, 'user-questions/request'); assert.equal(prepend, true); listener = fn; return () => disposed++ } }
const relay = createQuestionRelay({ ctx, isBridgeSession: id => id === 'session-a', ttlMs: 50 })
assert.deepEqual(await listener({ agent: { id: 'web' } }, async () => ({ native: true })), { native: true })
const question = { agent: { id: 'session-a' }, questions: [{ id: 'q', question: '?', options: [{ label: 'A' }, { label: 'B' }] }] }
const held = listener(question)
const pending = relay.questionFor('session-a')
const answer = answers => relay.answer('session-a', pending.requestId, answers)
for (const answers of [[], [{ id: 'other', selected: [] }], [{ id: 'q', selected: ['C'] }], [{ id: 'q', selected: ['A', 'B'] }], [{ id: 'q', selected: ['A', 3] }], [{ id: 'q', custom: 42 }]]) {
  assert.throws(() => answer(answers)); assert.equal(relay.size, 1)
}
assert.throws(() => relay.answer('session-a', 'stale', [{ id: 'q', selected: ['A'] }]), /requestId/)
answer([{ id: 'q', selected: ['B'] }])
assert.equal(relay.size, 0, 'consumed synchronously')
assert.throws(() => answer([{ id: 'q', selected: ['A'] }]), /没有等待/)
assert.deepEqual((await held).answers, [{ id: 'q', selected: ['B'] }])
const held2 = listener(question)
assert.throws(() => relay.answer('session-a', pending.requestId, [{ id: 'q', selected: ['A'] }]), /requestId/)
relay.answer('session-a', relay.questionFor('session-a').requestId, [{ id: 'q', selected: [] }])
assert.deepEqual((await held2).answers, [{ id: 'q', selected: [] }], 'skip is not consent')
const multi = listener({ ...question, questions: [{ ...question.questions[0], multi_select: true }] })
relay.answer('session-a', relay.questionFor('session-a').requestId, [{ id: 'q', selected: ['A', 'B'], custom: 'extra' }])
assert.equal((await multi).answers[0].selected.length, 2)
const aborted = new AbortController(); aborted.abort()
await assert.rejects(listener({ ...question, signal: aborted.signal }), /取消/)
assert.equal(relay.size, 0)
const ttl = listener(question)
const expiry = assert.rejects(ttl, /超时/)
await new Promise(r => setTimeout(r, 60)); await expiry
assert.equal(relay.size, 0)
await assert.rejects(listener({ ...question, questions: [question.questions[0], question.questions[0]] }), /重复/)
const held3 = listener(question); const closing = assert.rejects(held3, /disposed/); relay.dispose(); await closing
assert.equal(disposed, 1); assert.equal(relay.size, 0)
console.log('PASS: native delegation, exact requestId, one-shot answers, strict types, skip, multi-select, abort, TTL and dispose.')
