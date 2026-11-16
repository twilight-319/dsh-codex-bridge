// Guarded update handshake; does NOT disable plugins or cancel tasks.
// begin leaves admission closed even when busy. Use end TOKEN to abandon maintenance.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveEndpoint } from '../lib/endpoint-discovery.js'
const action = process.argv[2] ?? 'status'
if (!['begin','status','end'].includes(action)) throw new Error('Usage: node tools/maintenance.mjs begin|status|end [TOKEN]')
const token = fs.readFileSync(path.join(os.homedir(), '.dsh/codex-bridge/http-token'), 'utf8').trim()
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
try {
  const response = await fetch(resolveEndpoint().origin + '/api/dsh-codex-bridge.v2.tasks', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type':'application/json' }, body: JSON.stringify({ action: 'maintenance_' + action, ...(action === 'end' ? { token: process.argv[3] } : {}) }), signal: controller.signal })
  const data = await response.json()
  console.log(JSON.stringify(data, null, 2))
  if (!response.ok || data.ok !== true || (action === 'begin' && !data.value?.ready)) process.exitCode = 2
} finally { clearTimeout(timer) }
