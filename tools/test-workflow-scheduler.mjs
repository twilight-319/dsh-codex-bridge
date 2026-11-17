import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskManager } from '../lib/task-manager.js'
import { createTaskStore } from '../lib/task-store.js'
import { createWorkflowWorkspaces } from '../lib/workflow-workspaces.js'
import { normalizeWorkflowNodes } from '../lib/workflow-plan.js'
import { usageFromRecords } from '../lib/task-usage.js'

const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn) {for(let i=0;i<1000;i++){if(await fn())return;await delay(10)}assert.fail('workflow fixture timed out')}
const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
async function fixture(t,handler,options={}) {
  const dir=await mkdtemp(join(tmpdir(),'bridge-workflow-')),cwd=join(dir,'repo'),data=join(dir,'store'),workspaces=join(dir,'workspaces')
  await mkdir(cwd);await writeFile(join(cwd,'a.txt'),'a0');await writeFile(join(cwd,'b.txt'),'b0');await writeFile(join(cwd,'shared.txt'),'s0')
  git(cwd,['init']);git(cwd,['add','.']);git(cwd,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture'])
  const calls=[],native=new Map();let active=0,peak=0,reviews=0,manager
  const executor={
    async executeTask(input) {
      input={...input,cwd:input.cwd??calls.find(c=>c.sessionId===input.sessionId)?.input.cwd}
      const node=basename(input.cwd),sessionId=input.sessionId??'session-'+calls.length
      calls.push({node,input,sessionId});input.onSession?.({sessionId,baseline:0});native.set(sessionId,{running:true,pendingInput:[]});active++;peak=Math.max(peak,active)
      const abort=()=>{native.get(sessionId)?.onCancel?.();resolveAbort({stopReason:'cancelled'})}
      let resolveAbort
      const aborted=new Promise(r=>{resolveAbort=r});input.signal?.addEventListener('abort',abort,{once:true})
      try {const result=await Promise.race([handler({node,input,sessionId,calls,native}),aborted]);const value={sessionId,stopReason:'completed',text:node+' done',...result};native.set(sessionId,result?.keepRunning?{running:true,pendingInput:[]}:{running:false,pendingInput:[],result:value});return value}
      finally{active--;input.signal?.removeEventListener('abort',abort)}
    },
    async execute(input){return executor.executeTask(input)},
    async cancel(sessionId){const state=native.get(sessionId);if(state?.onCancel)state.onCancel()},
    async observe(sessionId){return native.get(sessionId)??{running:false,pendingInput:[]}},
    async dispose(){},validateAnswer(){},
  }
  const workspaceService=createWorkflowWorkspaces({directory:workspaces})
  manager=createTaskManager({store:createTaskStore(data),executor,workflowWorkspaces:workspaceService,reviewer:async()=>{reviews++;return{verdict:'approve'}},...options})
  t.after(async()=>{for(const call of calls)native.get(call.sessionId)?.onCancel?.();await manager.dispose();await rm(dir,{recursive:true,force:true})})
  return{dir,cwd,data,workspaces,workspaceService,manager,executor,calls,native,get peak(){return peak},get reviews(){return reviews},submit:extra=>manager.orchestrate({goal:'controlled graph',cwd,idempotencyKey:'graph',timeoutMs:30000,nodes:[{id:'alpha',goal:'modify a',writePaths:['a.txt']},{id:'beta',goal:'modify b',writePaths:['b.txt']}],...extra}),get managerRef(){return manager},replaceManager(next){manager=next}}
}

test('DAG validates cycles, references, duplicate IDs and parallel write overlap before creating work',()=>{
  assert.throws(()=>normalizeWorkflowNodes([{id:'a',goal:'g',writePaths:['src/'],dependsOn:['b']},{id:'b',goal:'g',writePaths:['src/x'],dependsOn:['a']}]))
  assert.throws(()=>normalizeWorkflowNodes([{id:'a',goal:'g',writePaths:['../outside']}]))
  assert.throws(()=>normalizeWorkflowNodes([{id:'a',goal:'g',writePaths:['src']},{id:'b',goal:'g',writePaths:['src/x']}]))
  assert.throws(()=>normalizeWorkflowNodes([{id:'a',goal:'g',writePaths:[],dependsOn:['missing']}]))
  assert.throws(()=>normalizeWorkflowNodes([{id:'a',goal:'g',writePaths:[]},{id:'a',goal:'g',writePaths:[]}]))
  const sequential=normalizeWorkflowNodes([{id:'a',goal:'g',writePaths:['src']},{id:'b',goal:'g',writePaths:['src/x'],dependsOn:['a']}])
  assert.deepEqual(sequential.order,['a','b'])
})

test('two real isolated worktrees run in parallel, dependencies see upstream outputs, source changes only at integration',async t=>{
  const gates={alpha:deferred(),beta:deferred()};let f
  f=await fixture(t,async({node,input})=>{
    if(node==='alpha'||node==='beta'){await gates[node].promise;await writeFile(join(input.cwd,node==='alpha'?'a.txt':'b.txt'),node+'1')}
    else {assert.equal(await readFile(join(input.cwd,'a.txt'),'utf8'),'alpha1');assert.equal(await readFile(join(input.cwd,'b.txt'),'utf8'),'beta1');await writeFile(join(input.cwd,'result.txt'),'combined')}
  })
  await writeFile(join(f.cwd,'shared.txt'),'user uncommitted');await writeFile(join(f.cwd,'untracked.txt'),'preserve')
  const nodes=[{id:'alpha',goal:'a',writePaths:['a.txt']},{id:'beta',goal:'b',writePaths:['b.txt']},{id:'combine',goal:'combine upstream',dependsOn:['alpha','beta'],writePaths:['result.txt']}]
  const root=await f.submit({nodes});await until(()=>f.calls.length===2)
  assert.equal(f.peak,2);assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'a0')
  assert.notEqual(f.calls[0].input.cwd,f.calls[1].input.cwd);assert.ok(f.calls.every(c=>c.input.cwd!==f.cwd))
  gates.alpha.resolve();await until(()=>f.manager.get(root.taskId).workflow.nodes[0].state==='COMPLETED');assert.equal(f.calls.length,2)
  gates.beta.resolve();await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED')
  assert.equal(f.calls.length,3);assert.equal(f.peak,2);assert.equal(f.reviews,0)
  assert.equal(await readFile(join(f.cwd,'result.txt'),'utf8'),'combined');assert.equal(await readFile(join(f.cwd,'shared.txt'),'utf8'),'user uncommitted');assert.equal(await readFile(join(f.cwd,'untracked.txt'),'utf8'),'preserve')
  const done=f.manager.get(root.taskId);assert.equal(done.run.integration.files.length,3)
  assert.ok(done.workflow.nodes.every(n=>f.manager.get(n.childTaskId).run.deadline<=done.run.deadline))
})

