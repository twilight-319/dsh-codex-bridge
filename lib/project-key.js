import {realpathSync} from 'node:fs'
import {resolve} from 'node:path'
export function projectKey(cwd) {
  let key=resolve(cwd)
  try{key=realpathSync.native(key)}catch{/* Missing historical directories remain identifiable. */}
  return process.platform==='win32'?key.toLowerCase():key
}
