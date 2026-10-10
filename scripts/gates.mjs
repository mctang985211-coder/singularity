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
 * - **A mechanism loses to a spelling only where the mechanism is not applied.** Round four defeated
 *   four of round three's closes by moving the same trick one step outside what the close looked at:
 *   a parser whose accepted set depends on the payload (the member set was sampled once), a module
 *   no load reaches (the text net under it was the spelling round three had already walked through),
 *   a barrel re-export (a re-export was counted as a use), a dynamic import whose argument is a
 *   concatenation (its first token was read as the whole target). Each is closed by asking the thing
 *   that can answer — the parser with a family of payloads, the module by loading it with its host
 *   imports stubbed, the re-export by requiring the re-exported name to be used somewhere, the import
 *   by reading the whole argument — and each close prints what it still cannot reach.
 * - **A verdict read as a substring is not a verdict.** Nine gates run a behavioural script and read
 *   a line it prints, and a one-line stub printing that line passed all of them, including the one
 *   that covers a whole phase's exit condition. So each of those gates now runs its script twice: a
 *   verdict is load-bearing only if it changes when the tree it judges changes.
 *
 * Usage:
 *   node scripts/gates.mjs           scan the real tree
 *   node scripts/gates.mjs --probe   self-test: every detector must fire on a violating input
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
 * the specifier it came from, whether the clause forwards the name instead of importing it, plus the
 * specifier of any namespace binding.
 *
 * The clause is read out of the code view, so a clause inside a comment or a string is not a
 * binding; the specifier itself is then read out of the raw text at the same offsets, because
 * `codeOnly` blanks string contents by design — reading it from the code view would compare the
 * names against blanks.
 *
 * The two kinds of clause are told apart here rather than at the counting site, because they are not
 * the same act: an import is a use of the name, and `export { X } from './y.ts'` is a *forwarding* of
 * it. Round four walked through the version that counted both as uses: a dead export re-exported by
 * `src/index.ts` was vouched for by the barrel that published it.
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
 * The file a relative specifier names, or `undefined` when it leaves the scanned tree.
 *
 * A `.js` specifier resolves to the `.ts` file beside it, because that is what the compiler does with
 * this configuration (`allowImportingTsExtensions`, `moduleResolution: nodenext`, no emit): the
 * written path is what the *output* would be called. Round four's L-3: the binding check resolved
 * only the literal path, so a module imported as `'./x.js'` bound nothing and the file it came from
 * was reported as an export nobody uses — a false positive tsc would never produce.
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
 * The published surface a consumer outside this repository uses and nothing here binds.
 *
 * Round three made a name count as used when another module *binds* it, and wrote that a re-export
 * "counts where `X` is declared, and counting it twice would let a barrel file vouch for a name
 * nothing uses". Round four measured that the fix had landed on the declaring side only: the barrel's
 * `export { X } from './y.ts'` was still counted as a use of `y.ts`'s `X`, so any name re-exported by
 * `src/index.ts` was vouched for no matter how dead, while the same name without the barrel was
 * reported. The loop is closed on both sides now — a forwarding clause is a use only when the
 * forwarding module's own name is used — and what that leaves is this list.
 *
 * These are the names `src/index.ts` publishes that nothing in `src/`, `tests/` or the specs binds.
 * Their consumer is the host that mounts this plugin, which no gate in this repository can see, so
 * the honest treatment is a recorded act rather than a checked one: publishing a name nothing here
 * binds fails the gate unless the name is recorded here, and a recorded name that has since been
 * bound (or is no longer published) fails it too. It is a ratchet, like the evidence budget: it makes
 * publishing a name visible and deliberate, not impossible. A deliberate addition edits this list in
 * the same commit; that is the whole point of the list.
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
  'src/task/bubble.ts\0BUBBLE_INPUT_MEMBERS',
  'src/task/bubble.ts\0BUBBLE_MEMBERS',
  'src/task/bubble.ts\0WORKSPACE_MEMBERS',
  'src/task/commands.ts\0AgentCommands',
  'src/task/commands.ts\0HeldAgent',
  'src/task/commands.ts\0TaskCommandOptions',
  'src/task/commands.ts\0TaskCommands',
  'src/task/commands.ts\0VerdictInput',
  'src/task/contract.ts\0CONTRACT_MEMBERS',
  'src/task/contract.ts\0CRITERION_MEMBERS',
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

