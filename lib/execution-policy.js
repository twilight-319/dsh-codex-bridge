import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_FILE = join(homedir(), '.dsh', 'codex-bridge', 'execution-policy.json');
const DEFAULT_POLICY = Object.freeze({ schemaVersion: 1, revision: 0, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'inherit' });
const PERMISSION_MODES = ['full-access', 'auto', 'never-ask', 'inherit'];
const FULL_ACCESS_PRESET = 'danger-full-access';
const SAVE_FIELDS = ['expectedRevision', 'modelMode', 'provider', 'model', 'effortMode', 'fixedEffort', 'allowedEfforts', 'defaultEffort', 'permissionMode', 'ackFullAccess'];
const STORED_FIELDS = ['schemaVersion', 'revision', ...SAVE_FIELDS.filter(key => key !== 'expectedRevision' && key !== 'ackFullAccess')];
const fileQueues = new Map();

function fail(message, status = 400, code = 'execution-policy-invalid') {
  return Object.assign(new Error(message), { code, status, statusCode: status });
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value, fields) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw fail('执行政策包含未知字段或不是对象。');
  }
}
function nonempty(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
function clone(value) { return structuredClone(value); }
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function service(ctx, key) {
  const result = typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
  if (!result) throw fail('DSH 执行政策依赖服务尚未就绪。', 503, 'execution-policy-unavailable');
  return result;
}
function normalizedPolicy(raw, stored) {
  exact(raw, stored ? STORED_FIELDS : SAVE_FIELDS);
  if (stored && (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0)) {
    throw fail('执行政策文件版本或 revision 无效。');
  }
  if (!stored && (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0)) {
    throw fail('expectedRevision 必须是非负安全整数。');
  }
  if (!['follow-default', 'pinned'].includes(raw.modelMode) || !['inherit', 'fixed', 'adaptive'].includes(raw.effortMode)) {
    throw fail('执行政策的模型模式或推理模式无效。');
  }
  if (!stored && raw.permissionMode === undefined) throw fail('保存执行政策时必须指定 permissionMode。');
  const permissionMode = raw.permissionMode === undefined ? 'inherit' : raw.permissionMode;
  if (!PERMISSION_MODES.includes(permissionMode)) throw fail('执行权限模式无效。');
  if (permissionMode === 'full-access' && !stored && raw.ackFullAccess !== true) {
    throw fail('完全权限需要显式确认（ackFullAccess: true）。');
  }
  if (permissionMode !== 'full-access' && raw.ackFullAccess !== undefined) {
    throw fail('当前权限模式不能携带 ackFullAccess。');
  }
  const next = { schemaVersion: 1, revision: stored ? raw.revision : raw.expectedRevision + 1, modelMode: raw.modelMode, effortMode: raw.effortMode, permissionMode };
  if (!Number.isSafeInteger(next.revision)) throw fail('执行政策 revision 已超出安全范围。');
  if (raw.modelMode === 'pinned') {
    if (!nonempty(raw.provider) || !nonempty(raw.model)) throw fail('固定模型需要有效的 provider 和 model。');
    next.provider = raw.provider;
    next.model = raw.model;
  } else if (Object.hasOwn(raw, 'provider') || Object.hasOwn(raw, 'model')) {
    throw fail('跟随默认模型时不能保存 provider 或 model。');
  }
  if (raw.effortMode === 'fixed') {
    if (!nonempty(raw.fixedEffort)) throw fail('固定推理模式需要 fixedEffort。');
    next.fixedEffort = raw.fixedEffort;
  } else if (Object.hasOwn(raw, 'fixedEffort')) throw fail('当前推理模式不能保存 fixedEffort。');
  if (raw.effortMode === 'adaptive') {
    if (!Array.isArray(raw.allowedEfforts) || raw.allowedEfforts.length === 0 || !raw.allowedEfforts.every(nonempty)) {
      throw fail('自适应推理模式需要非空 allowedEfforts 字符串列表。');
    }
    next.allowedEfforts = [...new Set(raw.allowedEfforts)];
    if (!nonempty(raw.defaultEffort) || !next.allowedEfforts.includes(raw.defaultEffort)) {
      throw fail('自适应 defaultEffort 必须属于 allowedEfforts。');
    }
    next.defaultEffort = raw.defaultEffort;
  } else if (Object.hasOwn(raw, 'allowedEfforts') || Object.hasOwn(raw, 'defaultEffort')) {
    throw fail('当前推理模式不能保存 allowedEfforts 或 defaultEffort。');
  }
  return next;
}
function safeCatalog(raw) {
  // Explicit projection rather than forwarding arbitrary provider/adapter fields.
  if (!object(raw) || !object(raw.default) || !nonempty(raw.default.provider) || !nonempty(raw.default.model)
      || !Array.isArray(raw.groups) || !Array.isArray(raw.failures) || !Array.isArray(raw.routableProviders)) {
    throw fail('DSH 模型目录格式无效。', 503, 'execution-policy-unavailable');
  }
  try {
    const selection = { provider: raw.default.provider, model: raw.default.model };
    if (raw.default.reasoningEffort !== undefined) {
      if (!nonempty(raw.default.reasoningEffort)) throw new Error();
      selection.reasoningEffort = raw.default.reasoningEffort;
    }
    const groups = raw.groups.map(group => {
      if (!nonempty(group.id) || typeof group.name !== 'string' || !Array.isArray(group.models)) throw new Error();
      return {
        id: group.id, name: group.name,
        models: group.models.map(model => {
          if (!nonempty(model.id) || typeof model.name !== 'string') throw new Error();
          const entry = { id: model.id, name: model.name };
          if (typeof model.description === 'string') entry.description = model.description;
          if (model.reasoning !== undefined) {
            if (!object(model.reasoning) || !Array.isArray(model.reasoning.efforts) || !model.reasoning.efforts.length) throw new Error();
            const efforts = model.reasoning.efforts.map(effort => {
              if (!nonempty(effort.id) || typeof effort.name !== 'string') throw new Error();
              return { id: effort.id, name: effort.name, ...(typeof effort.description === 'string' ? { description: effort.description } : {}) };
            });
            if (new Set(efforts.map(effort => effort.id)).size !== efforts.length) throw new Error();
            entry.reasoning = { efforts };
            if (model.reasoning.defaultEffort !== undefined) {
              if (!efforts.some(effort => effort.id === model.reasoning.defaultEffort)) throw new Error();
              entry.reasoning.defaultEffort = model.reasoning.defaultEffort;
            }
          }
          if (object(model.badge) && ['neutral', 'info', 'success', 'warning'].includes(model.badge.tone)) {
            const text = model.badge.text;
            if (typeof text === 'string' || (object(text) && typeof text.en === 'string' && Object.values(text).every(value => typeof value === 'string'))) {
              entry.badge = { text: clone(text), tone: model.badge.tone };
            }
          }
          return entry;
        }),
      };
    });
    if (!raw.routableProviders.every(nonempty)) throw new Error();
    return {
      default: selection, routableProviders: [...raw.routableProviders], groups,
      // Do not expose raw adapter failure messages: they may contain endpoint/credential diagnostics.
      failures: raw.failures.map(item => {
        if (!nonempty(item.id) || typeof item.name !== 'string') throw new Error();
        return { id: item.id, name: item.name, message: '该提供商的模型目录当前不可用。' };
      }),
    };
  } catch {
    throw fail('DSH 模型目录格式无效。', 503, 'execution-policy-unavailable');
  }
}
function resolvePolicy(policy, catalog, input = {}) {
  exact(input, ['reasoningEffort', 'reason']);
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.reason))) {
    throw fail('reason 必须是不超过 500 字符的纯文本字符串。');
  }
  const route = policy.modelMode === 'follow-default' ? catalog.default : policy;
  const entry = catalog.groups.find(group => group.id === route.provider)?.models.find(model => model.id === route.model);
  if (!entry) throw fail('执行模型当前不在 DSH 可用模型目录中；请修复模型配置，不会自动切换。', 503, 'execution-model-unavailable');
  const supported = entry.reasoning?.efforts.map(effort => effort.id) ?? [];
  const supports = effort => nonempty(effort) && supported.includes(effort);
  if (policy.effortMode === 'fixed' && !supports(policy.fixedEffort)) throw fail('固定推理强度已不受当前模型支持。');
  if (policy.effortMode === 'adaptive' && policy.allowedEfforts.some(effort => !supports(effort))) throw fail('自适应允许列表包含当前模型不支持的推理强度。');
  let effort;
  let effortSource;
  if (policy.effortMode !== 'adaptive' && Object.hasOwn(input, 'reasoningEffort')) {
    throw fail('当前执行政策不允许调用者选择 reasoningEffort。');
  }
  if (policy.effortMode === 'inherit') {
    const sameDefault = route.provider === catalog.default.provider && route.model === catalog.default.model;
    effort = sameDefault ? catalog.default.reasoningEffort : undefined;
    effortSource = effort === undefined ? 'model-default' : 'dsh-default';
    effort ??= entry.reasoning?.defaultEffort;
    if (effort === undefined) effortSource = 'adapter-default';
  } else if (policy.effortMode === 'fixed') {
    effort = policy.fixedEffort;
    effortSource = 'policy-fixed';
  } else {
    if (Object.hasOwn(input, 'reasoningEffort') && (!nonempty(input.reasoningEffort) || !policy.allowedEfforts.includes(input.reasoningEffort))) {
      throw fail('请求的推理强度不在政策允许列表中。');
    }
    effort = input.reasoningEffort ?? policy.defaultEffort;
    effortSource = input.reasoningEffort === undefined ? 'policy-default' : 'caller';
  }
  if (effort !== undefined && !supports(effort)) throw fail('有效推理强度不受当前模型支持。');
  return freeze({
    selection: { provider: route.provider, model: route.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    policyRevision: policy.revision, modelMode: policy.modelMode, effortMode: policy.effortMode, effortSource,
    permissionMode: policy.permissionMode, reason: input.reason ?? '',
  });
}

