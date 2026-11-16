// Contract tests for the bridge-owned execution model policy. No real DSH
// process, Codex app, or network is used: `ctx` is a fake host exposing the same
// public shapes the real sessionController/llm services do.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionPolicy } from '../lib/execution-policy.js'

const dir = await mkdtemp(join(tmpdir(), 'codex-bridge-policy-'))
const file = join(dir, 'execution-policy.json')
const catalogRaw = {
  default: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'medium' },
  routableProviders: ['deepseek', 'gpt'],
  groups: [
    {
      id: 'deepseek', name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4', name: 'DeepSeek V4',
          reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }], defaultEffort: 'medium' },
        },
        { id: 'deepseek-lite', name: 'DeepSeek Lite' },
      ],
    },
    {
      id: 'gpt', name: 'GPT',
      models: [{ id: 'gpt-6', name: 'GPT-6', reasoning: { efforts: [{ id: 'high', name: '高' }] } }],
    },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: 'upstream 401 token=SECRET-LEAK' }],
}
const calls = { resolveConfig: [], selects: [], saveSelection: 0, resolveAgent: [], approval: [], presets: [] }
const fakeAgent = { model: { select(selection) { calls.selects.push(selection) } }, session: { id: 'session-owned' } }
const ctx = {
  get(key) {
    if (key === 'sessionController') {
      return {
        async modelCatalog() { return structuredClone(catalogRaw) },
        async resolveAgent(sessionId) {
          calls.resolveAgent.push(sessionId)
          return { agent: fakeAgent }
        },
        // Present only so the test can prove the bridge never calls it.
        selectModel() { calls.saveSelection += 1 },
      }
    }
    if (key === 'llm') {
      return {
        async resolveCallConfig(selection) {
          calls.resolveConfig.push({ ...selection })
          const group = catalogRaw.groups.find((item) => item.id === selection.provider)
          const model = group?.models.find((item) => item.id === selection.model)
          if (!model) throw new Error('unknown model')
          if (selection.reasoningEffort !== undefined
            && !(model.reasoning?.efforts ?? []).some((effort) => effort.id === selection.reasoningEffort)) {
            throw new Error('unsupported effort')
          }
          return { maxTokens: 8192 }
        },
        // Present only so the test can prove it is never called.
        async theDefault() { calls.saveSelection += 1 },
      }
    }
    if (key === 'approval') {
      return { setPolicy(agent, policy) { calls.approval.push({ agent, policy }) } }
    }
    if (key === 'permissionPresets') {
      return {
        names: ['workspace-write', 'danger-full-access', 'auto'],
        set(session, name) { calls.presets.push({ session, name }) },
      }
    }
    return undefined
  },
}
const policy = createExecutionPolicy({ ctx, file })

// 1. Missing file: default follow-default + inherit, and no write is performed.
const initial = await policy.read()
assert.equal(initial.revision, 0)
assert.equal(initial.modelMode, 'follow-default')
assert.equal(initial.effortMode, 'inherit')
assert.equal(initial.permissionMode, 'inherit')

// 2. follow-default resolves the live catalog default and its effort.
let resolved = await policy.resolveExecution({})
assert.deepEqual(resolved.selection, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'medium' })
assert.equal(resolved.effortSource, 'dsh-default')
assert.equal(resolved.policyRevision, 0)
assert.equal(resolved.permissionMode, 'inherit')

// 3. The catalog projection must not leak raw adapter failure diagnostics.
const snapshot = await policy.snapshot()
assert.equal(snapshot.ok, true)
assert.equal(JSON.stringify(snapshot).includes('SECRET-LEAK'), false)
assert.equal(snapshot.catalog.failures[0].message, '该提供商的模型目录当前不可用。')

// 4. follow-default rejects a caller-supplied effort in inherit mode.
await assert.rejects(policy.resolveExecution({ reasoningEffort: 'high' }), /不允许调用者选择/)

// 5. Save a pinned non-default route with adaptive effort.
const pinned = await policy.save({
  expectedRevision: 0, modelMode: 'pinned', provider: 'deepseek', model: 'deepseek-v4',
  effortMode: 'adaptive', permissionMode: 'never-ask', allowedEfforts: ['low', 'high'], defaultEffort: 'low',
})
assert.equal(pinned.policy.revision, 1)
assert.deepEqual((await policy.read()).allowedEfforts, ['low', 'high'])

// 6. adaptive: omitted effort uses policy default; a caller choice inside the
//    allowed set is honored; outside the set is rejected without navigation.
assert.equal((await policy.resolveExecution({})).selection.reasoningEffort, 'low')
const chosen = await policy.resolveExecution({ reasoningEffort: 'high', reason: '跨模块重构' })
assert.equal(chosen.selection.reasoningEffort, 'high')
assert.equal(chosen.effortSource, 'caller')
assert.equal(chosen.reason, '跨模块重构')
await assert.rejects(policy.resolveExecution({ reasoningEffort: 'medium' }), /不在政策允许列表/)

