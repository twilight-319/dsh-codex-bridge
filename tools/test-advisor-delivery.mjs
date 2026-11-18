import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdvisorBudget, nativeAdvisorScope } from '../lib/advisor-budget.js'

const root = await mkdtemp(join(tmpdir(), 'bridge-advisor-'))
const priorProfile = process.env.USERPROFILE
const priorHome = process.env.HOME
process.env.USERPROFILE = root
process.env.HOME = root

const runnerUrl = new URL('../lib/codex-v2.js', import.meta.url).href
const hooks = registerHooks({
  load(url, context, next) {
    if (url === runnerUrl) return {
      format: 'module',
      source: `export const createRunner = () => ({ consult: request => globalThis.advisorFixture(request), dispose() {} });
               export const resolveCodexBin = () => null;`,
      shortCircuit: true,
    }
    return next(url, context)
  },
})

function fixtureSession() {
  const events = []
  const agent = {
    id: 'session-fixture', status: 'running',
    session: { header:{createdAt:1}, get seq(){return events.length}, eventAt:n=>events[n] },
  }
  let start
  let turn = 0
  const agents = {
    get:id=>id===agent.id?agent:null,
    currentInitiator:()=>agent,
    turnBoundaryOf:()=>({openTurnStartSeq:start}),
  }
  const human = (text, kind = 'user') => events.push({type:'user/message',data:{source:{kind},content:[{type:'text',text}]}})
  return {agent,agents,human,newTurn(text){start=events.length;events.push({type:'turn/start',data:{turn:++turn}});human(text)}}
}

