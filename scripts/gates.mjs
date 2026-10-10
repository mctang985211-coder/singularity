#!/usr/bin/env node
/**
 * The mechanical gates, and the self-test that proves they can fail.
 *
 * These are the first asset of this codebase, not an afterthought: the previous system had a good design
 * and still grew twelve persisted formats and 197 unreferenced exports, because only two gates existed
 * and neither constrained *shape proliferation*. Five lessons are built in, the round behind each is in
 * `docs/context.md` §11g, and what each still cannot reach is stated where it is used:
 *
 * - **A gate that has never failed is not known to work**: `--probe` fires every detector on a synthetic
 *   file set that violates all of them.
 * - **Text matching is not symbol matching**: references are counted over comment- and literal-stripped
 *   source, and an export counts only when another module *binds* the name.
 * - **A pattern is a spelling, and a spelling is not a mechanism**: each past spelling is asked of the
 *   thing that can answer now, and what that still cannot reach is printed where it is used.
 * - **A mechanism loses to a spelling only where it is not applied**: a close without a stated boundary
 *   is the next round's finding.
 * - **A verdict read as a substring is not a verdict**: each behavioural gate runs its script twice,
 *   once with `src/` removed, so a verdict that does not change with the tree is reported.
 *
 * Usage: `node scripts/gates.mjs` scans the real tree; `--probe` self-tests every detector.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const SOURCE_DIRS = ['src', 'tests']
const PROBE = process.argv.includes('--probe')

/** A file budget, not a design rule: the blueprint says split by responsibility, never by line count. */
const MAX_SOURCE_LINES = 400
/**
 * Durability belongs to DSH session persistence, so this codebase writes nothing.
 *
 * The rule is absolute rather than an allowlist with one exemption: the previous system kept a
 * self-built durable log beside the upstream one and re-implemented a worse barrier, lease and replay.
 *
 * What this detector is: a scan for a spelling that reaches a write — a non-read-only name imported or
 * re-exported from an fs module, a default or namespace binding, a dynamic import whose target cannot be
 * read, `createRequire`, `process.getBuiltinModule`, and the process-execution module, each refused by
 * name because the gate cannot see what it will do.
 *
 * What it is not, written because a gate believed to be a barrier is worse than one known not to be: not
 * interposition and not a proof. A write reached through a host package's API, or a Node capability this
 * list does not name, is invisible to it; and since the sweep imports every module under `src`, a write
 * at module level *runs* during the sweep — the file is there afterwards. Green means "no write this
 * scan can name", never "no write happened": round five's
 * `createRequire(import.meta.url)('node:fs/promises').writeFile(…)` and round seven's
 * `export { writeFile } from 'node:fs/promises'` both wrote while this gate read green.
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
 * Source with comments and string literal contents replaced by spaces, at exactly the input length.
 *
 * Lexical, not a parser, and approximate on purpose: a regex literal is not a literal here, a quote that
 * does not close on its own line is not a string, and a `${…}` substitution reads as literal text. One
 * pass, because which of `//`, `/*`, `'`, `"` and `` ` `` opens anything depends on what is open; length
 * and line breaks survive, because findings read line numbers out of the result.
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
        // An unescaped line break cannot be inside a quoted literal, so the quote was not one — an
        // apostrophe in a regex literal, say. The text is restored and read as code rather than
        // swallowed to the end of the file.
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
 * Every name a file declares as an export: `export <decl>`, and `export { … }` **without** `from`.
 * A re-export binds another module's name and is counted where that name is declared — counting it
 * here would let a barrel file vouch for a name nothing uses, and `src/index.ts` is such a barrel.
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
 * What one file binds from other modules: each name an `import`/`export … from` clause takes, with its
 * specifier, whether the clause forwards the name, plus any namespace binding's specifier. The clause
 * comes from the code view, so one inside a comment is not a binding; the specifier comes from the raw
 * text at the same offsets, because `codeOnly` blanks string contents.
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

/**
 * The file a relative specifier names, or `undefined` when it leaves the scanned tree. A `.js`
 * specifier resolves to the `.ts` beside it, because that is what this configuration compiles to:
 * round four's L-3 was a file imported as `'./x.js'` reported as an export nobody uses.
 */
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
 * The published surface a consumer outside this repository uses and nothing here binds: the names
 * `src/index.ts` publishes that nothing in `src/` or `tests/` binds. Their consumer is the host that
 * mounts this plugin, which no gate here can see, so publishing one is a recorded act: an unrecorded
 * name fails, and a recorded name that is now bound or no longer published fails too. A ratchet, like
 * the evidence budget — it makes publishing deliberate, not impossible (`docs/context.md` §11g).
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
  'src/task/commands.ts\0HeldAgent',
  'src/task/commands.ts\0TaskCommandOptions',
  'src/task/commands.ts\0TaskCommands',
  'src/task/commands.ts\0VerdictInput',
  'src/task/contract.ts\0VerifierRegistry',
  'src/task/decomposition.ts\0assertDecompositionAgainst',
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
 * Every export no other module binds, with the two ways a name can still be accounted for.
 *
 * A re-export is not a use — it *forwards* the name, and uses it only when the forwarding module is
 * itself used, transitively. What is left is the honest remainder: names the entry point publishes whose
 * consumer is outside this repository, recorded in `PUBLISHED_WITHOUT_CONSUMER` and checked both ways.
 * The record and the entry point are parameters so the self-test can hand this function another one.
 *
 * **What a file exports is asked of the file, not of a pattern** (round five's H-1), so the loader's
 * namespace is read as well as the text. **A binding is a consumer; the entry point's own bindings are
 * not** — and this gate cannot tell a barrel that computed a published value out of an import from that
 * bypass, which it says rather than implying otherwise.
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
  // A forwarded name is used exactly when its forwarding module is, so the walk goes backwards along
  // the forwarding edges to a fixpoint instead of stopping at the barrel.
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
    // Two readers that miss different things: the loader's namespace is where a *value* export's
    // spelling cannot hide (`b` in `export const a = 1, b = 2`, `default`, a destructuring), and the
    // text scan is where a *type* export lives, because the loader erases types. A forwarded name is
    // neither — it is counted where it is declared.
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
  // The record only shrinks: an entry something now binds, or that is no longer published, is a stale
  // claim about the tree — an unreferenced export written backwards.
  for (const key of recorded) {
    const [file, name] = key.split('\0')
    if (used.has(key))
      findings.push(`the published-surface record names ${name} in ${file}, which another module now binds; the record may only shrink, so shrink it in the commit that made it possible`)
    else if (!published.has(key) || !declared.has(key))
      findings.push(`the published-surface record names ${name} in ${file}, which ${ENTRY_POINT} does not publish unbound any more; the record may only shrink, so shrink it in the commit that made it possible`)
  }
  return findings
}

