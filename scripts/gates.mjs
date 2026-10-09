#!/usr/bin/env node
/**
 * The mechanical gates, and the self-test that proves they can fail.
 *
 * These are the first asset of this codebase, not an afterthought. The previous system had a good
 * design and still grew twelve persisted formats and 197 unreferenced exports, because only two
 * gates existed and neither constrained *shape proliferation*: adding a format cost nothing,
 * removing one cost a hand audit.
 *
 * Two lessons are built in:
 *
 * - **A gate that has never failed is not known to work.** `--probe` runs every detector against a
 *   synthetic file set that violates all of them. An earlier version of this file had a shortcut
 *   that made `no-unreferenced-export` unable to fail, and only the probe found it.
 * - **Text matching is not symbol matching.** References are counted over source with comments and
 *   string literals stripped, because a name mentioned in a comment or a message is not a use — a
 *   counterexample that passed every gate before this.
 *
 * Usage:
 *   node scripts/gates.mjs           scan the real tree
 *   node scripts/gates.mjs --probe   self-test: every detector must fire on a violating input
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SOURCE_DIRS = ['src', 'tests']
const PROBE = process.argv.includes('--probe')

/** A file budget, not a design rule: the blueprint says split by responsibility, never by line count. */
const MAX_SOURCE_LINES = 400
/**
 * Durability belongs to DSH session persistence, so this codebase writes nothing.
 *
 * The rule is absolute rather than an allowlist with one exemption: the previous system kept a
 * self-built durable log beside the upstream one, and re-implemented a worse version of a barrier,
 * a lease and a replay it already had.
 */
const READ_ONLY_FS = new Set([
  'readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync',
  'realpath', 'realpathSync', 'access', 'accessSync', 'readlink', 'readlinkSync', 'existsSync',
  'constants', 'Stats', 'Dirent',
])
const FS_MODULES = new Set(['node:fs', 'node:fs/promises'])

/** Every file under the source directories, as repo-relative posix paths. */
function sourceFiles() {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|mts|tsx)$/.test(entry.name)) found.push(relative(ROOT, path))
    }
  }
  for (const directory of SOURCE_DIRS) {
    try {
      if (statSync(join(ROOT, directory)).isDirectory()) walk(join(ROOT, directory))
    } catch {
      // A directory that does not exist yet contributes nothing.
    }
  }
  return found.sort()
}

/**
 * Source with comments and string literals replaced by empty ones.
 *
 * Lexical, not a parser: it is meant to stop a *name* from counting as a use, and it is honest
 * about being approximate. A real AST pass is the next step if a bypass appears.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** Every name a file exports, from `export <decl>` and from `export { … }` blocks. */
function exportedNames(code) {
  const names = new Set()
  const declarative = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/gm
  for (const match of code.matchAll(declarative)) names.add(match[1])
  const lists = /^export\s*(?:type\s*)?\{([^}]*)\}/gm
  for (const match of code.matchAll(lists)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && /^[A-Za-z0-9_$]+$/.test(name)) names.add(name)
    }
  }
  return names
}

/**
 * The gates that read the real tree by running a script and reading the verdict line it prints.
 *
 * One entry each, because three consumers need the same three facts: the detector, the probe's
 * synthetic failing run (which needs the markers to know that a script reporting failure is
 * reported), and the skip line that says which gates the synthetic file set cannot reach.
 */
const SCRIPT_GATES = [
  { name: 'control-store-probe', label: 'the control store probe', script: 'scripts/control-probe.mjs', markers: ['failures: 0', 'gaps: 0'] },
  { name: 'root-child-slice', label: 'the root/child slice', script: 'scripts/slice-b.mjs', markers: ['slice-b: OK'] },
  { name: 'recovery-probe', label: 'the recovery probe', script: 'scripts/recovery-probe.mjs', markers: ['recovery-probe: OK'] },
  { name: 'strategy-vectors', label: 'the strategy vector corpus', script: 'scripts/strategy-vectors.mjs', markers: ['strategy-vectors: OK'] },
  { name: 'measure-probe', label: 'the measurement probe', script: 'scripts/measure-probe.mjs', markers: ['measure-probe: OK'] },
  { name: 'round-probe', label: 'the round probe', script: 'scripts/round-probe.mjs', markers: ['round-probe: OK'] },
  { name: 'release-probe', label: 'the release probe', script: 'scripts/release-probe.mjs', markers: ['release-probe: OK'] },
]

