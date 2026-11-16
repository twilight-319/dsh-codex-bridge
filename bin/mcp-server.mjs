#!/usr/bin/env node
// Codex → DSH 反向桥：MCP stdio 服务端（零依赖，只用 node: 内置模块）。
//
// 角色：**Codex CLI（GPT）作为 MCP 客户端** spawn 本进程；本进程只做两件事：
//   1. 把 tools/list 里的 dsh_execute / dsh_status 暴露给 Codex；
//   2. tools/call 时带着 Bearer token 请求 DSH host 上的
//        POST /api/dsh-codex-bridge.execute
//        GET  /api/dsh-codex-bridge.status
//      （这两个路由由 DSH 侧插件实现，见 docs/dsh-exec-notes.md）。
//
// 为什么手写而不装 SDK：本机 profile 里没有 @modelcontextprotocol/sdk，插件也不允许新增依赖；
// MCP 的 stdio 传输就是「一行一个 JSON-RPC 2.0 帧」，工具面只有 2 个，手写足够且可控。
//
// ── 硬约束（改这个文件前先读）─────────────────────────────────────────────
// 1) **stdout 只能出现 JSON-RPC 帧**（每行一个，NUL 之外的任何杂字节都会把 Codex 的
//    MCP 客户端喂崩）。所有日志/诊断一律走 stderr；这里没有一处 console.log。
// 2) tools/call 的任何失败（超时、连接被拒、非 JSON 响应、401、token 文件缺失）都必须
//    变成 `isError: true` 的 content，**不允许**抛到顶层 —— 见 guard() 与全局 uncaught 处理。
// 3) 不用全局 fetch：undici 自带 300 s headersTimeout，而 dsh_execute 的默认预算就是
//    600 s，超长任务会在第 301 秒被客户端单方面掐断（QQ 桥接踩过完全相同的坑）。
//    因此这里用 node:http 手写请求，超时完全由本文件计时器控制（仅允许本机 HTTP origin）。
//
// 协议版本：MCP 2024-11-05 / 2025-03-26 / 2025-06-18 的 stdio + tools 面在形状上兼容；
// initialize 时优先回客户端请求的版本，不认识就回退到 2024-11-05（最保守）。
// 本机 Codex 0.166 的原生 codex.exe 里三个版本字符串都存在，实测回显客户端版本可用。

import fs from 'node:fs';
import http from 'node:http';
import { DEFAULT_DISCOVERY_FILE, resolveEndpoint } from '../lib/endpoint-discovery.js';
import os from 'node:os';
import path from 'node:path';

const SERVER_NAME = 'dsh-codex-bridge';

const SERVER_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  } catch {}
  return '0.1.0';
})();

// 支持的 MCP 协议版本；第一个是「客户端请求了不认识的版本」时的回退目标（按任务要求取最保守的）。
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PROTOCOL_FALLBACK = '2024-11-05';

const TOOL_EXECUTE = 'dsh_execute';
const TOOL_STATUS = 'dsh_status';
const TOOL_ANSWER = 'dsh_answer';

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TASK_CHARS = 20000;
const MAX_TIMEOUT_MS = 600000;
const MAX_HTTP_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ── stderr 诊断 ────────────────────────────────────────────────────────────
// 永远不打印 token：只打印来源（cli/env/file）与长度，够排查即可。
function log(...args) {
  try {
    process.stderr.write(`[${SERVER_NAME}] ${args.map(String).join(' ')}\n`);
  } catch {}
}

// ── CLI / env 配置（priority: CLI > env > default）──────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        i += 1;
        return next;
      }
      return undefined;
    };
    switch (name) {
      case 'url': out.url = take(); break;
      case 'token': out.token = take(); break;
      case 'token-file': out.tokenFile = take(); break;
      case 'timeout-ms': out.timeoutMs = take(); break;
      case 'help': out.help = true; break;
      case 'version': out.version = true; break;
      default:
        // 未知参数：不崩，只记 stderr（Codex 注册时可能多带参数，别因此让服务器起不来）
        log(`忽略未知参数 --${name}`);
        break;
    }
  }
  return out;
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildConfig(argv) {
  const cli = parseArgs(argv);
  const tokenFromCli = typeof cli.token === 'string' && cli.token.trim() ? cli.token.trim() : '';
  const token = tokenFromCli || (process.env.DSH_BRIDGE_TOKEN || '').trim();
  const tokenFile = (typeof cli.tokenFile === 'string' && cli.tokenFile.trim())
    || (process.env.DSH_BRIDGE_TOKEN_FILE || '').trim()
    || path.join(os.homedir(), '.dsh', 'codex-bridge', 'http-token');
  // An explicitly empty/missing --url is invalid, not permission to fall back.
  const explicitUrl = Object.hasOwn(cli, 'url')
    ? (cli.url ?? '')
    : process.env.DSH_BRIDGE_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof cli.timeoutMs === 'string' && cli.timeoutMs.trim()) {
    const value = Number(cli.timeoutMs);
    if (Number.isFinite(value) && value > 0) timeoutMs = value;
  } else if (process.env.DSH_BRIDGE_TIMEOUT_MS) {
    timeoutMs = envNumber('DSH_BRIDGE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  }
  timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(timeoutMs)));

  return {
    explicitUrl,
    // Do not resolve at startup: discovery can appear/change after MCP initialize.
    endpointSource: explicitUrl === undefined ? `discovery-file(${DEFAULT_DISCOVERY_FILE})` : 'cli/env (validated per request)',
    // 注意：token 分两路保存。CLI/env 给的 token 固定不变；token 文件在**每次调用时**重读，
    // 因为 DSH 侧可能在 MCP 服务端启动之后才首次生成令牌文件（首启时序），缓存会导致一直 401。
    token,
    tokenFile,
    timeoutMs,
    help: cli.help === true,
    version: cli.version === true,
  };
}

