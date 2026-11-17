import fs from 'node:fs'
import path from 'node:path'
import {digest} from './task-store.js'
/** Read-only inspection: never opens a writer, repairs tails or removes locks. */
export function inspectTaskData(directory) {
  if (!fs.existsSync(directory)) return {status:'missing',records:0,tasks:0,writerLocked:false}
  const writerLocked=fs.existsSync(path.join(directory,'writer.lock'))
  let seq=0,hash='',tasks=new Map(),incompleteTail=false
  try {
    const names=fs.readdirSync(directory).filter(n=>/^segment-[0-9]+\.jsonl$/.test(n)).sort().concat('events.jsonl')
    for(const name of names){
      const file=path.join(directory,name)
      if(!fs.existsSync(file))continue
      if(fs.statSync(file).size>64*1024*1024)return {status:'inspection-limit',writerLocked}
      const bytes=fs.readFileSync(file),end=bytes.lastIndexOf(10)+1
      if(end<bytes.length){if(name!=='events.jsonl')throw Error('sealed tail');incompleteTail=true}
      for(const line of bytes.subarray(0,end).toString('utf8').split('\n').filter(Boolean)){
        const {checksum,...body}=JSON.parse(line)
        if(body.v!==1||body.seq!==seq+1||body.prev!==hash||checksum!==digest(body))throw Error('invalid chain')
        seq=body.seq;hash=checksum;tasks.set(body.task.taskId,body.task)
      }
    }
    return {status:incompleteTail?'incomplete-tail':'healthy',records:seq,tasks:tasks.size,writerLocked,workflowTasks:[...tasks.values()].filter(t=>t.kind==='workflow').length}
  }catch{return {status:'corrupt',writerLocked,records:seq}}
}
export function collectTaskDiagnostics({directory,ctx,version,codexBin}={}) {
  const service=name=>{try{return typeof ctx?.get==='function'?ctx.get(name):ctx?.[name]}catch{return null}}
  const controller=service('sessionController'),verification=service('bridgeVerification')
  return {version,hostNode:process.version,platform:process.platform,store:inspectTaskData(directory),
    capabilities:{create:typeof controller?.create==='function',state:typeof controller?.state==='function',events:typeof controller?.events==='function',cancel:typeof controller?.cancel==='function',controlledVerification:typeof verification?.run==='function',codexExecutable:!!codexBin},
    liveAcceptance:'not-verified',permissionPolicy:'unchanged'}
}
