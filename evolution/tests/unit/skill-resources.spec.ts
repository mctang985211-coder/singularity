import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadSkillSidecar } from '@dangosys/dsh-singularity-task-runtime'
import { exec, preparedSkillExperiment, reopenLike, serviceWithProduction, skillProposal, skillText, VERSION_SET, walkToDecided } from './evolution.fixture.ts'

it('replay copies an explicit clean snapshot relative to the caller workspace and freezes its source directory', async () => {
  const w = await preparedSkillExperiment()
  const sourceDir = join(w.workspace, 'clean')
  await mkdir(sourceDir)
  await writeFile(join(sourceDir, 'input.txt'), 'original input\n')
  await writeFile(join(w.workspace, 'old-case.txt'), 'historical answer\n')
  const result = await w.replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'], snapshot: { sourceDir: 'clean' } }, exec('root-1'))
  expect(result).not.toContain('rejected')
  expect((await w.svc.experiments('s1'))[0]!.frozen.snapshot.sourceDir).toBe(sourceDir)
  for (const call of w.replayTask.mock.calls) {
    const workspace = call[2].workspace!.path
    expect(await readFile(join(workspace, 'input.txt'), 'utf8')).toBe('original input\n')
    await expect(readFile(join(workspace, 'old-case.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await rm(w.root, { recursive: true, force: true })
})

it('rejects an invalid Skill before recording a candidate', async () => {
  const { svc } = await serviceWithProduction()
  await svc.propose(skillProposal, 'root-1')
  await expect(svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: '# no metadata' })).rejects.toThrow('frontmatter')
  await expect(svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: '---\nname: wrong\ndescription: x\n---\nbody' })).rejects.toThrow('name')
  expect((await svc.get('s1')).status).toBe('proposed')
})

it('loads a historical invalid prepared candidate as a fact without creating a production commit', async () => {
  const { svc, root, skillRoot } = await serviceWithProduction()
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(join(skillRoot, 'verify', 'SKILL.md'), skillText('valid production'))
  await svc.propose(skillProposal, 'root-1')
  await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('candidate') })
  await svc.prepare('s1', 'root-1')
  const file = join(root, 'proposals.jsonl')
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  records.find(record => record.kind === 'candidate').mutation.content = '# historical candidate without frontmatter'
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const reopened = reopenLike(svc, { root, skillRoot })
  expect((await reopened.get('s1')).status).toBe('prepared')
  expect((await reopened.get('s1')).openIntent).toBeUndefined()
  expect(await reopened.reconcile()).toEqual([])
  expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('valid production'))
  await rm(root, { recursive: true, force: true })
})

it('preserves resources when omitted and publishes and rolls back a complete replacement resource set', async () => {
  const { svc, root, skillRoot } = await serviceWithProduction()
  const directory = join(skillRoot, 'verify')
  await mkdir(join(directory, 'resources'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), skillText('Use resources/feedback.py.'))
  await writeFile(join(directory, 'resources', 'feedback.py'), 'print("baseline")\n')
  await svc.propose({ ...skillProposal, proposalId: 'preserved' }, 'root-1')
  await svc.candidate('preserved', VERSION_SET, 'root-1', { name: 'verify', content: skillText('Keep the feedback Tool.') })
  const preserved = await svc.prepare('preserved', 'root-1')
  expect(preserved.prepared!.skillContent!.resources).toEqual(preserved.prepared!.skillBaseline!.resources)
  expect(await readFile(join(root, 'sandbox', 'preserved', 'skills', 'verify', 'resources', 'feedback.py'), 'utf8')).toContain('baseline')

  await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('Use the new feedback Tool.'), resources: {
    'resources/feedback.py': 'print("candidate")\n',
    'scripts/check.py': 'print("new tool")\n',
  } })
  const applied = await svc.apply('s1', 'root-1', 'approval:test')
  expect(applied.targets).toHaveLength(3)
  expect(await readFile(join(directory, 'resources', 'feedback.py'), 'utf8')).toContain('candidate')
  expect((await loadSkillSidecar(directory)).defects).toEqual([])
  const reopened = reopenLike(svc, { root, skillRoot })
  expect((await reopened.get('s1')).prepared!.skillContent!.resources).toHaveLength(2)
  await svc.rollback('s1', 'root-1', 'approval:rollback')
  expect(await readFile(join(directory, 'resources', 'feedback.py'), 'utf8')).toContain('baseline')
  await expect(readFile(join(directory, 'scripts', 'check.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await loadSkillSidecar(directory)).defects).toEqual([])
  await rm(root, { recursive: true, force: true })
})
