/**
 * Context gathering for the advisor: the Codex turn is text-only (the local
 * Windows sandbox cannot start child processes), so the bridge reads the repo
 * itself and hands Codex exactly the facts the decision needs.
 *
 * @module @local/dsh-codex-bridge/context
 */
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const GIT_TIMEOUT_MS = 15_000
const PER_FILE_CHARS = 30_000
const PER_DIR_ENTRIES = 60

function git(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolvePromise(error ? null : String(stdout).trimEnd()),
    )
  })
}

function inside(root, target) {
  const back = relative(root, target)
  return back !== '..' && !back.startsWith('..' + sep) && !isAbsolute(back)
}

async function readCapped(path, info, cap) {
  if (!info.isFile()) return null
  if (info.size > cap * 4) return `(skipped: ${Math.round(info.size / 1024)} KiB is too large)`
  const buffer = await readFile(path)
  if (buffer.includes(0)) return '(skipped: binary file)'
  const text = buffer.toString('utf8')
  return text.length > cap ? `${text.slice(0, cap)}\n…(truncated, ${text.length - cap} chars omitted)` : text
}

/**
 * Read the requested paths (files or directories) into labelled text blocks.
 * @returns {Promise<string>} concatenated `<file path=...>...</file>` blocks
 */
export async function gatherFiles(cwd, paths, budget = 120_000) {
  const blocks = []
  let used = 0
  const root = await realpath(cwd)
  for (const path of paths ?? []) {
    if (typeof path !== 'string' || path.trim() === '') continue
    const heading = `<file path="${path.trim()}">\n`
    const cap = Math.min(PER_FILE_CHARS, budget - used - heading.length - 64)
    if (cap <= 0) break
    let body
    try {
      const target = await realpath(resolve(cwd, path.trim()))
      if (!inside(root, target)) continue
      const info = await stat(target)
      if (info.isDirectory()) {
        const entries = (await readdir(target, { withFileTypes: true }))
          .slice(0, PER_DIR_ENTRIES)
          .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
        body = `(directory listing)\n${entries.join('\n')}`
      } else {
        body = await readCapped(target, info, cap)
      }
    } catch (error) {
      body = `(unreadable: ${error instanceof Error ? error.message : String(error)})`
    }
    const block = `${heading}${body ?? '(empty)'}\n</file>`
    if (used + block.length > budget) {
      blocks.push(`(remaining files omitted: context budget ${budget} chars reached)`)
      break
    }
    used += block.length + 2
    blocks.push(block)
  }
  return blocks.join('\n\n')
}

/**
 * Build the diff under review for one target.
 * @param {'worktree'|'staged'|'files'} target
 * @param {string[]} paths
 * @returns {Promise<string>} unified diff plus untracked-file contents
 */
export async function gatherDiff(cwd, target, paths = [], budget = 160_000) {
  const scoped = paths.filter((path) => typeof path === 'string' && path.trim() !== '')
  const parts = []
  if (target === 'staged') {
    const staged = await git(cwd, ['diff', '--no-color', '--cached', ...(scoped.length ? ['--', ...scoped] : [])])
    if (staged) parts.push(staged)
  } else if (target === 'files') {
    if (scoped.length === 0) throw new Error('codex_review with target "files" needs at least one path')
    const diff = await git(cwd, ['diff', '--no-color', 'HEAD', '--', ...scoped])
    if (diff) parts.push(diff)
    parts.push(await gatherFiles(cwd, scoped, Math.min(60_000, budget)))
  } else {
    const working = await git(cwd, ['diff', '--no-color', 'HEAD', ...(scoped.length ? ['--', ...scoped] : [])])
    if (working) parts.push(working)
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', ...(scoped.length ? ['--', ...scoped] : [])])
    const files = (untracked ?? '').split(/\r?\n/).filter((file) => file.trim() !== '').slice(0, 20)
    if (files.length > 0) {
      parts.push(`<untracked_files>\n${files.join('\n')}\n</untracked_files>`)
      parts.push(await gatherFiles(cwd, files, 60_000))
    }
  }
  const diff = parts.filter(Boolean).join('\n\n')
  if (diff === '') return '(no diff: the working tree is clean for this target)'
  return diff.length > budget ? `${diff.slice(0, budget)}\n…(diff truncated, ${diff.length - budget} chars omitted)` : diff
}