const CONFIG = buildConfig(process.argv.slice(2));

if (CONFIG.help) {
  // 显式 --help 是「人手动执行」的场景（不是 Codex spawn），此时走 stdout 无风险且已立刻退出。
  process.stdout.write([
    `${SERVER_NAME} ${SERVER_VERSION} — MCP stdio server (Codex → DSH)`,
    '',
    '用法: node bin/mcp-server.mjs [--url <base>] [--token <t>] [--token-file <p>] [--timeout-ms <ms>]',
    '',
    '  --url / DSH_BRIDGE_URL             显式本机 HTTP origin（CLI 优先于 env）',
    '                                      否则每次请求读取 ~/.dsh/codex-bridge/dsh-origin.json',
    '                                      仅 127.0.0.1 / localhost / [::1]，无旧端口 fallback',
    '  --token / DSH_BRIDGE_TOKEN         bearer token（优先于 token 文件）',
    '  --token-file / DSH_BRIDGE_TOKEN_FILE',
    '                                      token 文件，默认 ~/.dsh/codex-bridge/http-token',
    '  --timeout-ms / DSH_BRIDGE_TIMEOUT_MS  单次 execute 默认预算，默认 600000',
    '',
    '注册到 Codex（由人执行）: codex mcp add dsh_bridge -- node <此文件绝对路径>',
  ].join('\n') + '\n');
  process.exit(0);
}

if (CONFIG.version) {
  process.stdout.write(`${SERVER_VERSION}\n`);
  process.exit(0);
}

// ── stdout 帧写出 ──────────────────────────────────────────────────────────
let stdoutBroken = false;

function writeFrame(value) {
  if (stdoutBroken) return;
  let line;
  try {
    line = JSON.stringify(value);
  } catch (error) {
    log('序列化响应失败:', error?.message ?? String(error));
    return;
  }
  try {
    process.stdout.write(line + '\n');
  } catch (error) {
    // 客户端已经关掉管道：继续跑没意义，但也不能在 stdout 上写任何东西。
    stdoutBroken = true;
    log('stdout 写入失败，进入关闭流程:', error?.message ?? String(error));
    shutdown(0);
  }
}

function writeResult(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

function writeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeFrame({ jsonrpc: '2.0', id, error });
}

