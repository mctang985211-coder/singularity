/**
 * A deployment-shaped `config.yml` for the tests that exercise the capability
 * table's own text (A6): two YAML documents, exactly as the harness keeps them —
 * the profile patch list (whose `task-runtime` entry carries the capability
 * table) and the `api:` block beside it.
 *
 * Why a fixture rather than a string literal in each spec: the write an apply
 * performs is a *surgical* edit of one row inside the first document, and the
 * facts a case asserts on are (a) the row reads back as the applied row, (b)
 * every other byte — comments, key order, the second document with its key —
 * is exactly what it was. A fixture that keeps a comment and a credential in
 * the file is what makes both checkable.
 * @module tests/support/capability-config
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CapabilityConfig } from '../../task-runtime/src/index.ts'

/** The one line of the second document a case checks was left alone — never printed by production code. */
export const FIXTURE_API_KEY = 'sk-fixture-do-not-print-me'

/** One capability row, rendered the way the deployment's own file spells it (a YAML flow mapping). */
function rowLine(name: string, entry: CapabilityConfig): string {
  const parts: string[] = [`skills: [${(entry.skills ?? []).join(', ')}]`]
  if (entry.tools !== undefined) parts.push(`tools: [${entry.tools.join(', ')}]`)
  if (entry.preset !== undefined) parts.push(`preset: ${entry.preset}`)
  if (entry.permission !== undefined) parts.push(`permission: ${entry.permission}`)
  if (entry.mcpServers !== undefined) parts.push(`mcpServers: [${entry.mcpServers.join(', ')}]`)
  return `      ${name}: { ${parts.join(', ')} }`
}

/**
 * Write the fixture file and answer its path. The optional extra rows let a case
 * fix the table a row is inserted beside; the `api:` block is always there, so
 * "the second document was not touched" is a fact every case can assert.
 */
export async function writeCapabilityConfig(
  file: string,
  rows: Readonly<Record<string, CapabilityConfig>> = {},
): Promise<string> {
  await mkdir(dirname(file), { recursive: true })
  const text = [
    '# A deployment profile patch list, as the harness keeps it.',
    '- id: github-bot',
    '  config:',
    '    orgs: {}',
    '',
    '- id: task-runtime',
    '  config:',
    '    # capability name → skills / tool labels / agent preset / MCP servers',
    '    capabilities:',
    ...Object.entries(rows).map(([name, entry]) => rowLine(name, entry)),
    '    defaultPreset: standard',
    '',
    '- id: tool-session-query',
    '  config:',
    '    openAt: never',
    '',
    '---',
    '',
    '# The gateway facts, where a deployment keeps its key.',
    'api:',
    '  baseUrl: https://example.invalid/v1',
    '  key: ' + FIXTURE_API_KEY,
    '',
  ].join('\n')
  await writeFile(file, text, 'utf8')
  return file
}
