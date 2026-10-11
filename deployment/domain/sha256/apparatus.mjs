import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const DIR = fileURLToPath(new URL('.', import.meta.url))
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function frozen(expected) {
  const declaration = await readFile(join(DIR, 'protected.json'))
  const pack = JSON.parse(declaration)
  const entries = [['apparatus.mjs', hash(await readFile(join(DIR, 'apparatus.mjs')))], ['protected.json', hash(declaration)]]
  for (const material of pack.materials) {
    const digest = hash(await readFile(join(DIR, material.path)))
    if (digest !== material.digest) throw new Error('fixed material changed: ' + material.path)
    entries.push([material.path, digest])
  }
  if (hash(JSON.stringify(entries)) !== expected) throw new Error('the frozen SHA256 apparatus changed')
  for (const tool of pack.tools)
    if (hash(await readFile(tool.path)) !== tool.implementationDigest) throw new Error('fixed tool changed: ' + tool.name)
  return pack
}

export async function withSource(pack, source, signal, action) {
  signal?.throwIfAborted()
  const work = await mkdtemp(join(tmpdir(), 'sha256-domain-'))
  try {
    await writeFile(join(work, 'sha256_w_mem.v'), source)
    for (const material of pack.materials)
      await writeFile(join(work, material.file), await readFile(join(DIR, material.path)))
    await writeFile(join(work, 'reference_w_mem.v'), pack.seed.source.replace(/\bsha256_w_mem\b/g, 'sha256_w_mem_reference'))
    const core = await readFile(join(work, 'sha256_core.v'), 'utf8')
    await writeFile(join(work, 'reference_core.v'), core.replace(/\bsha256_core\b/g, 'sha256_core_reference').replace(/\bsha256_w_mem\b/g, 'sha256_w_mem_reference'))
    return await action(work)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export async function run(program, args, work, signal) {
  signal?.throwIfAborted()
  const pending = execute(program, args, { cwd: work, signal, detached: true, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
  const stop = () => {
    if (pending.child.pid === undefined) return
    try { process.kill(-pending.child.pid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const timer = setTimeout(stop, 60_000)
  signal?.addEventListener('abort', stop, { once: true })
  try { return await pending } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    stop()
  }
}

async function simulate(pack, work, top, pass) {
  const pathOf = name => pack.tools.find(tool => tool.name === name).path
  const tb = join(work, top + '.v')
  await run(pathOf('iverilog'), ['-g2012', '-s', top, '-o', 'sim.vvp', 'sha256_w_mem.v', 'sha256_core.v', 'sha256_k_constants.v', 'reference_w_mem.v', 'reference_core.v', tb], work)
  const { stdout } = await run(pathOf('vvp'), ['sim.vvp'], work)
  if (!stdout.split('\n').includes(pass)) throw new Error(top + ' did not complete its comparisons')
  const ends = [...stdout.matchAll(/^(.+?):\d+: \$finish called at /gm)]
  if (ends.length !== 1 || resolve(ends[0][1]) !== tb) throw new Error(top + ' was ended outside its protected testbench')
}

export async function verify(layer, artifactPath, inputPath, expected) {
  const pack = await frozen(expected)
  const source = await readFile(artifactPath)
  const input = await readFile(inputPath)
  if (layer === 'integration') {
    if (!source.equals(input)) throw new Error('integration must preserve the exact sealed schedule source')
  } else if (hash(input) !== hash(await readFile(join(DIR, 'protected.json')))) {
    throw new Error('the protected SHA256 requirement changed')
  }
  await withSource(pack, source, undefined, async work => {
    if (layer !== 'integration') {
      await simulate(pack, work, 'tb_sha256_w_mem_selfcheck', '*** sha256_w_mem self-check passed: 3 blocks, 192 words')
      await simulate(pack, work, 'tb_sha256_w_mem_cycles', '*** w_mem cycle equivalence passed')
    }
    if (layer !== 'schedule') {
      await simulate(pack, work, 'tb_sha256_core', '*** All 03 test cases completed successfully')
      await simulate(pack, work, 'tb_sha256_core_cycles', '*** SHA224/SHA256 core cycle equivalence passed')
    }
  })
}
