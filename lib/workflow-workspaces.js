import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, join, dirname, relative, sep } from 'node:path'
import { promises as fs } from 'node:fs'
import { digest, taskError } from './task-store.js'
import { projectKey } from './project-key.js'
import { workflowPath, scopeContains } from './workflow-plan.js'

const MAX_FILE=10*1024*1024,MAX_SNAPSHOT=256*1024*1024
const missing=e=>e.code==='ENOENT'
function git(cwd,args,signal) {
  return new Promise((yes,no)=>execFile('git',['-C',cwd,...args],{windowsHide:true,timeout:60000,maxBuffer:8*1024*1024,signal,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}},(error,out)=>error?no(taskError('Git隔离工作区操作失败，请保留工作区检查。','workspace-git-failed',409)):yes(out)))
}
async function json(path) { return JSON.parse(await fs.readFile(path,'utf8')) }
async function writeJson(path,value) {
  await fs.mkdir(dirname(path),{recursive:true,mode:0o700})
  const temporary=path+'.'+randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await fs.rename(temporary,path)
}
async function inside(root,path) {
  path=workflowPath(path)
  const target=resolve(root,path)
  if(!target.startsWith(resolve(root)+sep))throw taskError('工作区路径越界。','workspace-path',409)
  const parts=relative(root,target).split(sep)
  let current=resolve(root)
  for(const part of parts) {
    current=join(current,part)
    try { if((await fs.lstat(current)).isSymbolicLink())throw taskError('不支持符号链接或目录联接产物。','workspace-link',409) }
    catch(error) { if(missing(error))break;throw error }
  }
  return target
}
async function info(root,path,blobs) {
  const target=await inside(root,path)
  let stat
  try { stat=await fs.lstat(target) } catch(error) { if(missing(error))return null;throw error }
  if(!stat.isFile() || stat.size>MAX_FILE)throw taskError('隔离快照只支持每个文件不超过10MiB的普通文件。','workspace-file-limit',409)
  const bytes=await fs.readFile(target),hash=digest(bytes)
  if(bytes.length>MAX_FILE)throw taskError('文件在读取期间超过10MiB。','workspace-file-limit',409)
  if(blobs) { const dest=join(blobs,hash);try{await fs.writeFile(dest,bytes,{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error} }
  return {hash,bytes:bytes.length,mode:stat.mode&0o777}
}
async function paths(cwd,signal) {
  const values=await Promise.all([git(cwd,['ls-files','--cached','-z'],signal),git(cwd,['ls-files','--others','--exclude-standard','-z'],signal)])
  return [...new Set(values.flatMap(x=>x.split('\0').filter(Boolean)))].sort()
}
async function snapshot(cwd,blobs,extra=[],signal) {
  const files=Object.create(null),names=[...new Set([...(await paths(cwd,signal)),...extra])].sort(),aliases=new Set()
  let size=0
  for(const path of names) {
    const alias=process.platform==='win32'?path.toLowerCase():path
    if(aliases.has(alias))throw taskError('工作区包含大小写别名路径。','workspace-path-alias',409)
    aliases.add(alias)
    signal?.throwIfAborted()
    const value=await info(cwd,path,blobs)
    if(value) {size+=value.bytes;if(size>MAX_SNAPSHOT)throw taskError('工作区快照超过256MiB。','workspace-size-limit',409);files[path]=value}
  }
  return files
}
async function replace(root,path,value,blobs) {
  const target=await inside(root,path)
  if(value===null) {try{await fs.unlink(target)}catch(error){if(!missing(error))throw error};return}
  const bytes=await fs.readFile(join(blobs,value.hash))
  if(digest(bytes)!==value.hash)throw taskError('产物内容校验失败。','workspace-blob-corrupt',409)
  await fs.mkdir(dirname(target),{recursive:true})
  await inside(root,path)
  const temporary=join(dirname(target),'.'+randomUUID()+'.bridge-tmp')
  const handle=await fs.open(temporary,'wx',value.mode ?? 0o600)
  try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
  await fs.rename(temporary,target)
}
const same=(a,b)=>(a?.hash??null)===(b?.hash??null) && (a?.mode??null)===(b?.mode??null)

export function createWorkflowWorkspaces({directory=join(homedir(),'.dsh','codex-bridge','workflows-v1')}={}) {
  directory=resolve(directory)
  function location(root) {
    if(!/^workflow-[a-z0-9-]+$/.test(root.taskId))throw taskError('协作编号无效。')
    const base=join(directory,root.taskId)
    return {base,blobs:join(base,'blobs'),meta:join(base,'source.json')}
  }
  async function source(root) {
    const p=location(root),meta=await json(p.meta)
    if(meta.taskId!==root.taskId || meta.canonicalRoot!==projectKey(root.cwd) || projectKey(meta.cwd)!==projectKey(root.cwd) || root.run.workspace?.snapshotHash && digest(meta.files)!==root.run.workspace.snapshotHash)throw taskError('协作快照不匹配。','workspace-snapshot-mismatch',409)
    return {...p,...meta,files:Object.assign(Object.create(null),meta.files)}
  }
  async function nodeMeta(root,node) {
    const s=await source(root),meta=await json(join(s.base,node.id+'.json'))
    if(meta.nodeId!==node.id || meta.taskId!==root.taskId || meta.cwd!==join(s.base,'worktrees',node.id) || digest(meta.files)!==node.workspace?.snapshotHash)throw taskError('子任务工作区快照不匹配。','workspace-snapshot-mismatch',409)
    meta.files=Object.assign(Object.create(null),meta.files)
    return {s,meta}
  }
  return {
    async prepare(root,signal) {
      const p=location(root)
      try { const existing=await source(root);return {snapshotHash:digest(existing.files),directory:p.base,head:existing.head} } catch(error) {if(!missing(error))throw error}
      const top=(await git(root.cwd,['rev-parse','--show-toplevel'],signal)).trim()
      if(projectKey(top)!==projectKey(root.cwd))throw taskError('协作工作目录必须是Git仓库根目录。','workflow-root-required',409)
      if(projectKey(p.base).startsWith(projectKey(root.cwd)+sep))throw taskError('隔离工作区存储不能位于原项目内部。','workflow-workspace-location',409)
      const head=(await git(root.cwd,['rev-parse','HEAD'],signal)).trim()
      await fs.mkdir(p.blobs,{recursive:true,mode:0o700})
      const files=await snapshot(root.cwd,p.blobs,[],signal)
      const again=await snapshot(root.cwd,null,Object.keys(files),signal)
      if(digest(files)!==digest(again) || (await git(root.cwd,['rev-parse','HEAD'],signal)).trim()!==head)throw taskError('源项目在快照期间变化，请重试对账。','workflow-source-changed',409)
      await writeJson(p.meta,{taskId:root.taskId,cwd:root.cwd,canonicalRoot:projectKey(root.cwd),head,files})
      return {snapshotHash:digest(files),directory:p.base,head}
    },
    async prepareNode(root,node,ancestors,signal) {
      const s=await source(root),cwd=join(s.base,'worktrees',node.id),metaPath=join(s.base,node.id+'.json')
      try {
        const previous=await json(metaPath)
        if(previous.taskId!==root.taskId || previous.nodeId!==node.id || previous.cwd!==cwd)throw taskError('已有工作区不属于本节点。','workspace-owner',409)
        return {cwd,snapshotHash:digest(previous.files)}
      } catch(error) {if(!missing(error))throw error}
      try { await fs.lstat(cwd);throw taskError('工作区准备曾中断，保留目录等待人工核对。','workspace-preparation-uncertain',409) } catch(error){if(!missing(error))throw error}
      await fs.mkdir(dirname(cwd),{recursive:true,mode:0o700})
      const hooks=join(s.base,'empty-hooks');await fs.mkdir(hooks,{recursive:true,mode:0o700})
      await git(root.cwd,['-c','core.hooksPath='+hooks,'worktree','add','--no-checkout','--detach','--',cwd,s.head],signal)
      await git(cwd,['read-tree','HEAD'],signal)
      const checkedOut=await paths(cwd,signal)
      for(const path of checkedOut)if(!s.files[path])await replace(cwd,path,null,s.blobs)
      for(const [path,value]of Object.entries(s.files))await replace(cwd,path,value,s.blobs)
      const input=Object.assign(Object.create(null),s.files)
      for(const ancestor of ancestors)for(const file of ancestor.outputs?.files ?? []) {
        if(!same(input[file.path]??null,file.before))throw taskError('依赖产物的输入版本冲突。','workflow-dependency-conflict',409)
        await replace(cwd,file.path,file.after,s.blobs)
        if(file.after)input[file.path]=file.after;else delete input[file.path]
      }
      await writeJson(metaPath,{taskId:root.taskId,nodeId:node.id,cwd,files:input})
      return {cwd,snapshotHash:digest(input)}
    },
    async capture(root,node,signal) {
      const {s,meta}=await nodeMeta(root,node)
      if((await git(meta.cwd,['rev-parse','HEAD'],signal)).trim()!==s.head)throw taskError('执行者修改了Git提交，停止交付。','workflow-git-mutated',409)
      const after=await snapshot(meta.cwd,s.blobs,Object.keys(meta.files),signal),files=[]
      for(const path of [...new Set([...Object.keys(meta.files),...Object.keys(after)])].sort()) {
        const before=meta.files[path]??null,next=after[path]??null
        if(same(before,next))continue
        if(!node.writePaths.some(scope=>scopeContains(scope,path)))throw taskError('执行者修改超出声明范围：'+path,'workflow-write-scope',409)
        files.push({path,before,after:next})
      }
      return {files,hash:digest(files)}
    },
    async integrate(root,signal) {
      const s=await source(root),manifest=join(s.base,'integration.json')
      if((await git(root.cwd,['rev-parse','HEAD'],signal)).trim()!==s.head)throw taskError('原项目HEAD发生变化，停止自动集成。','workflow-source-changed',409)
      const final=Object.assign(Object.create(null),s.files),changed=new Set()
      for(const id of root.workflow.order) {
        const node=root.workflow.nodes.find(n=>n.id===id)
        if(!node.outputs || digest(node.outputs.files)!==node.outputs.hash)throw taskError('子任务产物校验不匹配。','workspace-output-corrupt',409)
        for(const file of node.outputs.files) {
          if(!same(final[file.path]??null,file.before))throw taskError('子任务产物无法按依赖合并。','workflow-dependency-conflict',409)
          changed.add(file.path);if(file.after)final[file.path]=file.after;else delete final[file.path]
        }
      }
      const files=[...changed].sort().map(path=>({path,before:s.files[path]??null,after:final[path]??null})).filter(f=>!same(f.before,f.after))
      // Preflight every target before writing any file. Recheck each target before replacement.
      for(const file of files) {const current=await info(root.cwd,file.path);if(!same(current,file.before)&&!same(current,file.after))throw taskError('原文件已被其他编辑修改：'+file.path,'workflow-integration-conflict',409)}
      await writeJson(manifest,{taskId:root.taskId,files,state:'applying'})
      for(const file of files) {
        signal?.throwIfAborted()
        const current=await info(root.cwd,file.path)
        if(same(current,file.after))continue
        if(!same(current,file.before))throw taskError('集成时文件发生变化：'+file.path,'workflow-integration-conflict',409)
        await replace(root.cwd,file.path,file.after,s.blobs)
      }
      await writeJson(manifest,{taskId:root.taskId,files,state:'applied'})
      return {files:files.map(f=>({path:f.path,hash:f.after?.hash??null,deleted:!f.after})),hash:digest(files)}
    },
    async rollback(root) {
      const s=await source(root)
      let state
      try{state=await json(join(s.base,'integration.json'))}catch(error){if(missing(error))return;throw error}
      if((await git(root.cwd,['rev-parse','HEAD'])).trim()!==s.head)throw taskError('原项目HEAD已变化，保留集成现场。','workflow-source-changed',409)
      if(state.taskId!==root.taskId)throw taskError('集成记录不匹配。','workflow-integration-conflict',409)
      for(const f of state.files) {const current=await info(root.cwd,f.path);if(!same(current,f.before)&&!same(current,f.after))throw taskError('集成产物又被编辑，保留现场：'+f.path,'workflow-integration-conflict',409)}
      for(const f of [...state.files].reverse())if(same(await info(root.cwd,f.path),f.after))await replace(root.cwd,f.path,f.before,s.blobs)
      await writeJson(join(s.base,'integration.json'),{...state,state:'rolled-back'})
    },
  }
}
