/**
 * Shared fixtures for the live xv6 locks validation spec and its cheap
 * scripted-harness sibling: where the pristine lab lives, the user-space
 * toolchain PATH a child must inherit, the independent grader wrapper every
 * criterion runs, and the Task template library the model retrieves from.
 *
 * The xv6 locks lab is graded by the lab's own grader (`grade-lab-lock`), whose
 * name is singular. The toolchain (xpack riscv-none-elf-gcc, a user-space qemu
 * wrapper) lives under `/home/roxy/code/testbeds/tools`, is never a system
 * package, and reaches a child only through PATH.
 *
 * @module tests/support/xv6-locks
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CriterionSpec, TaskTemplate, TaskTemplateRef } from '../../task/src/index.ts'
import { checkoutTools } from './log-pipeline.ts'

/** The pristine lab the specs copy from; override with `XV6_TESTBED`. */
export const XV6_TESTBED = process.env.XV6_TESTBED ?? '/home/roxy/code/testbeds/xv6-lock'

/** The user-space toolchain's bin dir: the qemu wrapper and the prefixed gcc/ld wrappers. */
export const XV6_TOOLS_BIN = '/home/roxy/code/testbeds/tools/bin'

/** The xpack RISC-V toolchain's own bin dir. */
export const XV6_XPACK_BIN = '/home/roxy/code/testbeds/tools/xpack-riscv-none-elf-gcc-13.4.0-1/bin'

/** The per-invocation bash bound: a full grade is ~3 min under TCG, so 25 min leaves headroom. */
export const XV6_BASH_TIMEOUT_MS = 1_500_000

/** The task-runtime verifier budget the deployment must carry for a grade to fit. */
export const XV6_VERIFY_TIMEOUT_MS = 1_500_000

/** Whether the pristine lab (and thus its grader) is present on this machine. */
export function xv6TestbedPresent(testbed: string = XV6_TESTBED): boolean {
  return existsSync(join(testbed, 'grade-lab-lock'))
}

/** The pristine tree a spec copies from, refused by name when it is missing. */
export function requireXv6Testbed(testbed: string = XV6_TESTBED): string {
  if (!xv6TestbedPresent(testbed)) {
    throw new Error(
      `xv6 locks testbed not found: ${testbed}/grade-lab-lock is missing. This validation needs the user-space ` +
        'toolchain and the pristine lab under /home/roxy/code/testbeds/xv6-lock; set XV6_TESTBED to another copy.',
    )
  }
  return testbed
}

/**
 * The RISC-V toolchain and the qemu wrapper are user-space installs, so a child
 * (`make`, `qemu-system-riscv64`, the grader's python) finds them only through
 * PATH. A spec calls this at module top: the loop's tool bodies and the
 * verifier's command both spawn children that inherit `process.env`.
 */
export function ensureXv6ToolchainOnPath(): void {
  const current = (process.env.PATH ?? '').split(':').filter(segment => segment !== '')
  const missing = [XV6_TOOLS_BIN, XV6_XPACK_BIN].filter(dir => !current.includes(dir))
  if (missing.length > 0) process.env.PATH = [...missing, ...current].join(':')
}

/** Copy the pristine lab into a run checkout (excluding `.git`) and write the checker. */
export function prepareXv6Checkout(checkout: string, options: { source?: string } = {}): void {
  const source = requireXv6Testbed(options.source ?? XV6_TESTBED)
  for (const entry of readdirSync(source)) {
    if (entry === '.git') continue
    cpSync(join(source, entry), join(checkout, entry), { recursive: true })
  }
  mkdirSync(join(checkout, 'checks'), { recursive: true })
  writeFileSync(join(checkout, 'checks', 'verify.sh'), XV6_CHECKER)
}

/** `read`, `write` and `bash` with the xv6 bash bound; the shared round-4 tool set. */
export function xv6CheckoutTools() {
  return checkoutTools({ bashTimeoutMs: XV6_BASH_TIMEOUT_MS })
}

/**
 * The independent acceptance checker a spec authors into the checkout. It runs
 * the lab's own grader (under an internal 1500s timeout), parses the grader's
 * OK/FAIL lines and its final `Score: X/70`, prints the verdicts, and exits 0
 * only when the stage's requirements all hold. It never trusts the model's
 * summary: the grader's stdout is the judge.
 *
 * Stages: `kalloc`, `bcache`, `regression`, `modules` (kalloc + bcache), `all`.
 */
