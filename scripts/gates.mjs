#!/usr/bin/env node
/**
 * Mechanical gates over the real tree; `--probe` proves each detector can fail.
 * Behavioural gates also run without src/ to reject constant success markers.
 * Usage: `node scripts/gates.mjs` or `node scripts/gates.mjs --probe`.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const SOURCE_DIRS = ['src', 'tests']
const PROBE = process.argv.includes('--probe')

/** File size is a ceiling; split by responsibility. */
const MAX_SOURCE_LINES = 600
/**
 * DSH owns durable writes. Scan src/ for filesystem writers, opaque imports and loaders.
 * This is a spelling check, not runtime interposition: host APIs and unnamed capabilities
 * are invisible, and importing modules during the sweep executes their top-level code.
 */
const READ_ONLY_FS = new Set([
  'readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync',
  'realpath', 'realpathSync', 'access', 'accessSync', 'readlink', 'readlinkSync', 'existsSync',
  'constants', 'Stats', 'Dirent',
])
const FS_MODULES = new Set(['node:fs', 'node:fs/promises'])
/** A process executor runs whatever a string says, shell redirection included, so it is refused whole. */
const EXEC_MODULES = new Set(['node:child_process'])

/** Every `.ts` file under the source directories, as repo-relative posix paths. */
function sourceFiles() {
  return SOURCE_DIRS
    .flatMap(directory => treeFiles(join(ROOT, directory)).filter(file => /\.(ts|mts|tsx)$/.test(file)).map(file => `${directory}/${file}`))
    .sort()
}

/**
 * Blank comments and literal contents while preserving length and line breaks.
 * Approximate: regex literals are not parsed and template substitutions are blanked.
 */
function codeOnly(source) {
  const out = source.split('')
  const blank = index => {
    if (index < source.length && out[index] !== '\n') out[index] = ' '
  }
  let state = 'code'
  let opened = 0
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line') {
      if (char === '\n' || char === '\r') state = 'code'
      else blank(index)
      index += 1
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        blank(index)
        blank(index + 1)
        state = 'code'
        index += 2
      } else {
        blank(index)
        index += 1
      }
    } else if (state === 'single' || state === 'double') {
      if (char === '\\' && next !== '\n') {
        blank(index)
        blank(index + 1)
        index += 2
      } else if (char === '\n' || char === '\r') {
        // Restore a quote that reaches an unescaped line break; it may belong to a regex.
        for (let restored = opened + 1; restored < index; restored += 1) out[restored] = source[restored]
        state = 'code'
        index = opened + 1
      } else if (char === (state === 'single' ? "'" : '"')) {
        state = 'code'
        index += 1
      } else {
        blank(index)
        index += 1
      }
    } else if (state === 'template') {
      if (char === '\\') {
        blank(index)
        blank(index + 1)
        index += 2
      } else if (char === '`') {
        state = 'code'
        index += 1
      } else {
        blank(index)
        index += 1
      }
    } else if (char === '/' && next === '/') {
      blank(index)
      blank(index + 1)
      state = 'line'
      index += 2
    } else if (char === '/' && next === '*') {
      blank(index)
      blank(index + 1)
      state = 'block'
      index += 2
    } else if (char === "'" || char === '"') {
      state = char === "'" ? 'single' : 'double'
      opened = index
      index += 1
    } else if (char === '`') {
      state = 'template'
      index += 1
    } else {
      index += 1
    }
  }
  return out.join('')
}

/**
 * Enumerate declared exports; re-exports are counted at their originating module.
 */
function declaredExports(code) {
  const names = new Set()
  const declarative = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/gm
  for (const match of code.matchAll(declarative)) names.add(match[1])
  const lists = /^export\s*(?:type\s*)?\{([^}]*)\}/gm
  for (const match of code.matchAll(lists)) {
    if (/^\s*from\b/.test(code.slice(match.index + match[0].length))) continue
    for (const entry of match[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && /^[A-Za-z0-9_$]+$/.test(name)) names.add(name)
    }
  }
  return names
}

/**
 * Read import/re-export bindings from stripped code and specifiers from matching raw offsets.
 */