try {
  const { apply } = await import('../index.js')
  hooks.deregister()
  const fixture = fixtureSession()
  const registered = new Map(), cleanups = []
  const host = {
    agents:fixture.agents,
    tools:{register(tool,options){registered.set(tool.name,{tool,options});return ()=>registered.delete(tool.name)}},
    systemPrompt:{section(){return ()=>{}}},
    workingDirectory:{ensure:async()=>root},
    effect(fn){cleanups.push(fn())},
  }
  const exec = {agent:fixture.agent,signal:new AbortController().signal}
  const tool = kind => registered.get('codex_'+kind).tool
  const invoke = (kind,args) => tool(kind).execute(args,exec)
  const requests = []
  let awaiting, resume
  let unavailable = false
  globalThis.advisorFixture = async request => {
    requests.push(request)
    if (awaiting) await awaiting
    if (unavailable) throw Object.assign(new Error('unavailable'),{code:'gateway-unavailable'})
    const answers = {
      plan: {task:'修改审批快照',assumptions:[],steps:[],decisions:[],acceptance:['旧审批人保持不变'],risks:[],openQuestions:[]},
      ask: {answer:'保留历史快照',keyPoints:[],nextAction:'用旧快照核对',openQuestions:[]},
    }
    return {answer:JSON.stringify(answers[request.kind]),meta:{elapsedMs:42,model:'fixture',effort:request.effort,sandbox:'read-only',cwd:root,usage:{input_tokens:19,cached_input_tokens:7,output_tokens:3}}}
  }
  const reload = options => {
    while (cleanups.length) cleanups.pop()()
    apply(host,{page:false,reverseBridge:false,...options})
  }

  reload()
  fixture.newTurn('小改动')
  await assert.rejects(invoke('ask',{question:'如何改？'}),/触发原因/)
  await assert.rejects(invoke('review',{focus:'检查 diff'}),/@codex/)
  assert.equal(requests.length,0)

  fixture.newTurn('给审批增加多人负责人，保持历史兼容')
  const plan = {task:'设计历史兼容',reason:'planning',context:'旧单保存单人快照'}
  awaiting = new Promise(resolve=>{resume=resolve})
  const first = invoke('plan',plan)
  await assert.rejects(invoke('ask',{question:'同回合再问',reason:'decision',context:'同一证据'}),{code:'ADVISOR_IN_PROGRESS_OR_UNKNOWN'})
  resume()
  const result = await first
  awaiting = null
  assert.equal(requests.length,1)
  assert.equal(requests[0].noRetry,true)
  assert.equal(requests[0].effort,'low')
  assert.equal(requests[0].timeoutMs,90_000)
  assert.match(requests[0].prompt,/旧单保存单人快照/)
  assert.equal(result._meta.source,'automatic')
  assert.equal(result._meta.cachedInputTokens,7)
  assert.deepEqual(tool('plan').output.presentationMeta(plan,result),result._meta)

  reload()
  const replay = await invoke('plan',plan)
  assert.equal(replay._meta.consultationId,result._meta.consultationId)
  assert.equal(replay._meta.reused,true)
  await assert.rejects(invoke('ask',{question:'别的问法',reason:'decision',context:'同一证据'}),{code:'ADVISOR_BUDGET_USED'})
  assert.equal(requests.length,1)

  fixture.human('@codex\n再确认旧审批的处理', 'plugin')
  assert.equal(nativeAdvisorScope(fixture.agents,fixture.agent).manualSeq,null,'a program message cannot grant a manual call')
  fixture.human('@codex\n再确认旧审批的处理')
  const manual = await invoke('ask',{question:'旧审批如何验证'})
  assert.equal(manual._meta.source,'manual')
  assert.notEqual(manual._meta.consultationId,result._meta.consultationId)
  assert.equal(requests[1].sessionKey,requests[0].sessionKey)

  fixture.newTurn('一条新的任务需要判断')
  const ask = {question:'给出下一步',reason:'blocked',context:'相同错误出现两次'}
  unavailable = true
  await assert.rejects(invoke('ask',ask),/gateway-unavailable/)
  await assert.rejects(invoke('ask',ask),{code:'ADVISOR_BUDGET_USED'})
  assert.equal(requests.length,3,'a failed automatic consultation is not dispatched again')
  assert.notEqual(requests[2].sessionKey,requests[0].sessionKey)
  unavailable = false

  reload({advisorMode:'manual'})
  fixture.newTurn('按手动模式处理')
  await assert.rejects(invoke('ask',ask),/@codex/)
  fixture.newTurn('@codex\n按手动模式询问专家')
  await invoke('ask',{question:'请给出一个建议'})
  globalThis.__dshCodexBridgeOwnedSessions.add(fixture.agent.id)
  assert.equal(registered.get('codex_ask').options.when({agent:fixture.agent}),false)
  await assert.rejects(invoke('ask',ask),/由 Codex 发起/)
  globalThis.__dshCodexBridgeOwnedSessions.delete(fixture.agent.id)
  assert.equal(requests.length,4)

  const records = join(root,'.dsh','codex-bridge','advisor-v1')
  const filenames = await readdir(records)
  assert.equal(filenames.filter(name=>name.endsWith('.claim.json')).length,4)
  const persisted = JSON.parse(await readFile(join(records,result._meta.consultationId.slice('consult-'.length)+'.result.json'),'utf8'))
  assert.equal(persisted.value._meta.inputTokens,19)
  assert.equal(persisted.value.acceptance[0],'旧审批人保持不变')
  const crashScope = {turnKey:'interrupted',manualSeq:null}
  const crashInput = {kind:'ask',question:'one question',input:{question:'one question'}}
  createAdvisorBudget(records)(crashScope,crashInput)
  assert.throws(()=>createAdvisorBudget(records)(crashScope,crashInput),{code:'ADVISOR_IN_PROGRESS_OR_UNKNOWN'})
  fixture.agent.status = 'idle'
  assert.equal(nativeAdvisorScope(fixture.agents,fixture.agent),null)
  while (cleanups.length) cleanups.pop()()

  const appServerUrl = new URL('../lib/appserver.js', import.meta.url).href
  const appServerHooks = registerHooks({
    load(url, context, next) {
      if (url === appServerUrl) return {
        format: 'module',
        source: `export const createAppServerSession = () => ({ alive:true, consult: () => globalThis.advisorTransportFixture(), dispose() {} });`,
        shortCircuit: true,
      }
      return next(url, context)
    },
  })
  const { createRunner } = await import(runnerUrl+'?transport-fixture')
  appServerHooks.deregister()
  const runner = createRunner({codexPath:process.execPath,logRuns:false})
  try {
    let calls = 0
    globalThis.advisorTransportFixture = async () => {
      calls++
      throw Object.assign(new Error('tool reply lost'),{code:'no-answer'})
    }
    await assert.rejects(runner.consult({prompt:'fixture',cwd:root,sessionKey:'transport',noRetry:true}),{code:'no-answer'})
    assert.equal(calls,1)
    assert.equal(runner.stats().sessions.length,0,'the next authorized turn can open a healthy session')
  } finally {
    delete globalThis.advisorTransportFixture
    await runner.dispose()
  }
  console.log('PASS: native expert authority, concurrency, replay, failure, manual mode, telemetry and reverse bridge protection.')
} finally {
  delete globalThis.advisorFixture
  if (priorProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = priorProfile
  if (priorHome === undefined) delete process.env.HOME
  else process.env.HOME = priorHome
  await rm(root,{recursive:true,force:true})
}
