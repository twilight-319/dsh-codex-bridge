/**
 * Output contracts shared by two layers:
 *   1. `*_SCHEMA` — handed to `codex exec --output-schema`, so the model is
 *      forced by the API to emit exactly this shape (no markdown, no prose).
 *   2. `outputSchema()` — the DSH tool output schema: the same fields plus the
 *      `_meta` footer, with `additionalProperties: true` so diagnostics can be
 *      added without invalidating the result.
 *
 * @module @local/dsh-codex-bridge/schemas
 */

const stringArray = { type: 'array', items: { type: 'string' } }

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string' },
    assumptions: stringArray,
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          files: stringArray,
          why: { type: 'string' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['id', 'action', 'files', 'why', 'risk'],
        additionalProperties: false,
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          choice: { type: 'string' },
          why: { type: 'string' },
          alternatives: stringArray,
        },
        required: ['question', 'choice', 'why', 'alternatives'],
        additionalProperties: false,
      },
    },
    acceptance: stringArray,
    risks: stringArray,
    openQuestions: stringArray,
  },
  required: ['task', 'assumptions', 'steps', 'decisions', 'acceptance', 'risks', 'openQuestions'],
  additionalProperties: false,
}

export const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    decision: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number' },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'string' },
          whyNot: { type: 'string' },
        },
        required: ['option', 'whyNot'],
        additionalProperties: false,
      },
    },
    nextAction: { type: 'string' },
    openQuestions: stringArray,
  },
  required: ['question', 'decision', 'rationale', 'confidence', 'alternatives', 'nextAction', 'openQuestions'],
  additionalProperties: false,
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise', 'reject'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'line', 'issue', 'fix'],
        additionalProperties: false,
      },
    },
    missingTests: stringArray,
    nextAction: { type: 'string' },
  },
  required: ['verdict', 'summary', 'findings', 'missingTests', 'nextAction'],
  additionalProperties: false,
}

export const ASK_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    keyPoints: stringArray,
    nextAction: { type: 'string' },
    openQuestions: stringArray,
  },
  required: ['answer', 'keyPoints', 'nextAction', 'openQuestions'],
  additionalProperties: false,
}

export const SCHEMAS = {
  plan: PLAN_SCHEMA,
  decide: DECIDE_SCHEMA,
  review: REVIEW_SCHEMA,
  ask: ASK_SCHEMA,
}

const META_SCHEMA = {
  type: 'object',
  properties: {
    elapsedMs: { type: 'number' },
    model: { type: 'string' },
    effort: { type: 'string' },
    sandbox: { type: 'string' },
    cwd: { type: 'string' },
    inputTokens: { type: 'number' },
    cachedInputTokens: { type: 'number' },
    outputTokens: { type: 'number' },
    reasoningTokens: { type: 'number' },
    threadId: { type: 'string' },
    consultationId: { type: 'string' },
    source: { type: 'string' },
    reason: { type: 'string' },
    usageKnown: { type: 'boolean' },
    reused: { type: 'boolean' },
  },
  additionalProperties: true,
}

/** DSH tool output schema: the Codex result plus `_meta`. */
export function outputSchema(kind) {
  const base = SCHEMAS[kind]
  return {
    type: 'object',
    properties: { ...base.properties, _meta: META_SCHEMA },
    required: [...base.required, '_meta'],
    additionalProperties: true,
  }
}

/** Validate (lightly) a parsed result against the contract's required keys. */
export function assertResultShape(kind, value) {
  const base = SCHEMAS[kind]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`codex returned ${typeof value} instead of a JSON object`)
  }
  const missing = base.required.filter((key) => !(key in value))
  if (missing.length > 0) throw new Error(`codex JSON is missing required fields: ${missing.join(', ')}`)
  return value
}