// JSON-RPC 2.0 标准码 + MCP 的补充约定
const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// ── 工具定义 ───────────────────────────────────────────────────────────────
// schema 取「最保守形态」：不写 additionalProperties:false、不写 minLength/maxLength。
// 原因：Codex 会把 MCP 的 inputSchema 转成自己的工具 schema；部分客户端在 strict 模式下
// 要求 properties 全集必填 + additionalProperties:false，带可选参数的工具一旦被那样解释
// 就会直接把合法调用判成非法。约束改在服务端做（下面 validateXxx），模型侧只看 description。
const TOOLS = [
  {
    name: TOOL_EXECUTE,
    description: [
      '让 DSH（DeepSeek Harness）本机实际执行一个任务，并返回它的最终回答。',
      'DSH 跑的是一个真实会话：能读写工作目录里的文件、执行命令，动作发生在用户本机。',
      '适合「需要真正动手/读仓库」的步骤；只在需要执行时才调用，规划与决策请自己做。',
      '返回的是 DSH 的最终 assistant 文本；失败时以 isError 返回可读原因（超时、连接失败、401 等）。',
      '默认每次新建会话；传 sessionId 可复用同一 DSH 会话继续追问（保留上下文）。',
      '如果返回 needsInput=true，说明 DSH 在等待用户回答：把 question 原样呈现给用户，然后调用 dsh_answer 回答同一会话。',
      `task 最长 ${MAX_TASK_CHARS} 字符；timeoutMs 上限 ${MAX_TIMEOUT_MS}。`,
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: `交给 DSH 执行的任务描述（自然语言，含必要的验收标准/约束）。必填，最长 ${MAX_TASK_CHARS} 字符。`,
        },
        sessionId: {
          type: 'string',
          description: '要复用的已有 DSH 执行会话 ID（由之前的 dsh_execute 返回）。省略则新建会话；同一会话不能并发执行。',
        },
        cwd: {
          type: 'string',
          description: 'DSH 会话的工作目录（绝对路径）。省略则由 DSH 侧决定（通常是它当前的工作目录）。',
        },
        timeoutMs: {
          type: 'integer',
          description: `本次执行预算（毫秒），默认取服务端配置（${CONFIG.timeoutMs}）。会被裁剪到 1000~${MAX_TIMEOUT_MS}。`,
        },
        reasoningEffort: {
          type: 'string',
          description:
            '思考强度（可选，精确 ID）。仅当你在用户配置的执行政策中看到 effortMode=adaptive 且该值属于 allowedEfforts 时才可传；其余模式会明确拒绝。可用值以 dsh_status 返回的 policy.reasoningEfforts 为准，不得猜测。',
        },
        reason: {
          type: 'string',
          description: '可选：一句话说明为什么选择这个强度（会记入执行台账，最长 500 字符）。',
        },
      },
      required: ['task'],
    },
  },
  {
    name: TOOL_ANSWER,
    description:
      '回答 DSH 执行会话提出的问题并继续执行。仅用于 dsh_execute 返回 needsInput=true 的同一 sessionId 和本次 question.requestId；answers 必须覆盖 question.questions 里的每个问题 id。返回继续执行后的最终回答，或下一次 needsInput。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '处于等待回答状态的 DSH 执行会话 ID。' },
        requestId: { type: 'string', description: '本次 question.requestId，必须精确匹配最新提问，不能使用上次的标识。' },
        timeoutMs: { type: 'integer', description: '回答后继续执行的预算，1000~600000 毫秒；人类等待时间不占本预算。' },
        answers: {
          type: 'array',
          description: '每个问题一项；selected 用候选 label，或用 custom 自由文本。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '问题 id（来自 question.questions[].id）。' },
              selected: { type: 'array', items: { type: 'string' }, description: '选中的候选项 label；单选用一个。' },
              custom: { type: 'string', description: '自由文本回答（单选的 Other，或多选的补充）。' },
            },
            required: ['id'],
          },
        },
      },
      required: ['sessionId', 'requestId', 'answers'],
    },
  },
  {
    name: TOOL_STATUS,
    description:
      '检查 DSH 反向桥端点是否可达、鉴权是否通过，并返回 DSH 侧的版本/状态信息。只读，不执行任何任务。返回值里的 policy 说明当前执行模型政策：modelMode、effortMode、可用 model，以及 reasoningEfforts（该模型支持的精确思考档位 ID）与 allowedEfforts（用户授权你选择的档位）。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ── 参数校验（-32602 分支）────────────────────────────────────────────────
class InvalidParams extends Error {}

function requireObject(value, what) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidParams(`${what} 必须是对象，收到 ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  return value;
}

function validateExecuteArgs(raw) {
  const args = requireObject(raw, 'arguments');
  const task = args.task;
  if (typeof task !== 'string') {
    throw new InvalidParams(`参数 task 必填且必须是字符串，收到 ${task === undefined ? 'undefined' : typeof task}`);
  }
  const trimmed = task.trim();
  if (!trimmed) throw new InvalidParams('参数 task 不能为空字符串');
  if (trimmed.length > MAX_TASK_CHARS) {
    throw new InvalidParams(`参数 task 过长：${trimmed.length} 字符，上限 ${MAX_TASK_CHARS}`);
  }
  let sessionId;
  if (args.sessionId !== undefined && args.sessionId !== null) {
    if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new InvalidParams('参数 sessionId 必须是非空字符串');
    sessionId = args.sessionId.trim();
  }
  let cwd;
  if (args.cwd !== undefined && args.cwd !== null) {
    if (typeof args.cwd !== 'string') throw new InvalidParams(`参数 cwd 必须是字符串，收到 ${typeof args.cwd}`);
    const value = args.cwd.trim();
    if (value) cwd = value;
  }
  let timeoutMs;
  if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
    const value = Number(args.timeoutMs);
    if (!Number.isFinite(value) || value <= 0) {
      throw new InvalidParams(`参数 timeoutMs 必须是正数（毫秒），收到 ${JSON.stringify(args.timeoutMs)}`);
    }
    timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
  }
  let reasoningEffort;
  if (args.reasoningEffort !== undefined && args.reasoningEffort !== null) {
    if (typeof args.reasoningEffort !== 'string') throw new InvalidParams(`参数 reasoningEffort 必须是字符串，收到 ${typeof args.reasoningEffort}`);
    const value = args.reasoningEffort.trim();
    if (!value || value !== args.reasoningEffort) throw new InvalidParams('参数 reasoningEffort 必须是非空、无首尾空白的精确强度 ID');
    reasoningEffort = value;
  }
  let reason;
  if (args.reason !== undefined && args.reason !== null) {
    if (typeof args.reason !== 'string') throw new InvalidParams(`参数 reason 必须是字符串，收到 ${typeof args.reason}`);
    // Plain single-line text: the ledger stores it, so no control characters.
    if (args.reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(args.reason)) {
      throw new InvalidParams('参数 reason 必须是不超过 500 字符的纯文本（不含控制字符）');
    }
    reason = args.reason;
  }
  return { task: trimmed, cwd, timeoutMs, reasoningEffort, reason, sessionId };
}

function validateAnswerArgs(raw) {
  const args = requireObject(raw, 'arguments');
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!sessionId) throw new InvalidParams('参数 sessionId 必填且必须是非空字符串');
  const requestId = typeof args.requestId === 'string' ? args.requestId : '';
  if (!requestId.trim() || requestId.trim() !== requestId) throw new InvalidParams('requestId 必填，请重连 MCP 并传最新 question.requestId');
  const timeoutMs = args.timeoutMs ?? CONFIG.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new InvalidParams('timeoutMs 必须是 1000~600000 的整数');
  const seen = new Set();
  if (!Array.isArray(args.answers) || args.answers.length === 0) throw new InvalidParams('参数 answers 必须是非空数组');
  const answers = [];
  for (const item of args.answers) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new InvalidParams('answers 的每一项必须是对象');
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) throw new InvalidParams('answers 的每一项都需要字符串 id');
    if (seen.has(id)) throw new InvalidParams('问题 id 不能重复');
    seen.add(id);
    if (item.selected !== undefined && (!Array.isArray(item.selected) || item.selected.some(label => typeof label !== 'string' || !label))) throw new InvalidParams('selected 必须为有效 label 字符串数组');
    if (item.custom !== undefined && typeof item.custom !== 'string') throw new InvalidParams('custom 必须是字符串');
    const selected = item.selected ?? [];
    if (new Set(selected).size !== selected.length) throw new InvalidParams('选项不能重复');
    const custom = item.custom?.trim() ? item.custom : undefined;
    answers.push({ id, selected, ...(custom === undefined ? {} : { custom }) });
  }
  return { sessionId, requestId, answers, timeoutMs };
}

function validateStatusArgs(raw) {
  // dsh_status 没有参数；客户端常传 {} 或直接省略，两者都接受。
  const args = requireObject(raw, 'arguments');
  const keys = Object.keys(args);
  if (keys.length > 0) throw new InvalidParams(`dsh_status 不接受参数，收到 ${JSON.stringify(keys)}`);
  return {};
}

// ── token 读取 ─────────────────────────────────────────────────────────────
// 每次调用都重读文件：DSH 侧首次启动才生成令牌，MCP 进程常常更早起来。
function resolveToken() {
  if (CONFIG.token) return { ok: true, token: CONFIG.token, source: 'cli-or-env' };
  const file = CONFIG.tokenFile;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, message: `token file missing: ${file}`, hint: 'DSH 侧首次启动会生成该文件；也可用 --token / DSH_BRIDGE_TOKEN 显式提供。' };
    }
    return { ok: false, message: `token file unreadable: ${file}: ${error?.message ?? String(error)}` };
  }
  const token = raw.replace(/^\uFEFF/, '').trim();
  if (!token) {
    return { ok: false, message: `token file is empty: ${file}`, hint: '删除该文件后重启 DSH 会重新生成，或改用 --token 显式提供。' };
  }
  return { ok: true, token, source: 'token-file' };
}

// ── HTTP（node:http，不用全局 fetch：见文件头 3）──────────────────────────
function httpRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let res = null;
    let timer = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    let target;
    try {
      target = new URL(url);
    } catch (error) {
      finish(new Error('内部请求 URL 无效'));
      return;
    }
    // requestDsh already validates the origin. No redirects are followed, and
    // localhost is pinned to literal loopback (never trust OS/DNS to choose a remote IP).
    const hostname = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname.replace(/^\[|\]$/g, '');
    const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (payload) reqHeaders['content-length'] = Buffer.byteLength(payload);

    timer = setTimeout(() => {
      const error = new Error(`请求超时：${method} ${url} 超过 ${timeoutMs}ms 未完成`);
      error.code = 'DSH_TIMEOUT';
      finish(error);
      try { req?.destroy(error); } catch {}
      try { res?.destroy(); } catch {}
    }, timeoutMs);
    timer.unref?.();

    try {
      req = http.request({
        hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method,
        headers: reqHeaders,
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        let truncated = false;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_HTTP_BYTES) {
            truncated = true;
            const error = new Error(`响应体过大（>${MAX_HTTP_BYTES} 字节），已中止读取`);
            error.code = 'DSH_BODY_TOO_LARGE';
            finish(error);
            try { response.destroy(); } catch {}
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(Object.assign(new Error('响应被对端中断'), { code: 'DSH_ABORTED' })));
        response.on('end', () => {
          if (settled) return;
          finish(null, {
            status: response.statusCode || 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            truncated,
          });
        });
      });
      req.on('error', (error) => finish(error));
      req.end(payload);
    } catch (error) {
      finish(error);
      try { req?.destroy(); } catch {}
    }
  });
}

function describeNetworkError(error) {
  const code = String(error?.code ?? '');
  const base = error?.message ?? String(error);
  switch (code) {
    case 'ECONNREFUSED':
      return `${base}\n提示：${error?.dshOrigin ?? '当前 DSH origin'} 上没有进程监听，请启动或重载 DSH；显式 --url / DSH_BRIDGE_URL 请检查端口。不会自动重试执行任务。`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `${base}\n提示：主机名无法解析，检查 --url 是否写对。`;
    case 'DSH_TIMEOUT':
      return `${base}\n提示：DSH 侧可能仍在执行该任务；可调大 timeoutMs 或缩短任务。`;
    case 'ECONNRESET':
    case 'EPIPE':
    case 'DSH_ABORTED':
      return `${base}\n提示：连接被对端中断，DSH 可能重启或崩溃。`;
    default:
      return `${base}${code ? `（code=${code}）` : ''}`;
  }
}

function snippet(text, limit = 400) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '(空响应体)';
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function authHint(tokenInfo) {
  if (tokenInfo.ok) {
    return `token 来源: ${tokenInfo.source}${tokenInfo.source === 'token-file' ? `（${CONFIG.tokenFile}）` : ''}`;
  }
  return tokenInfo.hint ? `${tokenInfo.message}\n${tokenInfo.hint}` : tokenInfo.message;
}

async function requestDsh({ route, method, body, timeoutMs }) {
  // Resolve before reading/attaching the bearer, on every request. Invalid explicit
  // configuration fails closed; it must never silently fall back to discovery.
  const { origin } = resolveEndpoint({ explicitUrl: CONFIG.explicitUrl });
  const tokenInfo = resolveToken();
  if (!tokenInfo.ok) {
    const error = new Error(tokenInfo.message);
    error.code = 'DSH_NO_TOKEN';
    error.tokenInfo = tokenInfo;
    throw error;
  }
  const url = `${origin}${route}`;
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${tokenInfo.token}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Deliberately one attempt only, especially POST: the host may have accepted
  // work before a connection reset, so rediscovery/retry could execute it twice.
  const response = await httpRequest({
    url,
    method,
    headers,
    body: body === undefined ? null : body,
    timeoutMs,
  }).catch((error) => {
    error.dshOrigin = origin;
    throw error;
  });

  const parsed = (() => {
    const text = response.text.trim();
    if (!text) return { json: null, empty: true };
    try {
      return { json: JSON.parse(text), empty: false };
    } catch {
      return { json: null, empty: false, invalid: true };
    }
  })();

  return { response, parsed, url, tokenInfo };
}

// ── 工具实现 ───────────────────────────────────────────────────────────────
function toTextResult(text, extra) {
  const result = { content: [{ type: 'text', text: String(text ?? '') }] };
  if (extra) result.content.push({ type: 'text', text: extra });
  return result;
}

function errorResult(message, extra) {
  const result = { content: [{ type: 'text', text: String(message ?? '') }], isError: true };
  if (extra) result.content.push({ type: 'text', text: extra });
  return result;
}

function invalidResponse(parsed, kind) {
  const data = parsed.json;
  if (!data || Array.isArray(data) || typeof data !== 'object' || data.ok !== true) return true;
  if (kind === 'status') return !Number.isInteger(data.pid) || !Number.isFinite(data.sessions);
  if (typeof data.sessionId !== 'string' || !data.sessionId) return true;
  if (data.needsInput === true) return typeof data.question?.requestId !== 'string' || !Array.isArray(data.question.questions) || !data.question.questions.length;
  return typeof data.text !== 'string' || data.stopReason !== 'completed';
}
function failureDetail(data, fallback) {
  return snippet(data?.message ?? data?.error ?? fallback) + (data?.sessionId ? '\n[dsh] sessionId=' + data.sessionId + ' stopReason=' + (data.stopReason ?? 'unknown') : '');
}

async function callExecute(args) {
  const { task, cwd, timeoutMs, reasoningEffort, reason, sessionId } = args;
  const budget = timeoutMs ?? CONFIG.timeoutMs;
  const body = { task };
  if (cwd) body.cwd = cwd;
  body.timeoutMs = budget;
  if (sessionId) body.sessionId = sessionId;
  if (reasoningEffort) body.reasoningEffort = reasoningEffort;
  if (reason) body.reason = reason;
  const started = Date.now();
  try {
    const { response, parsed, url, tokenInfo } = await requestDsh({
      route: '/api/dsh-codex-bridge.v3.execute',
      method: 'POST',
      body,
      timeoutMs: budget + 10000,
    });
    const elapsedMs = Date.now() - started;

    if (response.status === 401) {
      return errorResult(
        [
          `HTTP 401 Unauthorized：DSH 拒绝了 bearer token（POST ${url}）。`,
          authHint(tokenInfo),
          '排查顺序：① 先调 dsh_status 看是否同样 401；② 是否同时开着多个 DSH 实例/窗口（发现文件只保留最后挂载者）；③ 删除 token 文件后重启 DSH 会重新生成；④ 在 DSH 里重载插件后重连 Codex 插件。',
        ].join('\n')
      );
    }
    if (response.status === 404) {
      return errorResult(
        [
          `HTTP 404：DSH 上没有这个路由（POST ${url}）。`,
          '说明 DSH 侧的执行入口还没注册/未启用（dsh-exec 路由），不是 token 问题。',
        ].join('\n')
      );
    }
    if (response.status < 200 || response.status >= 300) {
      // The host sends a human-readable `message` alongside the stable code.
      const detail = failureDetail(parsed.json, response.text);
      return errorResult(`HTTP ${response.status}：${detail}（POST ${url}，${elapsedMs}ms）`);
    }
    if (parsed.invalid) {
      return errorResult(
        [
          `DSH 返回了非 JSON 响应（POST ${url}，${elapsedMs}ms，status ${response.status}）。`,
          `响应片段: ${snippet(response.text)}`,
          '常见原因：--url 指到了别的 HTTP 服务（例如 DSH Web GUI 的页面路由）或代理返回了 HTML。',
        ].join('\n')
      );
    }
    if (invalidResponse(parsed, 'execute')) return errorResult('DSH 执行响应无效或失败：' + failureDetail(parsed.json, '需要合法 JSON、ok:true 与完成/提问结构'));
    const data = parsed.json;
    if (data && typeof data === 'object' && data.ok === false) {
      return errorResult(`DSH 执行失败：${snippet(data.error ?? data.message ?? '(ok:false，未说明原因)')}`);
    }
    if (data && data.needsInput === true) {
      const questionText = JSON.stringify(data.question ?? { questions: [] }, null, 2);
      return toTextResult(
        [
          'DSH 执行会话正在等待你回答以下问题。',
          '请把 question 中的问题/选项原样呈现给用户；收到回答后调用 dsh_answer（同一 sessionId 和本次 question.requestId）继续执行。',
          questionText,
        ].join('\n\n'),
        '[dsh] sessionId=' + String(data.sessionId ?? '') + ' needsInput=true'
      );
    }
    if (typeof data?.text === 'string') {
      const meta = [];
      if (data.sessionId) meta.push(`sessionId=${data.sessionId}`);
      if (data.workspaceId) meta.push(`workspaceId=${data.workspaceId}`);
      if (Number.isFinite(Number(data.elapsedMs))) meta.push(`elapsedMs=${Number(data.elapsedMs)}`);
      else meta.push(`wallMs=${elapsedMs}`);
      if (data.stopReason) meta.push(`stopReason=${data.stopReason}`);
      const execution = data.execution;
      if (execution && typeof execution === 'object' && execution.selection) {
        const selection = execution.selection;
        meta.push(`model=${selection.provider}/${selection.model}`);
        meta.push(`effort=${selection.reasoningEffort ?? '(adapter-default)'}`);
        if (execution.effortSource) meta.push(`effortSource=${execution.effortSource}`);
        if (execution.policyRevision !== undefined) meta.push(`policyRevision=${execution.policyRevision}`);
      }
      return toTextResult(data.text, meta.length ? `[dsh] ${meta.join(' ')}` : undefined);
    }
    return toTextResult(JSON.stringify(data ?? { ok: true }, null, 2));
  } catch (error) {
    const elapsedMs = Date.now() - started;
    if (error?.code === 'DSH_NO_TOKEN') {
      return errorResult(`无法读取 DSH 访问令牌：${error.message}\n${error.tokenInfo?.hint ?? ''}`.trim());
    }
    return errorResult(`调用 DSH 执行入口失败（${elapsedMs}ms）：${describeNetworkError(error)}`);
  }
}


async function callAnswer(args) {
  const { sessionId, requestId, answers, timeoutMs } = args;
  const started = Date.now();
  try {
    const { response, parsed, url } = await requestDsh({
      route: '/api/dsh-codex-bridge.v3.answer',
      method: 'POST',
      body: { sessionId, requestId, answers, timeoutMs },
      timeoutMs: timeoutMs + 10000,
    });
    const elapsedMs = Date.now() - started;
    if (response.status === 401) {
      return errorResult(['HTTP 401 Unauthorized：DSH 拒绝了 bearer token（POST ' + url + '）。', authHint({ ok: false, message: 'token 不被接受' }), '先调 dsh_status 对照；必要时重载插件后重连 Codex 插件。'].join('\n'));
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = failureDetail(parsed.json, response.text);
      return errorResult('回答失败：HTTP ' + response.status + '：' + detail);
    }
    if (invalidResponse(parsed, 'answer')) return errorResult('DSH 回答响应无效或失败：' + failureDetail(parsed.json, '需要合法 JSON、ok:true 与完成/提问结构'));
    const data = parsed.json;
    if (data && data.needsInput === true) {
      const questionText = JSON.stringify(data.question ?? { questions: [] }, null, 2);
      return toTextResult(['DSH 又提出了新的问题：', questionText].join('\n\n'), '[dsh] sessionId=' + String(sessionId) + ' needsInput=true');
    }
    if (typeof data?.text === 'string') {
      const meta = ['sessionId=' + sessionId];
      if (Number.isFinite(Number(data.elapsedMs))) meta.push('elapsedMs=' + Number(data.elapsedMs));
      if (data.stopReason) meta.push('stopReason=' + data.stopReason);
      return toTextResult(data.text, '[dsh] ' + meta.join(' '));
    }
    return toTextResult(JSON.stringify(data ?? { ok: true }, null, 2));
  } catch (error) {
    if (error?.code === 'DSH_NO_TOKEN') return errorResult('无法读取 DSH 访问令牌：' + error.message);
    return errorResult('回答 DSH 提问失败（' + (Date.now() - started) + 'ms）：' + describeNetworkError(error));
  }
}

async function callStatus() {
  try {
    const { response, parsed, url, tokenInfo } = await requestDsh({
      route: '/api/dsh-codex-bridge.v3.status',
      method: 'GET',
      body: undefined,
      // status 是探活：不该让模型为一个诊断调用等几分钟。
      timeoutMs: Math.min(CONFIG.timeoutMs, 10000),
    });
    if (response.status === 401) {
      return errorResult(
        [
          `HTTP 401 Unauthorized：DSH 在线，但 bearer token 不被接受（GET ${url}）。`,
          authHint(tokenInfo),
          '排查顺序：① 是否同时开着多个 DSH 实例/窗口（发现文件只保留最后挂载者）；② 删除 token 文件后重启 DSH 会重新生成；③ 在 DSH 里重载插件后重连 Codex 插件。',
        ].join('\n')
      );
    }
    if (response.status === 404) {
      return errorResult(
        [
          `HTTP 404：DSH 在线，但 /api/dsh-codex-bridge.v3.status 路由不存在（GET ${url}）。`,
          '说明 DSH 侧的插件路由还没注册/未启用。',
        ].join('\n')
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return errorResult(`HTTP ${response.status}（GET ${url}）：${snippet(parsed.json?.error ?? response.text)}`);
    }
    if (parsed.invalid) {
      return errorResult(
        [
          `DSH 返回了非 JSON 响应（GET ${url}，status ${response.status}）。`,
          `响应片段: ${snippet(response.text)}`,
        ].join('\n')
      );
    }
    if (invalidResponse(parsed, 'status')) return errorResult('DSH 状态响应无效或失败：' + failureDetail(parsed.json, '需要合法 JSON、ok:true、pid 和 sessions'));
    const summary = {
      reachable: true,
      httpStatus: response.status,
      url,
      tokenSource: tokenInfo.source,
      dsh: parsed.json ?? {},
    };
    // 状态调用成功时**不是** isError：这是正常的连通性回答。
    return toTextResult(JSON.stringify(summary, null, 2));
  } catch (error) {
    if (error?.code === 'DSH_NO_TOKEN') {
      return errorResult(`DSH 状态未知：${error.message}\n${error.tokenInfo?.hint ?? ''}`.trim());
    }
    return errorResult(`DSH 状态请求失败：${describeNetworkError(error)}`);
  }
}

// ── MCP 方法分发 ───────────────────────────────────────────────────────────
let initialized = false;
let initializeSeen = false;

function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_FALLBACK;
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize': {
      const p = requireObject(params, 'params');
      const protocolVersion = negotiateProtocolVersion(p.protocolVersion);
      initializeSeen = true;
      log(
        'initialize:',
        `client=${p.clientInfo?.name ?? '?'}@${p.clientInfo?.version ?? '?'}`,
        `requestedProtocol=${p.protocolVersion ?? '(none)'}`,
        `negotiated=${protocolVersion}`,
        `endpoint=${CONFIG.endpointSource}`,
        `timeoutMs=${CONFIG.timeoutMs}`,
        `token=${CONFIG.token ? 'cli/env' : `file(${CONFIG.tokenFile})`}`
      );
      writeResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: [
          'dsh_execute 会把任务交给 DSH（DeepSeek Harness）在本机真实执行并返回最终回答；',
          'dsh_status 用于确认桥接端点与鉴权是否正常，并读取执行模型政策。',
          '只有在 dsh_status 的 policy.effortMode 为 adaptive 时，dsh_execute 才接受 reasoningEffort，且必须取自 policy.allowedEfforts（精确 ID）。',
          '执行模型本身由用户在 DSH 设置页配置，不要也不能通过本工具切换模型。',
          '需要复用上下文时把上次返回的 sessionId 传给 dsh_execute；不同任务可并发新建会话。',
          'dsh_execute 返回 needsInput 时，把问题呈现给用户并用 dsh_answer 回答同一 sessionId 和本次 question.requestId。',
        ].join(''),
      });
      return;
    }
    case 'ping':
      writeResult(id, {});
      return;
    case 'tools/list':
      writeResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const p = requireObject(params, 'params');
      const name = p.name;
      if (typeof name !== 'string' || !name.trim()) {
        throw new InvalidParams('tools/call 缺少 name（必须是字符串）');
      }
      if (name === TOOL_EXECUTE) {
        writeResult(id, await callExecute(validateExecuteArgs(p.arguments)));
        return;
      }
      if (name === TOOL_ANSWER) {
        writeResult(id, await callAnswer(validateAnswerArgs(p.arguments)));
        return;
      }
      if (name === TOOL_STATUS) {
        validateStatusArgs(p.arguments);
        writeResult(id, await callStatus());
        return;
      }
      throw new InvalidParams(`未知工具: ${name}（可用: ${TOOL_EXECUTE}, ${TOOL_STATUS}）`);
    }
    // 没有声明 resources/prompts/logging 能力，客户端正常不会发这些；真发了就按规范回 -32601。
    default:
      writeError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`, { method });
  }
}

