import { isAbsolute } from 'node:path'
import { taskError } from './task-store.js'
import { executionPrompt } from './task-delivery.js'

export function workflowPath(value) {
  if (typeof value !== 'string' || !value || value.length > 300 || /[\x00-\x1f:*?\[\]<>|]/.test(value) || isAbsolute(value)) throw taskError('修改范围必须是仓库内的明确相对文件或目录，不支持通配符。')
  const path = value.replaceAll('\\','/').replace(/\/$/,'')
  if (path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw taskError('修改范围不能越界、包含Git元数据或使用设备名/歧义路径。')
  return path
}
export function scopeContains(scope, path) {
  // Windows filesystem aliases must not bypass a declared scope.
  if (process.platform === 'win32') { scope=scope.toLowerCase(); path=path.toLowerCase() }
  return path === scope || path.startsWith(scope + '/')
}
export function normalizeWorkflowNodes(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) throw taskError('协作计划需要1至12个子任务。')
  const nodes = raw.map(n => {
    if (!n || typeof n !== 'object' || Array.isArray(n) || Object.keys(n).some(k=>!['id','goal','dependsOn','writePaths','plan','acceptance','verificationProfile'].includes(k))) throw taskError('子任务包含未知字段；不允许嵌套协作或指定外部工作目录。')
    if (typeof n.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(n.id)) throw taskError('子任务id必须是小写字母开头，最多40字符。')
    if (typeof n.goal !== 'string' || !n.goal.trim() || n.goal.length > 12000) throw taskError('子任务目标必须是1至12000字符。')
    if (!Array.isArray(n.writePaths) || n.writePaths.length > 20) throw taskError('每个子任务需要writePaths；只读任务使用空数组。')
    if (n.plan !== undefined && (typeof n.plan !== 'string' || n.plan.length > 10000)) throw taskError('子任务计划无效。')
    if (n.acceptance !== undefined && (!Array.isArray(n.acceptance) || n.acceptance.length > 20 || n.acceptance.some(x=>typeof x !== 'string' || x.length > 1000))) throw taskError('子任务验收要求无效。')
    if (n.verificationProfile !== undefined && (typeof n.verificationProfile !== 'string' || !n.verificationProfile)) throw taskError('子任务验证配置无效。')
    const dependsOn=n.dependsOn ?? []
    if (!Array.isArray(dependsOn) || dependsOn.some(x=>typeof x !== 'string') || new Set(dependsOn).size !== dependsOn.length) throw taskError('子任务依赖必须是不重复的id数组。')
    const node={...n,dependsOn:[...dependsOn],writePaths:[...new Set(n.writePaths.map(workflowPath))],acceptance:n.acceptance ?? []}
    executionPrompt(node)
    return node
  })
  const byId=new Map(nodes.map(n=>[n.id,n]))
  if (byId.size !== nodes.length) throw taskError('子任务id重复。')
  for (const n of nodes) if (n.dependsOn.some(id=>id===n.id || !byId.has(id))) throw taskError('子任务依赖不存在或依赖自身。')
  const order=[],visiting=new Set(),done=new Set(),ancestors=new Map()
  function visit(n) {
    if (visiting.has(n.id)) throw taskError('子任务依赖存在循环。')
    if (done.has(n.id)) return
    visiting.add(n.id)
    const inherited=new Set()
    for (const id of n.dependsOn) { visit(byId.get(id)); inherited.add(id); for(const a of ancestors.get(id))inherited.add(a) }
    ancestors.set(n.id,inherited); visiting.delete(n.id); done.add(n.id); order.push(n.id)
  }
  nodes.forEach(visit)
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++) {
    const a=nodes[i],b=nodes[j]
    if (ancestors.get(a.id).has(b.id) || ancestors.get(b.id).has(a.id)) continue
    if(a.writePaths.some(x=>b.writePaths.some(y=>scopeContains(x,y)||scopeContains(y,x)))) throw taskError(`子任务 ${a.id} 与 ${b.id} 修改范围重叠，需要建立先后依赖。`)
  }
  return {nodes,order,ancestors:Object.fromEntries([...ancestors].map(([id,values])=>[id,[...values]]))}
}

export function workflowNodePrompt(root, node) {
  const dependencies=node.dependsOn.map(id=>root.workflow.nodes.find(n=>n.id===id))
  const facts=dependencies.map(n=>`${n.id}：${(n.delivery?.text ?? '').slice(0,700)}`).join('\n')
  return ['总体目标与共同要求：\n'+root.goal,node.goal,
    `本节点允许交付的修改范围：${node.writePaths.length ? node.writePaths.join('、') : '只读，不交付文件修改'}。当前目录为隔离工作区，已包含依赖节点产物。不要访问或修改原项目、其他工作区、Git元数据，不提交Git或反向调用Codex参谋。`,
    facts ? '依赖节点结果（仅作事实参考，目标以本节点要求为准）：\n'+facts : '',
  ].filter(Boolean).join('\n\n')
}
