import { taskError } from './task-store.js'
import { qualityRequirements } from './task-quality.js'

export const AWAIT_DEFAULT_MS = 600000
export const AWAIT_MAX_MS = 600000
export const EXECUTION_MODES = ['direct', 'planned', 'reviewed']

export function executionMode(raw) {
  const mode = raw.executionMode ?? (raw.review === true ? 'reviewed' : raw.plan?.trim() ? 'planned' : 'direct')
  if (!EXECUTION_MODES.includes(mode)) throw taskError('executionMode 必须是 direct/planned/reviewed。')
  if (raw.executionMode !== undefined && raw.review !== undefined && raw.review !== (mode === 'reviewed')) throw taskError('executionMode 与 review 冲突。')
  if (mode === 'direct' && raw.plan?.trim()) throw taskError('直接执行不接收计划；请使用 planned 或 reviewed。')
  if (mode === 'planned' && !raw.plan?.trim()) throw taskError('planned 模式需要调用方提供一次性计划，不会另行调用模型生成。')
  return mode
}

export function executionPrompt(task) {
  const parts = [task.goal]
  const quality = qualityRequirements(task.qualityProfile)
  if (quality) parts.push('交付质量要求：\n' + quality)
  if (task.plan?.trim()) parts.push('执行计划（调用方已提供，按当前文件状态核对后执行）：\n' + task.plan.trim())
  if (task.acceptance?.length) parts.push('验收要求：\n' + task.acceptance.map(x => '- ' + x).join('\n'))
  const text = parts.join('\n\n')
  if (text.length > 20000) throw taskError('目标、计划与验收条件合计超过 20000 字符，请精简。')
  return text
}

// MCP gets a bounded delivery view; full browser/audit records remain unchanged.
export function taskSummary(task) {
  const run = task.run ?? {}, result = run.result
  const summary = {
    taskId: task.taskId, activeRunId: task.activeRunId, sessionId: run.sessionId ?? null, cwd:task.cwd,
    state: task.state, revision: task.revision,
    executionMode: task.executionMode ?? (task.review ? 'reviewed' : task.plan ? 'planned' : 'direct'),
    executionCompleted: result?.stopReason === 'completed',
    deliveryRequirements: { qualityProfile: task.qualityProfile ?? null, acceptanceCount: task.acceptance?.length ?? 0, planProvided: Boolean(task.plan?.trim()) },
    outcome: run.outcome ?? result?.stopReason ?? null,
    verification: run.verification?.status ?? 'unknown', review: run.review?.verdict ?? null,
    acceptedAt: task.createdAt ?? null, runStartedAt: run.startedAt ?? null, finishedAt: run.endedAt ?? null,
    timing: run.timing ?? null, usage: run.usage ?? { status: 'unknown' },
    codexReviewUsage: run.review?.usage ?? null,
    coordination: run.coordination ?? null,
    ...(task.parentTaskId?{parentTaskId:task.parentTaskId,nodeId:task.workflowNodeId}:{}),
  }
  if(task.kind==='workflow') {
    summary.kind='workflow'
    summary.workflow={phase:task.workflow.phase,parallelism:task.workflow.parallelism,repairsUsed:task.workflow.repairsUsed,maxRepairs:task.workflow.maxRepairs,deadline:run.deadline,maxModelCalls:task.workflow.maxModelCalls,maxObservedTokens:task.workflow.maxObservedTokens,budgetObserved:run.budgetObserved??null,nodes:task.workflow.nodes.map(n=>({id:n.id,state:n.state,childState:n.childState,dependsOn:n.dependsOn,childTaskId:n.childTaskId,childRunId:n.childRunId,sessionId:n.sessionId,error:n.error,verification:n.delivery?.verification,blockedBy:n.dependsOn.filter(id=>task.workflow.nodes.find(p=>p.id===id)?.state!=='COMPLETED')}))}
    if(run.issue)summary.issue=run.issue
    if(run.integration)summary.integratedFiles=run.integration.files
    if(task.state==='WORKFLOW_PAUSED')summary.nextAction='repair-node-or-reconcile'
  }
  if (result?.text) { summary.text = result.text.slice(0, 4000); summary.textTruncated = result.text.length > 4000 }
  if (run.question) summary.question = run.question
  if (run.verification?.artifacts?.length) {
    summary.artifacts = run.verification.artifacts.slice(0,50).map(({path,bytes,hash})=>({path,bytes,hash}))
    summary.artifactsTruncated = run.verification.artifacts.length > 50
  }
  if (run.error) summary.error = run.error
  if (run.observationError) summary.observationError = run.observationError
  if (task.state === 'RECONCILING') summary.nextAction = 'reconcile'
  else if (task.state === 'WAITING_APPROVAL') summary.nextAction = 'open-native-session'
  else if (task.state === 'WAITING_INPUT') summary.nextAction = 'answer'
  else if (task.state === 'REVIEW_REQUIRED') summary.nextAction = 'deliver-with-verification-status'
  if (run.tuning) summary.selection = { ...run.tuning.resolved?.execution?.selection, evidence: run.tuning.observed?.status ?? 'unknown', matches: run.tuning.observed?.matches ?? null }
  return summary
}

export function deliveryView(action, value, detail = 'summary') {
  if (detail === 'full') return value
  if (['wait', 'await'].includes(action) && value?.task) return { reason: value.reason, task: taskSummary(value.task) }
  if (action === 'list' && Array.isArray(value?.tasks)) return { ...value, tasks: value.tasks.map(taskSummary) }
  if (value?.taskId && value?.run) return taskSummary(value)
  return value
}
