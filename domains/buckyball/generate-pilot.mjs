#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cases, programFor } from './pilot-cases.mjs'

const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) =>
  [process.argv[2 + i * 2]?.replace(/^--/, ''), process.argv[3 + i * 2]]))
for (const key of ['repository', 'output', 'core-checkout', 'tools'])
  assert(options[key], `Required --${key} <path>`)
const repository = await realpath(options.repository), output = resolve(options.output)
const core = await realpath(options['core-checkout']), tools = JSON.parse(await readFile(options.tools, 'utf8'))
const executable = value => typeof value === 'string' ? value : value?.path
const riscvGcc = executable(tools.tools?.riscvGcc), bemu = executable(tools.tools?.bemu)
const hostCompiler = executable(tools.tools?.hostCompiler) ?? await realpath('/usr/bin/cc')
const generatedIsa = tools.generatedIsa ?? tools.generated?.isa
assert(riscvGcc && bemu && generatedIsa, 'Tool manifest must provide tools.riscvGcc, tools.bemu and generatedIsa')
const bemuArgv = tools.bemuArgv ?? [bemu, '--elf', '{elf}', '--log-dir', '{log}']
assert(bemuArgv[0] === bemu && bemuArgv.includes('{elf}') && bemuArgv.includes('{log}'),
  'BEMU command must use its frozen binary, candidate ELF and isolated log directory')