/** One detector per gate. Each takes the file list and the code-stripped texts. */
const DETECTORS = [
  {
    name: 'no-export-star',
    detect: (files, views) => {
      const findings = []
      for (const file of files) {
        views.code.get(file).split('\n').forEach((line, index) => {
          if (/^\s*export\s+\*/.test(line)) findings.push(`${file}:${index + 1} re-exports a whole module; state the names instead`)
        })
      }
      return findings
    },
  },
  {
    name: 'no-durable-writer',
    detect: (files, views) => {
      const findings = []
      for (const file of files) {
        if (!file.startsWith('src/')) continue
        const imports = /import\s*(?:type\s*)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
        for (const match of views.raw.get(file).matchAll(imports)) {
          if (!FS_MODULES.has(match[2])) continue
          const clause = match[1].trim()
          // A default or namespace binding hides every name behind one identifier, so no allowlist
          // can see what it will call. It is refused outright, which is the counterexample fix.
          if (!clause.startsWith('{'))
            findings.push(`${file} imports ${match[2]} as a ${clause.startsWith('*') ? 'namespace' : 'default'} binding; no module may write durably; DSH session persistence owns the medium`)
          for (const entry of clause.replace(/[{}]/g, '').split(',')) {
            const name = entry.trim().replace(/^type\s+/, '')
            if (name === '') continue
            if (!READ_ONLY_FS.has(name)) findings.push(`${file} imports ${name} from ${match[2]}; no module may write durably; DSH session persistence owns the medium`)
          }
        }
      }
      return findings
    },
  },
  {
    name: 'no-unreferenced-export',
    detect: (files, views) => {
      const findings = []
      const entry = 'src/index.ts'
      for (const file of files) {
        if (!file.startsWith('src/')) continue
        const own = file === entry
        for (const name of exportedNames(views.code.get(file))) {
          const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`)
          let referenced = false
          for (const other of files) {
            if (other === file) continue
            if (word.test(views.code.get(other))) {
              referenced = true
              break
            }
          }
          if (!referenced)
            findings.push(
              own
                ? `${file} exports ${name}, which nothing imports; the stack's surface is exactly what is used`
                : `${file} exports ${name}, which no other module imports; drop the keyword or the export`,
            )
        }
      }
      return findings
    },
  },
  {
    name: 'no-duplicate-type-body',
    detect: (files, views) => {
      const strip = source => source.replace(/\s+/g, '')
      const bodies = new Map()
      for (const file of files) {
        if (!file.startsWith('src/')) continue
        const source = views.code.get(file)
        const declaration = /export\s+(?:interface|type)\s+([A-Za-z0-9_$]+)(?:\s*<[^>]*>)?\s*=?\s*\{/g
        for (const match of source.matchAll(declaration)) {
          const start = match.index + match[0].length - 1
          let depth = 0
          let end = start
          for (; end < source.length; end += 1) {
            if (source[end] === '{') depth += 1
            else if (source[end] === '}') {
              depth -= 1
              if (depth === 0) break
            }
          }
          const body = strip(source.slice(start, end + 1))
          if (body.length < 40) continue
          const key = `${body.length}:${body}`
          const sites = bodies.get(key) ?? []
          sites.push(`${match[1]} in ${file}`)
          bodies.set(key, sites)
        }
      }
      const findings = []
      for (const sites of bodies.values()) if (sites.length > 1) findings.push(`identical type body declared twice: ${sites.join(' and ')}`)
      return findings
    },
  },
  {
    name: 'source-size',
    detect: (files, views) => {
      const findings = []
      for (const file of files) {
        const lines = views.raw.get(file).split('\n').length
        if (lines > MAX_SOURCE_LINES) findings.push(`${file} is ${lines} lines; the budget is ${MAX_SOURCE_LINES}`)
      }
      return findings
    },
  },
  {
    name: 'single-conditional-owner',
    detect: (files, views) => {
      const claims = []
      for (const file of files) {
        if (!file.startsWith('src/')) continue
        views.code.get(file).split('\n').forEach((line, index) => {
          if (/conditional:\s*true/.test(line)) claims.push(`${file}:${index + 1}`)
        })
      }
      return claims.length > 1
        ? [`${claims.length} kinds claim a conditional update (${claims.join(', ')}); one environment has one authoritative switch path`]
        : []
    },
  },
  {
    name: 'protocol-inventory',
    detect: () => inventoryFindingsWith(readLedger()),
  },
  {
    name: 'dsh-alignment',
    realTree: true,
    detect: () => alignmentFindingsWith(readBaseline()),
  },
  ...SCRIPT_GATES.map(gate => ({
    name: gate.name,
    realTree: true,
    detect: () => scriptFindings(gate.label, gate.markers, runScript(gate.script)),
  })),
]

