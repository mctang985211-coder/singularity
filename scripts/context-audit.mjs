#!/usr/bin/env node
/** Measures serialized inputs, not tokens. Captures are exported by the request owner, never reconstructed from summaries. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))
const hash = text => createHash('sha256').update(text).digest('hex')
export const contextSources = [
  [
    'native-policy',
    'dsh-baseline.json',
    'Pinned host identities; actual system policy must be measured from request capture',
  ],
  ['role-policy', 'assembly/src/prompts.ts', 'guidanceFor / reviewGuidanceFor: decision policy and purpose fragments'],
  ['tool-capability-policy', 'assembly/src/tool-policy.ts', 'One allowlist for native/schema/sections/admission'],
  ['tool-schema', 'assembly/src/agent.ts', 'Tool syntax, argument semantics and pagination'],
  [
    'dispatch-contract-direction-handoff',
    'assembly/src/scheduler.ts',
    'Frozen dispatch packet; facts, not another acceptance contract',
  ],
  ['review-subject', 'assembly/src/review.ts', 'Frozen subject, protected checks and host-generated report facts'],
  ['proposal-authoring', 'assembly/src/rsi-policy.ts', 'Proposal criteria and authoring rules'],
  ['authoring-format', 'assembly/src/rsi-proposal.ts', 'Parser and minimal format; no duplicate policy'],
  ['method-template-skill', 'assembly/src/method-run.ts', 'Pinned guidance/catalog; Skill body only on actual read'],
  ['on-demand-pages', 'assembly/src/read.ts', 'Scoped read results and paging'],
  ['handoff-and-direction', 'assembly/src/coordination.ts', 'Relationship projection; cannot rewrite the contract'],
  ['optional-memory', 'assembly/src/parent-memory.ts', 'Optional notes; cannot establish acceptance'],
]
export async function auditSources(root = ROOT) {
  const inventory = []
  for (const [component, file, authority] of contextSources) {
    const content = await readFile(resolve(root, file), 'utf8')
    inventory.push({ component, file, authority, sha256: hash(content), sourceBytes: bytes(content) })
  }
  return { schemaVersion: 1, kind: 'source-inventory', units: 'UTF-8 bytes; not request tokens', inventory }
}
export function auditRequests(capture) {
  assert.equal(capture.schemaVersion, 1)
  assert.ok(['offline-native-fixture', 'research'].includes(capture.kind))
  assert.ok(Array.isArray(capture.requests) && capture.requests.length > 0)
  const requests = capture.requests.map((request, index) => {
    assert.ok(
      Array.isArray(request.messages) && Array.isArray(request.tools),
      'complete native messages/tools required',
    )
    const messages = request.messages.map((message, position) => ({
      position,
      role: message.role,
      source: message.source ?? null,
      bytes: bytes(message),
      sha256: hash(JSON.stringify(message)),
    }))
    const tools = request.tools.map(tool => ({
      name: tool.name,
      bytes: bytes(tool),
      sha256: hash(JSON.stringify(tool)),
    }))
    const systems = request.messages.filter(m => m.role === 'system')
    const policy = systems.map(m => JSON.stringify(m.content)).join('\n')
    const starts = policy.split('Singularity executes frozen Tasks in a workflow.').length - 1
    assert.ok(starts <= 1, 'duplicate injected Singularity role policy')
    const toolNames = tools.map(t => t.name)
    assert.equal(new Set(toolNames).size, toolNames.length, 'duplicate tool schema')
    const sections = request.messages.flatMap((message, position) => {
      if (message.source?.kind !== 'singularity' || message.source.purpose !== 'dispatch') return []
      const text = (message.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
      let dispatch
      try {
        dispatch = JSON.parse(text)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return [{ position, component: 'unstructured-dispatch', bytes: bytes(text) }]
      }
      if (!dispatch || typeof dispatch !== 'object')
        return [{ position, component: 'unstructured-dispatch', bytes: bytes(text) }]
      return Object.entries(dispatch).map(([key, value]) => ({ position, component: key, bytes: bytes(value) }))
    })
    return {
      index,
      sessionId: request.sessionId ?? null,
      serializedRequestBytes: bytes(request),
      systemBytes: systems.reduce((n, m) => n + bytes(m), 0),
      toolsBytes: bytes(request.tools),
      conversationBytes: bytes(request.messages),
      messages,
      tools,
      dispatchSections: sections,
    }
  })
  return { schemaVersion: 1, kind: capture.kind, units: 'UTF-8 bytes; not tokenizer or billing evidence', requests }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const capture = process.argv[2]
  const report = capture ? auditRequests(JSON.parse(await readFile(capture, 'utf8'))) : await auditSources()
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}
