import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createTaskStore,digest} from '../lib/task-store.js'
import {createTaskManager} from '../lib/task-manager.js'
import {inspectTaskData,collectTaskDiagnostics} from '../lib/task-diagnostics.js'
import {createTaskBrowserApi} from '../lib/task-browser-api.js'
const delay=()=>new Promise(r=>setTimeout(r,10))
const root=new URL('..',import.meta.url)
const cmd=(file,args)=>spawnSync(process.execPath,[file,...args],{cwd:root,encoding:'utf8'})
const sum=dir=>Object.fromEntries(fs.readdirSync(dir).map(n=>[n,digest(fs.readFileSync(join(dir,n)))]))
test('doctor is read-only for missing, healthy, locked and incomplete task stores',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-doctor-'))
 try{
  const missing=join(dir,'missing');assert.equal(inspectTaskData(missing).status,'missing');assert.ok(!fs.existsSync(missing))
  const store=createTaskStore(join(dir,'data'));store.commit({taskId:'t',run:{},state:'FAILED'},'fixture')
  const before=sum(join(dir,'data'));assert.equal(inspectTaskData(join(dir,'data')).writerLocked,true)
  const report=cmd('bin/doctor.mjs',['--directory',join(dir,'data')]);assert.equal(report.status,0)
  assert.deepEqual(sum(join(dir,'data')),before);store.close()
  fs.appendFileSync(join(dir,'data/events.jsonl'),'{tail')
  const broken=sum(join(dir,'data'));assert.equal(inspectTaskData(join(dir,'data')).status,'incomplete-tail')
  assert.deepEqual(sum(join(dir,'data')),broken)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('offline backup and restore validate data and refuse writers, overwrites and bad manifests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-backup-'))
 try{
  const source=join(dir,'source'),backup=join(dir,'backup'),destination=join(dir,'restored')
  const store=createTaskStore(source);store.commit({taskId:'t',state:'FAILED',run:{},goal:'restore me'},'fixture');store.checkpoint()
  assert.notEqual(cmd('bin/task-data.mjs',['backup',source,backup]).status,0);store.close()
  assert.equal(cmd('bin/task-data.mjs',['backup',source,backup]).status,0)
  assert.equal(cmd('bin/task-data.mjs',['restore',backup,destination]).status,0)
  const reopened=createTaskStore(destination);assert.equal(reopened.get('t').goal,'restore me');reopened.close()
  assert.notEqual(cmd('bin/task-data.mjs',['restore',backup,destination]).status,0)
  fs.appendFileSync(join(backup,'snapshot.json'),'tampered')
  assert.notEqual(cmd('bin/task-data.mjs',['restore',backup,join(dir,'invalid')]).status,0)
  assert.ok(!fs.existsSync(join(dir,'invalid')))
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('legacy import is idempotent and remains read-only across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-import-'));let manager
 try{
  let executions=0;const executor={async execute(){executions++},async dispose(){}}
  manager=createTaskManager({store:createTaskStore(dir),executor})
  const records=[{sessionId:'session-old',task:'old task',cwd:dir,text:'old result',stopReason:'completed'}]
  assert.equal(manager.importLegacy(records).imported,1);assert.equal(manager.importLegacy(records).imported,0)
  const old=manager.list().tasks[0];assert.equal(old.state,'LEGACY');assert.equal(old.activeRunId,null)
  await assert.rejects(manager.retry({taskId:old.taskId,idempotencyKey:'no'}),{code:'legacy-read-only'})
  await manager.dispose();manager=createTaskManager({store:createTaskStore(dir),executor})
  assert.equal(manager.get(old.taskId).state,'LEGACY');assert.equal(executions,0)
 }finally{if(manager)await manager.dispose();await rm(dir,{recursive:true,force:true})}
})
test('directory aliases share idempotency and project serialization',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-alias-'));let manager
 try{
  const real=join(dir,'project'),alias=join(dir,'alias');fs.mkdirSync(real);await symlink(real,alias,process.platform==='win32'?'junction':'dir')
  let calls=0
  const executor={async execute(i){calls++;i.onSession({sessionId:'s'});await new Promise(r=>i.signal.addEventListener('abort',r,{once:true}));return {sessionId:'s',stopReason:'cancelled'}},async observe(){return {running:false,pendingInput:[]}},async cancel(){},async dispose(){}}
  manager=createTaskManager({store:createTaskStore(join(dir,'store')),executor})
  const first=await manager.submit({goal:'first',cwd:real,idempotencyKey:'same'})
  assert.equal((await manager.submit({goal:'first',cwd:alias,idempotencyKey:'same'})).taskId,first.taskId)
  const second=await manager.submit({goal:'next',cwd:alias,idempotencyKey:'different'})
  for(let i=0;i<100&&calls===0;i++)await delay()
  assert.equal(calls,1);assert.equal(manager.get(second.taskId).state,'QUEUED')
 }finally{if(manager)await manager.dispose();await rm(dir,{recursive:true,force:true})}
})
test('browser task routes reject foreign origins and keep human review off bearer dispatch',async()=>{
 let calls=0
 const handler=createTaskBrowserApi({manager:()=>({get(){calls++;return {taskId:'t'}},async answer(_,options){assert.equal(options.wait,false);return {state:'RUNNING'}}}),diagnostics:()=>({version:'fixture'}),legacyRecords:()=>[]})
 assert.equal((await handler(new Request('http://localhost/api',{method:'POST',headers:{origin:'http://evil.invalid'},body:'{"action":"get","taskId":"t"}'}))).status,403)
 assert.equal(calls,0)
 assert.equal((await handler(new Request('http://localhost/api'))).status,405)
 const result=await handler(new Request('http://localhost/api',{method:'POST',headers:{origin:'http://localhost'},body:'{"action":"answer"}'}))
 assert.equal((await result.json()).value.state,'RUNNING')
 const {dispatchTask}=await import('../lib/task-api.js')
 await assert.rejects(dispatchTask({}, {action:'review'}))
})
test('diagnostic projection never returns service credentials',async()=>{
 const report=collectTaskDiagnostics({directory:join(tmpdir(),'non-existing-'+Date.now()),version:'rc',ctx:{sessionController:{create(){},state(){},events(){},cancel(){},secret:'PRIVATE_TOKEN'},bridgeVerification:{run(){},apiKey:'PRIVATE_TOKEN'}}})
 assert.equal(report.capabilities.controlledVerification,true);assert.ok(!JSON.stringify(report).includes('PRIVATE_TOKEN'))
})
test('release gate rejects missing, stale and duplicate evidence and requires every live check',async()=>{
 const {validateReleaseEvidence,requiredGates}=await import('./release-check.mjs')
 const commit='a'.repeat(40)
 const evidence={targetVersion:'2.0.0',sourceCommit:commit,gates:requiredGates.map(id=>({id,status:'pass',evidence:'synthetic unit fixture only'}))}
 assert.equal(validateReleaseEvidence(evidence,commit).ready,true)
 assert.equal(validateReleaseEvidence(evidence,'b'.repeat(40)).ready,false)
 evidence.gates.find(g=>g.id==='windows-dsh-lifecycle').status='not-verified'
 assert.equal(validateReleaseEvidence(evidence,commit).ready,false)
 evidence.gates.push(evidence.gates[0]);assert.equal(validateReleaseEvidence(evidence,commit).ready,false)
 const blocked=cmd('tools/release-check.mjs',[]);assert.equal(blocked.status,1)
 assert.equal(JSON.parse(blocked.stdout).ready,false)
})
test('execution creates a real artifact then profile hash and read-only review determine success',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-full-flow-'));let manager
 try{
  const body='export const ready = true;\n',hash=digest(Buffer.from(body));let reviewed=false
  const executor={async execute(input){input.onSession({sessionId:'session-artifact',baseline:0,execution:{selection:{provider:'fixture',model:'controlled-host'}}});await writeFile(join(dir,'artifact.js'),body);return {sessionId:'session-artifact',stopReason:'completed',text:'artifact generated'}},async dispose(){}}
  manager=createTaskManager({store:createTaskStore(join(dir,'store')),executor,profiles:{artifact:{files:[{path:'artifact.js',sha256:hash}]}},reviewer:async task=>{assert.equal(task.run.verification.status,'passed');reviewed=true;return {verdict:'approve',summary:'fixture reviewer'}}})
  assert.ok(!fs.existsSync(join(dir,'artifact.js')))
  const task=await manager.submit({goal:'generate artifact',cwd:dir,idempotencyKey:'full-flow',verificationProfile:'artifact',review:true,acceptance:['artifact digest matches']})
  for(let i=0;i<200&&!['SUCCEEDED','FAILED','REVIEW_REQUIRED'].includes(manager.get(task.taskId).state);i++)await delay()
  const done=manager.get(task.taskId);assert.equal(done.state,'SUCCEEDED');assert.equal(reviewed,true)
  assert.equal(done.run.verification.artifacts[0].hash,digest(fs.readFileSync(join(dir,'artifact.js'))))
  assert.equal(done.run.execution.selection.model,'controlled-host')
 }finally{if(manager)await manager.dispose();await rm(dir,{recursive:true,force:true})}
})
test('upgrading path normalization preserves older idempotency receipts and rejects changed input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-old-idempotency-'));let manager
 try{
  const store=createTaskStore(join(dir,'store')),payload={goal:'original',cwd:dir,idempotencyKey:'old-key',timeoutMs:300000}
  const oldHash=digest(Object.fromEntries(Object.keys(payload).sort().map(k=>[k,payload[k]])))
  store.commit({taskId:'old-task',activeRunId:'old-run',goal:'original',cwd:dir,state:'REVIEW_REQUIRED',revision:1,createdAt:1,submissionKey:digest({cwd:dir,key:'old-key'}),payloadHash:oldHash,run:{runId:'old-run',outcome:'completed'}},'fixture.beta_receipt')
  let executions=0;manager=createTaskManager({store,executor:{async execute(){executions++},async dispose(){}}})
  assert.equal((await manager.submit(payload)).taskId,'old-task')
  await assert.rejects(manager.submit({...payload,goal:'changed'}),{code:'idempotency-conflict'})
  const alias=dir+'-alias';await symlink(dir,alias,process.platform==='win32'?'junction':'dir')
  try{assert.equal((await manager.submit({...payload,cwd:alias})).taskId,'old-task')}finally{await rm(alias,{force:true})}
  assert.equal(executions,0)
 }finally{if(manager)await manager.dispose();await rm(dir,{recursive:true,force:true})}
})