/**
 * The gates the synthetic file set cannot reach: they spawn real processes and read the real tree.
 *
 * The self-test filters them out **before** it scores anything. Running them first and discarding
 * the result afterwards is not the same thing: it ran three end-to-end scripts to completion, threw
 * their verdicts away, and then `pnpm gates` ran them a second time for real.
 */
const REAL_TREE_GATES = new Set(DETECTORS.filter(detector => detector.realTree === true).map(detector => detector.name))

/** The one baseline file every other declaration must agree with. */
const DSH_BASELINE = 'dsh-baseline.json'

function readBaseline() {
  return JSON.parse(readFileSync(join(ROOT, DSH_BASELINE), 'utf8'))
}

/** The protocol ledger: every declared kind, and who produces and reads it. */
const PROTOCOL_LEDGER = 'protocol-baseline.json'

function readLedger() {
  return JSON.parse(readFileSync(join(ROOT, PROTOCOL_LEDGER), 'utf8'))
}

/**
 * What the code actually declares, asked of the registries rather than read out of the source.
 *
 * A protocol is declared by an exported `declare*Protocol(registry)` in a slice's `protocol.ts`,
 * which is the one convention every slice already follows. The `registry.declare` sweep below is
 * what keeps that convention honest: a shape declared anywhere else is invisible to this function,
 * so the gate says so instead of quietly under-reporting.
 */
async function declaredProtocols() {
  const { ProtocolRegistry } = await import(new URL('../src/protocol/registry.ts', import.meta.url).href)
  const found = []
  for (const file of protocolModules()) {
    const module = await import(new URL(`../${file}`, import.meta.url).href)
    const registry = new ProtocolRegistry()
    const declarers = Object.entries(module).filter(([name, value]) => /^declare[A-Z]\w*Protocol$/.test(name) && typeof value === 'function')
    for (const [, declare] of declarers) declare(registry)
    for (const protocol of registry.protocols()) {
      for (const version of registry.versionsOf(protocol)) {
        found.push({ protocol, version, kinds: [...registry.kindsOf(protocol, version)].sort() })
      }
    }
  }
  return found.sort((left, right) => (left.protocol < right.protocol ? -1 : left.protocol > right.protocol ? 1 : left.version - right.version))
}

/** Every slice's `protocol.ts`, which is where a declared shape lives. */
function protocolModules() {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'protocol.ts') found.push(relative(ROOT, path))
    }
  }
  walk(join(ROOT, 'src'))
  return found.sort()
}

