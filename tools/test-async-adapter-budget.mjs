// Verify real adapter paths >600s without waiting10min; model/task services are isolated stubs.
import{spawnSync}from'node:child_process'
import{mkdtempSync,rmSync}from'node:fs'
import{mkdtemp,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import assert from'node:assert/strict'
if(!process.argv.includes('--child')){
 const home=mkdtempSync(join(tmpdir(),'async-budget-home-'));try{const r=spawnSync(process.execPath,[import.meta.filename,'--child'],{env:{...process.env,HOME:home,USERPROFILE:home},stdio:'inherit',timeout:15000});assert.equal(r.status,0)}finally{rmSync(home,{recursive:true,force:true})}
}else{
 const{createExecutor}=await import('../lib/session-executor.js');const{createTaskManager}=await import('../lib/task-manager.js');const{createTaskStore}=await import('../lib/task-store.js');const dir=await mkdtemp(join(tmpdir(),'async-budget-'))
 let seq=0,records=[],prompted=0,advanced=false;const realNow=Date.now;let jump=0;Date.now=()=>realNow()+jump
 const event=(type,data)=>records.push({event:{seq:++seq,type,data}})
 const service={async create(){return{sessionId:'session-long-budget'}},async state(){return{cursor:seq,running:false,pendingInput:[]}},async prompt(){prompted++},async wait(){if(!advanced){jump=601000;advanced=true;return{reason:'timeout',state:{cursor:seq},output:{records:[]}}}event('assistant/message',{message:{content:[{type:'text',text:'AFTER_10_MIN'}]}});event('turn/end',{reason:{kind:'completed'}});return{reason:'idle',state:{cursor:seq},output:{records}}},async events(){return{records}},async cancel(){}}
 const adapter=createExecutor({ctx:{sessionController:service}});const manager=createTaskManager({store:createTaskStore(join(dir,'store')),executor:adapter})
 try{const t=await manager.submit({goal:'long-budget',cwd:dir,idempotencyKey:'one',timeoutMs:1800000});for(let i=0;i<100&&manager.get(t.taskId).state!=='REVIEW_REQUIRED';i++)await new Promise(r=>setTimeout(r,10));const done=manager.get(t.taskId);assert.equal(done.state,'REVIEW_REQUIRED');assert.equal(done.run.result.text,'AFTER_10_MIN');assert.equal(prompted,1);await assert.rejects(adapter.execute({task:'legacy',timeoutMs:600001}));console.log('PASS: TaskManager -> real executeTask adapter survives simulated601s, old execute rejects>600s')}
 finally{Date.now=realNow;await manager.dispose();await rm(dir,{recursive:true,force:true})}
}
