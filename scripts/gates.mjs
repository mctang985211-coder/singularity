#!/usr/bin/env node
/**
 * The mechanical gates, and the self-test that proves they can fail.
 *
 * These are the first asset of this codebase, not an afterthought. The previous system had a good
 * design and still grew twelve persisted formats and 197 unreferenced exports, because only two
 * gates existed and neither constrained *shape proliferation*: adding a format cost nothing,
 * removing one cost a hand audit.
 *
 * Three lessons are built in:
 *
 * - **A gate that has never failed is not known to work.** `--probe` runs every detector against a
 *   synthetic file set that violates all of them. An earlier version of this file had a shortcut
 *   that made `no-unreferenced-export` unable to fail, and only the probe found it.
 * - **Text matching is not symbol matching.** References are counted over source with comments and
 *   string literals stripped, because a name mentioned in a comment or a message is not a use — a
 *   counterexample that passed every gate before this. Round three went further: it added an export
 *   nothing imported and stayed green, because the *word* occurred elsewhere as a member name. An
 *   export is now counted only when another module binds that name through an import or a re-export
 *   that resolves to the declaring file, which a member name cannot imitate.
 * - **A pattern is a spelling, and a spelling is not a mechanism.** The same round declared a live
 *   protocol through `X['declare'](...)` and added an optional payload member with no version bump;
 *   both stayed green, because the only sweep was the regex `/\.declare\s*[<(]/` and the ledger
 *   compared `(protocol, version, kind)` while a payload's members live inside a parser function.
 *   Both are asked of the running code now: every `declare` call is observed on the one prototype it
 *   has to go through, whichever registry it lands on, and a kind's member set is read out of the
 *   parser's own refusal. What that still does not reach is written down where it is used.
 *
 * Usage:
 *   node scripts/gates.mjs           scan the real tree
 *   node scripts/gates.mjs --probe   self-test: every detector must fire on a violating input
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

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
 * Source with comments and string literal contents replaced by spaces, at exactly the input length.
 *
 * Lexical, not a parser, and honest about being approximate: a regex literal is not a literal here,
 * a `'` or `"` that does not close on its own line is not a string, and a `${…}` substitution inside
 * a template reads as literal text — so a name used only there is not a use. A real AST pass is the
 * next step if a bypass appears.
 *
 * One pass, because comments and literals are one lexical problem: which of `//`, `/*`, `'`, `"` and
 * `` ` `` opens anything depends on what is already open, and four sequential regexes cannot know
 * that. The version that stripped comments first read the `//` inside a template literal as a
 * comment, blanked the backtick that closed the template, and let the template rule swallow the
 * ninety lines that followed it — lines no detector ever saw.
 *
 * Length and line breaks survive, because the detectors read line numbers and offsets out of the
 * result: a comment or a literal body becomes spaces, never disappears.
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
 *
 * A re-export (`export { X } from './y.ts'`) is deliberately not a new export here. It is a
 * *binding* of `y.ts`'s `X`, counted where `X` is declared, and counting it twice would let a barrel
 * file vouch for a name nothing uses. `src/index.ts` is exactly such a barrel.
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
 * What one file binds from other modules: each name an `import`/`export … from` clause takes, with
 * the specifier it came from, plus the specifier of any namespace binding.
 *
 * The clause is read out of the code view, so a clause inside a comment or a string is not a
 * binding; the specifier itself is then read out of the raw text at the same offsets, because
 * `codeOnly` blanks string contents by design — reading it from the code view would compare the
 * names against blanks.
 */