/** Every file that declares a shape without being a slice's `protocol.ts`. */
function declarationSitesOutsideProtocolModules() {
  const allowed = new Set(protocolModules())
  const findings = []
  for (const file of sourceFiles()) {
    if (!file.startsWith('src/') || allowed.has(file)) continue
    const declares = /\.declare\s*[<(]/.exec(codeOnly(readFileSync(join(ROOT, file), 'utf8')))
    if (declares !== null) findings.push(`${file} declares a protocol without being a slice's protocol.ts; the inventory can only check what it can find`)
  }
  return findings
}

/**
 * Every declared kind must be in the ledger and every ledger row must be declared. Both directions
 * matter: one catches a shape added without a stated consumer, the other a ledger that has drifted
 * into fiction. Parameterised so the self-test can hand it a wrong ledger and watch it fire.
 */
function inventoryFindingsWith(ledger) {
  const rows = Array.isArray(ledger?.protocols) ? ledger.protocols : []
  const key = entry => `${entry.protocol}@${entry.version}`
  const listed = new Map(rows.map(row => [key(row), row]))
  const findings = []

  for (const declared of DECLARED) {
    const row = listed.get(key(declared))
    const where = `${declared.protocol}@${declared.version}`
    if (row === undefined) {
      findings.push(`${where} is declared by the code but no ${PROTOCOL_LEDGER} row names it; adding a shape is a recorded act, so record who produces it and who reads it`)
      continue
    }
    const named = [...(row.kinds ?? [])].sort()
    const missing = declared.kinds.filter(kind => !named.includes(kind))
    const extra = named.filter(kind => !declared.kinds.includes(kind))
    if (missing.length > 0) findings.push(`${where} declares ${missing.join(', ')}, which its ledger row does not list`)
    if (extra.length > 0) findings.push(`${where}'s ledger row lists ${extra.join(', ')}, which the code does not declare`)
    for (const field of ['subject', 'producedBy', 'readBy'])
      if (typeof row[field] !== 'string' || row[field].length === 0)
        findings.push(`${where}'s ledger row has no ${field}; a shape with no named producer or reader is how the previous system grew 197 unreferenced exports`)
  }

  for (const row of rows) {
    if (!DECLARED.some(declared => key(declared) === key(row)))
      findings.push(`${PROTOCOL_LEDGER} names ${key(row)}, which no code declares`)
  }
  return findings
}

/** Filled by the gate before it scans; the inventory cannot be a one-way check without it. */
let DECLARED = []

/**
 * Everything must agree with one baseline: the file, the version the host actually installs, the
 * declared peers, and every absolute path that points into the install. Three separate files had
 * hardcoded that path with nothing checking them, which is how an alignment silently drifts.
 *
 * Parameterised so the self-test can hand it a wrong baseline and watch it fire.
 */
function alignmentFindingsWith(baseline) {
  const findings = []
  const declaredRoot = baseline.installRoot

  // 1. The version the host actually provides must be the version we declare. Versions are per
  //    package: cordis is versioned independently of the dsh-* packages.
  for (const entry of baseline.packages) {
    const short = entry.name.replace('@deepseek-ai/', '')
    let installed
    try {
      installed = JSON.parse(readFileSync(join(declaredRoot, short, 'package.json'), 'utf8')).version
    } catch {
      findings.push(`cannot read ${entry.name} at ${declaredRoot}; the baseline names an install that is not there`)
      continue
    }
    if (installed !== entry.version)
      findings.push(`${entry.name} is installed at ${installed} but the baseline declares ${entry.version}`)
  }

  // 2. The declared peers must carry the baseline version.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const entry of baseline.packages) {
    const declared = manifest.peerDependencies?.[entry.name]
    if (declared === undefined) findings.push(`${entry.name} is not a declared peer; the host cannot provide what we do not name`)
    else if (declared !== entry.version)
      findings.push(`${entry.name} is declared as peer ${declared}, but the baseline is ${entry.version}`)
  }

  // 3. Every absolute path into the install must be the baseline root. tsconfig cannot compute it,
  //    so the gate is what keeps it from drifting.
  const config = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))
  for (const [alias, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
    for (const target of targets) {
      if (!String(target).startsWith(declaredRoot))
        findings.push(`tsconfig paths ${alias} → ${target} is outside the baseline install root`)
    }
  }
  for (const file of ['vitest.config.ts', 'scripts/dsh-control-runtime.mjs']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const paths = source.match(/\/[A-Za-z0-9_./-]*node_modules\/@deepseek-ai\/dsh\/node_modules\/@deepseek-ai/g) ?? []
    if (paths.length === 0) findings.push(`${file} names no DSH install path; it cannot be aligned to ${baseline.dshVersion}`)
    for (const path of new Set(paths)) {
      if (path !== declaredRoot) findings.push(`${file} points at ${path}, not the baseline install root ${declaredRoot}`)
    }
  }

  return findings
}

