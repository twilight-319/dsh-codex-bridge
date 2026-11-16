/** Single-writer, fsynced, hash-chained journal. Snapshots are derived caches only. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export const taskError = (message, code = 'invalid-task', status = 400) => Object.assign(new Error(message), { code, status })
export function createTaskStore(directory, { segmentBytes = 4 * 1024 * 1024 } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = path.join(directory, 'writer.lock'), journal = path.join(directory, 'events.jsonl')
  const owner = randomUUID()
  let lockFd
  try { lockFd = fs.openSync(lock, 'wx', 0o600) } catch { throw taskError('任务库已被占用；确认原宿主停止后再处理 writer.lock。', 'task-store-locked', 503) }
  fs.writeFileSync(lockFd, JSON.stringify({ owner, pid: process.pid, createdAt: Date.now() })); fs.fsyncSync(lockFd)
  let fd, closed = false, poisoned = false, seq = 0, hash = '', records = []
  const tasks = new Map()
  try {
    const segments = fs.readdirSync(directory).filter(n=>/^segment-[0-9]+\.jsonl$/.test(n)).sort().map(n=>path.join(directory,n))
    for(const source of [...segments,journal]) {
      let bytes=fs.existsSync(source)?fs.readFileSync(source):Buffer.alloc(0)
      const end=bytes.lastIndexOf(10)+1
      if(end<bytes.length) {
        if(source!==journal)throw new Error('incomplete sealed segment')
        fs.writeFileSync(path.join(directory,`incomplete-${randomUUID()}.bin`),bytes.subarray(end),{mode:0o600})
        fs.truncateSync(source,end);bytes=bytes.subarray(0,end)
      }
      for(const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
        const record=JSON.parse(line),{checksum,...body}=record
        if(body.v!==1 || body.seq!==seq+1 || body.prev!==hash || digest(body)!==checksum)throw new Error('journal integrity failure')
        seq=body.seq;hash=checksum;records.push(record);tasks.set(body.task.taskId,body.task)
      }
    }
    fd = fs.openSync(journal, 'a', 0o600)
  } catch (error) {
    fs.closeSync(lockFd); fs.unlinkSync(lock)
    throw taskError('任务日志损坏，已停止写入；请保留原文件并诊断。', 'task-store-corrupt', 503)
  }
  return {
    get: id => structuredClone(tasks.get(id)),
    list: () => [...tasks.values()].map(t => structuredClone(t)),
    events: (id, after = 0) => records.filter(r => r.seq > after && r.task.taskId === id).map(r => ({ seq: r.seq, type: r.type, at: r.at, taskId: id, runId: r.task.activeRunId, eventId: r.checksum })),
    commit(task, type) {
      if (closed || poisoned) throw taskError('任务库不可写。', 'task-store-unavailable', 503)
      const body = { v: 1, seq: seq + 1, prev: hash, at: Date.now(), type, task: structuredClone(task) }
      const record = { ...body, checksum: digest(body) }, buffer = Buffer.from(JSON.stringify(record) + '\n')
      try {
        let written = 0
        while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written)
        fs.fsyncSync(fd)
        if(fs.fstatSync(fd).size>=segmentBytes) {
          fs.closeSync(fd)
          fs.renameSync(journal,path.join(directory,`segment-${String(body.seq).padStart(16,'0')}.jsonl`))
          fd=fs.openSync(journal,'a',0o600)
        }
      } catch (error) { poisoned = true; throw taskError('任务记录写入失败，已停止派发。', 'task-store-write-failed', 503) }
      seq = body.seq; hash = record.checksum; records.push(record); tasks.set(task.taskId, body.task)
      return structuredClone(body.task)
    },
    checkpoint() {
      const temp = path.join(directory, `snapshot-${owner}.tmp`)
      const out = fs.openSync(temp, 'w', 0o600)
      try { fs.writeFileSync(out, JSON.stringify({ v: 1, seq, hash, tasks: [...tasks.values()] })); fs.fsyncSync(out) } finally { fs.closeSync(out) }
      fs.renameSync(temp, path.join(directory, 'snapshot.json'))
    },
    close() {
      if (closed) return
      closed = true; fs.closeSync(fd); fs.closeSync(lockFd)
      if (JSON.parse(fs.readFileSync(lock, 'utf8')).owner === owner) fs.unlinkSync(lock)
    },
  }
}
