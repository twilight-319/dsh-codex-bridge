/** One-shot question relay for bridge-owned sessions; ordinary Web questions pass through. */
import { randomUUID } from 'node:crypto'

const DEFAULT_TTL_MS = 15 * 60 * 1000
const invalid = (message) => Object.assign(new Error(`dsh_answer: ${message}`), { status: 400, code: 'invalid-answer' })

function exactText(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw invalid(`${name} 必须是非空字符串，最多 ${limit} 字符。`)
  return value
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) throw invalid('questions 必须包含 1~20 个问题。')
  const ids = new Set()
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('问题必须是对象。')
    const id = exactText(item.id, '问题 id', 120)
    if (ids.has(id)) throw invalid('问题 id 不能重复。')
    ids.add(id)
    const question = exactText(item.question, 'question', 2000)
    if (item.options !== undefined && (!Array.isArray(item.options) || item.options.length > 12)) throw invalid('options 必须是最多 12 项的数组。')
    const labels = new Set()
    const options = (item.options ?? []).map((option) => {
      const label = exactText(option?.label, '选项 label', 300)
      if (labels.has(label)) throw invalid('候选 label 不能重复。')
      labels.add(label)
      return { label, ...(typeof option.description === 'string' ? { description: option.description.slice(0, 500) } : {}) }
    })
    return { id, question, ...(typeof item.header === 'string' ? { header: item.header.slice(0, 200) } : {}), ...(item.multiSelect === true || item.multi_select === true ? { multiSelect: true } : {}), ...(options.length ? { options } : {}) }
  })
}

function validateAnswers(questions, raw) {
  if (!Array.isArray(raw) || raw.length !== questions.length) throw invalid('answers 必须覆盖每个问题且数量一致。')
  const byId = new Map(questions.map((question) => [question.id, question]))
  const seen = new Set()
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('每个 answer 必须是对象。')
    const question = byId.get(item.id)
    if (!question) throw invalid(`未知问题 id ${JSON.stringify(item.id)}。`)
    if (seen.has(item.id)) throw invalid('问题不能重复回答。')
    seen.add(item.id)
    if (item.selected !== undefined && (!Array.isArray(item.selected) || item.selected.some((label) => typeof label !== 'string' || !label))) throw invalid('selected 必须是非空 label 的数组。')
    if (item.custom !== undefined && typeof item.custom !== 'string') throw invalid('custom 必须是字符串。')
    const selected = item.selected ?? []
    if (new Set(selected).size !== selected.length) throw invalid('选项不能重复。')
    if (!question.multiSelect && selected.length > 1) throw invalid('单选问题最多选择一个选项。')
    const allowed = new Set((question.options ?? []).map((option) => option.label))
    if (selected.some((label) => !allowed.has(label))) throw invalid('selected 不在问题候选选项里。')
    if (item.custom?.length > 10000) throw invalid('custom 最多 10000 字符。')
    // Empty answers are an explicit skip, as in the native DSH question tool.
    return { id: item.id, selected: [...selected], ...(item.custom?.trim() ? { custom: item.custom } : {}) }
  })
}

export function createQuestionRelay({ ctx, isBridgeSession, logger, ttlMs = DEFAULT_TTL_MS } = {}) {
  const pending = new Map()
  let disposed = false
  function settle(sessionId, entry) {
    if (pending.get(sessionId) !== entry) return false
    pending.delete(sessionId)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener?.('abort', entry.onAbort)
    return true
  }
  function listener(request, next) {
    const sessionId = request?.agent?.id == null ? '' : String(request.agent.id)
    if (!sessionId || !isBridgeSession?.(sessionId)) return next()
    if (disposed) return Promise.reject(new Error('codex bridge disposed'))
    let questions
    try { questions = normalizeQuestions(request.questions) } catch (error) { return Promise.reject(error) }
    if (pending.has(sessionId)) return Promise.reject(new Error('该会话已有一个等待回答的提问。'))
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const entry = { requestId: randomUUID(), sessionId, questions, createdAt: Date.now(), expiresAt: Date.now() + Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS), resolve, reject, signal: request.signal, timer: null, onAbort: null }
    entry.onAbort = () => { if (settle(sessionId, entry)) reject(new Error('DSH 提问已取消。')) }
    pending.set(sessionId, entry)
    entry.timer = setTimeout(() => { if (settle(sessionId, entry)) reject(new Error('DSH 提问等待回答超时；任务不会自动重跑。')) }, Math.max(1, entry.expiresAt - Date.now()))
    entry.timer.unref?.()
    entry.signal?.addEventListener?.('abort', entry.onAbort, { once: true })
    if (entry.signal?.aborted) entry.onAbort()
    logger?.info?.(`codex-bridge: relaying ${questions.length} question(s) from ${sessionId}`)
    return promise.then((answers) => ({ answers }))
  }
  const unregister = ctx?.on?.('user-questions/request', listener, true)
  function questionFor(sessionId) {
    const entry = pending.get(sessionId)
    if (!entry) return undefined
    return { requestId: entry.requestId, sessionId, expiresAt: entry.expiresAt, questions: structuredClone(entry.questions) }
  }
  function answer(sessionId, requestId, rawAnswers) {
    const entry = pending.get(sessionId)
    if (!entry) throw Object.assign(new Error('该 DSH 会话当前没有等待回答的问题。'), { status: 409, code: 'question-not-pending' })
    if (requestId !== entry.requestId) throw Object.assign(new Error('requestId 已过期或不属于当前提问；请使用最新 question.requestId。'), { status: 409, code: 'question-request-mismatch' })
    const answers = validateAnswers(entry.questions, rawAnswers)
    settle(sessionId, entry) // Consume synchronously, before waking the DSH continuation.
    entry.resolve(answers)
    return { requestId, answers }
  }
  function cancel(sessionId, reason = 'DSH 提问已取消。') {
    const entry = pending.get(sessionId)
    if (entry && settle(sessionId, entry)) entry.reject(new Error(reason))
  }
  function dispose() {
    disposed = true
    if (typeof unregister === 'function') unregister()
    for (const sessionId of [...pending.keys()]) cancel(sessionId, 'codex bridge disposed while a DSH question was pending')
  }
  return { questionFor, answer, cancel, dispose, get size() { return pending.size } }
}
