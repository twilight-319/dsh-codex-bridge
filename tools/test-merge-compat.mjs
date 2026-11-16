import test from'node:test'
import assert from'node:assert/strict'
import{mkdtemp,rm,symlink}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{createTaskManager}from'../lib/task-manager.js'
import{createTaskStore,digest}from'../lib/task-store.js'
import{historyBudget,tuningConfig}from'../lib/task-tuning.js'
const canonical=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
const executor={async dispose(){},async observe(){return{running:false,pendingInput:[]}}}
test('v2 receipt aliases preserve original task and conflicting aliases reject',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'merge-receipt-'));let m
 try{const store=createTaskStore(join(dir,'store')),raw={goal:'same',cwd:dir,idempotencyKey:'receipt',reasoningEffort:'max'};const original={taskId:'old',cwd:dir,goal:'same',activeRunId:'r',state:'REVIEW_REQUIRED',revision:1,createdAt:1,submissionKey:'other-primary',submissionKeyAliases:[digest({cwd:dir,key:'receipt'})],requestHashVersion:2,requestedInput:raw,payloadHash:digest(canonical(raw)),run:{runId:'r',budgetMs:60000}}
 store.commit(original,'fixture');m=createTaskManager({store,executor});assert.equal((await m.submit(raw)).taskId,'old');await assert.rejects(m.submit({...raw,reasoningEffort:'high'}),{code:'idempotency-conflict'});store.commit({...original,taskId:'collision'},'fixture');await assert.rejects(m.submit(raw),{code:'idempotency-ambiguous'})
 }finally{await m?.dispose();await rm(dir,{recursive:true,force:true})}
})
test('beta hash2 survives canonical path alias without changing original hash',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'merge-hash2-')),alias=dir+'-alias';let m
 try{await symlink(dir,alias,process.platform==='win32'?'junction':'dir');const store=createTaskStore(join(dir,'store'));const raw={goal:'same',cwd:dir,idempotencyKey:'key',timeoutMs:120000};const old={taskId:'old',cwd:dir,goal:'same',activeRunId:'r',state:'REVIEW_REQUIRED',revision:1,createdAt:1,submissionKey:digest({cwd:dir,key:'key'}),requestHashVersion:2,requestedInput:raw,payloadHash:digest(canonical(raw)),run:{runId:'r',budgetMs:120000}};store.commit(old,'fixture');m=createTaskManager({store,executor});assert.equal((await m.submit({...raw,cwd:alias})).taskId,'old');assert.equal(m.get('old').payloadHash,old.payloadHash);await assert.rejects(m.submit({...raw,cwd:alias,timeoutMs:119000}),{code:'idempotency-conflict'})
 }finally{await m?.dispose();await rm(alias,{force:true});await rm(dir,{recursive:true,force:true})}
})
test('old tuning group retains success and censor families without rewriting',()=>{
 const cwd=process.cwd(),execution={selection:{provider:'p',model:'m',reasoningEffort:'max'}},taskClass='test',profile=null,oldGroup=digest({cwd,selection:execution.selection,taskClass,profile}),now=Date.now();const r={tuning:{group:oldGroup,resolved:{execution},requested:{tuning:{taskClass}},observed:{status:'request-confirmed',matches:true}},endedAt:now,timing:{totalMs:10000},result:{stopReason:'completed'},verification:{status:'passed'}}
 const tasks=[{cwd,createdAt:now,profile,run:r},{cwd,createdAt:now-1,profile,run:{...r,timing:{totalMs:20000}},history:[{...r,cancelReason:'budget-exhausted',result:{stopReason:'timeout'}}]}];const result=historyBudget(tasks,{cwd,execution,taskClass,profile,config:tuningConfig({minSamples:2}),fallback:1800000,maximum:7200000});assert.equal(result.summary.completedSamples,2);assert.equal(result.summary.censoredFamilies,1);assert.equal(result.summary.censorPopulation,2);assert.equal(result.reason,'censored-ratio-high');assert.equal(r.tuning.group,oldGroup)
})
test('legacy import refuses residual adapter activity and active maintenance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'merge-import-'));let activity=1;const m=createTaskManager({store:createTaskStore(dir),executor:{...executor,activity:()=>({calls:activity})}})
 try{assert.throws(()=>m.importLegacy([]),{code:'migration-busy'});activity=0;const ready=m.maintenanceBegin();assert.throws(()=>m.importLegacy([]),{code:'migration-busy'});m.maintenanceEnd({token:ready.token});assert.equal(m.importLegacy([]).imported,0)}finally{await m.dispose();await rm(dir,{recursive:true,force:true})}
})
