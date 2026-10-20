import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buckyballTaskInput, checkBuckyballTrial, freezeBuckyballSource, parseBuckyballChangeSet, prepareBuckyballTrial, verifyBuckyballChangeSet, type BuckyballPatchPolicy, type BuckyballVerificationInput } from '../src/buckyball.ts'
import { sha256 } from '../src/ids.ts'
import { loadDomain } from '../src/domain.ts'
import { runVerifierSelftest } from '../../src/verifier/implementation.ts'
import { spawnProcess } from '../src/process.ts'

const execFile = promisify(execFileCallback), roots: string[] = []
const policy: BuckyballPatchPolicy = { allowed: ['arch'], protected: ['arch/oracle.mjs'] }
const patch = 'diff --git a/arch/source.c b/arch/source.c\n--- a/arch/source.c\n+++ b/arch/source.c\n@@ -1 +1 @@\n-return 0;\n+return 1;\n'
const git = async (root: string, ...args: string[]) => (await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args])).stdout.trim()
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buckyball-spec-'))
  roots.push(root)
  const repository = join(root, 'source')
  await mkdir(join(repository, 'arch'), { recursive: true })
  await writeFile(join(repository, 'arch/source.c'), 'return 0;\n')
  await writeFile(join(repository, 'arch/oracle.mjs'), 'protected oracle\n')
  await git(repository, 'init', '--quiet')
  await git(repository, 'add', '.')
  await git(repository, 'commit', '--quiet', '-m', 'fixture')
  const frozen = await freezeBuckyballSource(repository, 'HEAD')
  const change = { baseCommit: frozen.baseCommit, inputTreeDigest: frozen.inputTreeDigest, patch }
  return { root, repository, frozen, change }
}

