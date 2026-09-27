import { describe, expect, test } from 'vitest'
import {
  SKILL_CONTRACT_VERSION,
  SKILL_SIDECAR_FILE,
  SUPPORTED_SKILL_RESOURCE_DIRS,
  isSupportedSkillResourcePath,
  serializeSkillSidecar,
  sidecarWithSkillMd,
  skillContentDigest,
  skillContractDefects,
  skillContractDigest,
} from '../../src/skill-contract.ts'
import type {
  ExecutionSkillSidecar,
  KnowledgeSkillSidecar,
  SkillContractDefect,
  SkillSidecar,
} from '../../src/skill-contract.ts'

/**
 * The fixed vector's canonical text is written out below and its SHA-256 was
 * computed outside this repository (`sha256sum` over that exact byte sequence),
 * so a change in the serialization or in the sidecar's closed field set shows up
 * here instead of being confirmed by the implementation against itself.
 */
const EXECUTION_CANONICAL = [
  '{"capabilities":["verify-ball-functional"],',
  '"content":{"resources":[{"path":"references/a.md","sha256":"2222222222222222222222222222222222222222222222222222222222222222"}],',
  '"skillMdSha256":"1111111111111111111111111111111111111111111111111111111111111111"},',
  '"contractVersion":1,',
  '"inputs":[{"description":"the Ball under test","name":"ball","required":true}],',
  '"outputs":[],',
  '"precondition":"the bbdev MCP server is loaded",',
  '"requiredTools":["bash","read"],',
  '"type":"execution",',
  '"verifier":{"ref":"command"}}',
].join('')
const EXECUTION_SHA256 = 'a5ceee1b8e59556a1575044bebcb788ff255c4d452978075500ca85f4117d1e3'

const DIGEST_A = '1111111111111111111111111111111111111111111111111111111111111111'
const DIGEST_B = '2222222222222222222222222222222222222222222222222222222222222222'

function execution(overrides: Partial<ExecutionSkillSidecar> = {}): ExecutionSkillSidecar {
  return {
    contractVersion: 1,
    type: 'execution',
    capabilities: ['verify-ball-functional'],
    precondition: 'the bbdev MCP server is loaded',
    inputs: [{ name: 'ball', description: 'the Ball under test', required: true }],
    outputs: [],
    requiredTools: ['bash', 'read'],
    verifier: { ref: 'command' },
    content: { skillMdSha256: DIGEST_A, resources: [{ path: 'references/a.md', sha256: DIGEST_B }] },
    ...overrides,
  }
}

function knowledge(overrides: Partial<KnowledgeSkillSidecar> = {}): KnowledgeSkillSidecar {
  return {
    contractVersion: 1,
    type: 'knowledge',
    source: 'the ball development guide',
    scope: 'Ball-level alignment only',
    content: { skillMdSha256: DIGEST_A, resources: [] },
    contentCheck: { kind: 'command', command: 'grep -q Gold SKILL.md' },
    ...overrides,
  }
}

/** The readable reasons of a refusal, which is what a caller reports. */
function reasons(defects: readonly SkillContractDefect[]): string[] {
  return defects.map(defect => defect.reason)
}

describe('skill sidecar vocabulary', () => {
  test('the sidecar file name, contract version and supported resource positions are fixed', () => {
    expect(SKILL_SIDECAR_FILE).toBe('SKILL.contract.json')
    expect(SKILL_CONTRACT_VERSION).toBe(1)
    expect(SUPPORTED_SKILL_RESOURCE_DIRS).toEqual(['references', 'scripts'])
  })

  test('supported resource paths are one `<dir>/<file>` level under a known directory', () => {
    expect(isSupportedSkillResourcePath('references/a.md')).toBe(true)
    expect(isSupportedSkillResourcePath('scripts/run_bemu.sh')).toBe(true)
    expect(isSupportedSkillResourcePath('references/nested/a.md')).toBe(false)
    expect(isSupportedSkillResourcePath('docs/a.md')).toBe(false)
    expect(isSupportedSkillResourcePath('references')).toBe(false)
    expect(isSupportedSkillResourcePath('a.md')).toBe(false)
    expect(isSupportedSkillResourcePath('/references/a.md')).toBe(false)
    expect(isSupportedSkillResourcePath('references/../a.md')).toBe(false)
    expect(isSupportedSkillResourcePath('references/a/b.md')).toBe(false)
    expect(isSupportedSkillResourcePath('references\\a.md')).toBe(false)
    expect(isSupportedSkillResourcePath('references/')).toBe(false)
  })
})

