#!/usr/bin/env node
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import {inspectTaskData} from '../lib/task-diagnostics.js'
import {resolveEndpoint} from '../lib/endpoint-discovery.js'
const args=process.argv.slice(2)
const directory=resolve(args.includes('--directory')?args[args.indexOf('--directory')+1]:join(homedir(),'.dsh','codex-bridge','tasks-v2'))
const report={externalNode:process.version,platform:process.platform,store:inspectTaskData(directory),liveAcceptance:'not-verified'}
if(args.includes('--online')){
 try{
  const {origin}=resolveEndpoint(),url=new URL(origin)
  const token=fs.readFileSync(join(homedir(),'.dsh','codex-bridge','http-token'),'utf8').trim()
  const state=await new Promise((yes,no)=>{
   const req=http.request({hostname:url.hostname==='localhost'?'127.0.0.1':url.hostname.replace(/^\[|\]$/g,''),port:url.port||80,path:'/api/dsh-codex-bridge.v3.status',headers:{authorization:'Bearer '+token}},res=>{
    let body='',size=0
    res.on('data',b=>{size+=b.length;if(size>1024*1024)req.destroy(new Error('response-limit'));else body+=b})
    res.on('aborted',()=>no(Error('aborted')));res.on('error',no)
    res.on('end',()=>{try{if(res.statusCode!==200)throw Error('unreachable');yes(JSON.parse(body))}catch{no(Error('invalid-status'))}})
   });req.setTimeout(5000,()=>req.destroy(Error('timeout')));req.on('error',no);req.end()
  })
  report.bridge={reachable:state.ok===true,version:typeof state.version==='string'?state.version:'unknown',hostNode:typeof state.hostNode==='string'?state.hostNode:'not-reported'}
 }catch{report.bridge={reachable:false,reason:'discovery-auth-or-transport-unavailable'}}
}
console.log(JSON.stringify(report,null,2))
if(['corrupt','incomplete-tail','inspection-limit'].includes(report.store.status))process.exitCode=1