function moduleBindings(code, raw) {
  const bound = []
  const namespaces = []
  const clause = /\b(import|export)\s+([\s\S]{0,600}?)\bfrom\s*(["'])/g
  for (const match of code.matchAll(clause)) {
    const quoted = match.index + match[0].length - 1
    const end = raw.indexOf(raw[quoted], quoted + 1)
    if (end < 0) continue
    const specifier = raw.slice(quoted + 1, end)
    const forwarding = match[1] === 'export'
    const list = /\{([\s\S]*)\}/.exec(match[2])
    if (list === null) {
      namespaces.push(specifier)
      continue
    }
    for (const entry of list[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
      if (name !== undefined && /^[A-Za-z0-9_$]+$/.test(name)) bound.push({ name, specifier, forwarding })
    }
  }
  return { bound, namespaces }
}

/** Resolve relative modules inside the scanned tree, including compiled JS extensions. */
function resolveModule(from, specifier, files) {
  if (!specifier.startsWith('.')) return undefined
  const target = normalize(join(dirname(from), specifier))
  if (files.includes(target)) return target
  const compiled = target.replace(/\.(js|mjs|jsx)$/, extension => ({ '.js': '.ts', '.mjs': '.mts', '.jsx': '.tsx' })[extension])
  return compiled !== target && files.includes(compiled) ? compiled : undefined
}

/** The 1-based line an offset into a file falls on. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/** The one module the stack publishes through. Its re-exports leave this repository. */
const ENTRY_POINT = 'src/index.ts'

/**
 * Record entry-point exports with no consumer in this tree. Entries that gain a local
 * binding or cease to be published must be removed; host consumers cannot be observed.
 */
const PUBLISHED_WITHOUT_CONSUMER = new Set([
  'src/agent/protocol.ts\0AGENT_OPENED_MEMBERS',
  'src/measure/commands.ts\0EvaluationPlanInput',
  'src/measure/commands.ts\0MeasureCommandOptions',
  'src/measure/commands.ts\0TrialInput',
  'src/measure/protocol.ts\0ConstraintCheck',
  'src/measure/protocol.ts\0MissedTrial',
  'src/measure/view.ts\0Caliber',
  'src/measure/view.ts\0ConstraintView',
  'src/measure/view.ts\0MissingSlot',
  'src/release/commands.ts\0ReleaseCommandOptions',
  'src/release/commands.ts\0ReleaseCommands',
  'src/strategy/commands.ts\0DecideRoundInput',
  'src/strategy/commands.ts\0StrategyCommandOptions',
  'src/strategy/protocol.ts\0EditAsset',
  'src/strategy/protocol.ts\0RoundDecisionRecord',
  'src/strategy/view.ts\0SlotView',
  'src/task/bubble.ts\0BUBBLE_MEMBERS',
  'src/task/bubble.ts\0WORKSPACE_MEMBERS',
  'src/task/commands.ts\0AgentCommands',
  'src/task/commands.ts\0TaskCommandOptions',
  'src/task/commands.ts\0VerdictInput',
  'src/task/contract.ts\0VerifierRegistry',
  'src/task/decomposition.ts\0DECOMPOSITION_CHILD_MEMBERS',
  'src/task/decomposition.ts\0DECOMPOSITION_MEMBERS',
  'src/task/responsibility.ts\0REASSIGNMENT_MEMBERS',
  'src/task/responsibility.ts\0RESPONSIBILITY_MEMBERS',
  'src/task/run.ts\0EvidenceRecord',
  'src/task/tree.ts\0ChildOutcome',
  'src/task/tree.ts\0ChildStatus',
  'src/task/tree.ts\0TreeCriterionView',
  'src/task/view.ts\0CriterionVerdictView',
  'src/task/view.ts\0RunView',
])

/** Filled by the gate before it scans: what the loader says each module exports. */
let RUNTIME_EXPORTS = new Map()

/**
 * Follow re-export bindings transitively and check unbound published names against the record.
 * Runtime namespaces cover value exports; text covers erased types. Entry-point imports
 * are excluded, so a computed published value cannot be distinguished from a dead binding.
 */
function unreferencedExportFindings(files, views, recorded, runtime = RUNTIME_EXPORTS) {
  const findings = []
  const used = new Set()
  const forwarded = []
  const bound = new Map()
  for (const file of files) {
    const { bound: names, namespaces } = moduleBindings(views.code.get(file), views.raw.get(file))
    bound.set(file, names)
    for (const specifier of namespaces) {
      if (resolveModule(file, specifier, files) === undefined) continue
      findings.push(`${file} imports ${specifier} as a namespace binding; a namespace hides which of that module's exports are used, so no count can be made — name what you use`)
    }
    for (const { name, specifier, forwarding } of names) {
      const target = resolveModule(file, specifier, files)
      if (target === undefined) continue
      if (forwarding) forwarded.push({ from: file, to: target, name })
      else if (file !== ENTRY_POINT) used.add(`${target}\0${name}`)
    }
  }
  // Follow forwarding edges backwards until all used names are accounted for.
  for (let grew = true; grew; ) {
    grew = false
    for (const { from, to, name } of forwarded)
      if (used.has(`${from}\0${name}`) && !used.has(`${to}\0${name}`)) {
        used.add(`${to}\0${name}`)
        grew = true
      }
  }
  // The same walk forwards from the entry point, which is what "published" means here.
  const published = new Set()
  for (let grew = true; grew; ) {
    grew = false
    for (const { from, to, name } of forwarded)
      if ((from === ENTRY_POINT || published.has(`${from}\0${name}`)) && !published.has(`${to}\0${name}`)) {
        published.add(`${to}\0${name}`)
        grew = true
      }
  }

  const declared = new Set()
  for (const file of files) {
    if (!file.startsWith('src/')) continue
    // Runtime namespaces cover value spellings; text supplies erased types.
    // Forwarded names are counted at their declaration.
    const forwards = new Set((bound.get(file) ?? []).filter(entry => entry.forwarding).map(entry => entry.name))
    const exported = [...new Set([...declaredExports(views.code.get(file)), ...(runtime.get(file) ?? [])])].filter(name => !forwards.has(name))
    for (const name of exported) {
      const key = `${file}\0${name}`
      declared.add(key)
      if (used.has(key)) continue
      if (published.has(key)) {
        if (recorded.has(key)) continue
        findings.push(
          `${file} exports ${name}, which nothing in this tree binds and ${ENTRY_POINT} publishes; a consumer outside this repository is one no gate here can see, so publishing a name nothing here binds is a recorded act — record it in this gate's PUBLISHED_WITHOUT_CONSUMER, or drop the export`,
        )
        continue
      }
      findings.push(`${file} exports ${name}, which no other module binds by importing it, or by re-exporting it where the re-export is itself used; drop the keyword or the export`)
    }
  }
  // Remove records that are now bound or no longer published.
  for (const key of recorded) {
    const [file, name] = key.split('\0')
    if (used.has(key))
      findings.push(`the published-surface record names ${name} in ${file}, which another module now binds; the record may only shrink, so shrink it in the commit that made it possible`)
    else if (!published.has(key) || !declared.has(key))
      findings.push(`the published-surface record names ${name} in ${file}, which ${ENTRY_POINT} does not publish unbound any more; the record may only shrink, so shrink it in the commit that made it possible`)
  }
  return findings
}

/** Shared script, verdict and argument declarations for detectors and their self-tests. */
const SCRIPT_GATES = [
  { name: 'control-store-probe', label: 'the control store probe', script: 'scripts/control-probe.mjs', markers: ['failures: 0', 'gaps: 0'] },
  { name: 'root-child-slice', label: 'the root/child slice', script: 'scripts/slice-b.mjs', markers: ['slice-b: OK'] },
  { name: 'recovery-probe', label: 'the recovery probe', script: 'scripts/recovery-probe.mjs', markers: ['recovery-probe: OK'] },
  { name: 'strategy-vectors', label: 'the strategy vector corpus', script: 'scripts/strategy-vectors.mjs', markers: ['strategy-vectors: OK'] },
  { name: 'measure-probe', label: 'the measurement probe', script: 'scripts/measure-probe.mjs', markers: ['measure-probe: OK'] },
  { name: 'round-probe', label: 'the round probe', script: 'scripts/round-probe.mjs', markers: ['round-probe: OK'] },
  { name: 'release-probe', label: 'the release probe', script: 'scripts/release-probe.mjs', markers: ['release-probe: OK'] },
  { name: 'cd-probe', label: 'the C+D probe', script: 'scripts/cd-probe.mjs', markers: ['cd-probe: OK'] },
  { name: 'domain-comparison', label: 'the domain comparison probe', script: 'scripts/domain-probe.mjs', markers: ['domain-probe: OK'] },
  // Browser/profile probes check runnable child tasks and a shared panel/tool snapshot.
  { name: 'panel-probe', label: 'the panel probe', script: 'scripts/browser-probe.mjs', args: ['--panel'], markers: ['panel-probe: OK'] },
  { name: 'subtask-probe', label: 'the sub-task probe', script: 'scripts/browser-probe.mjs', args: ['--decompose'], markers: ['subtask-probe: OK'] },
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
    /** Durable-write restrictions apply to product src/; tests and probes exercise real media. */
    name: 'src-names-no-durable-write',
    detect: (files, views) => {
      const findings = []
      for (const file of files) {
        if (!file.startsWith('src/')) continue
        const code = views.code.get(file)
        // Both imports and re-exports can expose a filesystem writer.
        const clauses = /\b(import|export)\s*(?:type\s*)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
        for (const match of views.raw.get(file).matchAll(clauses)) {
          const verb = match[1]
          const specifier = match[3]
          const clause = match[2].trim()
          if (EXEC_MODULES.has(specifier)) {
            findings.push(`${file} ${verb}s ${specifier}; a general process executor runs whatever a string says, a shell redirection into a file among them, so no module under src/ may name one`)
            continue
          }
          if (!FS_MODULES.has(specifier)) continue
          // Default and namespace bindings hide which filesystem members are called.
          if (!clause.startsWith('{')) {
            findings.push(`${file} ${verb}s ${specifier} as a ${clause.startsWith('*') ? 'whole module' : clause.startsWith('type') ? 'type' : 'default or namespace'} binding; no module under src/ may write durably; name the members you read instead`)
            continue
          }
          for (const entry of clause.replace(/[{}]/g, '').split(',')) {
            const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
            if (name === undefined || name === '') continue
            if (!READ_ONLY_FS.has(name)) findings.push(`${file} ${verb}s ${name} from ${specifier}; no module under src/ may write durably; DSH session persistence owns the medium`)
          }
        }
        // A dynamic import must name one complete quoted literal.
        for (const match of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
          const at = `${file}:${lineOf(code, match.index)}`
          const literal = /^\s*(['"])([^'"]*)\1\s*\)/.exec(views.raw.get(file).slice(match.index + match[0].length))
          if (literal === null)
            findings.push(`${at} loads a module through a dynamic import whose target is not one quoted literal the gate can read on its own (a concatenation, a template, a variable or an expression); no module under src/ may write durably, so a dynamic import may only name one literal module, and never a filesystem one`)
          else if (FS_MODULES.has(literal[2]) || EXEC_MODULES.has(literal[2]))
            findings.push(`${at} dynamically imports ${literal[2]}; no module under src/ may write durably; DSH session persistence owns the medium`)
        }
        // Opaque loaders and builtin lookup bypass import clauses.
        for (const [spelling, how] of [
          ['createRequire', "builds a module loader with createRequire; createRequire(import.meta.url)('node:fs/promises').writeFile(…) wrote a real file while every gate stayed green"],
          ['getBuiltinModule', 'fetches a module by name with process.getBuiltinModule, which no import clause names and no specifier scan can see'],
        ]) {
          const at = code.search(new RegExp(`\\b${spelling}\\b`))
          if (at >= 0) findings.push(`${file}:${lineOf(code, at)} ${how}; no module under src/ may write durably, so a loader this gate cannot read is refused by name`)
        }
      }
      return findings
    },
  },
  {
    name: 'no-unreferenced-export',
    /** Assembly imports are real consumers of the stack's exports. */
    detect: (files, views) => unreferencedExportFindings([...files, ...assemblySources().map(({ file, text }) => file)], { raw: new Map([...views.raw, ...assemblySources().map(({ file, text }) => [file, text])]), code: new Map([...views.code, ...assemblySources().map(({ file, text }) => [file, codeOnly(text)])]) }, PUBLISHED_WITHOUT_CONSUMER),
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
    name: 'assembly-budget',
    /** Its subject is its own package and its synthetic leg is below, because `sourceFiles()` is not its file set. */
    probeSeparately: true,
    detect: () => assemblyBudgetFindings(assemblySources()),
  },
  {
    name: 'assembly-domain-free',
    /** Its findings come from the deployment's own declaration, so its synthetic leg is below. */
    probeSeparately: true,
    detect: () => assemblyDomainFindings(assemblySources()),
  },
  {
    name: 'assembly-built',
    /** It compares the real bundle's mtime with the real sources, and its synthetic leg is below. */
    probeSeparately: true,
    detect: () => assemblyArtifactFindings(),
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
    /** Its synthetic failures are its own legs below, because it reads the real registries. */
    probeSeparately: true,
    detect: () => inventoryFindingsWith(readLedger(), DECLARED),
  },
  {
    name: 'evidence-budget',
    /** Its synthetic failure is its own leg below, because it reduces to arithmetic over a file set. */
    probeSeparately: true,
    detect: (files, views) => evidenceBudgetFindings(files, views, evidenceFiles()),
  },
  {
    name: 'spec-density',
    /** Its synthetic failure is its own leg below, because it reduces to arithmetic over a file set. */
    probeSeparately: true,
    detect: (files, views) => specDensityFindings(files, views),
  },
  {
    name: 'tree-inventory',
    /** It measures the real tree and spawns vitest's collector, so its synthetic legs are its own. */
    probeSeparately: true,
    detect: (files, views) => [
      ...treeInventoryFindings(readTreeLedger(), {
        sourceFiles: files.length,
        specFiles: files.filter(file => /^tests\/[^/]*\.spec\.ts$/.test(file)).length,
        tests: collectedTestCount(),
        gates: DETECTORS.length,
      }),
      ...countClaimFindings(),
    ],
  },
  {
    name: 'mutation-claims',
    /** It reads the real ledger, the real tree and the real documents, and runs one claim, so its legs are its own. */
    probeSeparately: true,
    detect: () => {
      const ledger = readMutationLedger()
      return [...mutationClaimFindings(ledger), ...mutationRunFindings(ledger)]
    },
  },
  {
    name: 'dsh-alignment',
    realTree: true,
    detect: () => alignmentFindingsWith(readBaseline()),
  },
  ...SCRIPT_GATES.map(gate => ({
    name: gate.name,
    realTree: true,
    detect: () => [
      ...scriptFindings(gate.label, gate.markers, runScript(gate.script, gate.args)),
      // The verdict is only read after it has been shown to be able to differ from itself.
      ...notLoadBearingFindings(gate.label, gate.markers, gate.script, loadBearingMirror(), gate.args),
    ],
  })),
]

/**
 * Charge tests/*.ts, assembly/tests/*.ts, all fixture files and every script at any depth.
 * Compare their lines with authored stack and assembly source; print uncharged files too.
 * Headroom is derived as floor(budget × source) − charged, never restated as a constant.
 */
const EVIDENCE_BUDGET = 1.88
const SPEC_DENSITY = 5

/** Walk all files except node_modules and history, using directory-relative paths. */
function treeFiles(directory) {
  const found = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(relative(directory, path))
    }
  }
  try { walk(directory) } catch { /* a directory that does not exist contributes nothing */ }
  return found.sort()
}

/** All scripts, including nested and hidden names, without an extension filter. */
function scriptFiles(directory = join(ROOT, 'scripts')) {
  const under = relative(ROOT, directory)
  return treeFiles(directory).map(file => (under.startsWith('..') ? file : `${under}/${file}`))
}

/** Every file the budget does not charge, with its size — derived from the same walk as the charge. */
function unchargedFiles() {
  const charged = new Set(evidenceFiles().map(entry => entry.file))
  return treeFiles(ROOT)
    .filter(file => !file.startsWith('src/') && !charged.has(file))
    .map(file => ({ file, lines: readFileSync(join(ROOT, file), 'utf8').split('\n').length }))
}

/** Charged evidence files and their line counts. */
function evidenceFiles() {
  const paths = new Set(sourceFiles().filter(file => file.startsWith('tests/')))
  for (const file of treeFiles(join(ROOT, 'tests', 'fixtures'))) paths.add(`tests/fixtures/${file}`)
  // Assembly specs contribute to the same evidence budget.
  for (const file of treeFiles(join(ROOT, 'assembly', 'tests'))) paths.add(`assembly/tests/${file}`)
  for (const file of scriptFiles()) paths.add(file)
  return [...paths].sort().map(file => ({ file, lines: readFileSync(join(ROOT, file), 'utf8').split('\n').length }))
}

/** Authored assembly sources, using the same extension set as the stack. */
const ASSEMBLY_SOURCE_EXTENSIONS = /\.(ts|mts|tsx)$/

function assemblySources() {
  return treeFiles(join(ROOT, 'assembly', 'src'))
    .filter(file => ASSEMBLY_SOURCE_EXTENSIONS.test(file))
    .map(file => ({ file: `assembly/src/${file}`, text: readFileSync(join(ROOT, 'assembly', 'src', file), 'utf8') }))
    .sort((left, right) => left.file.localeCompare(right.file))
}

/** Assembly has per-file and package ceilings; split responsibilities at real seams. */
const ASSEMBLY_FILE_BUDGET = 200
const ASSEMBLY_TOTAL_BUDGET = 1677

/** The split rule and the package budget, measured on the plugin's own files. */
function assemblyBudgetFindings(sources) {
  const findings = []
  for (const { file, text } of sources) {
    const lines = text.split('\n').length
    if (lines > ASSEMBLY_FILE_BUDGET)
      findings.push(
        `${file} is ${lines} lines; a plugin source file's budget is ${ASSEMBLY_FILE_BUDGET} — split at a responsibility boundary, never at a line count`,
      )
  }
  const total = sources.reduce((sum, { text }) => sum + text.split('\n').length, 0)
  if (total > ASSEMBLY_TOTAL_BUDGET)
    findings.push(
      `assembly/src is ${total} lines; the plugin's budget is ${ASSEMBLY_TOTAL_BUDGET} — the excess is indirection that only exists because it was convenient`,
    )
  return findings
}

/**
 * Collect declaration values that name domain entities. Prose and command args are excluded.
 */
const DOMAIN_IDENTITY_KEYS = new Set(['criterionId', 'verifier', 'ref', 'path', 'program', 'artifact', 'inputs'])

/** Every name a domain declaration uses, wherever it sits in the document. */
function domainIdentityLiterals(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) domainIdentityLiterals(item, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && DOMAIN_IDENTITY_KEYS.has(key)) found.add(value)
    else if ((key === 'inputs' || key === 'argv') && Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') found.add(item)
    } else domainIdentityLiterals(value, found)
  }
  return found
}

/** The domain declarations this deployment ships, by directory-relative path. */
function domainDeclarations() {
  return treeFiles(join(ROOT, 'deployment', 'domain')).filter(file => file.endsWith('task.json'))
}

/** Domain names belong to loaded declarations, not copies inside assembly source. */
function assemblyDomainFindings(sources) {
  const declarations = domainDeclarations()
  if (declarations.length === 0) return ['no domain declaration under deployment/domain is scanned, so the assembly is checked against nothing']
  const named = new Set()
  for (const file of declarations) {
    const path = join(ROOT, 'deployment', 'domain', file)
    try {
      for (const literal of domainIdentityLiterals(JSON.parse(readFileSync(path, 'utf8')))) named.add(literal)
    } catch (error) {
      return [`deployment/domain/${file} could not be read as a domain declaration (${error instanceof Error ? error.message : String(error)})`]
    }
  }
  const findings = []
  for (const { file, text } of sources)
    for (const literal of named)
      if (text.includes(literal))
        findings.push(
          `${file} names the domain literal ${JSON.stringify(literal)}; a domain is loaded data, and deployment/domain/ is the only place its names may be written`,
        )
  return findings
}

/** When a shipped file was written, or `undefined` when the build never produced it. */
function shippedAt(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/** The plugin's faces, as its manifest promises them: the files a profile mounts. */
function assemblyBuildArtifacts(packageDir = join(ROOT, 'assembly'), ships = shippedAt, sources = assemblySources()) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  return ['.', './agent'].map(face => {
    const exported = manifest.exports?.[face]
    const artifact = typeof exported === 'string' ? exported : exported?.default
    const named = typeof artifact === 'string' ? `assembly${artifact.replace(/^\./, '')}` : `assembly/package.json exports ${face}`
    if (typeof artifact !== 'string')
      return { face, file: named, stale: true, reason: `the manifest does not export ${face}` }
    const shipped = ships(join(packageDir, artifact))
    if (shipped === undefined) return { face, file: named, stale: true, reason: 'the face the manifest exports is not built' }
    const stale = sources.find(source => statSync(join(ROOT, source.file)).mtimeMs > shipped)
    return {
      face,
      file: named,
      stale: stale !== undefined,
      reason: stale === undefined ? '' : `${stale.file} is newer than the bundle a profile would mount`,
    }
  })
}