test('failed node pauses dependents, repair is idempotent and uses the same workspace under the parent deadline',async t=>{
  let f
  f=await fixture(t,async({node,input,calls})=>{
    const count=calls.filter(c=>c.node===node).length
    if(node==='alpha'&&count===1)return{stopReason:'error'}
    await writeFile(join(input.cwd,node==='alpha'?'a.txt':'b.txt'),node+' repaired')
  })
  const root=await f.submit({maxRepairs:1,nodes:[{id:'alpha',goal:'a',writePaths:['a.txt']},{id:'beta',goal:'b',writePaths:['b.txt'],dependsOn:['alpha']}]})
  await until(()=>f.manager.get(root.taskId).state==='WORKFLOW_PAUSED');assert.equal(f.calls.length,1)
  const child=f.manager.get(root.taskId).workflow.nodes[0].childTaskId
  await assert.rejects(f.manager.retry({taskId:child,idempotencyKey:'bypass'}),{code:'workflow-owned'})
  const repair={taskId:root.taskId,nodeId:'alpha',idempotencyKey:'repair-one'}
  await f.manager.repairNode(repair);await f.manager.repairNode(repair)
  // The fixture's reuse adapter still receives the original cwd through the metadata below.
  await until(()=>['REVIEW_REQUIRED','WORKFLOW_PAUSED'].includes(f.manager.get(root.taskId).state))
  const current=f.manager.get(root.taskId)
  assert.equal(current.workflow.repairsUsed,1)
  if(current.state==='WORKFLOW_PAUSED')throw new Error(JSON.stringify(current.run.issue))
  assert.equal(f.calls.filter(c=>c.node==='alpha').length,2);assert.equal(f.calls.filter(c=>c.node==='beta').length,1)
})

