import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findSkillFile, parseSkillFile, readSkillFile } from '../../src/skill-file.ts'

let root: string
let previousHome: string | undefined

function skill(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-file-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dsh-home')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

describe('parseSkillFile', () => {
  test('splits frontmatter from the body and defaults invocation to both surfaces', () => {
    const parsed = parseSkillFile('---\nname: probe\ndescription: "Probe the thing"\n---\n\n# Probe\nbody\n', '/x/SKILL.md')
    expect(parsed.name).toBe('probe')
    expect(parsed.description).toBe('Probe the thing')
    expect(parsed.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(parsed.content).toBe('# Probe\nbody\n')
  })

  test('carries when-to-use and the two invocation switches', () => {
    const parsed = parseSkillFile(
      '---\nname: probe\ndescription: d\nwhen-to-use: when probing\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n',
      '/x/SKILL.md',
    )
    expect(parsed.whenToUse).toBe('when probing')
    expect(parsed.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  })

  test('rejects the shapes it cannot read instead of guessing', () => {
    const cases: readonly (readonly [string, RegExp])[] = [
      ['# no frontmatter\n', /has no YAML frontmatter/],
      ['---\nname: probe\n', /unterminated frontmatter/],
      ['---\nname: probe\n---\nbody\n', /requires "description"/],
      ['---\ndescription: d\n---\nbody\n', /requires "name"/],
      ['---\nname: probe\ndescription: d\nnested:\n  key: value\n---\nbody\n', /nested frontmatter line/],
      ['---\nname: probe\ndescription: d\nuser-invocable: maybe\n---\nbody\n', /non-boolean "user-invocable"/],
    ]
    for (const [text, expected] of cases) {
      expect(() => parseSkillFile(text, '/x/SKILL.md'), text).toThrow(expected)
    }
  })

  // The root's domain reference skill ships at the repository root, where
  // skill-filesystem discovery reads it; this keeps its frontmatter inside the
  // grammar the grant fallback path accepts.
  test('the shipped bb-pipeline skill parses', async () => {
    const file = fileURLToPath(new URL('../../../../../.agents/skills/bb-pipeline/SKILL.md', import.meta.url))
    const parsed = parseSkillFile(await readFile(file, 'utf8'), file)
    expect(parsed.name).toBe('bb-pipeline')
    expect(parsed.description.length).toBeGreaterThan(0)
    expect(parsed.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(parsed.content).toContain('# BB')
  })
})

describe('findSkillFile', () => {
  test('finds a project skill from the worker cwd and from an ancestor directory', async () => {
    skill(join(root, 'checkout', '.agents', 'skills'), 'probe-skill', '---\nname: probe-skill\ndescription: d\n---\nbody\n')
    const nested = join(root, 'checkout', 'src', 'deep')
    mkdirSync(nested, { recursive: true })

    expect(await findSkillFile('probe-skill', join(root, 'checkout'))).toBe(
      join(root, 'checkout', '.agents', 'skills', 'probe-skill', 'SKILL.md'),
    )
    expect(await findSkillFile('probe-skill', nested)).toBe(
      join(root, 'checkout', '.agents', 'skills', 'probe-skill', 'SKILL.md'),
    )
  })

  test('falls back to the deployment skill home and reports nothing when the skill does not exist', async () => {
    skill(join(root, 'dsh-home', 'skills'), 'home-skill', '---\nname: home-skill\ndescription: d\n---\nbody\n')
    expect(await findSkillFile('home-skill', join(root, 'checkout'))).toBe(
      join(root, 'dsh-home', 'skills', 'home-skill', 'SKILL.md'),
    )
    expect(await findSkillFile('no-such-skill-in-this-deployment', join(root, 'checkout'))).toBeUndefined()
  })
})

describe('readSkillFile', () => {
  test('reads a SKILL.md into a runtime registration rooted at its directory', async () => {
    skill(join(root, '.agents', 'skills'), 'probe-skill', '---\nname: probe-skill\ndescription: d\n---\n# Probe\n')
    const file = join(root, '.agents', 'skills', 'probe-skill', 'SKILL.md')
    expect(await readSkillFile(file, 'probe-skill')).toEqual({
      name: 'probe-skill',
      description: 'd',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      path: file,
      resourceBase: { kind: 'directory', path: join(root, '.agents', 'skills', 'probe-skill') },
      content: '# Probe\n',
    })
  })
})