/** What a real deployment resolves, checked for one thing no other gate can see: is it the current build? */
function assemblyArtifactFindings(artifacts = assemblyBuildArtifacts()) {
  return artifacts
    .filter(artifact => artifact.stale)
    .map(artifact => `${artifact.file} is not the current build for ${artifact.face}: ${artifact.reason}; run 'node assembly/build.mjs'`)
}

/** The evidence's size against the source's, over the same file set the other gates see. */
function evidenceBudgetFindings(files, views, evidence, pluginSources = assemblySources()) {
  const stack = files.filter(file => file.startsWith('src/')).reduce((total, file) => total + views.raw.get(file).split('\n').length, 0)
  // Assembly source belongs in the denominator alongside stack source.
  const source = stack + pluginSources.reduce((total, { text }) => total + text.split('\n').length, 0)
  if (source === 0) return []
  const charged = evidence.reduce((total, entry) => total + entry.lines, 0)
  const ratio = charged / source
  const headroom = Math.floor(EVIDENCE_BUDGET * source) - charged
  return ratio > EVIDENCE_BUDGET
    ? [
        `the evidence is ${charged} lines against ${source} of source (${ratio.toFixed(4)}, budget ${EVIDENCE_BUDGET}); ${-headroom} line(s) have to go — evidence that grows with the source is locking structure, and evidence that grows without it is a check nobody charged for - delete the check that states no external fact - see docs/spec-policy.md`,
      ]
    : []
}

/**
 * Textual expect/it density approximates one behaviour per test; loops can under-report.
 * Script check structure is outside this detector and charged only by line count.
 */