test('scope violations and source edits are never silently integrated',async t=>{
  const f=await fixture(t,async({input})=>{await writeFile(join(input.cwd,'shared.txt'),'out of scope')})
  const root=await f.submit({nodes:[{id:'alpha',goal:'only a',writePaths:['a.txt']}]})
  await until(()=>f.manager.get(root.taskId).state==='WORKFLOW_PAUSED')
  assert.equal(f.manager.get(root.taskId).workflow.nodes[0].error.code,'workflow-write-scope')
  assert.equal(await readFile(join(f.cwd,'shared.txt'),'utf8'),'s0')
  const gate=deferred(),g=await fixture(t,async({input})=>{await gate.promise;await writeFile(join(input.cwd,'a.txt'),'worker')})
  const second=await g.submit({nodes:[{id:'alpha',goal:'a',writePaths:['a.txt']}]});await until(()=>g.calls.length===1)
  await writeFile(join(g.cwd,'a.txt'),'user concurrent edit');gate.resolve()
  await until(()=>g.manager.get(second.taskId).state==='RECONCILING')
  assert.equal(g.manager.get(second.taskId).run.issue.code,'workflow-integration-conflict')
  assert.equal(await readFile(join(g.cwd,'a.txt'),'utf8'),'user concurrent edit')
})

test('parent cancellation waits for stopped evidence and does not admit dependents',async t=>{
  const gates=new Map(),f=await fixture(t,({sessionId,native})=>new Promise(resolve=>{const stop=()=>{native.set(sessionId,{running:false,pendingInput:[]});resolve({stopReason:'cancelled'})};gates.set(sessionId,stop);native.get(sessionId).onCancel=stop}))
  const root=await f.submit({nodes:[{id:'alpha',goal:'a',writePaths:['a.txt']},{id:'beta',goal:'b',writePaths:['b.txt'],dependsOn:['alpha']}]});await until(()=>f.calls.length===1)
  await f.manager.cancel({taskId:root.taskId});await until(()=>f.manager.get(root.taskId).state==='CANCELLED')
  assert.equal(f.calls.length,1);assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'a0')
})

test('observed shared model budget prevents new nodes and never fabricates token prices',async t=>{
  const f=await fixture(t,async({input})=>{
    const usage=usageFromRecords([{seq:10,type:'assistant/message',data:{usage:{inputTokens:10,cacheReadTokens:30,outputTokens:2}}}])
    input.onUsage({seq:10,usage});return{usage}
  })
  const root=await f.submit({maxModelCalls:1,nodes:[{id:'alpha',goal:'read',writePaths:[]},{id:'beta',goal:'read later',writePaths:[],dependsOn:['alpha']}]})
  await until(()=>f.manager.get(root.taskId).state==='FAILED')
  assert.equal(f.calls.length,1);const done=f.manager.get(root.taskId);assert.equal(done.run.cancelReason,'observed-model-budget');assert.equal(done.run.usage.cost,null)
})

test('source ownership includes subdirectories; global worker limit includes ordinary tasks',async t=>{
  const gates={alpha:deferred(),beta:deferred(),sub:deferred()},f=await fixture(t,async({node})=>{await gates[node].promise})
  const sub=join(f.cwd,'sub');await mkdir(sub)
  const root=await f.submit();await until(()=>f.calls.length===2)
  const ordinary=await f.manager.submit({goal:'queued source edit',cwd:sub,idempotencyKey:'ordinary'})
  await delay(80);assert.equal(f.calls.length,2)
  gates.alpha.resolve();gates.beta.resolve();await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED');await until(()=>f.calls.length===3)
  gates.sub.resolve();await until(()=>f.manager.get(ordinary.taskId).state==='REVIEW_REQUIRED');assert.ok(f.peak<=2)
})