export const XV6_CHECKER = `#!/bin/bash
# Independent acceptance checker for the MIT 6.828 xv6 locks lab.
#
#   kalloc      kalloctest test1 and test2 both pass
#   bcache      bcachetest test0 and test1 both pass
#   regression  usertests passes
#   modules     kalloc and bcache
#   all         kalloc, bcache and regression, and the full grade prints "Score: 70/70"
#
# The grader is only ever run through this script. Its output is the judge; this
# script never reads the model's claims.

stage="$1"
case "$stage" in
  kalloc|bcache|regression|modules|all) ;;
  *)
    echo "verify.sh: unknown stage '$stage'; expected kalloc, bcache, regression, modules or all" >&2
    exit 2
    ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root" || { echo "verify.sh: cannot enter checkout root" >&2; exit 2; }

if [ ! -f grade-lab-lock ]; then
  echo "verify.sh: grade-lab-lock is missing from $root" >&2
  exit 2
fi

filter=""
case "$stage" in
  kalloc) filter="kalloctest" ;;
  bcache) filter="bcachetest" ;;
  regression) filter="usertests" ;;
  *) filter="" ;;
esac

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# The lab Makefile derives its gdb stub port from the user id alone
# (GDBPORT = id -u % 5000 + 25000), so every grader this user starts would
# listen on the same port. Two graders running at once therefore collide: the
# second refuses to start ("GDB stub found on port ...") and can disturb the
# first. The default integration suite runs this checker from more than one spec
# in parallel, so every grader invocation here is serialized on one machine-wide
# advisory lock, held only around the grader itself. Every invocation uses the
# same path even when callers carry different TMPDIR values. Refuse to grade
# without flock rather than let shared-port collisions produce false evidence.
if ! command -v flock >/dev/null 2>&1; then
  echo "verify.sh: flock is required to protect the shared xv6 grader port" >&2
  exit 2
fi
exec 9>"/tmp/xv6-lock-grader.lock"
if ! flock -w 1500 9; then
  echo "verify.sh: could not acquire the machine-wide xv6 grader lock within 1500s" >&2
  echo "verify.sh: stage $stage was NOT run" >&2
  exit 2
fi

if [ "$stage" = modules ]; then
  timeout 1500 python3 grade-lab-lock kalloctest > "$log" 2>&1
  grade_status=$?
  timeout 1500 python3 grade-lab-lock bcachetest >> "$log" 2>&1
  bcache_status=$?
  if [ "$grade_status" = 0 ]; then grade_status=$bcache_status; fi
elif [ -n "$filter" ]; then
  timeout 1500 python3 grade-lab-lock "$filter" > "$log" 2>&1
  grade_status=$?
else
  timeout 1500 python3 grade-lab-lock > "$log" 2>&1
  grade_status=$?
fi
cat "$log"

has() { grep -Eq "$1" "$log"; }

kal_t1=FAIL
has 'kalloctest: test1: OK' && kal_t1=OK
kal_t2=FAIL
has 'kalloctest: test2: OK' && kal_t2=OK
bca_t0=FAIL
has 'bcachetest: test0: OK' && bca_t0=OK
bca_t1=FAIL
has 'bcachetest: test1: OK' && bca_t1=OK
usr=FAIL
has 'usertests: OK' && usr=OK

kalloc_ok=FAIL
if [ "$kal_t1" = OK ] && [ "$kal_t2" = OK ]; then kalloc_ok=OK; fi
bcache_ok=FAIL
if [ "$bca_t0" = OK ] && [ "$bca_t1" = OK ]; then bcache_ok=OK; fi

score="$(grep -Eo 'Score: [0-9]+/[0-9]+' "$log" | tail -1)"
if [ -z "$score" ]; then score="Score: ?/?"; fi

required=OK
case "$stage" in
  kalloc) [ "$kalloc_ok" = OK ] || required=FAIL ;;
  bcache) [ "$bcache_ok" = OK ] || required=FAIL ;;
  regression) [ "$usr" = OK ] || required=FAIL ;;
  modules) { [ "$kalloc_ok" = OK ] && [ "$bcache_ok" = OK ]; } || required=FAIL ;;
  all)
    if [ "$kalloc_ok" != OK ] || [ "$bcache_ok" != OK ] || [ "$usr" != OK ]; then required=FAIL; fi
    if [ "$score" != "Score: 70/70" ]; then required=FAIL; fi
    ;;
esac

echo "--- xv6 locks verdicts (stage: $stage) ---"
echo "kalloctest: test1: $kal_t1"
echo "kalloctest: test2: $kal_t2"
echo "bcachetest: test0: $bca_t0"
echo "bcachetest: test1: $bca_t1"
echo "usertests: $usr"
echo "$score"

if [ "$grade_status" = 124 ]; then
  echo "verify.sh: the grader exceeded the internal 1500s timeout" >&2
fi
if [ "$grade_status" != 0 ]; then
  echo "verify.sh: the grader exited $grade_status; its partial output cannot pass this stage" >&2
  required=FAIL
fi

if [ "$required" = OK ]; then
  echo "verify.sh: stage $stage PASSED"
  exit 0
fi
echo "verify.sh: stage $stage FAILED" >&2
exit 1
`

