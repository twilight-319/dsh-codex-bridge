import { setTimeout as pause } from 'node:timers/promises'

export const OBSERVATION_DEFAULT_MS = 600000
export const OBSERVATION_REQUEST_MS = 55000
const running = new Set(['QUEUED', 'RUNNING', 'VERIFYING', 'REVIEWING', 'CANCEL_REQUESTED'])

// This loop owns read-only HTTP waits, never task dispatch or model requests.
// The caller still needs to keep its outer tool envelope open.
export async function observeTask(input, awaitTask, { now = Date.now, sleep = ms => pause(ms, undefined, { signal: input.signal }) } = {}) {
  const { taskId, runId, observationMs = OBSERVATION_DEFAULT_MS, requestWaitMs = OBSERVATION_REQUEST_MS, signal } = input
  if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 200 || (runId !== undefined && (typeof runId !== 'string' || !runId.trim() || runId.length > 200))) throw new Error('taskId/runId 必须是非空任务凭据，最多200字符。')
  if (!Number.isInteger(observationMs) || observationMs < 0 || observationMs > OBSERVATION_DEFAULT_MS) throw new Error('observationMs 必须是0~600000整数。')
  if (!Number.isInteger(requestWaitMs) || requestWaitMs < 1000 || requestWaitMs > OBSERVATION_REQUEST_MS) throw new Error('requestWaitMs 必须是1000~55000整数。')
  const started = now(), deadline = started + observationMs
  let boundRun = runId, calls = 0
  const finish = (value, reason = value.reason) => ({ ...value, reason, observation: { httpAwaitCalls: calls, elapsedMs: Math.max(0, now() - started), externalCodexUsage: 'unknown' } })
  while (true) {
    signal?.throwIfAborted()
    const waitMs = Math.min(requestWaitMs, Math.max(0, deadline - now())), before = now()
    const value = await awaitTask({ taskId, ...(boundRun ? { runId: boundRun } : {}), waitMs }, signal)
    calls++
    signal?.throwIfAborted()
    if (!value || typeof value.reason !== 'string' || value.task?.taskId !== taskId || typeof value.task?.activeRunId !== 'string' || !value.task.activeRunId || typeof value.task?.state !== 'string') throw new Error('任务观察响应无效；保留原任务凭据，不重新派发。')
    if (boundRun && value.task.activeRunId !== boundRun) return finish(value, 'run-changed')
    boundRun ??= value.task.activeRunId
    if (value.reason !== 'wait-expired' || !running.has(value.task.state)) return finish(value)
    if (now() >= deadline) return finish(value, 'observation-expired')
    // Protect against a host incorrectly returning an immediate expiry in a loop.
    const throttle = Math.min(deadline - now(), Math.max(0, Math.min(waitMs, 1000) - (now() - before)))
    if (throttle > 0) await sleep(throttle)
    if (now() >= deadline) return finish(value, 'observation-expired')
  }
}
