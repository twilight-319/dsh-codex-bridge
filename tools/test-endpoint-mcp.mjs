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
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['dsh_execute', 'dsh_answer', 'dsh_status']);
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