/** The paths the model may not touch: the checker, the grader and its parser, the Makefile, the test programs. */
export const XV6_PROTECTED_INPUTS = [
  'checks/verify.sh',
  'grade-lab-lock',
  'gradelib.py',
  'Makefile',
  'user/kalloctest.c',
  'user/bcachetest.c',
  'user/usertests.c',
] as const

export const XV6_CONSTRAINTS = [
  'Never modify the protected acceptance inputs: checks/verify.sh, grade-lab-lock, gradelib.py, Makefile, ' +
    'user/kalloctest.c, user/bcachetest.c and user/usertests.c. Read them; never rewrite them.',
  'Work only inside the checkout. Keep the tree buildable: plain `make` must succeed — the RISC-V cross toolchain ' +
    'and qemu wrapper are already on PATH, so do not chase toolchain setup.',
  "Grade through `bash checks/verify.sh <stage>`, which invokes the lab's own `python3 grade-lab-lock [filter]` " +
    'while holding the shared-port lock. Do not invoke the grader directly. The script name is singular (grade-lab-lock). ' +
    'The lab is complete only when the full run prints `Score: 70/70`, which also requires a file `time.txt` at the ' +
    'repository root containing a single positive integer (the hours spent on the lab).',
]

/** One criterion: the named stage of the independent checker, over the protected inputs. */
export function xv6Criteria(stage: string): CriterionSpec[] {
  return [
    {
      criterionId: `${stage}-result`,
      description: `the ${stage} xv6 acceptance checker passes`,
      command: `bash checks/verify.sh ${stage}`,
      protectedInputs: [...XV6_PROTECTED_INPUTS],
    },
  ]
}

export const XV6_CATALOG = ['kernel']

function xv6Leaf(options: {
  id: string
  appliesTo: string
  objective: string
  stage: string
  catalogPath?: string[]
  version?: number
}): TaskTemplate {
  return {
    id: options.id,
    version: options.version ?? 1,
    catalogPath: options.catalogPath ?? [...XV6_CATALOG],
    appliesTo: [options.appliesTo],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective: options.objective,
      acceptanceCriteria: xv6Criteria(options.stage),
      requiredCapabilities: ['local-files'],
      constraints: XV6_CONSTRAINTS,
    },
  }
}

export function kallocTemplate(): TaskTemplate {
  return xv6Leaf({
    id: 'xv6-kalloc-percpu',
    appliesTo: 'Convert the xv6 physical page allocator to per-CPU free lists with stealing.',
    objective:
      'Rework kernel/kalloc.c so the physical page allocator stops contending on one global lock: give each CPU its own ' +
      "free list and its own lock, allocate from the calling CPU's list, free to it, and when that list is empty steal " +
      "pages from another CPU's list. Keep the allocator correct (no lost, duplicated or leaked pages; `usertests " +
      'sbrkmuch` still passes) and prove the contention is gone: `bash checks/verify.sh kalloc` must pass, which means ' +
      '`python3 grade-lab-lock kalloctest` reports both `test1: OK` and `test2: OK`. Never modify the grader or the test ' +
      'programs.',
    stage: 'kalloc',
  })
}