function isNotification(message) {
  return message && typeof message === 'object' && !Object.prototype.hasOwnProperty.call(message, 'id');
}

async function handleMessage(rawText) {
  let message;
  try {
    message = JSON.parse(rawText);
  } catch (error) {
    // 解析失败无法确定 id，按规范回 id: null。
    writeError(null, RPC.PARSE_ERROR, `Parse error: ${error?.message ?? String(error)}`);
    return;
  }

  if (Array.isArray(message)) {
    // MCP 2025-06-18 已移除 JSON-RPC 批处理；这里仍逐条处理，纯粹为了容错。
    for (const item of message) await handleSingle(item);
    return;
  }
  await handleSingle(message);
}

async function handleSingle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    writeError(null, RPC.INVALID_REQUEST, 'Invalid Request: 期望一个 JSON-RPC 2.0 对象');
    return;
  }
  const { method } = message;

  if (isNotification(message)) {
    // 通知永远不回帧。
    if (typeof method !== 'string') return;
    if (method === 'notifications/initialized') {
      initialized = true;
      log('收到 notifications/initialized，进入正常态');
      return;
    }
    if (method === 'notifications/cancelled' || method === 'notifications/progress') return;
    log(`收到未处理的通知: ${method}`);
    return;
  }

  if (typeof method !== 'string' || !method) {
    writeError(message.id ?? null, RPC.INVALID_REQUEST, 'Invalid Request: 缺少 method');
    return;
  }
  if (message.jsonrpc !== '2.0') {
    writeError(message.id ?? null, RPC.INVALID_REQUEST, `Invalid Request: jsonrpc 必须是 "2.0"，收到 ${JSON.stringify(message.jsonrpc)}`);
    return;
  }

  try {
    await handleRequest(message);
  } catch (error) {
    if (error instanceof InvalidParams) {
      writeError(message.id ?? null, RPC.INVALID_PARAMS, error.message);
      return;
    }
    log(`内部错误 (${method}):`, error?.stack ?? String(error));
    writeError(message.id ?? null, RPC.INTERNAL_ERROR, `Internal error: ${error?.message ?? String(error)}`);
  }
}

