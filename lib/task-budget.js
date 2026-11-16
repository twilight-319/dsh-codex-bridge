/** Independent async execution budgets; legacy synchronous tools remain capped at 10 minutes. */
export const LEGACY_MAX_MS = 600000
export const TASK_HARD_MAX_MS = 7200000
export function taskBudgets({ taskDefaultTimeoutMs = 1800000, taskMaxTimeoutMs = TASK_HARD_MAX_MS } = {}) {
  if (!Number.isInteger(taskDefaultTimeoutMs) || !Number.isInteger(taskMaxTimeoutMs) || taskDefaultTimeoutMs < 1000 || taskMaxTimeoutMs < taskDefaultTimeoutMs || taskMaxTimeoutMs > TASK_HARD_MAX_MS) throw new Error('异步预算必须满足 1000 <= taskDefaultTimeoutMs <= taskMaxTimeoutMs <= 7200000。')
  return { taskDefaultTimeoutMs, taskMaxTimeoutMs }
}
