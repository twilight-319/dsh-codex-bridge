import {dispatchTask} from './task-api.js'
export const TASK_BROWSER_PATH='/api/dsh-codex-bridge.v2.task-workbench'
/** Mount only through the host's browser-authenticated connection registry. */
export function createTaskBrowserApi({manager,diagnostics,legacyRecords}) {
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}})
  return async request=>{
    if(request.method!=='POST')return json({ok:false,error:'method-not-allowed'},405)
    if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return json({ok:false,error:'cross-origin'},403)
    try {
      const raw=await request.text()
      if(raw.length>60000)return json({ok:false,error:'body-too-large'},413)
      const body=JSON.parse(raw)
      let value
      if(body.action==='answer'){const {action,...input}=body;value=await manager().answer(input,{wait:false})}
      else if(body.action==='diagnose')value=await diagnostics()
      else if(body.action==='importLegacy')value=manager().importLegacy(legacyRecords())
      else if(body.action==='review'){const {action,...input}=body;value=manager().review(input)}
      else value=await dispatchTask(manager(),body,{signal:request.signal})
      return json({ok:true,value})
    }catch(error){return json({ok:false,error:error.code??'task-operation-failed',message:error.status?error.message:'操作失败，请保留任务编号并检查诊断。'},error.status??(error instanceof SyntaxError?400:500))}
  }
}