test('parent routes current native questions and rejects stale answers',async t=>{
  const f=await fixture(t,async({node,input,calls})=>{
    if(calls.filter(c=>c.node===node).length===1)return{stopReason:'needs-input',needsInput:{requestId:'question-1',expiresAt:Date.now()+10000,questions:[{id:'q',question:'continue?',options:[{label:'yes'}]}]}}
    assert.deepEqual(input.answers,[{id:'q',selected:['yes']}]);await writeFile(join(input.cwd,'a.txt'),'answered')
  })
  f.executor.answerTask=input=>f.executor.executeTask(input)
  const root=await f.submit({nodes:[{id:'alpha',goal:'a',writePaths:['a.txt']}]})
  await until(()=>f.manager.get(root.taskId).state==='WAITING_INPUT'&&f.manager.maintenanceStatus().jobs===0)
  const current=f.manager.get(root.taskId);assert.equal(current.run.question.nodeId,'alpha')
  await assert.rejects(f.manager.answer({taskId:root.taskId,runId:root.activeRunId,requestId:'stale',answers:[]}),{code:'question-request-mismatch'})
  assert.equal(f.calls.length,1)
  await f.manager.answer({taskId:root.taskId,runId:root.activeRunId,requestId:'question-1',answers:[{id:'q',selected:['yes']}]})
  await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED');assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'answered')
})

test('unconfirmed cancellation retains source lock until explicit stopped reconciliation',async t=>{
  const f=await fixture(t,async()=>({stopReason:'error',keepRunning:true}))
  const root=await f.submit({nodes:[{id:'alpha',goal:'a',writePaths:['a.txt']}]})
  await until(()=>f.manager.get(root.taskId).state==='RECONCILING')
  await f.manager.cancel({taskId:root.taskId});await delay(80);assert.equal(f.manager.get(root.taskId).state,'RECONCILING')
  const childId=f.manager.get(root.taskId).workflow.nodes[0].childTaskId,child=f.manager.get(childId)
  f.native.set(child.run.sessionId,{running:false,pendingInput:[],result:{sessionId:child.run.sessionId,stopReason:'aborted',text:''}})
  await f.manager.reconcile({taskId:root.taskId});await until(()=>f.manager.get(root.taskId).state==='CANCELLED')
  assert.equal(f.calls.length,1)
})

test('restart reconciles an already dispatched child without replay and then admits only its successor',async t=>{
  const never=deferred(),f=await fixture(t,async({node,input})=>{if(node==='alpha')await never.promise;else await writeFile(join(input.cwd,'b.txt'),'successor')})
  const root=await f.submit({nodes:[{id:'alpha',goal:'a',writePaths:['a.txt']},{id:'beta',goal:'b',writePaths:['b.txt'],dependsOn:['alpha']}]})
  await until(()=>f.calls.length===1&&f.manager.get(root.taskId).workflow.nodes[0].childTaskId)
  const copied=f.manager.list({limit:100}).tasks,restorePath=join(f.dir,'restored'),snapshotStore=createTaskStore(restorePath)
  copied.forEach(record=>snapshotStore.commit(record,'fixture.crash_snapshot'));snapshotStore.close()
  const first=f.calls[0];await f.manager.dispose()
  await writeFile(join(first.input.cwd,'a.txt'),'completed during interruption')
  f.native.set(first.sessionId,{running:false,pendingInput:[],result:{sessionId:first.sessionId,stopReason:'completed',text:'native fact'}})
  const restored=createTaskManager({store:createTaskStore(restorePath),executor:f.executor,workflowWorkspaces:f.workspaceService});f.replaceManager(restored)
  assert.equal(restored.get(root.taskId).state,'RECONCILING');await delay(60);assert.equal(f.calls.length,1)
  await restored.reconcile({taskId:root.taskId});await until(()=>restored.get(root.taskId).state==='REVIEW_REQUIRED')
  assert.equal(f.calls.filter(c=>c.node==='alpha').length,1);assert.equal(f.calls.filter(c=>c.node==='beta').length,1)
  assert.equal(restored.get(root.taskId).run.deadline,root.run.deadline)
  assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'completed during interruption')
})

test('maintenance drains accepted graph continuations without admitting new graphs',async t=>{
  const gate=deferred(),f=await fixture(t,async({node})=>{if(node==='alpha')await gate.promise})
  const root=await f.submit({nodes:[{id:'alpha',goal:'read',writePaths:[]},{id:'beta',goal:'read next',writePaths:[],dependsOn:['alpha']}]})
  await until(()=>f.calls.length===1)
  let token;try{f.manager.maintenanceBegin();assert.fail('must drain')}catch(error){assert.equal(error.code,'maintenance-busy');token=error.maintenance.token}
  await assert.rejects(f.submit({idempotencyKey:'new-graph'}),{code:'maintenance-draining'})
  gate.resolve();await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED');await until(()=>f.manager.maintenanceStatus().ready)
  assert.equal(f.calls.length,2);f.manager.maintenanceEnd({token})
})