export function bcacheTemplate(): TaskTemplate {
  return xv6Leaf({
    id: 'xv6-bcache-finegrained',
    appliesTo: 'Give the xv6 buffer cache fine-grained per-bucket locking instead of one global lock.',
    objective:
      'Rework kernel/bio.c so the buffer cache no longer serializes every lookup on a single `bcache` lock: hash blocks ' +
      'into buckets with a lock per bucket, keep the eviction path safe (a buffer is never handed out twice, and eviction ' +
      'must not race a concurrent lookup or release), and preserve the existing bread/bwrite/brelse/bpin/bunpin contract. ' +
      'Prove it: `bash checks/verify.sh bcache` must pass, which means `python3 grade-lab-lock bcachetest` reports both ' +
      '`test0: OK` and `test1: OK`. Never modify the grader or the test programs.',
    stage: 'bcache',
  })
}

export function regressionTemplate(): TaskTemplate {
  return xv6Leaf({
    id: 'xv6-full-regression',
    appliesTo: 'Prove the optimized xv6 still passes the full usertests suite and the complete grade.',
    objective:
      'After the allocator and buffer-cache locks are reworked, run the full acceptance: `bash checks/verify.sh ' +
      'regression` (`usertests` must pass) and then `bash checks/verify.sh all`. The lab is complete only when the full ' +
      'grade prints `Score: 70/70`, which also requires `time.txt` at the repository root to contain a single positive ' +
      'integer. If a stage regresses, report it to the parent instead of editing the protected grader or test programs.',
    stage: 'regression',
  })
}

/** One distractor in the `web` catalog, carrying the marker string the live assertions forbid in any request. */
export function unrelatedXv6Template(index: number): TaskTemplate {
  return xv6Leaf({
    id: `unrelated-${index}`,
    appliesTo: 'UNRELATED_DOMAIN_MARKER: paint a marketing webpage.',
    objective: 'UNRELATED_DOMAIN_MARKER: paint a marketing webpage with a hero section and a call to action.',
    stage: 'kalloc',
    catalogPath: ['web'],
  })
}

/** The coordinating template: one owned responsibility whose recipe composes the three stages in dependency order. */
export function lockLabTemplate(refs: {
  kalloc: TaskTemplateRef
  bcache: TaskTemplateRef
  regression: TaskTemplateRef
}): TaskTemplate {
  return {
    id: 'xv6-lock-lab-optimization',
    version: 1,
    catalogPath: [...XV6_CATALOG],
    appliesTo: [
      'Own the xv6 locks lab optimization and independently verify the allocator, buffer cache and regression.',
    ],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective:
        "Own the xv6 locks lab: eliminate the kernel's lock contention so `python3 grade-lab-lock` prints `Score: " +
        "70/70`, including the `time.txt` point. Begin by expanding this contract's own recipe: call task_decompose " +
        "with this template's exact templateRef at the top level and no reason or children, so the runtime admits the " +
        'allocator, buffer-cache and regression children with the regression gated behind both fixes. Then coordinate ' +
        'them to completion and hand this task in; do not bind this template to yourself again as a child.',
      acceptanceCriteria: xv6Criteria('modules'),
      requiredCapabilities: ['coordinate-tasks'],
      constraints: [
        ...XV6_CONSTRAINTS,
        "Expand this template's recipe with a top-level `templateRef` (omit `reason` and `children`); do not pass the " +
          'recipe as a child of yourself, which would only create another copy of this coordinating contract.',
      ],
    },
    decomposition: {
      reason:
        'The allocator and the buffer cache are independent lock-contention fixes with separately checkable verdicts, ' +
        'and the full regression is only meaningful once both are in.',
      children: [
        { templateRef: refs.kalloc },
        { templateRef: refs.bcache },
        { templateRef: refs.regression, dependsOn: [0, 1] },
      ],
    },
  }
}