describe('frozen Buckyball text changes', () => {
  it('exports the exact committed baseline into independent trials and never copies dirty state or generated files', async () => {
    const { root, repository, frozen, change } = await fixture()
    await writeFile(join(repository, 'arch/source.c'), 'author work in progress\n')
    await writeFile(join(repository, 'arch/generated.bin'), 'untracked generated output')
    const trials = [join(root, 'trial-a'), join(root, 'trial-b')]
    await Promise.all(trials.map(trial => prepareBuckyballTrial(repository, frozen, change, policy, trial)))
    expect(await readFile(join(repository, 'arch/source.c'), 'utf8')).toBe('author work in progress\n')
    for (const trial of trials) {
      expect(await readFile(join(trial, 'arch/source.c'), 'utf8')).toBe('return 1;\n')
      await expect(readFile(join(trial, 'arch/generated.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await writeFile(join(trials[0]!, 'arch/source.c'), 'trial-a-only\n')
    expect(await readFile(join(trials[1]!, 'arch/source.c'), 'utf8')).toBe('return 1;\n')
  })

  it('freezes pinned submodule content rather than its current worktree', async () => {
    const { root, repository } = await fixture()
    const module = join(root, 'module')
    await mkdir(module)
    await git(module, 'init', '--quiet')
    await writeFile(join(module, 'component.c'), 'pinned\n')
    await git(module, 'add', '.')
    await git(module, 'commit', '--quiet', '-m', 'module')
    await git(repository, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', module, 'vendor/component')
    await git(repository, 'commit', '--quiet', '-am', 'pin module')
    const frozen = await freezeBuckyballSource(repository, 'HEAD')
    expect(frozen.repositories).toHaveLength(2)
    await writeFile(join(repository, 'vendor/component/component.c'), 'dirty module\n')
    await prepareBuckyballTrial(repository, frozen, { baseCommit: frozen.baseCommit, inputTreeDigest: frozen.inputTreeDigest, patch }, policy, join(root, 'trial'))
    expect(await readFile(join(root, 'trial/vendor/component/component.c'), 'utf8')).toBe('pinned\n')
  })

  it('refuses missing submodules rather than silently archiving the parent repository', async () => {
    const { root, repository, frozen } = await fixture()
    await mkdir(join(repository, 'missing'))
    await git(repository, 'update-index', '--add', '--cacheinfo', `160000,${frozen.baseCommit},missing`)
    await git(repository, 'commit', '--quiet', '-m', 'missing module')
    await expect(freezeBuckyballSource(repository, 'HEAD')).rejects.toThrow('Missing pinned submodule')
    await expect(readFile(join(root, 'trial'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires the exact frozen source and refuses an existing trial', async () => {
    const { root, repository, frozen, change } = await fixture(), trial = join(root, 'trial')
    await expect(prepareBuckyballTrial(repository, frozen, { ...change, inputTreeDigest: '0'.repeat(64) }, policy, trial)).rejects.toThrow('frozen source')
    await mkdir(trial)
    await writeFile(join(trial, 'keep'), 'existing run')
    await expect(prepareBuckyballTrial(repository, frozen, change, policy, trial)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(trial, 'keep'), 'utf8')).toBe('existing run')
    await expect(prepareBuckyballTrial(repository, frozen, change, policy, join(repository, 'trial'))).rejects.toThrow('separate')
  })

  it.each([
    ['protected file', patch.replaceAll('arch/source.c', 'arch/oracle.mjs')],
    ['traversal', patch.replaceAll('arch/source.c', '../outside.c')],
    ['git metadata', patch.replaceAll('arch/source.c', '.git/config')],
    ['different header', patch.replace('+++ b/arch/source.c', '+++ b/arch/oracle.mjs')],
    ['executable mode', patch.replace('--- a/', 'old mode 100644\nnew mode 100755\n--- a/')],
    ['symlink mode', patch.replace('--- a/', 'new file mode 120000\n--- a/')],
    ['binary patch', patch + 'GIT binary patch\n'],
    ['rename', patch.replace('b/arch/source.c', 'b/arch/renamed.c')],
  ])('refuses %s before creating a trial', async (_, patch) => {
    const { root, repository, frozen, change } = await fixture(), trial = join(root, 'trial')
    await expect(prepareBuckyballTrial(repository, frozen, { ...change, patch }, policy, trial)).rejects.toThrow()
    await expect(readFile(join(trial, 'arch/source.c'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses escaping symlinks and patches through otherwise safe symlinks', async () => {
    const { root, repository } = await fixture()
    await symlink('../../outside', join(repository, 'arch/escape'))
    await git(repository, 'add', '.')
    await git(repository, 'commit', '--quiet', '-m', 'escaping link')
    let frozen = await freezeBuckyballSource(repository, 'HEAD')
    await expect(prepareBuckyballTrial(repository, frozen, { baseCommit: frozen.baseCommit, inputTreeDigest: frozen.inputTreeDigest, patch }, policy, join(root, 'bad'))).rejects.toThrow('Escaping source symlink')
    await rm(join(repository, 'arch/escape'))
    await symlink('source.c', join(repository, 'arch/link.c'))
    await git(repository, 'add', '.')
    await git(repository, 'commit', '--quiet', '-m', 'internal link')
    frozen = await freezeBuckyballSource(repository, 'HEAD')
    await expect(prepareBuckyballTrial(repository, frozen, { baseCommit: frozen.baseCommit, inputTreeDigest: frozen.inputTreeDigest, patch: patch.replaceAll('source.c', 'link.c') }, policy, join(root, 'bad-link'))).rejects.toThrow('traverses source symlink')
  })

  it('removes an incomplete trial when patch context does not match', async () => {
    const { root, repository, frozen, change } = await fixture(), trial = join(root, 'trial')
    await expect(prepareBuckyballTrial(repository, frozen, { ...change, patch: patch.replace('-return 0;', '-different source;') }, policy, trial)).rejects.toThrow()
    await expect(readFile(join(trial, 'arch/source.c'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('parses only the three frozen change-set fields', () => {
    const valid = { baseCommit: 'a'.repeat(40), inputTreeDigest: 'b'.repeat(64), patch }
    expect(parseBuckyballChangeSet(JSON.stringify(valid))).toEqual(valid)
    expect(() => parseBuckyballChangeSet(JSON.stringify({ ...valid, binary: 'base64' }))).toThrow('fields')
  })

  it('executes an independent oracle through the existing confined process runner and distinguishes infrastructure failure', async () => {
    const { root, repository, frozen, change } = await fixture(), trial = join(root, 'trial')
    await prepareBuckyballTrial(repository, frozen, change, policy, trial)
    const oracle = join(root, 'oracle.mjs')
    await writeFile(oracle, "import{readFileSync}from'node:fs'; console.log('independent check'); process.exit(readFileSync('arch/source.c','utf8')==='return 1;\\n'?0:1)\n")
    const results = await checkBuckyballTrial(trial, [
      { id: 'semantics', argv: [process.execPath, oracle] },
      { id: 'missing-tool', argv: ['/nonexistent-buckyball-tool'] },
      { id: 'oracle-environment-failure', argv: [process.execPath, '-e', 'process.exit(4)'] },
    ], [oracle], spawnProcess)
    expect(results.map(result => result.status)).toEqual(['pass', 'invalid', 'invalid'])
    expect(results[0]!.stdout).toContain('independent check')
    await writeFile(join(trial, 'arch/source.c'), 'wrong answer\n')
    expect((await checkBuckyballTrial(trial, [{ id: 'semantics', argv: [process.execPath, oracle] }], [oracle], spawnProcess))[0]!.status).toBe('fail')
  })

  it('pins oracle/tool content and exposes the normal Domain verifier entry without a second executor', async () => {
    const { root, repository, frozen, change } = await fixture(), domain = join(root, 'domain')
    await mkdir(domain)
    const oracle = join(root, 'oracle.mjs')
    await writeFile(oracle, "import{readFileSync}from'node:fs';process.exit(readFileSync('arch/source.c','utf8')==='return 1;\\n'?0:1)\n")
    const adapter = fileURLToPath(new URL('../src/buckyball.ts', import.meta.url)), ids = fileURLToPath(new URL('../src/ids.ts', import.meta.url))
    const input: BuckyballVerificationInput = { version: 1, repository, source: frozen, policy,
      checks: [{ id: 'independent-semantics', argv: [process.execPath, oracle] }],
      immutableFiles: await Promise.all([process.execPath, oracle, adapter, ids].map(async path => ({ path, digest: sha256(await readFile(path)) }))),
    }
    const manifests = join(root, 'private-oracle/manifests')
    await mkdir(manifests, { recursive: true })
    const taskInput = buckyballTaskInput(input), manifest = join(manifests, taskInput.verificationDigest + '.json')
    await writeFile(manifest, JSON.stringify(input))
    await writeFile(join(domain, 'frozen.json'), JSON.stringify(taskInput))
    expect(taskInput).not.toHaveProperty('checks')
    expect(taskInput).not.toHaveProperty('immutableFiles')
    expect(JSON.stringify(taskInput)).not.toContain(oracle)
    await writeFile(join(domain, 'pass.json'), JSON.stringify(change))
    await writeFile(join(domain, 'fail.json'), JSON.stringify({ ...change, patch: patch.replace('+return 1;', '+return 2;') }))
    const invalidSubmissions = {
      malformed: 'not JSON',
      'wrong-baseline': JSON.stringify({ ...change, baseCommit: '0'.repeat(40) }),
      'protected-path': JSON.stringify({ ...change, patch: patch.replaceAll('arch/source.c', 'arch/oracle.mjs') }),
      'context-mismatch': JSON.stringify({ ...change, patch: patch.replace('-return 0;', '-different source;') }),
    }
    for (const [name, content] of Object.entries(invalidSubmissions)) await writeFile(join(domain, `${name}.json`), content)
    await writeFile(join(domain, 'verifier.mjs'), (await readFile(fileURLToPath(new URL('../../domains/buckyball/verifier.mjs', import.meta.url)), 'utf8'))
      .replace('../../assembly/src/buckyball.ts', adapter).replace('../../assembly/src/ids.ts', ids))
    await writeFile(join(domain, 'task.json'), JSON.stringify({ references: [], verifierReferences: [repository, oracle, manifests, fileURLToPath(new URL('../src', import.meta.url))],
      inputs: [{ ref: 'frozen', from: 'frozen.json' }], templates: [],
      verifiers: [{ ref: 'buckyball', version: '1', program: 'verifier.mjs', args: ['{artifact}', '{input}'], selftest: [
        { name: 'accepts-correct', expected: 'pass', artifact: 'pass.json', argv: ['pass.json', 'frozen.json'] },
        { name: 'rejects-wrong', expected: 'fail', artifact: 'fail.json', argv: ['fail.json', 'frozen.json'] },
        ...Object.keys(invalidSubmissions).map(name => ({ name, expected: 'fail', artifact: `${name}.json`, argv: [`${name}.json`, 'frozen.json'] })),
      ] }],
    }))
    const loaded = await loadDomain(domain, spawnProcess)
    expect(loaded.references).toEqual([])
    expect((await runVerifierSelftest(loaded.verifiers[0]!)).failures).toEqual([])
    const worker = await spawnProcess({ shell: false, argv: [process.execPath, '-e', `require('node:fs').readFileSync(${JSON.stringify(oracle)})`] }, undefined,
      domain, { root: domain, writable: false, protected: [], references: loaded.references })
    expect(worker.exitCode).not.toBe(0)
    const workerManifest = await spawnProcess({ shell: false, argv: [process.execPath, '-e', `require('node:fs').readFileSync(${JSON.stringify(manifest)})`] }, undefined,
      domain, { root: domain, writable: false, protected: [], references: loaded.references })
    expect(workerManifest.exitCode).not.toBe(0)
    const check = () => spawnProcess({ shell: false, argv: [process.execPath, join(domain, 'verifier.mjs'), join(domain, 'pass.json'), join(domain, 'frozen.json')] }, undefined,
      domain, { root: domain, writable: false, protected: [], references: loaded.verifierReferences! })
    await writeFile(join(domain, 'frozen.json'), JSON.stringify({ ...taskInput, policy: { ...policy, allowed: ['other'] } }))
    expect((await check()).stderr).toContain('Task input differs from frozen verification manifest')
    await writeFile(join(domain, 'frozen.json'), JSON.stringify(taskInput))
    await writeFile(manifest, JSON.stringify({ ...input, checks: [] }))
    expect((await check()).stderr).toContain('Frozen verification manifest differs')
    await writeFile(oracle, 'process.exit(0)\n')
    await expect(verifyBuckyballChangeSet(JSON.stringify(change), input, join(root, 'drift'), spawnProcess)).rejects.toThrow('Frozen oracle/tool content differs')
    await expect(readFile(join(root, 'drift/arch/source.c'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
