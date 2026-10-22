#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const exec = promisify(execFile), here = dirname(fileURLToPath(import.meta.url))
const flags = process.argv.slice(2)
assert(flags.length % 2 === 0, 'Use --name value options')
const options = Object.fromEntries(Array.from({ length: flags.length / 2 }, (_, i) => [flags[2 * i].replace(/^--/, ''), flags[2 * i + 1]]))
for (const key of ['source-setup', 'output', 'core-checkout', 'liberty']) assert(options[key], `Required --${key}`)
const prior = await realpath(options['source-setup']), output = resolve(options.output), core = await realpath(options['core-checkout'])
try { assert.equal((await readdir(output)).length, 0, 'Destination must be empty') } catch (error) { if (error.code !== 'ENOENT') throw error }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const put = async (relative, value) => writeFile(join(output, relative), typeof value === 'string' ? value : json(value))
for (const dir of ['domain/inputs', 'domain/samples', 'public', 'private-oracle', 'model-specs', 'evidence']) await mkdir(join(output, dir), { recursive: true })
for (const file of ['evaluate.py', 'oracle.cpp', 'public/accelerator.sv', 'public/WORKFLOW.md', 'public/score.mjs', 'public/chip-local-measure.mjs'])
  await copyFile(join(here, file), join(output, file.startsWith('public/') ? file : 'public/' + file))
for (const file of ['measurement.mjs', 'verifier.mjs']) await copyFile(join(here, file), join(output, 'domain', file))

const retained = new Set(['qwen2.5-0.5b.config.json', 'qwen3-0.6b.config.json', 'smollm2-360m.config.json',
  'fun-cosyvoice3-0.5b.yaml', 'fun-cosyvoice3-blanken.config.json', 'fun-cosyvoice3-model-card.md',
  'official-cosyvoice-llm.py', 'official-cosyvoice3-dit.py'])
const provenance = JSON.parse(await readFile(join(prior, 'model-specs/provenance.json'), 'utf8')).filter(entry => retained.has(entry.file))
assert.equal(provenance.length, retained.size, 'Missing official model provenance')
for (const entry of provenance) {
  const bytes = await readFile(join(prior, 'model-specs', entry.file))
  assert.equal(hash(bytes), entry.sha256, 'Changed retained model source: ' + entry.file)
  await writeFile(join(output, 'model-specs', entry.file), bytes)
}
await put('model-specs/provenance.json', provenance)
const tools = {}
for (const [name, executable] of Object.entries({ verilator: 'verilator', yosys: 'yosys', sta: 'sta', python: 'python3', cxx: 'g++' })) {
  const { stdout } = await exec('which', [executable])
  tools[name] = await realpath(stdout.trim())
}
tools.liberty = await realpath(options.liberty)
assert((await readFile(tools.liberty, 'utf8')).includes('sky130_fd_sc_hd__tt_025C_1v80'), 'Use the declared SKY130 HD TT 25C 1.8V corner')
const versions = {}
for (const [name, argv] of Object.entries({ verilator: ['--version'], yosys: ['-V'], sta: ['-version'], python: ['--version'], cxx: ['--version'] }))
  versions[name] = (await exec(tools[name], argv)).stdout.trim().split('\n')[0]
const manifest = { version: 1, tools, python: tools.python, versions,
  files: await Promise.all(Object.entries(tools).map(async ([name, path]) => ({ name, path, sha256: hash(await readFile(path)) }))),
  technology: { name: 'SKY130 HD', corner: 'TT 25C 1.8V', areaUnit: 'um^2', timingUnit: 'ns', source: tools.liberty },
  limits: { compileThreads: 1, evaluationSeconds: 50, moduleVerilatorOnly: true, fullChipVerilator: false, bebopP2E: false, commercialEDA: false },
}
await put('external-tools.json', manifest)
await copyFile(join(here, 'scoring-policy.json'), join(output, 'scoring-policy.json'))

