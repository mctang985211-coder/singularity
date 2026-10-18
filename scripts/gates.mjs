#!/usr/bin/env node
/** Product boundary, schema, dependency and deployable-build checks. */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { hostFindings, hostInstall } from './host-config.mjs'
import { checkBuild } from '../assembly/build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROTOCOL_LEDGER = 'protocol-baseline.json'
const MUTATION_LEDGER = 'mutation-baseline.json'
const READ_ONLY_FS = new Set(['readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync',
  'realpath', 'realpathSync', 'access', 'accessSync', 'readlink', 'readlinkSync', 'existsSync', 'constants', 'Stats', 'Dirent',
])
const FS_MODULES = new Set(['node:fs', 'node:fs/promises'])

function treeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? treeFiles(path) : [path]
  }).sort()
}

export function coreWriteFindings(sources) {
  const findings = []
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const report = (node, detail) => findings.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${detail}`)
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text
        if (specifier === 'node:child_process' || specifier === 'child_process') report(node, 'core cannot execute processes; DSH owns the medium')
        if (FS_MODULES.has(specifier)) {
          const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause
          if (bindings === undefined || ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings) ||
            (ts.isImportDeclaration(node) && node.importClause?.name !== undefined)
          )
            report(node, 'core filesystem imports must name their read-only members')
          else for (const element of bindings.elements)
            if (!READ_ONLY_FS.has((element.propertyName ?? element.name).text)) report(element, 'core cannot import a filesystem writer')
        }
      }
      if (ts.isIdentifier(node) && ['createRequire', 'getBuiltinModule'].includes(node.text))
        report(node, 'core cannot use opaque module loaders')
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = node.arguments[0]
        if (target === undefined || !ts.isStringLiteral(target)) report(node, 'core dynamic imports must name one literal module')
        else if (FS_MODULES.has(target.text) || ['node:child_process', 'child_process'].includes(target.text))
          report(node, 'core cannot dynamically load filesystem or process capabilities')
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return findings
}

export function domainFindings(sources, declarations) {
  const identities = new Set()
  const keys = new Set(['criterionId', 'verifier', 'ref', 'path', 'program', 'artifact', 'inputs'])
  const collect = (node) => {
    if (Array.isArray(node)) { for (const item of node) collect(item)
      return }
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && keys.has(key)) identities.add(value)
      else if (['inputs', 'argv'].includes(key) && Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string') identities.add(item)
      } else collect(value)
    }
  }
  for (const declaration of declarations) collect(declaration)
  const findings = []
  for (const { file, text } of sources) {
    const visit = (node) => {
      if (ts.isStringLiteralLike(node) && identities.has(node.text)) findings.push(`${file} hardcodes domain identity ${JSON.stringify(node.text)}`)
      ts.forEachChild(node, visit)
    }
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
      ),
    )
  }
  return findings
}

export function inventoryFindingsWith(ledger, declared) {
  const findings = []
  const key = (row) => `${row.protocol}@${row.version}`
  const actual = new Map(declared.map((row) => [key(row), row]))
  const listed = new Map(ledger.protocols.map((row) => [key(row), row]))
  for (const [id, row] of actual) {
    const record = listed.get(id)
    if (record === undefined) { findings.push(`${PROTOCOL_LEDGER} omits ${id}`)
      continue }
    for (const field of ['subject', 'producedBy', 'readBy'])
      if (typeof record[field] !== 'string' || record[field].length === 0) findings.push(`${id} has no ${field}`)
    const actualKinds = new Map(row.kinds.map((kind) => [kind.name, kind.members]))
    const recordedKinds = new Map(record.kinds.map((kind) => [kind.name, kind.members]))
    for (const [name, members] of actualKinds)
      if (!Array.isArray(recordedKinds.get(name)) || JSON.stringify([...members].sort()) !== JSON.stringify([...recordedKinds.get(name)].sort()))
        findings.push(`${id} ${name} payload member set differs from ${PROTOCOL_LEDGER}`)
    for (const name of recordedKinds.keys()) if (!actualKinds.has(name)) findings.push(`${id} records undeclared kind ${name}`)
  }
  for (const id of listed.keys()) if (!actual.has(id)) findings.push(`${PROTOCOL_LEDGER} records undeclared ${id}`)
  return findings
}

export function mutationFindings(ledger, textOf = (file) => readFileSync(join(ROOT, file), 'utf8')) {
  const findings = []
  const ids = new Set()
  for (const claim of ledger.claims) {
    const where = `${MUTATION_LEDGER} ${claim.id}`
    if (ids.has(claim.id)) findings.push(`${where}: duplicate mutation identity`)
    ids.add(claim.id)
    if (!['node', 'vitest'].includes(claim.run?.kind) || !Array.isArray(claim.run.args) || claim.run.args.length === 0)
      findings.push(`${where}: no runnable command`)
    else for (const arg of claim.run.args) if (!arg.startsWith('-')) {
      try { textOf(arg) } catch { findings.push(`${where}: missing command input ${arg}`) }
    }
    if (typeof claim.witness !== 'string' || claim.witness.length === 0 || claim.witness === '×') findings.push(`${where}: no specific failure witness`)
    if (claim.edits.length === 0) findings.push(`${where}: no mutation edits`)
    for (const edit of claim.edits) {
      try {
        if (textOf(edit.file).split(edit.find).length - 1 !== 1) findings.push(`${where}: stale edit anchor in ${edit.file}`)
      } catch { findings.push(`${where}: missing edit input ${edit.file}`) }
    }
  }
  if (!ids.has(ledger.commitClaim)) findings.push(`${MUTATION_LEDGER}: commitClaim does not name a runnable mutation`)
  return findings
}

function alignmentFindingsWith(baseline) {
  const findings = hostFindings(hostInstall(), baseline)
  for (const entry of baseline.packages) {
    const peer = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).peerDependencies[entry.name]
    if (peer !== entry.version) findings.push(`${entry.name}: peer ${peer}, expected ${entry.version}`)
  }
  const generated = JSON.parse(readFileSync(join(ROOT, '.singularity/tsconfig.host.json'), 'utf8'))
  for (const [alias, targets] of Object.entries(generated.compilerOptions.paths))
    for (const path of targets) if (!path.startsWith(hostInstall() + '/')) findings.push(`${alias} points outside the configured private host`)
  return findings
}

async function declaredProtocols() {
  await import('./dsh-control-runtime.mjs')
  const core = await import('../src/index.ts')
  const registry = new core.ProtocolRegistry()
  for (const declare of [core.declareAgentProtocol, core.declareTaskProtocol, core.declareEnvironmentProtocol,
    core.declareReviewProtocol,
    core.declareMeasureProtocol,
    core.declareStrategyProtocol,
    core.declareReleaseProtocol,
  ]) declare(registry)
  return registry.protocols().flatMap((protocol) =>
      registry
        .versionsOf(protocol)
        .map((version) => ({ protocol, version,
    kinds: registry.kindsOf(protocol, version).map((name) => ({ name, members: registry.ruleFor(protocol, version, name).members })),
        })),
    )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--probe')) {
    execFileSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/build-gates.spec.ts', 'assembly/tests/build.spec.ts',
      ],
      { cwd: ROOT, stdio: 'inherit' },
    )
  } else {
    const sources = (directory) => treeFiles(join(ROOT, directory)).filter((file) => /\.(ts|tsx|js)$/.test(file))
        .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    const ledger = JSON.parse(readFileSync(join(ROOT, MUTATION_LEDGER), 'utf8'))
    const checks = [
      ['assembly-built', async () => { await checkBuild()
          return []
        },
      ],
      ['core-no-durable-write', () => coreWriteFindings(sources('src'))],
      ['assembly-domain-free', () => domainFindings([...sources('assembly/src'),
        ...sources('assembly/frontend'),
        ...['client.js'].map((file) => ({ file: 'assembly/' + file, text: readFileSync(join(ROOT, 'assembly', file), 'utf8'),
              })),
            ],
        treeFiles(join(ROOT, 'deployment/domain')).filter((file) => file.endsWith('task.json'))
              .map((file) => JSON.parse(readFileSync(file, 'utf8'))),
          ),
      ],
      ['protocol-inventory', async () => inventoryFindingsWith(JSON.parse(readFileSync(join(ROOT, PROTOCOL_LEDGER), 'utf8')), await declaredProtocols(),
          ),
      ],
      ['dsh-alignment', () => alignmentFindingsWith(JSON.parse(readFileSync(join(ROOT, 'dsh-baseline.json'), 'utf8')))],
      ['mutation-claims', () => mutationFindings(ledger)],
      ['mutation-witness', () => { execFileSync(process.execPath, [join(ROOT, 'scripts/mutate.mjs'), ledger.commitClaim], { cwd: ROOT, stdio: 'pipe',
          })
          return []
        },
      ],
    ]
    for (const [name, check] of checks) {
      try {
        const findings = await check()
        if (findings.length > 0) throw new Error(findings.join('\n'))
        console.log('  ok    ' + name)
      } catch (error) {
        process.exitCode = 1
        console.error('  FAIL  ' + name + ': ' + String(error.message ?? error))
      }
    }
    console.log(process.exitCode ? 'gates: failed' : 'gates: OK')
  }
}
