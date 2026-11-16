import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createExecutionPolicy,resolvePolicy} from '../lib/execution-policy.js'
import {createTaskManager} from '../lib/task-manager.js'
import {createTaskStore} from '../lib/task-store.js'
import {createTaskTuner,normalizeTuning,historyBudget,tuningConfig} from '../lib/task-tuning.js'
const catalog={default:{provider:'p',model:'a',reasoningEffort:'high'},groups:[{id:'p',name:'P',models:[{id:'a',name:'A',reasoning:{efforts:[{id:'high',name:'High'},{id:'max',name:'Max'}],defaultEffort:'high'}},{id:'b',name:'B',reasoning:{efforts:[{id:'low',name:'Low'}],defaultEffort:'low'}}]}],routableProviders:['p'],failures:[]}
const models=[{provider:'p',model:'a',effortMode:'adaptive',allowedEfforts:['high','max'],defaultEffort:'high',objective:{priority:'quality',autoAllowed:true,efforts:{quality:'max'}}},{provider:'p',model:'b',effortMode:'fixed',fixedEffort:'low',objective:{priority:'speed',autoAllowed:true}}]
const delay=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){for(let i=0;i<300;i++){if(fn())return;await delay(10)}assert.fail('timeout')}
async function policyFixture(t){const dir=await mkdtemp(join(tmpdir(),'bridge-tuning-'));let selected;const p=createExecutionPolicy({file:join(dir,'policy.json'),ctx:{sessionController:{async modelCatalog(){return structuredClone(catalog)},async resolveAgent(){return{agent:{model:{select(s){selected=s},current(){return selected}}}}}},llm:{async resolveCallConfig(){return{}}}}});t.after(async()=>{await t.manager?.dispose();await rm(dir,{recursive:true,force:true})});await p.save({expectedRevision:0,modelMode:'pool',permissionMode:'inherit',models});return{dir,p}}
test('pool saves exact two routes, rejects duplicates/third/unsupported and never writes default',async t=>{
 const{p}=await policyFixture(t);const state=await p.snapshot();assert.equal(state.policy.models.length,2);assert.equal((await p.resolveExecution({provider:'p',model:'a',reasoningEffort:'max'})).selection.reasoningEffort,'max')
 await assert.rejects(p.resolveExecution({provider:'q',model:'a'}));await assert.rejects(p.save({expectedRevision:1,modelMode:'pool',permissionMode:'inherit',models:[models[0],models[0]]}));await assert.rejects(p.save({expectedRevision:1,modelMode:'pool',permissionMode:'inherit',models:[...models,models[0]]}));await assert.rejects(p.save({expectedRevision:1,modelMode:'pool',permissionMode:'inherit',models:[{...models[0],allowedEfforts:['x'],defaultEffort:'x'}]}))
 const resolved=await p.resolveExecution({provider:'p',model:'a',reasoningEffort:'max'});await p.validateFrozen(resolved);const receipt=await p.apply('session-test',resolved.selection);assert.equal(receipt.observed.status,'configuration-confirmed');assert.equal(receipt.observed.matches,true)
 await p.save({expectedRevision:1,modelMode:'pool',permissionMode:'inherit',models:[models[1]]});await assert.rejects(p.validateFrozen(resolved))
})
test('manual/auto is per parameter and cold-start tags respect capabilities',async t=>{
 const{p}=await policyFixture(t);const tuner=createTaskTuner({policy:p,budgets:{taskDefaultTimeoutMs:1800000,taskMaxTimeoutMs:7200000}})
 const quality=await tuner.resolve({tuning:{modelMode:'auto',effortMode:'auto',timeoutMode:'auto',objective:'quality',taskClass:'backend-change'}},{cwd:'x',profile:null});assert.deepEqual(quality.resolved.execution.selection,{provider:'p',model:'a',reasoningEffort:'max'});assert.equal(quality.resolved.sources.effort,'user-rule');assert.equal(quality.suggested.timeout.reason,'insufficient-samples')
 const speed=await tuner.resolve({tuning:{modelMode:'auto',effortMode:'auto',objective:'speed'}},{cwd:'x',profile:null});assert.equal(speed.resolved.execution.selection.model,'b');assert.equal(speed.resolved.execution.selection.reasoningEffort,'low')
 assert.throws(()=>normalizeTuning({reasoningEffort:'max',tuning:{effortMode:'auto'}}));assert.throws(()=>normalizeTuning({tuning:{timeoutMode:'manual'}}));assert.throws(()=>normalizeTuning({provider:'p'}))
 await assert.rejects(tuner.resolve({provider:'p',model:'b',reasoningEffort:'max'},{cwd:'x'}))
})
test('history groups isolate projects, count families once, separate verified and censor timeouts',async t=>{
 const{p}=await policyFixture(t),execution=await p.resolveExecution({provider:'p',model:'a',reasoningEffort:'max'}),config=tuningConfig({minSamples:2}),input={cwd:'x',execution,taskClass:'backend',profile:null,config,fallback:1800000,maximum:7200000};const group=historyBudget([],input).summary.group
 const now=Date.now(),run=(ms)=>({tuning:{group,applied:{status:'applied'},observed:{status:'request-confirmed',matches:true}},endedAt:now,result:{stopReason:'completed'},timing:{totalMs:ms},verification:{status:'unavailable'}})
 const tasks=[{cwd:'x',createdAt:now,run:run(10000),history:[run(9000)]},{cwd:'x',createdAt:now-1,run:{...run(20000),verification:{status:'passed'}}},{cwd:'other',createdAt:now,run:run(1)}]
 const r=historyBudget(tasks,input);assert.equal(r.source,'history');assert.equal(r.value,24000);assert.equal(r.summary.completedSamples,2);assert.equal(r.summary.verifiedSamples,1)
 tasks.push({cwd:'x',createdAt:now,run:{tuning:{group},endedAt:now,cancelReason:'budget-exhausted',timing:{totalMs:1000}}});assert.equal(historyBudget(tasks,input).reason,'censored-ratio-high');for(let i=0;i<50;i++)tasks.push({cwd:'x',createdAt:now,run:{...run(10),tuning:{group,observed:{status:'unknown'}}}});const excluded=historyBudget(tasks,input);assert.equal(excluded.reason,'censored-ratio-high');assert.equal(excluded.summary.censorPopulation,3)
})
test('preview read-only, explicit max freezes, defaults/history do not change idempotency',async t=>{
 const{p,dir}=await policyFixture(t);let input;const store=createTaskStore(join(dir,'store'));const manager=createTaskManager({store,executionPolicy:p,executor:{async executeTask(i){input=i;i.onSession({sessionId:'s',baseline:0,execution:{...i.frozenExecution,application:{status:'applied',observed:{status:'configuration-confirmed'}}}});i.onEvidence({status:'request-confirmed',selection:i.frozenExecution.selection,seq:10});return{sessionId:'s',stopReason:'completed',text:'ok',execution:i.frozenExecution}},async dispose(){},async cancel(){},async observe(){return{running:false,pendingInput:[]}}}});t.manager=manager
 const raw={goal:'g',cwd:dir,idempotencyKey:'k',timeoutMs:60000,reasoningEffort:'max',reason:'cross module'};await manager.preview(raw);assert.equal(store.list().length,0)
 const[a,b]=await Promise.all([manager.submit(raw),manager.submit(raw)]);assert.equal(a.taskId,b.taskId);await until(()=>manager.get(a.taskId).state==='REVIEW_REQUIRED');const done=manager.get(a.taskId);assert.equal(input.frozenExecution.selection.reasoningEffort,'max');assert.equal(done.run.tuning.observed.status,'request-confirmed');assert.equal(done.run.tuning.observed.matches,true)
 const changedBudgetStore=createTaskStore(join(dir,'smaller-store'));const old=store.get(a.taskId);changedBudgetStore.commit(old,'fixture.import');const smaller=createTaskManager({store:changedBudgetStore,taskDefaultTimeoutMs:1000,taskMaxTimeoutMs:1000,executor:{async dispose(){}}});assert.equal((await smaller.submit(raw)).taskId,a.taskId);await smaller.dispose();
 await p.save({expectedRevision:1,modelMode:'pool',permissionMode:'inherit',models:[models[1]]});assert.equal((await manager.submit(raw)).taskId,a.taskId);await assert.rejects(manager.retry({taskId:a.taskId,idempotencyKey:'r'}));await assert.rejects(manager.submit({...raw,reason:'different'}),{code:'idempotency-conflict'})
})