test('parent wall-clock deadline stops its workers without granting a successor a fresh budget',async t=>{
  const never=deferred(),f=await fixture(t,async()=>{await never.promise})
  const root=await f.submit({timeoutMs:1200,nodes:[{id:'alpha',goal:'read',writePaths:[]},{id:'beta',goal:'read next',writePaths:[],dependsOn:['alpha']}]})
  await until(()=>f.manager.get(root.taskId).state==='FAILED')
  assert.equal(f.manager.get(root.taskId).run.cancelReason,'budget-exhausted');assert.ok(f.calls.length<=1)
  assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'a0')
})

test('unknown usage on one worker cannot erase another worker known token budget',async t=>{
  const report=deferred(),never=deferred(),f=await fixture(t,async({node,input})=>{
    if(node==='alpha'){await report.promise;input.onUsage({seq:5,usage:usageFromRecords([{seq:5,type:'assistant/message',data:{usage:{inputTokens:60,outputTokens:1}}}])})}
    await never.promise
  })
  const root=await f.submit({maxObservedTokens:50});await until(()=>f.calls.length===2);report.resolve()
  await until(()=>f.manager.get(root.taskId).state==='FAILED')
  const done=f.manager.get(root.taskId);assert.equal(done.run.cancelReason,'observed-token-budget');assert.equal(done.run.budgetObserved.knownTokens,61)
  assert.equal(done.run.usage.inputTokens,null,'unknown worker metrics remain unknown in aggregate display')
})

test('interrupted integration rolls back only its own unchanged partial writes on cancellation',async t=>{
  const f=await fixture(t,async({input})=>{await writeFile(join(input.cwd,'a.txt'),'new-a');await writeFile(join(input.cwd,'b.txt'),'new-b')})
  f.workspaceService.integrate=async root=>{
    const node=root.workflow.nodes[0],files=node.outputs.files
    await writeFile(join(root.run.workspace.directory,'integration.json'),JSON.stringify({taskId:root.taskId,files,state:'applying'}))
    const first=files[0];await writeFile(join(root.cwd,first.path),await readFile(join(root.run.workspace.directory,'blobs',first.after.hash)))
    throw Object.assign(new Error('simulated write interruption'),{code:'injected-interruption'})
  }
  const root=await f.submit({nodes:[{id:'alpha',goal:'change both',writePaths:['a.txt','b.txt']}]})
  await until(()=>f.manager.get(root.taskId).state==='RECONCILING')
  assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'new-a');assert.equal(await readFile(join(f.cwd,'b.txt'),'utf8'),'b0')
  await f.manager.cancel({taskId:root.taskId});await until(()=>f.manager.get(root.taskId).state==='CANCELLED')
  assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'a0');assert.equal(await readFile(join(f.cwd,'b.txt'),'utf8'),'b0')
})

test('review is performed once after all nodes integrate, not once per worker',async t=>{
  const f=await fixture(t,async({node,input})=>{await writeFile(join(input.cwd,node==='alpha'?'a.txt':'b.txt'),node)})
  const root=await f.submit({review:true});await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED')
  assert.equal(f.reviews,1);assert.ok(f.manager.get(root.taskId).run.reviewIntent)
  const children=f.manager.list({limit:100}).tasks.filter(t=>t.parentTaskId===root.taskId)
  assert.ok(children.every(t=>t.review===false));assert.equal(f.manager.list({rootsOnly:true}).tasks.length,1)
})

test('snapshot maps preserve legitimate filenames that match JavaScript prototype properties',async t=>{
  const f=await fixture(t,async({input})=>{assert.equal(await readFile(join(input.cwd,'constructor'),'utf8'),'keep');await writeFile(join(input.cwd,'__proto__'),'delivered')})
  await writeFile(join(f.cwd,'constructor'),'keep')
  const root=await f.submit({nodes:[{id:'alpha',goal:'create one file',writePaths:['__proto__']}]})
  await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED')
  assert.equal(await readFile(join(f.cwd,'__proto__'),'utf8'),'delivered');assert.equal(await readFile(join(f.cwd,'constructor'),'utf8'),'keep')
})

