import { tuningConfig } from './lib/task-tuning.js'
import { taskBudgets } from './lib/task-budget.js'
import { createTaskStore } from './lib/task-store.js'
import { createTaskManager } from './lib/task-manager.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
/**
 * Codex advisor bridge — GPT decides at decision points, DeepSeek executes.
 *
 * Registers four global tools (`codex_plan`, `codex_decide`, `codex_review`,
 * `codex_ask`) plus one system-prompt policy section that tells the executor
 * when consulting the strategist is worth the round trip.
 *
 * A profile-installed plugin cannot resolve bare `@deepseek-ai/*` specifiers,
 * so this file imports nothing from the Harness: tools are registered with raw
 * JSON Schema and every registration is a plain disposer.
 *
 * @module @local/dsh-codex-bridge
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRunner, resolveCodexBin } from './lib/codex-v2.js'
import { gatherDiff, gatherFiles, repoFacts } from './lib/context.js'
import { createExecutor, DEFAULT_EXECUTE_PATH, DEFAULT_STATUS_PATH, isInternalSessionId, registerHttpRoute } from './lib/dsh-exec-v4.js'
import { createExecutionPolicy } from './lib/execution-policy.js'
import { createQuestionRelay } from './lib/question-relay.js'
import { appendLedger, ledgerPath, readSessions } from './lib/ledger.js'
import { createPageApi } from './lib/page-api-v5.js'
import { createCodexUi } from './lib/codex-ui-v1.js'
import { createCodexThreads } from './lib/codex-threads-v1.js'
import { mountBrowserRoute } from './lib/route-host-v2.js'
import { publishBridgeOrigin } from './lib/publish-origin.js'
import { buildPrompt, parseAnswer } from './lib/prompts.js'
import { SCHEMAS, assertResultShape, outputSchema } from './lib/schemas.js'

export const name = 'codex-bridge'
export const inject = ['tools', 'systemPrompt', 'workingDirectory', 'connection']

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.3.0'
  } catch {
    return '0.3.0'
  }
})()

const DEFAULTS = {
  codexPath: '',
  model: '',
  reasoningEffort: '',
  timeoutMs: 240_000,
  maxConcurrency: 2,
  sandbox: 'read-only',
  maxContextChars: 120_000,
  promptPolicy: true,
  logRuns: true,
  sessionMode: 'app-server',
  maxSessions: 3,
  sessionIdleMs: 900_000,
  reverseBridge: true,
  reversePreset: 'standard',
  page: true,
  verificationProfiles: {},
  tuningHistory: {},
  taskDefaultTimeoutMs: 1800000,
  taskMaxTimeoutMs: 7200000,
}

const POLICY = `## Codex advisor (codex_* tools)

You are the executor; a real Codex/GPT session (read-only) is the strategist, available through \`codex_plan\`, \`codex_decide\`, \`codex_review\` and \`codex_ask\`.

Consult it at decision points — not on every step:
- the request is ambiguous, or several designs are plausible and the trade-off matters;
- before an irreversible or high-blast-radius change: schema/data migration, bulk rewrite, deleting files, dependency or build-config changes, release/publish;
- after the same approach has failed twice, or a result contradicts expectations;
- the user asks you to think first or to pick an approach.

Do not consult for routine work: reading files, small edits, running tests, formatting, obvious fixes.

How to call:
- One precise sentence for \`task\`/\`question\`, plus \`context\` with facts the model cannot see (errors already hit, constraints, what you tried) and \`paths\` for files it must read.
- Prefer \`paths\` over pasting diffs; big pasted text only makes the consult slower.
- Pass \`effort: "low"\` for routine decisions; omit it (native high) only for architecture-level calls.
- codex_plan returns steps/decisions/acceptance; codex_decide returns one verdict; codex_review returns severity-ranked findings on the current diff; codex_ask is a free-form second opinion.

After a consult: follow the decision unless the repository contradicts it, and mention in your answer that the direction came from the Codex review. If a call fails (timeout, quota, not logged in), report it and continue with your own judgement rather than retrying blindly.`

const PATH_LIST = {
  type: 'array',
  items: { type: 'string' },
  description: 'Workspace-relative files (or directories) whose content the strategist should read.',
}
const TEXT_LIST = {
  type: 'array',
  items: { type: 'string' },
  description: 'Short bullet facts: constraints, do-not-touch areas, compatibility requirements, candidate options.',
}
const EFFORT = {
  type: 'string',
  enum: ['low', 'medium', 'high'],
  description: 'Optional reasoning effort for this call; omit for the plugin setting.',
}

const TASKS = {
  plan: {
    name: 'codex_plan',
    description:
      'Ask the Codex/GPT strategist for an implementation plan and the decisions behind it (read-only, one fresh Codex session, ~10-70s). Use before a non-trivial change when the approach is not obvious, when the request is ambiguous, or before a high-blast-radius rewrite. Returns steps with files/risks, decisions, acceptance checks and open questions.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'One precise sentence: what must be achieved.' },
        context: {
          type: 'string',
          description: 'Facts the strategist cannot see from the repo alone: errors already hit, what you tried, user constraints.',
        },
        paths: PATH_LIST,
        constraints: TEXT_LIST,
        effort: EFFORT,
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  decide: {
    name: 'codex_decide',
    description:
      'Ask the Codex/GPT strategist for one decisive verdict between alternatives, or before an irreversible action (migration, deletion, dependency/config change, release). Read-only, ~10-40s. Returns the decision, rationale, confidence, rejected alternatives and the next action.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The decision to make, phrased as one precise question.' },
        options: TEXT_LIST,
        context: {
          type: 'string',
          description: 'Facts the strategist cannot see from the repo alone: errors, constraints, what you tried.',
        },
        constraints: TEXT_LIST,
        paths: PATH_LIST,
        effort: EFFORT,
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  review: {
    name: 'codex_review',
    description:
      'Ask the Codex/GPT strategist to review the current uncommitted change (default), the staged diff, or specific files. Returns a verdict plus severity-ranked findings (blocker/major/minor/nit) with file:line and a fix. Read-only, ~10-40s. Use before reporting a non-trivial change as done.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['worktree', 'staged', 'files'],
          description: 'worktree = all uncommitted changes (default); staged = git diff --cached; files = the given paths.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to review when target is "files" (required then); optional scope filter otherwise.',
        },
        focus: {
          type: 'string',
          description: 'What to pay special attention to (e.g. SQL injection, migration safety, API compatibility).',
        },
        context: { type: 'string', description: 'Intent of the change and anything the strategist should know.' },
        diff: { type: 'string', description: 'Paste a diff directly instead of letting the bridge compute one. Prefer target/paths.' },
        effort: EFFORT,
      },
      required: [],
      additionalProperties: false,
    },
  },
  ask: {
    name: 'codex_ask',
    description:
      'Ask the Codex/GPT strategist one focused question when you need a second opinion without a full plan (e.g. "is this an API misuse?", "which failure is primary?"). Read-only, ~10-40s. Returns an answer, key points and a suggested next action.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One focused question.' },
        context: { type: 'string', description: 'Facts the strategist cannot see from the repo alone.' },
        paths: PATH_LIST,
        effort: EFFORT,
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
}

function text(content) {
  return [{ type: 'text', text: content }]
}

function bullets(items, empty = '') {
  if (!Array.isArray(items) || items.length === 0) return empty
  return items.map((item) => `- ${item}`).join('\n')
}

function footer(meta) {
  if (!meta) return ''
  const seconds = ((meta.elapsedMs ?? 0) / 1000).toFixed(1)
  const tokens = meta.inputTokens ? ` · ${Math.round(meta.inputTokens / 1000)}k in / ${meta.outputTokens ?? 0} out` : ''
  const mode = meta.mode === 'exec-fallback' ? ' · exec fallback' : meta.mode === 'app-server' ? ' · app-server' : ''
  return `\n\n_Codex ${meta.model} · ${seconds}s${tokens}${mode} · sandbox ${meta.sandbox}_`
}

const RENDERERS = {
  plan(value) {
    const parts = [`## Plan: ${value.task}`]
    if (value.assumptions?.length) parts.push(`**Assumptions**\n${bullets(value.assumptions)}`)
    parts.push(
      `**Steps**\n${(value.steps ?? [])
        .map(
          (step) =>
            `${step.id}. ${step.action}\n   - files: ${step.files?.length ? step.files.join(', ') : '—'}\n   - why: ${step.why} (risk: ${step.risk})`,
        )
        .join('\n')}`,
    )
    if (value.decisions?.length) {
      parts.push(
        `**Decisions**\n${value.decisions
          .map((decision) => `- ${decision.question} → **${decision.choice}** — ${decision.why}`)
          .join('\n')}`,
      )
    }
    if (value.acceptance?.length) parts.push(`**Acceptance**\n${bullets(value.acceptance)}`)
    if (value.risks?.length) parts.push(`**Risks**\n${bullets(value.risks)}`)
    parts.push(`**Open questions**\n${bullets(value.openQuestions, '- none')}`)
    return parts.join('\n\n')
  },
  decide(value) {
    const parts = [
      `**Decision:** ${value.decision}`,
      `**Why:** ${value.rationale}`,
      `**Confidence:** ${value.confidence}`,
      `**Next action:** ${value.nextAction}`,
    ]
    if (value.alternatives?.length) {
      parts.push(
        `**Rejected**\n${value.alternatives.map((alternative) => `- ${alternative.option} — ${alternative.whyNot}`).join('\n')}`,
      )
    }
    if (value.openQuestions?.length) parts.push(`**Open questions**\n${bullets(value.openQuestions)}`)
    return parts.join('\n\n')
  },
  review(value) {
    const parts = [`**Verdict:** ${value.verdict}`, `**Summary:** ${value.summary}`]
    if (value.findings?.length) {
      parts.push(
        `**Findings**\n${value.findings
          .map((finding) => `- [${finding.severity}] ${finding.file}:${finding.line} — ${finding.issue}\n  fix: ${finding.fix}`)
          .join('\n')}`,
      )
    } else {
      parts.push('**Findings**\n- none')
    }
    if (value.missingTests?.length) parts.push(`**Missing tests**\n${bullets(value.missingTests)}`)
    parts.push(`**Next action:** ${value.nextAction}`)
    return parts.join('\n\n')
  },
  ask(value) {
    const parts = [value.answer]
    if (value.keyPoints?.length) parts.push(`**Key points**\n${bullets(value.keyPoints)}`)
    parts.push(`**Next action:** ${value.nextAction}`)
    if (value.openQuestions?.length) parts.push(`**Open questions**\n${bullets(value.openQuestions)}`)
    return parts.join('\n\n')
  },
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const resolved = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined && raw[key] !== null) resolved[key] = raw[key]
  }
  resolved.timeoutMs = Number(resolved.timeoutMs)
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs < 5_000 || resolved.timeoutMs > 900_000) {
    throw new Error('codex-bridge: timeoutMs must be between 5000 and 900000')
  }
  Object.assign(resolved, taskBudgets(resolved))
  resolved.tuningHistory=tuningConfig(resolved.tuningHistory)
  resolved.maxConcurrency = Math.max(1, Number(resolved.maxConcurrency) || 2)
  resolved.maxContextChars = Math.max(10_000, Number(resolved.maxContextChars) || 120_000)
  resolved.maxSessions = Math.min(8, Math.max(1, Number(resolved.maxSessions) || 3))
  resolved.sessionIdleMs = Math.min(86_400_000, Math.max(60_000, Number(resolved.sessionIdleMs) || 900_000))
  if (resolved.sandbox !== 'read-only' && resolved.sandbox !== 'danger-full-access') {
    throw new Error('codex-bridge: sandbox must be "read-only" or "danger-full-access"')
  }
  if (resolved.sessionMode !== 'app-server' && resolved.sessionMode !== 'exec') {
    throw new Error('codex-bridge: sessionMode must be "app-server" or "exec"')
  }
  return resolved
}

function pickMeta(result) {
  const meta = {
    elapsedMs: result.meta.elapsedMs,
    model: result.meta.model,
    effort: result.meta.effort,
    sandbox: result.meta.sandbox,
    cwd: result.meta.cwd,
  }
  if (result.meta.usage) {
    meta.inputTokens = result.meta.usage.input_tokens
    meta.outputTokens = result.meta.usage.output_tokens
  }
  if (result.meta.threadId) meta.threadId = result.meta.threadId
  if (result.meta.mode) meta.mode = result.meta.mode
  return meta
}

/**
 * @param {object} ctx Cordis context
 * @param {object} [config] plugin config from cordis.patch.yml
 */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)
  const runner = createRunner({
    codexPath: resolved.codexPath,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    sandbox: resolved.sandbox,
    timeoutMs: resolved.timeoutMs,
    maxConcurrency: resolved.maxConcurrency,
    sessionMode: resolved.sessionMode,
    maxSessions: resolved.maxSessions,
    sessionIdleMs: resolved.sessionIdleMs,
    logRuns: resolved.logRuns !== false,
    logger: ctx.logger,
  })
  const limits = {
    maxContextChars: resolved.maxContextChars,
    maxDiffChars: Math.min(200_000, Math.max(20_000, resolved.maxContextChars * 1.5)),
  }

  // Cordis effect cleanup: the effect body runs now and returns the disposer
  // that the plugin's fiber calls on unload/hot-reload. `ctx.on('dispose')` alone
  // did not run on a bundle toggle here, which leaked the app-server process.
  const track = (disposer) => {
    const cleanup = () => {
      try {
        const pending = disposer()
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      } catch {
        /* disposal is best effort */
      }
    }
    if (typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => cleanup)
        return
      } catch {
        /* fall through to ctx.on */
      }
    }
    if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)
  }

  // There is no hard-coded provider/model here: the policy reuses the live DSH
  // model catalog and stores only the user's choices in the bridge's own file.
  const executionPolicy = createExecutionPolicy({ ctx, logger: ctx.logger })
  const questionRelay = createQuestionRelay({ ctx, logger: ctx.logger, isBridgeSession: (sessionId) => isInternalSessionId(sessionId) })
  track(() => questionRelay.dispose())

  // Reverse bridge: expose a token-protected HTTP entry so Codex (as the
  // driver) can ask this DSH process to execute a task. The executor is built on
  // first use because the session controller may mount after this plugin.
  let executor = null
  let taskManager = null
  const getExecutor = () => {
    if (executor === null) {
      executor = createExecutor({
        ctx,
        config: { preset: resolved.reversePreset },
        logger: ctx.logger,
        policy: executionPolicy,
        relay: questionRelay,
      })
    }
    return executor
  }
  const getTaskManager = () => {
    if (!taskManager) taskManager = createTaskManager({
      store:createTaskStore(join(homedir(),'.dsh','codex-bridge','tasks-v2')),
      executor:getExecutor(), profiles:resolved.verificationProfiles,
      taskDefaultTimeoutMs: resolved.taskDefaultTimeoutMs, taskMaxTimeoutMs: resolved.taskMaxTimeoutMs,
      executionPolicy, tuningHistory:resolved.tuningHistory,
      verificationService:(()=>{try{return typeof ctx.get==='function' ? ctx.get('bridgeVerification') : ctx.bridgeVerification}catch{return null}})(),
      reviewer: async (task,signal) => {
        const result=await runner.consult({prompt:buildPrompt('review',{context:JSON.stringify({goal:task.goal,acceptance:task.acceptance,before:task.run.before,verification:task.run.verification}).slice(0,120000),diff:task.run.after?.diff ?? ''},{cwd:task.cwd,files:'',diff:task.run.after?.diff ?? ''}),schema:SCHEMAS.review,cwd:task.cwd,signal,kind:'review',sessionKey:'task-review|'+task.taskId})
        const parsed=parseAnswer(result.answer)
        if(!parsed.ok) throw new Error('invalid review')
        return assertResultShape('review',parsed.value)
      },
    })
    return taskManager
  }
  if(resolved.page!==false) mountBrowserRoute(ctx,'/api/dsh-codex-bridge.v2.tasks.review',['POST'],async request=>{
    try {
      if(request.method!=='POST')return new Response('',{status:405})
      const origin=request.headers.get('origin')
      if(origin && origin!==new URL(request.url).origin)return new Response('',{status:403})
      const raw=await request.text();if(raw.length>20000)return new Response('',{status:413})
      return new Response(JSON.stringify({ok:true,value:getTaskManager().review(JSON.parse(raw))}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
    }catch(error){return new Response(JSON.stringify({ok:false,error:error.code??'review-failed'}),{status:error.status??500,headers:{'content-type':'application/json'}})}
  })
  if (resolved.reverseBridge !== false) {
    try {
      track(
        registerHttpRoute({
          ctx,
          taskManager:getTaskManager,
          executor: {
            version: PLUGIN_VERSION,
            sessionCount: () => readSessions({ limit: 10000 }).length,
            execute: (input) => getTaskManager().legacyExecute(input),
            answer: (input) => getTaskManager().legacyAnswer(input),
            isInternalSession: (sessionId) => isInternalSessionId(sessionId),
            // Compact, secret-free view for `dsh_status`: the exact choices the
            // current policy permits for the next execution.
            describePolicy: async () => {
              const state = await executionPolicy.snapshot()
              const policy = state.policy
              const route = policy.modelMode === 'follow-default'
                ? state.catalog.default
                : policy.modelMode==='pool' ? policy.models[0] : { provider: policy.provider, model: policy.model }
              const entry = state.catalog.groups
                .find((group) => group.id === route.provider)?.models
                .find((model) => model.id === route.model)
              return {
                revision: policy.revision,
                modelMode: policy.modelMode,
                effortMode: policy.effortMode,
                permissionMode: policy.permissionMode,
                permissionPresets: executionPolicy.permissionCatalog(),
                model: `${route.provider}/${route.model}`,
                reasoningEfforts: (entry?.reasoning?.efforts ?? []).map((effort) => effort.id),
                modelDefaultEffort: entry?.reasoning?.defaultEffort ?? null,
                fixedEffort: policy.fixedEffort ?? null,
                allowedEfforts: policy.allowedEfforts ?? null,
                policyDefaultEffort: policy.defaultEffort ?? null,
                authorizedModels: policy.modelMode==='pool'?policy.models.map(m=>({...m,supportedEfforts:(state.catalog.groups.find(g=>g.id===m.provider)?.models.find(v=>v.id===m.model)?.reasoning?.efforts??[]).map(e=>e.id)})):null,
              }
            },
          },
          logger: ctx.logger,
        }),
      )
      publishBridgeOrigin(ctx)
    } catch (error) {
      ctx.logger?.warn?.(`codex-bridge: reverse bridge route registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Browser-authenticated policy editor API. Same-origin only; the host's
  // connection registry already enforces browser authentication.
  if (resolved.page !== false) {
    const policyJson = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    const policyFailure = (error) => {
      const status = Number(error?.statusCode ?? error?.status)
      const usable = Number.isInteger(status) && status >= 400 && status < 600
      return policyJson(
        {
          ok: false,
          error: typeof error?.code === 'string' ? error.code : 'execution-policy-invalid',
          message: usable && typeof error?.message === 'string' ? error.message : '执行政策操作失败。',
        },
        usable ? status : 500,
      )
    }
    const policyHandler = async (request) => {
      const method = String(request?.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        try {
          return policyJson(await executionPolicy.snapshot())
        } catch (error) {
          return policyFailure(error)
        }
      }
      if (method !== 'POST') return policyJson({ ok: false, error: 'method-not-allowed' }, 405)
      let body
      try {
        body = await request.json()
      } catch {
        return policyJson({ ok: false, error: 'invalid-json', message: '请求体必须是 JSON 对象。' }, 400)
      }
      try {
        const saved = await executionPolicy.save(body)
        const state = await executionPolicy.snapshot()
        return policyJson({ ok: true, policy: saved.policy, catalog: state.catalog, permissions: state.permissions })
      } catch (error) {
        return policyFailure(error)
      }
    }
    try {
      mountBrowserRoute(ctx, '/api/dsh-codex-bridge.execution-policy', ['GET', 'POST'], policyHandler)
    } catch (error) {
      ctx.logger?.warn?.(`codex-bridge: execution policy route failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  track(() => {
    void runner.dispose()
    if(taskManager) void taskManager.dispose().catch(error=>ctx.logger?.warn?.(error.message))
    else void executor?.dispose?.()
  })

  // The bridge page is a normal central panel (sidebar icon + `main` slot); its
  // data route is browser-authenticated, unlike the external bearer route above.
  if (resolved.page !== false) {
    try {
      const pageApi = createPageApi({
        ctx,
        runner,
        logger: ctx.logger,
        config: {
          ...resolved,
          pluginVersion: PLUGIN_VERSION,
          executePath: DEFAULT_EXECUTE_PATH,
          statusPath: DEFAULT_STATUS_PATH,
          resolveBin: () => resolveCodexBin(resolved.codexPath),
        },
      })
      // Register from the reloaded entry, not from a cached module body: Cordis
      // tears these routes down when the plugin unloads.
      mountBrowserRoute(ctx, pageApi.paths.page, ['GET', 'POST'], pageApi.handle)
      mountBrowserRoute(ctx, pageApi.paths.codex, ['GET'], pageApi.codex)
    } catch (error) {
      ctx.logger?.warn?.(`codex-bridge: page API registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Codex mirror page: projects → threads → transcript → continue the same thread.
  let codexThreads = null
  const getCodexThreads = () => {
    if (codexThreads === null) {
      codexThreads = createCodexThreads({
        bin: resolveCodexBin(resolved.codexPath),
        cwd: process.cwd(),
        logger: ctx.logger,
      })
    }
    return codexThreads
  }
  track(() => {
    void codexThreads?.dispose?.()
  })
  if (resolved.page !== false) {
    try {
      const codexUi = createCodexUi({
        logger: ctx.logger,
        bin: resolveCodexBin(resolved.codexPath),
        client: async () => getCodexThreads(),
      })
      mountBrowserRoute(ctx, codexUi.paths.projects, ['GET'], codexUi.projects)
      mountBrowserRoute(ctx, codexUi.paths.thread, ['GET'], codexUi.thread)
      mountBrowserRoute(ctx, codexUi.paths.send, ['POST'], codexUi.send)
    } catch (error) {
      ctx.logger?.warn?.(`codex-bridge: codex page registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function cwdOf(exec) {
    try {
      if (exec.agent) return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      /* fall through to process cwd */
    }
    return process.cwd()
  }

  async function run(kind, args, exec) {
    const cwd = await cwdOf(exec)
    const facts = await repoFacts(cwd).catch(() => null)
    const files = args.paths?.length ? await gatherFiles(cwd, args.paths, limits.maxContextChars) : ''
    let diff = ''
    if (kind === 'review') {
      const pasted = typeof args.diff === 'string' ? args.diff.trim() : ''
      diff = pasted !== '' ? pasted : await gatherDiff(cwd, args.target ?? 'worktree', args.paths ?? [], limits.maxDiffChars)
      if (diff.startsWith('(no diff')) {
        throw new Error(
          'codex_review found no changes to review. The working tree is clean for this target; pass target "staged"/"files" or a `diff`.',
        )
      }
    }
    const prompt = buildPrompt(kind, args, {
      cwd,
      branch: facts?.branch ?? undefined,
      date: new Date().toISOString().slice(0, 10),
      mode: resolved.sandbox === 'danger-full-access' ? 'full repository access' : 'text only, no shell',
      facts,
      files,
      diff,
    })
    const result = await runner.consult({
      prompt,
      schema: SCHEMAS[kind],
      cwd,
      effort: args.effort,
      signal: exec.signal,
      kind,
      sessionKey: exec.agent ? String(exec.agent.id) : undefined,
    })
    const parsed = parseAnswer(result.answer)
    if (parsed.ok === false) {
      throw new Error(`codex answered with non-JSON (${parsed.reason}); first 400 chars: ${result.answer.slice(0, 400)}`)
    }
    const value = assertResultShape(kind, parsed.value)
    return { ...value, _meta: pickMeta(result) }
  }

  for (const [kind, task] of Object.entries(TASKS)) {
    const definition = {
      name: task.name,
      description: task.description,
      parameters: task.parameters,
      output: {
        schema: outputSchema(kind),
        render: (_args, value) => text(`${RENDERERS[kind](value)}${footer(value?._meta)}`),
      },
      timeoutMs: resolved.timeoutMs + 30_000,
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const agentSessionId = exec.agent ? String(exec.agent.id) : ''
        if (agentSessionId !== '' && isInternalSessionId(agentSessionId)) {
          throw new Error(
            `${task.name}: this session was started by the reverse bridge (Codex → DSH). Consulting Codex again would recurse; do the work yourself and report the result.`,
          )
        }
        const required = kind === 'plan' ? 'task' : kind === 'answer' ? 'question' : kind === 'review' ? null : 'question'
        if (required && (typeof input[required] !== 'string' || input[required].trim() === '')) {
          throw new Error(`${task.name}: "${required}" is required and must be a non-empty string`)
        }
        if (kind === 'review' && (input.target ?? 'worktree') === 'files' && !(input.paths?.length > 0)) {
          throw new Error('codex_review: target "files" needs at least one path')
        }
        if (input.effort !== undefined && !['low', 'medium', 'high'].includes(input.effort)) {
          throw new Error('effort must be one of: low, medium, high')
        }
        return await run(kind, input, exec)
      },
    }
    track(ctx.tools.register(definition))
  }

  // Diagnostics: tells us which host modules are actually live after a hot
  // reload, and whether the Codex-session ledger is writable.
  const diagTool = {
    name: 'codex_bridge_diag',
    description:
      'Internal read-only diagnostics for the Codex bridge plugin: live module version, ledger path/writability, reverse-bridge executor state and recent session ids. Use only when debugging the bridge itself.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { json: { type: 'string' } },
        required: ['json'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.json ?? '') }],
    },
    async execute() {
      const path = ledgerPath()
      // Diagnostics must remain read-only; do not pollute the task ledger with
      // synthetic probe sessions or claim a swallowed append error is writable.
      const probe = { mode: 'read-only', sessions: readSessions({ limit: 500 }).length }
      let size = 0
      try {
        size = existsSync(path) ? statSync(path).size : 0
      } catch {
        /* ignore */
      }
      return {
        json: JSON.stringify(
          {
            pluginVersion: PLUGIN_VERSION,
            node: process.version,
            pid: process.pid,
            ledger: { path, exists: existsSync(path), size, probe },
            executorCreated: executor !== null,
            runner: typeof runner.stats === 'function' ? runner.stats() : null,
            routes: { execute: DEFAULT_EXECUTE_PATH, status: DEFAULT_STATUS_PATH },
            sessionMode: resolved.sessionMode,
            reverseBridge: resolved.reverseBridge,
          },
          null,
          2,
        ),
      }
    },
  }
  track(ctx.tools.register(diagTool))

  if (resolved.promptPolicy !== false) {
    track(
      ctx.systemPrompt.section({
        name: 'codex-bridge/policy',
        order: 1000,
        text: POLICY,
      }),
    )
  }
}
