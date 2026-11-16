import {spawnSync}from'node:child_process'
import{mkdtempSync,rmSync}from'node:fs'
import{tmpdir}from'node:os'
import{join}from'node:path'
import assert from'node:assert/strict'
if(!process.argv.includes('--child')){const home=mkdtempSync(join(tmpdir(),'frozen-host-'));try{const r=spawnSync(process.execPath,[import.meta.filename,'--child'],{env:{...process.env,HOME:home,USERPROFILE:home},stdio:'inherit',timeout:20000});assert.equal(r.status,0)}finally{rmSync(home,{recursive:true,force:true})}}
else{
 const{createExecutor}=await import('../lib/session-executor.js')
 const execution={selection:{provider:'p',model:'m',reasoningEffort:'max'},permissionMode:'inherit',policyRevision:1}
 let evidence=[],revoked=false,prompts=0,answers=0,stage='normal',entered,release,question
 const blocked=()=>new Promise(r=>{entered=r});let reached
 const pause=()=>new Promise(r=>{release=r;entered?.()})
 const policy={async resolveExecution(){return structuredClone(execution)},async validateFrozen(){if(stage==='answer')await pause();if(revoked)throw Object.assign(Error('revoked'),{status:409,code:'revoked'})},async applyAccess(){},async apply(){return{status:'applied'}}}
 const service={async create(){if(stage==='create')await pause();return{sessionId:'session-'+Math.random()}},async state(){if(stage==='state')await pause();return{cursor:0,running:false,pendingInput:[]}},async prompt(){prompts++},async cancel(){question=null},async events(){return{records:[]}},async wait(){return question?{reason:'input-required',state:{cursor:1}}:{reason:'idle',state:{cursor:2},output:{records:[{event:{seq:1,type:'request/header',data:{header:{config:{provider:'p',model:'m',reasoningEffort:'high'}}}}},{event:{seq:2,type:'request/header',data:{header:{config:execution.selection}}}},{event:{seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'ok'}]}}}},{event:{seq:4,type:'turn/end',data:{reason:{kind:'completed'}}}}]}}}}
 const relay={questionFor(){return question},cancel(){question=null},validate(){},answer(){answers++;question=null}}
 const e=createExecutor({ctx:{sessionController:service},policy,relay})
 try{
  for(const mode of ['create','state']){stage=mode;revoked=false;reached=blocked();const call=e.executeTask({task:'g',timeoutMs:10000,frozenExecution:execution});await reached;revoked=true;stage='normal';release();await assert.rejects(call);assert.equal(prompts,0,'no prompt after revocation during '+mode)}
  revoked=false;stage='normal';const first=await e.execute({task:'first',timeoutMs:10000,onEvidence:v=>evidence.push(v)});assert.equal(first.stopReason,'completed');assert.deepEqual(evidence.map(v=>v.selection.reasoningEffort),['high','max']);revoked=true;await assert.rejects(e.execute({task:'reuse',sessionId:first.sessionId,timeoutMs:10000}));assert.equal(prompts,1,'legacy reuse must revalidate policy')
  revoked=false;question={requestId:'q',expiresAt:Date.now()+60000,questions:[{id:'q',question:'?'}]};const waiting=await e.executeTask({task:'ask',timeoutMs:10000,frozenExecution:execution});assert.equal(waiting.stopReason,'needs-input');stage='answer';reached=blocked();const abort=new AbortController();const answering=e.answerTask({sessionId:waiting.sessionId,requestId:'q',answers:[],timeoutMs:10000,frozenExecution:execution,signal:abort.signal});await reached;abort.abort();await e.cancel(waiting.sessionId);release();await assert.rejects(answering);assert.equal(answers,0,'cancel during validation must not consume answer')
  console.log('PASS: frozen revocation before prompt, legacy reuse gate, and cancelled-answer race')
 }finally{stage='normal';await e.dispose()}
}
