/**
 * Route mounts for the bridge, safe under plugin reloads.
 *
 * Cordis tears down the routes a plugin registered when the plugin unloads, so a
 * reloaded plugin must register again. A module-level "already mounted" cache is
 * therefore wrong: the route may already be gone while the cache says mounted.
 * Every mount attempt registers; a duplicate-registration error is swallowed and
 * the existing route keeps serving.
 *
 * @module @local/dsh-codex-bridge/route-host
 */
function getService(ctx, key) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get(key)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    /* service not ready */
  }
  try {
    return ctx ? ctx[key] : undefined
  } catch {
    return undefined
  }
}

/**
 * Register one browser-authenticated Fetch route.
 * @returns {boolean} whether a registration call succeeded.
 */
export function mountBrowserRoute(ctx, path, methods, handler) {
  if (typeof path !== 'string' || path === '' || typeof handler !== 'function') return false
  const connection = getService(ctx, 'connection')
  const registry = connection && connection.fetch
  if (!registry || typeof registry.register !== 'function') return false
  try {
    registry.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: (request) => handler(request),
    })
    return true
  } catch {
    // Already registered by an earlier mount that survived: the old handler stays.
    return false
  }
}

/**
 * Register one raw Node route on the web server.
 *
 * Returns the host-provided disposer so a plugin reload can actually remove the
 * registration instead of leaving the previous handler mounted forever.
 *
 * @returns {(() => void) | false} disposer, or false when registration failed.
 */
export function mountNodeRoute(ctx, path, handler) {
  if (typeof path !== 'string' || path === '' || typeof handler !== 'function') return false
  const webServer = getService(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') return false
  try {
    const dispose = webServer.register({ kind: 'exact', path, handler: (req, res) => handler(req, res) })
    return typeof dispose === 'function' ? dispose : () => {}
  } catch {
    return false
  }
}
