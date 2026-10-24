import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const { auditSources, auditRequests } = await import(
  fileURLToPath(new URL('../scripts/context-audit.mjs', import.meta.url))
)
it('inventories every effective-context source and measures full requests including tool schemas and consumed pages', async () => {
  expect((await auditSources()).inventory.length).toBeGreaterThanOrEqual(10)
  const request = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'native + role' }] },
      {
        role: 'user',
        source: { kind: 'singularity', purpose: 'dispatch' },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              contract: { goal: 'frozen' },
              method: { workflowGuidance: 'bounded', skills: [] },
              handoff: { decisions: [] },
            }),
          },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: 'actual Skill or authoring page read' }] },
    ],
    tools: [{ name: 'read', parameters: { type: 'object' } }],
  }
  const report = auditRequests({ schemaVersion: 1, kind: 'offline-native-fixture', requests: [request] })
  expect(report.requests[0].messages).toHaveLength(3)
  expect(report.requests[0].dispatchSections.map((s: { component: string }) => s.component)).toEqual([
    'contract',
    'method',
    'handoff',
  ])
  expect(report.requests[0].serializedRequestBytes).toBe(Buffer.byteLength(JSON.stringify(request)))
  request.tools.push(request.tools[0]!)
  expect(() => auditRequests({ schemaVersion: 1, kind: 'offline-native-fixture', requests: [request] })).toThrow(
    'duplicate tool schema',
  )
})