describe('skillContractDefects', () => {
  test('a well-formed execution sidecar and a well-formed knowledge sidecar have no defects', () => {
    expect(skillContractDefects(execution())).toEqual([])
    expect(skillContractDefects(knowledge())).toEqual([])
  })

  test('the kind of problem is named: unknown version, unknown field, shape', () => {
    expect(skillContractDefects(execution({ contractVersion: 2 as never })).map(defect => defect.code))
      .toEqual(['sidecar-unknown-version'])
    expect(skillContractDefects({ ...execution(), effort: 'high' }).map(defect => defect.code))
      .toEqual(['sidecar-unknown-field'])
    expect(skillContractDefects(execution({ precondition: '' })).map(defect => defect.code))
      .toEqual(['sidecar-shape'])
  })

  test('text fields are accepted verbatim and only checked for blankness', () => {
    expect(skillContractDefects(execution({ precondition: '  the server is loaded\n' }))).toEqual([])
    expect(reasons(skillContractDefects(execution({ precondition: '   \n' })))).toEqual([
      'sidecar.precondition must be a non-blank string',
    ])
    expect(reasons(skillContractDefects(execution({ precondition: 7 as never })))).toEqual([
      'sidecar.precondition must be a non-blank string',
    ])
  })

  test('a value that is not an object is refused before any field is read', () => {
    expect(reasons(skillContractDefects(null))).toEqual(['the sidecar must be a JSON object, got null'])
    expect(reasons(skillContractDefects([]))).toEqual(['the sidecar must be a JSON object, got an array'])
    expect(reasons(skillContractDefects('{}'))).toEqual(['the sidecar must be a JSON object, got string'])
  })

  test('an unknown contract version is refused by number, a missing one by name', () => {
    expect(reasons(skillContractDefects(execution({ contractVersion: 2 as never })))).toEqual([
      'sidecar.contractVersion 2 is not a version this build reads (1)',
    ])
    expect(reasons(skillContractDefects({ type: 'execution' }))[0])
      .toBe('sidecar.contractVersion is missing; this build reads and writes version 1')
  })

  test('an unknown type is refused with the vocabulary named', () => {
    expect(reasons(skillContractDefects({ contractVersion: 1, type: 'docs' }))).toEqual([
      'sidecar.type "docs" is not one of execution, knowledge',
    ])
  })

  test('every required field of a declared type is required, not defaulted', () => {
    expect(reasons(skillContractDefects({ contractVersion: 1, type: 'execution' }))).toEqual([
      'sidecar.capabilities must be a non-empty array of capability names',
      'sidecar.precondition must be a non-blank string',
      'sidecar.inputs must be an array of ports',
      'sidecar.outputs must be an array of ports',
      'sidecar.requiredTools must be an array of tool names',
      'sidecar.verifier must be an object carrying a ref',
      'sidecar.content must be an object carrying skillMdSha256 and resources',
    ])
    expect(reasons(skillContractDefects({ contractVersion: 1, type: 'knowledge' }))).toEqual([
      'sidecar.source must be a non-blank string',
      'sidecar.scope must be a non-blank string',
      'sidecar.content must be an object carrying skillMdSha256 and resources',
      'sidecar.contentCheck must be an object carrying kind and command',
    ])
  })

  test('a field outside the declared set is refused by name, per type', () => {
    expect(reasons(skillContractDefects({ ...execution(), verifierRef: 'command' }))).toEqual([
      'sidecar declares unknown field "verifierRef"; an execution sidecar carries contractVersion, type, capabilities, precondition, inputs, outputs, requiredTools, verifier, content',
    ])
    expect(reasons(skillContractDefects({ ...knowledge(), verifier: { ref: 'command' } }))).toEqual([
      'sidecar declares unknown field "verifier"; a knowledge sidecar carries contractVersion, type, source, scope, content, contentCheck',
    ])
  })

  test('capability names must be a non-empty, unique list of non-blank names', () => {
    expect(reasons(skillContractDefects(execution({ capabilities: [] })))).toEqual([
      'sidecar.capabilities must be a non-empty array of capability names',
    ])
    expect(reasons(skillContractDefects(execution({ capabilities: ['a', 'a'] })))).toEqual([
      'sidecar.capabilities[1] duplicates "a"',
    ])
    expect(reasons(skillContractDefects(execution({ capabilities: ['a', ' '] })))).toEqual([
      'sidecar.capabilities[1] must be a non-blank string',
    ])
  })

  test('required tools are a unique list of non-blank names, empty when nothing extra is needed', () => {
    expect(skillContractDefects(execution({ requiredTools: [] }))).toEqual([])
    expect(reasons(skillContractDefects(execution({ requiredTools: ['bash', 'bash'] })))).toEqual([
      'sidecar.requiredTools[1] duplicates "bash"',
    ])
    expect(reasons(skillContractDefects(execution({ requiredTools: 'bash' as never })))).toEqual([
      'sidecar.requiredTools must be an array of tool names',
    ])
  })

  test('the verifier reference is a closed object with one non-blank ref', () => {
    expect(reasons(skillContractDefects(execution({ verifier: { ref: ' ' } })))).toEqual([
      'sidecar.verifier.ref must be a non-blank string',
    ])
    expect(reasons(skillContractDefects(execution({ verifier: { ref: 'command', version: '1' } as never })))).toEqual([
      'sidecar.verifier declares unknown field "version"; a verifier reference carries ref',
    ])
    expect(reasons(skillContractDefects(execution({ verifier: undefined as never })))).toEqual([
      'sidecar.verifier must be an object carrying a ref',
    ])
  })

  test('ports are closed objects, and one list cannot name a port twice', () => {
    expect(reasons(skillContractDefects(execution({
      inputs: [{ name: 'ball', description: 'the Ball', required: true, type: 'string' } as never],
    })))).toEqual([
      'sidecar.inputs[0] declares unknown field "type"; a port carries name, description, required',
    ])
    expect(reasons(skillContractDefects(execution({
      inputs: [{ name: 'ball', description: 'the Ball', required: 'yes' } as never],
    })))).toEqual([
      'sidecar.inputs[0].required must be a boolean',
    ])
    expect(reasons(skillContractDefects(execution({
      outputs: [
        { name: 'log', description: 'a log', required: true },
        { name: 'log', description: 'another log', required: false },
      ],
    })))).toEqual([
      'sidecar.outputs[1] duplicates port "log"',
    ])
    expect(reasons(skillContractDefects(execution({ inputs: 'ball' as never })))).toEqual([
      'sidecar.inputs must be an array of ports',
    ])
  })

  test('the content identity needs both digests in their exact form', () => {
    expect(reasons(skillContractDefects(execution({
      content: { skillMdSha256: 'ABC', resources: [] },
    })))).toEqual([
      'sidecar.content.skillMdSha256 must be a lowercase 64-character hex digest',
    ])
    expect(reasons(skillContractDefects(execution({
      content: { skillMdSha256: DIGEST_A, resources: [{ path: 'references/a.md', sha256: 'zz' }] },
    })))).toEqual([
      'sidecar.content.resources[0].sha256 must be a lowercase 64-character hex digest',
    ])
    expect(reasons(skillContractDefects(execution({
      content: { skillMdSha256: DIGEST_A, resources: [{ path: 'docs/a.md', sha256: DIGEST_B }] },
    })))).toEqual([
      'sidecar.content.resources[0].path "docs/a.md" is not a supported resource path (references/<file> or scripts/<file>)',
    ])
    expect(reasons(skillContractDefects(execution({
      content: { skillMdSha256: DIGEST_A, resources: [{ path: 'references/a.md', sha256: DIGEST_B, size: 4 } as never] },
    })))).toEqual([
      'sidecar.content.resources[0] declares unknown field "size"; a resource identity carries path, sha256',
    ])
  })

  test('the resource list is sorted by path and names each file once', () => {
    expect(reasons(skillContractDefects(execution({
      content: {
        skillMdSha256: DIGEST_A,
        resources: [
          { path: 'references/b.md', sha256: DIGEST_B },
          { path: 'references/a.md', sha256: DIGEST_B },
        ],
      },
    })))).toEqual([
      'sidecar.content.resources[1] path "references/a.md" precedes "references/b.md"; the list must be sorted by path',
    ])
    expect(reasons(skillContractDefects(execution({
      content: {
        skillMdSha256: DIGEST_A,
        resources: [
          { path: 'scripts/x.sh', sha256: DIGEST_B },
          { path: 'scripts/x.sh', sha256: DIGEST_B },
        ],
      },
    })))).toEqual([
      'sidecar.content.resources[1] duplicates "scripts/x.sh"',
    ])
  })

  test('a knowledge sidecar carries source, scope and a recognized content check', () => {
    expect(reasons(skillContractDefects(knowledge({ source: ' ' })))).toEqual([
      'sidecar.source must be a non-blank string',
    ])
    expect(reasons(skillContractDefects(knowledge({ scope: undefined as never })))).toEqual([
      'sidecar.scope must be a non-blank string',
    ])
    expect(reasons(skillContractDefects(knowledge({ contentCheck: { kind: 'script', command: 'x' } as never })))).toEqual([
      'sidecar.contentCheck.kind "script" is not one of command',
    ])
    expect(reasons(skillContractDefects(knowledge({ contentCheck: { kind: 'command', command: ' ' } })))).toEqual([
      'sidecar.contentCheck.command must be a non-blank string',
    ])
    expect(reasons(skillContractDefects(knowledge({ contentCheck: { kind: 'command', command: 'x', timeoutMs: 5 } as never })))).toEqual([
      'sidecar.contentCheck declares unknown field "timeoutMs"; a content check carries kind, command',
    ])
  })

  test('every defect of one sidecar is reported, not only the first', () => {
    expect(reasons(skillContractDefects({
      contractVersion: 3,
      type: 'execution',
      capabilities: [],
      precondition: '',
      inputs: [],
      outputs: [],
      requiredTools: [],
      verifier: { ref: '' },
      content: { skillMdSha256: 'nope', resources: [] },
    }))).toEqual([
      'sidecar.contractVersion 3 is not a version this build reads (1)',
      'sidecar.capabilities must be a non-empty array of capability names',
      'sidecar.precondition must be a non-blank string',
      'sidecar.verifier.ref must be a non-blank string',
      'sidecar.content.skillMdSha256 must be a lowercase 64-character hex digest',
    ])
  })

  test('the union discriminates on type, so a knowledge sidecar is not judged by execution rules', () => {
    const sidecar: SkillSidecar = knowledge()
    expect(sidecar.type).toBe('knowledge')
    expect(skillContractDefects(sidecar)).toEqual([])
  })
})

