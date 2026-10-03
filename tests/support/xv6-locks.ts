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

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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

if [ "$stage" = modules ]; then
  { timeout 1500 python3 grade-lab-lock kalloctest; timeout 1500 python3 grade-lab-lock bcachetest; } > "$log" 2>&1
elif [ -n "$filter" ]; then
  timeout 1500 python3 grade-lab-lock "$filter" > "$log" 2>&1
else
  timeout 1500 python3 grade-lab-lock > "$log" 2>&1
fi
grade_status=$?
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
  "Grade with the lab's own grader: `python3 grade-lab-lock [filter]`. The script name is singular (grade-lab-lock). " +
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
