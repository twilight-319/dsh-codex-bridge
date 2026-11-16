import { taskError } from './task-store.js'
export const TASK_PATH = '/api/dsh-codex-bridge.v2.tasks'
export const taskActions = ['submit','get','list','events','answer','cancel','reconcile','retry']
export async function dispatchTask(manager, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !taskActions.includes(body.action)) throw taskError('未知任务操作。')
  const { action, ...input } = body
  if (action === 'get') return manager.get(input.taskId)
  return manager[action](input)
}
