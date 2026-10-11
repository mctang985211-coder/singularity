import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const { coreWriteFindings, domainFindings, inventoryFindingsWith, mutationFindings }: {
  coreWriteFindings(sources: readonly { file: string; text: string }[]): readonly string[]
  domainFindings(sources: readonly { file: string; text: string }[], declarations: readonly unknown[]): readonly string[]
  inventoryFindingsWith(ledger: unknown, declared: readonly unknown[]): readonly string[]
  mutationFindings(ledger: unknown, textOf: (file: string) => string): readonly string[]
} = await import(fileURLToPath(new URL('../scripts/gates.mjs', import.meta.url)))

describe('core persistence boundary', () => {
  it('allows named filesystem reads and ignores writer words inside comments', () => {
    expect(coreWriteFindings([{ file: 'src/read.ts', text: "import { readFile } from 'node:fs/promises'\n// writeFile createRequire\n" }])).toEqual([])
  })
  it.each([
    "import { writeFile } from 'node:fs/promises'",
    "export { writeFile } from 'node:fs/promises'",
    "import * as files from 'node:fs'",
    "import { spawn } from 'node:child_process'",
    "const files = await import('node:fs/promises')",
    "const files = await import(selectedModule)",
    "import { createRequire } from 'node:module'",
  ])('rejects the durable-write capability %s', text => {
    expect(coreWriteFindings([{ file: 'src/write.ts', text }]).length).toBeGreaterThan(0)
  })
})

it.each(['assembly/src/plugin.ts', 'assembly/client.js', 'assembly/panel.js'])(
  'rejects domain identity literals in %s while allowing domain data loaded through a port', file => {
    const domain = { criterion: { criterionId: 'controlled-criterion' }, verifier: { program: 'controlled-verifier.mjs' } }
    expect(domainFindings([{ file, text: "const criterion = 'controlled-criterion'" }], [domain])).toHaveLength(1)
    expect(domainFindings([{ file, text: 'const criterion = domain.criterion' }], [domain])).toEqual([])
  })

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
  const claim = { id: 'valid-rule', run: { kind: 'vitest', args: ['tests/contract.spec.ts'] },
    witness: 'rejects an unowned source', edits: [{ file: 'src/contract.ts', find: 'original', replace: 'changed' }] }
  const textOf = (file: string) => file.startsWith('tests/') ? 'test source' : 'original'
  it('checks a runnable row without requiring any document to repeat its identity', () => {
    expect(mutationFindings({ commitClaim: claim.id, claims: [claim] }, textOf)).toEqual([])
  })
  it('rejects a stale edit anchor and an unspecific failure witness', () => {
    expect(mutationFindings({ commitClaim: claim.id, claims: [{ ...claim, witness: '×' }] }, () => 'anchor has changed')).toHaveLength(2)
  })
})
