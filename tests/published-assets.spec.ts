import { describe, expect, it } from 'vitest'

import { declareEnvironmentProtocol, ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_ROLE, ENVIRONMENT_VERSION, PUBLISHER_ROLE } from '../src/environment/protocol.ts'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { publishedAssetsBelow } from '../src/strategy/published-assets.ts'

const ENVIRONMENT = 'library-1'
const initial = { templates: [{ id: 'root', goal: 'count' }], skills: [{ name: 'count', content: 'count carefully' }], tools: [{ name: 'count', source: 'initial tool' }] }
let counter = 0
function factsLog(): MemoryLog {
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  return new MemoryLog(registry, { subjects: { [ENVIRONMENT_ROLE]: 'environment-service', [PUBLISHER_ROLE]: 'publisher-service' },
    now: () => '2026-10-09T00:00:00.000Z' })
}
function created(log: MemoryLog, revisionId: string, manifest: unknown, subject = ENVIRONMENT): void {
  log.emit({ commandId: `create-${++counter}`, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated, subject, payload: { revisionId, manifest } })
}
function switched(log: MemoryLog, expected: string, to: string, subject = ENVIRONMENT): void {
  log.emit({ commandId: `switch-${++counter}`, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched, subject, payload: { expected, to } })
}

describe('accepted structural edits in frozen publication history', () => {
  it('counts actual publication edits without an election; bootstrap establishes the baseline', () => {
    const log = factsLog()
    created(log, 'initial', initial)
    created(log, 'improved', { ...initial, templates: [{ id: 'root', goal: 'count exactly' }], skills: [{ name: 'count', content: 'count twice' }] })
    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual([])
    switched(log, '', 'initial')
    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual([])
    switched(log, 'initial', 'improved')
    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual(['template', 'skill'])
  })

  it('preserves the frozen cutoff and cumulative edits across rollback, isolating other libraries', () => {
    const log = factsLog()
    created(log, 'initial', initial)
    switched(log, '', 'initial')
    created(log, 'skill', { ...initial, skills: [{ name: 'count', content: 'new skill' }] })
    switched(log, 'initial', 'skill')
    const cutoff = log.count
    created(log, 'tool', { ...initial, skills: [{ name: 'count', content: 'new skill' }], tools: [{ name: 'count', source: 'new tool' }] })
    switched(log, 'skill', 'tool')
    created(log, 'other-initial', initial, 'another-library')
    created(log, 'other-gate', { ...initial, tools: 'new gate' }, 'another-library')
    switched(log, '', 'other-initial', 'another-library')
    switched(log, 'other-initial', 'other-gate', 'another-library')
    switched(log, 'tool', 'initial')
    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, cutoff)).toEqual(['skill'])
    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual(['skill', 'tool'])
  })

  it('attributes no structural class to generic revision fields', () => {
    const log = factsLog()
    created(log, 'a', { notes: 'one' })
    created(log, 'b', { notes: 'two' })
    switched(log, '', 'a')
    switched(log, 'a', 'b')
    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual([])
  })
})