/** The narrow runtime surface {@link registerXv6Library} needs. */
export interface Xv6TemplateRegistry {
  registerTaskTemplate(template: TaskTemplate): Promise<TaskTemplateRef>
  findTaskTemplates(
    query?: string,
  ): Promise<readonly { readonly templateRef: TaskTemplateRef; readonly template: TaskTemplate }[]>
}

/** Register the standard library: four `kernel` templates plus the `web` distractors. */
export async function registerXv6Library(
  runtime: Xv6TemplateRegistry,
  options: { distractors?: number } = {},
): Promise<void> {
  await runtime.registerTaskTemplate(kallocTemplate())
  await runtime.registerTaskTemplate(bcacheTemplate())
  await runtime.registerTaskTemplate(regressionTemplate())
  for (let index = 0; index < (options.distractors ?? 0); index += 1) {
    await runtime.registerTaskTemplate(unrelatedXv6Template(index))
  }
  const current = await runtime.findTaskTemplates()
  const ref = (id: string): TaskTemplateRef => {
    const match = current.find(item => item.templateRef.id === id)
    if (match === undefined) throw new Error(`the library holds no ${id} template`)
    return match.templateRef
  }
  await runtime.registerTaskTemplate(
    lockLabTemplate({
      kalloc: ref('xv6-kalloc-percpu'),
      bcache: ref('xv6-bcache-finegrained'),
      regression: ref('xv6-full-regression'),
    }),
  )
}

/* --- the repair world (round 7) ------------------------------------------ */

/**
 * The reference tree the round-7 repair experiment seeds from: its
 * `kernel/kalloc.c` and `kernel/bio.c` are the per-CPU allocator and bucketed
 * buffer cache the lab is graded on. Override with `XV6_REFERENCE`.
 */
export const XV6_REFERENCE = process.env.XV6_REFERENCE ?? '/home/roxy/code/testbeds/xv6-lock-reference'

/** The marker the fix leaf writes once the reference implementation is confirmed in place. */
export const XV6_FIX_MARKER = 'out/locks-fix.applied'

/** The completion artifact the regression (honest) leaf writes only once that marker exists. */
export const XV6_COMPLETE_MARKER = 'out/locks-complete.json'

/** The grade's time.txt, written by the regression (honest) leaf on its presence path. */
export const XV6_TIME_FILE = 'time.txt'

/** The coordinating template whose serial recipe is the round-7 defect. */
export const XV6_LAB_ID = 'xv6-lock-lab-optimization'

/** The fix leaf: confirm the pre-seeded reference locks and write {@link XV6_FIX_MARKER}. */
export const XV6_FIX_LEAF_ID = 'xv6-lock-fix-applied'

/** The regression leaf: the honest completion check that refuses to fabricate the marker. */
export const XV6_COMPLETION_LEAF_ID = 'xv6-lock-completion-regression'

/** The objective prefix the coordinator's spawn name exposes to a script. */
export const XV6_LAB_OBJECTIVE_PREFIX = 'Own the xv6 locks lab optimization'

/** The objective prefix the fix leaf's spawn name exposes to a script. */
export const XV6_FIX_OBJECTIVE_PREFIX = 'Confirm the xv6 locks reference fix'

/**
 * The objective prefix the regression leaf's spawn name exposes to a script.
 * The runtime truncates a spawn name to the first 40 characters of a worker's
 * objective, so every prefix a script matches on must stay under that bound.
 */
export const XV6_COMPLETION_OBJECTIVE_PREFIX = 'Prove the xv6 locks lab is complete'

/** The fix leaf's criterion id. */
export const XV6_FIX_CRITERION_ID = 'locks-fix-result'

/** The regression (honest) leaf's criterion id. */
export const XV6_COMPLETION_CRITERION_ID = 'locks-completion-result'

/** The coordinating template's criterion id. */
export const XV6_LAB_CRITERION_ID = 'locks-lab-result'

/** Whether the reference tree the round-7 fixtures seed from is present on this machine. */
export function xv6ReferencePresent(reference: string = XV6_REFERENCE): boolean {
  return existsSync(join(reference, 'kernel', 'kalloc.c')) && existsSync(join(reference, 'kernel', 'bio.c'))
}

/**
 * Seed one checkout with the reference lock implementation: copy the pre-fixed
 * `kernel/kalloc.c` and `kernel/bio.c` from {@link XV6_REFERENCE} and remove any
 * `time.txt` the reference carries, so the completion stage has to write its own.
 */
