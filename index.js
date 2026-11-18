import { tuningConfig } from './lib/task-tuning.js'
import { taskBudgets } from './lib/task-budget.js'
import { createTaskBrowserApi, TASK_BROWSER_PATH } from './lib/task-browser-api.js'
import { collectTaskDiagnostics } from './lib/task-diagnostics.js'
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
import { gatherDiff, gatherFiles } from './lib/context.js'
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
import { createAdvisorBudget, MANUAL_ADVISOR_MARKER, nativeAdvisorScope } from './lib/advisor-budget.js'

export const name = 'codex-bridge'
export const inject = ['tools', 'systemPrompt', 'workingDirectory', 'connection', 'agents']

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
  advisorMode: 'auto',
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

DSH owns implementation and verification. Handle routine work locally. Resolve business preferences with the user.
Spend one automatic expert consultation only when the answer can change your next action:
- Set reason=planning with codex_plan before a complex task when dependencies or compatibility affect the sequence.
- Set reason=decision with codex_decide or codex_ask for a material choice between approaches.
- Set reason=blocked with codex_decide or codex_ask after repeated failure or contradictory evidence.
Send a single question, the relevant facts, and only the necessary file paths. Use the returned decision or plan, verify it in the repository, and report what you adopted and what happened. If consultation fails, continue where evidence allows or report the blocker. Keep normal delivery in DSH.
When the latest human message begins with an @codex line, the user has asked for one explicit consultation. Use codex_review only for a user-requested review. For another explicit consult the user can send a new @codex message.`

const ADVISOR_REASON = {
  type: 'string', enum: ['planning', 'decision', 'blocked'],
  description: 'For an automatic consultation, indicate whether the expert will help with planning, a material decision, or a blocker.',
}

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
      'Consult Codex once before a complex task when sequencing, dependencies or compatibility matter. Returns a plan, decisions and acceptance checks for DSH to implement.',
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
        reason: ADVISOR_REASON,
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  decide: {
    name: 'codex_decide',
    description:
      'Consult Codex about one material decision or blocker. Supply the options and the evidence already collected. DSH owns implementation and approvals.',
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
        reason: ADVISOR_REASON,
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  review: {
    name: 'codex_review',
    description:
      'Ask Codex to review changes when the user requests a review with an @codex line. Returns a verdict, concrete findings and fixes. Prefer a focused diff or specific files.',
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
      'Consult Codex about one focused uncertainty or blocker. Send the evidence and what DSH has already tried. Returns a suggested next action.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One focused question.' },
        context: { type: 'string', description: 'Facts the strategist cannot see from the repo alone.' },
        paths: PATH_LIST,
        effort: EFFORT,
        reason: ADVISOR_REASON,
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
  const tokens = ` · 输入 ${meta.inputTokens ?? '未知'} / 缓存命中 ${meta.cachedInputTokens ?? '未知'} / 输出 ${meta.outputTokens ?? '未知'} token`
  const mode = meta.mode === 'exec-fallback' ? ' · exec fallback' : meta.mode === 'app-server' ? ' · app-server' : ''
  const source = meta.reused ? '读取已有建议' : meta.source === 'manual' ? '用户发起咨询' : '自动咨询'
  return `\n\n_Codex ${meta.model} · ${source} · ${seconds}s${tokens}${mode}_`
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
  if (!['auto', 'manual'].includes(resolved.advisorMode)) throw new Error('codex-bridge: advisorMode must be "auto" or "manual"')
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
    for (const [key, field] of Object.entries({inputTokens:'input_tokens',cachedInputTokens:'cached_input_tokens',outputTokens:'output_tokens',reasoningTokens:'reasoning_output_tokens'})) {
      const count = result.meta.usage[field]
      if (Number.isSafeInteger(count) && count >= 0) meta[key] = count
    }
  }
  if (result.meta.threadId) meta.threadId = result.meta.threadId
  if (result.meta.mode) meta.mode = result.meta.mode
  return meta
}

function focusedAdvisorInput(input, limits) {
  const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : undefined
  const list = (value, max, width) => Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, max).map(item => item.trim().slice(0, width))
    : undefined
  return {
    task: bounded(input.task, 2000), question: bounded(input.question, 2000),
    context: bounded(input.context, 4000), focus: bounded(input.focus, 2000),
    paths: list(input.paths, 6, 500), options: list(input.options, 8, 300), constraints: list(input.constraints, 8, 300),
    target: input.target, diff: bounded(input.diff, limits.maxDiffChars), effort: input.effort,
  }
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
  const reserveAdvisor = createAdvisorBudget(join(homedir(), '.dsh', 'codex-bridge', 'advisor-v1'), { logRuns: resolved.logRuns !== false })
  const agentRegistry = ctx.agents ?? ctx.get?.('agents')
  const canIdentifyTurn = typeof agentRegistry?.turnBoundaryOf === 'function' && typeof agentRegistry?.currentInitiator === 'function'
  let previousBridgeSessions
  function isBridgeAgent(id) {
    if (id == null) return false
    if (isInternalSessionId(id)) return true
    previousBridgeSessions ??= new Set(readSessions({ limit: 10000 }).map(entry => entry.sessionId))
    return previousBridgeSessions.has(id)
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
      maxConcurrency:resolved.maxConcurrency,
      taskDefaultTimeoutMs: resolved.taskDefaultTimeoutMs, taskMaxTimeoutMs: resolved.taskMaxTimeoutMs,
      executionPolicy, tuningHistory:resolved.tuningHistory,
      verificationService:(()=>{try{return typeof ctx.get==='function' ? ctx.get('bridgeVerification') : ctx.bridgeVerification}catch{return null}})(),
      reviewer: async (task,signal) => {
        const result=await runner.consult({prompt:buildPrompt('review',{context:JSON.stringify({goal:task.goal,acceptance:task.acceptance,before:task.run.before,verification:task.run.verification}).slice(0,120000),diff:task.run.after?.diff ?? ''},{cwd:task.cwd,files:'',diff:task.run.after?.diff ?? ''}),schema:SCHEMAS.review,cwd:task.cwd,signal,kind:'review',sessionKey:'task-review|'+task.taskId,noRetry:true})
        const parsed=parseAnswer(result.answer)
        if(!parsed.ok) throw new Error('invalid review')
        return { ...assertResultShape('review',parsed.value), usage:result.meta?.usage ?? null, elapsedMs:result.meta?.elapsedMs ?? null }
      },
    })
    return taskManager
  }
  if (resolved.page !== false) {
    const handler = createTaskBrowserApi({
      manager:getTaskManager,
      diagnostics:() => collectTaskDiagnostics({directory:join(homedir(),'.dsh','codex-bridge','tasks-v2'),ctx,version:PLUGIN_VERSION,codexBin:resolveCodexBin(resolved.codexPath)}),
      legacyRecords:() => readSessions({limit:10000,includeArchive:true}),
    })
    mountBrowserRoute(ctx,TASK_BROWSER_PATH,['POST'],handler)
    // Preserve the Beta 1 human review route, with the same authenticated implementation.
    mountBrowserRoute(ctx,'/api/dsh-codex-bridge.v2.tasks.review',['POST'],async request => { try { const input=await request.json(); return handler(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...input,action:'review'})})) } catch {return new Response('',{status:400})} })
  }
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

  async function run(kind, args, exec, scope, admission, reason) {
    const automatic = admission.source === 'automatic'
    const timeoutMs = Math.floor(automatic ? Math.min(90_000, resolved.timeoutMs) : resolved.timeoutMs)
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = exec.signal ? AbortSignal.any([exec.signal, deadline]) : deadline
    const cwd = await cwdOf({agent:exec.agent,signal})
    signal.throwIfAborted()
    const files = kind !== 'review' && args.paths?.length
      ? await gatherFiles(cwd, args.paths, Math.min(limits.maxContextChars, 12_000))
      : ''
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
      date: new Date().toISOString().slice(0, 10),
      mode: resolved.sandbox === 'danger-full-access' ? 'full repository access' : 'text only, no shell',
      files,
      diff,
    })
    signal.throwIfAborted()
    const result = await runner.consult({
      prompt,
      schema: SCHEMAS[kind],
      cwd,
      effort: args.effort ?? (resolved.reasoningEffort || 'low'),
      timeoutMs,
      signal,
      kind,
      sessionKey: 'advisor|' + scope.turnKey,
      noRetry: true,
    })
    const parsed = parseAnswer(result.answer)
    if (parsed.ok === false) {
      throw new Error(`codex answered with non-JSON (${parsed.reason}); first 400 chars: ${result.answer.slice(0, 400)}`)
    }
    const value = assertResultShape(kind, parsed.value)
    const meta = pickMeta(result)
    return { ...value, _meta: { ...meta, consultationId: admission.consultationId, source: admission.source, reason, usageKnown: meta.inputTokens !== undefined && meta.outputTokens !== undefined } }
  }

  for (const [kind, task] of Object.entries(TASKS)) {
    const definition = {
      name: task.name,
      description: task.description,
      parameters: task.parameters,
      output: {
        schema: outputSchema(kind),
        render: (_args, value) => text(`${RENDERERS[kind](value)}${footer(value?._meta)}`),
        presentationMeta: (_args, value) => value._meta,
      },
      timeoutMs: resolved.timeoutMs + 30_000,
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        if (isBridgeAgent(exec.agent?.id)) {
          throw new Error('此任务由 Codex 发起。请在原 DSH 任务中继续实现或提交待答问题。')
        }
        const focused = focusedAdvisorInput(input, limits)
        const question = kind === 'plan' ? focused.task : kind === 'review' ? (focused.focus || '核对当前修改') : focused.question
        if (!question) throw new Error('请提供一条明确的咨询问题或目标。')
        if (kind === 'review' && focused.target === 'files' && !focused.paths?.length) {
          throw new Error('codex_review: target "files" needs at least one path')
        }
        if (focused.effort !== undefined && !['low', 'medium', 'high'].includes(focused.effort)) {
          throw new Error('effort must be one of: low, medium, high')
        }
        const scope = nativeAdvisorScope(agentRegistry, exec.agent)
        if (!scope) throw new Error('无法确认当前 DSH 的用户回合。可以在 Codex 工作台打开「专家咨询」主动提问。')
        const manual = scope.manualSeq !== null
        if (!manual) {
          if (resolved.advisorMode === 'manual' || kind === 'review') {
            throw new Error(`需要用户明确发起。请让用户在新消息的第一行写 ${MANUAL_ADVISOR_MARKER}，随后写咨询问题。`)
          }
          const reasons = kind === 'plan' ? ['planning'] : ['decision', 'blocked']
          if (!reasons.includes(input.reason) || !(focused.context || focused.paths?.length)) {
            throw new Error('自动咨询需要触发原因和相关事实或文件。简单实现可由 DSH 自主完成。')
          }
        }
        exec.signal?.throwIfAborted()
        const reason = manual ? 'user-requested' : input.reason
        const admission = reserveAdvisor(scope, { kind, reason, question, input: focused })
        if (admission.replay) return { ...admission.replay, _meta: { ...admission.replay._meta, reused: true } }
        let value
        try {
          value = await run(kind, focused, exec, scope, admission, reason)
        } catch (cause) {
          const code = typeof cause?.code === 'string' ? cause.code : 'consult-failed'
          try { admission.finish('failed', { code }) } catch (error) { ctx.logger?.warn?.('codex-bridge: could not save failed consultation', error) }
          throw new Error(`专家咨询未返回可用建议（${code}）。继续有证据支持的步骤，缺少实现决定时向用户说明阻塞。`, { cause })
        }
        try {
          admission.finish('completed', value)
        } catch (error) {
          ctx.logger?.warn?.('codex-bridge: could not save consultation result', error)
        }
        return value
      },
    }
    track(ctx.tools.register(definition, { when: ({ agent }) => canIdentifyTurn && !isBridgeAgent(agent?.id) }))
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
        text: ({ agent }) => !canIdentifyTurn || isBridgeAgent(agent?.id) ? '' : resolved.advisorMode === 'auto' ? POLICY
          : 'DSH owns implementation. Use the Codex advisor only when the latest human message begins with an @codex line.',
      }),
    )
  }
}