/**
 * Every export no other module binds, with the two ways a name can still be accounted for.
 *
 * Round two counted a name as used when the *word* appeared anywhere, so an export whose name was a
 * member name elsewhere stayed green. Round three replaced that with a binding check and round four
 * walked through what was left of it: a re-export counted as a binding of its target.
 *
 * A re-export is not a use. It is a *forwarding* of the name, and it is a use of the forwarded name
 * only when the forwarding module's own name is used, transitively, by an import: `src/task/protocol.ts`
 * re-exporting `RunStatus` from `run.ts` counts because a spec imports `RunStatus` from `protocol.ts`;
 * the barrel re-exporting a name nothing imports counts for nothing.
 *
 * What is left after that is the honest remainder — names the entry point publishes that nothing in
 * this repository binds, whose only consumer is outside it. No gate here can see that consumer, so
 * those are recorded in `PUBLISHED_WITHOUT_CONSUMER` rather than waved through, and the record is
 * checked in both directions. Both the record and the entry point are parameters, so the self-test
 * can hand this function a different one of either and watch it fire.
 */
function unreferencedExportFindings(files, views, recorded) {
  const findings = []
  const used = new Set()
  const forwarded = []
  for (const file of files) {
    const { bound: names, namespaces } = moduleBindings(views.code.get(file), views.raw.get(file))
    for (const specifier of namespaces) {
      if (resolveModule(file, specifier, files) === undefined) continue
      findings.push(`${file} imports ${specifier} as a namespace binding; a namespace hides which of that module's exports are used, so no count can be made — name what you use`)
    }
    for (const { name, specifier, forwarding } of names) {
      const target = resolveModule(file, specifier, files)
      if (target === undefined) continue
      if (forwarding) forwarded.push({ from: file, to: target, name })
      else used.add(`${target}\0${name}`)
    }
  }
  // A forwarded name is used exactly when the module doing the forwarding is used, so the uses walk
  // backwards along the forwarding edges to a fixpoint instead of stopping at the barrel.
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
    for (const name of declaredExports(views.code.get(file))) {
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
  // The record only shrinks: an entry that something now binds, or that is no longer published, is a
  // stale claim about the tree, which is the same defect as an unreferenced export written backwards.
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
        //
        // Round four's H-2: "everything else" was decided by the *first token*, so
        // `await import('node:' + 'fs/promises')` read as the literal `'node:'`, passed as "not a
        // filesystem module", and wrote a real file with all nineteen gates green. The literal is now
        // the whole argument or the import is refused: one literal, closed by the `)` that ends the
        // call. The concatenation spelling is refused because it is not readable, which is what this
        // comment claimed all along.
        for (const match of views.code.get(file).matchAll(/(?<![\w$.])import\s*\(/g)) {
          const at = `${file}:${lineOf(views.code.get(file), match.index)}`
          const literal = /^\s*(['"])([^'"]*)\1\s*\)/.exec(views.raw.get(file).slice(match.index + match[0].length))
          if (literal === null)
            findings.push(`${at} loads a module through a dynamic import whose target is not one quoted literal the gate can read on its own (a concatenation, a template, a variable or an expression); no module may write durably, so a dynamic import may only name one literal module, and never a filesystem one`)
          else if (FS_MODULES.has(literal[2]))
            findings.push(`${at} dynamically imports ${literal[2]}; no module may write durably; DSH session persistence owns the medium`)
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
 * The gates the synthetic file set cannot reach: they spawn real processes and read the real tree.
 *
 * The self-test filters them out **before** it scores anything. Running them first and discarding
 * the result afterwards is not the same thing: it ran three end-to-end scripts to completion, threw
 * their verdicts away, and then `pnpm gates` ran them a second time for real.
 */
const REAL_TREE_GATES = new Set(DETECTORS.filter(detector => detector.realTree === true).map(detector => detector.name))

/**
 * The evidence budget, and its ratchet.
 *
 * Round four's seventh pattern: `sourceFiles()` scans `src/` and `tests/` `.ts` files, so `scripts/`
 * (fifteen files, seven thousand lines) and `tests/fixtures/*.json` were in no detector and no budget,
 * while `tests/*.spec.ts` was charged for every line and sat at 0.8489 against its 0.85 ratchet. The
 * phase delivered entirely in that unwatched lane — nine hundred and eighty-two probe lines, one
 * fixture, a verdict read by substring — was the phase whose checks the ratchet did not charge. The
 * ratchet did not merely fail to constrain that work; it made adding probe lines the cheapest way to
 * discharge an exit condition.
 *
 * So the numerator is *evidence*, not specs: every `.ts` file under `tests/` (specs, fixtures and
 * helpers), every file under `tests/fixtures/` (JSON included, counted by line), and every `.mjs`
 * file directly under `scripts/`. The denominator stays the `.ts` files under `src/`. Not charged, and named so a reader can see the holes rather
 * than assume there are none: `docs/**`, and `scripts/` subdirectories (there are none today).
 *
 * Renaming the gate is part of the fix rather than tidying: a gate called `spec-budget` whose
 * numerator was not specs would be a printed claim that is not true, which is the defect this round
 * found in `protocol-inventory`'s note.
 *
 * The number jumps, and that is the honest number — the constraint was always there, it was simply
 * not being charged. Both measurements are recorded so the jump is visible rather than mysterious,
 * taken on the clean tree at the moment of the change (including this file, which is one of the
 * fifteen under `scripts/`, so a line added here is charged like any other line of evidence):
 * `tests/*.spec.ts` alone was 7,239 lines
 * against 8,530 of source, 0.8487 (the old ratchet, 0.85); all evidence is 15,962 against 8,530,
 * 1.8713 (this ratchet, rounded up at the fourth decimal, so a rounding can never be a quiet
 * widening).
 *
 * These are ratchets, not targets: the numbers came down from 0.88 and 7.8 by deleting restatement,
 * and may only go down further. Lowering one is part of the commit that makes it possible.
 */
const EVIDENCE_BUDGET = 1.8713
const SPEC_DENSITY = 5

/**
 * Every file the budget charges besides the source itself, with its line count.
 *
 * Read from disk rather than from the scanned file set, because much of the evidence is not a `.ts`
 * file under `src/` or `tests/` — which is exactly the reason the budget had to be renamed.
 */
function evidenceFiles() {
  const paths = new Set(sourceFiles().filter(file => file.startsWith('tests/')))
  try {
    for (const entry of readdirSync(join(ROOT, 'tests', 'fixtures'), { recursive: true, withFileTypes: true }))
      if (entry.isFile()) paths.add(relative(ROOT, join(entry.parentPath ?? entry.path, entry.name)))
  } catch {
    // A fixture directory that does not exist contributes nothing.
  }
  for (const entry of readdirSync(join(ROOT, 'scripts'), { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith('.mjs')) paths.add(`scripts/${entry.name}`)
  return [...paths].sort().map(file => ({ file, lines: readFileSync(join(ROOT, file), 'utf8').split('\n').length }))
}

/** The evidence's size against the source's, over the same file set the other gates see. */
function evidenceBudgetFindings(files, views, evidence) {
  const source = files.filter(file => file.startsWith('src/')).reduce((total, file) => total + views.raw.get(file).split('\n').length, 0)
  if (source === 0) return []
  const charged = evidence.reduce((total, entry) => total + entry.lines, 0)
  const ratio = charged / source
  return ratio > EVIDENCE_BUDGET
    ? [
        `the evidence is ${charged} lines against ${source} of source (${ratio.toFixed(4)}, budget ${EVIDENCE_BUDGET}); evidence that grows with the source is locking structure, and evidence that grows without it is a check nobody charged for - delete the check that states no external fact - see docs/spec-policy.md`,
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
 *
 * What it does not reach, said here instead of being implied: a behavioural script's checks are
 * `check(...)` calls and its denominator is the script, so the same arithmetic over `scripts/` would
 * divide a count by one. That ratio says nothing about redundancy, and a script's own report of how
 * many checks it made is a self-report rather than a fact this gate can weigh. The evidence budget
 * charges a probe's *size*; nothing here charges its structure, and a line of arithmetic that only
 * looked like a constraint would be worse than this paragraph.
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

/** One parser's answer to one payload: a named member set, an acceptance, or a refusal that names nothing. */
function parseSample(rule, payload, where) {
  try {
    rule.parse(payload, where)
  } catch (error) {
    const closed = /shape is closed \(known: ([^)]*)\)/.exec(String(error?.message ?? error))
    if (closed !== null)
      return {
        kind: 'closed',
        members: closed[1]
          .split(',')
          .map(name => name.trim())
          .filter(name => name.length > 0)
          .sort(),
      }
    return { kind: 'unreadable', detail: `${error?.message ?? error}`.split('\n')[0] }
  }
  return { kind: 'open' }
}

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
 * Round four's BL-3: **one payload is a sample of one branch, not the member set.** A parser written
 * as `source['revision'] !== undefined ? ['runId', 'revision', 'operatorNote'] : ['runId', 'revision']`
 * answered `['revision', 'runId']` to the probe, the ledger agreed with that answer, and a fact
 * carrying `operatorNote` was committed and folded through the real store with all nineteen gates
 * green. What a parser accepts is a function of the payload it is handed, so the honest reading is a
 * family of payloads — the probe member alone, then the probe member beside every member the parser
 * has named so far, until the answer stops changing — and if two samples disagree, the accepted set
 * depends on the payload and there is no single member set to compare with the ledger. That is a
 * finding, not an average: the gate refuses to state a set it cannot read.
 *
 * Four answers, all meaningful: the closed set; `open` when the parser accepted the probe member, so
 * the payload is not closed at all; `unreadable` when it refused without naming a set, so the gate
 * cannot see the shape; and `conditional` when the samples disagree, so there is no one shape to see.
 *
 * What the family still does not reach, printed on every run because it is a limit of the mechanism:
 * a parser conditioned on anything outside the payload's own member set — a module-level flag, the
 * `where` argument, a clock — is reached by no sample at all, and a condition on a *value*
 * (`source['runId'] === 'special'`) only by the probe value that happens to match it.
 */
function acceptedMembers(rule, where) {
  const payloadOf = names => Object.fromEntries([...names.map(name => [name, { [PROBE_MEMBER]: true }]), [PROBE_MEMBER, true]])
  const samples = []
  const named = []
  for (let round = 0; round < 4; round += 1) {
    const answer = parseSample(rule, payloadOf(named), where)
    if (answer.kind !== 'closed')
      return samples.length === 0 ? answer : { kind: 'conditional', samples: [...samples, `${answer.kind}: ${answer.detail ?? ''}`.trim()] }
    if (samples.length > 0 && samples[0].join(',') !== answer.members.join(','))
      return { kind: 'conditional', samples: [...samples, answer.members] }
    samples.push(answer.members)
    const grown = answer.members.filter(name => !named.includes(name))
    if (grown.length === 0) break
    named.push(...grown)
  }
  return { kind: 'closed', members: samples[0] }
}

/**
 * Where a `declare` call was written, read from the stack rather than from the text.
 *
 * The nearest frame inside `src` that is not the registry itself. `declareEnvironmentProtocol(FOLD)`
 * called from another module therefore reports the declarer in the slice's `protocol.ts`: the
 * declaration is *written* there, and where it is called from is not where it lives. A call written
 * directly in some other module reports that module, which is what the rule below refuses.
 *
 * A module loaded from somewhere with no path into `src` — a synthetic module the self-test hands the
 * sweep, a module retried under a cache-busting URL — has no such frame, so the module the sweep is
 * currently importing answers instead. That is the same fact the stack would have given: the
 * declaration happened while that module was loading.
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
 * A value that answers to anything, for the host packages this process cannot install.
 *
 * Callable, constructable, and every property of it is itself, except `then` (a stub that looks
 * thenable would make an `await` on it hang) and the primitive coercions (a `Symbol.toPrimitive` that
 * returned a stub would throw where a string is expected). This is a stub for *loading*, not a model
 * of the package: the sweep wants the module's load-time behaviour, not the host's.
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
 * Whether a specifier names a package the host installs rather than a path or a URL.
 *
 * `file:` and `data:` specifiers are what a module's own imports of this tree look like, and stubbing
 * them would replace this tree's own modules with a stub — which is exactly what happened when this
 * scan accepted anything that was not `.`-relative or `node:`, and what made a synthetic module's
 * registry a native-code proxy instead of this process's class.
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
 * import them, and the *only* net under them was the text pattern for `.declare` — the spelling round
 * three had already walked through with `X['declare'](…)`. The third-round bypass, moved into
 * `src/runtime/agent-session.ts`, was green while the identical insertion into a loadable module was
 * reported; and a new `src/runtime/protocol.ts` — the conventional home of a declaration — was
 * covered by neither mechanism, because it was filtered out of the text net while the run's own note
 * said those modules' declarations were read as text. So the modules are loaded instead: every
 * specifier they name that this process cannot resolve is answered with a generated stub module, and
 * the import is retried. What a module declares at load time is then *observed*, whichever way the
 * call is spelled, whether or not it lives in a `protocol.ts`.
 *
 * The names a stub exports come from the tree's own import clauses. That scan is a text scan, and it
 * is allowed to be one because it is not the mechanism: a name it misses makes the import fail, and a
 * module that cannot be loaded is a *finding* — never a quiet pass.
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
 * What the code actually declares, asked of the running code rather than read out of the source.
 *
 * Three rounds found the same weakness three times, each time as a spelling: a declaration through
 * an exported `declare*Protocol` in a slice's `protocol.ts` (found), the same declaration on a
 * registry the module built for itself and reached with `X['declare'](…)` (missed, because the only
 * sweep was a text pattern), and the payload's member set (invisible, because it lives inside a
 * function). So this asks the runtime:
 *
 * 1. **every module under `src` is imported**, with the one
 *    `ProtocolRegistry.prototype.declare` wrapped. A declaration is therefore observed however the
 *    call is spelled and whichever registry it lands on — `X.declare(…)`, `X['declare'](…)` and a
 *    destructured `declare` all arrive at the same method, and a registry built inside a module is
 *    no hiding place. A module whose host imports do not resolve here is imported *again* with those
 *    imports stubbed, so "this process cannot load it" is no longer a place the sweep stops;
 * 2. **every exported `declare*Protocol` is then called** with a registry of this gate's own, which
 *    is how a declaration that only happens when somebody calls it is seen at all;
 * 3. **each observed kind's member set is read from its parser** (`acceptedMembers` above), so a
 *    payload member is part of the declared surface the ledger compares — and a parser whose answer
 *    depends on the payload is refused rather than sampled.
 *
 * What this does not catch, written down because a gate's coverage is part of what it promises:
 *
 * - a declaration that only runs on a path no load reaches — the sweep sees module load and the
 *   exported declarers, not every call site. The text sweep below is the net under it, and that net
 *   matches the dot spelling only, which round three defeated with `X['declare'](…)`;
 * - a module that cannot be loaded even with its host imports stubbed (a syntax error, a host import
 *   this scan did not see, a module that needs a real host to evaluate). It is reported as a finding
 *   naming exactly that, instead of being covered by the spelling-dependent net quietly;
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
  /** Modules this process could only import with their host packages stubbed, by name. */
  const stubbed = []
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
  const attempt = async module => {
    LOADING = module.name
    try {
      return { loaded: await import(module.url.href) }
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
  return { declared, sites, unloaded, stubbed, refusals }
}

/**
 * A module no load reached even with its host imports stubbed: a gap, reported rather than noted.
 *
 * The text net below still covers it, and that net matches the dot spelling only — so the honest
 * report is a finding that says so, not a note that reads as coverage. Round four's BL-4 was exactly
 * this: the note said "their declarations are read as text, not observed" without saying that the
 * text net had already been defeated, and one of the modules it named was not even read as text.
 */
function unobservableDeclarations(unloaded) {
  return unloaded.map(
    ({ name, error }) =>
      `${name} could not be imported even with its host imports stubbed (${error}); a declaration in it is not observed, and the text net over it matches the dot spelling only, which round three walked through with X['declare'](…) — make the module loadable, or declare the shape in a module this sweep reaches`,
  )
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
 * The unreadable answers are findings rather than silence, because a shape the gate cannot read must
 * not read as a shape that is fine. `conditional` is the round-four case: the parser answered
 * differently to two payloads, so the accepted set is a function of the payload and the ledger can
 * only be compared with a set that exists. Reporting one branch's answer here is how a member the
 * ledger does not list stayed invisible while a real fact carried it.
 */
function shapeFindings(where, kind, line) {
  if (kind.members.kind === 'open')
    return [
      `${where} ${kind.name} accepted a payload member no kind declares (${PROBE_MEMBER}); its payload is not closed, so a member can be added with nothing to notice it`,
    ]
  if (kind.members.kind === 'unreadable')
    return [
      `${where} ${kind.name} refused the gate's probe without naming its closed member set (${kind.members.detail}); the gate reads a shape's members out of that refusal, so the check that refuses an unknown member has to come before the rest of the parser`,
    ]
  if (kind.members.kind === 'conditional')
    return [
      `${where} ${kind.name} answers with a different accepted member set depending on the payload it is given (${kind.members.samples
        .map(sample => (Array.isArray(sample) ? `known: ${sample.join(', ')}` : sample))
        .join(' vs ')}); the accepted set is a function of the payload, so no single member set can be compared with the ledger and the ledger cannot say what this shape is — close the payload unconditionally, or bump the version and declare the members it accepts`,
    ]
  const listed = [...line.members].sort()
  const missing = kind.members.members.filter(member => !listed.includes(member))
  const extra = listed.filter(member => !kind.members.members.includes(member))
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

/**
 * A copy of this tree with `src/` taken away, for asking a behavioural script whether it judges.
 *
 * Round four's H-3: `ok domain-comparison` was a substring match on stdout, and a one-line script
 * printing that line passed it — the gate could not tell the 982-line probe from a stub, and that
 * gate covers phase F's entire exit condition. Nine gates read a script's verdict this way, and the
 * self-test never ran a script at all.
 *
 * A verdict is load-bearing only if it changes when the thing it judges changes, so every
 * behavioural script is run a second time in a copy of this tree whose `src/` is gone. A script that
 * judges the tree fails there; a script that prints a constant reports its marker there too, and that
 * is the finding. The copy is made once per run, lazily, and removed when the process exits.
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
 * The second run of one behavioural script: the same script, in a tree with no `src/`.
 *
 * A non-zero exit is the expected outcome and says the script is load-bearing. Reporting the marker
 * with exit 0 in a tree that has nothing to judge is the finding, and it says what it observed rather
 * than implying the script is fraudulent.
 *
 * What this does not catch, and the run therefore does not claim: a script that checks for `src/` and
 * prints its marker only when it is present is not distinguished from one that judges the tree. This
 * leg rules out a verdict that is a constant; it does not establish that a verdict is correct.
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
  // The two arithmetic gates reduce to arithmetic over a file set and a charged set, so each probe
  // hands them one that breaks it. Without this they would be numbers nobody has watched fail — and
  // the evidence budget's charged set now includes a script and a fixture, because that is where the
  // work it charges for actually lives.
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
  // module is legal — a rule that refused every dynamic import would be a different rule. The fourth
  // leg is round four's H-2: a concatenation whose *first* token is a quoted literal used to read as
  // that literal, so `'node:' + 'fs/promises'` passed as "not a filesystem module" while writing a
  // real file. The literal is the whole argument or the import is refused.
  for (const [label, source, expected] of [
    ['a dynamic import of a filesystem module', `export const load = async () => (await import('node:fs/promises')).writeFile\n`, 1],
    ['a dynamic import whose target the gate cannot read', 'export const load = async target => await import(target)\n', 1],
    ['a dynamic import of a module that is not a filesystem one', `export const load = async () => await import('./helper.ts')\n`, 0],
    ['a filesystem module spelled as a concatenation of two literals', `export const load = async () => (await import('node:' + 'fs/promises')).writeFile\n`, 1],
    ['a filesystem module spelled as a template literal', 'export const load = async () => (await import(`node:fs/promises`)).writeFile\n', 1],
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
  // must not. Round four's H-1 gets legs too, because the barrel was the remaining way to be
  // vouched for: a name nothing binds that the entry point re-exports is a finding unless the
  // published-surface record names it, and a recorded name something now binds is a finding, so the
  // record can only shrink. L-3 is here as well: a `.js` specifier is what tsc resolves for a `.ts`
  // file, so the binding it carries has to count, or the file it came from is a false positive.
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
  // The barrel legs again, with the entry point named: the same two files, one of them `src/index.ts`
  // re-exporting the name, and the published-surface record as the only thing that can excuse it.
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

  // The inventory reads the registries and the ledger, so its probe hands the check synthetic
  // declarations and synthetic ledgers: each way the two can disagree must produce a finding, or the
  // ledger protects nothing. A kind's member set is a case of its own, because that is the half the
  // ledger could not see.
  const probeLedger = kinds => ({ protocols: [{ protocol: 'probe', version: 1, subject: 's', producedBy: 'p', readBy: 'r', kinds }] })
  const probeDeclared = [{ protocol: 'probe', version: 1, kinds: [{ name: 'probe/kind', members: { kind: 'closed', members: ['alpha', 'beta'] } }] }]
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
  // fail in every direction: a parser that accepts the probe has no closure at all, a parser that
  // refuses without naming a set is one the gate cannot see, and — round four's BL-3 — a parser whose
  // accepted set depends on the payload has no single answer to read. All three are findings, never
  // silence, and the third is asserted to be the *conditional* answer rather than any finding at all,
  // because "some finding appeared" is not the same claim as "the conditional parser was refused".
  const conditionalParse = raw => {
    const source = raw
    const known = source['revision'] !== undefined ? ['revision', 'runId', 'operatorNote'] : ['revision', 'runId']
    for (const key of Object.keys(source)) if (!known.includes(key)) throw new Error(`the shape is closed (known: ${known.join(', ')})`)
    return source
  }
  for (const [label, parse, expected] of [
    ['a parser that accepts a member no kind declares', () => ({}), 'open'],
    [
      'a parser that refuses without naming its closed set',
      () => {
        throw new Error('this payload is refused, but nothing here says what it accepts')
      },
      'unreadable',
    ],
    ['the conditional parser that walked through the one-payload sample', conditionalParse, 'conditional'],
  ]) {
    const answer = acceptedMembers({ parse }, 'probe/kind')
    const declared = [{ protocol: 'probe', version: 1, kinds: [{ name: 'probe/kind', members: answer }] }]
    const findings = inventoryFindingsWith(probeLedger([{ name: 'probe/kind', members: ['alpha'] }]), declared)
    if (answer.kind !== expected || findings.length === 0) {
      missed += 1
      console.log(`  FAIL  protocol-inventory did not fire on ${label} (read ${answer.kind}, expected ${expected}, ${findings.length} findings)`)
    } else {
      console.log(`  ok    protocol-inventory read ${answer.kind} and fired on ${label} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
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

  // Round four's BL-4a, as a leg: a module this process cannot import because it names a host package
  // that is not installed here, which declares at load time with the bracket spelling. Before the fix
  // it was green — the sweep never reached the module and the text net cannot see that spelling — so
  // the leg hands the sweep exactly that module, written to a temp file, and requires the sweep to
  // have loaded it with its host import stubbed *and* the inventory to report the shape. It is a
  // `.mjs` so nothing here depends on type stripping, and it imports the registry by file URL so the
  // declaration lands on this process's own registry prototype.
  const hostImportRoot = mkdtempSync(join(tmpdir(), 'gates-host-import-'))
  const hostImportModule = join(hostImportRoot, 'probe-host-import.mjs')
  writeFileSync(
    hostImportModule,
    `import { Nothing } from '@deepseek-ai/dsh-not-installed'
import { ProtocolRegistry } from ${JSON.stringify(new URL('../src/protocol/registry.ts', import.meta.url).href)}
const HIDDEN = new ProtocolRegistry()
HIDDEN['declare']('hidden', 1, { initialState: {}, kinds: { 'hidden/leaked': { guarantees: { appended: true }, emitter: () => 'scheduler', parse: () => ({}), reduce: state => state } } })
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

  // The text net under the sweep has a leg too, and it states its own limit rather than reporting a
  // miss as a success: it fires on the dot spelling, which is the one the round-three bypass did *not*
  // use, and the bracket spelling is the reason the sweep loads the module instead of trusting a net.
  for (const [label, source, expected, judged] of [
    ['a dot-spelled declaration in a module no load reached', 'const registry = new ProtocolRegistry()\nregistry.declare("sneak", 1, {})\n', 1, 'the text net fired on the dot spelling'],
    ["the same declaration spelled with brackets", "const registry = new ProtocolRegistry()\nregistry['declare']('sneak', 1, {})\n", 0, 'the text net does not match the bracket spelling — a stated limit of the net, which is why the sweep loads the module'],
  ]) {
    const findings = declarationTextFindings('src/__probe_declare.ts', source)
    if (findings.length === expected) {
      console.log(`  ok    ${judged} (${findings.length} finding${findings.length === 1 ? '' : 's'})`)
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

  // These gates read the real tree, so each probe is a synthetic failing run of the marker check: the
  // runner returns a string that reports failure, and the gate has to say so. That is one half of the
  // check, and until round four it was the whole self-test — a string, never a script.
  for (const gate of SCRIPT_GATES) {
    const findings = scriptFindings(gate.name, gate.markers, () => 'ok\nsome checks failed\n')
    if (findings.length === 0) {
      missed += 1
      console.log(`  FAIL  ${gate.name} did not fire on a failing run`)
    } else {
      console.log(`  ok    ${gate.name} fired (${findings.length} findings)`)
    }
  }

  // The other half, with real processes: round four's H-3 was that the self-test never ran a script,
  // so a one-line stub printing `domain-probe: OK` was reported as "fired" while the live gate
  // reported `ok domain-comparison`. These two legs run actual scripts in a tree with no `src/`: the
  // stub must be reported as not load-bearing, and a script that judges the tree must not be.
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
  const results = scan(files, { raw, code: new Map([...raw].map(([file, text]) => [file, codeOnly(text)])) })
  const inventory = results.find(result => result.name === 'protocol-inventory')
  // The sweep's own verdicts, which are not detector findings: a declarer this gate could not ask,
  // where a declaration was written, and the text net under the modules no load accounted for. A
  // file the sweep did observe is not handed to the net, so one spelling is not reported twice.
  const observedSites = new Set(sweep.sites.map(entry => entry.site))
  // Every module under `src` no load and no observation accounted for, `protocol.ts` included: a
  // module whose declaration was observed needs no text net, and one whose was not needs it whether
  // or not its name is conventional. Filtering `protocol.ts` out here is what left the one place a
  // declaration conventionally lives with no coverage at all when it could not be loaded.
  const unaccounted = files.filter(file => file.startsWith('src/') && !observedSites.has(file))
  for (const finding of [...sweep.refusals, ...declarationSiteFindings(sweep.sites), ...declarationSitesOutsideProtocolModules(unaccounted), ...unobservableDeclarations(sweep.unloaded)])
    inventory?.findings.push(finding)
  let failed = 0
  console.log(`gates: ${DETECTORS.length} gates over ${files.length} files\n`)
  // Coverage is stated rather than implied. The first two lines are properties of the mechanism
  // itself, so they print on every run: the parser answers for the members it reads at the top level,
  // and a declaration no load reaches is covered by a text net that matches one spelling. The third
  // is about this run: a module this process could not import as written was imported again with the
  // host packages it names stubbed, so what it declares at load time is observed, not matched.
  console.log('  note  protocol-inventory reads a kind\'s payload members from its parser; a member added inside a nested shape (contract.criteria[], revision, …) is not part of that comparison')
  console.log('  note  protocol-inventory refuses a parser whose accepted member set depends on the payload it is given; a parser conditioned on anything outside the payload\'s own members is reached by no sample')
  console.log('  note  protocol-inventory observes a declaration when a module loads or an exported declarer is called; a declaration that runs only on a path no load reaches is covered by the text net alone, which matches the dot spelling and not the bracket one')
  if (PUBLISHED_WITHOUT_CONSUMER.size > 0)
    console.log(`  note  no-unreferenced-export records ${PUBLISHED_WITHOUT_CONSUMER.size} name(s) that src/index.ts publishes and nothing in this tree binds; the record may only shrink, and a name published without being recorded in it is a finding`)
  // The behavioural gates' own limit, printed with the other coverage claims rather than left to the
  // docstring: what the second run rules out is a constant verdict, not a fabricated one.
  console.log('  note  every behavioural gate runs its script twice, once here and once in a copy of this tree with src/ removed, so a verdict that does not depend on the tree is reported; a script that reproduces that dependence without judging the tree is not distinguished by it')
  if (sweep.stubbed.length > 0)
    console.log(`  note  protocol-inventory could not import ${sweep.stubbed.length} module(s) as written (${sweep.stubbed.join(', ')}); they were imported again with the host packages they name stubbed, so what they declare at load time is observed rather than matched as text`)
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
