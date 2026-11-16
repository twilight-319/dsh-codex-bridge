import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createTaskManager} from '../lib/task-manager.js'
import {createTaskStore} from '../lib/task-store.js'
import {taskBudgets} from '../lib/task-budget.js'
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await delay(10)}assert.fail('timeout')}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'bridge-long-')), store=createTaskStore(join(dir,'store'));let resolveExecute,resolveAnswer,executions=0,cancels=0,progress
 const executor={executeTask:async input=>{executions++;progress=input.onProgress;input.onSession?.({sessionId:'session-test',baseline:0});return new Promise(r=>{resolveExecute=r})},execute:async input=>executor.executeTask(input),answerTask:async()=>new Promise(r=>{resolveAnswer=r}),answer:async()=>new Promise(r=>{resolveAnswer=r}),validateAnswer(){},async cancel(){cancels++},async observe(){return{running:false,pendingInput:[]}},async dispose(){}}
 const manager=createTaskManager({store,executor})
 t.after(async()=>{resolveExecute?.({sessionId:'session-test',stopReason:'completed',text:'done'});resolveAnswer?.({sessionId:'session-test',stopReason:'completed',text:'answered'});await delay(10);await manager.dispose();await rm(dir,{recursive:true,force:true})})
 return{dir,store,manager,get executions(){return executions},get answerReady(){return typeof resolveAnswer === 'function'},get cancels(){return cancels},complete:result=>resolveExecute(result??{sessionId:'session-test',stopReason:'completed',text:'done'}),answerComplete:()=>resolveAnswer({sessionId:'session-test',stopReason:'completed',text:'answered'}),progress:v=>progress(v),submit:extra=>manager.submit({goal:'controlled',cwd:dir,idempotencyKey:String(Math.random()),...extra})}
}
test('async defaults30min and explicit >10min accepted; max/legacy stay bounded',async t=>{
 const f=await fixture(t);const a=await f.submit();assert.equal(a.run.budgetMs,1800000);assert.ok(a.run.deadline-a.createdAt>=1799900)
 const b=await f.submit({timeoutMs:3600000});assert.equal(b.run.budgetMs,3600000)
 await assert.rejects(f.submit({timeoutMs:7200001}));await assert.rejects(f.manager.submit({goal:'legacy',cwd:f.dir,idempotencyKey:'legacy',timeoutMs:600001},{legacy:true}))
 assert.throws(()=>taskBudgets({taskDefaultTimeoutMs:5000,taskMaxTimeoutMs:4000}));assert.throws(()=>taskBudgets({taskMaxTimeoutMs:7200001}))
 await f.manager.cancel({taskId:b.taskId});await until(()=>f.executions===1);f.complete();await until(()=>f.manager.get(a.taskId).state==='REVIEW_REQUIRED')
})
test('short wait expiry/cancellation does not cancel or re-dispatch background job',async t=>{
 const f=await fixture(t);const a=await f.submit();await until(()=>f.executions===1);await delay(20);const before=f.manager.get(a.taskId)
 const r=await f.manager.wait({taskId:a.taskId,afterRevision:before.revision,waitMs:10});assert.equal(r.reason,'wait-expired');assert.equal(r.task.state,'RUNNING');assert.equal(f.cancels,0);assert.equal(f.executions,1)
 const abort=new AbortController();abort.abort();await assert.rejects(f.manager.wait({taskId:a.taskId,signal:abort.signal}));assert.equal(f.cancels,0)
 f.complete();await until(()=>f.manager.get(a.taskId).state==='REVIEW_REQUIRED');assert.equal((await f.manager.wait({taskId:a.taskId})).reason,'settled-or-input')
})
test('maintenance closes admission before drain, blocks retry/legacy, never cancels queued tasks',async t=>{
 const f=await fixture(t);const a=await f.submit();await until(()=>f.executions===1);const b=await f.submit();let token
 try{f.manager.maintenanceBegin();assert.fail('must be busy')}catch(e){assert.equal(e.code,'maintenance-busy');token=e.maintenance.token;assert.equal(e.maintenance.ready,false)}
 assert.equal(f.cancels,0);await assert.rejects(f.submit(),{code:'maintenance-draining'});await assert.rejects(f.manager.legacyExecute({task:'legacy',cwd:f.dir}),{code:'maintenance-draining'})
 f.complete();await until(()=>f.executions===2);assert.equal(f.cancels,0);f.complete();await until(()=>f.manager.get(b.taskId).state==='REVIEW_REQUIRED');assert.throws(()=>f.manager.retry({taskId:a.taskId,idempotencyKey:'r'}),{code:'maintenance-draining'})
 const ready=f.manager.maintenanceBegin();assert.equal(ready.ready,true);assert.equal(ready.token,token);assert.throws(()=>f.manager.maintenanceEnd({token:'wrong'}));assert.equal(f.manager.maintenanceEnd({token}).draining,false)
})
test('async answer returns before continuation completes while legacy waits',async t=>{
 const f=await fixture(t);const a=await f.submit();await until(()=>f.executions===1);f.complete({sessionId:'session-test',stopReason:'needs-input',needsInput:{requestId:'q',expiresAt:Date.now()+60000,questions:[{id:'q',question:'?'}]}});await until(()=>f.manager.get(a.taskId).state==='WAITING_INPUT')
 const answered=await f.manager.answer({taskId:a.taskId,runId:a.activeRunId,requestId:'q',answers:[]});assert.equal(answered.state,'RUNNING');f.answerComplete();await until(()=>f.manager.get(a.taskId).state==='REVIEW_REQUIRED')
})
test('legacyAnswer on an async task waits but cannot refresh its deadline',async t=>{
 const f=await fixture(t);const a=await f.submit({timeoutMs:3600000});await until(()=>f.executions===1);f.complete({sessionId:'session-test',stopReason:'needs-input',needsInput:{requestId:'q',expiresAt:Date.now()+60000,questions:[{id:'q',question:'?'}]}});await until(()=>f.manager.get(a.taskId).state==='WAITING_INPUT')
 let returned=false;const answer=f.manager.legacyAnswer({sessionId:'session-test',requestId:'q',answers:[],timeoutMs:2000}).then(r=>{returned=true;return r});await until(()=>f.answerReady);await delay(30);assert.equal(returned,false);assert.equal(f.manager.get(a.taskId).run.deadline,a.run.deadline);f.answerComplete();assert.equal((await answer).stopReason,'completed')
})

