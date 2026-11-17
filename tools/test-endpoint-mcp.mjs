// Standalone integration tests. All homes/tokens/discovery files are temporary;
// never read/write the real profile, start CodexApp or contact the live DSH host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {dispatchTask} from '../lib/task-api.js';

const serverPath = fileURLToPath(new URL('../bin/mcp-server.mjs', import.meta.url));
const TOKEN = 'endpoint-test-bearer-DO-NOT-LOG';

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-endpoint-mcp-'));
  const bridgeDir = path.join(home, '.dsh', 'codex-bridge');
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'http-token'), TOKEN);
  const clients = [];
  const servers = [];
  const publish = (origin) => {
    const dest = path.join(bridgeDir, 'dsh-origin.json');
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, origin, pid: process.pid, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, dest);
  };
  async function mock(label, handler, host = '127.0.0.1') {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
        if (handler) return handler(req, res);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.method === 'POST' ? { ok: true, sessionId: 'session-test', stopReason: 'completed', text: label } : { ok: true, pid: 1, sessions: 0, label }));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
    servers.push(server);
    const addressHost = host === '::1' ? '[::1]' : host;
    return { origin: `http://${addressHost}:${server.address().port}`, requests };
  }
  async function client(args = [], env = {}, nodeArgs = []) {
    const childEnv = { ...process.env, HOME: home, USERPROFILE: home, DSH_BRIDGE_TOKEN: '', DSH_BRIDGE_TOKEN_FILE: '' };
    delete childEnv.DSH_BRIDGE_URL;
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [...nodeArgs, serverPath, ...args], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const frames = [];
    const pending = new Map();
    let nextId = 0;
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const frame = JSON.parse(line);
        frames.push(frame);
        const entry = pending.get(frame.id);
        if (entry) { clearTimeout(entry.timer); pending.delete(frame.id); entry.resolve(frame); }
      } catch (error) {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear();
      }
    });
    child.on('exit', (code) => {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`MCP exited ${code}: ${stderr}`)); }
      pending.clear();
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timed out: ${method}: ${stderr}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const api = {
      child, frames, request,
      stderr: () => stderr,
      call: async (name = 'dsh_status') => {
        const frame = await request('tools/call', { name, arguments: name === 'dsh_execute' ? { task: 'test-only', timeoutMs: 1000 } : {} });
        assert.equal(frame.error, undefined);
        return frame.result;
      },
    };
    clients.push(api);
    const init = await request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'endpoint-test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await request('tools/list', {});
    assert.deepEqual(list.result.tools.slice(0,3).map((tool) => tool.name), ['dsh_execute', 'dsh_answer', 'dsh_status']);
    assert.ok(list.result.tools.some(tool=>tool.name==='dsh_task_submit'));
    return api;
  }
  t.after(async () => {
    for (const api of clients) {
      if (api.child.exitCode === null) {
        const exited = new Promise((resolve) => api.child.once('exit', resolve));
        api.child.kill();
        await exited;
      }
      assert.ok(!api.stderr().includes(TOKEN), 'stderr must never log bearer token');
    }
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    // Exact target was created above with mkdtemp; never derived from real HOME.
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, bridgeDir, publish, mock, client };
}

const text = (result) => result.content.map((item) => item.text).join('\n');
const statusLabel = (result) => JSON.parse(result.content[0].text).dsh.label;

test('malformed/failed HTTP successes never become MCP success for any tool', async (t) => {
  const f = await fixture(t);
  let payload = '';
  const mock = await f.mock('bad', (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(payload); });
  f.publish(mock.origin); const api = await f.client();
  for (const value of ['', '<html>not JSON</html>', 'null', '{}', '{"ok":false,"error":"rejected"}', '{"ok":true,"text":"fake"}']) {
    payload = value;
    for (const name of ['dsh_status', 'dsh_execute', 'dsh_answer']) {
      const args = name === 'dsh_execute' ? { task: 'test', timeoutMs: 1000 } : name === 'dsh_answer' ? { sessionId: 'session-test', requestId: 'q1', answers: [{ id: 'q', selected: [] }] } : {};
      const frame = await api.request('tools/call', { name, arguments: args });
      assert.equal(frame.error, undefined, JSON.stringify(frame.error));
      assert.equal(frame.result.isError, true, name + ':' + value);
    }
  }
  payload = JSON.stringify({ ok: true, sessionId: 'session-test', stopReason: 'completed', text: 'answered' });
  const good = await api.request('tools/call', { name: 'dsh_answer', arguments: { sessionId: 'session-test', requestId: 'q1', answers: [{ id: 'q', selected: [] }] } });
  assert.notEqual(good.result.isError, true);
  assert.equal(JSON.parse(mock.requests.at(-1).body).requestId, 'q1');
  for (const args of [{ sessionId: 's', answers: [] }, { sessionId: 's', requestId: 'r', answers: [{ id: 'q', selected: [3] }] }, { sessionId: 's', requestId: 'r', answers: [{ id: 'q', custom: 4 }] }]) {
    const frame = await api.request('tools/call', { name: 'dsh_answer', arguments: args });
    assert.equal(frame.error.code, -32602);
  }
});