assert(bemuArgv.includes('--itrace'), 'BEMU must emit the completed-instruction trace')
await import(pathToFileURL(join(core, 'scripts/dsh-control-runtime.mjs')).href)
const [{ freezeBuckyballSource }, { loadDomain }, { contractFor }, { spawnProcess }, { runVerifierCommand }] = await Promise.all([
  import(pathToFileURL(join(core, 'assembly/src/buckyball.ts')).href),
  import(pathToFileURL(join(core, 'assembly/src/domain.ts')).href),
  import(pathToFileURL(join(core, 'assembly/src/inputs.ts')).href),
  import(pathToFileURL(join(core, 'assembly/src/process.ts')).href),
  import(pathToFileURL(join(core, 'src/verifier/command.ts')).href),
])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const domain = join(output, 'domain'), privateDir = join(output, 'private-oracle'), publicDir = join(output, 'public')
for (const dir of [domain, privateDir, publicDir, join(domain, 'inputs'), join(domain, 'samples')]) await mkdir(dir, { recursive: true })
const source = await freezeBuckyballSource(repository, tools.sourceCommit ?? 'HEAD')
const generatedFiles = []
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await visit(path)
    else { assert(entry.isFile(), 'Generated ISA references must be ordinary files'); generatedFiles.push(path) }
  }
}
await visit(generatedIsa)
const params = await readFile(join(generatedIsa, 'params.h'), 'utf8')
const ballIsa = await readFile(join(generatedIsa, 'ballISA.h'), 'utf8')
const functFor = name => {
  const value = /^#define\s+BB_FUNC7_(\w+)\s+(\d+)\s*$/gm
  const entry = [...ballIsa.matchAll(value)].find(match => match[1] === name)
  assert(entry, `Generated ISA lacks ${name}`)
  return Number(entry[2])
}
const bankWidth = Number(/#define BANK_WIDTH\s+(\d+)/.exec(params)?.[1])
const bankLines = Number(/#define BANK_LINES\s+(\d+)/.exec(params)?.[1])
assert(bankWidth === 128 && bankLines >= 64 && bankLines % 64 === 0,
  `Pilot ReLU/Gemmini need 128-bit banks and depth divisible by 64; got width=${bankWidth}, depth=${bankLines}`)
const here = dirname(fileURLToPath(import.meta.url)), oracle = join(privateDir, 'oracle.mjs')
await copyFile(join(here, 'pilot-oracle.mjs'), oracle)
const wrapper = (await readFile(join(core, 'domains/buckyball/verifier.mjs'), 'utf8'))
  .replace("'../../assembly/src/buckyball.ts'", JSON.stringify(pathToFileURL(join(core, 'assembly/src/buckyball.ts')).href))
await writeFile(join(domain, 'verifier.mjs'), wrapper)
const immutable = async paths => Promise.all([...new Set(paths)].map(async path => ({ path, digest: hash(await readFile(path)) })))
const commonFiles = [process.execPath, oracle, riscvGcc, hostCompiler,
  ...bemuArgv.filter(arg => arg.startsWith('/') && !arg.includes('{')),
  join(core, 'assembly/src/buckyball.ts'), join(core, 'assembly/src/ids.ts'), ...generatedFiles]
const patch = (path, text) => {
  assert(text.endsWith('\n') && text.split('\n').length <= 101, 'A focused pilot source must have at most 100 lines')
  const lines = text.slice(0, -1).split('\n')
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const inputs = [], templates = [], samples = [], provenance = []
for (const c of cases) {
  const configPath = join(privateDir, c.id + '.json'), harness = join(privateDir, c.id + '-harness.c')
  const reference = join(privateDir, c.id + '-reference.c')
  await writeFile(harness, programFor(c, false, bankWidth / 8))
  await writeFile(reference, programFor(c, true, bankWidth / 8))
  const expectedFuncts = [33, 16, ...(c.kind === 'relu' ? [functFor('RELU')] : c.kind === 'transpose'
    ? [functFor('GEMMINI_CONFIG'), functFor('GEMMINI_PRELOAD'), functFor('GEMMINI_COMPUTE_PRELOADED')]
    : c.kind === 'accumulate' ? [functFor('GEMMINI_CONFIG'), functFor('GEMMINI_COMPUTE_ACCUMULATED')] : [])]
  await writeFile(configPath, json({ version: 1, caseId: c.id, target: c.target, harness, reference,
    riscvGcc, hostCompiler, bemuArgv, expectedFuncts, seeds: [17, 101, 991],
    includes: ['stack/runtime/include', 'bb-tests/workloads/lib', generatedIsa,
      'examples/balls/relu/workloads', 'examples/balls/gemmini/workloads'] }))
  const verification = { version: 1, repository, source, policy: { allowed: [c.target], protected: ['stack', 'bebop', 'examples', 'arch'] },
    checks: [{ id: 'independent-scalar-and-bemu', argv: [process.execPath, oracle, configPath] }],
    immutableFiles: await immutable([...commonFiles, configPath, harness, reference]) }
  await writeFile(join(domain, 'inputs', c.id + '.json'), json(verification))
  await writeFile(join(domain, 'inputs', c.id + '.c'), c.bad)
  inputs.push({ ref: c.id + '-verification', from: 'inputs/' + c.id + '.json' }, { ref: c.id + '-starter', from: 'inputs/' + c.id + '.c' })
  for (const [kind, text] of [['pass', c.good], ['fail', c.bad]]) {
    const artifact = 'samples/' + c.id + '-' + kind + '.json'
    await writeFile(join(domain, artifact), json({ baseCommit: source.baseCommit, inputTreeDigest: source.inputTreeDigest, patch: patch(c.target, text) }))
    samples.push({ name: c.id + '-' + kind, artifact, argv: [artifact, 'inputs/' + c.id + '.json'], expected: kind })
  }
  const goal = `${c.goal} Repair the explicitly-labelled-synthetic-defect in inputs/starter.c and submit change-set.json adding the repaired kernel at ${c.target}. Use the real Buckyball ISA, not a CPU replacement. This pilot evaluates BEMU functional behavior only.`
  templates.push({ id: c.id, goal, artifact: 'change-set.json',
    inputs: [{ name: 'inputs/verification.json', source: { kind: 'protected', ref: c.id + '-verification' } },
      { name: 'inputs/starter.c', source: { kind: 'protected', ref: c.id + '-starter' } }],
    criteria: [{ criterionId: 'behavior', statement: c.goal + ' All independently generated inputs must agree with a separate scalar C reference when the repaired kernel runs as a real RISC-V ELF under BEMU.' },
      { criterionId: 'isa-and-scope', statement: `Only ${c.target} may be added. Retain the declared bb_pilot_kernel ABI and actual Buckyball ISA operations. Do not alter simulator, runtime, headers, oracle, build tools or reference inputs; no CPU replacement of the requested operator.` }],
    checks: [{ criterionId: 'behavior', verifier: 'buckyball-c-isa-pilot', input: 'inputs/verification.json' }],
    guidance: `Read ${join(publicDir, 'WORKFLOW.md')}. Copy inputs/starter.c to a writable candidate.c, repair it, then run node ${join(publicDir, 'change-set.mjs')} inputs/verification.json candidate.c change-set.json. The source is an authored synthetic starter based on ${c.lineage}; it is not a reproduced upstream defect.`,
    initial: { from: 'samples/' + c.id + '-fail.json' } })
  provenance.push({ caseId: c.id, familyId: c.family, split: c.split, sourceKind: c.sourceKind,
    upstreamCommit: tools.projection?.upstreamCommit ?? 'c3317d2f0739f829c93a86bee145acc191898e81',
    frozenProjection: source.baseCommit, sourceLineage: c.lineage, rootCause: c.rootCause,
    operatorModuleLineage: c.operatorModuleLineage, target: c.target,
    rights: 'Locally authored synthetic starter and independent scalar reference; upstream source remains a separately pinned restricted local dependency.',
    evidenceScope: 'C/ISA plus BEMU functional semantics; no MLIR, RTL timing, synthesis or PPA evidence' })
}
await writeFile(join(publicDir, 'change-set.mjs'), `import { readFile, writeFile } from 'node:fs/promises'
const [inputPath, sourcePath, outputPath] = process.argv.slice(2)
const input = JSON.parse(await readFile(inputPath, 'utf8')), text = await readFile(sourcePath, 'utf8')
if (!text.endsWith('\\n') || text.includes('\\r')) throw new Error('Use LF text ending in a newline')
const path = input.policy.allowed[0], lines = text.slice(0, -1).split('\\n')
const patch = 'diff --git a/' + path + ' b/' + path + '\\nnew file mode 100644\\n--- /dev/null\\n+++ b/' + path + '\\n@@ -0,0 +1,' + lines.length + ' @@\\n' + lines.map(line => '+' + line).join('\\n') + '\\n'
await writeFile(outputPath, JSON.stringify({ baseCommit: input.source.baseCommit, inputTreeDigest: input.source.inputTreeDigest, patch }, null, 2) + '\\n')
`)
await writeFile(join(publicDir, 'WORKFLOW.md'), `# Buckyball C/ISA pilot\n\nEach Task receives only its own synthetic starter and frozen verification input. Repair the starter in a writable copy, retain its ABI, and package it with change-set.mjs. All six starters are authored synthetic defects; none is claimed as historical upstream failure.\n\nThe source reference is ${repository}, frozen at ${source.baseCommit}. Compiler: ${riscvGcc}. Generated ISA headers: ${generatedIsa}. BEMU: ${bemu}. Compile with -O2 -march=rv64gc -mabi=lp64d -static, the source runtime/ISA includes and stack/runtime/src/dma.c. Put generated outputs in the current Task workspace. Derive geometry from params.h; the pilot explicitly requires 128-bit banks and a bank depth divisible by 64.\n\nThe independent oracle compiles scalar C separately for the host and compares its complete outputs with an actual BEMU RISC-V execution. Agent tests supplement it. BEMU completed-instruction traces must contain the requested DMA/operator instructions. This demonstrates those operations executed, while independent review still checks that the candidate did not substitute CPU computation for the requested operator. No MLIR/RTL/PPA or transfer claim follows from this pilot.\n`)
const references = [...new Set([repository, publicDir, generatedIsa, ...bemuArgv.filter(arg => arg.startsWith('/') && !arg.includes('{')), ...(tools.references ?? [])])]
const declaration = { rootTemplate: cases[0].id, inputs, templates,
  verifiers: [{ ref: 'buckyball-c-isa-pilot', version: '1', program: 'verifier.mjs', args: ['{artifact}', '{input}'], selftest: samples }],
  references, verifierReferences: [privateDir, join(core, 'assembly/src')] }
await writeFile(join(domain, 'task.json'), json(declaration))
const loaded = await loadDomain(domain, spawnProcess)
const suite = { version: 1, suiteId: 'buckyball-c-isa-synthetic-pilot-v1', failureQuality: 0,
  cases: cases.map(c => ({ caseId: c.id, familyId: c.family, sourceId: c.family, split: c.split, weight: 1, trials: 2,
    contract: contractFor(loaded, loaded.templates.get(c.id), loaded.templates.get(c.id).goal), hardGuards: ['isa-and-scope'] })) }
await writeFile(join(domain, 'suite.json'), json(suite))
await writeFile(join(domain, 'task.json'), json({ ...declaration, suite: 'suite.json' }))
await writeFile(join(privateDir, 'provenance.json'), json({ version: 1, protocol: 'buckyball-transfer-v1', pilotOnly: true,
  splitRule: 'Connected components of sourceLineage, rootCause and operatorModuleLineage stay in one split.',
  caseCount: cases.length, statisticalLimitation: 'One independent family per split; paired release evidence must be insufficient, without lowering the three-family gate.', cases: provenance }))
const executions = []
const capture = async (...args) => {
  const outcome = await spawnProcess(...args)
  executions.push({ invocation: args[0], ...outcome })
  await writeFile(join(privateDir, 'execution-evidence.json'), json(executions))
  return outcome
}
const admitted = await loadDomain(domain, capture), results = []
for (const verifier of admitted.verifiers) for (const sample of verifier.selftest.samples) {
  const actual = await verifier.judge(sample.input)
  results.push({ name: sample.name, expected: sample.expected, actual: actual.verdict, detail: actual.detail })
  await writeFile(join(privateDir, 'selftest-results.json'), json(results))
  assert.equal(actual.verdict, sample.expected, `${sample.name}: ${JSON.stringify(actual)}`)
  console.log(`${sample.name}: ${actual.verdict}`)
}
const probeDir = join(privateDir, 'probes')
await mkdir(probeDir, { recursive: true })
const first = cases[0], verificationPath = join(domain, 'inputs', first.id + '.json')
const verification = JSON.parse(await readFile(verificationPath, 'utf8'))
const drifted = structuredClone(verification)
drifted.immutableFiles.find(file => file.path === riscvGcc).digest = '0'.repeat(64)
const driftPath = join(probeDir, 'pin-drift.json')
await writeFile(driftPath, json(drifted))
const hypothesisPath = join(probeDir, 'wrong-stride-hypothesis.json')
await writeFile(hypothesisPath, json({ baseCommit: source.baseCommit, inputTreeDigest: source.inputTreeDigest,
  patch: patch(first.target, first.good.replace('0, rows, output_stride)', '0, rows, output_stride - 1)')) }))
const probes = []
for (const probe of [
  { name: 'compiler-pin-drift', kind: 'infrastructure-probe', artifact: join(domain, 'samples', first.id + '-pass.json'),
    input: driftPath, expected: 'unknown', claim: 'A compiler pin mismatch is unavailable evidence, not a business failure.' },
  { name: 'wrong-stride-hypothesis', kind: 'oracle-level-refutation', artifact: hypothesisPath,
    input: verificationPath, expected: 'fail', claim: 'Subtracting one from the destination stride repairs the row-layout problem.',
    limitation: 'A rejected hypothesis at the oracle level; not a completed model investigation Task.' },
]) {
  const actual = await runVerifierCommand({ command: [process.execPath, join(domain, 'verifier.mjs'), probe.artifact, probe.input],
    artifactPath: probe.artifact, inputs: [{ name: 'verification', path: probe.input, digest: hash(await readFile(probe.input)) }] },
    invocation => capture(invocation, undefined, domain, { root: domain, writable: false, protected: [],
      references: [...admitted.references, ...admitted.verifierReferences] }))
  probes.push({ ...probe, actual })
  await writeFile(join(probeDir, 'results.json'), json(probes))
  assert.equal(actual.verdict, probe.expected, `${probe.name}: ${JSON.stringify(actual)}`)
  console.log(`${probe.name}: ${actual.verdict}`)
}
console.log(json({ domain, suiteCases: admitted.suite.cases.length, selftests: results.length, probes: probes.length, source, pilotOnly: true }))
