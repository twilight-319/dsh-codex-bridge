import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskStore } from '../lib/task-store.js'
import { createTaskManager } from '../lib/task-manager.js'
import { deliveryView, executionMode, executionPrompt } from '../lib/task-delivery.js'
import { usageFromRecords, mergeUsage, usageBudgetBound, addUsageBounds, retainUsageBound } from '../lib/task-usage.js'

const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(fn) { for (let i=0;i<300;i++) { if(fn()) return; await delay(10) } assert.fail('fixture timeout') }
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'bridge-efficient-')),store=createTaskStore(join(dir,'store'))
  let input,resolve,reviewCalls=0,calls=0,cancels=0
  const executor={
    async executeTask(value){calls++;input=value;value.onSession?.({sessionId:'session-efficient',baseline:0});return new Promise(r=>{resolve=r})},
    async answerTask(value){calls++;input=value;return new Promise(r=>{resolve=r})},
    validateAnswer(){},async cancel(){cancels++},async observe(){return{running:false,pendingInput:[]}},async dispose(){},
  }
  const manager=createTaskManager({store,executor,reviewer:async()=>{reviewCalls++;return{verdict:'approve',usage:{input_tokens:31,cached_input_tokens:20,output_tokens:7}}}})
  t.after(async()=>{resolve?.({sessionId:'session-efficient',stopReason:'completed',text:'done'});await delay(25);await manager.dispose();await rm(dir,{recursive:true,force:true})})
  return{dir,manager,store,get input(){return input},get calls(){return calls},get cancels(){return cancels},get reviewCalls(){return reviewCalls},complete(result={}){resolve({sessionId:'session-efficient',stopReason:'completed',text:'done',...result})},submit(extra={}){return manager.submit({goal:'only requested output',cwd:dir,idempotencyKey:'one',...extra})}}
}

test('one long observation survives progress revisions and settles on real completion',async t=>{
  const f=await fixture(t),task=await f.submit();await until(()=>f.calls===1)
  let returned=false
  const pending=f.manager.await({taskId:task.taskId,waitMs:60000}).then(r=>{returned=true;return r})
  f.input.onProgress({seq:10,eventType:'tool/result',lastActivityAt:Date.now()})
  await delay(70);assert.equal(returned,false,'progress must not wake the calling model')
  assert.equal(f.manager.get(task.taskId).run.progress.seq,10)
  f.complete();const result=await pending
  assert.equal(result.task.run.result.stopReason,'completed');assert.equal(result.task.run.coordination.awaitCalls,1)
  assert.equal(f.calls,1);assert.equal(f.cancels,0);assert.equal(f.reviewCalls,0)
  assert.ok(result.task.run.timing.executionMs>=0);assert.ok(result.task.run.timing.verificationMs>=0)
})

test('expiry, observer abort and old short waits never cancel or resubmit work',async t=>{
  const f=await fixture(t),task=await f.submit();await until(()=>f.calls===1)
  assert.equal((await f.manager.await({taskId:task.taskId,waitMs:5})).reason,'wait-expired')
  const abort=new AbortController(),pending=f.manager.await({taskId:task.taskId,waitMs:60000,signal:abort.signal})
  abort.abort();await assert.rejects(pending)
  const before=f.manager.get(task.taskId)
  const short=f.manager.wait({taskId:task.taskId,afterRevision:before.revision,waitMs:1000})
  f.input.onProgress({seq:10,eventType:'tool/result'})
  assert.equal((await short).reason,'changed');assert.equal(f.calls,1);assert.equal(f.cancels,0)
  await assert.rejects(f.manager.await({taskId:task.taskId,waitMs:600001}))
})

test('questions, approvals and uncertain execution are actionable',async t=>{
  for(const stopReason of ['needs-input','input-required','error']){
    const f=await fixture(t),task=await f.submit();await until(()=>f.calls===1)
    f.complete({stopReason,needsInput:stopReason==='needs-input'?{requestId:'q',questions:[{id:'q',question:'choose'}]}:undefined})
    await until(()=>['WAITING_INPUT','WAITING_APPROVAL','FAILED','RECONCILING'].includes(f.manager.get(task.taskId).state))
    const r=await f.manager.await({taskId:task.taskId,waitMs:60000});assert.equal(r.reason,'settled-or-input')
    if(stopReason==='needs-input')assert.equal(deliveryView('await',r).task.question.requestId,'q')
  }
})

test('mode controls actual review and passes supplied plan and criteria to DSH',async t=>{
  for(const mode of ['direct','planned','reviewed']){
    const f=await fixture(t),task=await f.submit({executionMode:mode,...(mode==='planned'?{plan:'use existing helper'}:{}),acceptance:['do not run tests']})
    await until(()=>f.calls===1);assert.ok(f.input.task.includes('do not run tests'))
    if(mode==='planned')assert.ok(f.input.task.includes('use existing helper'))
    f.complete();const done=(await f.manager.await({taskId:task.taskId,waitMs:1000})).task
    assert.equal(f.reviewCalls,mode==='reviewed'?1:0)
    if(mode==='reviewed')assert.equal(deliveryView('get',done).codexReviewUsage.input_tokens,31)
  }
  assert.throws(()=>executionMode({executionMode:'direct',review:true}));assert.throws(()=>executionMode({executionMode:'planned'}))
  assert.throws(()=>executionMode({executionMode:'direct',plan:'hidden work'}))
  assert.throws(()=>executionPrompt({goal:'x'.repeat(19999),acceptance:['overflow']}))
})

