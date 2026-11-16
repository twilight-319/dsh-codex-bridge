import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, readFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { digest } from './task-store.js'
const exec = promisify(execFile)
export async function workspaceEvidence(cwd) {
  try {
    const [status, diff] = await Promise.all([
      exec('git', ['-C', cwd, 'status', '--porcelain=v1'], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }),
      exec('git', ['-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD'], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }),
    ])
    return { available: true, status: status.stdout.slice(0, 30000), diff: diff.stdout.slice(0, 100000), diffHash: digest(diff.stdout), at: Date.now() }
  } catch { return { available: false, at: Date.now() } }
}
export async function verifyTask({ cwd, profile, service, signal }) {
  if (!profile) return { status: 'not_configured', checks: [], artifacts: [] }
  const checks = [], artifacts = []
  const root = await realpath(cwd)
  for (const entry of profile.files ?? []) {
    signal?.throwIfAborted()
    try {
      const target = await realpath(resolve(root, entry.path)), rel = relative(root, target)
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('outside workspace')
      const info = await stat(target)
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('not a bounded file')
      const hash = digest(await readFile(target))
      artifacts.push({ path: rel, bytes: info.size, hash })
      checks.push({ kind: 'file', path: rel, passed: entry.sha256 ? entry.sha256 === hash : true })
    } catch { checks.push({ kind: 'file', path: entry.path, passed: false }) }
  }
  for (const command of profile.commands ?? []) {
    signal?.throwIfAborted()
    // Never fall back to a shell subprocess: this capability must be supplied by the trusted host.
    if (!service?.run) { checks.push({ kind: 'command', status: 'unavailable' }); continue }
    const result = await service.run({ argv: command.argv, cwd: root, timeoutMs: command.timeoutMs ?? 30000, signal })
    checks.push({ kind: 'command', argv: command.argv, exitCode: result.exitCode, passed: result.exitCode === 0, evidenceRef: result.evidenceRef ?? null })
  }
  const status = checks.some(c => c.passed === false) ? 'failed' : checks.some(c => c.status === 'unavailable') ? 'unavailable' : checks.length ? 'passed' : 'not_configured'
  return { status, profileHash: digest(profile), checks, artifacts }
}