function specDensityFindings(files, views) {
  const findings = []
  for (const file of files) {
    if (!file.startsWith('tests/') || !file.endsWith('.spec.ts')) continue
    const code = views.code.get(file)
    const assertions = (code.match(/\bexpect\s*\(/g) ?? []).length
    const tests = (code.match(/^\s*it(?:\.each)?\s*\(/gm) ?? []).length
    if (tests === 0) continue
    const density = assertions / tests
    if (density > SPEC_DENSITY)
      findings.push(`${file} asserts ${assertions} times in ${tests} test(s) (${density.toFixed(1)} each, budget ${SPEC_DENSITY}); one behaviour is one assertion`)
  }
  return findings
}

/**
 * Compare tree-baseline.json with measured counts. Tests use vitest list --json;
 * an unavailable measurement is a finding.
 */
const TREE_LEDGER = 'tree-baseline.json'

function readTreeLedger() {
  return JSON.parse(readFileSync(join(ROOT, TREE_LEDGER), 'utf8'))
}

/** The test count as vitest collects it: the runner's own port, not a text count of `it(`. */
function collectedTestCount() {
  try {
    const output = execFileSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'list', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    const listed = JSON.parse(output.slice(output.indexOf('['), output.lastIndexOf(']') + 1))
    return Array.isArray(listed) ? listed.length : undefined
  } catch {
    return undefined
  }
}

/** The ledger against this build, both directions. Parameterised so the self-test can hand it a wrong one. */
function treeInventoryFindings(ledger, measured) {
  const counts = ledger?.counts
  if (counts === null || typeof counts !== 'object') return [`${TREE_LEDGER} has no counts object; the numbers documents quote are not in the one place this gate reads`]
  const findings = []
  for (const [name, value] of Object.entries(measured)) {
    if (value === undefined) findings.push(`${name} could not be measured on this build, so ${TREE_LEDGER}'s number for it is unverified; a count nobody could read must not read as one that agreed`)
    else if (!Object.hasOwn(counts, name)) findings.push(`${TREE_LEDGER} records no ${name}; every count in this file is compared with a measurement, so a missing row is a number nothing checks`)
    else if (counts[name] !== value) findings.push(`${TREE_LEDGER} says ${name} is ${counts[name]}; this build measures ${value}. The counts are measured, not entered: state what the measurement says, and never in prose`)
  }
  for (const name of Object.keys(counts)) if (!Object.hasOwn(measured, name)) findings.push(`${TREE_LEDGER} records ${name}, which this gate does not measure; a number with no measurement is the defect this ledger replaced`)
  return findings
}

/** Current documents whose explicit mutation claims are checked against the ledger. */
const CLAIM_DOCS = ['docs/context.md', 'docs/f-evidence.md', 'docs/assembly-g1.md', 'docs/phase-g2-design.md']

function readDocs() {
  return CLAIM_DOCS.map(file => {
    try { return { file, text: readFileSync(join(ROOT, file), 'utf8') } } catch { return { file, text: undefined } }
  })
}

/**
 * Scan README.md and every docs/ markdown file. Declared historical records are exempt
 * only when their opening commit belongs to this repository.
 */
const RECORD_DOCS = new Set([
  'docs/review.md',
  'docs/adversarial-review-2.md',
  'docs/adversarial-review-3.md',
  'docs/adversarial-review-4.md',
  'docs/adversarial-review-5.md',
  'docs/adversarial-review-6.md',
  'docs/adversarial-review-7.md',
  'docs/adversarial-review-8.md',
])
/** A hexadecimal token with at least one letter, used for commit-shaped mentions. */
const COMMIT = /\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/g

/** Every commit this repository holds, for checking a token instead of matching its shape. */
function repositoryCommits() {
  try {
    return new Set(execFileSync('git', ['rev-list', '--all'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean))
  } catch {
    return undefined
  }
}

/** A historical record is anchored by its first commit-shaped token, verified against git. */
function namesHeldCommit(text, commits) {
  const first = (text.match(COMMIT) ?? [])[0]
  return commits !== undefined && first !== undefined && [...commits].some(sha => sha.startsWith(first))
}

/** Every document the count scan reads: this repository's own markdown, not two named files. */
function docPaths() {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.md')) found.push(relative(ROOT, path))
    }
  }
  try { walk(join(ROOT, 'docs')) } catch { /* a repository with no docs/ has no prose to scan */ }
  try { if (statSync(join(ROOT, 'README.md')).isFile()) found.push('README.md') } catch { /* an absent README is not a count claim */ }
  return found.sort()
}

function readCorpus() {
  return docPaths().map(file => {
    try { return { file, text: readFileSync(join(ROOT, file), 'utf8') } } catch { return { file, text: undefined } }
  })
}

/**
 * Recognize prose counts by spelling; the lookbehind excludes section numbers.
 */
const COUNT_CLAIM = /(?<![\w.])\d[\d,]*\s*(?:条\s*)?(?:测试|门禁|spec 文件|个\s*`?\.ts`?\s*文件)|(?<![\w.])\d[\d,]*\s+(?:tests?|gates?|spec files?)\b/

/** A bare file count refers to this tree only when its line names this tree. */
const FILE_CLAIM = /(?<![\w.])\d[\d,]*\s*(?:个\s*)?文件|(?<![\w.])\d[\d,]*\s+files?\b/
const TREE_ON_LINE = /src\/|tests\/|scripts\/|docs\/|singularity-core|README\.md|this tree|this repository|本树|本仓|本仓库|仓库/

/** A fence delimiter: three or more backticks or tildes at the line's first character, and an info string. */
const FENCE = /^(`{3,}|~{3,})(.*)$/
/** The same delimiter with anything before it, which a renderer reads as a code block rather than a fence. */
const INDENTED_FENCE = /^[ \t]+(`{3,}|~{3,})/

/**
 * Skip fenced output and records whose opening commit is held by this repository.
 * Fences must use three unindented characters; longer, indented, invalid or unclosed
 * delimiters are findings. Closing delimiters must match their opener.
 * A commit-shaped token exempts its own line without verifying ownership.
 * Limits: word counts, bare table numbers, unmeasured subjects and files outside the corpus.
 */
function countClaimFindings(docs = readCorpus(), records = RECORD_DOCS, commits = repositoryCommits()) {
  const findings = []
  for (const { file, text } of docs) {
    if (text === undefined) {
      findings.push(`${file} is in the count scan's corpus and cannot be read; every document is read, so a count in one nobody could open would read as one that agreed`)
      continue
    }
    if (records.has(file) && namesHeldCommit(text, commits)) continue
    if (records.has(file))
      findings.push(
        `${file} is declared a record of a past commit and does not open by naming one this repository holds (the first commit it names is the anchor, wherever later lines quote others)${commits === undefined ? " (git could not list this repository's commits, so no record can be verified)" : ''}; a count is a record only of the commit its document opens on, so this document is not a record and its counts are read as this tree's`,
      )
    let open = null
    text.split('\n').forEach((line, index) => {
      // Indented delimiters neither open nor close a fence.
      if (INDENTED_FENCE.test(line))
        findings.push(`${file}:${index + 1} indents a fence delimiter; a renderer reads that as a code block rather than a fence, so it quotes nothing, and honouring it is how the eighth review hid a count behind a balanced indented pair`)
      const fence = FENCE.exec(line)
      if (fence !== null) {
        const delimiter = fence[1]
        // Delimiter characters in the info string make this line a paragraph.
        const malformed = fence[2].includes(delimiter[0])
        if (malformed)
          findings.push(`${file}:${index + 1} opens a ${delimiter[0] === '`' ? 'backtick' : 'tilde'} fence whose info string holds a ${delimiter[0] === '`' ? 'backtick' : 'tilde'}; that line is a paragraph rather than a delimiter, so it quotes nothing and must not exempt what follows`)
        else if (delimiter.length > 3)
          findings.push(`${file}:${index + 1} uses a ${delimiter.length}-character ${delimiter[0] === '`' ? 'backtick' : 'tilde'} fence; this tree quotes output with three, and a longer delimiter is what the seventh review hid a count behind, so spell it as three`)
        if (malformed) return
        if (open === null) open = delimiter
        else if (delimiter[0] === open[0] && delimiter.length >= open.length && fence[2].trim() === '') open = null
        return
      }
      if (open !== null) return
      if (!COUNT_CLAIM.test(line) && !(FILE_CLAIM.test(line) && TREE_ON_LINE.test(line))) return
      if (line.match(COMMIT) !== null) return
      findings.push(`${file}:${index + 1} states a count in prose (${line.trim().slice(0, 60)}); the counts live in ${TREE_LEDGER} and this gate measures them - state it there, or on the line name the commit this one measures`)
    })
    if (open !== null)
      findings.push(`${file} leaves a ${open.length}-character ${open[0]} fence open, so every count after it is read as quoted output; close it with the same character, at least as long`)
  }
  return findings
}

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
 * Check mutation anchors, runnable commands, witnesses and named document claims.
 * Execute commitClaim in a copy of the tree; other claims run only on demand.
 * Commit messages lie outside the claim scan.
 */
const MUTATION_LEDGER = 'mutation-baseline.json'

function readMutationLedger() {
  return JSON.parse(readFileSync(join(ROOT, MUTATION_LEDGER), 'utf8'))
}

/** The one word a document uses to state a mutation result, and the id that must ride with it. */
const MUTATION_CLAIM = /\bcaught\b/i
const MUTATION_ID = /mutate:([a-z0-9][a-z0-9-]*)/g

/** The ledger against the tree and the documents. Parameterised so the self-test can hand it either. */
function mutationClaimFindings(ledger, docs = readDocs(), textOf = file => readFileSync(join(ROOT, file), 'utf8')) {
  const findings = []
  const claims = Array.isArray(ledger?.claims) ? ledger.claims : []
  if (claims.length === 0) return [`${MUTATION_LEDGER} records no claims; a claim that names no script is a claim nobody can run`]
  const ids = new Set()
  for (const claim of claims) {
    const where = `${MUTATION_LEDGER} ${claim?.id ?? '(no id)'}`
    if (typeof claim?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(claim.id)) {
      findings.push(`${where}: every claim needs a stable id a document can name, and this one has none`)
      continue
    }
    if (ids.has(claim.id)) findings.push(`${where}: two claims share this id, so naming it does not say which script runs`)
    ids.add(claim.id)
    if (!['node', 'vitest'].includes(claim.run?.kind) || !Array.isArray(claim.run?.args) || claim.run.args.length === 0)
      findings.push(`${where}: names no runnable command; a claim runs as { "kind": "node" | "vitest", "args": [...] }`)
    else for (const arg of claim.run.args) if (!arg.startsWith('-')) try { statSync(join(ROOT, arg)) } catch { findings.push(`${where}: would run ${arg}, which is not in this tree`) }
    // The vitest any-failure marker cannot identify which rule caught a mutation.
    if (typeof claim.witness !== 'string' || claim.witness === '')
      findings.push(`${where}: names no witness; a caught verdict must be a string the failing run prints, so the catch is of this rule and not of any test that happens to fail`)
    else if (claim.witness === '\u00d7')
      findings.push(`${where}: witnesses the any-failure marker vitest prints before every failed test; that string is satisfied by any failure in the file, so it pins no rule`)
    const edits = Array.isArray(claim.edits) ? claim.edits : []
    if (edits.length === 0) findings.push(`${where}: names no edits, so nothing would be mutated`)
    for (const edit of edits) {
      let text
      try { text = textOf(edit?.file) } catch { text = undefined }
      if (typeof text !== 'string') { findings.push(`${where}: edits ${edit?.file}, which cannot be read, so the claim cannot be applied to this tree`); continue }
      const hits = text.split(edit.find).length - 1
      if (hits !== 1) findings.push(`${where}: ${edit.file} holds ${hits} matches of the text this claim replaces, and exactly one is required; the mutation no longer applies to the tree it claims to attack`)
    }
  }
  for (const { file, text } of docs) {
    if (text === undefined) { findings.push(`${file} is one of the documents that make mutation claims and cannot be read`); continue }
    text.split('\n').forEach((line, index) => {
      const here = [...line.matchAll(MUTATION_ID)].map(match => match[1])
      for (const id of here) { if (!ids.has(id)) findings.push(`${file}:${index + 1} names ${`mutate:${id}`}, which ${MUTATION_LEDGER} does not record; a claim that names no runnable script is a claim nobody can run`) }
      if (MUTATION_CLAIM.test(line) && here.length === 0) findings.push(`${file}:${index + 1} states a mutation result with no runnable claim (${line.trim().slice(0, 60)}); name it as mutate:<id> from ${MUTATION_LEDGER}, or state it in the ledger instead of in prose`)
    })
  }
  return findings
}

/** Execute commitClaim through mutate.mjs and require its caught verdict. */
function mutationRunFindings(ledger, run = verdictOfCommitClaim) {
  const id = ledger?.commitClaim
  if (!(ledger?.claims ?? []).some(claim => claim?.id === id))
    return [`${MUTATION_LEDGER} names no claim to run on every commit (commitClaim: ${JSON.stringify(id ?? null)}); a ledger whose verdicts no gate ever runs is round seven's M1, so the half that reads it runs one`]
  const verdict = run(id)
  return verdict === 'caught' ? [] : [`${MUTATION_LEDGER}'s commitClaim ${id} is not caught by this tree: ${verdict}. A verdict gone stale is the finding, not a reason to stop running one`]
}

/** One claim, run the way a reader would, judged by the line `mutate.mjs` prints for that id. */
function verdictOfCommitClaim(id) {
  try {
    const output = execFileSync(process.execPath, [join(ROOT, 'scripts/mutate.mjs'), id], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 600000 })
    return output.split('\n').some(line => line.trim().startsWith('caught') && line.includes(id)) ? 'caught' : `it exited 0 without printing a caught verdict for ${id}`
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n')
    return `it exited ${typeof error.status === 'number' ? error.status : 1}: ${output.slice(-3).join(' | ').slice(0, 240)}`
  }
}

/** Read KindRule.members: the same value the parse boundary enforces. */
function declaredMembers(rule) {
  return Array.isArray(rule?.members) ? [...rule.members].sort() : undefined
}

/**
 * Locate the nearest src/ declaration frame outside the registry; otherwise use the loaded module.
 */
let LOADING = undefined

function declarationSite() {
  for (const frame of (new Error().stack ?? '').split('\n')) {
    const match = /((?:file:\/\/)?[^\s()]*\/src\/[^\s():]+\.ts):\d+:\d+\)?$/.exec(frame.trim())
    if (match === null) continue
    const site = relative(ROOT, match[1].replace(/^file:\/\//, ''))
    if (site === 'src/protocol/registry.ts') continue
    return site
  }
  return LOADING ?? 'unknown'
}

/** Loading-only host stub: callable and constructable, with non-thenable properties. */
const STUB_PROGRAM = `
const STUB = new Proxy(function () {}, {
  get: (_, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : STUB),
  apply: () => STUB,
  construct: () => STUB,
})
`

/** The source of a module the sweep is about to import, for the specifiers only a text scan can see. */
function sourceOfModule(module) {
  const url = module.url
  if (url.protocol !== 'data:') return readFileSync(url, 'utf8')
  const payload = url.href.slice(url.href.indexOf(',') + 1)
  return /;base64,/.test(url.href) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload)
}

/** Bare package specifiers are host imports; paths and URLs belong to the tree. */
function isHostSpecifier(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')
}

/** Every package specifier a source names — not relative, not a node builtin, not a URL — with its names. */
function hostImportsOf(source, into) {
  const clauses = /\b(?:import|export)\s+([\s\S]{0,600}?)\bfrom\s*(["'])([^"']+)\2/g
  for (const match of source.matchAll(clauses)) {
    if (!isHostSpecifier(match[3])) continue
    const set = into.get(match[3]) ?? new Set()
    const list = /\{([\s\S]*)\}/.exec(match[1])
    if (list !== null)
      for (const entry of list[1].split(',')) {
        const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
        if (name !== undefined && /^[A-Za-z0-9_$]+$/.test(name)) set.add(name)
      }
    into.set(match[3], set)
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g)) {
    if (!isHostSpecifier(match[2])) continue
    if (!into.has(match[2])) into.set(match[2], new Set())
  }
  return into
}

/**
 * Retry unresolved host imports with generated loading stubs. Missing imported names
 * still fail, and a module that remains unloadable becomes a finding.
 */
function registerHostStubs(modules) {
  const specifiers = new Map()
  for (const file of sourceFiles()) if (file.startsWith('src/')) hostImportsOf(readFileSync(join(ROOT, file), 'utf8'), specifiers)
  for (const module of modules) {
    try {
      hostImportsOf(sourceOfModule(module), specifiers)
    } catch {
      // An unreadable module is reported if its import retry fails.
    }
  }
  const stubs = {}
  for (const [specifier, names] of specifiers) {
    const body = `${STUB_PROGRAM}\n${[...names].map(name => `export const ${name} = STUB`).join('\n')}\nexport default STUB\n`
    stubs[specifier] = `data:text/javascript,${encodeURIComponent(body)}`
  }
  const hook = `const STUBS = ${JSON.stringify(stubs)}
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier]
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  // A relative import made from inside a retried module has to be retried too. The first pass already
  // resolved — and cached the *failure* of — every module it walked, so the retry would otherwise
  // re-enter a stub-importing module through an unchanged specifier and meet the first pass's cached
  // error. \`retryUrl\` re-resolves only the module named in the failure, which is why this pass saw a
  // module it had stubbed still reported as unloadable; the marker is what carries the retry inward.
  if (context.parentURL !== undefined && context.parentURL.includes('gate-stub') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const resolved = await next(specifier, context)
    if (resolved.url.startsWith('data:')) return resolved
    const retried = new URL(resolved.url)
    retried.searchParams.set('gate-stub', '1')
    return { ...resolved, url: retried.href }
  }
  return next(specifier, context)
}
`
  register(`data:text/javascript,${encodeURIComponent(hook)}`)
  return [...specifiers.keys()]
}

/** The same module under a URL ESM has not already failed for: a failed import is cached as a failure. */
function retryUrl(url) {
  if (url.protocol === 'data:') return url
  const retried = new URL(url.href)
  retried.searchParams.set('gate-stub', '1')
  return retried
}

/**
 * Observe declarations while importing src/ and calling exported declare*Protocol functions.
 * Read member sets from the rules that enforce them. Unloadable modules are findings.
 * Limits: unreachable non-dot declarations and members inside nested closed shapes.
 */
async function declaredProtocols(
  modules = sourceFiles()
    .filter(file => file.startsWith('src/'))
    .map(file => ({ name: file, url: new URL(`../${file}`, import.meta.url) })),
) {
  const { ProtocolRegistry } = await import(new URL('../src/protocol/registry.ts', import.meta.url).href)
  const observed = []
  const unloaded = []
  const refusals = []
  /** Modules this process could only import with their host packages stubbed, by name. */
  const stubbed = []
  const original = ProtocolRegistry.prototype.declare
  ProtocolRegistry.prototype.declare = function (protocol, version, spec) {
    const published = original.call(this, protocol, version, spec)
    observed.push({
      protocol,
      version,
      site: declarationSite(),
      kinds: Object.entries(spec.kinds).map(([name, rule]) => ({
        name,
        members: declaredMembers(rule),
        nested: rule?.nested === undefined ? undefined : Object.keys(rule.nested).sort(),
      })),
    })
    return published
  }
  /** The names each module actually exports, from the namespace the loader built for it. */
  const exportsByModule = new Map()
  const attempt = async module => {
    LOADING = module.name
    try {
      const loaded = await import(module.url.href)
      // Runtime namespaces include value-export spellings that the text scan misses.
      exportsByModule.set(module.name, Object.keys(loaded).sort())
      return { loaded }
    } catch (error) {
      return { error: `${error?.message ?? error}`.split('\n')[0] }
    } finally {
      LOADING = undefined
    }
  }
  const askDeclarers = (module, loaded) => {
    for (const [name, value] of Object.entries(loaded)) {
      if (!/^declare[A-Z]\w*Protocol$/.test(name) || typeof value !== 'function') continue
      try {
        value(new ProtocolRegistry())
      } catch (error) {
        refusals.push(
          `${module.name}#${name} refused the registry this gate handed it (${`${error?.message ?? error}`.split('\n')[0]}); the inventory calls every exported declarer with an empty registry, so what this one declares is not in the comparison`,
        )
      }
    }
  }
  try {
    const unreachable = []
    for (const module of modules) {
      const outcome = await attempt(module)
      if (outcome.loaded === undefined) unreachable.push({ module, error: outcome.error })
      else askDeclarers(module, outcome.loaded)
    }
    // The modules no load reached, reached with the host packages they name answered by stubs.
    if (unreachable.length > 0) {
      registerHostStubs(unreachable.map(entry => entry.module))
      for (const { module, error } of unreachable) {
        const outcome = await attempt({ name: module.name, url: retryUrl(module.url) })
        if (outcome.loaded === undefined) {
          unloaded.push({ name: module.name, error: `${error} / with host imports stubbed: ${outcome.error}` })
          continue
        }
        stubbed.push(module.name)
        askDeclarers(module, outcome.loaded)
      }
    }
  } finally {
    ProtocolRegistry.prototype.declare = original
    LOADING = undefined
  }

  // Merge repeated declarations by protocol/version and collect all observed sites.
  const byKey = new Map()
  for (const entry of observed) {
    const key = `${entry.protocol}@${entry.version}`
    const merged = byKey.get(key) ?? { protocol: entry.protocol, version: entry.version, kinds: new Map(), sites: new Set() }
    merged.sites.add(entry.site)
    for (const kind of entry.kinds) if (!merged.kinds.has(kind.name)) merged.kinds.set(kind.name, kind)
    byKey.set(key, merged)
  }
  const order = (left, right) => (left.protocol < right.protocol ? -1 : left.protocol > right.protocol ? 1 : left.version - right.version)
  const declared = [...byKey.values()]
    .map(entry => ({
      protocol: entry.protocol,
      version: entry.version,
      kinds: [...entry.kinds.values()].sort((left, right) => (left.name < right.name ? -1 : 1)),
    }))
    .sort(order)
  const sites = [...byKey.values()]
    .flatMap(entry => [...entry.sites].map(site => ({ site, protocol: entry.protocol, version: entry.version, kinds: [...entry.kinds.keys()].sort() })))
    .sort((left, right) => (left.site < right.site ? -1 : left.site > right.site ? 1 : order(left, right)))
  return { declared, sites, unloaded, stubbed, refusals, exports: exportsByModule }
}

/** Report modules still unloadable after host stubbing; declaration coverage is incomplete. */
function unobservableDeclarations(unloaded) {
  return unloaded.map(
    ({ name, error }) =>
      `${name} could not be imported even with its host imports stubbed (${error}); a declaration in it is not observed, and the text net over it matches the dot spelling only, which round three walked through with X['declare'](…) — make the module loadable, or declare the shape in a module this sweep reaches`,
  )
}

/** Protocol declarations must live in their slice's protocol.ts. */
function declarationSiteFindings(sites) {
  const findings = []
  for (const { site, protocol, version, kinds } of sites) {
    if (/(^|\/)protocol\.ts$/.test(site)) continue
    findings.push(`${site} declares ${protocol}@${version} (${kinds.join(', ')}) without being a slice's protocol.ts; a shape declared here is one no reader looks for`)
  }
  return findings
}

/**
 * Count dot-spelled declarations against observations at each source site.
 * Other spellings and surplus observations through exported declarers remain outside this net.
 */
function unaccountedDeclarationFindings(files, observedBySite, read = file => readFileSync(join(ROOT, file), 'utf8')) {
  const findings = []
  for (const file of files) {
    if (!file.startsWith('src/')) continue
    const text = declarationTextSites(codeOnly(read(file)))
    const observed = observedBySite.get(file) ?? 0
    if (text > observed)
      findings.push(
        `${file} spells ${text} declaration(s) in the dot form and this run observed ${observed} at that site; the surplus is a declaration no load reached, and the text net sees the dot spelling only — a declaration belongs in a slice's protocol.ts, where the sweep sees it whatever it is called`,
      )
  }
  return findings
}

/** How many declarations one file's code spells in the dot form — the form this net can see. */
function declarationTextSites(code) {
  return (code.match(/\.declare\s*[<(]/g) ?? []).length
}

/** Compare declared protocols, versions, kinds and payload members with the ledger both ways. */
function inventoryFindingsWith(ledger, declared) {
  const rows = Array.isArray(ledger?.protocols) ? ledger.protocols : []
  const key = entry => `${entry.protocol}@${entry.version}`
  const listed = new Map(rows.map(row => [key(row), row]))
  const findings = []

  for (const entry of declared) {
    const row = listed.get(key(entry))
    const where = key(entry)
    if (row === undefined) {
      findings.push(`${where} is declared by the code but no ${PROTOCOL_LEDGER} row names it; adding a shape is a recorded act, so record who produces it and who reads it`)
      continue
    }
    const named = new Map()
    const bare = []
    for (const kind of row.kinds ?? []) {
      if (typeof kind === 'string') {
        bare.push(kind)
        named.set(kind, { name: kind })
      } else named.set(kind.name, kind)
    }
    // Bare kind names omit the required payload member inventory.
    if (bare.length > 0)
      findings.push(
        `${where}'s ledger row lists ${bare.join(', ')} as a bare name, which is the shape that could not see a payload member change; a kind's row is { "name": …, "members": [ … ] }`,
      )
    const declaredNames = entry.kinds.map(kind => kind.name)
    for (const kind of entry.kinds) {
      const line = named.get(kind.name)
      if (line === undefined) {
        findings.push(`${where} declares ${kind.name}, which its ledger row does not list`)
        continue
      }
      if (bare.includes(kind.name)) continue
      if (!Array.isArray(line.members)) {
        findings.push(`${where} ${kind.name}'s ledger row has no member set; a payload member is part of the declared shape, so the row lists the members the parser accepts`)
        continue
      }
      findings.push(...shapeFindings(where, kind, line))
    }
    const extra = [...named.keys()].filter(name => !declaredNames.includes(name))
    if (extra.length > 0) findings.push(`${where}'s ledger row lists ${extra.join(', ')}, which the code does not declare`)
    for (const field of ['subject', 'producedBy', 'readBy'])
      if (typeof row[field] !== 'string' || row[field].length === 0)
        findings.push(`${where}'s ledger row has no ${field}; a shape with no named producer or reader is how the previous system grew 197 unreferenced exports`)
  }

  for (const row of rows) {
    if (!declared.some(entry => key(entry) === key(row)))
      findings.push(`${PROTOCOL_LEDGER} names ${key(row)}, which no code declares`)
  }
  return findings
}

/** Compare a kind's enforced member set with its ledger row; missing declarations are findings. */
function shapeFindings(where, kind, line) {
  if (!Array.isArray(kind.members))
    return [
      `${where} ${kind.name} declares no payload member set, so the ledger cannot be compared with what the parse boundary enforces; a kind declares its closed members once, through defineKind`,
    ]
  if (kind.nested === undefined)
    return [
      `${where} ${kind.name} declares its payload members and says nothing about the closed shapes inside them; declare it as {}, so a kind that closes no inner shape says so and one that closes a shape names it`,
    ]
  const declared = [...kind.members].sort()
  const listed = [...line.members].sort()
  const missing = declared.filter(member => !listed.includes(member))
  const extra = listed.filter(member => !declared.includes(member))
  const findings = []
  if (missing.length > 0)
    findings.push(
      `${where} ${kind.name} declares the payload member(s) ${missing.join(', ')}, which its ledger row does not list; a payload member is part of the declared shape, so adding one is a version bump and a recorded act`,
    )
  if (extra.length > 0)
    findings.push(`${where} ${kind.name}'s ledger row lists the payload member(s) ${extra.join(', ')}, which the parser does not accept; the ledger records the shape that exists`)
  return findings
}

/** Filled by the gate before it scans; the inventory cannot be a one-way check without it. */
let DECLARED = []

/** Compare installed packages, declared peers and absolute paths with the DSH baseline. */
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
    // Any absolute path into a `node_modules/@deepseek-ai` scope, whatever its parent layout: the
    // baseline root is the private environment (`docs/standalone-dsh.md`), a plain npm install that
    // does not carry the global install's `@deepseek-ai/dsh/node_modules` nesting.
    const paths = source.match(/\/[A-Za-z0-9_./-]*node_modules\/@deepseek-ai/g) ?? []
    if (paths.length === 0) findings.push(`${file} names no DSH install path; it cannot be aligned to ${baseline.dshVersion}`)
    for (const path of new Set(paths)) {
      if (path !== declaredRoot) findings.push(`${file} points at ${path}, not the baseline install root ${declaredRoot}`)
    }
  }

  return findings
}

/** Run a behavioural script and read its exact verdict markers. */
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
  // Keep enough failing output to include checks alongside server progress.
  const tail = `${output}`.trim().split('\n').slice(-15).join(' | ')
  for (const marker of markers) {
    if (!`${output}`.includes(marker)) findings.push(`${label} did not report ${JSON.stringify(marker)}: ${tail}`)
  }
  if (status !== 0) findings.push(`${label} exited ${status}: ${tail}`)
  return findings
}

