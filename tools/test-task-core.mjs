import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskStore } from '../lib/task-store.js'
import { createTaskManager } from '../lib/task-manager.js'
import { verifyTask } from '../lib/task-verifier.js'
import { gatherDiff } from '../lib/context.js'
import { execFileSync } from 'node:child_process'
const pause=()=>new Promise(r=>setTimeout(r,10))
async function fixture(t,mode='done') {
 const dir=await mkdtemp(join(tmpdir(),'bridge-task-')),store=createTaskStore(join(dir,'store'))
 const sessions=new Map();let calls=0,answerValid=true
 const executor={
  async execute(input) {
   calls++;const sessionId='session-'+calls;sessions.set(sessionId,{running:true});input.onSession?.({sessionId,baseline:5,execution:{selection:{provider:'test',model:'fixture'},policyRevision:1}})
   if(mode==='wait') {await new Promise(r=>input.signal.addEventListener('abort',r,{once:true}));sessions.set(sessionId,{running:false});return {sessionId,text:'',stopReason:'cancelled'}}
   if(mode==='question') return {sessionId,text:'',stopReason:'needs-input',needsInput:{requestId:'q1',questions:[{id:'q',question:'?',options:[{label:'A'}]}]}}
   sessions.set(sessionId,{running:false,result:{sessionId,text:'done',stopReason:'completed'}})
   return {sessionId,text:'done',stopReason:'completed'}
  },
  async answer(input){return {sessionId:input.sessionId,text:'answer',stopReason:'completed'}},
  validateAnswer(input){if(!answerValid || input.answers?.[0]?.selected?.[0]!=='A')throw Object.assign(new Error('invalid'),{status:400})},
  async observe(id){return sessions.get(id)},async cancel(id){sessions.set(id,{running:false})},async dispose(){},metadataOf(){},
 }
 const manager=createTaskManager({store,executor,profiles:{file:{files:[{path:'artifact.txt'}]},cmd:{commands:[{argv:['npm','test']}]}}})
 await writeFile(join(dir,'artifact.txt'),'evidence')
 t.after(async()=>{await manager.dispose();await rm(dir,{recursive:true,force:true})})
 const submit=(extra={})=>manager.submit({goal:'test',cwd:dir,idempotencyKey:'one',...extra})
 const settled=async id=>{for(let i=0;i<200;i++){const task=manager.get(id);if(['SUCCEEDED','REVIEW_REQUIRED','FAILED','CANCELLED','WAITING_INPUT'].includes(task.state))return task;await pause()}throw new Error('task did not settle')}
 return {dir,store,manager,submit,settled,calls:()=>calls}
}
test('durable idempotency converges under concurrent admission; conflicting payload refused',async t=>{
 const f=await fixture(t)
 const tasks=await Promise.all(Array.from({length:20},()=>f.submit()))
 assert.equal(new Set(tasks.map(t=>t.taskId)).size,1)
 const task=await f.settled(tasks[0].taskId);assert.equal(f.calls(),1);assert.equal(task.state,'REVIEW_REQUIRED')
 await assert.rejects(f.submit({goal:'changed'}),{code:'idempotency-conflict'})
 assert.ok(f.manager.events({taskId:task.taskId}).events.length>=4)
})
test('verification evidence is separate from model completion; fixed file profile passes',async t=>{
 const f=await fixture(t);const task=await f.submit({verificationProfile:'file'})
 const result=await f.settled(task.taskId)
 assert.equal(result.state,'SUCCEEDED');assert.equal(result.run.verification.artifacts.length,1);assert.ok(result.run.before)
})
test('unavailable controlled command executor never becomes success',async t=>{
 const f=await fixture(t);const task=await f.submit({verificationProfile:'cmd'})
 const result=await f.settled(task.taskId);assert.equal(result.state,'REVIEW_REQUIRED');assert.equal(result.run.verification.status,'unavailable')
})
test('targeted cancellation requires stopped observation',async t=>{
 const f=await fixture(t,'wait');const task=await f.submit()
 while(!f.manager.get(task.taskId).run.sessionId)await pause()
 assert.equal((await f.manager.cancel({taskId:task.taskId})).state,'CANCEL_REQUESTED')
 assert.equal((await f.settled(task.taskId)).state,'CANCELLED')
})
test('invalid answer preserves pending question; valid answer continues same run',async t=>{
 const f=await fixture(t,'question');const task=await f.submit();await f.settled(task.taskId)
 await assert.rejects(f.manager.answer({taskId:task.taskId,runId:task.activeRunId,requestId:'q1',answers:[]}),{status:400})
 assert.equal(f.manager.get(task.taskId).state,'WAITING_INPUT')
 await f.manager.answer({taskId:task.taskId,runId:task.activeRunId,requestId:'q1',answers:[{id:'q',selected:['A']}]})
 assert.equal(f.manager.get(task.taskId).activeRunId,task.activeRunId)
 assert.equal(f.manager.get(task.taskId).state,'REVIEW_REQUIRED')
})
test('store locks, checksums, incomplete tails and restart uncertainty',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'task-journal-'))
 try {
  let store=createTaskStore(dir)
  assert.throws(()=>createTaskStore(dir),{code:'task-store-locked'})
  store.commit({taskId:'t',revision:1,state:'RUNNING',run:{},activeRunId:'r'},'started');store.close()
  fs.appendFileSync(join(dir,'events.jsonl'),'{broken')
  store=createTaskStore(dir);assert.equal(store.get('t').revision,1)
  const manager=createTaskManager({store,executor:{async dispose(){}}});assert.equal(manager.get('t').state,'RECONCILING')
  store.checkpoint();store.close()
  const file=join(dir,'events.jsonl');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('started','corrupt'))
  assert.throws(()=>createTaskStore(dir),{code:'task-store-corrupt'})
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('worktree scope includes only requested tracked and untracked files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'task-scope-'))
 const git=(...args)=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'})
 try{git('init');await writeFile(join(dir,'a'),'old');await writeFile(join(dir,'b'),'old');git('add','.');git('-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture');await writeFile(join(dir,'a'),'new');await writeFile(join(dir,'b'),'new');await writeFile(join(dir,'secret'),'untracked');const diff=await gatherDiff(dir,'worktree',['a']);assert.match(diff,/diff --git a\/a/);assert.doesNotMatch(diff,/diff --git a\/b|secret/)}finally{await rm(dir,{recursive:true,force:true})}
})
test('sealed segments retain history and hash chain across reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'task-segments-'))
 try{let store=createTaskStore(dir,{segmentBytes:100});for(let i=0;i<4;i++)store.commit({taskId:'t',revision:i},'changed');store.close();store=createTaskStore(dir);assert.equal(store.get('t').revision,3);assert.equal(store.events('t').length,4);store.close()}finally{await rm(dir,{recursive:true,force:true})}
})
test('human acceptance is guarded by run, revision and evidence hash',async t=>{
 const f=await fixture(t);const task=await f.submit();const done=await f.settled(task.taskId)
 assert.throws(()=>f.manager.review({taskId:task.taskId,runId:done.activeRunId,expectedRevision:0,evidenceHash:done.run.evidenceHash,decision:'accept'}),{code:'review-conflict'})
 assert.equal(f.manager.review({taskId:task.taskId,runId:done.activeRunId,expectedRevision:done.revision,evidenceHash:done.run.evidenceHash,decision:'accept'}).state,'SUCCEEDED')
})
test('real MCP stdio and authenticated HTTP route submit, query and cancel a legacy call',async t=>{
 const {registerHttpRoute}=await import('../lib/dsh-exec-v4.js')
 const {createServer}=await import('node:http')
 const {spawn}=await import('node:child_process')
 const {createInterface}=await import('node:readline')
 const f=await fixture(t,'wait'),routes=new Map(),token='test-task-route-token'
 const dispose=registerHttpRoute({ctx:{webServer:{register({path,handler}){routes.set(path,handler);return ()=>routes.delete(path)}}},executor:{execute:i=>f.manager.legacyExecute(i)},taskManager:()=>f.manager,token})
 const server=createServer((req,res)=>{const handler=routes.get(req.url);if(handler)handler(req,res);else {res.writeHead(404);res.end()}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const url='http://127.0.0.1:'+server.address().port
 const unauth=await fetch(url+'/api/dsh-codex-bridge.v2.tasks',{method:'POST',body:JSON.stringify({action:'list'})});assert.equal(unauth.status,401)
 const child=spawn(process.execPath,['bin/mcp-server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,DSH_BRIDGE_URL:url,DSH_BRIDGE_TOKEN:token},stdio:['pipe','pipe','pipe']})
 let next=0;const pending=new Map();let stderr='';child.stderr.on('data',b=>stderr+=b)
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const frame=JSON.parse(line);pending.get(frame.id)?.(frame);pending.delete(frame.id)})
 const request=(method,params)=>{const id=++next;return {id,promise:new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('stdio timeout '+stderr)),5000);pending.set(id,v=>{clearTimeout(timer);resolve(v)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})}}
 t.after(async()=>{child.kill();lines.close();dispose();server.closeAllConnections();await new Promise(r=>server.close(r))})
 const submitted=await request('tools/call',{name:'dsh_task_submit',arguments:{goal:'transport',cwd:f.dir,idempotencyKey:'transport'}}).promise
 const task=JSON.parse(submitted.result.content[0].text)
 const fetched=await request('tools/call',{name:'dsh_task_get',arguments:{taskId:task.taskId}}).promise
 assert.equal(JSON.parse(fetched.result.content[0].text).taskId,task.taskId)
 await request('tools/call',{name:'dsh_task_cancel',arguments:{taskId:task.taskId}}).promise
 await f.settled(task.taskId)
 const call=request('tools/call',{name:'dsh_execute',arguments:{task:'legacy wait',cwd:f.dir,timeoutMs:2000}})
 for(let i=0;i<100 && f.calls()<2;i++)await pause()
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:call.id}})+'\n')
 const cancelled=await call.promise;assert.equal(cancelled.result.isError,true)
 assert.ok(!stderr.includes(token))
})
