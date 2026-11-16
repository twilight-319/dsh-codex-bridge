import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join, dirname} from 'node:path'
import {randomUUID} from 'node:crypto'

/** Publish only the local bridge origin, never credentials. Last active host wins. */
export function publishBridgeOrigin(ctx, {logger=ctx.logger, file=join(homedir(),'.dsh','codex-bridge','dsh-origin.json')}={}) {
  const instanceId=randomUUID()
  let disposed=false, writing=Promise.resolve()
  async function publish() {
    if(disposed)return
    const web=typeof ctx.get==='function'?ctx.get('webServer'):ctx.webServer
    const raw=web?.getOrigin?.()
    if(!raw)return
    const url=new URL(raw)
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Bridge origin must be an HTTP loopback origin')
    const origin=url.origin
    // Do not overwrite another active instance periodically; write at mount only.
    await mkdir(dirname(file),{recursive:true})
    const temp=file+'.'+instanceId+'.tmp'
    try {
      await writeFile(temp,JSON.stringify({version:1,origin,pid:process.pid,instanceId,updatedAt:Date.now()})+'\n',{mode:0o600})
      if(disposed){await unlink(temp).catch(()=>{});return}
      await rename(temp,file)
      logger?.info?.('codex-bridge: endpoint discovery published '+origin)
    } catch(error) {await unlink(temp).catch(()=>{});throw error}
  }
  writing=publish().catch(error=>logger?.warn?.('codex-bridge: cannot publish endpoint discovery: '+error.message))
  // Keep a stale non-secret origin rather than deleting during unload: deleting
  // after read has a cross-process race. Next mount atomically replaces it; a
  // stopped endpoint fails clearly and execution POSTs are never auto-retried.
  const dispose=()=>{disposed=true;return writing}
  if(typeof ctx.effect==='function')ctx.effect(()=>dispose)
  return {ready:writing,dispose}
}