/**
 * The gates that read the real tree by running a script and reading the verdict line it prints. One
 * entry each, because three consumers need the same facts: the detector, the probe's synthetic failing
 * run, and the skip line naming what the synthetic file set cannot reach.
 */
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
        const code = views.code.get(file)
        // Import *and* re-export clauses, because `export { writeFile } from 'node:fs/promises'` names a
        // write with no `import` in it: round seven forwarded one through such a module and every gate
        // stayed green while the forwarding module's caller performed the write.
        const clauses = /\b(import|export)\s*(?:type\s*)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
        for (const match of views.raw.get(file).matchAll(clauses)) {
          const verb = match[1]
          const specifier = match[3]
          const clause = match[2].trim()
          if (EXEC_MODULES.has(specifier)) {
            findings.push(`${file} ${verb}s ${specifier}; a general process executor runs whatever a string says, a shell redirection into a file among them, so no module may name one`)
            continue
          }
          if (!FS_MODULES.has(specifier)) continue
          // A default or namespace binding hides every name behind one identifier, so no allowlist
          // can see what it will call. It is refused outright, which is the counterexample fix.
          if (!clause.startsWith('{')) {
            findings.push(`${file} ${verb}s ${specifier} as a ${clause.startsWith('*') ? 'whole module' : clause.startsWith('type') ? 'type' : 'default or namespace'} binding; no module may write durably; name the members you read instead`)
            continue
          }
          for (const entry of clause.replace(/[{}]/g, '').split(',')) {
            const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
            if (name === undefined || name === '') continue
            if (!READ_ONLY_FS.has(name)) findings.push(`${file} ${verb}s ${name} from ${specifier}; no module may write durably; DSH session persistence owns the medium`)
          }
        }
        // A dynamic import is the same capability behind a door a static scan cannot see, refused for
        // the same reason as a namespace binding: the gate cannot see what it will call. Round four's
        // H-2 decided "not a filesystem module" by the *first token*, so `'node:' + 'fs/promises'` read
        // as `'node:'` and wrote a real file — the literal is now the whole argument, closed by `)`.
        for (const match of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
          const at = `${file}:${lineOf(code, match.index)}`
          const literal = /^\s*(['"])([^'"]*)\1\s*\)/.exec(views.raw.get(file).slice(match.index + match[0].length))
          if (literal === null)
            findings.push(`${at} loads a module through a dynamic import whose target is not one quoted literal the gate can read on its own (a concatenation, a template, a variable or an expression); no module may write durably, so a dynamic import may only name one literal module, and never a filesystem one`)
          else if (FS_MODULES.has(literal[2]) || EXEC_MODULES.has(literal[2]))
            findings.push(`${at} dynamically imports ${literal[2]}; no module may write durably; DSH session persistence owns the medium`)
        }
        // A loader or a builtin fetched by name is that door without the wall: neither is an import
        // clause, so no import rule reads what it loads. Both are refused by name — there is no readable
        // spelling of "load anything".
        for (const [spelling, how] of [
          ['createRequire', "builds a module loader with createRequire; createRequire(import.meta.url)('node:fs/promises').writeFile(…) wrote a real file while every gate stayed green"],
          ['getBuiltinModule', 'fetches a module by name with process.getBuiltinModule, which no import clause names and no specifier scan can see'],
        ]) {
          const at = code.search(new RegExp(`\\b${spelling}\\b`))
          if (at >= 0) findings.push(`${file}:${lineOf(code, at)} ${how}; no module may write durably, so a loader this gate cannot read is refused by name`)
        }
      }
      return findings
    },
  },
  {
    name: 'no-unreferenced-export',
    /** Parameterised over the published-surface record, so the self-test can hand it a wrong one. */
    detect: (files, views) => unreferencedExportFindings(files, views, PUBLISHED_WITHOUT_CONSUMER),
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
      ...scriptFindings(gate.label, gate.markers, runScript(gate.script)),
      // The verdict is only read after it has been shown to be able to differ from itself.
      ...notLoadBearingFindings(gate.label, gate.markers, gate.script, loadBearingMirror()),
    ],
  })),
]

