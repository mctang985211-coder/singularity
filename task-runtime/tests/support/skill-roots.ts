/**
 * Pin the skill roots a provider pre-check searches outside a worker's checkout.
 *
 * Since S1-C admission discovers every granted skill from the worker's own
 * viewpoint, a test that admits a capability row naming a skill would otherwise
 * depend on whatever the machine running the suite happens to have under
 * `$DSH_HOME/skills` or `~/.agents/skills` — a passing suite on one developer's
 * laptop and a refused batch on CI. {@link pinSkillHome} moves both roots inside
 * the test's own tmp fixture, so the only skills discovery can reach are the
 * ones the test installed.
 *
 * The installed skills carry their `SKILL.md` alone: a guidance skill, which is
 * loadable and claims no execution verifier, so a test that is about a grant, a
 * record or a cascade does not also have to satisfy a sidecar's tool and
 * verifier rules.
 * @module tests/support/skill-roots
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

const FIXTURE_SKILLS = fileURLToPath(new URL('../fixtures/skills/', import.meta.url))

const homes: string[] = []

/** Explicit Task method selected by ordinary execution fixtures. Negative guidance cases omit it. */
export const TASK_GUIDANCE = { 'execute-task': { skills: ['task-execution'] } }

/**
 * Point `$DSH_HOME` and `$HOME` at a fresh tmp directory holding one guidance
 * skill per name: a fixture copy when one exists, a minimal `SKILL.md`
 * otherwise (most skill names are deployment skills with no fixture, and this
 * helper is about *discoverability*, not about content identity).
 * @param skills - skill names to install under `<home>/skills/<name>/SKILL.md`.
 * @returns the pinned home, in case a test wants to assert on the roots.
 */
export function pinSkillHome(...skills: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'singularity-skill-home-'))
  homes.push(home)
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
  for (const name of skills) {
    const directory = join(home, 'skills', name)
    mkdirSync(directory, { recursive: true })
    const fixture = join(FIXTURE_SKILLS, name, 'SKILL.md')
    if (existsSync(fixture)) copyFileSync(fixture, join(directory, 'SKILL.md'))
    else
      writeFileSync(
        join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: reference skill for one test\n---\n\n# ${name}\n`,
      )
  }
  return home
}

/** Undo {@link pinSkillHome}: unstub the environment and remove every pinned home. */
export function releaseSkillHomes(): void {
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}
