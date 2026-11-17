import { taskError } from './task-store.js'
export const TASK_PATH = '/api/dsh-codex-bridge.v2.tasks'
export const taskActions = ['submit','orchestrate','repair_node','preview','get','list','events','wait','await','answer','cancel','reconcile','retry','maintenance_status','maintenance_begin','maintenance_end']
export async function dispatchTask(manager, body, { signal } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !taskActions.includes(body.action)) throw taskError('未知任务操作。')
  const { action, ...input } = body
  if (action === 'maintenance_status') return manager.maintenanceStatus()
  if (action === 'maintenance_begin') return manager.maintenanceBegin()
  if (action === 'maintenance_end') return manager.maintenanceEnd(input)
  if (action === 'get') return manager.get(input.taskId)
  if (action === 'repair_node') return manager.repairNode(input)
  if (['wait','await'].includes(action)) return manager[action]({ ...input, signal })
  return manager[action](input)
}
