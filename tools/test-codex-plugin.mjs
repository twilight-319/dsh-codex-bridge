// Self-contained cached-plugin smoke: no real user tokens or model calls.
import test from'node:test'
import assert from'node:assert/strict'
import{mkdtemp,cp,readFile,mkdir,writeFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve}from'node:path'
import{spawn}from'node:child_process'
import{createInterface}from'node:readline'
import{createServer}from'node:http'
test('Codex root plugin is portable, async-first and cache-contained',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-public-plugin-')),cache=join(dir,'cache with spaces'),home=join(dir,'isolated-user');let child,server
 try{
  await mkdir(cache);await mkdir(home)
  for(const path of ['bin','lib','docs','package.json','.mcp.json','.codex-plugin','skills'])await cp(new URL('../'+path,import.meta.url),join(cache,path),{recursive:true})
  const market=JSON.parse(await readFile(new URL('../.agents/plugins/marketplace.json',import.meta.url),'utf8'));assert.equal(market.plugins[0].source.path,'.')
  const plugin=JSON.parse(await readFile(join(cache,'.codex-plugin/plugin.json'),'utf8'));assert.equal(plugin.version,'0.8.0');assert.ok(plugin.interface.defaultPrompt.join().includes('dsh_task_submit'))
  const skill=await readFile(join(cache,'skills/dsh-execute/SKILL.md'),'utf8');assert.ok(skill.includes('dsh_task_wait'));assert.ok(skill.includes('不要默认用旧同步'));assert.ok(skill.split('\n').length<500)
  const config=JSON.parse(await readFile(join(cache,'.mcp.json'),'utf8')).mcpServers.dsh_bridge;assert.equal(config.command,'node');assert.equal(config.cwd,'.');assert.equal(config.default_tools_approval_mode,undefined)
  const env={...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:home};for(const key of Object.keys(env))if(key.startsWith('DSH_BRIDGE_'))delete env[key]
  child=spawn(process.execPath,config.args,{cwd:resolve(cache,config.cwd),env,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b)
  const lines=createInterface({input:child.stdout}),pending=new Map();let id=0
  lines.on('line',line=>{const frame=JSON.parse(line),p=pending.get(frame.id);if(p){clearTimeout(p.timer);pending.delete(frame.id);p.resolve(frame)}})
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('MCP timeout '+stderr)),5000);pending.set(n,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')})
  const call=async(name,args={})=>(await rpc('tools/call',{name,arguments:args})).result
  await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'cache-smoke',version:'1'}})
  const tools=(await rpc('tools/list',{})).result.tools;for(const name of ['dsh_task_submit','dsh_task_observe','dsh_task_wait','dsh_task_preview','dsh_task_orchestrate','dsh_task_repair_node'])assert.ok(tools.some(t=>t.name===name))
  assert.ok(tools.find(t=>t.name==='dsh_task_submit').inputSchema.properties.reasoningEffort)
  const missing=await call('dsh_status');assert.equal(missing.isError,true,'empty isolated home must not find real user DSH')
  let requests=0
  server=createServer((req,res)=>{requests++;assert.equal(req.headers.authorization,'Bearer isolated-test-only');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,pid:1,sessions:0,version:'test-fixture'}))});await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const data=join(home,'.dsh/codex-bridge');await mkdir(data,{recursive:true});await writeFile(join(data,'http-token'),'isolated-test-only');await writeFile(join(data,'dsh-origin.json'),JSON.stringify({version:1,origin:'http://127.0.0.1:'+server.address().port}))
  const healthy=await call('dsh_status');assert.notEqual(healthy.isError,true);assert.equal(requests,1);assert.ok(!stderr.includes('isolated-test-only'))
  lines.close();for(const p of pending.values())clearTimeout(p.timer)
 }finally{if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill();await end}if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(dir,{recursive:true,force:true})}
})