/**
 * One behavioural script, as a gate.
 *
 * These are the checks that observe the product doing something: the control store across real
 * processes (phase A), and the root/child slice with a real verifier (phase B). The first of them
 * was part of no automated path, so a task-protocol version bump broke it and nothing reported
 * that until it happened to be run by hand. A behavioural check belongs on the automated path, and
 * a script that prints its own verdict needs that verdict read rather than assumed.
 *
 * Parameterised over its runner so the self-test can hand it a synthetic failure, because these
 * gates read the real tree and the synthetic file set cannot reach them.
 */
function scriptFindings(label, markers, run) {
  const findings = []
  let output
  let status = 0
  try {
    output = run(ROOT)
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : 1
    output = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`
  }
  const tail = `${output}`.trim().split('\n').slice(-3).join(' | ')
  for (const marker of markers) {
    if (!`${output}`.includes(marker)) findings.push(`${label} did not report ${JSON.stringify(marker)}: ${tail}`)
  }
  if (status !== 0) findings.push(`${label} exited ${status}: ${tail}`)
  return findings
}

function runScript(name) {
  return root => execFileSync(process.execPath, [name], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Run every detector over one file set and report per gate. */
function scan(files, views) {
  return DETECTORS.map(({ name, detect }) => ({ name, findings: detect(files, views) }))
}

/**
 * The synthetic set the self-test scores.
 *
 * One file violates every static gate at once; a second mentions the first file's exports **only in
 * comments**, which is the reviewer's counterexample: a name in a comment is not a use, and text
 * matching alone called it one.
 */
function probeSet() {
  const padding = Array.from({ length: MAX_SOURCE_LINES + 5 }, (_, index) => `// padding ${index}`).join('\n')
  const violating = `/** Probe: every static gate must fire on this file. */
import fs from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'

export * from './protocol/refusal.ts'

export interface ProbeShapeA {
  readonly alpha: string
  readonly beta: number
  readonly gamma: readonly string[]
}

export interface ProbeShapeB {
  readonly alpha: string
  readonly beta: number
  readonly gamma: readonly string[]
}

export interface NeverImportedAnywhere {
  readonly lonely: string
}

export const probeClaims = [
  { guarantees: { appended: true, conditional: true } },
  { guarantees: { appended: true, conditional: true } },
]

export async function probe(path: string): Promise<string> {
  await writeFile(path, 'x', 'utf8')
  await fs.writeFile(path, 'y', 'utf8')
  return readFile(path, 'utf8')
}
${padding}
`
  const commentOnly = `/** Probe: names below appear only in comments, which must not count as uses. */
// NeverImportedAnywhere is referenced here and nowhere else.
/* ProbeShapeA and ProbeShapeB too. */
export const probeCommentAnchor = 1
`
  const files = ['src/__probe.ts', 'src/__probe_comment.ts']
  const raw = new Map([
    [files[0], violating],
    [files[1], commentOnly],
  ])
  return { files, raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) }
}