test('async wait cancellation is observer-only and tool schemas distinguish budgets', async(t)=>{
  const f=await fixture(t); const bodies=[];
  const mock=await f.mock('tasks',(req,res)=>{const chunks=[]; // fixture already consumed request, inspect captured body below
    res.setHeader('content-type','application/json');
    setTimeout(()=>res.end(JSON.stringify({ok:true,value:{reason:'wait-expired',task:{taskId:'t',state:'RUNNING'}}})),50);
  });f.publish(mock.origin);const api=await f.client();
  const tools=(await api.request('tools/list',{})).result.tools;
  assert.ok(tools.find(t=>t.name==='dsh_task_wait').inputSchema.properties.waitMs);
  assert.ok(tools.find(t=>t.name==='dsh_task_submit').description.includes('异步'));
  const waiting=api.request('tools/call',{name:'dsh_task_wait',arguments:{taskId:'t',waitMs:10}});
  api.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:5}})+'\n');
  const result=await waiting;assert.notEqual(result.result.isError,true);
  assert.equal(mock.requests.length,1);assert.equal(JSON.parse(mock.requests[0].body).action,'wait');
  const answer=await api.request('tools/call',{name:'dsh_task_answer',arguments:{taskId:'t',runId:'r',requestId:'q',answers:[]}});assert.notEqual(answer.result.isError,true);
  assert.equal(mock.requests.length,2);assert.equal(JSON.parse(mock.requests[1].body).action,'answer');
});

test('await uses one HTTP observation, summary/full projection and read-only hints', async t => {
  const f=await fixture(t)
  const task={taskId:'t',activeRunId:'r',state:'REVIEW_REQUIRED',revision:9,goal:'private context',requestedInput:{large:'x'.repeat(20000)},run:{sessionId:'s',result:{stopReason:'completed',text:'done'},verification:{status:'not_configured'}}}
  const mock=await f.mock('await',(req,res)=>{res.setHeader('content-type','application/json');const body=JSON.parse(mock.requests.at(-1).body);res.end(JSON.stringify({ok:true,value:body.action==='await'?{task,reason:'settled-or-input'}:task}))})
  f.publish(mock.origin);const api=await f.client()
  const tools=(await api.request('tools/list',{})).result.tools
  assert.equal(tools.find(t=>t.name==='dsh_task_await').annotations.readOnlyHint,true)
  assert.equal(tools.find(t=>t.name==='dsh_task_submit').annotations.readOnlyHint,false)
  const awaited=(await api.request('tools/call',{name:'dsh_task_await',arguments:{taskId:'t',waitMs:60000}})).result
  const summary=JSON.parse(awaited.content[0].text)
  assert.equal(summary.task.executionCompleted,true);assert.equal(summary.task.goal,undefined)
  assert.equal(mock.requests.length,1);assert.equal(JSON.parse(mock.requests[0].body).waitMs,60000)
  const fetched=(await api.request('tools/call',{name:'dsh_task_get',arguments:{taskId:'t',detail:'full'}})).result
  assert.equal(JSON.parse(fetched.content[0].text).goal,'private context')
  assert.equal(JSON.parse(mock.requests.at(-1).body).detail,undefined,'view options must not enter task idempotency input')
  const invalid=await api.request('tools/call',{name:'dsh_task_await',arguments:{taskId:'t',waitMs:600001}})
  assert.equal(invalid.error.code,-32602);assert.equal(mock.requests.length,2)
})