test('journal-only backup refuses workflow stores instead of claiming complete recovery',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const source=join(dir,'store'),destination=join(dir,'backup'),store=createTaskStore(source)
  store.commit({taskId:'workflow-backup',kind:'workflow',state:'REVIEW_REQUIRED',run:{}},'fixture');store.close()
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/task-data.mjs',import.meta.url)),'backup',source,destination],{encoding:'utf8',windowsHide:true})
  assert.equal(result.status,1);assert.ok(result.stderr.includes('journal-only backup/restore is refused'))
})

test('an unconfirmed persisted Codex review is not automatically charged a second time after restart',async t=>{
  const f=await fixture(t,async()=>{})
  const root=await f.submit({review:true,nodes:[{id:'alpha',goal:'read',writePaths:[]}]})
  await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED')
  const records=f.manager.list({limit:100}).tasks
  const parent=records.find(t=>t.taskId===root.taskId);parent.state='VERIFYING';delete parent.run.review;delete parent.run.endedAt
  const restoredPath=join(f.dir,'review-restored'),saved=createTaskStore(restoredPath)
  records.forEach(record=>saved.commit(record,'fixture.review_interruption'));saved.close();await f.manager.dispose()
  let repeated=0
  const restored=createTaskManager({store:createTaskStore(restoredPath),executor:f.executor,workflowWorkspaces:f.workspaceService,reviewer:async()=>{repeated++;return{verdict:'approve'}}});f.replaceManager(restored)
  await restored.reconcile({taskId:root.taskId});await until(()=>restored.get(root.taskId).state==='REVIEW_REQUIRED')
  assert.equal(repeated,0);assert.equal(restored.get(root.taskId).run.review.verdict,'unavailable')
  assert.equal(restored.get(root.taskId).run.review.reason,'previous-review-unconfirmed')
})

test('explicit cancellation preserves user edits after a partial integration and reports incomplete rollback',async t=>{
  const f=await fixture(t,async({input})=>{await writeFile(join(input.cwd,'a.txt'),'candidate')})
  f.workspaceService.integrate=async root=>{
    const files=root.workflow.nodes[0].outputs.files
    await writeFile(join(root.run.workspace.directory,'integration.json'),JSON.stringify({taskId:root.taskId,files,state:'applying'}))
    await writeFile(join(root.cwd,'a.txt'),'candidate')
    throw Object.assign(new Error('interrupted'),{code:'injected-interruption'})
  }
  const root=await f.submit({nodes:[{id:'alpha',goal:'a',writePaths:['a.txt']}]})
  await until(()=>f.manager.get(root.taskId).state==='RECONCILING')
  await writeFile(join(f.cwd,'a.txt'),'user took over')
  await f.manager.cancel({taskId:root.taskId});await until(()=>f.manager.get(root.taskId).state==='CANCELLED')
  assert.equal(await readFile(join(f.cwd,'a.txt'),'utf8'),'user took over')
  assert.equal(f.manager.get(root.taskId).run.rollbackIncomplete,true)
})


test('visual quality requirements reach isolated nodes and survive node repair',async t=>{
  const f=await fixture(t,async({input,calls})=>{
    assert.ok(input.task.includes('主体特征、姿态'))
    assert.ok(input.task.includes('不运行测试'))
    if(calls.length===1)return{stopReason:'error'}
    await writeFile(join(input.cwd,'a.txt'),'visual done')
  })
  const root=await f.submit({nodes:[{id:'alpha',goal:'draw',writePaths:['a.txt'],qualityProfile:'visual',acceptance:['不运行测试']}]})
  await until(()=>f.manager.get(root.taskId).state==='WORKFLOW_PAUSED')
  await f.manager.repairNode({taskId:root.taskId,nodeId:'alpha',idempotencyKey:'quality-repair'})
  await until(()=>f.manager.get(root.taskId).state==='REVIEW_REQUIRED')
  const node=f.manager.get(root.taskId).workflow.nodes[0]
  assert.equal(f.manager.get(node.childTaskId).qualityProfile,'visual');assert.equal(f.calls.length,2);assert.equal(f.reviews,0)
})
