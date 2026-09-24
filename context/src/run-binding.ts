/**
 * The "chosen implementation" summary of one run (A2): the text projection of
 * the binding record a run carries, migrated in from the task runtime's
 * `run-binding.ts` — the record, the materialization and the re-check stay
 * there; only the *words* live here, where every other record rendering lives.
 * The contract projection, `task_read` and the run record read all render from
 * this one function, so no two views of a run can describe different content.
 *
 * What it carries: every capability the run matched, the skill selected for it
 * (name, role, purpose, short content digest and — where the skill declares one
 * — the contract digest), the granted MCP servers, the snapshot the run is bound
 * to, and what the binding does *not* cover. What it deliberately leaves out: the
 * skill text. A worker reads the body on demand with the `skill` tool; a summary
 * is identity and purpose.
 * @module @dangosys/dsh-singularity-context/run-binding
 */

import type { RunProviderBinding } from '@dangosys/dsh-singularity-task'
import type { RunBindingRead } from '@dangosys/dsh-singularity-task-runtime'

/** The first 12 hex of a digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest: string): string {
  return digest.slice(0, 12)
}

/**
 * Render one run's binding summary.
 *
 * `read` is the re-check result when the caller re-read the snapshot. A caller
 * that has not read it omits it, and then no readability claim is made in either
 * direction. When it is given and reports defects, they are rendered under a
 * named refusal so a reader is never told to trust content that is not there.
 */
export function renderRunBinding(binding: RunProviderBinding | undefined, read?: RunBindingRead): string {
  if (binding === undefined) return ''
  const lines: string[] = []
  for (const capability of binding.capabilities) {
    const selected = binding.skills.filter(skill => skill.capabilities.includes(capability))
    if (selected.length === 0) {
      lines.push(`- capability \`${capability}\`: no provider skill — the capability's tools are granted without one`)
      continue
    }
    for (const skill of selected) {
      const contract = skill.contractDigest === null ? '' : `, contract ${shortDigest(skill.contractDigest)}`
      const gaps = skill.uncovered.length === 0 ? '' : ` · not covered by this binding: ${skill.uncovered.join(', ')}`
      lines.push(`- capability \`${capability}\` → skill \`${skill.name}\` [${skill.role}] — ${skill.description} (content ${shortDigest(skill.contentDigest)}${contract})${gaps}`)
    }
  }
  if (binding.mcpServers.length > 0) {
    lines.push(`- MCP servers mounted for this run: ${binding.mcpServers.map(server => `\`${server.serverName}\`${server.templateDigest === null ? '' : ` (template ${shortDigest(server.templateDigest)})`}`).join(', ')}`)
  }
  if (lines.length === 0) return ''
  const header = [
    '## Implementation chosen for this run',
    '',
    `- registry revision: ${shortDigest(binding.registryRevision)}`,
    ...lines,
    // The snapshot path is rendered, not described: the views that read this
    // summary act on it, and "the snapshot path above" was a claim none of them
    // could act on. A binding that names no snapshot says so instead.
    ...(binding.snapshotRoot === undefined
      ? [
          '- a skill named here is read with the `skill` tool when you need its body; this run bound no content snapshot, so the revision and digests above are what it resolved against',
        ]
      : [
          `- bound content snapshot: ${binding.snapshotRoot}`,
          '- a skill named here is read with the `skill` tool when you need its body; the revision, digests and snapshot path above are what this run is bound to',
        ]),
  ]
  if (read !== undefined && read.defects.length > 0) {
    // Named, never softened: a reader told this run's content is unavailable
    // must not go looking for a newer version at the production path.
    header.push(
      '',
      'Bound content is not readable: the snapshot no longer matches this run\'s record, and the production skill path is not a substitute for it.',
      ...read.defects.map(defect => `- ${defect}`),
    )
  }
  return header.join('\n')
}