test('same-key replay remains one task and mode change is an idempotency conflict',async t=>{
  const f=await fixture(t),first=await f.submit({executionMode:'direct'})
  assert.equal((await f.submit({executionMode:'direct'})).taskId,first.taskId)
  await assert.rejects(f.submit({executionMode:'reviewed'}),{code:'idempotency-conflict'})
  await until(()=>f.calls===1);assert.equal(f.calls,1)
})

test('compact delivery excludes context and preserves actionable evidence with full opt-in',()=>{
  const task={taskId:'t',activeRunId:'r',state:'REVIEW_REQUIRED',revision:9,goal:'private repeated goal',requestedInput:{large:'x'.repeat(20000)},history:[{result:{text:'old'}}],run:{sessionId:'s',result:{stopReason:'completed',text:'z'.repeat(5000)},before:{diff:'private diff'},verification:{status:'not_configured'},tuning:{resolved:{execution:{selection:{provider:'p',model:'m'}}},observed:{status:'request-confirmed',matches:true}}}}
  const summary=deliveryView('get',task)
  assert.equal(summary.executionCompleted,true);assert.equal(summary.verification,'not_configured');assert.equal(summary.textTruncated,true)
  assert.equal(summary.text.length,4000);assert.equal(summary.goal,undefined);assert.equal(summary.run,undefined)
  assert.ok(JSON.stringify(summary).length<5000);assert.equal(deliveryView('get',task,'full'),task)
  assert.equal(deliveryView('list',{tasks:[task],nextCursor:null}).tasks[0].taskId,'t')
})

test('usage deduplicates records and preserves disjoint cache counts and unknowns',()=>{
  const first={event:{seq:11,type:'assistant/message',data:{usage:{inputTokens:100,cacheReadTokens:900,cacheWriteTokens:0,outputTokens:20,totalTokens:1020}}}}
  const second={event:{seq:12,type:'assistant/message',data:{usage:{inputTokens:50,cacheReadTokens:450,cacheWriteTokens:0,outputTokens:10,totalTokens:510}}}}
  const totals=usageFromRecords([first,first,second])
  assert.equal(totals.modelCalls,2);assert.equal(totals.inputTokens,150);assert.equal(totals.cacheReadTokens,1350);assert.equal(totals.totalTokens,1530)
  assert.equal(totals.reasoningTokens,null);assert.equal(totals.cost,null)
  const partial=usageFromRecords([first,{event:{seq:13,type:'assistant/attempt',data:{}}}])
  assert.equal(partial.status,'partial');assert.equal(partial.callsWithUsage,1);assert.equal(usageFromRecords([]).inputTokens,null)
  assert.equal(mergeUsage(totals,usageFromRecords([second])).inputTokens,200)
})

test('progress snapshots do not double-charge usage and answers add only new work',async t=>{
  const f=await fixture(t),task=await f.submit();await until(()=>f.calls===1)
  const first=usageFromRecords([{seq:10,type:'assistant/message',data:{usage:{inputTokens:20,outputTokens:2,cacheReadTokens:10}}}])
  f.input.onUsage({seq:10,usage:first});f.input.onUsage({seq:10,usage:first})
  f.complete({stopReason:'needs-input',needsInput:{requestId:'q',expiresAt:Date.now()+60000,questions:[{id:'q',question:'?'}]},usage:first})
  await until(()=>f.manager.get(task.taskId).state==='WAITING_INPUT');await until(()=>f.manager.maintenanceStatus().jobs===0)
  const waiting=f.manager.get(task.taskId)
  await f.manager.answer({taskId:task.taskId,runId:waiting.activeRunId,requestId:'q',answers:[]});await until(()=>f.calls===2)
  const second=usageFromRecords([{seq:20,type:'assistant/message',data:{usage:{inputTokens:30,outputTokens:3,cacheReadTokens:15}}}])
  f.input.onUsage({seq:20,usage:second});f.complete({usage:second})
  const done=(await f.manager.await({taskId:task.taskId,waitMs:1000})).task
  assert.equal(done.run.usage.inputTokens,50);assert.equal(done.run.usage.modelCalls,2)
  assert.equal(f.store.get(task.taskId).run.usage.inputTokens,50);assert.ok(done.run.timing.humanWaitingMs>=0)
  assert.equal(done.run.budgetUsage.inputTokens,50)
})

test('partial recovered windows retain observed budget bounds without inventing complete counters',()=>{
  const first=usageFromRecords([{seq:1,type:'assistant/message',data:{usage:{inputTokens:100,outputTokens:10}}}])
  const saved=retainUsageBound(null,usageBudgetBound(first))
  const recovered=usageFromRecords([{seq:2,type:'assistant/message',data:{usage:{inputTokens:20,outputTokens:2}}}])
  const bound=retainUsageBound(saved,usageBudgetBound(recovered))
  assert.equal(bound.inputTokens,100);assert.equal(bound.cacheReadTokens,0)
  assert.equal(recovered.cacheReadTokens,null,'display retains unknown cache accounting')
  const next=retainUsageBound(bound,addUsageBounds(bound,{modelCalls:1,inputTokens:30,outputTokens:3}))
  assert.equal(next.inputTokens,130);assert.equal(next.modelCalls,2)
})