/** Policy persistence never edits the DSH default model or provider configuration. */
export function createExecutionPolicy({ ctx, logger, file = DEFAULT_FILE }) {
  const filename = resolve(file);
  void logger; // Errors are intentionally generic; never forward adapter stacks/secret-bearing diagnostics.
  async function read() {
    let raw;
    try { raw = await readFile(filename, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return clone(DEFAULT_POLICY);
      throw fail('无法读取执行政策文件。', 503, 'execution-policy-unavailable');
    }
    try { return normalizedPolicy(JSON.parse(raw.replace(/^\uFEFF/, '')), true); }
    catch { throw fail('执行政策文件已损坏或格式无效；请修复后重试。', 503, 'execution-policy-corrupt'); }
  }
  async function catalog() {
    let raw;
    try { raw = await service(ctx, 'sessionController').modelCatalog(); }
    catch { throw fail('DSH 模型目录当前不可用。', 503, 'execution-policy-unavailable'); }
    return safeCatalog(raw);
  }
  async function snapshot() {
    const policy = await read();
    return freeze({ ok: true, policy, catalog: await catalog(), permissions: permissionCatalog() });
  }
  async function resolveExecution(input = {}) {
    const state = await snapshot();
    return resolvePolicy(state.policy, state.catalog, input);
  }
  async function save(body) {
    // Detach before queueing so caller mutation cannot alter the CAS/write payload.
    const proposed = normalizedPolicy(body, false);
    const expectedRevision = body.expectedRevision;
    const operation = (fileQueues.get(filename) ?? Promise.resolve()).then(async () => {
      const current = await read();
      if (current.revision !== expectedRevision) throw fail('执行政策已被其他操作修改，请重新读取后保存。', 409, 'execution-policy-conflict');
      const resolved = resolvePolicy(proposed, await catalog());
      try { await service(ctx, 'llm').resolveCallConfig(resolved.selection); }
      catch { throw fail('DSH 拒绝了当前执行模型或推理强度。', 503, 'execution-model-unavailable'); }
      const temp = join(dirname(filename), `.execution-policy-${process.pid}-${randomUUID()}.tmp`);
      try {
        await mkdir(dirname(filename), { recursive: true });
        await writeFile(temp, JSON.stringify(proposed, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temp, filename);
      } catch {
        throw fail('无法原子保存执行政策。', 503, 'execution-policy-unavailable');
      } finally {
        // Exact temp path created above; never delete the destination or caller-supplied paths.
        await unlink(temp).catch(() => {});
      }
      return freeze({ ok: true, policy: clone(proposed) });
    });
    const settled = operation.then(() => undefined, () => undefined);
    fileQueues.set(filename, settled);
    void settled.then(() => { if (fileQueues.get(filename) === settled) fileQueues.delete(filename); });
    return operation;
  }
  async function apply(sessionId, selection) {
    if (!nonempty(sessionId)) throw fail('缺少有效的执行会话 ID。');
    exact(selection, ['provider', 'model', 'reasoningEffort']);
    if (!nonempty(selection.provider) || !nonempty(selection.model) || (selection.reasoningEffort !== undefined && !nonempty(selection.reasoningEffort))) throw fail('执行会话模型选择无效。');
    const selected = clone(selection);
    try { await service(ctx, 'llm').resolveCallConfig(selected); }
    catch { throw fail('DSH 拒绝了当前执行模型或推理强度。', 503, 'execution-model-unavailable'); }
    const result = await service(ctx, 'sessionController').resolveAgent(sessionId);
    if (result && 'error' in result) throw result.error;
    if (!result?.agent?.model || typeof result.agent.model.select !== 'function') throw fail('执行会话模型服务不可用。', 503, 'execution-policy-unavailable');
    await result.agent.model.select(selected);
  }
  /**
   * Apply the frozen execution permission mode to this owned, not-yet-prompted
   * session. never-ask keeps the profile's resource access but rejects actions
   * that would need a human approval; full-access requires an explicit user
   * selection and switches the built-in danger-full-access preset first.
   */
  async function applyAccess(sessionId, mode) {
    if (!nonempty(sessionId)) throw fail('缺少有效的执行会话 ID。');
    if (mode !== 'never-ask' && mode !== 'full-access' && mode !== 'auto') return;
    const result = await service(ctx, 'sessionController').resolveAgent(sessionId);
    if (result && 'error' in result) throw result.error;
    const agent = result?.agent;
    if (!agent || !agent.session) throw fail('执行会话权限服务不可用。', 503, 'execution-policy-unavailable');
    if (mode === 'full-access' || mode === 'auto') {
      let presets = null;
      try { presets = typeof ctx?.get === 'function' ? ctx.get('permissionPresets') : ctx?.permissionPresets; } catch { presets = null; }
      if (!presets || typeof presets.set !== 'function' || !Array.isArray(presets.names)) {
        throw fail('当前 DSH 没有启用权限预设服务，无法切换执行权限。', 503, 'execution-permission-unavailable');
      }
      const preset = mode === 'auto' ? 'auto' : FULL_ACCESS_PRESET;
      if (mode === 'auto' && !presets.names.includes('auto')) {
        throw fail('当前 DSH 没有启用 Auto 审核预设；请在设置里改用完全权限，或先在 DSH 启用 Auto 集成。', 503, 'execution-permission-unavailable');
      }
      if (mode === 'full-access' && !presets.names.includes(FULL_ACCESS_PRESET)) {
        throw fail('当前 DSH 没有配置完全权限预设（' + FULL_ACCESS_PRESET + '）。', 503, 'execution-permission-unavailable');
      }
      presets.set(agent.session, preset);
    }
    // Auto keeps its own independent reviewer and ask policy; never-ask and
    // full-access deterministically disable approval prompts.
    if (mode === 'auto') return;
    const approval = service(ctx, 'approval');
    if (typeof approval.setPolicy !== 'function') throw fail('当前 DSH 没有审批策略服务。', 503, 'execution-permission-unavailable');
    approval.setPolicy(agent, 'never');
  }
  /** Advertised permission presets (for the settings UI/status). */
  function permissionCatalog() {
    try {
      const presets = typeof ctx?.get === 'function' ? ctx.get('permissionPresets') : ctx?.permissionPresets;
      const names = presets && Array.isArray(presets.names) ? presets.names : []
      return { names, autoAvailable: names.includes('auto'), fullAccessAvailable: names.includes(FULL_ACCESS_PRESET) }
    } catch {
      return { names: [], autoAvailable: false, fullAccessAvailable: false }
    }
  }
  return { read, snapshot, save, resolveExecution, apply, applyAccess, permissionCatalog };
}
