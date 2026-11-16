/** Apply a real host signal AND a wall-clock bound, including hosts ignoring abort. */
export async function boundedHostCall(work, { signal: callerSignal, timeoutMs = 5000, code = 'host-call-timeout' } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('invalid host call timeout')
  const controller = new AbortController()
  const forward = () => controller.abort(callerSignal.reason ?? new Error('host call cancelled'))
  callerSignal?.addEventListener('abort', forward, { once: true })
  if (callerSignal?.aborted) forward()
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('宿主操作超时。'), { code })), timeoutMs)
  let onAbort
  try {
    const aborted = new Promise((_, no) => {
      onAbort = () => no(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
    const read = (async () => { controller.signal.throwIfAborted(); return work(controller.signal) })()
    return await Promise.race([read, aborted])
  } finally {
    clearTimeout(timer); callerSignal?.removeEventListener('abort', forward)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
