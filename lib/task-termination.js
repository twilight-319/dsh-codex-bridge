/** Host facts and cancellation intent are independent; this is the sole outcome mapping. */
export const hostStopped = observation => observation?.running === false && !observation.questionPending && (!observation.pendingInput || Array.isArray(observation.pendingInput) && observation.pendingInput.length === 0)
export function deriveTermination(run, observation, adapterResult) {
  const fact = observation?.result ?? adapterResult
  // A scoped completed event wins even if cancellation was requested concurrently.
  if (fact?.stopReason === 'completed') return { kind: 'completed', result: fact }
  if (!hostStopped(observation)) return { kind: 'uncertain' }
  if (['budget-exhausted','question-expired'].includes(run.cancelReason)) return { kind: 'stopped', state: 'FAILED', outcome: run.cancelReason, stopReason: 'timeout' }
  if (run.cancelReason === 'user') return { kind: 'stopped', state: 'CANCELLED', outcome: 'cancelled', stopReason: 'cancelled' }
  // A host abort alone cannot prove whether the user or a budget caused it.
  return { kind: 'stopped', state: 'FAILED', outcome: fact?.stopReason ?? run.outcome ?? run.error?.code ?? 'unknown', stopReason: fact?.stopReason ?? 'error' }
}
