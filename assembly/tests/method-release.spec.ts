import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import type { ApprovalAsk, ApprovalSeams } from '../../src/runtime/approval.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { openApparatus, taskStateOf, type Apparatus } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { createMethod, methodEnvironment, methodOfRun, type MethodAssets } from '../src/method.ts'
import { releaseMethod } from '../src/method-release.ts'
import { propose } from '../src/surfaces.ts'
import { agentFor, attachmentsAt, FakePersistence } from './seam.ts'

const dir = '/home/ROXY/code/singularity-core/deployment/domain/letters'
const cleanup: { root: string; apparatus: Apparatus }[] = []
afterEach(async () => { for (const { root, apparatus } of cleanup.splice(0)) { await apparatus.store.close(); await rm(root, { recursive: true, force: true }) } })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-release-'))
  const domain = await loadDomain(dir, spawnProcess)
  const apparatus = await openApparatus('release-spec', root, domain, new FakePersistence() as unknown as SessionPersistence, attachmentsAt(root))
  cleanup.push({ root, apparatus })
  const declaration = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as { rootTemplate: string; templates: unknown[] }
  const assets: MethodAssets = { ...declaration, skill: 'Use the exact frozen Tool.', tool: "process.stdout.write('35')" }
  const { rootTemplate, templates, skill, tool } = assets
  const method = await createMethod(apparatus, { rootTemplate, templates, skill, tool })
  return { apparatus, method }
}

function approval(outcome: string) {
  const asks: ApprovalAsk[] = []
  let feed: ((session: Session, event: SessionEvent) => void) | undefined
  const seams: ApprovalSeams = {
    feed: { on: (_name, listener) => { feed = listener; return () => { feed = undefined } } },
    approval: { request: async ask => {
      asks.push(ask)
      feed!(ask.agent.session, { type: 'approval/asked', data: { id: 'native-question-1', toolName: ask.toolName, callId: ask.callId } } as SessionEvent)
      return outcome
    } },
  }
  return { seams, asks }
}

it('presents complete bootstrap content through native approval, publishes once, and a new Run pins that Method', async () => {
  const { apparatus, method } = await fixture()
  const { seams, asks } = approval('allowed-once')
  const agent = agentFor('publisher', 'publisher')
  await expect(releaseMethod(apparatus, seams, agent, 'publish-1', { bootstrap: method }, new AbortController().signal))
    .resolves.toEqual({ revision: method, approvalId: 'native-question-1' })
  expect(JSON.parse(asks[0]!.reason!)).toMatchObject({ purpose: 'Bootstrap Method library', revision: method, assets: { skill: 'Use the exact frozen Tool.' } })
  const proposal = await propose(apparatus, { agentId: 'new-agent', sessionId: 'new-session', model: { provider: 'test', model: 'test' } }, 'new-solve', { goal: 'independent solve' })
  const run = taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!
  expect(methodOfRun(apparatus, run)).toEqual(method)
  expect(run.consumed.map(entry => entry.method)).toEqual(['template'])
})

it('leaves an empty library unpublished when native approval rejects the concrete draft', async () => {
  const { apparatus, method } = await fixture()
  const { seams } = approval('rejected')
  await expect(releaseMethod(apparatus, seams, agentFor('publisher', 'publisher'), 'reject-1', { bootstrap: method }, new AbortController().signal))
    .rejects.toThrow('nothing was authorised')
  expect(apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus))?.pointer).toBeUndefined()
})
