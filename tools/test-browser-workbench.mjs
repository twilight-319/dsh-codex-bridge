// Optional real React + Chromium QA against synthetic host responses, never real DSH data.
import fs from 'node:fs'
import path from 'node:path'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.BRIDGE_PLAYWRIGHT_MODULE||'playwright')
const dependencies=process.env.BRIDGE_REACT_MODULES
if(!dependencies)throw Error('BRIDGE_REACT_MODULES must point to test-only node_modules')
const assets={'/react.js':path.join(dependencies,'react/umd/react.development.js'),'/react-dom.js':path.join(dependencies,'react-dom/umd/react-dom.development.js'),'/client.js':new URL('../client.js',import.meta.url)}
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Task workbench fixture</title><style>html,body,#root{height:100%;margin:0}body{--dsw-alias-bg-base:#f7f8fa;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f1f4f9;--dsw-alias-label-primary:#17202d;--dsw-alias-label-secondary:#637083;--dsw-alias-border-l1:#d8dfe7}body.dark{--dsw-alias-bg-base:#141820;--dsw-alias-bg-layer-1:#1c2430;--dsw-alias-bg-layer-2:#263345;--dsw-alias-label-primary:#edf1f7;--dsw-alias-label-secondary:#adb9ca;--dsw-alias-border-l1:#3b495c}</style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(def){const plugin=def.factory(()=>React);plugin.apply({slots:{inject(_,fn){fn()},register(def,fn){if(def.name==='main')window.main=fn;return ()=>{}}},get(n){return this[n]},effect(fn){fn()}});ReactDOM.createRoot(document.getElementById('root')).render(window.main())}}</script><script src="/client.js"></script></html>`
const server=createServer((req,res)=>{if(assets[req.url]){res.setHeader('content-type','text/javascript');res.end(fs.readFileSync(assets[req.url]))}else {res.setHeader('content-type','text/html');res.end(html)}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true,...(process.env.BRIDGE_CHROMIUM_PATH?{executablePath:process.env.BRIDGE_CHROMIUM_PATH}:{}),args:['--no-sandbox']})
const output=path.resolve(process.env.BRIDGE_UI_OUTPUT||'browser-qa');fs.mkdirSync(output,{recursive:true})
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],mutations=[]
 page.on('pageerror',e=>errors.push(e.message))
 let task={taskId:'task-fixture',goal:'核对构建结果与发布清单',cwd:'D:/workspace/sample-project',state:'REVIEW_REQUIRED',revision:9,activeRunId:'run-2',history:[{runId:'run-1',attempt:1,outcome:'error',result:{text:'首轮测试失败，修复后再次验证。'}}],run:{runId:'run-2',attempt:2,sessionId:'session-fixture',outcome:'completed',hostStopReason:'completed',evidenceHash:'manifest-fixture',execution:{selection:{provider:'fixture',model:'controlled-model'}},verification:{status:'passed',checks:[{path:'dist/application.js',passed:true}],artifacts:[{path:'dist/application.js',bytes:1024,hash:'0123456789abcdef'.repeat(4)}]},review:{verdict:'approve',summary:'验收条件已有对应证据。'},result:{text:'构建完成。测试、文件产物与只读审查均已记录。此数据为浏览器测试夹具。'}}}
 await page.route('**/api/**',async route=>{
  const request=route.request(),body=request.postDataJSON()||{},json=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,value})})
  if(request.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"projects":[]}'})
  if(body.action==='list')return json({tasks:[task],nextCursor:null})
  if(body.action==='get')return json(task)
  if(body.action==='events')return json({events:[{eventId:'one',at:Date.now(),type:'verification.passed'}]})
  if(body.action==='diagnose')return json({version:'2.0.0-rc.1',hostNode:'v24',store:{status:'healthy'},capabilities:{state:true,cancel:true,controlledVerification:false},liveAcceptance:'not-verified'})
  mutations.push(body)
  if(body.action==='review')task={...task,state:body.decision==='accept'?'SUCCEEDED':'REVIEW_REQUIRED'}
  if(body.action==='answer')task={...task,state:'RUNNING'}
  return json(task)
 })
 await page.goto('http://127.0.0.1:'+server.address().port)
 await page.getByRole('button',{name:'任务',exact:true}).click()
 await page.getByRole('heading',{name:'任务工作台'}).waitFor()
 await page.getByRole('button',{name:/核对构建结果与发布清单/}).click()
 await page.getByRole('button',{name:'接受当前结果',exact:true}).waitFor()
 assert.equal(mutations.length,0)
 assert.equal(await page.getByRole('button',{name:'接受当前结果',exact:true}).isDisabled(),true)
 await page.screenshot({path:path.join(output,'desktop-light.png'),fullPage:true})
 await page.evaluate(()=>document.body.classList.add('dark'))
 await page.screenshot({path:path.join(output,'desktop-dark.png'),fullPage:true})
 await page.setViewportSize({width:390,height:844})
 await page.evaluate(()=>document.body.classList.remove('dark'))
 await page.screenshot({path:path.join(output,'mobile-light.png'),fullPage:true})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'document must not overflow horizontally')
 await page.getByRole('checkbox',{name:'我已核对当前 Run 的产物和验收证据'}).check()
 await page.getByRole('button',{name:'接受当前结果',exact:true}).click()
 await page.getByText('验收通过',{exact:true}).first().waitFor()
 assert.equal(mutations[0].evidenceHash,'manifest-fixture');assert.equal(mutations[0].expectedRevision,9)
 await page.getByRole('button',{name:'Run 1',exact:true}).click()
 await page.getByText('首轮测试失败，修复后再次验证。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'当前运行',exact:true}).click()
 task={...task,state:'WAITING_INPUT',revision:10,run:{...task.run,question:{requestId:'current-question',questions:[{id:'choice',question:'是否继续受控验收？',options:[{label:'继续'},{label:'停止'}]}]}}}
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.getByRole('radio',{name:'继续',exact:true}).check()
 await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.action==='answer'),page.getByRole('button',{name:'回答并继续',exact:true}).click()])
 assert.equal(mutations.at(-1).requestId,'current-question')
 await page.getByRole('button',{name:'新建任务',exact:true}).click()
 await page.getByLabel('任务目标',{exact:true}).fill('验证任务表单键盘输入')
 await page.keyboard.press('Tab')
 assert.ok(await page.evaluate(()=>document.activeElement!==document.body))
 await page.screenshot({path:path.join(output,'mobile-form.png'),fullPage:true})
 assert.deepEqual(errors,[])
 if(process.env.BRIDGE_UI_LOG_PREVIEW==='1') {
  for(const name of ['desktop-light','desktop-dark','mobile-light','mobile-form']) {
   const bytes=fs.readFileSync(path.join(output,name+'.png'))
   const data=await page.evaluate(async base64=>{
    const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode()
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0)
    return canvas.toDataURL('image/webp',0.75)
   },bytes.toString('base64'))
   console.log('BRIDGE_QA_IMAGE '+name+' '+data)
  }
 }
 console.log(JSON.stringify({passed:true,browser:browser.version(),react:'18.3.1',themes:['light','dark'],viewports:[1440,390],fixtureOnly:true}))
}finally {await browser.close();await new Promise(r=>server.close(r))}