describe('skill sidecar identity', () => {
  test('the contract digest covers the canonical sidecar text (fixed vector)', () => {
    expect(skillContractDigest(execution())).toBe(EXECUTION_SHA256)
    expect(EXECUTION_CANONICAL).toContain('"type":"execution"')
  })

  test('the digest ignores key order but not content', () => {
    const reordered = {
      content: execution().content,
      verifier: { ref: 'command' },
      requiredTools: ['bash', 'read'],
      outputs: [],
      inputs: [{ name: 'ball', description: 'the Ball under test', required: true }],
      precondition: 'the bbdev MCP server is loaded',
      capabilities: ['verify-ball-functional'],
      type: 'execution',
      contractVersion: 1,
    } as ExecutionSkillSidecar
    expect(skillContractDigest(reordered)).toBe(EXECUTION_SHA256)
    expect(skillContractDigest(execution({ requiredTools: ['bash', 'read', 'job_output'] }))).not.toBe(EXECUTION_SHA256)
    expect(skillContractDigest(execution({
      content: { skillMdSha256: DIGEST_B, resources: [] },
    }))).not.toBe(EXECUTION_SHA256)
  })

  test('the content digest describes exactly the bytes the identity names', () => {
    expect(skillContentDigest({ skillMdSha256: DIGEST_A, resources: [] }))
      .toBe(skillContentDigest({ skillMdSha256: DIGEST_A, resources: [] }))
    expect(skillContentDigest({ skillMdSha256: DIGEST_A, resources: [] }))
      .not.toBe(skillContentDigest({
        skillMdSha256: DIGEST_A,
        resources: [{ path: 'references/a.md', sha256: DIGEST_B }],
      }))
  })
})

