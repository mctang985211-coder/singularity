import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { message, sessionId, text } from '../shared.ts'

export function defineEvolutionCandidateTool(ctx: Context) {
  return defineTool({
    name: 'evolution_candidate',
    description:
      'Record one candidate as mutationJson (a JSON string). task_definition: {template:<complete canonical TaskTemplate>,criterionRepair?:' +
      '{positive:{taskId,sourceDir,parameters},negative:{taskId,sourceDir,parameters}}}; changed child criteria need both fixed ' +
      'examples under the original independent parent oracle. Skill: {name,content:<whole SKILL.md>}. Capability: ' +
      '{rows:{<name>:<whole row>},mcpServers?:{<id>:{serverName,description,command,args?,env?,cwd?,toolCallTimeoutMs?}},skill?:' +
      '{name,content,sidecar:{precondition,inputs,outputs,requiredTools,verifier:{ref}}}}. A row may grant skills, native tool ' +
      'labels or MCP ids and need not contain a Skill. New definitions must be granted by that row; use their serverName in ' +
      'mcp__<serverName>__<tool> names. Native tools must already be authorized; existing permission and preset stay fixed. ' +
      'New Skill sidecar contractVersion, type, capabilities, content hashes and resources are derived by this tool. No ' +
      'production changes. Next: evolution_prepare, evolution_replay, evolution_gate.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Proposal to move into candidate' },
      versionSet: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'Complete version set the candidate aligns to: name → version string, at least one entry',
      },
      mutationJson: {
        type: 'string',
        required: true,
        description:
          'JSON text of one complete Task template, Skill or capability mutation as described above. ' +
          'If skill is present, its sidecar is an object, not quoted JSON; supply only precondition, inputs, outputs, requiredTools and verifier:{ref}.',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_candidate')
      const versions = args.versionSet as Record<string, unknown>
      try {
        const mutation = JSON.parse(args.mutationJson) as unknown
        if (mutation === null || typeof mutation !== 'object' || Array.isArray(mutation)) {
          throw new Error('mutationJson must contain a JSON object')
        }
        const candidate = mutation as Record<string, unknown>
        if (candidate.skill !== undefined) {
          const skill = candidate.skill as Record<string, unknown>
          if (skill === null || typeof skill !== 'object' || Array.isArray(skill)
            || typeof skill.content !== 'string') {
            throw new Error('mutationJson.skill must carry the whole SKILL.md content')
          }
          const sidecar = skill.sidecar as Record<string, unknown>
          if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
            throw new Error('mutationJson.skill.sidecar must be an object')
          }
          for (const key of Object.keys(sidecar)) {
            if (!['precondition', 'inputs', 'outputs', 'requiredTools', 'verifier'].includes(key)) {
              throw new Error(`mutationJson.skill.sidecar.${key} is not an authorable field`)
            }
          }
          const rows = candidate.rows
          if (rows === null || typeof rows !== 'object' || Array.isArray(rows)
            || Object.keys(rows).length !== 1) {
            throw new Error('mutationJson.rows must hold exactly one capability row')
          }
          skill.sidecar = {
            contractVersion: 1,
            type: 'execution',
            capabilities: Object.keys(rows),
            ...sidecar,
            content: { skillMdSha256: createHash('sha256').update(skill.content).digest('hex'), resources: [] },
          }
        }
        const proposal = await ctx.evolution.candidate(
          args.proposalId,
          versions as Record<string, string>,
          caller,
          candidate,
        )
        const versionsText = Object.entries(proposal.versionSet!).map(([key, value]) => `${key}=${value}`).join(', ')
        return [
          `proposal ${proposal.proposalId} [candidate] version set: ${versionsText}`,
          'ledger entry only — no branch created, nothing executed; mutation recorded — next: evolution_prepare (sandbox ' +
          'materialization), then evolution_replay (the two-sided experiment), then evolution_gate',
        ].join('\n')
      } catch (error) {
        return `evolution_candidate rejected: ${message(error)}`
      }
    },
  })
}
