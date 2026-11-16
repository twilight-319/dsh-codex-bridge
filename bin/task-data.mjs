#!/usr/bin/env node
// Explicit offline backup/restore; never targets a live writer or overwrites data.
import fs from 'node:fs'
import path from 'node:path'
import {inspectTaskData} from '../lib/task-diagnostics.js'
import {digest} from '../lib/task-store.js'
const [operation,sourceArg,destinationArg]=process.argv.slice(2)
try{
 if(!['backup','restore'].includes(operation)||!sourceArg||!destinationArg)throw Error('usage: task-data.mjs backup|restore SOURCE NEW_DIRECTORY')
 const source=fs.realpathSync(sourceArg),destination=path.resolve(destinationArg),relative=path.relative(source,destination)
 if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('destination must be outside source')
 if(fs.existsSync(destination))throw Error('destination must not exist')
 const health=inspectTaskData(source)
 if(health.writerLocked||health.status!=='healthy')throw Error('stop writer and verify source integrity first')
 const lock=path.join(source,'writer.lock');const lockFd=fs.openSync(lock,'wx',0o600)
 try {
 const files=fs.readdirSync(source).filter(n=>n==='events.jsonl'||n==='snapshot.json'||/^segment-[0-9]+\.jsonl$/.test(n))
 let manifest
 if(operation==='restore'){
  manifest=JSON.parse(fs.readFileSync(path.join(source,'backup-manifest.json'),'utf8'))
  if(manifest.version!==1||!Array.isArray(manifest.files)||manifest.files.length!==files.length)throw Error('invalid backup manifest')
  for(const record of manifest.files){if(!files.includes(record.name)||digest(fs.readFileSync(path.join(source,record.name)))!==record.sha256)throw Error('backup checksum mismatch')}
 }
 fs.mkdirSync(destination,{mode:0o700})
 try {
  for(const name of files)fs.copyFileSync(path.join(source,name),path.join(destination,name),fs.constants.COPYFILE_EXCL)
  if(operation==='backup')fs.writeFileSync(path.join(destination,'backup-manifest.json'),JSON.stringify({version:1,createdAt:Date.now(),files:files.map(name=>({name,sha256:digest(fs.readFileSync(path.join(destination,name)))}))}),{mode:0o600,flag:'wx'})
  if(inspectTaskData(destination).status!=='healthy')throw Error('destination validation failed')
 }catch(error){fs.rmSync(destination,{recursive:true,force:true});throw error}
 console.log(JSON.stringify({ok:true,operation,files:files.length}))
 } finally {fs.closeSync(lockFd);fs.unlinkSync(lock)}
}catch(error){console.error(error.message);process.exitCode=1}