// 7. Unknown fields, invalid combinations and a bad CAS revision are rejected.
await assert.rejects(policy.save({ expectedRevision: 1, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'never-ask', extra: true }), /未知字段/)
await assert.rejects(policy.save({ expectedRevision: 1, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'never-ask', provider: 'deepseek' }), /不能保存/)
await assert.rejects(policy.save({ expectedRevision: 0, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'never-ask' }), /其他操作修改/)
await assert.rejects(policy.save({ expectedRevision: 1, modelMode: 'pinned', provider: 'missing', model: 'x', effortMode: 'inherit', permissionMode: 'never-ask' }), /不在 DSH 可用模型目录/)
await assert.rejects(policy.save({ expectedRevision: 1, modelMode: 'pinned', provider: 'gpt', model: 'gpt-6', effortMode: 'fixed', fixedEffort: 'low', permissionMode: 'never-ask' }), /固定推理强度已不受当前模型支持/)
// Concurrent saves with the same revision: exactly one wins, the other conflicts.
const race = await Promise.allSettled([
  policy.save({ expectedRevision: 1, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'never-ask' }),
  policy.save({ expectedRevision: 1, modelMode: 'pinned', provider: 'deepseek', model: 'deepseek-lite', effortMode: 'inherit', permissionMode: 'never-ask' }),
])
assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1)
assert.equal(race.filter((item) => item.status === 'rejected' && /其他操作修改/.test(item.reason.message)).length, 1)

// 8. Corrupt policy fails closed instead of silently resetting to defaults.
const corruptDir = await mkdtemp(join(tmpdir(), 'codex-bridge-policy-corrupt-'))
const corruptFile = join(corruptDir, 'execution-policy.json')
await writeFile(corruptFile, '{not json', 'utf8')
const corrupt = createExecutionPolicy({ ctx, file: corruptFile })
await assert.rejects(corrupt.read(), /已损坏/)
await assert.rejects(corrupt.resolveExecution({}), /已损坏/)

// 9. apply() uses the owned session agent only: no global default save.
const current = await policy.read()
await policy.save({ expectedRevision: current.revision, modelMode: 'pinned', provider: 'deepseek', model: 'deepseek-v4', effortMode: 'fixed', fixedEffort: 'high', permissionMode: 'never-ask' })
resolved = await policy.resolveExecution({})
await policy.apply('session-owned', resolved.selection)
assert.deepEqual(calls.selects.at(-1), { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
assert.deepEqual(calls.resolveAgent.at(-1), 'session-owned')
assert.ok(calls.resolveConfig.length > 0)
assert.equal(calls.saveSelection, 0, 'bridge must never persist the deployment default model')
await assert.rejects(policy.apply('', resolved.selection), /缺少有效的执行会话 ID/)

// 10. Permission application: never-ask only changes approval, not the sandbox.
await policy.applyAccess('session-owned', 'never-ask')
assert.equal(calls.approval.at(-1).policy, 'never')
assert.equal(calls.presets.length, 0)
await policy.applyAccess('session-owned', 'inherit')
assert.equal(calls.approval.length, 1)
// Explicit full-access saves still need an acknowledgement; auto does not.
await assert.rejects(policy.save({
  expectedRevision: (await policy.read()).revision, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'full-access',
}), /完全权限需要显式确认/)
await policy.save({
  expectedRevision: (await policy.read()).revision, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'auto',
})
await policy.applyAccess('session-owned', 'auto')
assert.equal(calls.presets.at(-1).name, 'auto')
assert.equal(calls.approval.length, 1, 'auto keeps its own reviewer and does not force never')
const beforeFull = (await policy.read()).revision
await policy.save({
  expectedRevision: beforeFull, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'full-access', ackFullAccess: true,
})
assert.equal((await policy.read()).permissionMode, 'full-access')
await policy.applyAccess('session-owned', 'full-access')
assert.equal(calls.presets.at(-1).name, 'danger-full-access')
assert.equal(calls.approval.at(-1).policy, 'never')
await assert.rejects(policy.save({
  expectedRevision: (await policy.read()).revision, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'invalid',
}), /执行权限模式无效/)

// 11. Applied metadata stays in the bridge's own policy file, never global config.
const stored = JSON.parse(await readFile(file, 'utf8'))
assert.equal(stored.schemaVersion, 1)
assert.equal(typeof stored.revision, 'number')

await rm(dir, { recursive: true, force: true })
await rm(corruptDir, { recursive: true, force: true })
console.log('PASS: execution policy defaults, catalog projection, follow/pinned/adaptive/fixed, out-of-range rejection, CAS, corruption, owned-session apply, no global default write.')