export function seedReferenceLockFix(checkout: string): void {
  if (!xv6ReferencePresent()) {
    throw new Error(
      `xv6 locks reference tree not found: ${XV6_REFERENCE}/kernel/{kalloc.c,bio.c} is missing. The round-7 repair ` +
        'experiment seeds its snapshot from the reference fix; set XV6_REFERENCE to another copy.',
    )
  }
  for (const file of ['kalloc.c', 'bio.c']) {
    copyFileSync(join(XV6_REFERENCE, 'kernel', file), join(checkout, 'kernel', file))
  }
  rmSync(join(checkout, XV6_TIME_FILE), { force: true })
}

/**
 * Reset the round-7 leftovers a previous run could have left in one checkout:
 * the fix marker, the completion artifact, `time.txt` and the whole `out/` tree.
 * The experiment freezes its input snapshot before any side runs, so a stale
 * marker from an earlier replay would let the regression leaf pass on the
 * defective recipe and mask the defect.
 */
export function resetLockLab(checkout: string): void {
  for (const path of [XV6_FIX_MARKER, XV6_COMPLETE_MARKER, XV6_TIME_FILE]) {
    rmSync(join(checkout, path), { force: true })
  }
  rmSync(join(checkout, 'out'), { recursive: true, force: true })
}

/** One criterion over the shared protected inputs, judged by the lab's own grader wrapper. */
function xv6RepairCriterion(criterionId: string, description: string, command: string): CriterionSpec {
  return { criterionId, description, command, verifierRef: 'command', protectedInputs: [...XV6_PROTECTED_INPUTS] }
}

const XV6_REPAIR_CONSTRAINTS = [
  ...XV6_CONSTRAINTS,
  'The fix and the completion check are two stages of one run: never write another stage\'s artifact, and never re-run a ' +
    "stage that already failed. A stage that finds its input missing reports the gap instead of fabricating it.",
]

/**
 * The fix leaf: the snapshot already carries the reference implementation, so
 * this leaf's job is to confirm it and leave {@link XV6_FIX_MARKER} behind, then
 * let the independent checker grade both module stages
 * (`bash checks/verify.sh modules`).
 */
export function lockFixTemplate(): TaskTemplate {
  return {
    id: XV6_FIX_LEAF_ID,
    version: 1,
    catalogPath: [...XV6_CATALOG],
    appliesTo: ['Confirm the pre-seeded per-CPU allocator and bucketed buffer cache and mark the fix applied.'],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective:
        `${XV6_FIX_OBJECTIVE_PREFIX}: the checkout already carries the reference per-CPU allocator (kernel/kalloc.c gives ` +
        'every CPU its own free list and lock, stealing from another CPU when empty) and the reference buffer cache ' +
        '(kernel/bio.c hashes blocks into buckets with a lock per bucket). Confirm both files are present and unmodified, ' +
        `write the fix marker ${XV6_FIX_MARKER}, and prove the modules still pass: \`bash checks/verify.sh modules\` must ` +
        'report `kalloctest test1/test2: OK` and `bcachetest test0/test1: OK`. Do not touch the protected grader, the ' +
        'Makefile or the test programs.',
      acceptanceCriteria: [
        xv6RepairCriterion(
          XV6_FIX_CRITERION_ID,
          `the fix marker exists and both module stages of the xv6 checker pass`,
          `bash -c 'test -f ${XV6_FIX_MARKER} && bash checks/verify.sh modules'`,
        ),
      ],
      requiredCapabilities: ['local-files'],
      constraints: XV6_REPAIR_CONSTRAINTS,
    },
  }
}

/**
 * The regression leaf. Its contract is *honest* when `honestLeaf` is set: the
 * freshness check comes FIRST and the gap path is one submission, so a replayed
 * worker whose upstream fix stage never wrote {@link XV6_FIX_MARKER} reports the
 * missing artifact instead of fabricating the completion files.
 *
 * `gapEvidence` (off by default, so the shared phase-0 shape is unchanged) makes
 * the criterion NAME the artifact that is missing instead of testing silently:
 * the live spec reads the failed criterion's log to prove which input the gap
 * leaf lacked.
 */
