import { describe, expect, test } from 'vitest'
import type { RunProviderBinding } from '@dangosys/dsh-singularity-task'
import type { RunBindingRead } from '@dangosys/dsh-singularity-task-runtime'
import { renderRunBinding } from '../../src/render/records.ts'

/**
 * The "chosen implementation" text projection (A2, migrated from the task
 * runtime): what a run's binding record reads like to the workers and readers
 * that get it through the contract projection and `task_read`. Identity and
 * purpose, never the body — and a re-check refusal that is named rather than
 * softened.
 */

const hex = (seed: string) => seed.repeat(64)

function binding(overrides: Partial<RunProviderBinding> = {}): RunProviderBinding {
  return {
    registryRevision: hex('a'),
    capabilities: ['design-ball', 'research'],
    skills: [
      {
        name: 'ball-align',
        role: 'knowledge',
        capabilities: ['design-ball'],
        description: 'Align a Buckyball Ball across layers',
        contractDigest: hex('c'),
        contentDigest: hex('d'),
        uncovered: [],
      },
      {
        name: 'verify',
        role: 'execution-provider',
        capabilities: ['research'],
        description: 'Verify a Ball',
        contractDigest: hex('1'),
        contentDigest: hex('2'),
        uncovered: ['notes.md'],
      },
    ],
    mcpServers: [{ serverName: 'bbdev', templateDigest: hex('e') }],
    snapshotRoot: '/dsh/singularity/run-bindings/sg-t-root/r-1/skills',
    ...overrides,
  }
}

describe('renderRunBinding', () => {
  test('names every capability, its provider, the purpose and a short digest — and what is not covered', () => {
    const summary = renderRunBinding(binding())
    expect(summary).toContain('## Implementation chosen for this run')
    expect(summary).toContain(`- registry revision: ${'a'.repeat(12)}`)
    expect(summary).toContain(
      'capability `design-ball` → skill `ball-align` [knowledge] — Align a Buckyball Ball across layers',
    )
    expect(summary).toContain(`(content ${'d'.repeat(12)}, contract ${'c'.repeat(12)})`)
    expect(summary).toContain('capability `research` → skill `verify` [execution-provider] — Verify a Ball')
    expect(summary).toContain('not covered by this binding: notes.md')
    expect(summary).toContain('- MCP servers mounted for this run: `bbdev` (template eeeeeeeeeeee)')
    expect(summary).toContain(`- bound content snapshot: /dsh/singularity/run-bindings/sg-t-root/r-1/skills`)
    expect(summary).toContain('the contract context loads the full Skill instructions from this frozen snapshot before task execution')
  })

  test('names a capability that carries no provider skill instead of leaving it out', () => {
    const summary = renderRunBinding(binding({ skills: [] }))
    expect(summary).toContain(
      "capability `design-ball`: no provider skill — the capability's tools are granted without one",
    )
    expect(summary).toContain('capability `research`: no provider skill')
  })

  test('renders nothing for a run with no binding, and no readability claim for a run nobody re-read', () => {
    expect(renderRunBinding(undefined)).toBe('')
    const withoutRead = renderRunBinding(binding())
    expect(withoutRead).not.toContain('not readable')
  })

  test('renders the re-check refusal by name, pointing at the record and never at the production path', () => {
    const record = binding()
    const read: RunBindingRead = {
      snapshotRoot: record.snapshotRoot!,
      skills: [
        {
          name: 'ball-align',
          role: 'knowledge',
          readable: false,
          defects: ['content-mismatch: SKILL.md is not the bound content'],
        },
      ],
      defects: ['skill "ball-align": content-mismatch: SKILL.md is not the bound content'],
    }
    const refused = renderRunBinding(record, read)
    expect(refused).toContain("Bound content is not readable: the snapshot no longer matches this run's record")
    expect(refused).toContain('- skill "ball-align": content-mismatch: SKILL.md is not the bound content')
    expect(refused).toContain(record.snapshotRoot!)
  })

  test('a binding that names no snapshot says so instead of pointing at a path', () => {
    const summary = renderRunBinding(binding({ snapshotRoot: undefined, skills: [] }))
    expect(summary).not.toContain('bound content snapshot:')
    expect(summary).not.toContain('snapshot path above')
    expect(summary).toContain(
      'this run bound no content snapshot; it cannot supply guidance to a model request',
    )
  })
})