function runScript(name, args = []) {
  return root => execFileSync(process.execPath, [name, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Lazily copy the tree without src/; remove it when this process exits. */
function mirrorWithoutSource() {
  const mirror = mkdtempSync(join(tmpdir(), 'gates-mirror-'))
  cpSync(ROOT, mirror, {
    recursive: true,
    filter: source => !source.split(sep).includes('node_modules') && !source.split(sep).includes('.git'),
  })
  symlinkSync(join(ROOT, 'node_modules'), join(mirror, 'node_modules'))
  renameSync(join(mirror, 'src'), join(mirror, 'src-absent'))
  return mirror
}

/** The mirror, built on first use: `--probe` never runs the real scripts, so it never needs one. */
let MIRROR = undefined
function loadBearingMirror() {
  MIRROR ??= mirrorWithoutSource()
  return MIRROR
}
process.on('exit', () => {
  if (MIRROR !== undefined) rmSync(MIRROR, { recursive: true, force: true })
})

/**
 * A script must fail without src/. This rejects constant verdicts but cannot distinguish
 * real judgement from a script that merely checks whether src/ exists.
 */
function notLoadBearingFindings(label, markers, script, root, args = []) {
  let output
  let status = 0
  try {
    output = runScript(script, args)(root)
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : 1
    output = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`
  }
  if (status !== 0) return []
  if (!markers.every(marker => `${output}`.includes(marker))) return []
  return [
    `${label} reported ${markers.map(marker => JSON.stringify(marker)).join(' and ')} with exit 0 against a copy of the tree with src/ removed, so its verdict does not depend on the tree it claims to judge: a script that reports a constant is indistinguishable from a comparison by a substring, and this gate's verdict therefore means nothing until the script can report something else`,
  ]
}

/** Run every detector over one file set and report per gate. */
function scan(files, views) {
  return DETECTORS.map(({ name, detect }) => ({ name, findings: detect(files, views) }))
}

/** Synthetic violations include exports mentioned only in comments, which are not uses. */
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
  const lazily = await import('node:fs/promises')
  const hidden = await import('a/specifier/the/gate/cannot/read')
  await lazily.writeFile(path, hidden, 'utf8')
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
  // Both exemptions are declared where the detector is, so this filter cannot drift from the list.
  const scored = DETECTORS.filter(detector => detector.realTree !== true && detector.probeSeparately !== true)
  const results = scored.map(({ name, detect }) => ({ name, findings: detect(files, { raw, code }) }))
  let missed = 0
  console.log('gate self-test: every detector must fire on one violating file\n')
  // Every gate this file set cannot score is named: skipped here and unnamed reads as passed.
  const notScored = DETECTORS.filter(detector => detector.realTree === true || detector.probeSeparately === true).map(detector => detector.name)
  console.log(`  (not run here: ${notScored.join(', ')}; synthetic failing runs below)\n`)
  for (const { name, findings } of results) {
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${name} did not fire`)
    } else {
      console.log(`  ok    ${name} fired (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    }
  }
  // The arithmetic gates are handed a file set that breaks them: otherwise they are unwatched numbers.
  for (const [name, files, raw, evidence] of [
    [
      'evidence-budget',
      ['src/a.ts', 'tests/a.spec.ts'],
      new Map([
        ['src/a.ts', 'export const a = 1\n'],
        ['tests/a.spec.ts', Array.from({ length: 20 }, () => 'expect(1).toBe(1)').join('\n')],
      ]),
      [
        { file: 'tests/a.spec.ts', lines: 20 },
        { file: 'tests/fixtures/a.json', lines: 40 },
        { file: 'scripts/a.mjs', lines: 60 },
      ],
    ],
    [
      'spec-density',
      ['tests/a.spec.ts'],
      new Map([['tests/a.spec.ts', `it('a', () => {\n${Array.from({ length: 12 }, () => '  expect(1).toBe(1)').join('\n')}\n})\n`]]),
      undefined,
    ],
  ]) {
    const detect = DETECTORS.find(detector => detector.name === name).detect
    const findings = name === 'evidence-budget'
      ? evidenceBudgetFindings(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) }, evidence, [])
      : detect(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) })
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${name} did not fire on a file set that breaks it`)
    } else {
      console.log(`  ok    ${name} fired (${findings.length} findings)`)
    }
  }

  // Exercise assembly source budgets and names taken from the real domain declaration.
  const paddedPluginFile = Array.from({ length: ASSEMBLY_FILE_BUDGET + 5 }, (_, index) => `// padding ${index}`).join('\n')
  const declaredDomainNames =
    domainDeclarations().length === 0
      ? []
      : [...domainIdentityLiterals(JSON.parse(readFileSync(join(ROOT, 'deployment', 'domain', domainDeclarations()[0]), 'utf8')))]
  for (const [name, findings] of [
    [
      'assembly-budget',
      assemblyBudgetFindings([
        { file: 'assembly/src/__probe.ts', text: paddedPluginFile },
        { file: 'assembly/src/__probe_two.ts', text: paddedPluginFile },
        { file: 'assembly/src/__probe_three.ts', text: paddedPluginFile },
        { file: 'assembly/src/__probe_four.ts', text: paddedPluginFile },
      ]),
    ],
    [
      'assembly-domain-free',
      declaredDomainNames.length === 0
        ? []
        : assemblyDomainFindings([{ file: 'assembly/src/__probe.ts', text: `const named = ${JSON.stringify(declaredDomainNames[0])}\n` }]),
    ],
  ]) {
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${name} did not fire on a file set that breaks it`)
    } else {
      console.log(`  ok    ${name} fired (${findings.length} findings)`)
    }
  }

  // Exercise absent manifest exports, missing bundles and bundles older than their sources.
  const buildProbe = mkdtempSync(join(tmpdir(), 'gates-built-'))
  mkdirSync(join(buildProbe, 'lib'), { recursive: true })
  writeFileSync(join(buildProbe, 'lib', 'index.js'), 'export const x = 1\n')
  // The stale leg needs a bundle older than the source it claims to have been built from.
  utimesSync(join(buildProbe, 'lib', 'index.js'), new Date(0), new Date(0))
  const sourcePath = join(ROOT, 'assembly', 'src', 'ids.ts')
  const newer = () => statSync(sourcePath).mtimeMs + 60000
  writeFileSync(join(buildProbe, 'package.json'), `${JSON.stringify({ exports: { '.': { default: './lib/index.js' }, './agent': { default: './lib/missing.js' } } })}\n`)
  const bounded = [{ face: '.', file: 'x', stale: true, reason: 'r' }]
  for (const [label, artifacts] of [
    ['a manifest whose face is not built', assemblyBuildArtifacts(buildProbe, path => (path.endsWith('missing.js') ? undefined : statSync(path).mtimeMs), [])],
    ['a bundle older than a source it was built from', assemblyBuildArtifacts(buildProbe, () => statSync(join(buildProbe, 'lib', 'index.js')).mtimeMs, [{ file: 'assembly/src/ids.ts', text: 'a source the bundle predates' }])],
    ['a synthetic stale pair, so the filter itself is exercised', bounded],
  ]) {
    const findings = assemblyArtifactFindings(artifacts)
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  assembly-built did not fire on ${label}`)
    } else {
      console.log(`  ok    assembly-built fired (${findings.length} findings)`)
    }
  }
  rmSync(buildProbe, { recursive: true, force: true })

  // The tree ledger and the prose scan, one leg per boundary, watched either firing or staying silent.
  const treeMeasured = { sourceFiles: 2, specFiles: 1, tests: 5, gates: 2 }
  for (const [label, ledger, measured] of [
    ['a count that disagrees with the measurement', { counts: { ...treeMeasured, tests: 4 } }, treeMeasured],
    ['a count the ledger does not record', { counts: { sourceFiles: 2, specFiles: 1, gates: 2 } }, treeMeasured],
    ['a count the ledger records and nothing measures', { counts: { ...treeMeasured, probes: 8 } }, treeMeasured],
    ['a measurement that could not be taken', { counts: treeMeasured }, { ...treeMeasured, tests: undefined }],
  ]) {
    const findings = treeInventoryFindings(ledger, measured)
    if (findings.length === 0) { missed += 1; console.log(`  FAIL  tree-inventory did not fire on ${label}`) }
    else console.log(`  ok    tree-inventory fired on ${label} (${findings.length} findings)`)
  }
  const probeRecord = new Set(['docs/__probe-review.md'])
  const probeCommits = new Set([`e8c1c70${'0'.repeat(33)}`])
  for (const [label, docs, expected] of [
    ['a document stating a gate count in prose', [{ file: 'docs/__probe.md', text: 'the tree has 12 gates today\n' }], 1],
    ['a document stating none', [{ file: 'docs/__probe.md', text: `the counts live in ${TREE_LEDGER}\n` }], 0],
    ['a section heading numbered 6.4, which is not a count of 4 gates', [{ file: 'docs/__probe.md', text: '## 6.4 门禁清单\n' }], 0],
    ['a count inside a fenced block, which is quoted output', [{ file: 'docs/__probe.md', text: '```\ngates: 11 gates over 42 files\n```\n' }], 0],
    ['a fence left open, which would exempt the rest of the document', [{ file: 'docs/__probe.md', text: '```\ngates: OK — 11 gates passed\n' }], 1],
    ['a count whose line names the commit it measures', [{ file: 'docs/__probe.md', text: 'at `e8c1c70` the tree had 10 gates\n' }], 0],
    ['a count on a line whose long number is not a commit', [{ file: 'docs/__probe.md', text: 'the tree has 12 gates, measured 20261010\n' }], 1],
    ['a bare file count that does not name a tree', [{ file: 'docs/__probe.md', text: '4 files were misread in one revision\n' }], 0],
    ['a bare file count that names this tree', [{ file: 'docs/__probe.md', text: 'this tree has 15 files\n' }], 1],
    ['a count inside a balanced `~~~` fence, which is a delimiter too', [{ file: 'docs/__probe.md', text: '~~~\ngates: 11 gates over 42 files\n~~~\n' }], 0],
    ['a `~~~` fence left open', [{ file: 'docs/__probe.md', text: '~~~\ngates: 11 gates over 42 files\n' }], 1],
    ['a four-backtick fence closed by a three-backtick line, which B1 hid a count behind', [{ file: 'docs/__probe.md', text: '````\ngates: 11 gates over 42 files\n```\n' }], 2],
    ['a balanced four-backtick fence, refused by name rather than honoured', [{ file: 'docs/__probe.md', text: '````\ngates: 11 gates over 42 files\n````\n' }], 2],
    // Indented delimiters are findings and cannot hide the enclosed count.
    ['a balanced pair of indented fences round a count, which is a code block in every renderer', [{ file: 'docs/__probe.md', text: '    ```\n    gates: 11 gates over 42 files\n    ```\n' }], 3],
    ['a tab-indented fence delimiter, indented by the other character that does it', [{ file: 'docs/__probe.md', text: '\t```\ngates: 11 gates over 42 files\n```\n' }], 3],
    // Invalid info strings neither open nor close a fence.
    ['an info string holding a backtick, which CommonMark reads as a paragraph rather than a fence', [{ file: 'docs/__probe.md', text: '``` `x\ngates: 11 gates over 42 files\n```\n' }], 3],
    ['an info string holding a tilde on a tilde fence, the same rule for the other delimiter', [{ file: 'docs/__probe.md', text: '~~~ ~x\ngates: 11 gates over 42 files\n~~~\n' }], 3],
    ['a declared record that names a commit this repository holds', [{ file: 'docs/__probe-review.md', text: 'measured at `e8c1c70`: 21 gates\n' }], 0],
    // A later held commit cannot anchor a record that opens on a foreign commit.
    ['a declared record that opens on a foreign commit and only later names a held one', [{ file: 'docs/__probe-review.md', text: 'measured at `be50316` first, then `e8c1c70`: 21 gates\n' }], 1],
    ['a declared record that names only a token no repository holds', [{ file: 'docs/__probe-review.md', text: 'measured at `deadbeefcafe1234`: 21 gates\n' }], 1],
    ['a declared record that names no commit at all', [{ file: 'docs/__probe-review.md', text: 'the tree had 21 gates\n' }], 2],
    ['a document in the corpus that cannot be read', [{ file: 'docs/__probe.md', text: undefined }], 1],
  ]) {
    const findings = countClaimFindings(docs, probeRecord, probeCommits)
    if (findings.length === expected) console.log(`  ok    tree-inventory handled ${label} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    else { missed += 1; console.log(`  FAIL  tree-inventory reported ${findings.length} findings on ${label}, expected ${expected}: ${findings.join(' | ')}`) }
  }

  // Exercise script charging across extensions, hidden names and nested directories.
  const probeScripts = mkdtempSync(join(tmpdir(), 'gates-scripts-'))
  mkdirSync(join(probeScripts, 'probes'), { recursive: true })
  mkdirSync(join(probeScripts, '.probes'), { recursive: true })
  for (const file of ['top.mjs', 'zz-big.js', 'zz-big.cjs', 'zz-big.ts', 'notes.txt', 'probes/zz-big.mjs', '.probes/zz-big.mjs'])
    writeFileSync(join(probeScripts, ...file.split('/')), '')
  const charged = scriptFiles(probeScripts).map(file => file.split('/').slice(-2).join('/'))
  if (charged.length === 7 && charged.includes('.probes/zz-big.mjs') && charged.includes('zz-big.js') && charged.includes('notes.txt'))
    console.log(`  ok    evidence-budget charges every file under scripts/, whatever its name or suffix (${charged.join(', ')})`)
  else { missed += 1; console.log(`  FAIL  evidence-budget left a file uncharged: ${JSON.stringify(charged)}`) }
  rmSync(probeScripts, { recursive: true, force: true })

  // The ledger is checked against a tree it does not match, documents naming nothing, both directions.
  const probeMutations = { claims: [{ id: 'probe-claim', rule: 'the probe rule', witness: 'failed', run: { kind: 'node', args: ['scripts/gates.mjs', '--probe'] }, edits: [{ file: 'package.json', find: '"private": true', replace: '"private": false' }] }] }
  const anchored = { 'package.json': '{"private": true}\n' }
  for (const [label, docs, texts, expected] of [
    ['a claim a document names whose edits still apply', [{ file: 'docs/x.md', text: 'caught `mutate:probe-claim`\n' }], anchored, 0],
    ['a claim whose edit no longer applies to the tree', [{ file: 'docs/x.md', text: 'caught `mutate:probe-claim`\n' }], { 'package.json': '{"private": false}\n' }, 1],
    ['a result stated with no runnable script', [{ file: 'docs/x.md', text: 'caught `mutate:probe-claim`\nnineteen mutations were caught\n' }], anchored, 1],
    ['a runnable ledger entry without copying its id into prose', [{ file: 'docs/x.md', text: 'no claims here\n' }], anchored, 0],
  ]) {
    const findings = mutationClaimFindings(probeMutations, docs, file => texts[file])
    if (findings.length === expected) console.log(`  ok    mutation-claims handled ${label} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    else { missed += 1; console.log(`  FAIL  mutation-claims reported ${findings.length} findings on ${label}, expected ${expected}: ${findings.join(' | ')}`) }
  }

  // A witness must identify the rule rather than any failure in the file.
  const weakWitness = { claims: [{ ...probeMutations.claims[0], witness: '\u00d7' }] }
  const weak = mutationClaimFindings(weakWitness, [{ file: 'docs/x.md', text: 'caught `mutate:probe-claim`\n' }], file => anchored[file])
  if (weak.length === 1) console.log(`  ok    mutation-claims refuses a claim whose witness is the any-failure marker (${weak.length} finding)`)
  else { missed += 1; console.log(`  FAIL  mutation-claims took an any-failure witness: ${weak.join(' | ')}`) }
  // Exercise both caught and stale execution verdicts, independently of anchor validity.
  const probeRun = { commitClaim: 'probe-claim', claims: probeMutations.claims }
  for (const [label, ledger, run, expected] of [
    ['the claim this gate runs on every commit, caught', probeRun, () => 'caught', 0],
    ['that claim gone stale, which is the finding M1 recorded', probeRun, () => 'the command passed under the mutation', 1],
    ['a ledger that names no claim to run', { ...probeRun, commitClaim: undefined }, () => 'caught', 1],
    ['a ledger naming a claim it does not record', { ...probeRun, commitClaim: 'no-such-claim' }, () => 'caught', 1],
  ]) {
    const findings = mutationRunFindings(ledger, run)
    if (findings.length === expected) console.log(`  ok    mutation-claims handled ${label} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    else { missed += 1; console.log(`  FAIL  mutation-claims reported ${findings.length} findings on ${label}, expected ${expected}: ${findings.join(' | ')}`) }
  }

  // Pin what codeOnly hides and preserves, including exact length and line breaks.
  const STRIPPER_CASES = [
    ['an escaped quote and a `//` inside a string', String.raw`const a = 'it\'s // "fine"'` + '\n', 'fine', 'const a'],
    ['a `/*` and an escaped `"` inside a string', String.raw`const b = "a \"b\" /* c"` + '\n', 'c"', 'const b'],
    ['a quote inside a line comment', 'const c = 1 // don\'t "quote" me\n', 'quote', 'const c'],
    ['a quote inside a block comment', '/* it\'s "fine" */ const d = 2\n', 'fine', 'const d'],
    ['a `//` and a quote inside a template literal', 'const e = `a // b /* c */ one\'s`\n', "one's", 'const e'],
    ['a backslash at the end of a line inside a template literal', 'const f = `one \\\ntwo`\n', 'two', 'const f'],
    ['the counterexample: a `//` in a template whose backtick closes on the same line', 'write(`${PROGRAM}// rebuilt\n`, 1)\nconst survivor = 1\n', 'rebuilt', 'survivor'],
    ['an unterminated block comment on the last line', 'const g = 3\n/* never closed\n', 'closed', 'const g'],
    ['an unterminated template literal on the last line', 'const h = `never closed\n', 'closed', 'const h'],
    ['a template whose last character is a backslash', 'const k = `never closed \\', 'never', 'const k'],
    ['an unterminated single quote, which is not a string', "const i = don't\nconst survivor2 = 1 // trailing\n", 'trailing', 'survivor2'],
    ['nested-looking delimiters', 'const j = "a \'b\' `c` // d" /* "e" */ `f \'g\'`\n', '"e"', 'const j'],
  ]
  let stripperBreaks = 0
  for (const [label, input, hidden, kept] of STRIPPER_CASES) {
    const stripped = codeOnly(input)
    const faults = []
    if (stripped.length !== input.length) faults.push(`${input.length} characters in, ${stripped.length} out`)
    if (stripped.split('\n').length !== input.split('\n').length) faults.push('the line breaks moved')
    if (stripped.includes(hidden)) faults.push(`${JSON.stringify(hidden)} survived`)
    if (!stripped.includes(kept)) faults.push(`${JSON.stringify(kept)} was stripped with it`)
    if (faults.length === 0) continue
    missed += 1
    stripperBreaks += 1
    console.log(`  FAIL  codeOnly on ${label}: ${faults.join('; ')}`)
  }
  if (stripperBreaks === 0)
    console.log(`  ok    codeOnly held its contract on ${STRIPPER_CASES.length} nasty inputs (length, line breaks, what must go, what must stay)`)

  // Exercise every durability branch, including allowed non-filesystem literal imports.
  for (const [label, source, expected, use = `import { load } from './__probe_import.ts'\nexport const used = load\n`] of [
    ['a dynamic import of a filesystem module', `export const load = async () => (await import('node:fs/promises')).writeFile\n`, 1],
    // Re-exports can expose writers without an import clause.
    ['a write re-exported from a filesystem module and performed through a forwarding import', `export { writeFile } from 'node:fs/promises'\n`, 1, `import { writeFile } from './__probe_import.ts'\nawait writeFile('x', 'y')\n`],
    ['a whole module re-exported from a filesystem module', `export * from 'node:fs/promises'\n`, 1],
    ['a default binding of a filesystem module, refused whole', `import fs from 'node:fs/promises'\nexport const read = fs.readFile\n`, 1],
    ['a read-only name re-exported from a filesystem module, which the rule allows', `export { readFile } from 'node:fs/promises'\n`, 0],
    ['a general process executor, refused whole', `import { execFileSync } from 'node:child_process'\nexport const run = execFileSync\n`, 1],
    ['a builtin module fetched by name, past every import clause', `export const write = process.getBuiltinModule('node:fs/promises').writeFile\n`, 1],
    ['a dynamic import whose target the gate cannot read', 'export const load = async target => await import(target)\n', 1],
    ['a dynamic import of a module that is not a filesystem one', `export const load = async () => await import('./helper.ts')\n`, 0],
    ['a filesystem module spelled as a concatenation of two literals', `export const load = async () => (await import('node:' + 'fs/promises')).writeFile\n`, 1],
    ['a filesystem module spelled as a template literal', 'export const load = async () => (await import(`node:fs/promises`)).writeFile\n', 1],
    // These capabilities can write while modules are loaded.
    ['a module loader built with createRequire, which no import rule can read', "import { createRequire } from 'node:module'\nexport const load = () => createRequire(import.meta.url)('node:fs/promises').writeFile\n", 1],
    ['a read-only filesystem import, which is what the rule allows', "import { readFile } from 'node:fs/promises'\nexport const read = readFile\n", 0],
  ]) {
    const probeFiles = ['src/__probe_import.ts', 'src/__probe_import_use.ts']
    const probeRaw = new Map([
      [probeFiles[0], source],
      [probeFiles[1], use],
    ])
    const findings = DETECTORS.find(detector => detector.name === 'src-names-no-durable-write').detect(probeFiles, {
      raw: probeRaw,
      code: new Map([...probeRaw].map(([file, text]) => [file, codeOnly(text)])),
    })
    if (findings.length === expected) {
      console.log(`  ok    src-names-no-durable-write handled ${label} (${expected} finding${expected === 1 ? '' : 's'})`)
    } else {
      missed += 1
      console.log(`  FAIL  src-names-no-durable-write reported ${findings.length} findings on ${label}, expected ${expected}`)
    }
  }

  // Exercise real bindings, forwarding barrels, published records and compiled JS specifiers.
  for (const [label, user, expected] of [
    ['an export whose name occurs elsewhere only as a member', `export const holder = { orphan: 2 }\n`, 1],
    ['the same export, bound by an import', `import { orphan } from './__probe_export.ts'\nexport const used = orphan\n`, 0],
    ['the same export bound through a `.js` specifier, which is what tsc resolves', `import { orphan } from './__probe_export.js'\nexport const used = orphan\n`, 0],
    ['the same export re-exported by a module that is itself unused, which is not a use', `export { orphan } from './__probe_export.ts'\n`, 1],
  ]) {
    const probeFiles = ['src/__probe_export.ts', 'src/__probe_export_user.ts']
    const probeRaw = new Map([
      [probeFiles[0], `export const orphan = 1\nexport const other = 2\n`],
      [probeFiles[1], user],
    ])
    const findings = unreferencedExportFindings(probeFiles, {
      raw: probeRaw,
      code: new Map([...probeRaw].map(([file, text]) => [file, codeOnly(text)])),
    }, new Set())
    const orphans = findings.filter(finding => finding.includes('orphan'))
    if (orphans.length === expected) {
      console.log(`  ok    no-unreferenced-export handled ${label} (${expected} finding${expected === 1 ? '' : 's'})`)
    } else {
      missed += 1
      console.log(`  FAIL  no-unreferenced-export reported ${orphans.length} findings on ${label}, expected ${expected}`)
    }
  }
  // The barrel legs with the entry point named, the published-surface record as the only excuse.
  for (const [label, recorded, expected] of [
    ['a name the entry point publishes that nothing binds, recorded as published', new Set(['src/__probe_export.ts\0orphan']), 0],
    ['the same name, not recorded', new Set(), 1],
    ['a recorded name that another module now binds', new Set(['src/__probe_export.ts\0orphan', 'src/__probe_export.ts\0other']), 1],
    ['a recorded name the entry point no longer publishes', new Set(['src/__probe_export.ts\0orphan', 'src/__probe_gone.ts\0gone']), 1],
  ]) {
    const probeFiles = ['src/index.ts', 'src/__probe_export.ts', 'src/__probe_export_user.ts']
    const probeRaw = new Map([
      [probeFiles[0], `export { orphan } from './__probe_export.ts'\n`],
      [probeFiles[1], `export const orphan = 1\nexport const other = 2\n`],
      [probeFiles[2], `import { other } from './__probe_export.ts'\nvoid other\n`],
    ])
    const findings = unreferencedExportFindings(probeFiles, {
      raw: probeRaw,
      code: new Map([...probeRaw].map(([file, text]) => [file, codeOnly(text)])),
    }, recorded)
    if (findings.length === expected) {
      console.log(`  ok    no-unreferenced-export handled ${label} (${expected} finding${expected === 1 ? '' : 's'})`)
    } else {
      missed += 1
      console.log(`  FAIL  no-unreferenced-export reported ${findings.length} findings on ${label}, expected ${expected}: ${findings.join(' | ')}`)
    }
  }

  // Runtime export spellings must be counted; entry-point imports do not establish use.
  for (const [label, source, runtime, user, barrel, expected] of [
    ['both declarators of one export statement, which the text scan read as one', 'export const a = 1, b = 2\n', ['a', 'b'], '', false, 2],
    ['a default export, whose name is not written after the keyword', 'export default 1\n', ['default'], '', false, 1],
    ['a destructuring export, whose names are inside the pattern', 'export const {a, b} = { a: 1, b: 2 }\n', ['a', 'b'], '', false, 2],
    ['the entry point importing the dead export, which no consumer can reach', 'export const orphan = 1\n', ['orphan'], `import { orphan } from './__probe_export.ts'\nvoid orphan\n`, true, 1],
    ['the same import in a module that is not the entry point', 'export const orphan = 1\n', ['orphan'], `import { orphan } from './__probe_export.ts'\nvoid orphan\n`, false, 0],
  ]) {
    const entry = barrel ? 'src/index.ts' : 'src/__probe_export_user.ts'
    const probeFiles = [entry, 'src/__probe_export.ts']
    const probeRaw = new Map([
      [entry, user],
      ['src/__probe_export.ts', source],
    ])
    const findings = unreferencedExportFindings(
      probeFiles,
      { raw: probeRaw, code: new Map([...probeRaw].map(([file, text]) => [file, codeOnly(text)])) },
      new Set(),
      new Map([['src/__probe_export.ts', runtime]]),
    )
    if (findings.length === expected) {
      console.log(`  ok    no-unreferenced-export reported ${findings.length} finding${findings.length === 1 ? '' : 's'} on ${label}`)
    } else {
      missed += 1
      console.log(`  FAIL  no-unreferenced-export reported ${findings.length} findings on ${label}, expected ${expected}: ${findings.join(' | ')}`)
    }
  }

  // Exercise mismatches in protocols, versions, kinds and payload member sets.
  const probeLedger = kinds => ({ protocols: [{ protocol: 'probe', version: 1, subject: 's', producedBy: 'p', readBy: 'r', kinds }] })
  const probeDeclared = members => [{ protocol: 'probe', version: 1, kinds: [{ name: 'probe/kind', members }] }]
  const probeKinds = [
    { name: 'probe/kind', members: ['alpha', 'beta'] },
    { name: 'never/declared', members: [] },
  ]
  for (const [label, ledger, declared] of [
    ['a kind the code declares but the ledger omits', probeLedger([]), probeDeclared(['alpha', 'beta'])],
    ['a member the code declares but the ledger omits', probeLedger([{ name: 'probe/kind', members: ['alpha'] }]), probeDeclared(['alpha', 'beta'])],
    ['a member the ledger lists but the code does not declare', probeLedger([{ name: 'probe/kind', members: ['alpha', 'beta', 'ghost'] }]), probeDeclared(['alpha', 'beta'])],
    ['a kind the ledger lists but the code does not declare', probeLedger(probeKinds), probeDeclared(['alpha', 'beta'])],
    ['a protocol the ledger names and no code declares', { protocols: [...probeLedger(probeKinds).protocols, { protocol: 'ghost', version: 1, kinds: [], subject: 's', producedBy: 'p', readBy: 'r' }] }, probeDeclared(['alpha', 'beta'])],
    ['a ledger row written as a bare kind name, the shape that could not see a member', probeLedger(['probe/kind']), probeDeclared(['alpha', 'beta'])],
    ['a ledger row with no member set at all', probeLedger([{ name: 'probe/kind' }]), probeDeclared(['alpha', 'beta'])],
    ['a kind whose declaration names no member set', probeLedger([{ name: 'probe/kind', members: [] }]), probeDeclared(undefined)],
  ]) {
    const findings = inventoryFindingsWith(ledger, declared)
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  protocol-inventory did not fire on ${label}`)
    } else {
      console.log(`  ok    protocol-inventory fired on ${label} (${findings.length} findings)`)
    }
  }

  // Payload enforcement, rule identity and frozen declaration sets are distinct checks.
  {
    const { defineKind, ProtocolRegistry: Registry } = await import(new URL('../src/protocol/registry.ts', import.meta.url).href)
    const rule = defineKind({ guarantees: { appended: true }, members: ['alpha'], nested: {}, emitter: 'writer', parse: raw => raw, reduce: state => state })
    const registry = new Registry()
    registry.declare('probe', 1, { initialState: {}, kinds: { 'probe/kind': rule } })
    let refused
    try {
      rule.parse({ alpha: 1, beta: 2 }, 'probe/kind payload')
      refused = 'accepted'
    } catch (error) {
      refused = error?.refusal?.code ?? 'unreadable'
    }
    const declared = [{ protocol: 'probe', version: 1, kinds: [{ name: 'probe/kind', members: [...rule.members] }] }]
    const findings = inventoryFindingsWith(probeLedger([{ name: 'probe/kind', members: ['alpha', 'beta'] }]), declared)
    const bare = { guarantees: { appended: true }, members: ['alpha'], nested: {}, emitter: 'writer', parse: () => ({}), reduce: state => state }
    let unbranded
    try {
      new Registry().declare('probe', 2, { initialState: {}, kinds: { 'probe/kind': bare } })
      unbranded = 'accepted'
    } catch (error) {
      unbranded = error?.refusal?.code ?? 'unreadable'
    }
    // A spread copy has a different identity even if it preserves the member set.
    const copied = { ...rule, parse: () => ({}) }
    let spread
    try {
      new Registry().declare('probe', 3, { initialState: {}, kinds: { 'probe/kind': copied } })
      spread = 'accepted'
    } catch (error) {
      spread = error?.refusal?.code ?? 'unreadable'
    }
    // Declared member sets must remain frozen.
    let widened
    try {
      rule.members.push('beta')
      widened = 'widened'
    } catch {
      widened = 'frozen'
    }
    if (
      refused !== 'malformed-payload' ||
      findings.length !== 1 ||
      unbranded !== 'malformed-declaration' ||
      spread !== 'malformed-declaration' ||
      widened !== 'frozen'
    ) {
      missed += 1
      console.log(
        `  FAIL  the declared member set was not the enforced one (an undeclared member: ${refused}; ledger comparison: ${findings.length} findings; a rule that skipped defineKind: ${unbranded}; a copy of a declared rule: ${spread}; a declared set widened after the fact: ${widened})`,
      )
    } else {
      console.log(
        `  ok    defineKind closed the payload with the declared set (an undeclared member refused, ${findings.length} ledger finding), the registry refused a rule that skipped it and a copy of one, and the declared set could not be widened`,
      )
    }
  }

  // Observe bracket-spelled declarations on a module's private registry.
  const sneakModule = `data:text/javascript,${encodeURIComponent(
    `import { defineKind, ProtocolRegistry } from ${JSON.stringify(new URL('../src/protocol/registry.ts', import.meta.url).href)}
const PRIVATE = new ProtocolRegistry()
PRIVATE['declare']('sneak', 1, { initialState: {}, kinds: { 'sneak/leaked': defineKind({ guarantees: { appended: true }, members: [], nested: {}, emitter: () => 'scheduler', parse: () => ({}), reduce: state => state }) } })
export const concealed = PRIVATE.kindsOf('sneak', 1)
export function declareBrokenProtocol() { throw new Error('this declarer wants something else in place') }
`,
  )}`
  const sneaked = await declaredProtocols([{ name: 'a synthetic module', url: new URL(sneakModule) }])
  const sweepFindings = [...sneaked.refusals, ...declarationSiteFindings(sneaked.sites), ...inventoryFindingsWith(readLedger(), sneaked.declared)]
  if (sweepFindings.length === 0) {
    missed += 1
    console.log("  FAIL  the declaration sweep did not fire on a bracket-spelled declaration on a module's own registry")
  } else {
    console.log(`  ok    the declaration sweep observed it (${sweepFindings.length} findings)`)
  }
  // The other branch: a declarer that refuses the registry leaves the inventory unable to say what it declares.
  if (sneaked.refusals.length === 0) {
    missed += 1
    console.log('  FAIL  the declaration sweep did not report a declarer that refused its registry')
  } else {
    console.log(`  ok    the declaration sweep reported a refused declarer (${sneaked.refusals.length} finding)`)
  }

  // Stub unresolved host imports and still report bracket-spelled protocol declarations.
  const hostImportRoot = mkdtempSync(join(tmpdir(), 'gates-host-import-'))
  const hostImportModule = join(hostImportRoot, 'probe-host-import.mjs')
  writeFileSync(
    hostImportModule,
    `import { Nothing } from '@deepseek-ai/dsh-not-installed'
import { defineKind, ProtocolRegistry } from ${JSON.stringify(new URL('../src/protocol/registry.ts', import.meta.url).href)}
const HIDDEN = new ProtocolRegistry()
HIDDEN['declare']('hidden', 1, { initialState: {}, kinds: { 'hidden/leaked': defineKind({ guarantees: { appended: true }, members: [], nested: {}, emitter: () => 'scheduler', parse: () => ({}), reduce: state => state }) } })
void Nothing
void HIDDEN.kindsOf('hidden', 1)
`,
  )
  const hostSweep = await declaredProtocols([{ name: 'src/__probe_host_import.ts', url: pathToFileURL(hostImportModule) }])
  const hostFindings = [...hostSweep.refusals, ...declarationSiteFindings(hostSweep.sites), ...inventoryFindingsWith(readLedger(), hostSweep.declared)]
  const siteReported = hostFindings.some(finding => finding.includes("without being a slice's protocol.ts"))
  const ledgerReported = hostFindings.some(finding => finding.includes('no protocol-baseline.json row names it'))
  if (hostSweep.stubbed.includes('src/__probe_host_import.ts') && siteReported && ledgerReported) {
    console.log(`  ok    the sweep loaded a module whose host import does not resolve, observed its bracket-spelled declaration, and reported it both as a non-protocol.ts site and as a shape no ledger row names (${hostFindings.length} findings)`)
  } else {
    missed += 1
    console.log(
      `  FAIL  the sweep did not observe a bracket-spelled declaration in a module it could not import as written (stubbed: ${hostSweep.stubbed.join(', ') || 'none'}; site rule: ${siteReported}; ledger rule: ${ledgerReported}; unloaded: ${JSON.stringify(hostSweep.unloaded)}; findings: ${hostFindings.length})`,
    )
  }
  rmSync(hostImportRoot, { recursive: true, force: true })

  // Exercise per-declaration counting and its stated limit: unreachable bracket spellings.
  const declaredOnce = 'const registry = new ProtocolRegistry()\nregistry.declare("first", 1, {})\n'
  const bracketSecond = "const registry = new ProtocolRegistry()\nregistry.declare('first', 1, {})\nregistry['declare']('second', 1, {})\n"
  for (const [label, source, observed, expected] of [
    ['a dot-spelled declaration in a module no load reached', 'const registry = new ProtocolRegistry()\nregistry.declare("hidden", 1, {})\n', 0, 1],
    ['the one declaration a file spells, observed at that site', declaredOnce, 1, 0],
    ["the review's construction: an unreached second declaration in an observed protocol.ts", `${declaredOnce}export function zzHidden(r) {\n  r.declare('zzhidden', 1, {})\n}\n`, 1, 1],
    ['the same second declaration spelled with brackets, which the net cannot count — its stated limit', bracketSecond, 1, 0],
  ]) {
    const findings = unaccountedDeclarationFindings(['src/__probe_declare.ts'], new Map([['src/__probe_declare.ts', observed]]), () => source)
    if (findings.length === expected) {
      console.log(`  ok    the per-declaration net reported ${findings.length} finding${findings.length === 1 ? '' : 's'} on ${label}`)
    } else {
      missed += 1
      console.log(`  FAIL  the per-declaration net reported ${findings.length} findings on ${label}, expected ${expected}`)
    }
  }

  // A wrong baseline: if a version nobody installed does not produce a finding, nothing is protected.
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

  // A failing verdict string must fail every script detector.
  for (const gate of SCRIPT_GATES) {
    const findings = scriptFindings(gate.name, gate.markers, () => 'ok\nsome checks failed\n')
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${gate.name} did not fire on a failing run`)
    } else {
      console.log(`  ok    ${gate.name} fired (${findings.length} findings)`)
    }
  }

  // A constant marker stub must fail; a script that depends on src/ must pass.
  const stubRoot = mkdtempSync(join(tmpdir(), 'gates-stub-'))
  mkdirSync(join(stubRoot, 'scripts'), { recursive: true })
  writeFileSync(join(stubRoot, 'scripts', 'stub.mjs'), `console.log(${JSON.stringify('domain-probe: OK')})\n`)
  writeFileSync(
    join(stubRoot, 'scripts', 'judging.mjs'),
    `import('../src/protocol/refusal.ts').then(() => console.log(${JSON.stringify('domain-probe: OK')}), () => process.exit(1))\n`,
  )
  for (const [label, script, expected] of [
    ['a one-line stub that prints the marker', 'scripts/stub.mjs', 1],
    ['a script that judges the tree, which dies in a tree with no src', 'scripts/judging.mjs', 0],
  ]) {
    const findings = notLoadBearingFindings('a synthetic script', ['domain-probe: OK'], script, stubRoot)
    if (findings.length === expected) {
      console.log(`  ok    the load-bearing check handled ${label} (${expected} finding${expected === 1 ? '' : 's'})`)
    } else {
      missed += 1
      console.log(`  FAIL  the load-bearing check reported ${findings.length} findings on ${label}, expected ${expected}`)
    }
  }
  rmSync(stubRoot, { recursive: true, force: true })

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
  const sweep = await declaredProtocols()
  DECLARED = sweep.declared
  RUNTIME_EXPORTS = sweep.exports
  const results = scan(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) })
  const inventory = results.find(result => result.name === 'protocol-inventory')
  // Add sweep failures and declarations that its imports did not account for.
  const observedBySite = new Map()
  for (const entry of sweep.sites) observedBySite.set(entry.site, (observedBySite.get(entry.site) ?? 0) + 1)
  for (const finding of [
    ...sweep.refusals,
    ...declarationSiteFindings(sweep.sites),
    ...unaccountedDeclarationFindings(files, observedBySite),
    ...unobservableDeclarations(sweep.unloaded),
  ])
    inventory?.findings.push(finding)
  let failed = 0
  console.log(`gates: ${DETECTORS.length} gates over ${files.length} files\n`)
  // Report observed coverage and its limits.
  const declaredNested = DECLARED.flatMap(entry => entry.kinds.filter(kind => (kind.nested ?? []).length > 0).map(kind => `${entry.protocol}@${entry.version} ${kind.name} (${kind.nested.join(', ')})`))
  console.log('  note  protocol-inventory compares the ledger with each kind\'s declared member set, which is the same value defineKind applies to the payload before its parser runs; there is nothing to sample, so a parser whose accepted set would depend on the payload cannot make the declared set wrong')
  console.log(`  note  protocol-inventory compares each kind's declared payload members with its ledger row and does not reach inside a payload: the closed shapes a kind declares there (${declaredNested.join('; ') || 'none in this tree'}) are handed to the readers that name them, one level down, and what closes each reader there is the spec that feeds it an undeclared member — a declaration is not what stops a reader from spreading one`)
  console.log(`  note  protocol-inventory observes a declaration when a module loads or an exported declarer is called, and counts each src file's dot-spelled declarations against what was observed at that site; ${observedBySite.size} site(s) carried a declaration this run (${[...observedBySite.keys()].sort().join(', ')}), and in those files a declaration spelled otherwise (X['declare'](…)) on a path no load reaches is reached by neither mechanism`)
  if (PUBLISHED_WITHOUT_CONSUMER.size > 0)
    console.log(`  note  no-unreferenced-export records ${PUBLISHED_WITHOUT_CONSUMER.size} name(s) that src/index.ts publishes and nothing in this tree binds; the record may only shrink, and a name published without being recorded in it is a finding`)
  // The behavioural gates' limit: the second run rules out a constant verdict, not a fabricated one.
  console.log('  note  every behavioural gate runs its script twice, once here and once in a copy of this tree with src/ removed, so a verdict that does not depend on the tree is reported; a script that reproduces that dependence without judging the tree is not distinguished by it')
  if (sweep.stubbed.length > 0)
    console.log(`  note  protocol-inventory could not import ${sweep.stubbed.length} module(s) as written (${sweep.stubbed.join(', ')}); they were imported again with the host packages they name stubbed, so what they declare at load time is observed rather than matched as text`)
  const corpus = docPaths()
  const commits = repositoryCommits()
  const records = corpus.filter(file => RECORD_DOCS.has(file))
  const verified = records.filter(file => namesHeldCommit(readFileSync(join(ROOT, file), 'utf8'), commits))
  console.log(`  note  tree-inventory scans ${corpus.length} document(s) — every markdown file under docs/ and README.md — for count claims, minus ${verified.length} record(s) of past commits, each anchored by the first commit it names and checked against git to be one this repository holds — a held token later in the text anchors nothing${verified.length === records.length ? '' : ` (${records.length - verified.length} declared entry/entries anchor on nothing this tree holds and are read as this tree's)`}; a fenced block is quoted output, a fence delimiter is three backticks or three tildes and a longer or unclosed one is a finding, a count on a line carrying a commit-shaped token is that line's record (the token is not verified against git, so a fabricated one buys the same exemption), and a bare file count is read as this tree's only where the line names this tree`)
  const charge = evidenceFiles().reduce((total, entry) => total + entry.lines, 0)
  const sourceLines =
    files.filter(file => file.startsWith('src/')).reduce((total, file) => total + raw.get(file).split('\n').length, 0) +
    assemblySources().reduce((total, entry) => total + entry.text.split('\n').length, 0)
  console.log(`  note  evidence-budget charges ${charge} lines of evidence against ${sourceLines} of source (${(charge / sourceLines).toFixed(4)}, ratchet ${EVIDENCE_BUDGET}, ${Math.floor(EVIDENCE_BUDGET * sourceLines) - charge} whole line(s) of headroom): every file under scripts/ at any depth whatever it is called, every .ts under tests/ and assembly/tests/, and every file under tests/fixtures/ — against the stack's src/ plus the plugin's assembly/src`)
  const uncharged = unchargedFiles()
  console.log(`  note  evidence-budget does not charge ${uncharged.length} file(s), ${uncharged.reduce((total, entry) => total + entry.lines, 0)} lines — ${uncharged.map(entry => `${entry.file} (${entry.lines})`).join(', ')} — because prose is not the lane round four's pattern found work moving to, and a ledger, a vector corpus or a manifest is an input a gate compares rather than a check the budget weighs; this list is walked rather than restated, so a file cannot be left off it`)
  const ledger = readMutationLedger()
  console.log(`  note  mutation-claims runs one claim on every commit — ${ledger.commitClaim} — in a copy of this tree, so a verdict that has gone stale is reported; the other ${(ledger.claims ?? []).length - 1} claim(s) run only on demand (node scripts/mutate.mjs --all), which is not a gate`)
  console.log('')
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
