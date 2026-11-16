// Offline release gate. No real profile mutations, model calls or live tasks.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
const root = new URL('..', import.meta.url)
const checks = ['index.js', 'client.js', ...readdirSync(new URL('../lib', import.meta.url)).filter(n => n.endsWith('.js')).map(n => 'lib/' + n), 'bin/mcp-server.mjs']
for (const file of checks) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const tests = ['test-retest-regressions', 'test-acceptance-regressions', 'test-task-core', 'test-auth-classify', 'test-endpoint-discovery', 'test-publish-origin', 'test-publish-origin-invalid', 'test-endpoint-mcp', 'test-execution-policy', 'test-http-route-modes', 'test-question-relay', 'test-session-executor', 'test-native-client', 'test-model-settings-client']
for (const test of tests) {
  console.log('\n=== ' + test + ' ===')
  const result = spawnSync(process.execPath, ['tools/' + test + '.mjs'], { cwd: root, stdio: 'inherit', timeout: 60000 })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('\nPASS: syntax checks and all ' + tests.length + ' offline regression suites.')