describe('skill sidecar rewriting and serialization (K3)', () => {
  test('sidecarWithSkillMd replaces exactly content.skillMdSha256 and keeps every other field', () => {
    const original = execution()
    const rewritten = sidecarWithSkillMd(original, DIGEST_B)
    expect(rewritten).toEqual({
      ...original,
      content: { skillMdSha256: DIGEST_B, resources: original.content.resources },
    })
    // Field by field, not just shape: capabilities, verifier, tools and ports
    // survive a content update untouched, so the rewrite can never escalate a
    // declaration while the bytes change.
    expect(rewritten.content.resources).toEqual(original.content.resources)
    expect(rewritten.type).toBe('execution')
    const rewrittenExecution = rewritten as ExecutionSkillSidecar
    expect(rewrittenExecution.capabilities).toEqual(original.capabilities)
    expect(rewrittenExecution.requiredTools).toEqual(original.requiredTools)
    expect(rewrittenExecution.verifier).toEqual(original.verifier)
    expect(rewrittenExecution.inputs).toEqual(original.inputs)
    // The original object is not mutated.
    expect(original.content.skillMdSha256).toBe(DIGEST_A)

    const knowledgeRewritten = sidecarWithSkillMd(knowledge(), DIGEST_B)
    expect(knowledgeRewritten).toEqual({
      ...knowledge(),
      content: { skillMdSha256: DIGEST_B, resources: [] },
    })
    expect(knowledgeRewritten.type).toBe('knowledge')
  })

  test('sidecarWithSkillMd refuses a digest that is not a lowercase 64-character hex sha256', () => {
    for (const bad of ['', 'nope', EXECUTION_SHA256.toUpperCase(), DIGEST_A.slice(0, 63), `${DIGEST_A}0`]) {
      expect(() => sidecarWithSkillMd(execution(), bad)).toThrow(/skillMdSha256/)
    }
  })

  test('serializeSkillSidecar is deterministic: one object is always one byte sequence', () => {
    const first = serializeSkillSidecar(execution())
    const second = serializeSkillSidecar(execution())
    expect(first).toBe(second)
    expect(first.endsWith('\n')).toBe(true)
    expect(first).toBe(`${JSON.stringify(JSON.parse(first), null, 2)}\n`)
    // Key order in memory does not move the bytes: the serialization is the
    // canonical key order, not the insertion order.
    const reordered = {
      verifier: execution().verifier,
      content: execution().content,
      requiredTools: execution().requiredTools,
      outputs: [],
      inputs: execution().inputs,
      precondition: execution().precondition,
      capabilities: execution().capabilities,
      type: 'execution',
      contractVersion: 1,
    } as ExecutionSkillSidecar
    expect(serializeSkillSidecar(reordered)).toBe(first)
    // The bytes parse back to the same declaration, and its digest is the
    // sidecar's canonical identity.
    const parsed = JSON.parse(first) as SkillSidecar
    expect(parsed).toEqual(execution())
    expect(skillContractDigest(parsed)).toBe(skillContractDigest(execution()))
    // A different declaration is a different byte sequence.
    expect(serializeSkillSidecar(execution({ requiredTools: ['bash', 'read', 'job_output'] }))).not.toBe(first)
    expect(serializeSkillSidecar(sidecarWithSkillMd(execution(), DIGEST_B))).not.toBe(first)
    expect(serializeSkillSidecar(knowledge()).startsWith('{\n  "content"')).toBe(true)
  })
})
