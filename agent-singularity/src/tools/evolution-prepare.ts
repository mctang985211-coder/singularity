import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { message, sessionId, text } from '../shared.ts'

export function defineEvolutionPrepareTool(ctx: Context) {
  return defineTool({
    name: 'evolution_prepare',
    description:
      'Freeze the candidate and its production baseline in the proposal sandbox. A Task candidate freezes both template libraries; ' +
      'a Skill freezes SKILL.md and its existing execution declaration; a capability freezes its whole row, optional MCP launch ' +
      'definitions and optional new execution Skill. No production changes. Next: evolution_replay, then evolution_gate.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Task template, Skill or capability candidate to freeze' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_prepare')
      try {
        const prepared = await ctx.evolution.prepare(args.proposalId, caller)
        const view = prepared.prepared!
        if (view.templateCandidate !== undefined) {
          return [
            `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
            ...view.files.map(file => `  wrote ${file}`),
            `candidate template: ${view.templateCandidate.template.id}@${view.templateCandidate.template.version} sha256:${view.templateCandidate.digest}`,
            view.templateBaseline == null ? 'template baseline: absent' : `template baseline: ${view.templateBaseline.template.id}@${view.templateBaseline.template.version} sha256:${view.templateBaseline.digest}`,
            'sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate',
          ].join('\n')
        }
        if (view.capabilityRow !== undefined) {
          // The A6 arm: one capability row, plus the new execution skill when the
          // candidate carries one. The production baseline this arm compares
          const rowBaseline = view.capabilityBaseline ?? null
          return [
            `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
            ...view.files.map(file => `  wrote ${file}`),
            `candidate row: ${view.capabilityRow.name} sha256:${view.capabilityRow.digest.slice(0, 12)}…`,
            rowBaseline === null
              ? 'registry baseline: the table held no such row, so this candidate adds it'
              : `registry baseline: row sha256:${rowBaseline.digest.slice(0, 12)}… (an apply refuses if the registry row changed since this read)`,
            ...(view.mcpServers === undefined ? [] : [`candidate MCP definitions sha256:${view.mcpServers.digest}: ${JSON.stringify(view.mcpServers.definitions)}`]),
            view.skillContent === undefined
              ? 'candidate object: the row alone — no new skill object is materialized'
              : 'candidate object: a new execution provider (SKILL.md + SKILL.contract.json) the row grants, judged by a registered ' +
                'verifier with resources: []',
            'sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate',
          ].join('\n')
        }
        // The skill arm: the fold admits one prepared shape, a materialized skill
        // prepare that carries both content identities (P2/P3), so the render reads
        const baseline = view.skillBaseline!
        return [
          `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
          ...view.files.map(file => `  wrote ${file}`),
          view.skillContent!.contract === undefined
            ? 'candidate object: guidance (one file, SKILL.md)'
            : 'candidate object: execution provider (SKILL.md + SKILL.contract.json) — the sidecar is derived from production ' +
              'with only content.skillMdSha256 rewritten, so this candidate cannot move a capability, a required tool or a verifier',
          'champion snapshot: captured under champion/',
          `production baseline: ${baseline.name} sha256:${baseline.sha256.slice(0, 12)}… (an apply refuses if the production ` +
            'object changed since this read)',
          'sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate',
        ].join('\n')
      } catch (error) {
        return `evolution_prepare rejected: ${message(error)}`
      }
    },
  })
}
