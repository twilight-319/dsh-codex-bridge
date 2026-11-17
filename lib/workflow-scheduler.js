import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { digest, taskError } from './task-store.js'
import { projectKey } from './project-key.js'
import { normalizeTuning } from './task-tuning.js'
import { normalizeWorkflowNodes, workflowNodePrompt } from './workflow-plan.js'
import { mergeUsage, usageFromRecords } from './task-usage.js'
import { executionPrompt } from './task-delivery.js'

const terminal=new Set(['SUCCEEDED','FAILED','CANCELLED','REVIEW_REQUIRED','LEGACY'])
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
const bounded=(value,fallback,min,max,name)=>{value??=fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw taskError(name+'超出允许范围。');return value}
const issue=error=>({code:error.code??'workflow-error',message:String(error.message??'协作状态需要核对').slice(0,700)})
const childEnded=t=>terminal.has(t.state)

/** One durable parent graph, native Task/Run children, no model-driven polling. */
export function createWorkflowScheduler({store,get,save,admit,profiles,budgets,workspaces,submitChild,retryChild,cancelChild,reconcileChild,recoverQueued,answerChild,finishRoot,isBusy,conflicts,kick}) {
  const timers=new Map(),operations=new Map()
  let pending=false,running=null,closed=false,fault=null
  const roots=()=>store.list().filter(t=>t.kind==='workflow'&&!terminal.has(t.state))
  const childOf=(root,node)=>node.childTaskId?get(node.childTaskId):store.list().find(t=>t.parentTaskId===root.taskId&&t.workflowNodeId===node.id)
  const nodeOf=(root,id)=>{const node=root.workflow.nodes.find(n=>n.id===id);if(!node)throw taskError('子任务不存在。');return node}
  function arm(root) {
    clearTimeout(timers.get(root.taskId))
    const timer=setTimeout(()=>{void api.cancel(root.taskId,'budget-exhausted').catch(()=>{})},Math.max(1,root.run.deadline-Date.now()))
    timer.unref?.();timers.set(root.taskId,timer)
  }
  function write(root,type) {const result=save(root,type);if(terminal.has(root.state)){clearTimeout(timers.get(root.taskId));timers.delete(root.taskId)}return result}
  function remaining(root) {return root.run.deadline-Date.now()}
  function ensureActive(id) {const root=get(id);if(root.run.cancelRequestedAt||remaining(root)<=0)throw taskError('协作任务已经取消或预算耗尽。','workflow-stopping',409);return root}
  function pause(root,error,nodeId) {
    root.state='WORKFLOW_PAUSED';root.workflow.phase='paused';root.run.issue={...issue(error),...(nodeId?{nodeId}:{})};root.run.question=null
    write(root,'workflow.paused')
  }
  function aggregate(root) {
    let usage,knownTokens=0,modelCalls=0
    for(const node of root.workflow.nodes) {
      const child=childOf(root,node)
      for(const run of child?[...(child.history??[]),child.run]:[])if(run.dispatchIntent||run.usage){usage=mergeUsage(usage,run.usage??usageFromRecords([]));const bound=run.budgetUsage??run.usage;modelCalls+=bound?.modelCalls??0;knownTokens+=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].reduce((sum,key)=>sum+(bound?.[key]??0),0)}
    }
    root.run.usage=usage??usageFromRecords([])
    root.run.budgetObserved={modelCalls,knownTokens,coverage:root.run.usage.status}
  }
  async function stop(root) {
    for(const node of root.workflow.nodes) {
      const child=childOf(root,node)
      if(child&&!childEnded(child)&&!child.run.cancelRequestedAt)await cancelChild(child.taskId)
    }
    root=get(root.taskId)
    const unsettled=root.workflow.nodes.map(n=>childOf(root,n)).filter(c=>c&&(!childEnded(c)||isBusy(c.taskId)))
    if(unsettled.length) {
      if(unsettled.some(c=>c.state==='RECONCILING')&&root.state!=='RECONCILING') {root.state='RECONCILING';write(root,'workflow.stop_uncertain')}
      return
    }
    if(root.run.integrationIntent&&!root.run.integrationComplete) {
      try{await workspaces.rollback(root)}catch(error){root.run.rollbackIncomplete=true;root.run.issue={...issue(error),message:'执行已确认停止，文件回滚未完成，保留当前文件供人工核对：'+issue(error).message}}
    }
    if(root.run.integrationComplete) {
      // Integration has already happened; never relabel completed work as cancelled.
      root.state='REVIEW_REQUIRED';root.run.result={stopReason:'completed',text:'子任务产物已集成；后续验证或审查被中止，请核对结果。'}
      root.run.evidenceHash=digest({integration:root.run.integration,verification:root.run.verification,issue:root.run.issue})
    } else {root.state=root.run.cancelReason==='user'?'CANCELLED':'FAILED';root.run.result={stopReason:root.run.cancelReason==='user'?'cancelled':'timeout',text:root.run.rollbackIncomplete?'执行已停止；未能完整回滚，当前文件已保留，请人工核对。':'协作任务已停止；未集成的工作区保留。'}}
    if(root.run.workStartedAt)root.run.timing={...root.run.timing,executionMs:Date.now()-root.run.workStartedAt}
    root.workflow.phase='completed';aggregate(root);write(root,'workflow.stopped')
  }
  async function attach(root,node) {
    const existing=childOf(root,node)
    if(existing&&!node.childTaskId){node.childTaskId=existing.taskId;node.state='ADMITTED';write(root,'workflow.child_attached')}
  }
  async function inspect(root,signal) {
    for(const id of root.workflow.order) {
      root=get(root.taskId);const node=nodeOf(root,id)
      await attach(root,node)
      const child=childOf(root,node)
      if(!child||node.state==='COMPLETED'||node.state==='FAILED'||node.repairIntent)continue
      if(node.childState!==child.state||node.childRunId!==child.activeRunId||node.sessionId!==child.run.sessionId){node.childState=child.state;node.childRunId=child.activeRunId;node.sessionId=child.run.sessionId;write(root,'workflow.child_state')}
      if(childEnded(child)&&!isBusy(child.taskId)) {
        if(child.run.result?.stopReason!=='completed'||child.state==='FAILED'||child.state==='CANCELLED'||node.verificationProfile&&child.run.verification?.status!=='passed') {
          node.state='FAILED';node.error=child.run.error??{code:'node-execution-failed',message:'执行或节点验证没有通过。'};write(root,'workflow.child_failed');continue
        }
        try {
          const outputs=await workspaces.capture(root,node,signal)
          root=get(root.taskId);const fresh=nodeOf(root,id);fresh.outputs=outputs;fresh.state='COMPLETED';fresh.delivery={text:(child.run.result?.text??'').slice(0,1200),verification:child.run.verification?.status??'unknown',runId:child.activeRunId}
          write(root,'workflow.child_completed')
        } catch(error) {
          if(get(root.taskId).run.cancelRequestedAt)throw error
          root=get(root.taskId);const fresh=nodeOf(root,id);fresh.state='FAILED';fresh.error=issue(error);write(root,'workflow.child_failed')
        }
      }
    }
    root=get(root.taskId);aggregate(root)
    const previous=get(root.taskId)
    if(digest(root.run.usage)!==digest(previous.run.usage??null))write(root,'workflow.usage_observed')
    return get(root.taskId)
  }
  async function dispatch(root,node,signal) {
    const ancestors=root.workflow.order.filter(id=>root.workflow.ancestors[node.id].includes(id)).map(id=>nodeOf(root,id))
    if(!node.workspace) {
      node.state='PREPARING';write(root,'workflow.child_preparing')
      const workspace=await workspaces.prepareNode(root,node,ancestors,signal)
      root=ensureActive(root.taskId);node=nodeOf(root,node.id);node.workspace=workspace;write(root,'workflow.child_workspace_ready')
    }
    root=ensureActive(root.taskId);node=nodeOf(root,node.id)
    aggregate(root)
    if(root.run.budgetObserved.modelCalls>=root.workflow.maxModelCalls||root.workflow.maxObservedTokens!==null&&root.run.budgetObserved.knownTokens>=root.workflow.maxObservedTokens) {
      await api.cancel(root.taskId,root.run.budgetObserved.modelCalls>=root.workflow.maxModelCalls?'observed-model-budget':'observed-token-budget');throw taskError('父任务观测预算耗尽。','workflow-stopping',409)
    }
    if(!node.admission) {
      const budget=Math.min(remaining(root),root.run.budgetMs)
      if(budget<1000)throw taskError('协作任务剩余预算不足。','workflow-stopping',409)
      node.admission={goal:workflowNodePrompt(root,node),cwd:node.workspace.cwd,idempotencyKey:root.taskId+'-'+node.id,timeoutMs:budget,executionMode:node.plan?'planned':'direct',...(node.plan?{plan:node.plan}:{}),acceptance:node.acceptance,...(node.qualityProfile?{qualityProfile:node.qualityProfile}:{}),...(node.verificationProfile?{verificationProfile:node.verificationProfile}:{}),...root.workflow.routing}
      node.state='SUBMITTING';write(root,'workflow.child_admission_intent')
    }
    const child=await submitChild(node.admission,{parentTaskId:root.taskId,nodeId:node.id,deadline:root.run.deadline})
    root=get(root.taskId);node=nodeOf(root,node.id);node.childTaskId=child.taskId;node.state='ADMITTED';write(root,'workflow.child_admitted')
  }
  async function advance(id,signal) {
    let root=get(id)
    if(root.run.cancelRequestedAt)return stop(root)
    if(remaining(root)<=0)return api.cancel(id,'budget-exhausted')
    if(root.state==='RECONCILING'||root.state==='WORKFLOW_PAUSED') {
      const before=digest(root.run.budgetObserved??null);aggregate(root)
      if(before!==digest(root.run.budgetObserved))write(root,'workflow.usage_observed')
      if(root.run.budgetObserved.modelCalls>=root.workflow.maxModelCalls)return api.cancel(id,'observed-model-budget')
      if(root.workflow.maxObservedTokens!==null&&root.run.budgetObserved.knownTokens>=root.workflow.maxObservedTokens)return api.cancel(id,'observed-token-budget')
      return
    }
    if(root.state==='QUEUED') {
      const blocked=store.list().some(t=>t.taskId!==id&&!terminal.has(t.state)&&conflicts(root,t)&&(!t.parentTaskId||t.parentTaskId!==id)&&(t.state!=='QUEUED'||t.createdAt<root.createdAt))
      if(blocked)return
      root.state='RUNNING';root.workflow.phase='preparing';root.run.workStartedAt=Date.now();root.run.timing={queueMs:Date.now()-root.createdAt};write(root,'workflow.started')
    }
    if(!root.run.workspace) {
      const workspace=await workspaces.prepare(root,signal)
      root=ensureActive(id);root.run.workspace=workspace;write(root,'workflow.snapshot_ready')
    }
    for(const candidate of root.workflow.nodes.filter(n=>n.repairIntent)) {
      root=ensureActive(id);const node=nodeOf(root,candidate.id),intent=node.repairIntent,child=childOf(root,node)
      if(child) {
        const repaired=await retryChild({taskId:child.taskId,idempotencyKey:intent.key,goal:intent.goal},id)
        root=get(id);const fresh=nodeOf(root,node.id);fresh.childTaskId=repaired.taskId;fresh.state='ADMITTED';fresh.repairIntent=null;write(root,'workflow.repair_admitted')
      } else {
        node.goal=intent.goal;node.plan=null;node.admission=null;node.repairIntent=null;node.state='PENDING';write(root,'workflow.preparation_retry')
      }
    }
    root=await inspect(root,signal)
    if(root.run.cancelRequestedAt)return stop(root)
    const allComplete=root.workflow.nodes.every(n=>n.state==='COMPLETED')
    if(!allComplete&&root.run.budgetObserved.modelCalls>=root.workflow.maxModelCalls)return api.cancel(id,'observed-model-budget')
    if(!allComplete&&root.workflow.maxObservedTokens!==null&&root.run.budgetObserved.knownTokens>=root.workflow.maxObservedTokens)return api.cancel(id,'observed-token-budget')
    const children=root.workflow.nodes.map(n=>({node:n,child:childOf(root,n)}))
    const uncertain=children.find(({child})=>child?.state==='RECONCILING')
    if(uncertain) {root.state='RECONCILING';root.run.issue={code:'child-uncertain',nodeId:uncertain.node.id,message:'子任务执行状态不确定，先对账。'};write(root,'workflow.child_uncertain');return}
    const failure=root.workflow.nodes.find(n=>n.state==='FAILED')
    if(failure){pause(root,failure.error,failure.id);return}
    if(allComplete) {
      root.state='RUNNING';root.workflow.phase='integrating';root.run.question=null;root.run.integrationIntent=true;write(root,'workflow.integration_intent')
      const integration=await workspaces.integrate(root,signal)
      root=get(id);root.run.integration=integration;root.run.integrationComplete=true;root.run.timing={...root.run.timing,executionMs:Date.now()-(root.run.workStartedAt??root.createdAt)};root.workflow.phase='verifying';write(root,'workflow.integrated')
      if(root.run.cancelRequestedAt)return stop(root)
      await finishRoot(id,{stopReason:'completed',text:`完成 ${root.workflow.nodes.length} 个子任务；集成 ${integration.files.length} 个文件。\n`+root.workflow.nodes.map(n=>`${n.id}：${n.delivery?.text??''}`).join('\n')},signal)
      root=get(id);root.workflow.phase='completed';aggregate(root);write(root,'workflow.finished');return
    }
    const waiting=children.find(({child})=>child?.state==='WAITING_INPUT')
    const approval=children.find(({child})=>child?.state==='WAITING_APPROVAL')
    const nextState=waiting?'WAITING_INPUT':approval?'WAITING_APPROVAL':'RUNNING'
    const question=waiting?{...waiting.child.run.question,childTaskId:waiting.child.taskId,childRunId:waiting.child.activeRunId,nodeId:waiting.node.id}:null
    if(root.state!==nextState||digest(root.run.question??null)!==digest(question)) {root.state=nextState;root.run.question=question;root.workflow.phase='executing';write(root,'workflow.attention_changed')}
    let active=children.filter(({child})=>child&&(!childEnded(child)||isBusy(child.taskId))).length
    for(const node of root.workflow.nodes) {
      if(active>=root.workflow.parallelism)break
      if(['COMPLETED','FAILED','ADMITTED'].includes(node.state)||node.childTaskId)continue
      if(!node.dependsOn.every(dep=>nodeOf(root,dep).state==='COMPLETED'))continue
      try {await dispatch(root,node,signal);active++}
      catch(error) {root=get(id);if(root.run.cancelRequestedAt||remaining(root)<=0)throw error;const failed=nodeOf(root,node.id);failed.state='FAILED';failed.error=issue(error);write(root,'workflow.child_failed');pause(root,error,node.id);return}
      root=ensureActive(id)
    }
  }
  async function pump() {
    while(pending&&!closed) {
      pending=false
      for(const root of roots()) {
        const controller=new AbortController();operations.set(root.taskId,controller)
        try{await advance(root.taskId,controller.signal)}
        catch(error){const current=get(root.taskId);if(current.run.cancelRequestedAt)await stop(current);else if(remaining(current)<=0)await api.cancel(root.taskId,'budget-exhausted');else if(current.run.integrationIntent){current.state='RECONCILING';current.run.issue=issue(error);write(current,'workflow.integration_uncertain')}else pause(current,error)}
        finally{operations.delete(root.taskId)}
      }
      kick()
    }
  }
  function wake() {
    if(closed||fault)return
    pending=true
    if(!running)running=Promise.resolve().then(pump).catch(error=>{fault=issue(error);pending=false}).finally(()=>{running=null;if(pending)wake()})
  }
  const api={
    wake,
    activity:()=>({operations:operations.size,...(fault?{error:fault}:{})}),
    canLaunch(child) {
      const root=store.get(child.parentTaskId)
      if(fault||!root||!['RUNNING','WAITING_INPUT','WAITING_APPROVAL'].includes(root.state)||root.run.cancelRequestedAt||remaining(root)<=0||!root.workflow.nodes.some(n=>n.id===child.workflowNodeId&&n.admission))return false
      aggregate(root)
      return root.run.budgetObserved.modelCalls<root.workflow.maxModelCalls&&(root.workflow.maxObservedTokens===null||root.run.budgetObserved.knownTokens<root.workflow.maxObservedTokens)
    },
    async submit(raw) {
      if(fault)throw taskError('协作调度器已停止，请检查任务库诊断。','workflow-scheduler-unavailable',503)
      const allowed=['goal','cwd','idempotencyKey','nodes','timeoutMs','parallelism','maxRepairs','maxModelCalls','maxObservedTokens','verificationProfile','review','provider','model','reasoningEffort','reason','tuning']
      if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k)))throw taskError('协作任务包含未知字段。')
      if(typeof raw.goal!=='string'||!raw.goal.trim()||raw.goal.length>12000||typeof raw.idempotencyKey!=='string'||!raw.idempotencyKey.trim()||raw.idempotencyKey.length>200)throw taskError('协作任务需要goal和稳定idempotencyKey。')
      if(raw.cwd!==undefined&&typeof raw.cwd!=='string'||raw.review!==undefined&&typeof raw.review!=='boolean')throw taskError('协作目录或审查选项无效。')
      const graph=normalizeWorkflowNodes(raw.nodes),cwd=resolve(raw.cwd??process.cwd()),requested={...raw,cwd},key=digest({cwd:projectKey(cwd),key:raw.idempotencyKey}),hash=digest(canonical(requested))
      const find=()=>store.list().find(t=>t.submissionKey===key&&projectKey(t.cwd)===projectKey(cwd))
      const replay=()=>{const t=find();if(t&&t.payloadHash!==hash)throw taskError('同一幂等键的协作计划发生变化。','idempotency-conflict',409);return t}
      const prior=replay();if(prior)return prior
      normalizeTuning(raw)
      if(raw.tuning?.timeoutMode==='auto')throw taskError('协作总预算使用明确时限或服务端默认值，不支持历史自动延时。')
      const timeoutMs=bounded(raw.timeoutMs,budgets.taskDefaultTimeoutMs,1000,budgets.taskMaxTimeoutMs,'总时限')
      const parallelism=bounded(raw.parallelism,2,1,2,'并发数'),maxRepairs=bounded(raw.maxRepairs,1,0,2,'修复轮数'),maxModelCalls=bounded(raw.maxModelCalls,40,1,1000,'观测模型调用预算')
      const maxObservedTokens=raw.maxObservedTokens===undefined?null:bounded(raw.maxObservedTokens,null,1,Number.MAX_SAFE_INTEGER,'观测token预算')
      for(const profile of [raw.verificationProfile,...graph.nodes.map(n=>n.verificationProfile)])if(profile!==undefined&&!Object.hasOwn(profiles,profile))throw taskError('验证配置不存在。')
      for(const node of graph.nodes)if(workflowNodePrompt({goal:raw.goal,workflow:{nodes:graph.nodes}},node).length+(node.plan?.length??0)+node.acceptance.join('\n').length+2500>20000)throw taskError('子任务说明过长，无法为依赖摘要预留上下文。')
      admit();if(!(await stat(cwd).catch(()=>null))?.isDirectory())throw taskError('协作工作目录不存在。')
      const repeated=replay();if(repeated)return repeated;admit()
      const taskId='workflow-'+randomUUID(),runId='run-'+randomUUID(),now=Date.now()
      const routing=Object.fromEntries(['provider','model','reasoningEffort','reason','tuning'].filter(k=>raw[k]!==undefined).map(k=>[k,structuredClone(raw[k])]))
      const root={schemaVersion:1,kind:'workflow',taskId,activeRunId:runId,cwd,goal:raw.goal,executionMode:raw.review?'reviewed':'planned',review:raw.review===true,profile:raw.verificationProfile?structuredClone(profiles[raw.verificationProfile]):null,requestedInput:structuredClone(requested),submissionKey:key,payloadHash:hash,requestHashVersion:2,revision:0,state:'QUEUED',createdAt:now,updatedAt:now,workflow:{...graph,nodes:graph.nodes.map(n=>({...n,state:'PENDING'})),phase:'queued',routing,parallelism,maxRepairs,repairsUsed:0,repairKeys:{},maxModelCalls,maxObservedTokens},run:{runId,startedAt:now,budgetMode:'wall-clock',budgetMs:timeoutMs,deadline:now+timeoutMs,verification:{status:'pending'},attempt:1}}
      write(root,'workflow.created');arm(root);wake();return get(taskId)
    },
    async cancel(id,reason='user') {
      let root=get(id);if(terminal.has(root.state))return root
      root.run.cancelRequestedAt??=Date.now();root.run.cancelReason??=reason;root.run.question=null;root.state='CANCEL_REQUESTED';root.workflow.phase='cancelling';write(root,'workflow.cancel_requested')
      operations.get(id)?.abort(new Error('workflow stopped'))
      for(const node of root.workflow.nodes){const child=childOf(root,node);if(child&&!childEnded(child)&&!child.run.cancelRequestedAt)await cancelChild(child.taskId)}
      wake();return get(id)
    },
    async reconcile(id) {
      let root=get(id);if(terminal.has(root.state))return root
      for(const node of root.workflow.nodes) {
        let child=childOf(root,node)
        if(child?.state==='RECONCILING') {
          if(!child.run.dispatchIntent&&!child.run.sessionId)await recoverQueued(child.taskId,id)
          else await reconcileChild(child.taskId)
        }
      }
      root=get(id)
      if(root.workflow.nodes.some(n=>childOf(root,n)?.state==='RECONCILING'))return root
      if(!root.run.cancelRequestedAt){root.state='RUNNING';root.run.issue=null;root.run.recoveryReason=null;write(root,'workflow.reconciled')}
      wake();return get(id)
    },
    async answer(input) {
      const root=get(input.taskId),q=root.run.question
      if(root.activeRunId!==input.runId||root.state!=='WAITING_INPUT'||!q||q.requestId!==input.requestId)throw taskError('协作任务当前问题已变化。','question-request-mismatch',409)
      await answerChild({taskId:q.childTaskId,runId:q.childRunId,requestId:input.requestId,answers:input.answers})
      const fresh=get(root.taskId);fresh.run.question=null;fresh.state='RUNNING';write(fresh,'workflow.child_answered');wake();return get(root.taskId)
    },
    async repair({taskId,nodeId,idempotencyKey,goal}) {
      let root=get(taskId);const node=nodeOf(root,nodeId)
      if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>200||goal!==undefined&&(typeof goal!=='string'||!goal.trim()||goal.length>12000))throw taskError('修复参数无效。')
      const key=digest(idempotencyKey),hash=digest({nodeId,goal:goal??null}),old=root.workflow.repairKeys[key]
      if(old){if(old.hash!==hash)throw taskError('修复幂等键内容冲突。','idempotency-conflict',409);wake();return root}
      admit();ensureActive(taskId)
      aggregate(root)
      if(root.run.budgetObserved.modelCalls>=root.workflow.maxModelCalls||root.workflow.maxObservedTokens!==null&&root.run.budgetObserved.knownTokens>=root.workflow.maxObservedTokens)throw taskError('父任务观测预算已经耗尽。','workflow-stopping',409)
      if(root.state!=='WORKFLOW_PAUSED'||node.state!=='FAILED'||root.workflow.repairsUsed>=root.workflow.maxRepairs)throw taskError('当前节点不能修复或已达到整个协作任务的修复上限。','workflow-repair-limit',409)
      const child=childOf(root,node)
      if(child&&(!childEnded(child)||isBusy(child.taskId)))throw taskError('先确认子任务已经停止。','task-busy',409)
      const repairGoal=workflowNodePrompt(root,{...node,goal:goal??node.goal+'\n\n仅修复本节点失败项，保留已完成修改：'+(node.error?.message??'检查执行结果')})
      executionPrompt({goal:repairGoal,acceptance:node.acceptance,qualityProfile:node.qualityProfile})
      const intent={key:root.taskId+'-repair-'+(root.workflow.repairsUsed+1),goal:repairGoal,hash,nodeId}
      root.workflow.repairsUsed++;root.workflow.repairKeys[key]=intent;node.repairIntent=intent;node.state='REPAIRING';delete node.outputs;delete node.error;root.state='RUNNING';root.run.issue=null;write(root,'workflow.repair_intent')
      wake();return get(taskId)
    },
    async dispose() {for(const timer of timers.values())clearTimeout(timer);for(const controller of operations.values())controller.abort();if(running)await running;closed=true;pending=false},
  }
  for(const root of roots()){root.state='RECONCILING';root.run.question=null;root.run.recoveryReason='workflow-host-restarted';write(root,'workflow.interrupted');arm(root)}
  return api
}