test('cancelling an active await closes only its HTTP observation, without a cancel POST',async t=>{
  const f=await fixture(t)
  const mock=await f.mock('pending',()=>{})
  f.publish(mock.origin);const api=await f.client()
  // fixture initialization uses request IDs 1 and 2, so this observation is 3.
  const waiting=api.request('tools/call',{name:'dsh_task_await',arguments:{taskId:'t',waitMs:60000}})
  for(let i=0;i<100&&!mock.requests.length;i++)await new Promise(r=>setTimeout(r,5))
  assert.equal(mock.requests.length,1)
  api.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:3}})+'\n')
  const result=await waiting
  assert.equal(result.result.isError,true);assert.ok(result.result.content[0].text.includes('后台DSH任务继续'))
  assert.deepEqual(mock.requests.map(r=>JSON.parse(r.body).action),['await'])
})

test('await network failure is a recoverable tool error with one POST and no automatic retry',async t=>{
  const f=await fixture(t),mock=await f.mock('reset',(_req,res)=>res.destroy())
  f.publish(mock.origin);const api=await f.client()
  const frame=await api.request('tools/call',{name:'dsh_task_await',arguments:{taskId:'known-task',waitMs:60000}})
  assert.equal(frame.error,undefined);assert.equal(frame.result.isError,true)
  assert.ok(frame.result.content[0].text.includes('保留原taskId'))
  assert.equal(mock.requests.length,1)
})

test('workflow MCP tools route graph admission and idempotent node repair with compact child status',async t=>{
  const f=await fixture(t),seen=[]
  const root={taskId:'workflow-test',kind:'workflow',activeRunId:'r',cwd:f.home,state:'WORKFLOW_PAUSED',revision:1,workflow:{phase:'paused',parallelism:2,repairsUsed:0,maxRepairs:1,maxModelCalls:40,maxObservedTokens:null,nodes:[{id:'alpha',state:'FAILED',dependsOn:[],writePaths:['a.txt'],childTaskId:'child-a'}]},run:{deadline:Date.now()+10000,issue:{code:'node-failed',nodeId:'alpha',message:'repair required'},verification:{status:'pending'}}}
  const manager={async orchestrate(input){seen.push(input);return root},async repairNode(input){seen.push(input);return root}}
  const mock=await f.mock('workflow',async(req,res)=>{const value=await dispatchTask(manager,JSON.parse(mock.requests.at(-1).body));res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,value}))})
  f.publish(mock.origin);const api=await f.client()
  const tools=(await api.request('tools/list',{})).result.tools
  assert.ok(tools.find(t=>t.name==='dsh_task_orchestrate').inputSchema.properties.nodes.items.properties.writePaths)
  const nodes=[{id:'alpha',goal:'a',writePaths:['a.txt']}]
  const frame=await api.request('tools/call',{name:'dsh_task_orchestrate',arguments:{goal:'graph',idempotencyKey:'one',nodes,parallelism:2}})
  const summary=JSON.parse(frame.result.content[0].text)
  assert.equal(summary.kind,'workflow');assert.equal(summary.workflow.nodes[0].childTaskId,'child-a');assert.equal(summary.issue.nodeId,'alpha');assert.deepEqual(seen[0].nodes,nodes)
  await api.request('tools/call',{name:'dsh_task_repair_node',arguments:{taskId:'workflow-test',nodeId:'alpha',idempotencyKey:'repair-one'}})
  assert.equal(seen[1].nodeId,'alpha');assert.equal(seen[1].idempotencyKey,'repair-one')
})

test('same initialized MCP process follows discovery changes for GET and POST', async (t) => {
  const f = await fixture(t);
  const a = await f.mock('first');
  const b = await f.mock('second');
  f.publish(a.origin);
  const api = await f.client();
  assert.equal(statusLabel(await api.call()), 'first');
  assert.equal(text(await api.call('dsh_execute')).split('\n')[0], 'first');
  f.publish(b.origin);
  assert.equal(statusLabel(await api.call()), 'second');
  assert.equal(text(await api.call('dsh_execute')).split('\n')[0], 'second');
  assert.equal(a.requests.length, 2);
  assert.equal(b.requests.length, 2);
  for (const req of [...a.requests, ...b.requests]) {
    assert.equal(req.authorization, `Bearer ${TOKEN}`);
    assert.match(req.url, /^\/api\/dsh-codex-bridge\.v3\.(status|execute)$/);
  }
});

