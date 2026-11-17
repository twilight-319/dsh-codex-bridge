// DSH TokenUsage counters are disjoint: inputTokens excludes both cache buckets.
// Source: DSH dsh-llm TokenUsage and durable assistant/message.data.usage.
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
const valid = x => Number.isSafeInteger(x) && x >= 0

export function usageFromRecords(records) {
  const messages = new Map()
  for (const record of records) {
    const e = record?.event ?? record
    if (['assistant/message', 'assistant/attempt'].includes(e?.type) && Number.isSafeInteger(e.seq)) messages.set(e.seq, e)
  }
  const all = [...messages.values()], observed = all.filter(e => valid(e.data?.usage?.inputTokens) && valid(e.data?.usage?.outputTokens))
  const totals = Object.fromEntries(fields.map(key => [key, observed.length && observed.every(e => valid(e.data.usage[key])) ? observed.reduce((n, e) => n + e.data.usage[key], 0) : null]))
  return {
    status: !observed.length ? 'unknown' : observed.length === all.length ? 'observed' : 'partial',
    source: 'assistant/message.usage', scope: 'run-baseline', inputAccounting: 'disjoint-uncached-and-cache',
    coverage: 'observed-assistant-records-only',
    modelCalls: all.length, callsWithUsage: observed.length, ...totals, cost: null,
  }
}

export function mergeUsage(previous, current) {
  if (!previous) return current
  if (!current) return previous
  return {
    ...current,
    status: previous.status === 'observed' && current.status === 'observed' ? 'observed' : previous.callsWithUsage || current.callsWithUsage ? 'partial' : 'unknown',
    modelCalls: previous.modelCalls + current.modelCalls,
    callsWithUsage: previous.callsWithUsage + current.callsWithUsage,
    ...Object.fromEntries(fields.map(key => [key, valid(previous[key]) && valid(current[key]) ? previous[key] + current[key] : null])),
    cost: null,
  }
}

// Explicit lower bounds for enforcement. Missing counters are NOT promoted to
// complete usage; these bounds only retain facts across partial event windows.
const budgetFields=['modelCalls','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']
export function usageBudgetBound(usage) {
  return Object.fromEntries(budgetFields.map(key=>[key,valid(usage?.[key])?usage[key]:0]))
}
export function addUsageBounds(previous,phase) {
  const a=usageBudgetBound(previous),b=usageBudgetBound(phase)
  return Object.fromEntries(budgetFields.map(key=>[key,a[key]+b[key]]))
}
export function retainUsageBound(previous,current) {
  const a=usageBudgetBound(previous),b=usageBudgetBound(current)
  return {status:'observed-lower-bound',...Object.fromEntries(budgetFields.map(key=>[key,Math.max(a[key],b[key])]))}
}