export function completionTemplate(options: { honestLeaf?: boolean; gapEvidence?: boolean } = {}): TaskTemplate {
  const criterionCommand =
    options.gapEvidence === true
      ? `bash -c 'for f in ${XV6_FIX_MARKER} ${XV6_COMPLETE_MARKER} ${XV6_TIME_FILE}; do ` +
        `test -f "$f" || { echo "missing $f" >&2; exit 1; }; done'`
      : `bash -c 'test -f ${XV6_FIX_MARKER} && test -f ${XV6_COMPLETE_MARKER} && test -f ${XV6_TIME_FILE}'`
  const honest =
    options.honestLeaf === true
      ? `FIRST, before anything else, check that this run's fix stage is in place: run \`test -f ${XV6_FIX_MARKER}\`. If ` +
        `${XV6_FIX_MARKER} is missing, the fix stage of THIS run has not produced it: do NOT explore the repository, read ` +
        'other tasks or sessions, poll, wait, retry, substitute or fabricate anything, and do NOT write ' +
        `${XV6_TIME_FILE} or ${XV6_COMPLETE_MARKER} — immediately call task_submit_result with a one-line gap report naming ` +
        `${XV6_FIX_MARKER}. The criterion will fail it, and that is the intended honest outcome. Only when ` +
        `${XV6_FIX_MARKER} exists: `
      : ''
  return {
    id: XV6_COMPLETION_LEAF_ID,
    version: 1,
    catalogPath: [...XV6_CATALOG],
    appliesTo: ['Prove the optimized lab is complete: the fix is applied and the full grade passes.'],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective:
        `${XV6_COMPLETION_OBJECTIVE_PREFIX}: ` +
        honest +
        `write ${XV6_TIME_FILE} at the repository root containing a single positive integer (the hours spent on the lab) and ` +
        `write ${XV6_COMPLETE_MARKER} recording that the completion stage ran; then hand this task in. ` +
        '`bash checks/verify.sh all` must ultimately print `Score: 70/70`.',
      acceptanceCriteria: [
        xv6RepairCriterion(
          XV6_COMPLETION_CRITERION_ID,
          `the fix marker, the completion artifact and time.txt all exist`,
          criterionCommand,
        ),
      ],
      requiredCapabilities: ['local-files'],
      constraints: XV6_REPAIR_CONSTRAINTS,
    },
  }
}

/** The two leaf references the round-7 coordinator recipe composes. */
export interface Xv6RepairRefs {
  /** The fix leaf ({@link lockFixTemplate}), which writes {@link XV6_FIX_MARKER}. */
  readonly fix: TaskTemplateRef
  /** The regression leaf ({@link completionTemplate}), which requires the marker. */
  readonly regression: TaskTemplateRef
}

/** The shared coordinator contract: how to expand the recipe, and what a failed child means. */
function xv6LabContract(): TaskTemplate['contract'] {
  return {
    objective:
      `${XV6_LAB_OBJECTIVE_PREFIX}: own the xv6 locks lab and drive its fix and completion stages to ` +
      "`Score: 70/70`. Begin by expanding this contract's own recipe: call task_decompose with this template's exact " +
      'templateRef at the top level and no reason or children, so the runtime admits the recipe children with its ' +
      'dependency edges. Then coordinate them to completion and hand this task in; do not bind this template to yourself ' +
      'again as a child. A child that fails ends this task: do NOT author a stage artifact yourself (never write ' +
      `${XV6_FIX_MARKER}, ${XV6_COMPLETE_MARKER} or ${XV6_TIME_FILE}), do NOT admit another batch, and do NOT re-dispatch a ` +
      'failed child — submit this task with a gap report naming the failed child so the defect stays visible for its owner.',
    acceptanceCriteria: [
      xv6RepairCriterion(
        XV6_LAB_CRITERION_ID,
        `the completion artifact exists and the full xv6 grade is 70/70`,
        `bash -c 'test -f ${XV6_COMPLETE_MARKER} && bash checks/verify.sh all'`,
      ),
    ],
    requiredCapabilities: ['coordinate-tasks'],
    constraints: [
      ...XV6_REPAIR_CONSTRAINTS,
      "Expand this template's recipe with a top-level `templateRef` (omit `reason` and `children`); do not pass the recipe " +
        'as a child of yourself, which would only create another copy of this coordinating contract.',
      'The recipe order is not the dependency order: the completion child is only meaningful once the fix child has ' +
        'produced its marker, so the recipe must carry that edge before a run is dispatched.',
    ],
  }
}