const cfg = async file => JSON.parse(await readFile(join(output, 'model-specs', file), 'utf8'))
const cv = await cfg('fun-cosyvoice3-blanken.config.json'), q25 = await cfg('qwen2.5-0.5b.config.json')
const q3 = await cfg('qwen3-0.6b.config.json'), smol = await cfg('smollm2-360m.config.json')
const yaml = await readFile(join(output, 'model-specs/fun-cosyvoice3-0.5b.yaml'), 'utf8')
assert(yaml.includes('cosyvoice.llm.llm.CosyVoice3LM'), 'Wrong CosyVoice release')
const dit = Number(/estimator: !new:cosyvoice\.flow\.DiT\.dit\.DiT\s+dim: (\d+)/.exec(yaml)?.[1])
assert.equal(dit, 1024)
const caseRows = [
  ['cosyvoice3-llm-decode', 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512', '29e01c4e8d000f4bcd70751be16fa94bf3d85a18', cv.hidden_size, 'CosyVoice-BlankEN/config.json:hidden_size'],
  ['cosyvoice3-dit-projection', 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512', '29e01c4e8d000f4bcd70751be16fa94bf3d85a18', dit, 'cosyvoice3.yaml:flow.decoder.estimator.dim'],
  ['qwen25-hidden-projection', 'Qwen/Qwen2.5-0.5B', '060db6499f32faf8b98477b0a26969ef7d8b9987', q25.hidden_size, 'config.json:hidden_size'],
  ['qwen25-ffn-down', 'Qwen/Qwen2.5-0.5B', '060db6499f32faf8b98477b0a26969ef7d8b9987', q25.intermediate_size, 'config.json:intermediate_size'],
  ['qwen3-hidden-projection', 'Qwen/Qwen3-0.6B', 'c1899de289a04d12100db370d81485cdf75e47ca', q3.hidden_size, 'config.json:hidden_size'],
  ['qwen3-ffn-down', 'Qwen/Qwen3-0.6B', 'c1899de289a04d12100db370d81485cdf75e47ca', q3.intermediate_size, 'config.json:intermediate_size'],
  ['smollm2-hidden-projection', 'HuggingFaceTB/SmolLM2-360M', 'f8027fd0eaeea54caa13c31d31b9fdc459c38b49', smol.hidden_size, 'config.json:hidden_size'],
  ['smollm2-ffn-down', 'HuggingFaceTB/SmolLM2-360M', 'f8027fd0eaeea54caa13c31d31b9fdc459c38b49', smol.intermediate_size, 'config.json:intermediate_size'],
]
const cases = Object.fromEntries(caseRows.map(([id, model, modelRevision, k, source]) => [id, { model, modelRevision, k, dots: 4, source }]))
const source = await readFile(join(output, 'public/accelerator.sv'), 'utf8')
await put('domain/inputs/accelerator.sv', source)
await put('domain/samples/pass.sv', source)
await put('domain/samples/fail-numeric.sv', source.replace('out_data <= sum;', "out_data <= sum ^ 32'h1;"))
await copyFile(join(prior, 'domain/samples/fail-backpressure.sv'), join(output, 'domain/samples/fail-backpressure.sv'))
const inputs = [{ ref: 'baseline-rtl', from: 'inputs/accelerator.sv' }], templates = [], references = {}
let physical
for (const [index, [id, c]] of Object.entries(cases).entries()) {
  const workload = { version: 1, caseId: id, ...c, seed: 1009 + index * 101,
    inputDtype: 'signed-int8', accumulator: 'signed-int32-wraparound', pairsPerBeat: 8,
    evidenceScope: 'Config-derived synthetic projection reduction; no checkpoint, quantization-accuracy or full-model claim.' }
  await put('domain/inputs/' + id + '.json', workload)
  const argv = [join(output, 'public/evaluate.py'), join(output, 'public/accelerator.sv'), id, '--workload', join(output, 'domain/inputs/' + id + '.json'), '--evidence', join(output, 'evidence/baseline-' + id)]
  if (physical) argv.push('--functional-only')
  const { stdout } = await exec(tools.python, argv, { timeout: 160000, maxBuffer: 2 * 1024 * 1024 })
  const observed = JSON.parse(stdout)
  if (!physical) physical = { area_um2: observed.area_um2, critical_period_ns: observed.critical_period_ns }
  references[id] = { ...physical, cycles: observed.cycles, latency_ns: observed.cycles * physical.critical_period_ns,
    inputDigest: hash(await readFile(join(output, 'domain/inputs/' + id + '.json'))),
    sourceSha256: hash(source), physicalEvidence: 'evidence/baseline-' + caseRows[0][0] }
  inputs.push({ ref: id + '-workload', from: 'inputs/' + id + '.json' })
  templates.push({ id, goal: `Optimize one reusable streaming INT8 dot-product PE for a synthetic local projection reduction K=${c.k}, derived from ${c.model} (${c.source}). This is a four-dot operator workload. Improve weighted measured operator latency and mapped cell area while preserving exact arithmetic and the fixed interface. Submit accelerator.sv.`,
    artifact: 'accelerator.sv', inputs: [
      { name: 'inputs/workload.json', source: { kind: 'protected', ref: id + '-workload' } },
      { name: 'inputs/baseline.sv', source: { kind: 'protected', ref: 'baseline-rtl' } }],
    criteria: [
      { criterionId: 'correctness', statement: 'Reusable signed INT8 dot products with INT32 wraparound; legal input gaps, output backpressure, reset and arbitrary dot lengths. Exactly one stable result per accepted in_last. Independent host functional checks pass.' },
      { criterionId: 'design-integrity', statement: 'Retain the fixed single-clock synthesizable accelerator interface. No test/model/vector special casing, simulation-only behavior, latches, blackboxes or external source reads. No full-chip Verilator, bebop-p2e or commercial EDA. Distinguish observed operator estimates from full-chip/full-model claims.' }],
    skills: ['local-inference-datapath'], capabilities: [],
    guidance: `Read ${join(output, 'public/WORKFLOW.md')}; use the bound chip-local-measure Tool for a measured baseline and candidate feedback. Independent host checks are private and must not become child commands.`,
    checks: [{ criterionId: 'correctness', verifier: 'streaming-int8-oracle', input: 'inputs/workload.json' }],
    initial: { from: 'inputs/accelerator.sv' } })
  console.log(id + ': cycles=' + observed.cycles + ' baseline latency_ns=' + references[id].latency_ns)
}
await put('private-oracle/references.json', references)
await put('public/references.json', references)
const declaration = { rootTemplate: caseRows[0][0], inputs, templates, measurement: 'measurement.mjs',
  references: [join(output, 'public'), join(output, 'external-tools.json'), join(output, 'scoring-policy.json'), tools.liberty],
  verifiers: [{ ref: 'streaming-int8-oracle', version: '2-verilator', program: 'verifier.mjs', args: ['{artifact}', '{input}'],
    selftest: ['pass', 'fail-numeric', 'fail-backpressure'].map(name => ({ name, artifact: 'samples/' + name + '.sv',
      argv: ['samples/' + name + '.sv', 'inputs/' + caseRows[0][0] + '.json'], expected: name === 'pass' ? 'pass' : 'fail' })) }] }
// Contracts do not depend on measurement. Materialize the suite first so the
// final measurement digest can bind complete task/suite bytes without placeholders.
const { measurement: _measurement, ...contractDeclaration } = declaration
await put('domain/task.json', contractDeclaration)
await import(pathToFileURL(join(core, 'scripts/dsh-control-runtime.mjs')).href)
const [{ loadDomain }, { contractFor }, { spawnProcess }, { templateDeclaration }] = await Promise.all([
  import(pathToFileURL(join(core, 'assembly/src/domain.ts')).href), import(pathToFileURL(join(core, 'assembly/src/inputs.ts')).href),
  import(pathToFileURL(join(core, 'assembly/src/process.ts')).href), import(pathToFileURL(join(core, 'assembly/src/template.ts')).href) ])
const loaded = await loadDomain(join(output, 'domain'), spawnProcess)
await put('domain/suite.json', { version: 1, suiteId: 'model-shaped-int8-local-rtl-v2', failureQuality: 0,
  cases: caseRows.map(([id]) => ({ caseId: id, familyId: 'streaming-int8-dot-accelerator', sourceId: 'single-rtl-primitive-lineage',
    split: 'evolve', weight: 1, trials: 2, contract: contractFor(loaded, loaded.templates.get(id), loaded.templates.get(id).goal), hardGuards: ['correctness', 'design-integrity'] })) })
await put('domain/task.json', { ...declaration, suite: 'suite.json' })
await loadDomain(join(output, 'domain'), spawnProcess)
const tool = `await import(${JSON.stringify(pathToFileURL(join(output, 'public/chip-local-measure.mjs')).href)})\n`
await put('initial-method.json', { workflowGuidance: 'Understand the global operator goal and frozen arithmetic/interface. Begin with one local measurement. Use independent concurrent exploratory Tasks only for genuinely separate datapath/timing and protocol/correctness questions; keep their scopes small, share explicit interface constraints, then integrate a chosen measured result once. A focused change may be atomic. Compare baseline and candidate under identical conditions, retain failed hypotheses, and avoid duplicated audits or private-host criteria in child contracts.',
  templates: [...loaded.templates.values()].map(templateDeclaration),
  skills: [{ name: 'local-inference-datapath', description: 'Investigate and measure reusable local inference RTL under exact protocol and arithmetic constraints.', capabilities: ['local-inference-design'], requiredTools: ['chip-local-measure'],
    content: 'Read the frozen workload, fixed ports and public WORKFLOW.md. Measure the baseline with chip-local-measure. Choose one mechanism: resource sharing, partial unrolling, balanced reduction, pipelining or elastic output handling. Preserve arbitrary dot lengths, signed extremes, INT32 wraparound and backpressure. Use the same Tool on each candidate before selecting it; raw cycles, area and timing explain the score. Claim only local pre-layout estimates. Never run full-chip Verilator, bebop-p2e or commercial EDA. Delegate separate questions only when useful and bind this Skill to children needing local measurement.' }],
  tools: [{ name: 'chip-local-measure', source: tool }] })
await put('REVIEW.md', `# Setup candidate requiring external review\n\nPrepared ${new Date().toISOString()}. Eight config-derived synthetic operator cases cover the exact Fun-CosyVoice3 release plus Qwen2.5-0.5B, Qwen3-0.6B and SmolLM2-360M. The release names are scale labels, not a census of every component. All cases use one reusable INT8 dot-product responsibility lineage and all are evolve cases. No transfer or model-accuracy claim is possible.\n\nReview model-specs/provenance.json, source dimensions in domain/inputs/*.json, scoring-policy.json, external-tools.json and baseline evidence before approving. Local timing and area were measured using only Verilator, Yosys and OpenSTA with open SKY130 HD. No full-chip simulation or commercial EDA was used. The bound initial Method includes a design Skill and public measurement Tool; each host check receives the same protected workload bytes used by local measurement.\n\nQuality = latency ratio^0.65 * area ratio^0.35. Baseline=1; no saturation. Raw cycles/area/period/latency are retained. Power weight=0. Synthesis is measured once for identical baseline RTL; all case functional cycles are independently measured. Stage a new package identity if formulas, references or apparatus change. This candidate does not approve itself.\n\nInitial Method: initial-method.json. Domain: domain. Suggested launch evaluationParallelism=4 with compileThreads=1, bounded rounds/candidates and repairs. Candidate methods and rounds remain serial. Statistical release cannot claim transfer because there is one family and no heldout split.\n`)
console.log(json({ output, domain: join(output, 'domain'), method: join(output, 'initial-method.json'), cases: caseRows.length, trialsPerCase: 2, approved: false }))