function moduleBindings(code, raw) {
  const bound = []
  const namespaces = []
  const clause = /\b(?:import|export)\s+([\s\S]{0,600}?)\bfrom\s*(["'])/g
  for (const match of code.matchAll(clause)) {
    const quoted = match.index + match[0].length - 1
    const end = raw.indexOf(raw[quoted], quoted + 1)
    if (end < 0) continue
    const specifier = raw.slice(quoted + 1, end)
    const list = /\{([\s\S]*)\}/.exec(match[1])
    if (list === null) {
      namespaces.push(specifier)
      continue
    }
    for (const entry of list[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
      if (name !== undefined && /^[A-Za-z0-9_$]+$/.test(name)) bound.push({ name, specifier })
    }
  }
  return { bound, namespaces }
}

/** The file a relative specifier names, or `undefined` when it leaves the scanned tree. */
function resolveModule(from, specifier, files) {
  if (!specifier.startsWith('.')) return undefined
  const target = normalize(join(dirname(from), specifier))
  return files.includes(target) ? target : undefined
}

/** The 1-based line an offset into a file falls on. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
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
        // A dynamic import is the same capability through a door a static scan cannot see:
        // `await import('node:fs/promises')` followed by `writeFile` wrote a real file while all
        // eighteen gates stayed green. A static pattern cannot be the answer — the next spelling is
        // `await import('node:' + 'fs')` — so the construct is refused for the same reason a
        // namespace binding is: the gate cannot see what it will call. A literal that is not a
        // filesystem module is readable, and legal; everything else is refused.
        for (const match of views.code.get(file).matchAll(/(?<![\w$.])import\s*\(/g)) {
          const at = `${file}:${lineOf(views.code.get(file), match.index)}`
          const literal = /^\s*(['"])([^'"]*)\1/.exec(views.raw.get(file).slice(match.index + match[0].length))
          if (literal === null)
            findings.push(`${at} loads a module through a dynamic import whose target the gate cannot read; no module may write durably, so a dynamic import may only name a literal module, and never a filesystem one`)
          else if (FS_MODULES.has(literal[2]))
            findings.push(`${at} dynamically imports ${literal[2]}; no module may write durably; DSH session persistence owns the medium`)
        }
      }
      return findings
    },
  },
  {
    name: 'no-unreferenced-export',
    detect: (files, views) => {
      const findings = []
      /**
       * The names other modules bind from each file: an export with no entry here has no consumer.
       *
       * This replaced a word search over the other files, which round three walked through by
       * adding `export const revisions = 0` beside a `revisions` member elsewhere. A binding cannot
       * be imitated that way, and `noUnusedLocals` already makes a binding a use: an import that is
       * never read is a compile error, so "bound" cannot be satisfied by an idle import.
       */
      const bound = new Map()
      for (const file of files) {
        const { bound: names, namespaces } = moduleBindings(views.code.get(file), views.raw.get(file))
        for (const specifier of namespaces) {
          if (resolveModule(file, specifier, files) === undefined) continue
          findings.push(`${file} imports ${specifier} as a namespace binding; a namespace hides which of that module's exports are used, so no count can be made — name what you use`)
        }
        for (const { name, specifier } of names) {
          const target = resolveModule(file, specifier, files)
          if (target === undefined) continue
          const set = bound.get(target) ?? new Set()
          set.add(name)
          bound.set(target, set)
        }
      }
      for (const file of files) {
        if (!file.startsWith('src/')) continue
        for (const name of declaredExports(views.code.get(file))) {
          if (bound.get(file)?.has(name) === true) continue
          findings.push(
            `${file} exports ${name}, which no other module binds by importing or re-exporting it from this file; drop the keyword or the export`,
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
    /** Its synthetic failures are its own legs below, because it reads the real registries. */
    probeSeparately: true,
    detect: () => inventoryFindingsWith(readLedger(), DECLARED),
  },
  {
    name: 'spec-budget',
    /** Its synthetic failure is its own leg below, because it reduces to arithmetic over a file set. */
    probeSeparately: true,
    detect: (files, views) => specBudgetFindings(files, views),
  },
  {
    name: 'spec-density',
    /** Its synthetic failure is its own leg below, because it reduces to arithmetic over a file set. */
    probeSeparately: true,
    detect: (files, views) => specDensityFindings(files, views),
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

/**
 * The spec budget, and its ratchet.
 *
 * A spec's size is set by the surface it locks, not by the source it covers. When specs approach
 * the source's size they are locking structure, and every refactor turns them red - which is how a
 * codebase stops being refactorable. The previous system had no such bound and grew specs to parity.
 *
 * These are ratchets, not targets: the numbers came down from 0.88 and 7.8 by deleting restatement,
 * and may only go down further. Lowering one is part of the commit that makes it possible.
 */
const SPEC_BUDGET = 0.85
const SPEC_DENSITY = 5

/** Total source lines, and total spec lines, over the same file set the other gates see. */
function specBudgetFindings(files, views) {
  const lines = prefix => files.filter(file => file.startsWith(prefix)).reduce((total, file) => total + views.raw.get(file).split('\n').length, 0)
  const source = lines('src/')
  const specs = files.filter(file => file.startsWith('tests/') && file.endsWith('.spec.ts')).reduce((total, file) => total + views.raw.get(file).split('\n').length, 0)
  if (source === 0) return []
  const ratio = specs / source
  return ratio > SPEC_BUDGET
    ? [
        `the specs are ${specs} lines against ${source} of source (${ratio.toFixed(2)}, budget ${SPEC_BUDGET}); a spec that grows with the source is locking structure, so delete the assertion that states no external fact - see docs/spec-policy.md`,
      ]
    : []
}

/**
 * One behaviour per test.
 *
 * `expect` count over `it` count is a crude proxy for a real rule: a test asserting the same
 * external fact eight times costs eight edits and adds no information. It is counted textually,
 * which is honest about being approximate - a loop that asserts is counted once, so a file can only
 * under-report here, never over-report.
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

/** A payload member no kind declares. The gate hands it to every parser, so the refusal names the closed set. */
const PROBE_MEMBER = '__gate_unknown_member__'

/**
 * What one kind's parser accepts at the top level, read out of the parser itself.
 *
 * `KindRule.parse` is a function, so a member set is not a value anybody can read — and a list
 * written beside the parser would be a second copy of the truth, free to drift from the check that
 * is enforced. The one honest source is the refusal the parser already produces: a payload carrying
 * a member no kind declares is refused by `assertClosedKeys` with `the shape is closed (known: …)`,
 * which is the parser naming its own member set. Round three added an optional member to
 * `release@1/release/drafted` with no version bump, and every gate stayed green because nothing
 * compared that set against anything.
 *
 * Three answers, all meaningful: the sorted member names; `null` when the parser accepted the probe,
 * so the payload is not closed at all; `undefined` when it refused without naming a set, so the gate
 * cannot see the shape and says so rather than assuming it is fine.
 */
function acceptedMembers(rule, where) {
  try {
    rule.parse({ [PROBE_MEMBER]: true }, where)
  } catch (error) {
    const closed = /shape is closed \(known: ([^)]*)\)/.exec(String(error?.message ?? error))
    if (closed !== null)
      return closed[1]
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0)
        .sort()
    return undefined
  }
  return null
}

/**
 * Where a `declare` call was written, read from the stack rather than from the text.
 *
 * The nearest frame inside `src` that is not the registry itself. `declareEnvironmentProtocol(FOLD)`
 * called from another module therefore reports the declarer in the slice's `protocol.ts`: the
 * declaration is *written* there, and where it is called from is not where it lives. A call written
 * directly in some other module reports that module, which is what the rule below refuses.
 */
function declarationSite() {
  for (const frame of (new Error().stack ?? '').split('\n')) {
    const match = /((?:file:\/\/)?[^\s()]*\/src\/[^\s():]+\.ts):\d+:\d+\)?$/.exec(frame.trim())
    if (match === null) continue
    const site = relative(ROOT, match[1].replace(/^file:\/\//, ''))
    if (site === 'src/protocol/registry.ts') continue
    return site
  }
  return 'unknown'
}

/**
 * What the code actually declares, asked of the running code rather than read out of the source.
 *
 * Three rounds found the same weakness three times, each time as a spelling: a declaration through
 * an exported `declare*Protocol` in a slice's `protocol.ts` (found), the same declaration on a
 * registry the module built for itself and reached with `X['declare'](…)` (missed, because the only
 * sweep was a text pattern), and the payload's member set (invisible, because it lives inside a
 * function). So this asks the runtime:
 *
 * 1. **every module under `src` this process can load is imported**, with the one
 *    `ProtocolRegistry.prototype.declare` wrapped. A declaration is therefore observed however the
 *    call is spelled and whichever registry it lands on — `X.declare(…)`, `X['declare'](…)` and a
 *    destructured `declare` all arrive at the same method, and a registry built inside a module is
 *    no hiding place;
 * 2. **every exported `declare*Protocol` is then called** with a registry of this gate's own, which
 *    is how a declaration that only happens when somebody calls it is seen at all;
 * 3. **each observed kind's member set is read from its parser** (`acceptedMembers` above), so a
 *    payload member is part of the declared surface the ledger compares.
 *
 * What this does not catch, written down because a gate's coverage is part of what it promises:
 *
 * - a declaration that only runs on a path no load reaches — the sweep sees module load and the
 *   exported declarers, not every call site. The text sweep below is the net under it, and a module
 *   this process cannot load (the ones importing the host's DSH packages: a runtime seam is not
 *   loadable here) is *only* covered by that text net, which is spelling-dependent;
 * - a payload member added to a **nested** closed shape (`contract.criteria[]`, `revision`, …): the
 *   parser answers for the members it reads at the top level, and reaching a nested set would mean
 *   synthesising a valid payload for every kind, which is a different and much larger mechanism.
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
  const original = ProtocolRegistry.prototype.declare
  ProtocolRegistry.prototype.declare = function (protocol, version, spec) {
    const published = original.call(this, protocol, version, spec)
    observed.push({
      protocol,
      version,
      site: declarationSite(),
      kinds: Object.entries(spec.kinds).map(([name, rule]) => ({ name, members: acceptedMembers(rule, `${protocol}@${version} ${name}`) })),
    })
    return published
  }
  try {
    for (const module of modules) {
      let loaded
      try {
        loaded = await import(module.url.href)
      } catch {
        unloaded.push(module.name)
        continue
      }
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
  } finally {
    ProtocolRegistry.prototype.declare = original
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
  return { declared, sites, unloaded, refusals }
}

/**
 * A declaration is written in a slice's `protocol.ts` — one conventional place — or a reader cannot
 * find it either.
 *
 * The sweep sees a declaration wherever it is written, so this is no longer what keeps the inventory
 * honest; the ledger comparison is. It stays because the *home* of a declared shape is something a
 * reader has to be able to predict, and because the text net under the sweep can enforce the same
 * rule, by name, for the modules that cannot be loaded.
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
 * The net under the sweep: the modules the sweep could not account for are read as text instead.
 *
 * Spelling-dependent on purpose — the round-three bypass wrote `X['declare'](…)` *because* this
 * pattern cannot see it — so it is the fallback and never the mechanism. It covers the two groups
 * the sweep leaves open: a module this process cannot load (one importing the host's DSH packages),
 * and a module whose `declare` call only happens on a path no load reaches, which the sweep cannot
 * observe and which the rule above therefore never sees either. A file whose declaration the sweep
 * did observe is not scanned, so a spelling both mechanisms can see is reported once. The finding
 * says it is a text match rather than implying the check is stronger than it is.
 */
function declarationSitesOutsideProtocolModules(files) {
  const findings = []
  for (const file of files) findings.push(...declarationTextFindings(file, readFileSync(join(ROOT, file), 'utf8')))
  return findings
}

/** The rule itself, over one file's text, so the self-test can watch it fire and see what it misses. */
function declarationTextFindings(file, source) {
  if (/\.declare\s*[<(]/.exec(codeOnly(source)) === null) return []
  return [
    `${file} declares a protocol by text and no load reached it, so this is a text match on the dot spelling rather than an observation; a declaration belongs in a slice's protocol.ts, where the sweep sees it whatever it is called`,
  ]
}

/**
 * Every declared kind must be in the ledger and every ledger row must be declared, **with the
 * payload's member set**, which is the half round three walked through: `release@1/release/drafted`
 * gained an optional member, the parser accepted it, it landed in state, and the gate compared only
 * `(protocol, version, kind)` while the file's own rule says a member addition is a version bump.
 *
 * Both directions matter, as before: one catches a shape added without a stated consumer, the other
 * a ledger that has drifted into fiction. Parameterised over both the ledger and the declarations so
 * the self-test can hand it a wrong one of either and watch it fire.
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
 * One kind's payload against its ledger row: the parser's own member set, both directions.
 *
 * The two unreadable answers are findings rather than silence, because a shape the gate cannot read
 * must not read as a shape that is fine.
 */
function shapeFindings(where, kind, line) {
  if (kind.members === null)
    return [
      `${where} ${kind.name} accepted a payload member no kind declares (${PROBE_MEMBER}); its payload is not closed, so a member can be added with nothing to notice it`,
    ]
  if (kind.members === undefined)
    return [
      `${where} ${kind.name} refused the gate's probe without naming its closed member set; the gate reads a shape's members out of that refusal, so the check that refuses an unknown member has to come before the rest of the parser`,
    ]
  const listed = [...line.members].sort()
  const missing = kind.members.filter(member => !listed.includes(member))
  const extra = listed.filter(member => !kind.members.includes(member))
  const findings = []
  if (missing.length > 0)
    findings.push(
      `${where} ${kind.name} accepts the payload member(s) ${missing.join(', ')}, which its ledger row does not list; a payload member is part of the declared shape, so adding one is a version bump and a recorded act`,
    )
  if (extra.length > 0)
    findings.push(`${where} ${kind.name}'s ledger row lists the payload member(s) ${extra.join(', ')}, which the parser does not accept; the ledger records the shape that exists`)
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
  // `realTree` gates read the real tree, and a `probeSeparately` gate has its own synthetic leg
  // below. Both are declared where the detector is, so this filter cannot drift from the list.
  const scored = DETECTORS.filter(detector => detector.realTree !== true && detector.probeSeparately !== true)
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
  // Both spec gates reduce to arithmetic over the file set, so each probe hands them a file set
  // that breaks it. Without this they would be numbers nobody has watched fail.
  for (const [name, files, raw] of [
    [
      'spec-budget',
      ['src/a.ts', 'tests/a.spec.ts'],
      new Map([
        ['src/a.ts', 'export const a = 1\n'],
        ['tests/a.spec.ts', Array.from({ length: 20 }, () => 'expect(1).toBe(1)').join('\n')],
      ]),
    ],
    [
      'spec-density',
      ['tests/a.spec.ts'],
      new Map([['tests/a.spec.ts', `it('a', () => {\n${Array.from({ length: 12 }, () => '  expect(1).toBe(1)').join('\n')}\n})\n`]]),
    ],
  ]) {
    const detect = DETECTORS.find(detector => detector.name === name).detect
    const findings = detect(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) })
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${name} did not fire on a file set that breaks it`)
    } else {
      console.log(`  ok    ${name} fired (${findings.length} findings)`)
    }
  }

  // Every code-reading detector reads this one function's output, and its contract is exact: the
  // input's length and its line breaks, so a line number in a finding is the line number in the
  // file. Its failure mode is silent — the four-regex version ate a backtick, swallowed ninety
  // lines of a spec, and reported a density of 4.7 for a file whose density was 4.5, wrong in the
  // numerator *and* the denominator. So each nasty input below pins what must be hidden and what
  // must survive, not merely that the call returns.
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

  // The dynamic-import rule inside no-durable-writer has two branches and one control, and each
  // must be able to fail: a literal filesystem module is refused, a target the gate cannot read is
  // refused because the gate cannot see what it will call, and a literal that is not a filesystem
  // module is legal — a rule that refused every dynamic import would be a different rule.
  for (const [label, source, expected] of [
    ['a dynamic import of a filesystem module', `export const load = async () => (await import('node:fs/promises')).writeFile\n`, 1],
    ['a dynamic import whose target the gate cannot read', 'export const load = async target => await import(target)\n', 1],
    ['a dynamic import of a module that is not a filesystem one', `export const load = async () => await import('./helper.ts')\n`, 0],
  ]) {
    const probeFiles = ['src/__probe_import.ts', 'src/__probe_import_use.ts']
    const probeRaw = new Map([
      [probeFiles[0], source],
      [probeFiles[1], `import { load } from './__probe_import.ts'\nexport const used = load\n`],
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

  // The binding count behind no-unreferenced-export is the round-three fix, so the counterexample
  // that walked through the word search has its own leg: an export nothing imports whose *name*
  // occurs in another file as a member name must fire, and the same export, bound by an import,
  // must not.
  for (const [label, user, expected] of [
    ['an export whose name occurs elsewhere only as a member', `export const holder = { orphan: 2 }\n`, 1],
    ['the same export, bound by an import', `import { orphan } from './__probe_export.ts'\nexport const used = orphan\n`, 0],
  ]) {
    const probeFiles = ['src/__probe_export.ts', 'src/__probe_export_user.ts']
    const probeRaw = new Map([
      [probeFiles[0], `export const orphan = 1\nexport const other = 2\n`],
      [probeFiles[1], user],
    ])
    const findings = DETECTORS.find(detector => detector.name === 'no-unreferenced-export').detect(probeFiles, {
      raw: probeRaw,
      code: new Map([...probeRaw].map(([file, text]) => [file, codeOnly(text)])),
    })
    const orphans = findings.filter(finding => finding.includes('orphan'))
    if (orphans.length === expected) {
      console.log(`  ok    no-unreferenced-export handled ${label} (${expected} finding${expected === 1 ? '' : 's'})`)
    } else {
      missed += 1
      console.log(`  FAIL  no-unreferenced-export reported ${orphans.length} findings on ${label}, expected ${expected}`)
    }
  }

  // The inventory reads the registries and the ledger, so its probe hands the check synthetic
  // declarations and synthetic ledgers: each way the two can disagree must produce a finding, or the
  // ledger protects nothing. A kind's member set is a case of its own, because that is the half the
  // ledger could not see.
  const probeLedger = kinds => ({ protocols: [{ protocol: 'probe', version: 1, subject: 's', producedBy: 'p', readBy: 'r', kinds }] })
  const probeDeclared = [{ protocol: 'probe', version: 1, kinds: [{ name: 'probe/kind', members: ['alpha', 'beta'] }] }]
  const probeKinds = [
    { name: 'probe/kind', members: ['alpha', 'beta'] },
    { name: 'never/declared', members: [] },
  ]
  for (const [label, ledger, declared] of [
    ['a kind the code declares but the ledger omits', probeLedger([]), probeDeclared],
    ['a member the code accepts but the ledger omits', probeLedger([{ name: 'probe/kind', members: ['alpha'] }]), probeDeclared],
    ['a member the ledger lists but the parser refuses', probeLedger([{ name: 'probe/kind', members: ['alpha', 'beta', 'ghost'] }]), probeDeclared],
    ['a kind the ledger lists but the code does not declare', probeLedger(probeKinds), probeDeclared],
    ['a protocol the ledger names and no code declares', { protocols: [...probeLedger(probeKinds).protocols, { protocol: 'ghost', version: 1, kinds: [], subject: 's', producedBy: 'p', readBy: 'r' }] }, probeDeclared],
    ['a ledger row written as a bare kind name, the shape that could not see a member', probeLedger(['probe/kind']), probeDeclared],
    ['a ledger row with no member set at all', probeLedger([{ name: 'probe/kind' }]), probeDeclared],
  ]) {
    const findings = inventoryFindingsWith(ledger, declared)
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  protocol-inventory did not fire on ${label}`)
    } else {
      console.log(`  ok    protocol-inventory fired on ${label} (${findings.length} findings)`)
    }
  }

  // The member set is read out of the parser's own refusal, so the reading itself must be able to
  // fail in both directions: a parser that accepts the probe has no closure at all, and a parser
  // that refuses without naming a set is one the gate cannot see. Both are findings, never silence.
  for (const [label, parse] of [
    ['a parser that accepts a member no kind declares', () => ({})],
    [
      'a parser that refuses without naming its closed set',
      () => {
        throw new Error('this payload is refused, but nothing here says what it accepts')
      },
    ],
  ]) {
    const declared = [{ protocol: 'probe', version: 1, kinds: [{ name: 'probe/kind', members: acceptedMembers({ parse }, 'probe/kind') }] }]
    const findings = inventoryFindingsWith(probeLedger([{ name: 'probe/kind', members: ['alpha'] }]), declared)
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  protocol-inventory did not fire on ${label}`)
    } else {
      console.log(`  ok    protocol-inventory fired on ${label} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
    }
  }

  // The sweep is what replaced the regex, so the sweep itself needs a leg that proves it can see a
  // declaration the text cannot: a module that declares on a registry it built for itself, with the
  // call spelled `X['declare'](…)`. It is a data: module rather than a file so the probe writes
  // nothing to the tree. Its site is not a protocol.ts, and its shape is in no ledger row.
  const sneakModule = `data:text/javascript,${encodeURIComponent(
    `import { ProtocolRegistry } from ${JSON.stringify(new URL('../src/protocol/registry.ts', import.meta.url).href)}
const PRIVATE = new ProtocolRegistry()
PRIVATE['declare']('sneak', 1, { initialState: {}, kinds: { 'sneak/leaked': { guarantees: { appended: true }, emitter: () => 'scheduler', parse: () => ({}), reduce: state => state } } })
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
  // Its other branch, which must not be silence either: a declarer that refuses the registry the
  // gate hands it leaves the inventory unable to say what it declares.
  if (sneaked.refusals.length === 0) {
    missed += 1
    console.log('  FAIL  the declaration sweep did not report a declarer that refused its registry')
  } else {
    console.log(`  ok    the declaration sweep reported a refused declarer (${sneaked.refusals.length} finding)`)
  }

  // The text net under the sweep has a leg too, and it states its own limit: it fires on the dot
  // spelling, which is the one the round-three bypass did *not* use.
  for (const [label, source, expected] of [
    ['a dot-spelled declaration in a module no load reached', 'const registry = new ProtocolRegistry()\nregistry.declare("sneak", 1, {})\n', 1],
    ['the same declaration spelled with brackets', "const registry = new ProtocolRegistry()\nregistry['declare']('sneak', 1, {})\n", 0],
  ]) {
    const findings = declarationTextFindings('src/__probe_declare.ts', source)
    if (findings.length === expected) {
      console.log(`  ok    the text net handled ${label} (${expected} finding${expected === 1 ? '' : 's'})`)
    } else {
      missed += 1
      console.log(`  FAIL  the text net reported ${findings.length} findings on ${label}, expected ${expected}`)
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
  const sweep = await declaredProtocols()
  DECLARED = sweep.declared
  const results = scan(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) })
  const inventory = results.find(result => result.name === 'protocol-inventory')
  // The sweep's own verdicts, which are not detector findings: a declarer this gate could not ask,
  // where a declaration was written, and the text net under the modules no load accounted for. A
  // file the sweep did observe is not handed to the net, so one spelling is not reported twice.
  const observedSites = new Set(sweep.sites.map(entry => entry.site))
  const unaccounted = files.filter(file => file.startsWith('src/') && !/(^|\/)protocol\.ts$/.test(file) && !observedSites.has(file))
  for (const finding of [...sweep.refusals, ...declarationSiteFindings(sweep.sites), ...declarationSitesOutsideProtocolModules(unaccounted)])
    inventory?.findings.push(finding)
  let failed = 0
  console.log(`gates: ${DETECTORS.length} gates over ${files.length} files\n`)
  // Coverage is stated rather than implied. The first line is a property of the mechanism itself, so
  // it prints on every run: the parser answers for the members it reads at the top level, and a
  // nested closed shape is only reachable by synthesising a valid payload, which this is not. The
  // second is about this run: these modules could not be imported and asked, so their declarations
  // are the one thing below that is matched by text instead of observed.
  console.log('  note  protocol-inventory reads a kind\'s payload members from its parser; a member added inside a nested shape (contract.criteria[], revision, …) is not part of that comparison')
  if (sweep.unloaded.length > 0)
    console.log(`  note  protocol-inventory could not load ${sweep.unloaded.length} module(s) (${sweep.unloaded.join(', ')}); their declarations are read as text, not observed`)
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
