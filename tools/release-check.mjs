import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
export const requiredGates=['offline-regressions','windows-ci','browser-fixtures','windows-dsh-lifecycle','m3-live-profile-review','native-approval','crash-recovery','rollback-live','dsh-visual-keyboard']
export function validateReleaseEvidence(evidence,targetCommit) {
 const errors=[]
 if(!/^[a-f0-9]{40}$/.test(targetCommit??''))errors.push('target commit must be a full SHA')
 if(evidence.sourceCommit!==targetCommit)errors.push('evidence is not bound to the target commit')
 if(evidence.targetVersion!=='2.0.0')errors.push('unexpected release target')
 for(const id of requiredGates){const records=(evidence.gates??[]).filter(g=>g.id===id);if(records.length!==1||records[0].status!=='pass'||typeof records[0].evidence!=='string'||!records[0].evidence.trim())errors.push(id+': verified evidence required')}
 return {ready:errors.length===0,targetCommit,errors}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{
  const args=process.argv.slice(2)
  const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined
  const file=value('--evidence')??new URL('../docs/release-gates.json',import.meta.url)
  const commit=value('--commit')??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  const result=validateReleaseEvidence(JSON.parse(fs.readFileSync(file,'utf8')),commit)
  console.log(JSON.stringify(result,null,2));if(!result.ready)process.exitCode=1
 }catch{console.error('Release evidence could not be validated. Provide --evidence FILE and --commit FULL_SHA.');process.exitCode=1}
}
