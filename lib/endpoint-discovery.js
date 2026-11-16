import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DISCOVERY_FILE = path.join(os.homedir(), '.dsh', 'codex-bridge', 'dsh-origin.json');
const START_HINT = '请启动或重载 DSH，让桥接插件发布当前 origin；也可用 --url / DSH_BRIDGE_URL 显式指定本机 HTTP origin。';

function endpointError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Validate the original spelling before WHATWG URL normalization: it would otherwise
// accept shorthand/decimal IPv4, backslashes, dot segments and empty ?/# delimiters.
// Never interpolate rejected input into diagnostics: it might contain credentials.
export function validateOrigin(raw) {
  if (typeof raw !== 'string') {
    throw endpointError('DSH_INVALID_ORIGIN', 'DSH origin 无效：必须是本机 HTTP origin。');
  }
  const value = raw.trim();
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/i.test(value)) {
    throw endpointError('DSH_INVALID_ORIGIN', 'DSH origin 无效：仅允许 http://127.0.0.1、http://localhost 或 http://[::1]（可带端口和根路径 /），禁止 userinfo、其他路径、query 和 hash。');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw endpointError('DSH_INVALID_ORIGIN', 'DSH origin 无效：HTTP origin 或端口格式不合法。');
  }
  if (url.port === '0') {
    throw endpointError('DSH_INVALID_ORIGIN', 'DSH origin 无效：端口必须为 1~65535。');
  }
  return url.origin;
}

// No cache, old-port fallback, PID liveness guess or TTL: a long-lived MCP process
// must follow the host's latest published origin on EVERY HTTP request.
export function resolveEndpoint({ explicitUrl, discoveryFile = DEFAULT_DISCOVERY_FILE } = {}) {
  if (explicitUrl !== undefined) return { origin: validateOrigin(explicitUrl), source: 'explicit' };
  let record;
  try {
    record = JSON.parse(fs.readFileSync(discoveryFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw endpointError('DSH_NO_ORIGIN', `未找到 DSH origin 发现文件。${START_HINT}`);
    }
    throw endpointError('DSH_INVALID_DISCOVERY', `无法读取 DSH origin 发现文件（文件不可读或 JSON 无效）。${START_HINT}`);
  }
  if (!record || Array.isArray(record) || record.version !== 1 || typeof record.origin !== 'string') {
    throw endpointError('DSH_INVALID_DISCOVERY', `DSH origin 发现文件格式无效（需要 version:1 和 origin）。${START_HINT}`);
  }
  try {
    return { origin: validateOrigin(record.origin), source: 'discovery-file' };
  } catch {
    throw endpointError('DSH_INVALID_ORIGIN', `DSH origin 发现文件包含不安全或无效的 origin。${START_HINT}`);
  }
}
