// Strict host-contract regressions for RETEST R01/R02/R03. No real model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
if (!process.argv.includes('--child')) {
 const home=mkdtempSync(join(tmpdir(),'bridge-retest-home-'))
 try { const r=spawnSync(process.execPath,[import.meta.filename,'--child'],{env:{...process.env,HOME:home,USERPROFILE:home},stdio:'inherit',timeout:40000});if(r.error)throw r.error;process.exitCode=r.status??1 }
 finally {rmSync(home,{recursive:true,force:true})}
} else {
 const {createExecutor}=await import('../lib/session-executor.js')
 const {createTaskManager}=await import('../lib/task-manager.js')
 const {createTaskStore}=await import('../lib/task-store.js')
 const delay=ms=>new Promise(r=>setTimeout(r,ms))
 async function until(predicate){for(let i=0;i<400;i++){if(predicate())return;await delay(10)}assert.fail('did not settle')}
 const hostResult=(reason='aborted')=>({sessionId:'session-native',stopReason:reason,text:reason==='completed'?'done':''})
 const observation=(reason='aborted',running=false)=>({running,pendingInput:[],questionPending:false,result:hostResult(reason)})
 async function seeded(t,{reason='user',state='RECONCILING',observe=async()=>observation(),cancel=async()=>{},run={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'bridge-retest-')),store=createTaskStore(join(dir,'store'))
  const seed={taskId:'task-seed',activeRunId:'run-seed',cwd:dir,goal:'fixture',state,revision:1,createdAt:Date.now(),run:{runId:'run-seed',dispatchIntent:true,baseline:0,sessionId:'session-native',cancelRequestedAt:Date.now(),cancelReason:reason,deadline:Date.now()+60000,verification:{status:'pending'},...run}}
  store.commit(seed, seed.run.cancelReason ? 'run.cancel_requested' : 'fixture.external_end')
  let cancelCalls=0,executeCalls=0
  const executor={async observe(...args){return observe(...args)},async cancel(...args){cancelCalls++;return cancel(...args)},async execute(){executeCalls++;return hostResult('completed')},async dispose(){}}
  const manager=createTaskManager({store,executor})
  t.after(async()=>{await manager.dispose();await rm(dir,{recursive:true,force:true})})
  return {manager,store,dir,taskId:seed.taskId,cancels:()=>cancelCalls,executions:()=>executeCalls}
 }
 test('R01 persisted user cancellation plus native aborted is CANCELLED/cancelled',async t=>{
  const f=await seeded(t)
  const result=await f.manager.reconcile({taskId:f.taskId})
  assert.equal(result.state,'CANCELLED');assert.equal(result.run.outcome,'cancelled')
  assert.equal(result.run.result.stopReason,'cancelled')
  assert.equal(result.run.hostStopReason,'aborted')
 })
 test('R01 waiting-budget intent plus native aborted remains FAILED/budget-exhausted',async t=>{
  const f=await seeded(t,{reason:'budget-exhausted'})
  const result=await f.manager.reconcile({taskId:f.taskId})
  assert.equal(result.state,'FAILED');assert.equal(result.run.outcome,'budget-exhausted')
  assert.equal(result.run.result.stopReason,'timeout');assert.equal(result.run.hostStopReason,'aborted')
 })
 test('R03 replay persisted cancellation after crash before delivery; never replay the task',async t=>{
  let running=true
  const f=await seeded(t,{observe:async()=>running?{running:true,pendingInput:[]}:observation(),cancel:async()=>{running=false}})
  const result=await f.manager.reconcile({taskId:f.taskId})
  assert.equal(f.cancels(),1);assert.equal(f.executions(),0);assert.equal(result.state,'CANCELLED')
 })
 test('R02 TaskManager plus real createExecutor preserves running budget intent and raw aborted',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-native-budget-')),store=createTaskStore(join(dir,'store'))
  const id='session-'+randomUUID();let running=false,records=[],nativeCancels=0,manager,intentAtAbort
  const service={
   async create(){return {sessionId:id}},
   async state(_,signal){signal.throwIfAborted();return {cursor:records.length,running,pendingInput:[]}},
   async prompt(_,signal){signal.throwIfAborted();running=true},
   async wait(_,signal){signal.throwIfAborted();return new Promise((_,no)=>signal.addEventListener('abort',()=>{intentAtAbort=store.list()[0]?.run.cancelReason;no(signal.reason)},{once:true}))},
   async events(_,signal){signal.throwIfAborted();return {records}},
   async cancel(){nativeCancels++;running=false;records=[{event:{seq:1,type:'turn/end',data:{reason:{kind:'aborted'}}}}]},
  }
  const executor=createExecutor({ctx:{sessionController:service}})
  manager=createTaskManager({store,executor})
  t.after(async()=>{await manager.dispose();await rm(dir,{recursive:true,force:true})})
  const task=await manager.submit({goal:'run until deadline',cwd:dir,idempotencyKey:'running-budget',timeoutMs:1000})
  await until(()=>['FAILED','CANCELLED','RECONCILING'].includes(manager.get(task.taskId).state))
  if(manager.get(task.taskId).state==='RECONCILING')await manager.reconcile({taskId:task.taskId})
  const done=manager.get(task.taskId)
  assert.equal(intentAtAbort,'budget-exhausted');assert.ok(nativeCancels>0);assert.equal(done.state,'FAILED');assert.equal(done.run.cancelReason,'budget-exhausted')
  assert.equal(done.run.outcome,'budget-exhausted');assert.equal(done.run.result.stopReason,'timeout');assert.equal(done.run.hostStopReason,'aborted')
 })
 test('completed wins cancellation/budget races and preserves native fact',async t=>{
  for(const reason of ['user','budget-exhausted']){
   const f=await seeded(t,{reason,observe:async()=>observation('completed')})
   const result=await f.manager.reconcile({taskId:f.taskId})
   assert.equal(result.state,'REVIEW_REQUIRED');assert.equal(result.run.outcome,'completed')
   assert.equal(result.run.hostStopReason,'completed');assert.equal(f.cancels(),0)
  }
 })
 test('native aborted without cancellation intent is not labelled user cancellation',async t=>{
  const f=await seeded(t,{reason:null,run:{cancelRequestedAt:undefined}})
  const result=await f.manager.reconcile({taskId:f.taskId})
  assert.equal(result.state,'FAILED');assert.equal(result.run.outcome,'aborted');assert.equal(f.cancels(),0)
 })
 test('recovered cancellation retries delivery failure and clears it only after an acknowledgement',async t=>{
  let running=true,fail=true
  const f=await seeded(t,{observe:async()=>running?{running:true,pendingInput:[]}:observation(),cancel:async()=>{if(fail)throw Object.assign(new Error('cancel transport failed'),{code:'native-cancel-failed'});running=false}})
  const first=await f.manager.reconcile({taskId:f.taskId})
  assert.equal(first.state,'RECONCILING');assert.equal(first.run.cancelError.code,'native-cancel-failed');assert.equal(first.run.cancelAttempts,1)
  fail=false
  const next=await f.manager.reconcile({taskId:f.taskId})
  assert.equal(next.state,'CANCELLED');assert.equal(next.run.cancelAttempts,2);assert.equal(next.run.cancelError,undefined)
  assert.ok(next.run.cancelSentAt);assert.equal(f.executions(),0)
 })
 test('concurrent reconciles coalesce cancellation delivery to the same Run',async t=>{
  let running=true
  const f=await seeded(t,{observe:async()=>{await delay(5);return running?{running:true,pendingInput:[]}:observation()},cancel:async()=>{await delay(15);running=false}})
  const tasks=await Promise.all(Array.from({length:4},()=>f.manager.reconcile({taskId:f.taskId})))
  assert.ok(tasks.every(r=>r.state==='CANCELLED'));assert.equal(f.cancels(),1)
 })
 test('cancellation replay holds queued project work until the host confirms stopped',async t=>{
  let running=true,release
  const gate=new Promise(r=>release=r)
  const f=await seeded(t,{observe:async()=>running?observation('aborted',true):observation(),cancel:async()=>{await gate;running=false}})
  const queued=await f.manager.submit({goal:'next',cwd:f.dir,idempotencyKey:'next'})
  const recovery=f.manager.reconcile({taskId:f.taskId})
  await until(()=>f.cancels()===1)
  assert.equal(f.manager.get(queued.taskId).state,'QUEUED');assert.equal(f.executions(),0)
  release();assert.equal((await recovery).state,'CANCELLED')
  await until(()=>f.manager.get(queued.taskId).state==='REVIEW_REQUIRED')
  assert.equal(f.executions(),1)
 })
 test('unconfirmed native aborted never releases the project even with a cancel acknowledgement',async t=>{
  const f=await seeded(t,{observe:async()=>observation('aborted',true)})
  const current=await f.manager.reconcile({taskId:f.taskId})
  assert.equal(current.state,'RECONCILING');assert.equal(current.run.hostStopReason,'aborted');assert.equal(f.cancels(),1)
  await assert.rejects(f.manager.retry({taskId:f.taskId,idempotencyKey:'unsafe'}),{code:'task-busy'})
 })
 test('actual executor cancellation is bounded even if native cancel ignores its signal',async t=>{
  const id='session-'+randomUUID();let hang=false,receivedSignal
  const service={async create(){return {sessionId:id}},async prompt(){},async state(_,signal){signal.throwIfAborted();return {cursor:0,running:false,pendingInput:[]}},async wait(){return {output:{records:[{event:{seq:1,type:'turn/end',data:{reason:{kind:'completed'}}}}]}}},async events(){return {records:[]}},async cancel(_,signal){receivedSignal=signal;if(hang)return new Promise(()=>{})}}
  const executor=createExecutor({ctx:{sessionController:service}});t.after(()=>executor.dispose())
  await executor.execute({task:'fixture',timeoutMs:1000});hang=true
  await assert.rejects(executor.cancel(id,{timeoutMs:20}),{code:'cancel-timeout'})
  assert.ok(receivedSignal.aborted)
 })
 test('upgrade corrects proven old FAILED/aborted attribution without executing again',async t=>{
  const f=await seeded(t,{state:'FAILED',reason:'user',run:{outcome:'aborted',result:hostResult(),observation:observation()}})
  const task=f.manager.get(f.taskId)
  assert.equal(task.state,'CANCELLED');assert.equal(task.run.outcome,'cancelled');assert.equal(task.run.hostStopReason,'aborted');assert.equal(f.cancels(),0)
 })

}
