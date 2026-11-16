import { projectKey } from './project-key.js'
import { resolvePolicy } from './execution-policy.js'
import { digest, taskError } from './task-store.js'
const VERSION = 'tuning-v1'
export function tuningConfig(raw = {}) {
  const c = { windowDays:90, maxFamilies:100, minSamples:20, quantile:0.9, margin:0.2, maxCensoredRatio:0.1, ...raw }
  if (Object.keys(c).some(k=>!['windowDays','maxFamilies','minSamples','quantile','margin','maxCensoredRatio'].includes(k)) || !Number.isInteger(c.windowDays)||c.windowDays<1||c.windowDays>365||!Number.isInteger(c.maxFamilies)||c.maxFamilies<1||c.maxFamilies>1000||!Number.isInteger(c.minSamples)||c.minSamples<2||c.minSamples>c.maxFamilies||!Number.isFinite(c.quantile)||c.quantile<0.5||c.quantile>0.99||!Number.isFinite(c.margin)||c.margin<0||c.margin>3||!Number.isFinite(c.maxCensoredRatio)||c.maxCensoredRatio<0||c.maxCensoredRatio>0.5) throw taskError('历史调优配置无效。')
  return c
}
export function normalizeTuning(raw) {
  const t = raw.tuning ?? {}
  if (!t || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some(k=>!['modelMode','effortMode','timeoutMode','taskClass','objective'].includes(k))) throw taskError('tuning包含未知字段。')
  if ((raw.provider === undefined) !== (raw.model === undefined)) throw taskError('provider/model必须成对指定。')
  for (const key of ['provider','model','reasoningEffort']) if (raw[key] !== undefined && (typeof raw[key] !== 'string'||!raw[key].trim()||raw[key].trim()!==raw[key])) throw taskError(key+'必须是精确非空ID。')
  if (raw.reason !== undefined && (typeof raw.reason !== 'string'||raw.reason.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw.reason))) throw taskError('reason必须是500字符以内纯文本。')
  for (const [mode,key] of [['modelMode','model'],['effortMode','reasoningEffort'],['timeoutMode','timeoutMs']]) {
    if(t[mode] !== undefined && !['manual','auto'].includes(t[mode])) throw taskError(mode+'必须manual或auto。')
    if(t[mode]==='auto' && raw[key]!==undefined || t[mode]==='manual' && raw[key]===undefined) throw taskError(mode+'与显式参数冲突或缺失。')
  }
  if (t.objective !== undefined && !['quality','speed','balanced'].includes(t.objective)) throw taskError('objective必须quality/speed/balanced。')
  if (t.taskClass !== undefined && (typeof t.taskClass!=='string'||! /^[a-z0-9][a-z0-9-]{0,63}$/.test(t.taskClass))) throw taskError('taskClass必须是1~64字符小写分类ID。')
  return { ...t }
}
export function historyBudget(tasks, {cwd, execution, taskClass, profile, config, fallback, maximum, now = Date.now()}) {
  const identity=projectKey(cwd)
  const group = digest({projectIdentity:identity,selection:execution.selection,taskClass:taskClass??null,profile:profile??null})
  const samples = [], reasons = {}, cutoff = now-config.windowDays*86400000
  let families=0,censored=0,verified=0,censorPopulation=0
  for (const task of tasks.filter(t=>projectKey(t.cwd)===identity).sort((a,b)=>b.createdAt-a.createdAt)) {
    if(families>=config.maxFamilies)break
    const runs=[...(task.history??[]),task.run].filter(r=>{
      if(!r.tuning || !Number.isFinite(r.endedAt) || r.endedAt<cutoff || r.endedAt>now)return false
      if(r.tuning.group===group)return true
      const original=digest({cwd:task.cwd,selection:r.tuning.resolved?.execution?.selection,taskClass:r.tuning.requested?.tuning?.taskClass??null,profile:task.profile??null})
      const equivalent=digest({projectIdentity:projectKey(task.cwd),selection:r.tuning.resolved?.execution?.selection,taskClass:r.tuning.requested?.tuning?.taskClass??null,profile:task.profile??null})
      return r.tuning.group===original && equivalent===group
    })
    if(!runs.length)continue
    families++
    // One terminal attempt per family; failed attempts remain separate counters.
    const hasTimeout=runs.some(r=>r.cancelReason==='budget-exhausted')
    if(hasTimeout)censored++
    const valid=runs.filter(r=>r.tuning.observed?.status==='request-confirmed' && r.tuning.observed.matches===true && !r.tuning.observed.everMismatch && r.tuning.applied?.observed?.matches!==false && r.result?.stopReason==='completed' && r.timing?.totalMs>0 && r.timing.totalMs<=7200000 && !r.cancelRequestedAt && !r.recoveryReason).at(-1)
    // A family with timeout+later success counts once in the denominator and remains censored.
    if(valid||hasTimeout)censorPopulation++
    if(valid){samples.push(valid.timing.totalMs);if(valid.verification?.status==='passed')verified++}
    else {const last=runs.at(-1);const reason=last.tuning.observed?.everMismatch||last.tuning.observed?.matches===false?'model-effort-mismatch':last.tuning.observed?.status!=='request-confirmed'?'request-evidence-unknown':last.cancelReason??last.outcome??'unknown';reasons[reason]=(reasons[reason]??0)+1}
  }
  const summary={group,windowDays:config.windowDays,families,completedSamples:samples.length,verifiedSamples:verified,censoredFamilies:censored,censorPopulation,excluded:reasons,config:{...config}}
  let reason = !taskClass?'task-class-required':samples.length<config.minSamples?'insufficient-samples':censored/Math.max(1,censorPopulation)>config.maxCensoredRatio?'censored-ratio-high':null
  if(reason)return {value:fallback,source:'policy-fallback',reason,summary}
  samples.sort((a,b)=>a-b)
  const p=samples[Math.max(0,Math.ceil(samples.length*config.quantile)-1)], estimate=Math.ceil(p*(1+config.margin))
  return {value:Math.min(maximum,Math.max(1000,estimate)),source:'history',reason:'completed-wall-clock-quantile',summary:{...summary,quantileMs:p,unboundedEstimateMs:estimate,capped:estimate>maximum}}
}
export function createTaskTuner({policy, history=()=>[], config, budgets}) {
  const settings=tuningConfig(config)
  async function resolve(raw, {cwd,profile}) {
    const tuning=normalizeTuning(raw), state=await policy.snapshot(), objective=tuning.objective??'balanced'
    let candidate, modelSource=raw.model!==undefined?'caller':'policy-default', modelReason='policy-default'
    const request={...(raw.provider!==undefined?{provider:raw.provider,model:raw.model}:{}),...(raw.reasoningEffort!==undefined?{reasoningEffort:raw.reasoningEffort}:{}),...(raw.reason!==undefined?{reason:raw.reason}:{})}
    if(tuning.modelMode==='auto') {
      if(state.policy.modelMode==='pool') {
        const usable=state.policy.models.filter(m=>m.objective.autoAllowed).filter(m=>{try{resolvePolicy(state.policy,state.catalog,{provider:m.provider,model:m.model,...(raw.reasoningEffort!==undefined?{reasoningEffort:raw.reasoningEffort}:{})});return true}catch{return false}})
        candidate=usable.find(m=>m.objective.priority===objective)??usable.find(m=>m.objective.priority==='balanced')??usable[0]
        if(!candidate)throw taskError('没有可自动选择且能力有效的授权模型。','no-auto-model',409)
        request.provider=candidate.provider;request.model=candidate.model;modelSource='user-rule';modelReason='authorized-objective-tag-not-historical-learning'
      } else {modelSource='policy-fallback';modelReason='single-authorized-route'}
    }
    if(!candidate && state.policy.modelMode==='pool')candidate=state.policy.models.find(m=>m.provider===(request.provider??state.policy.models[0].provider)&&m.model===(request.model??state.policy.models[0].model))
    let effortSource=raw.reasoningEffort!==undefined?'caller':'policy-default', effortReason='policy-default'
    if(tuning.effortMode==='auto') {
      const preferred=candidate?.objective.efforts?.[objective]
      if(preferred){request.reasoningEffort=preferred;effortSource='user-rule';effortReason='authorized-objective-effort-not-historical-learning'}
      else {effortSource='policy-fallback';effortReason='insufficient-effort-evidence'}
    }
    const execution=resolvePolicy(state.policy,state.catalog,request)
    const recommendation=historyBudget(history(),{cwd,execution,taskClass:tuning.taskClass,profile,config:settings,fallback:budgets.taskDefaultTimeoutMs,maximum:budgets.taskMaxTimeoutMs})
    const timeoutMs=raw.timeoutMs??(tuning.timeoutMode==='auto'?recommendation.value:budgets.taskDefaultTimeoutMs)
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>budgets.taskMaxTimeoutMs)throw taskError('timeoutMs超出授权预算范围。')
    const route=execution.selection
    const entry=state.catalog.groups.find(g=>g.id===route.provider)?.models.find(m=>m.id===route.model)
    return { version:VERSION,requested:structuredClone({provider:raw.provider,model:raw.model,reasoningEffort:raw.reasoningEffort,reason:raw.reason,timeoutMs:raw.timeoutMs,tuning}),
      suggested:{timeout:recommendation,model:{source:modelSource,reason:modelReason},effort:{source:effortSource,reason:effortReason}},
      resolved:{execution,timeoutMs,policyRevision:state.policy.revision,catalogHash:digest({route:entry,provider:route.provider}),sources:{model:modelSource,effort:effortSource,timeout:raw.timeoutMs!==undefined?'caller':tuning.timeoutMode==='auto'?recommendation.source:'policy-default'},at:Date.now()},
      applied:{status:'not-applied'},observed:{status:'unknown',reason:'尚未创建执行会话'},group:recommendation.summary.group }
  }
  return {resolve,validateFrozen:execution=>policy.validateFrozen(execution)}
}
