// React hook/DOM contract test; real Chromium screenshots are a separate QA step.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
let plugin,mounted,current,hook=0,effects=[],uuid=0,failSubmit=true
const cells=new Map(),requests=[],timers=new Map()
const sample={taskId:'task-current',goal:'修复构建并核对产物',cwd:'D:/project',state:'REVIEW_REQUIRED',revision:7,activeRunId:'run-current',history:[{runId:'run-old',attempt:1,outcome:'error',result:{text:'先前失败'}}],run:{runId:'run-current',attempt:2,sessionId:'session-live',outcome:'completed',hostStopReason:'completed',evidenceHash:'evidence-7',verification:{status:'passed',checks:[{kind:'file',path:'dist/app.js',passed:true}],artifacts:[{path:'dist/app.js',bytes:17,hash:'hash'}]},review:{verdict:'approve',summary:'已核对'},result:{text:'构建产物已生成'}}}
sample.acceptance=['主体识别清楚'];sample.qualityProfile='visual'
let task=structuredClone(sample)
const React={
 Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props||{},children}),
 useState(value){const data=cells.get(current),i=hook++;if(!(i in data))data[i]=value;return [data[i],next=>{data[i]=typeof next==='function'?next(data[i]):next}]},
 useRef(value){const data=cells.get(current),i=hook++;return data[i]||(data[i]={current:value})},useCallback:fn=>fn,
 useEffect(fn,deps){const data=cells.get(current),i=hook++,prev=data[i];if(!prev||!deps||deps.some((d,j)=>d!==prev.deps[j])){data[i]={deps,cleanup:prev?.cleanup};effects.push(()=>{data[i].cleanup?.();data[i].cleanup=fn()})}},
}
const sandbox={window:{__ModuleLoader__:{load(def){plugin=def.factory(()=>React)}},confirm:()=>true},document:{createElement:()=>({setAttribute(){},remove(){}}),head:{appendChild(){}}},AbortController,setTimeout,clearTimeout,setInterval:fn=>{const id=timers.size+1;timers.set(id,fn);return id},clearInterval:id=>timers.delete(id),crypto:{randomUUID:()=>`test-key-${++uuid}`},Date,Promise,console,
fetch:async(url,options={})=>{
 const json=(value,status=200)=>({ok:status<400,json:async()=>value})
 if(!options.body)return json({ok:true,projects:[]})
 const body=JSON.parse(options.body);requests.push(body)
 if(body.action==='list')return json({ok:true,value:{tasks:[task],nextCursor:null}})
 if(body.action==='get')return json({ok:true,value:task})
 if(body.action==='events')return json({ok:true,value:{events:[{seq:1,eventId:'e',at:1,type:'run.finished'}]}})
 if(body.action==='diagnose')return json({ok:true,value:{version:'2.0.0-rc.1',hostNode:'v24',store:{status:'healthy'},capabilities:{state:true,controlledVerification:false},liveAcceptance:'not-verified'}})
 if(body.action==='submit'){if(failSubmit){failSubmit=false;throw Error('connection lost')}return json({ok:true,value:task})}
 if(body.action==='review')return json({ok:true,value:{...task,state:body.decision==='accept'?'SUCCEEDED':'REVIEW_REQUIRED'}})
 if(body.action==='answer')return json({ok:true,value:{...task,state:'RUNNING'}})
 if(body.action==='cancel')return json({ok:true,value:{...task,state:'CANCEL_REQUESTED'}})
 if(body.action==='retry'){if(!sandbox.retryFailed){sandbox.retryFailed=true;task={...task,activeRunId:'run-third',run:{...task.run,attempt:3}};throw Error('retry response lost')}return json({ok:true,value:task})}
 if(body.action==='repair_node'){task={...task,workflow:{...task.workflow,repairsUsed:1}};if(!sandbox.repairFailed){sandbox.repairFailed=true;throw Error('repair response lost')}return json({ok:true,value:task})}
  if(body.action==='reconcile')return json({ok:true,value:task})
 if(body.action==='importLegacy')return json({ok:true,value:{imported:1}})
 return json({ok:false,error:'unexpected'},500)
}}
vm.runInNewContext(fs.readFileSync(new URL('../client.js',import.meta.url),'utf8'),sandbox)
plugin.apply({slots:{inject(_,fn){fn()},register(def,fn){if(def.name==='main')mounted=fn;return ()=>{}}},get(name){return this[name]},effect(fn){fn()}})
const root=mounted()
function render(type,props={}){current=type;if(!cells.has(type))cells.set(type,[]);hook=0;effects=[];const tree=type(props);effects.forEach(fn=>fn());return tree}
function walk(node,out=[]){if(Array.isArray(node))node.forEach(n=>walk(n,out));else if(node&&typeof node==='object'){out.push(node);walk(node.children,out)}return out}
const button=(tree,label)=>{const node=walk(tree).find(n=>n.type==='button'&&n.children[0]===label);assert.ok(node,'missing button '+label);return node}
const flush=()=>new Promise(r=>setImmediate(r))
let tree=render(root.type);button(tree,'任务').props.onClick();tree=render(root.type)
const panel=tree.type,props=tree.props
const view=()=>render(panel,props)
tree=view();await flush();tree=view()
assert.equal(requests.filter(r=>['submit','cancel','review','answer','importLegacy','retry'].includes(r.action)).length,0,'mount must be read-only')
walk(tree).find(n=>n.props.className?.includes('cbt-task')).props.onClick();await flush();tree=view();await flush();tree=view()
assert.ok(JSON.stringify(tree).includes('hash'))
assert.ok(JSON.stringify(tree).includes('主体识别清楚'),'criteria must display without a plan')
assert.ok(JSON.stringify(tree).includes('视觉与动画'))
assert.equal(button(tree,'接受当前结果').props.disabled,true)
const check=walk(tree).find(n=>n.type==='input'&&n.props.type==='checkbox');check.props.onChange({target:{checked:true}});tree=view()
button(tree,'接受当前结果').props.onClick();await flush();tree=view()
const review=requests.find(r=>r.action==='review');assert.equal(review.expectedRevision,7);assert.equal(review.evidenceHash,'evidence-7');assert.equal(review.runId,'run-current')
button(tree,'Run 1').props.onClick();tree=view();assert.ok(JSON.stringify(tree).includes('先前失败'));assert.ok(!walk(tree).some(n=>n.type==='button'&&n.children[0]==='接受当前结果'))
button(tree,'当前运行').props.onClick();tree=view()
button(tree,'创建修复 Run').props.onClick();await flush();tree=view();button(tree,'刷新').props.onClick();await flush();tree=view();await flush();tree=view();assert.equal(button(tree,'创建修复 Run').props.disabled,false);button(tree,'创建修复 Run').props.onClick();await flush();tree=view();const retries=requests.filter(r=>r.action==='retry');assert.equal(retries.length,2);assert.equal(retries[0].idempotencyKey,retries[1].idempotencyKey)
button(tree,'新建任务').props.onClick();tree=view()
walk(tree).find(n=>n.type==='select'&&n.children.some(child=>child&&child.props&&child.props.value==='visual')).props.onChange({target:{value:'visual'}});tree=view()
const goal=walk(tree).find(n=>n.type==='textarea'&&n.props.required);goal.props.onChange({target:{value:'幂等提交'}});tree=view()
assert.ok(walk(tree).some(n=>n.type==='input'&&n.props.type==='number'&&n.props.max===7200));walk(tree).find(n=>n.type==='input'&&n.props.placeholder==='例如 max，须获授权').props.onChange({target:{value:'max'}});tree=view();
walk(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flush();tree=view();assert.ok(JSON.stringify(tree).includes('test-key-2'))
walk(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flush();tree=view()
const submits=requests.filter(r=>r.action==='submit');assert.equal(submits.length,2);assert.equal(submits[0].idempotencyKey,submits[1].idempotencyKey);assert.equal(submits[0].timeoutMs,undefined);assert.equal(submits[0].reasoningEffort,'max');assert.equal(submits[0].executionMode,'direct');assert.equal(submits[0].qualityProfile,'visual');assert.equal(submits[0].review,undefined);assert.equal(submits[0].plan,undefined)
button(tree,'诊断').props.onClick();await flush();tree=view();assert.ok(JSON.stringify(tree).includes('not-verified'))
// Refresh picks up a real question; selected labels and current requestId are sent together.
task={...task,state:'WAITING_INPUT',run:{...task.run,question:{requestId:'latest-question',questions:[{id:'q',question:'选择继续方式',options:[{label:'继续'},{label:'停止'}]}]}}}
button(tree,'刷新').props.onClick();await flush();tree=view();await flush();tree=view()
walk(tree).find(n=>n.type==='input'&&n.props.type==='radio').props.onChange();tree=view()
walk(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flush();tree=view()
const answer=requests.find(r=>r.action==='answer');assert.equal(answer.requestId,'latest-question');assert.deepEqual(answer.answers[0].selected,['继续'])
task={...sample,taskId:'workflow-parent',kind:'workflow',state:'WORKFLOW_PAUSED',run:{...sample.run,issue:{message:'alpha需要修复'}},workflow:{phase:'paused',parallelism:2,repairsUsed:0,maxRepairs:1,nodes:[{id:'alpha',goal:'修改A模块',state:'FAILED',childTaskId:'child-alpha',childState:'FAILED',dependsOn:[],writePaths:['src/a'],error:{message:'节点验证失败'}}]}}
button(tree,'刷新').props.onClick();await flush();tree=view();await flush();tree=view()
assert.ok(JSON.stringify(tree).includes('修改A模块'));assert.ok(JSON.stringify(tree).includes('src/a'))
assert.ok(!walk(tree).some(n=>n.type==='button'&&n.children[0]==='创建修复 Run'),'parent must not bypass node repair budget')
button(tree,'修复节点 alpha').props.onClick();await flush();tree=view()
button(tree,'刷新').props.onClick();await flush();tree=view();await flush();tree=view()
assert.equal(button(tree,'修复节点 alpha').props.disabled,false,'uncertain accepted repair must remain replayable at the budget boundary')
button(tree,'修复节点 alpha').props.onClick();await flush();tree=view()
const nodeRepairs=requests.filter(r=>r.action==='repair_node');assert.equal(nodeRepairs.length,2);assert.equal(nodeRepairs[0].idempotencyKey,nodeRepairs[1].idempotencyKey);assert.equal(nodeRepairs[0].nodeId,'alpha')
assert.ok(requests.filter(r=>r.action==='list').every(r=>r.rootsOnly===true))
console.log('PASS: task workbench read-only mount, guarded review, Run history, idempotent uncertain submit, diagnostics and current-question answer.')
