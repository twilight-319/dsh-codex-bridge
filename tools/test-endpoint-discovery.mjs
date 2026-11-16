import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveEndpoint, validateOrigin } from '../lib/endpoint-discovery.js';

test('strict HTTP loopback origin allowlist and normalization', () => {
  for (const [raw, expected] of [
    ['http://127.0.0.1:53874/', 'http://127.0.0.1:53874'],
    ['http://localhost:80', 'http://localhost'],
    ['HTTP://LOCALHOST:53874/', 'http://localhost:53874'],
    ['http://[::1]:53874', 'http://[::1]:53874'],
  ]) assert.equal(validateOrigin(raw), expected);

  for (const raw of [
    undefined, null, 42, '', 'https://127.0.0.1:53874', 'http://example.com',
    'http://127.0.0.2', 'http://127.1', 'http://2130706433', 'http://0x7f000001',
    'http://localhost.evil.test', 'http://localhost.', 'http://[::ffff:127.0.0.1]',
    'http://secret@localhost', 'http://localhost@evil.test', 'http://@localhost',
    'http://localhost/api', 'http://localhost//', 'http://localhost/.',
    'http://localhost/../', 'http://localhost/%2e/', 'http://localhost?',
    'http://localhost/?secret', 'http://localhost#', 'http://localhost/#secret',
    'http:\\localhost', 'http://localhost\\@evil.test', 'http://localhost:',
    'http://localhost:0', 'http://localhost:65536', 'http://localhost:-1',
  ]) assert.throws(() => validateOrigin(raw), { code: 'DSH_INVALID_ORIGIN' }, String(raw));
  assert.throws(() => validateOrigin('http://user:SENSITIVE@evil.test'), (error) => !error.message.includes('SENSITIVE'));
});

test('explicit wins without discovery access; discovery rereads and fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-endpoint-unit-'));
  const discoveryFile = path.join(dir, 'dsh-origin.json');
  const resolve = (explicitUrl) => resolveEndpoint({ explicitUrl, discoveryFile });
  const publish = (value) => fs.writeFileSync(discoveryFile, JSON.stringify(value));
  try {
    assert.throws(() => resolve(), (error) => error.code === 'DSH_NO_ORIGIN' && /启动或重载 DSH/.test(error.message));
    assert.equal(resolve('http://localhost:12345').origin, 'http://localhost:12345');
    publish({ version: 1, origin: 'http://127.0.0.1:11111', pid: 1, updatedAt: new Date().toISOString() });
    assert.equal(resolve().origin, 'http://127.0.0.1:11111');
    publish({ version: 1, origin: 'http://127.0.0.1:22222', pid: 2, updatedAt: new Date().toISOString() });
    assert.equal(resolve().origin, 'http://127.0.0.1:22222');
    assert.equal(resolve('http://localhost:33333').origin, 'http://localhost:33333');
    assert.throws(() => resolve('https://localhost'), { code: 'DSH_INVALID_ORIGIN' });
    assert.throws(() => resolve(''), { code: 'DSH_INVALID_ORIGIN' });
    for (const record of [null, [], {}, { version: 2, origin: 'http://localhost' }, { version: 1, origin: 42 }]) {
      publish(record);
      assert.throws(() => resolve(), { code: 'DSH_INVALID_DISCOVERY' });
    }
    publish({ version: 1, origin: 'http://secret@evil.test' });
    assert.throws(() => resolve(), (error) => error.code === 'DSH_INVALID_ORIGIN' && !error.message.includes('secret'));
    fs.writeFileSync(discoveryFile, '{broken');
    assert.throws(() => resolve(), { code: 'DSH_INVALID_DISCOVERY' });
    assert.equal(resolve('http://localhost:44444').origin, 'http://localhost:44444');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