// ── stdio 帧读取 ───────────────────────────────────────────────────────────
let buffer = '';

function onData(chunk) {
  buffer += chunk;
  // 帧处理：MCP stdio 是「一行一个 UTF-8 JSON」。只按 \n 切；\r\n 的 \r 在 trim 里去掉。
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.trim()) continue;
    handleMessage(trimmed).catch((error) => {
      log('帧处理异常（已兜底）:', error?.stack ?? String(error));
      writeError(null, RPC.INTERNAL_ERROR, `Internal error: ${error?.message ?? String(error)}`);
    });
  }
  if (buffer.length > MAX_FRAME_BYTES) {
    // 单行超过 4MB 基本只能是客户端发疯或流错位：不可恢复，清空并回一个 parse error。
    buffer = '';
    writeError(null, RPC.PARSE_ERROR, 'Parse error: 单帧超过大小上限，已丢弃缓冲');
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', onData);
process.stdin.on('error', (error) => log('stdin 错误:', error?.message ?? String(error)));
process.stdin.on('end', () => {
  log('stdin 关闭，退出');
  // 留一点时间把最后几个响应刷出去（stdout 是同步写入，这里只是保守）。
  shutdown(0);
  setTimeout(() => process.exit(0), 50).unref?.();
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    process.exitCode = code;
  } catch {}
}

process.on('SIGTERM', () => { log('收到 SIGTERM'); shutdown(0); process.exit(0); });
process.on('SIGINT', () => { log('收到 SIGINT'); shutdown(0); process.exit(0); });

// 全局兜底：单次工具调用的异常都在 handleRequest 里被转成 -32603 / isError，
// 这里只为「绝不让进程因为一个漏网异常静默死掉」——客户端的 MCP 连接断了比报错更难排查。
process.on('uncaughtException', (error) => {
  log('uncaughtException（已忽略并保持进程存活）:', error?.stack ?? String(error));
});
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection（已忽略并保持进程存活）:', reason?.stack ?? String(reason));
});

log(
  `启动: v${SERVER_VERSION} pid=${process.pid}`,
  `endpoint=${CONFIG.endpointSource}`,
  `token=${CONFIG.token ? 'cli/env' : `file(${CONFIG.tokenFile})`}`,
  `timeoutMs=${CONFIG.timeoutMs}`,
  `protocols=${PROTOCOL_VERSIONS.join('/')}`,
  `node=${process.version}`
);

// 说明：initialized 标志目前只用于日志（tools/list 等请求在 initialize 之前到达时也照常响应）。
// 这样比严格拒绝更抗客户端时序差异；initializeSeen 保留给排查用。
void initialized;
void initializeSeen;
