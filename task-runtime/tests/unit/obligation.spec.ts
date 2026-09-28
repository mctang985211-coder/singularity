import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { TaskSnapshot } from '../../../task/src/types.ts'
import type { ObligationTemplate } from '../../src/obligation.ts'
import {
  checkObligationCoverage,
  findRepoRoot,
  loadObligationTemplates,
  parseObligationTemplates,
} from '../../src/obligation.ts'

function template(overrides: Partial<ObligationTemplate> = {}): ObligationTemplate {
  return {
    id: 'algorithm-correctness',
    question: '算法功能正确性（对 golden 参考）怎么判？',
    evidenceForm: 'bemu 回归批次 exit 0',
    typicalCapabilities: ['run-bemu-regression'],
    ...overrides,
  }
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    version: 1,
    id: 'store',
    tasks: [],
    runs: [],
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [],
    diagnoses: [],
    obligations: [],
    capabilities: {},
    ...overrides,
  }
}

describe('parseObligationTemplates', () => {
  // The shipped template ships at the repository root, next to the bb-pipeline
  // skill that points at it as the canonical obligation template.
  test('the shipped bb-obligations template parses into the seven known obligations', async () => {
    const file = fileURLToPath(new URL('../../../../../.agents/skills/bb-obligations/obligations.yml', import.meta.url))
    const templates = parseObligationTemplates(await readFile(file, 'utf8'), file)
    expect(templates.map(item => item.id)).toEqual([
      'algorithm-correctness',
      'differentiable-reference',
      'mapping-correctness',
      'hardware-equivalence',
      'ball-contract-consistency',
      'ppa-reachability',
      'model-integration',
    ])
    expect(templates.find(item => item.id === 'ppa-reachability')!.typicalCapabilities).toEqual(['measure-ppa'])
  })

  test('parses a JSON-compatible YAML template file', () => {
    const text = JSON.stringify([template(), template({ id: 'ppa-reachability', typicalCapabilities: [] })])
    const parsed = parseObligationTemplates(text, 'obligations.yml')
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.id).toBe('algorithm-correctness')
    expect(parsed[1]!.typicalCapabilities).toEqual([])
  })

  test('refuses malformed files and entries loudly, naming the source', () => {
    expect(() => parseObligationTemplates('not: json', 'a.yml')).toThrow(/a\.yml is not JSON-compatible YAML/)
    expect(() => parseObligationTemplates('{}', 'a.yml')).toThrow(/a\.yml must be an array/)
    expect(() => parseObligationTemplates('[{"id": "x"}]', 'a.yml')).toThrow(/a\.yml entry 0 requires a non-empty "question"/)
    expect(() => parseObligationTemplates('[{"id": "x", "question": "q", "evidenceForm": "e", "typicalCapabilities": [""]}]', 'a.yml'))
      .toThrow(/"typicalCapabilities" must be an array of non-empty strings/)
  })
})

describe('checkObligationCoverage', () => {
  const taskRequesting = (capabilities: string[]) => ({
    taskId: 't1',
    definitionRef: { taskType: 'subtask', version: 1 },
    objective: 'run the regression',
    depth: 1,
    acceptanceCriteria: [],
    requestedCapabilities: capabilities,
    decompositionStatus: 'leaf' as const,
    status: 'verified' as const,
    runIds: [],
    childTaskIds: [],
  })

  test('a capability the graph requested covers the template entry (hit)', () => {
    const coverage = checkObligationCoverage(
      [template()],
      snapshot({ tasks: [taskRequesting(['run-bemu-regression'])] }),
    )
    expect(coverage.uncovered).toEqual([])
    expect(coverage.covered).toEqual([{ template: template(), via: 'capability run-bemu-regression' }])
  })

  test('a template entry no capability and no obligation covers is reported, not blocked (miss)', () => {
    const coverage = checkObligationCoverage(
      [template({ id: 'ppa-reachability', question: 'PPA 可达性怎么判？', typicalCapabilities: [] })],
      snapshot({ tasks: [taskRequesting(['run-bemu-regression'])] }),
    )
    expect(coverage.covered).toEqual([])
    expect(coverage.uncovered.map(item => item.id)).toEqual(['ppa-reachability'])
  })

  test('a recorded obligation naming the entry covers it even with no capable task', () => {
    const ppa = template({ id: 'ppa-reachability', question: 'PPA 可达性怎么判？', typicalCapabilities: [] })
    const coverage = checkObligationCoverage(
      [ppa],
      snapshot({
        obligations: [{
          obligationId: 'o1',
          goal: 'obligation ppa-reachability is unanswered: no EDA capability in this deployment',
          criterion: 'a PPA verdict exists or the gap is escalated',
          sourceTaskId: 't1',
        }],
      }),
    )
    expect(coverage.uncovered).toEqual([])
    expect(coverage.covered[0]!.via).toBe('obligation o1')
  })
})

describe('template discovery on disk', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'obligation-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('findRepoRoot walks up from a nested env root to the directory holding .git', async () => {
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    const env = join(root, 'repo', 'environment', 'project1')
    mkdirSync(env, { recursive: true })
    expect(await findRepoRoot(env)).toBe(join(root, 'repo'))
    // A cap of zero levels checks only the start directory itself.
    expect(await findRepoRoot(join(root, 'nowhere'), 0)).toBeUndefined()
  })

  test('findRepoRoot caps the walk so a detached root never escapes to the filesystem root', async () => {
    // no .git anywhere under root: deeper than the cap and shallower both yield undefined
    const deep = join(root, ...Array.from({ length: 12 }, (_v, index) => `d${index}`))
    mkdirSync(deep, { recursive: true })
    expect(await findRepoRoot(deep)).toBeUndefined()
  })

  test('loadObligationTemplates scans every skill dir, skipping packs without the file', async () => {
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'repo', '.agents', 'skills', 'bb-obligations'), { recursive: true })
    writeFileSync(
      join(root, 'repo', '.agents', 'skills', 'bb-obligations', 'obligations.yml'),
      JSON.stringify([template()]),
    )
    mkdirSync(join(root, 'repo', '.agents', 'skills', 'bb-pipeline'), { recursive: true })

    const files = await loadObligationTemplates(join(root, 'repo'))
    expect(files).toHaveLength(1)
    expect(files[0]!.templates).toEqual([template()])
    expect(files[0]!.file).toContain('bb-obligations')

    // No skills root at all → no templates, no error.
    mkdirSync(join(root, 'bare', '.git'), { recursive: true })
    expect(await loadObligationTemplates(join(root, 'bare'))).toEqual([])
  })

  test('a malformed template file fails the load loudly', async () => {
    mkdirSync(join(root, 'repo', '.agents', 'skills', 'broken'), { recursive: true })
    writeFileSync(join(root, 'repo', '.agents', 'skills', 'broken', 'obligations.yml'), 'not: json')
    await expect(loadObligationTemplates(join(root, 'repo'))).rejects.toThrow(/not JSON-compatible YAML/)
  })
})