if (PROBE) {
  const { files, raw, code } = probeSet()
  const scored = DETECTORS.filter(detector => detector.realTree !== true && detector.name !== 'protocol-inventory')
  const results = scored.map(({ name, detect }) => ({ name, findings: detect(files, { raw, code }) }))
  let missed = 0
  console.log('gate self-test: every detector must fire on one violating file\n')
  console.log(`  (not run here: ${[...REAL_TREE_GATES].join(', ')}; synthetic failing runs below)\n`)
  for (const { name, findings } of results) {
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${name} did not fire`)
    } else {
      console.log(`  ok    ${name} fired (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    }
  }
  // The inventory reads the real registries, so its probe hands the check a wrong ledger. Each of
  // the three ways it can disagree must produce a finding, or the ledger protects nothing.
  for (const [label, wrong] of [
    ['a kind the code declares but the ledger omits', { ...readLedger(), protocols: readLedger().protocols.map(row => ({ ...row, kinds: row.kinds.filter((_, index) => index > 0) })) }],
    ['a kind the ledger lists but the code does not declare', { ...readLedger(), protocols: readLedger().protocols.map(row => ({ ...row, kinds: [...row.kinds, 'never/declared'] })) }],
    ['a protocol the ledger names and no code declares', { ...readLedger(), protocols: [...readLedger().protocols, { protocol: 'ghost', version: 1, kinds: [], subject: 's', producedBy: 'p', readBy: 'r' }] }],
  ]) {
    const findings = inventoryFindingsWith(wrong)
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  protocol-inventory did not fire on ${label}`)
    } else {
      console.log(`  ok    protocol-inventory fired on ${label} (${findings.length} findings)`)
    }
  }

  // The alignment gate reads the real tree, so its probe hands the function a wrong baseline: if a
  // version nobody installed does not produce a finding, the gate protects nothing. Versions are
  // per package, so the probe overrides each entry rather than one top-level number.
  const misaligned = alignmentFindingsWith({
    ...readBaseline(),
    packages: readBaseline().packages.map(entry => ({ ...entry, version: '0.0.0-not-installed' })),
  })
  if (misaligned.length === 0) {
    missed += 1
    console.log('  FAIL  dsh-alignment did not fire on a version nobody installed')
  } else {
    console.log(`  ok    dsh-alignment fired (${misaligned.length} findings)`)
  }

  // These gates read the real tree, so each probe is a synthetic failing run.
  for (const gate of SCRIPT_GATES) {
    const findings = scriptFindings(gate.name, gate.markers, () => 'ok\nsome checks failed\n')
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${gate.name} did not fire on a failing run`)
    } else {
      console.log(`  ok    ${gate.name} fired (${findings.length} findings)`)
    }
  }

  console.log('')
  if (missed > 0) {
    console.log(`gate self-test: ${missed} detector(s) cannot fail`)
    process.exitCode = 1
  } else {
    console.log('gate self-test: OK — every static detector can fail')
  }
} else {
  const files = sourceFiles()
  const raw = new Map(files.map(file => [file, readFileSync(join(ROOT, file), 'utf8')]))
  DECLARED = await declaredProtocols()
  const results = scan(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) })
  for (const finding of declarationSitesOutsideProtocolModules()) results.find(result => result.name === 'protocol-inventory')?.findings.push(finding)
  let failed = 0
  console.log(`gates: ${DETECTORS.length} gates over ${files.length} files\n`)
  for (const { name, findings } of results) {
    if (findings.length === 0) {
      console.log(`  ok    ${name}`)
      continue
    }
    failed += 1
    console.log(`  FAIL  ${name}`)
    for (const finding of findings) console.log(`          ${finding}`)
  }
  console.log('')
  if (failed > 0) {
    console.log(`gates: ${failed} of ${DETECTORS.length} failed`)
    process.exitCode = 1
  } else {
    console.log(`gates: OK — ${DETECTORS.length} gates passed`)
  }
}
