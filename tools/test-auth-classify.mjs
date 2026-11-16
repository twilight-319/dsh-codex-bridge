// Unit test for the Codex credential-failure classifier used by the runner's
// one-shot session restart. No Codex process or network is involved.
import assert from 'node:assert/strict'
import { isAuthFailure } from '../lib/codex-v2.js'

const positives = [
  { message: 'codex turn failed: 401 Unauthorized' },
  { message: 'HTTP 401: token expired' },
  { codexErrorInfo: { httpStatusCode: 401 } },
  { message: 'not logged in, run codex login' },
  { message: 'authentication required' },
  { message: 'OAuth token has expired' },
  { message: 'invalid_api_key' },
  { additionalDetails: '401 Unauthorized: invalid token' },
]
for (const error of positives) assert.equal(isAuthFailure(error), true, JSON.stringify(error))

const negatives = [
  null,
  undefined,
  '401 Unauthorized',
  { message: 'codex turn failed: timeout' },
  { message: 'codex app-server completed without an answer' },
  { message: 'all 3 app-server sessions are busy; retry when one finishes' },
  { message: 'connect ECONNREFUSED 127.0.0.1:61411' },
  { message: 'task failed: tests returned 401 lines of output' },
  {},
]
for (const error of negatives) assert.equal(isAuthFailure(error), false, JSON.stringify(error))

console.log('PASS: auth-failure classifier recognizes 401/login failures and ignores unrelated transport/timeout errors.')