/**
 * The evidence budget, and its ratchet.
 *
 * Round four's seventh pattern: `sourceFiles()` scanned only `src/` and `tests/` `.ts` files, so
 * `scripts/` and `tests/fixtures/*.json` were in no detector and no budget while `tests/*.spec.ts` was
 * charged for every line — the unwatched lane was the one whose checks the ratchet did not weigh.
 *
 * So the numerator is *evidence*: every `.ts` under `tests/`, every file under `tests/fixtures/` (JSON
 * included, by line), and — since round seven's H1 found the list was an extension filter — **every file
 * under `scripts/`, at any depth, whatever it is called**. The denominator stays the `.ts` files under
 * `src/`. Not charged, with sizes printed by walking the tree rather than restating a list: `docs/**` and
 * `README.md`, `tests/vectors/**`, the four root ledgers, the manifest and the two root configs — prose
 * because this budget charges *work*, and a ledger or a vector corpus because it is an input a gate
 * compares rather than a check the budget weighs.
 *
 * These are ratchets, not targets: they came down from 0.88 and 7.8 by deleting restatement and may only
 * go down further. This file is charged like any other evidence, so every detector and probe leg has to
 * be paid for by deleting a line of evidence. The allowance is not a number written here — round seven's
 * M2 caught a paragraph that said 22 lines where the arithmetic gave 21 — but derived and printed on
 * every run as `floor(ratchet × source) − charged`.
 */
const EVIDENCE_BUDGET = 1.88
const SPEC_DENSITY = 5

/**
 * Every file under one directory, `node_modules` and history aside, as paths relative to it: the charge
 * and the printed list of what is not charged are one walk, so they cannot drift apart.
 */
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

/**
 * Every file under `scripts/`, at any depth, as repo-relative posix paths.
 *
 * Round six's D3 stopped the charge at the directory; round seven's H1 was the same road one suffix
 * away — only `.mjs` was charged and a dot-name was skipped, so `zz-big.js`, `.cjs`, `.ts` and
 * `.probes/zz-big.mjs` were twenty thousand uncharged lines. A probe is evidence wherever it is filed,
 * so nothing is filtered: no extension, no name, no depth. The directory is a parameter for the self-test.
 */
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

/**
 * Every file the budget charges besides the source, with its line count, read from disk because most of
 * the evidence is not a `.ts` file under `src/` or `tests/` — why the budget had to be renamed.
 */
function evidenceFiles() {
  const paths = new Set(sourceFiles().filter(file => file.startsWith('tests/')))
  for (const file of treeFiles(join(ROOT, 'tests', 'fixtures'))) paths.add(`tests/fixtures/${file}`)
  for (const file of scriptFiles()) paths.add(file)
  return [...paths].sort().map(file => ({ file, lines: readFileSync(join(ROOT, file), 'utf8').split('\n').length }))
}

