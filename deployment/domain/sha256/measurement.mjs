import { readFile } from 'node:fs/promises'
import { frozen, hash, run, withSource } from './apparatus.mjs'

const CLOSURE = '412d9b4c37147040721bc39df5b0d5dd9fdf252815b212748724093a6db16380'

export async function describe() {
  const pack = await frozen(CLOSURE)
  return { baselineArea: pack.measurement.baselineArea,
    digest: hash(JSON.stringify([hash(await readFile(new URL(import.meta.url))), CLOSURE])),
    tools: pack.tools.map(({ name, version, implementationDigest }) => ({ name, version, implementationDigest })),
    conditions: pack.measurement.conditions, unit: 'um2', direction: 'lower' }
}

export async function measure(source, signal) {
  signal?.throwIfAborted()
  const pack = await frozen(CLOSURE)
  return withSource(pack, source, signal, async work => {
    const pathOf = name => pack.tools.find(tool => tool.name === name).path
    const lib = pathOf('sky130hd')
    const script = `read_liberty -lib ${lib}; read_verilog sha256_k_constants.v sha256_w_mem.v sha256_core.v; synth -top sha256_core; dfflibmap -liberty ${lib}; abc -exe ${pathOf('abc')} -liberty ${lib}; stat -liberty ${lib}`
    const { stdout } = await run(pathOf('yosys'), ['-p', script], work, signal)
    const areas = [...stdout.matchAll(/Chip area for top module '\\sha256_core': ([0-9.]+)/g)]
    const area = Number(areas[0]?.[1])
    if (areas.length !== 1 || !Number.isFinite(area) || area <= 0 || /Warning:.*area.*unknown/i.test(stdout))
      throw new Error('Yosys did not measure one complete sha256_core top area')
    return area
  })
}
