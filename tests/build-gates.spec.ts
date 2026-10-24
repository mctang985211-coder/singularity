import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const {
  coreWriteFindings,
  boundaryFindings,
  domainFindings,
  inventoryFindingsWith,
  mutationFindings,
}: {
  coreWriteFindings(sources: readonly { file: string; text: string }[]): readonly string[]
  boundaryFindings(sources: readonly { file: string; text: string }[]): readonly string[]
  domainFindings(
    sources: readonly { file: string; text: string }[],
    declarations: readonly unknown[],
  ): readonly string[]
  inventoryFindingsWith(ledger: unknown, declared: readonly unknown[]): readonly string[]
  mutationFindings(ledger: unknown, textOf: (file: string) => string): readonly string[]
} = await import(fileURLToPath(new URL('../scripts/gates.mjs', import.meta.url)))

describe('executable package boundaries', () => {
  it.each([
    "import { openDriver } from '../../assembly/src/driver.ts'",
    "export type { TaskDriver } from '../../assembly/src/driver.ts'",
    "const host = await import('@deepseek-ai/dsh-session')",
    "import { Session } from '@deepseek-ai/dsh-session'",
    "import { type Session, SessionId } from '@deepseek-ai/dsh-session'",
    "import { openAgentSession } from '../runtime/agent-session.ts'",
    "const host = require('@deepseek-ai/dsh-session')",
  ])('rejects an inward runtime leak: %s', text => {
    expect(boundaryFindings([{ file: 'src/task/example.ts', text }]).length).toBeGreaterThan(0)
  })
  it('detects a host leak through an otherwise ordinary core bridge', () => {
    expect(
      boundaryFindings([
        { file: 'src/task/example.ts', text: "export { adapter } from './bridge.ts'" },
        { file: 'src/task/bridge.ts', text: "export { Session as adapter } from '@deepseek-ai/dsh-session'" },
      ]),
    ).toHaveLength(1)
  })
  it('allows explicit host adapters and erased protocol type references', () => {
    expect(
      boundaryFindings([
        { file: 'src/runtime/agent-session.ts', text: "import { SessionId } from '@deepseek-ai/dsh-session'" },
        { file: 'src/control/session-store.ts', text: "import { SessionId } from '@deepseek-ai/dsh-session'" },
        { file: 'src/task/run.ts', text: "import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'" },
      ]),
    ).toEqual([])
  })
  it('keeps domain implementations out of assembly', () => {
    expect(
      boundaryFindings([
        { file: 'assembly/src/example.ts', text: "export * from '../../domain/reference/verifier.mjs'" },
      ]),
    ).toHaveLength(1)
  })
})

describe('core persistence boundary', () => {
  it('allows named filesystem reads and ignores writer words inside comments', () => {
    expect(
      coreWriteFindings([
        { file: 'src/read.ts', text: "import { readFile } from 'node:fs/promises'\n// writeFile createRequire\n" },
      ]),
    ).toEqual([])
  })
  it.each([
    "import { writeFile } from 'node:fs/promises'",
    "export { writeFile } from 'node:fs/promises'",
    "import * as files from 'node:fs'",
    "import { spawn } from 'node:child_process'",
    "const files = await import('node:fs/promises')",
    'const files = await import(selectedModule)',
    "import { createRequire } from 'node:module'",
  ])('rejects the durable-write capability %s', text => {
    expect(coreWriteFindings([{ file: 'src/write.ts', text }]).length).toBeGreaterThan(0)
  })
})

it.each(['src/task/example.ts', 'assembly/src/plugin.ts', 'assembly/client.js', 'assembly/frontend/panel.tsx'])(
  'rejects domain identity literals in %s while allowing domain data loaded through a port',
  file => {
    const domain = {
      criterion: { criterionId: 'controlled-criterion' },
      verifier: { program: 'controlled-verifier.mjs' },
    }
    expect(domainFindings([{ file, text: "const criterion = 'controlled-criterion'" }], [domain])).toHaveLength(1)
    expect(domainFindings([{ file, text: 'const criterion = domain.criterion' }], [domain])).toEqual([])
  },
)

describe('live protocol declarations and their ledger', () => {
  const declared = [{ protocol: 'task', version: 9, kinds: [{ name: 'run/started', members: ['runId'] }] }]
  const ledger = { protocols: [{ ...declared[0], subject: 'task', producedBy: 'scheduler', readBy: 'task view' }] }
  it('accepts the same protocol, version, kinds and member sets', () => {
    expect(inventoryFindingsWith(ledger, declared)).toEqual([])
  })
  it.each([
    { protocols: [] },
    { protocols: [{ ...ledger.protocols[0], version: 8 }] },
    { protocols: [{ ...ledger.protocols[0], kinds: [{ name: 'run/started', members: ['runId', 'unowned'] }] }] },
    { protocols: [{ ...ledger.protocols[0], kinds: [...declared[0]!.kinds, { name: 'run/extra', members: [] }] }] },
  ])('rejects a ledger that differs from the actual declaration', changed => {
    expect(inventoryFindingsWith(changed, declared).length).toBeGreaterThan(0)
  })
})

describe('runnable mutation claims', () => {
  const claim = {
    id: 'valid-rule',
    run: { kind: 'vitest', args: ['tests/contract.spec.ts'] },
    witness: 'rejects an unowned source',
    edits: [{ file: 'src/contract.ts', find: 'original', replace: 'changed' }],
  }
  const textOf = (file: string) => (file.startsWith('tests/') ? 'test source' : 'original')
  it('checks a runnable row without requiring any document to repeat its identity', () => {
    expect(mutationFindings({ commitClaim: claim.id, claims: [claim] }, textOf)).toEqual([])
  })
  it('rejects a stale edit anchor and an unspecific failure witness', () => {
    expect(
      mutationFindings({ commitClaim: claim.id, claims: [{ ...claim, witness: '×' }] }, () => 'anchor has changed'),
    ).toHaveLength(2)
  })
})