/**
 * The defective coordinator v1: the recipe lists the regression (completion)
 * child at index 0 and the fix child at index 1 with NO `dependsOn`. The batch
 * driver starts one independent child per round in array order
 * (`task-runtime/src/orchestration/child.ts:553-569`), so the completion leaf
 * runs before the fix leaf has written {@link XV6_FIX_MARKER} — the "forgotten
 * edge" defect. The criteria are identical to {@link repairedLockLabTemplate}.
 */
export function defectiveLockLabTemplate(refs: Xv6RepairRefs): TaskTemplate {
  return {
    id: XV6_LAB_ID,
    version: 1,
    catalogPath: [...XV6_CATALOG],
    appliesTo: ['Own the xv6 locks lab optimization and its fix/completion recipe.'],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: xv6LabContract(),
    decomposition: {
      reason:
        'The fix and the completion check are one run: the completion check is only meaningful once this run\u2019s fix ' +
        'stage has produced its marker.',
      children: [{ templateRef: refs.regression }, { templateRef: refs.fix }],
    },
  }
}

/**
 * The repaired coordinator v2, the minimal shape this experiment asserts: the
 * children keep the v1 order `[regression, fix]` and the regression child gains
 * exactly one `dependsOn: [1]` edge, so it starts only after the fix child has
 * verified. Everything else (criteria, objective, constraints) is byte-identical
 * to {@link defectiveLockLabTemplate}, so `evolution_prepare` never takes the
 * criterion-repair branch.
 */
export function repairedLockLabTemplate(refs: Xv6RepairRefs): TaskTemplate {
  return {
    id: XV6_LAB_ID,
    version: 2,
    catalogPath: [...XV6_CATALOG],
    appliesTo: ['Own the xv6 locks lab optimization and its fix/completion recipe.'],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: xv6LabContract(),
    decomposition: {
      reason:
        'The fix and the completion check are one run: the completion check is only meaningful once this run\u2019s fix ' +
        'stage has produced its marker.',
      children: [{ templateRef: refs.regression, dependsOn: [1] }, { templateRef: refs.fix }],
    },
  }
}

/** The references a round-7 registration returns: the defective v1 plus the two leaves it composes. */
export interface Xv6RepairLibrary extends Xv6RepairRefs {
  /** The defective coordinating v1 template. */
  readonly lab: TaskTemplateRef
}

/**
 * Register the round-7 repair library: the fix and honest-regression leaves
 * (plus `web` distractors) and the defective coordinating v1 that binds them in
 * the wrong order with no edge.
 *
 * `gapEvidence` is forwarded to {@link completionTemplate}; it is off by default,
 * so the phase-0 world is exactly what it was.
 */
export async function registerXv6RepairLibrary(
  runtime: Xv6TemplateRegistry,
  options: { distractors?: number; gapEvidence?: boolean } = {},
): Promise<Xv6RepairLibrary> {
  await runtime.registerTaskTemplate(lockFixTemplate())
  await runtime.registerTaskTemplate(completionTemplate({ honestLeaf: true, ...(options.gapEvidence === true ? { gapEvidence: true } : {}) }))
  for (let index = 0; index < (options.distractors ?? 0); index += 1) {
    await runtime.registerTaskTemplate(unrelatedXv6Template(index))
  }
  const current = await runtime.findTaskTemplates()
  const ref = (id: string): TaskTemplateRef => {
    const match = current.find(item => item.templateRef.id === id)
    if (match === undefined) throw new Error(`the library holds no ${id} template`)
    return match.templateRef
  }
  const refs: Xv6RepairRefs = { fix: ref(XV6_FIX_LEAF_ID), regression: ref(XV6_COMPLETION_LEAF_ID) }
  const lab = await runtime.registerTaskTemplate(defectiveLockLabTemplate(refs))
  return { ...refs, lab }
}