test('maintenance racing async admission prevents the late commit',async t=>{
 const f=await fixture(t);const submit=f.submit();const ready=f.manager.maintenanceBegin();assert.equal(ready.ready,true);await assert.rejects(submit,{code:'maintenance-draining'});assert.equal(f.manager.list().tasks.length,0);f.manager.maintenanceEnd({token:ready.token})
})

test('progress is actual forward sequence only and preserves concurrent cancel intent',async t=>{
 const f=await fixture(t);const a=await f.submit();await until(()=>f.executions===1);f.progress({seq:10,eventType:'tool/result',observedAt:Date.now(),lastActivityAt:Date.now(),timeSource:'first-observed-local'});assert.equal(f.manager.get(a.taskId).run.progress.seq,10);const rev=f.manager.get(a.taskId).revision;f.progress({seq:9,eventType:'old'});assert.equal(f.manager.get(a.taskId).revision,rev);await f.manager.cancel({taskId:a.taskId});const cancelled=f.manager.get(a.taskId);assert.equal(cancelled.run.cancelReason,'user');f.progress({seq:11,eventType:'tool/result',lastActivityAt:Date.now()});assert.equal(f.manager.get(a.taskId).run.cancelReason,'user');assert.ok(f.manager.get(a.taskId).revision>=cancelled.revision);f.complete();await until(()=>f.manager.get(a.taskId).state==='REVIEW_REQUIRED')
})