test('discovery can be published after initialize and invalidated without restarting MCP', async (t) => {
  const f = await fixture(t);
  const api = await f.client();
  const missing = await api.call();
  assert.equal(missing.isError, true);
  assert.match(text(missing), /启动或重载 DSH/);
  assert.ok(!text(missing).includes('61411'));
  const a = await f.mock('later');
  f.publish(a.origin);
  assert.equal(statusLabel(await api.call()), 'later');
  f.publish('http://endpoint-test-bearer-DO-NOT-LOG@evil.test');
  const unsafe = await api.call();
  assert.equal(unsafe.isError, true);
  assert.ok(!text(unsafe).includes(TOKEN));
  assert.equal(a.requests.length, 1);
});

test('explicit CLI overrides env and discovery; env overrides discovery', async (t) => {
  const f = await fixture(t);
  const a = await f.mock('discovery');
  const b = await f.mock('env');
  const c = await f.mock('cli');
  f.publish(a.origin);
  const api = await f.client(['--url', c.origin], { DSH_BRIDGE_URL: b.origin });
  assert.equal(statusLabel(await api.call()), 'cli');
  f.publish('http://evil.test');
  assert.equal(statusLabel(await api.call()), 'cli');
  const envApi = await f.client([], { DSH_BRIDGE_URL: b.origin });
  assert.equal(statusLabel(await envApi.call()), 'env');
  assert.equal(a.requests.length, 0);
});

test('invalid CLI or env fails closed and never logs raw credentials', async (t) => {
  const f = await fixture(t);
  const a = await f.mock('should-not-receive');
  f.publish(a.origin);
  for (const [args, env] of [
    [['--url', `http://${TOKEN}@localhost`], {}],
    [['--url'], {}],
    [['--url='], {}],
    [[], { DSH_BRIDGE_URL: 'https://localhost' }],
    [[], { DSH_BRIDGE_URL: '' }],
  ]) {
    const api = await f.client(args, env);
    const result = await api.call();
    assert.equal(result.isError, true);
    assert.ok(!text(result).includes(TOKEN));
  }
  assert.equal(a.requests.length, 0);
});

test('localhost and IPv6 loopback transport work', async (t) => {
  const f = await fixture(t);
  const a = await f.mock('localhost');
  f.publish(a.origin.replace('127.0.0.1', 'localhost'));
  // Override lookup in the child: any hostname lookup is a test failure. Literal
  // loopback bypasses lookup, proving localhost cannot be rebound by local DNS.
  const preload = path.join(f.home, 'deny-dns.cjs');
  fs.writeFileSync(preload, "require('node:dns').lookup = () => { throw new Error('DNS lookup must not run'); };\n");
  const api = await f.client([], {}, ['--require', preload]);
  assert.equal(statusLabel(await api.call()), 'localhost');
  let b;
  try { b = await f.mock('ipv6', undefined, '::1'); }
  catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.diagnostic('IPv6 unavailable; IPv4/localhost verified'); return; }
    throw error;
  }
  f.publish(b.origin);
  assert.equal(statusLabel(await api.call()), 'ipv6');
});

test('redirects are not followed and POST network failure is never retried', async (t) => {
  const f = await fixture(t);
  const sink = await f.mock('must-not-follow');
  const redirect = await f.mock('redirect', (_req, res) => { res.writeHead(302, { location: sink.origin }); res.end(); });
  f.publish(redirect.origin);
  const api = await f.client();
  assert.equal((await api.call()).isError, true);
  assert.equal((await api.call('dsh_execute')).isError, true);
  assert.equal(sink.requests.length, 0);
  const dropped = await f.mock('drop', (req) => {
    // Move discovery after accepting work, before the client sees failure.
    f.publish(sink.origin);
    req.socket.destroy();
  });
  f.publish(dropped.origin);
  assert.equal((await api.call('dsh_execute')).isError, true);
  assert.equal(dropped.requests.length, 1);
  assert.equal(sink.requests.length, 0, 'no implicit POST replay after rediscovery');
  assert.equal(statusLabel(await api.call()), 'must-not-follow');
});
