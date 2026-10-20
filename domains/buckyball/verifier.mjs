import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { BuckyballChangeError, buckyballTaskInput, verifyBuckyballChangeSet } from '../../assembly/src/buckyball.ts'
import { sha256 } from '../../assembly/src/ids.ts'

// This program is invoked by the normal sealed-submission verifier inside its Bubble.
// Its /tmp is private and its parent owns timeout, cancellation and process-group cleanup.
const temporary = await mkdtemp(join(tmpdir(), 'buckyball-verifier-'))
try {
  const [artifact, inputPath] = process.argv.slice(2)
  if (artifact === undefined || inputPath === undefined) throw new Error('Expected change-set.json and public Task input')
  const taskInput = JSON.parse(await readFile(inputPath, 'utf8'))
  if (!/^[a-f0-9]{64}$/.test(taskInput.verificationDigest)) throw new Error('Invalid host verification digest')
  const manifest = await readFile(new URL('../private-oracle/manifests/' + taskInput.verificationDigest + '.json', import.meta.url), 'utf8')
  if (sha256(manifest) !== taskInput.verificationDigest) throw new Error('Frozen verification manifest differs')
  const verification = JSON.parse(manifest)
  if (!isDeepStrictEqual(taskInput, buckyballTaskInput(verification))) throw new Error('Task input differs from frozen verification manifest')
  const result = await verifyBuckyballChangeSet(await readFile(artifact, 'utf8'), verification,
    join(temporary, 'trial'), (invocation, signal, cwd) => new Promise(resolve => {
      if (invocation.shell) throw new Error('Buckyball checks require argv')
      execFile(invocation.argv[0], invocation.argv.slice(1), {
        cwd, signal, timeout: 55_000, maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: temporary, CARGO_TARGET_DIR: join(cwd, 'bebop', 'target'),
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      }, (error, stdout, stderr) => resolve({ stdout, stderr,
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        ...(error !== null && typeof error.code !== 'number' ? { failure: error.message } : {}),
      }))
    }))
  console.log(JSON.stringify(result))
  process.exitCode = result.verdict === 'pass' ? 0 : result.verdict === 'fail' ? 1 : 4
} catch (error) {
  console.error(String(error))
  process.exitCode = error instanceof BuckyballChangeError ? 1 : 4
} finally { await rm(temporary, { recursive: true, force: true }) }
