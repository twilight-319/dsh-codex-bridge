// VM React contract test for the model-policy editor as mounted through the
// redesigned workbench overlay: opens without saving, renders the live catalog,
// posts the exact policy body, and surfaces a revision conflict.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let plugin
let mounted
let effects = []
let states = []
let cursor = 0
const requests = []
let saveConflict = false
const policy = { schemaVersion: 1, revision: 3, modelMode: 'follow-default', effortMode: 'inherit', permissionMode: 'full-access' }
const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  routableProviders: ['deepseek-official'],
  groups: [{
    id: 'deepseek-official', name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } },
      { id: 'deepseek-lite', name: 'DeepSeek Lite' },
    ],
  }],
  failures: [],
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) {
    const i = cursor++
    if (!(i in states)) states[i] = initial
    return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
  },
  useRef(value) { const i = cursor++; return states[i] ?? (states[i] = { current: value }) },
  useCallback: (fn) => fn,
  useEffect(fn) { effects.push(fn) },
}
const sandbox = {
  window: { __ModuleLoader__: { load(def) { plugin = def.factory(() => React) } } },
  document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
  fetch: async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null })
    const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value })
    if (url === '/api/dsh-codex-bridge.v3.codex') return json({ ok: true, projects: [] })
    if (url === '/api/dsh-codex-bridge.v2.codex') return json({ ok: true, projects: [] })
    if (url === '/api/dsh-codex-bridge.execution-policy') {
      if ((options.method || 'GET') === 'POST') {
        if (saveConflict) return json({ ok: false, error: 'execution-policy-conflict', message: '执行政策已被其他操作修改，请重新读取后保存。' }, 409)
        const body = JSON.parse(options.body)
        const saved = {
          schemaVersion: 1, revision: 4, modelMode: body.modelMode, effortMode: body.effortMode, permissionMode: body.permissionMode, ...(body.permissionMode === 'full-access' ? {} : {}),
          ...(body.modelMode === 'pinned' ? { provider: body.provider, model: body.model } : {}),
          ...(body.effortMode === 'fixed' ? { fixedEffort: body.fixedEffort } : {}),
          ...(body.effortMode === 'adaptive' ? { allowedEfforts: body.allowedEfforts, defaultEffort: body.defaultEffort } : {}),
        }
        return json({ ok: true, policy: saved, catalog })
      }
      return json({ ok: true, policy, catalog })
    }
    return json({ ok: false, error: 'unexpected ' + url }, 404)
  },
  setInterval: () => 1,
  clearInterval() {},
  console,
  Date,
  Promise,
}
vm.runInNewContext(code, sandbox)
const slots = { inject(name, fn) { fn() }, register(def, fn) { if (def.name === 'main' && def.key === 'codex') mounted = fn; return () => {} } }
plugin.apply({ slots, uiWorkspace: { openSession() {} }, sessions: { list: { getSnapshot: () => ({ byId: {} }) } }, get(name) { return this[name] }, effect(fn) { fn() } })
assert.ok(mounted)
const walk = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((item) => walk(item, out))
  else if (node && typeof node === 'object') { out.push(node); walk(node.children, out) }
  return out
}
const wait = () => new Promise((resolve) => setImmediate(resolve))
const root = mounted()
const byText = (tree, tag, text) => walk(tree).find((node) => node.type === tag && node.children.includes(text))
const textOf = (tree) => JSON.stringify(tree)
let ranOnce = false
let editorEffectsRan = false
function render() {
  effects = []; cursor = 0
  const page = root.type()
  const editor = walk(page).find((node) => typeof node.type === 'function')
  const tree = editor ? editor.type() : null
  if (!ranOnce) { ranOnce = true; effects.forEach((fn) => fn()) }
  if (editor && !editorEffectsRan) { editorEffectsRan = true; effects.forEach((fn) => fn()) }
  return { page, tree }
}
let view = render()
await wait(); view = render(); await wait(); view = render()
assert.ok(byText(view.page, 'button', '执行模型'), 'workbench exposes the policy button')
byText(view.page, 'button', '执行模型').props.onClick()
view = render()
await wait()
view = render()
assert.ok(view.tree, 'policy editor mounts inside the overlay')
assert.ok(textOf(view.tree).includes('执行模型政策'), 'editor heading renders')
assert.ok(textOf(view.tree).includes('deepseek/deepseek-v4') === false)
assert.ok(textOf(view.tree).includes('deepseek-official/deepseek-flash'), 'shows the live default route')
assert.ok(textOf(view.tree).includes('执行权限'), 'permission section is rendered')
assert.equal(requests.filter((item) => item.method === 'GET' && item.url === '/api/dsh-codex-bridge.execution-policy').length, 1)
assert.equal(requests.some((item) => item.method === 'POST'), false, 'open must not auto-save')

// Switch to pinned + adaptive through the rendered controls.
const editorRender = () => { const next = render(); return next.tree }
const radios = () => walk(view.tree).filter((node) => node.type === 'input' && node.props.type === 'radio')
radios().filter((node) => node.props.name === 'modelMode')[1].props.onChange()
view.tree = editorRender()
const selects = () => walk(view.tree).filter((node) => node.type === 'select')
selects()[0].props.onChange({ target: { value: 'deepseek-official' } })
view.tree = editorRender()
selects()[1].props.onChange({ target: { value: 'deepseek-flash' } })
view.tree = editorRender()
walk(view.tree).filter((node) => node.type === 'input' && node.props.type === 'radio' && node.props.name === 'effortMode')[2].props.onChange()
view.tree = editorRender()
const boxes = () => walk(view.tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox' && String(node.props['aria-label'] || '').indexOf('允许强度 ') === 0)
assert.equal(boxes().length, 2, 'only the model-advertised efforts are offered')
boxes()[0].props.onChange(); view.tree = editorRender()
boxes()[1].props.onChange(); view.tree = editorRender()
walk(view.tree).filter((node) => node.type === 'select').at(-1).props.onChange({ target: { value: 'high' } })
view.tree = editorRender()
byText(view.tree, 'button', '保存执行模型设置').props.onClick()
await wait()
const posted = requests.filter((item) => item.method === 'POST')
assert.equal(posted.length, 1)
assert.deepEqual(posted[0].body, {
  expectedRevision: 3,
  modelMode: 'pinned',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  effortMode: 'adaptive',
  allowedEfforts: ['low', 'high'],
  defaultEffort: 'high',
  permissionMode: 'full-access',
  ackFullAccess: true,
})
view.tree = editorRender()
assert.ok(textOf(view.tree).includes('已保存'))

saveConflict = true
byText(view.tree, 'button', '保存执行模型设置').props.onClick()
await wait()
view.tree = editorRender()
assert.ok(textOf(view.tree).includes('其他操作修改'), 'conflict message is shown')
assert.ok(textOf(view.tree).includes('deepseek-flash'), 'draft is preserved')
assert.ok(walk(view.tree).some((node) => node.props.role === 'alert'))

console.log('PASS: policy overlay opens without saving, renders live catalog, posts the exact policy body, advances revision and surfaces CAS conflict.')