/** The evidence's size against the source's, over the same file set the other gates see. */
function evidenceBudgetFindings(files, views, evidence) {
  const source = files.filter(file => file.startsWith('src/')).reduce((total, file) => total + views.raw.get(file).split('\n').length, 0)
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
 * One behaviour per test: `expect` over `it` is a crude proxy for a real rule — a test asserting one
 * external fact eight times costs eight edits and adds nothing. Counted textually, which is approximate
 * on purpose: a loop that asserts is counted once, so a file can only under-report here.
 *
 * What it does not reach: a behavioural script's checks are `check(...)` calls and its denominator is
 * the script, so the same arithmetic over `scripts/` would divide by one. The budget charges a probe's
 * *size*; nothing charges its structure.
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
 * The tree ledger: the counts documents quote, in the one place this gate compares with the build.
 *
 * Three rounds watched the same numbers drift in `docs/context.md`, noticed nothing, because they lived
 * in prose. They live in `tree-baseline.json` now and this gate measures them — `tests` through vitest's
 * own `list --json` port, because a text count of `it(` is a different number, and a measurement that
 * cannot be taken is a finding, never silence. §13 has the reasoning and the limits.
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

/** The two documents that state mutation results, which `mutation-claims` reads by name. */
const CLAIM_DOCS = ['docs/context.md', 'docs/f-evidence.md']

function readDocs() {
  return CLAIM_DOCS.map(file => {
    try { return { file, text: readFileSync(join(ROOT, file), 'utf8') } } catch { return { file, text: undefined } }
  })
}

/**
 * The count scan's corpus and its declared records.
 *
 * The corpus is every document this repository publishes — `README.md` and every markdown file under
 * `docs/` — so a document written later is scanned without anyone remembering to add it (round six's D2:
 * the identical claim fired in `context.md` and passed in `blueprint.md`). `RECORD_DOCS` names the
 * documents that measure a past commit: that is what makes a count a record rather than a claim about
 * this build, so each entry must name a commit **this repository holds**, checked against git — round
 * seven's B2 was an entry skipped whole-file on any hex token with a letter in it. A declared record
 * that names none is not a record: it is reported as such, and its counts are read as this tree's.
 */
const RECORD_DOCS = new Set([
  'docs/review.md',
  'docs/adversarial-review-2.md',
  'docs/adversarial-review-3.md',
  'docs/adversarial-review-4.md',
  'docs/adversarial-review-5.md',
  'docs/adversarial-review-6.md',
  'docs/adversarial-review-7.md',
  // The eighth review is a record of the commit it names on its first line, like the seven above: a
  // review's counts are measurements of *that* commit, which is what the ledger above measures too.
  'docs/adversarial-review-8.md',
])
/** A hex token with a letter in it: commit-shaped, which was all this was checked for until round seven. */
const COMMIT = /\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/g

/** Every commit this repository holds, for checking a token instead of matching its shape. */
function repositoryCommits() {
  try {
    return new Set(execFileSync('git', ['rev-list', '--all'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean))
  } catch {
    return undefined
  }
}

/** Whether a text names a commit this repository holds, by full sha or by a short prefix. */
function namesHeldCommit(text, commits) {
  return commits !== undefined && (text.match(COMMIT) ?? []).some(token => [...commits].some(sha => sha.startsWith(token)))
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
 * A count stated in prose, in the spellings this tree's documents have drifted in: a net, not a
 * mechanism, whose boundary §13 states. The leading `(?<![\w.])` keeps a section number out of it —
 * without one, "## 6.4 门禁清单" reads as "4 门禁".
 */
const COUNT_CLAIM = /(?<![\w.])\d[\d,]*\s*(?:条\s*)?(?:测试|门禁|spec 文件|个\s*`?\.ts`?\s*文件)|(?<![\w.])\d[\d,]*\s+(?:tests?|gates?|spec files?)\b/

/**
 * A bare file count, which is this tree's only where the line names this tree: without this half, "15
 * files" in §6.3 is outside every net, and without the tree on the line the same spelling covers the
 * legacy repository's suite in §2.1 and "4 files were misread" in §11g.
 */
const FILE_CLAIM = /(?<![\w.])\d[\d,]*\s*(?:个\s*)?文件|(?<![\w.])\d[\d,]*\s+files?\b/
const TREE_ON_LINE = /src\/|tests\/|scripts\/|docs\/|singularity-core|README\.md|this tree|this repository|本树|本仓|本仓库|仓库/

/** A fence delimiter: three or more backticks or tildes, and whatever follows, read as an info string. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/

/**
 * The prose scan. The boundaries, each stating what it does not reach (the reasoning is in §13):
 *
 * - A fenced block is quoted output. The opening delimiter is recorded and only the same character
 *   repeated at least as many times, alone on its line, closes it: round seven's B1 closed a four-backtick
 *   fence on the first ``` after it, so the rest read as prose and was then skipped as quoted, silently.
 *   A delimiter longer than three is a finding in its own right — the tree quotes output with three.
 * - A fence left open is a finding for every delimiter, so one ``` cannot exempt the rest.
 * - A declared record is skipped whole-file only when it names a commit this repository holds, checked
 *   against git and not matched as a hex token; if it names none it is not a record, and it is scanned.
 * - A count on a line carrying a commit-shaped token is that line's record, and the token is **not**
 *   verified, because this tree's documents quote other repositories' history (`docs/blueprint.md`'s
 *   port table names commits the RRSI checkout holds and this one never did). A fabricated token buys
 *   the same exemption: that is the boundary, not a claim that it was checked.
 *
 * Not caught: a count spelled in words, a bare number in a table cell with no counting word, a count of
 * something the ledger does not measure, and any document outside `README.md` and `docs/`.
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
        `${file} is declared a record of a past commit and names none this repository holds${commits === undefined ? " (git could not list this repository's commits, so no record can be verified)" : ''}; a count is a record only of a commit it names, so this document is not a record and its counts are read as this tree's`,
      )
    let open = null
    text.split('\n').forEach((line, index) => {
      const fence = FENCE.exec(line)
      if (fence !== null) {
        const delimiter = fence[1]
        if (delimiter.length > 3)
          findings.push(`${file}:${index + 1} uses a ${delimiter.length}-character ${delimiter[0] === '`' ? 'backtick' : 'tilde'} fence; this tree quotes output with three, and a longer delimiter is what the seventh review hid a count behind, so spell it as three`)
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
 * The mutation ledger: every claim that a mutation is caught, with the edits and the command that judge it.
 *
 * The claims live in `mutation-baseline.json` and `scripts/mutate.mjs` runs one in a copy of the tree.
 * This gate is the cheap half plus one: each claim must still apply (its anchor occurs once), every
 * document that states a result must name a claim, and **one claim — the ledger's `commitClaim` — runs
 * on every commit**, because round seven's M1 was that anchors and ids alone leave a tree whose verdicts
 * have all gone stale reading green. (§13 has the limits, first among them a claim in a commit message.)
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
  const named = new Set()
  for (const { file, text } of docs) {
    if (text === undefined) { findings.push(`${file} is one of the documents that make mutation claims and cannot be read`); continue }
    text.split('\n').forEach((line, index) => {
      const here = [...line.matchAll(MUTATION_ID)].map(match => match[1])
      for (const id of here) { named.add(id); if (!ids.has(id)) findings.push(`${file}:${index + 1} names ${`mutate:${id}`}, which ${MUTATION_LEDGER} does not record; a claim that names no runnable script is a claim nobody can run`) }
      if (MUTATION_CLAIM.test(line) && here.length === 0) findings.push(`${file}:${index + 1} states a mutation result with no runnable claim (${line.trim().slice(0, 60)}); name it as mutate:<id> from ${MUTATION_LEDGER}, or state it in the ledger instead of in prose`)
    })
  }
  for (const id of ids) if (!named.has(id)) findings.push(`${MUTATION_LEDGER} records ${id}, which no document names; a script nothing points at is not evidence a reader can find`)
  return findings
}

/**
 * The one claim this gate runs rather than only anchoring (round seven's M1): the ledger's `commitClaim`
 * is executed on every commit in a copy of the tree, through the same `scripts/mutate.mjs` a reader would
 * use, and a verdict that is not `caught` is a finding. Running all of them here is not the shape.
 */
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

/**
 * What one kind accepts, read from the declaration rather than from its behaviour: `KindRule.members`
 * is the value the parse boundary enforces, so the inventory compares the ledger with the same value the
 * log enforces. Rounds three to five inferred this set by sampling payloads until the fifth round showed
 * the mechanism's own limit — a parser that closes its payload over a member it never *names* is reached
 * by no sample. Sampling is gone rather than patched: a declaration and its parser cannot disagree.
 *
 * Two answers, both meaningful: the declared set, or a finding when the declaration names none.
 */
function declaredMembers(rule) {
  return Array.isArray(rule?.members) ? [...rule.members].sort() : undefined
}

/**
 * Where a `declare` call was written, read from the stack: the nearest frame inside `src` that is not
 * the registry itself, so a declarer called from another module reports the slice's `protocol.ts`, where
 * the declaration is *written*. A module loaded from no path into `src` has no such frame, so the module
 * the sweep is importing answers instead — the same fact the stack would have given.
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

/**
 * A value that answers to anything, for the host packages this process cannot install: callable,
 * constructable, every property itself, except `then` (a stub that looks thenable would hang an `await`)
 * and the primitive coercions. A stub for *loading*, not a model of the package.
 */
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

/**
 * Whether a specifier names a package the host installs rather than a path or a URL: `file:` and `data:`
 * specifiers are this tree's own imports, and stubbing them would replace this tree's modules.
 */
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
 * Make the host packages resolvable, by pointing every bare specifier this tree names at a stub.
 *
 * Round four's BL-4: two modules under `src/` import the host's DSH packages, so this process cannot
 * import them, and the only net under them was the text pattern for `.declare` — the spelling round
 * three had walked through. So those modules are loaded instead: an unresolvable specifier is answered
 * with a generated stub and the import retried, so what a module declares at load time is *observed*,
 * however the call is spelled. The stub's names come from the tree's own import clauses, and that scan
 * may be a text scan because it is not the mechanism: a name it misses makes the import fail, and a
 * module that cannot be loaded is a *finding*, never a quiet pass.
 */
function registerHostStubs(modules) {
  const specifiers = new Map()
  for (const file of sourceFiles()) if (file.startsWith('src/')) hostImportsOf(readFileSync(join(ROOT, file), 'utf8'), specifiers)
  for (const module of modules) {
    try {
      hostImportsOf(sourceOfModule(module), specifiers)
    } catch {
      // A module whose source cannot be read contributes nothing; if that is why it will not load,
      // the retry fails and the module is reported instead of assumed.
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
  return stub === undefined ? next(specifier, context) : { url: stub, shortCircuit: true }
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
 * What the code actually declares, asked of the running code rather than read out of the source: every
 * module under `src` is imported with `ProtocolRegistry.prototype.declare` wrapped, so a declaration is
 * observed however it is spelled and whichever registry it lands on; every exported `declare*Protocol`
 * is called with a registry of this gate's own, so one that only happens when somebody calls it is seen
 * at all; and each observed kind's member set is read from its declaration — the value `defineKind`
 * applied at the parse boundary. Three rounds found the same weakness as three spellings.
 *
 * What this does not catch: a declaration on a path no load reaches (the text net below matches the dot
 * spelling only); a module that cannot be loaded even with its host imports stubbed (reported); and the
 * members inside a **nested** closed shape, which the ledger records only at the top level.
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
      // The module's own export list, which is the truth no spelling can hide: `export const a = 1,
      // b = 2`, `export default …` and `export const {a, b} = …` all appear here, and the text scan
      // below enumerates exactly one of the three. Keyed by the name this sweep calls the module.
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

  // One key per protocol version. The same protocol is declared more than once on purpose (a
  // projection builds its own registry for the protocols it folds), with the same rules, so the
  // first observation of a kind is kept and the sites are collected from every observation.
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

/**
 * A module no load reached even with its host imports stubbed: a gap, reported rather than noted. The
 * text net matches the dot spelling only, so the honest report is a finding that says so, not a note
 * that reads as coverage — round four's BL-4 exactly.
 */
function unobservableDeclarations(unloaded) {
  return unloaded.map(
    ({ name, error }) =>
      `${name} could not be imported even with its host imports stubbed (${error}); a declaration in it is not observed, and the text net over it matches the dot spelling only, which round three walked through with X['declare'](…) — make the module loadable, or declare the shape in a module this sweep reaches`,
  )
}

/**
 * A declaration belongs in a slice's `protocol.ts`, or a reader cannot find it either. The ledger
 * comparison is what keeps the inventory honest; this stays because a shape's *home* must be predictable.
 */
function declarationSiteFindings(sites) {
  const findings = []
  for (const { site, protocol, version, kinds } of sites) {
    if (/(^|\/)protocol\.ts$/.test(site)) continue
    findings.push(`${site} declares ${protocol}@${version} (${kinds.join(', ')}) without being a slice's protocol.ts; a shape declared here is one no reader looks for`)
  }
  return findings
}

/**
 * The net under the sweep, **per declaration rather than per file**: round five's BL-4 was a net that
 * skipped every file one observed declaration appeared in — and every slice's `protocol.ts` is such a
 * file — so a declaration no load reached inside one was invisible while the note claimed coverage.
 *
 * It counts a file's **dot**-spelled declarations against the ones observed *at that site*; more text
 * than observation is a surplus no load reached. It does not catch another spelling (`X['declare'](…)`)
 * nor a surplus seen through an exported declarer: a file with declarations is checked in the dot
 * spelling only, and the run prints those sites.
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

/**
 * Every declared kind must be in the ledger and every ledger row must be declared, **with the payload's
 * member set** — the half round three walked through, when an optional member landed in state while the
 * gate compared only `(protocol, version, kind)`. One direction catches a shape added without a stated
 * consumer, the other a ledger drifted into fiction. Both are parameters for the self-test.
 */
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
    // The old row shape failed loudly rather than quietly: a bare kind name is exactly the ledger
    // that could not see a payload member change.
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

/**
 * One kind's declared payload against its ledger row, both directions. It reads `KindRule.members` —
 * the declaration `defineKind` applies at the parse boundary — so the two can only disagree when
 * somebody edited the ledger, which is what a recorded act is for. A kind whose declaration names no
 * set is a finding rather than silence: a shape this gate cannot read must not read as one that is fine.
 */
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

/**
 * Everything must agree with one baseline: the file, the version the host installs, the declared peers
 * and every absolute path into the install. Three files had hardcoded that path unchecked, which is how
 * an alignment silently drifts. Parameterised for the self-test.
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
 * One behavioural script, as a gate: the checks that observe the product doing something. The first of
 * them was on no automated path, so a version bump broke it and nothing reported that until somebody ran
 * it by hand. Parameterised over its runner, because these gates read the real tree.
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

/**
 * A copy of this tree with `src/` taken away, for asking a behavioural script whether it judges: round
 * four's H-3 was a one-line stub printing the marker and passing the gate that covers phase F's exit
 * condition. The copy is made once per run, lazily, and removed when the process exits.
 */
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
 * The second run of one behavioural script, in a tree with no `src/`: a non-zero exit says the script
 * is load-bearing, and reporting the marker with exit 0 in a tree with nothing to judge is the finding.
 * What it does not catch: a script that checks for `src/` and prints its marker only when it is present
 * is not distinguished from one that judges the tree — this rules out a constant verdict, not a wrong one.
 */
function notLoadBearingFindings(label, markers, script, root) {
  let output
  let status = 0
  try {
    output = runScript(script)(root)
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

/**
 * The synthetic set the self-test scores: one file violates every static gate at once, and a second
 * mentions the first file's exports **only in comments** — the reviewer's counterexample, where a name
 * in a comment is not a use and text matching alone called it one.
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
      ? evidenceBudgetFindings(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) }, evidence)
      : detect(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) })
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${name} did not fire on a file set that breaks it`)
    } else {
      console.log(`  ok    ${name} fired (${findings.length} findings)`)
    }
  }

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
    ['a declared record that names a commit this repository holds', [{ file: 'docs/__probe-review.md', text: 'measured at `e8c1c70`: 21 gates\n' }], 0],
    ['a declared record that names only a token no repository holds', [{ file: 'docs/__probe-review.md', text: 'measured at `deadbeefcafe1234`: 21 gates\n' }], 1],
    ['a declared record that names no commit at all', [{ file: 'docs/__probe-review.md', text: 'the tree had 21 gates\n' }], 2],
    ['a document in the corpus that cannot be read', [{ file: 'docs/__probe.md', text: undefined }], 1],
  ]) {
    const findings = countClaimFindings(docs, probeRecord, probeCommits)
    if (findings.length === expected) console.log(`  ok    tree-inventory handled ${label} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    else { missed += 1; console.log(`  FAIL  tree-inventory reported ${findings.length} findings on ${label}, expected ${expected}: ${findings.join(' | ')}`) }
  }

  // Round six's D3 and round seven's H1: the walk is handed a synthetic `scripts/` holding every shape
  // that was once uncharged, so this watches the walk rather than a listing.
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
    ['a ledger row no document names', [{ file: 'docs/x.md', text: 'no claims here\n' }], anchored, 1],
  ]) {
    const findings = mutationClaimFindings(probeMutations, docs, file => texts[file])
    if (findings.length === expected) console.log(`  ok    mutation-claims handled ${label} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    else { missed += 1; console.log(`  FAIL  mutation-claims reported ${findings.length} findings on ${label}, expected ${expected}: ${findings.join(' | ')}`) }
  }
  // A ledger that anchors perfectly and runs nothing is M1, so the run has a leg each way.
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

  // Every code-reading detector reads this one function, and its failure mode is silent: the four-regex
  // version ate a backtick, swallowed ninety lines of a spec, and reported a density of 4.7 for a file
  // whose density was 4.5 — wrong in the numerator *and* the denominator. So each input below pins what
  // must be hidden and what must survive, and the contract is exact: input length and line breaks.
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

  // Each branch of the durability detector has to be able to fail, including the legal one (a non-fs
  // literal): round four's H-2 is why the literal is the whole argument, round seven's B3 why a clause
  // that *re-exports* is an import.
  for (const [label, source, expected, use = `import { load } from './__probe_import.ts'\nexport const used = load\n`] of [
    ['a dynamic import of a filesystem module', `export const load = async () => (await import('node:fs/promises')).writeFile\n`, 1],
    // Round seven's B3 verbatim: named by a re-export clause, performed by the silent forwarding module.
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
    // Round five's H-2 and round seven's B3, whose writes happened during the sweep meant to notice them.
    ['a module loader built with createRequire, which no import rule can read', "import { createRequire } from 'node:module'\nexport const load = () => createRequire(import.meta.url)('node:fs/promises').writeFile\n", 1],
    ['a read-only filesystem import, which is what the rule allows', "import { readFile } from 'node:fs/promises'\nexport const read = readFile\n", 0],
  ]) {
    const probeFiles = ['src/__probe_import.ts', 'src/__probe_import_use.ts']
    const probeRaw = new Map([
      [probeFiles[0], source],
      [probeFiles[1], use],
    ])
    const findings = DETECTORS.find(detector => detector.name === 'no-durable-writer').detect(probeFiles, {
      raw: probeRaw,
      code: new Map([...probeRaw].map(([file, text]) => [file, codeOnly(text)])),
    })
    if (findings.length === expected) {
      console.log(`  ok    no-durable-writer handled ${label} (${expected} finding${expected === 1 ? '' : 's'})`)
    } else {
      missed += 1
      console.log(`  FAIL  no-durable-writer reported ${findings.length} findings on ${label}, expected ${expected}`)
    }
  }

  // The round-three binding fix, with the counterexample that walked through a word search, round four's
  // H-1 barrel legs (a published name is a finding unless recorded, and the record only shrinks) and
  // L-3 (a `.js` specifier is what tsc resolves for a `.ts` file, so its binding has to count).
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

  // Round five's H-1: three spellings the text scan never enumerated, given the runtime export list the
  // sweep would have read, plus the cheapest bypass — the entry point binding a dead export so the
  // record need not be touched, which is a use in a module and no use in the barrel that is the boundary.
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

  // Each way the declared registries and the ledger can disagree, including a kind's member set — the
  // half round three's ledger could not see.
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

  // The mechanism itself, behaviourally: the declared set is the value the parse boundary enforces, a
  // rule that skipped `defineKind` is refused by name, and a copy of one is refused because the mark is
  // identity rather than a property — round six's counterexample, which no reading of the source catches.
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
    // Round six's counterexample: a spread copy kept the mark and the declared set while replacing the
    // parse boundary, so the log accepted an undeclared member with every gate green. The mark is
    // identity now, and the copy below names the same member set and is still refused.
    const copied = { ...rule, parse: () => ({}) }
    let spread
    try {
      new Registry().declare('probe', 3, { initialState: {}, kinds: { 'probe/kind': copied } })
      spread = 'accepted'
    } catch (error) {
      spread = error?.refusal?.code ?? 'unreadable'
    }
    // A later push would make the enforced set and the compared set two values with neither changing.
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

  // The sweep needs a leg proving it sees a declaration no text scan can: a `data:` module declaring on
  // its own registry with the call spelled `X['declare'](…)`, whose site is no protocol.ts.
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

  // Round four's BL-4a: a module naming a host package that is not installed, declaring at load time
  // with the bracket spelling. It was green before the fix, so the leg requires the sweep to load it
  // with its host import stubbed *and* the inventory to report the shape (`data:` URL, `.mjs` file).
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

  // Round five's BL-4: the net skipped a file once one declaration in it was observed, and every
  // protocol.ts is such a file. The legs are the review's shape — one declaration observed, a second no
  // load reached — and the last one is the stated limit, not a success: the bracket spelling is
  // counted by nothing, which is why the sweep loads the module instead.
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

  // One half of the marker check: a runner returning a failing string, which was the whole self-test
  // until round four — a string, never a script.
  for (const gate of SCRIPT_GATES) {
    const findings = scriptFindings(gate.name, gate.markers, () => 'ok\nsome checks failed\n')
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${gate.name} did not fire on a failing run`)
    } else {
      console.log(`  ok    ${gate.name} fired (${findings.length} findings)`)
    }
  }

  // The other half, with real processes (round four's H-3): a stub printing the marker must be reported
  // as not load-bearing, and a script that judges the tree must not be.
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
  // The sweep's own verdicts, which are not detector findings: a declarer it could not ask, where a
  // declaration was written, and the dot-spelled declarations no load reached — per file, not per
  // declaration *inside* a file, which is why the net is per declaration.
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
  // Coverage is stated rather than implied, and each line is a property of this run that can be checked
  // against it: the compared value, what the comparison does not reach, the sites that declared, the
  // modules loaded with stubs, and the declaration net's own boundary where a reader meets it.
  const declaredNested = DECLARED.flatMap(entry => entry.kinds.filter(kind => (kind.nested ?? []).length > 0).map(kind => `${entry.protocol}@${entry.version} ${kind.name} (${kind.nested.join(', ')})`))
  console.log('  note  protocol-inventory compares the ledger with each kind\'s declared member set, which is the same value defineKind applies to the payload before its parser runs; there is nothing to sample, so a parser whose accepted set would depend on the payload cannot make the declared set wrong')
  console.log(`  note  protocol-inventory compares each kind's declared payload members with its ledger row and does not reach inside a payload: the closed shapes a kind declares there (${declaredNested.join('; ') || 'none in this tree'}) are enforced by the readers that name them, one level down`)
  console.log(`  note  protocol-inventory observes a declaration when a module loads or an exported declarer is called, and counts each src file's dot-spelled declarations against what was observed at that site; ${observedBySite.size} site(s) carried a declaration this run (${[...observedBySite.keys()].sort().join(', ')}), and in those files a declaration spelled otherwise (X['declare'](…)) on a path no load reaches is reached by neither mechanism`)
  if (PUBLISHED_WITHOUT_CONSUMER.size > 0)
    console.log(`  note  no-unreferenced-export records ${PUBLISHED_WITHOUT_CONSUMER.size} name(s) that src/index.ts publishes and nothing in this tree binds; the record may only shrink, and a name published without being recorded in it is a finding`)
  // The behavioural gates' limit: the second run rules out a constant verdict, not a fabricated one.
  console.log('  note  every behavioural gate runs its script twice, once here and once in a copy of this tree with src/ removed, so a verdict that does not depend on the tree is reported; a script that reproduces that dependence without judging the tree is not distinguished by it')
  if (sweep.stubbed.length > 0)
    console.log(`  note  protocol-inventory could not import ${sweep.stubbed.length} module(s) as written (${sweep.stubbed.join(', ')}); they were imported again with the host packages they name stubbed, so what they declare at load time is observed rather than matched as text`)
  // Round six's and round seven's closes as properties of this run: the count scan and its limits, what
  // the budget charges and what it does not, and the one claim this run executes.
  const corpus = docPaths()
  const commits = repositoryCommits()
  const records = corpus.filter(file => RECORD_DOCS.has(file))
  const verified = records.filter(file => namesHeldCommit(readFileSync(join(ROOT, file), 'utf8'), commits))
  console.log(`  note  tree-inventory scans ${corpus.length} document(s) — every markdown file under docs/ and README.md — for count claims, minus ${verified.length} record(s) of past commits, each verified against git to name a commit this repository holds${verified.length === records.length ? '' : ` (${records.length - verified.length} declared entry/entries named none and are read as this tree's)`}; a fenced block is quoted output, a fence delimiter is three backticks or three tildes and a longer or unclosed one is a finding, a count on a line carrying a commit-shaped token is that line's record (the token is not verified against git, so a fabricated one buys the same exemption), and a bare file count is read as this tree's only where the line names this tree`)
  const charge = evidenceFiles().reduce((total, entry) => total + entry.lines, 0)
  const sourceLines = files.filter(file => file.startsWith('src/')).reduce((total, file) => total + raw.get(file).split('\n').length, 0)
  console.log(`  note  evidence-budget charges ${charge} lines of evidence against ${sourceLines} of source (${(charge / sourceLines).toFixed(4)}, ratchet ${EVIDENCE_BUDGET}, ${Math.floor(EVIDENCE_BUDGET * sourceLines) - charge} whole line(s) of headroom): every file under scripts/ at any depth whatever it is called, every .ts under tests/ and every file under tests/fixtures/`)
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
