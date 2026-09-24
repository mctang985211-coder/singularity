#!/usr/bin/env python3
"""Reviewer scratch tool: build mutant copies of the frozen criteria module + spec.

Never writes to `driver/`, `fixtures/` or the historical evidence tree. Each
mutant is a full copy of `driver/s3-criteria.ts` (and, where useful, the spec)
with exactly one named rule neutralised; the replacements are asserted to apply
once, and a unified diff of every mutant is written to `results/mutations.diff`.
"""

import difflib
import pathlib
import shutil
import sys

ROOT = pathlib.Path('/home/ROXY/code/bb_work/r1-supplemental-2026-09-24')
DRIVER = ROOT / 'driver'
SCRATCH = ROOT / 'evidence/review/scratch'
MUTANTS = SCRATCH / 'mutants'
RESULTS = SCRATCH / 'results'

MUTATIONS = {
    'no-s1': [
        ("if (confirmed.get(freeze.condition) !== true) {",
         "if (false) { // MUTANT no-s1: the S1 rejection is removed"),
    ],
    'no-s1-s2': [
        ("if (confirmed.get(freeze.condition) !== true) {",
         "if (false) { // MUTANT no-s1-s2: the S1 rejection is removed"),
        ("if (adj.goalDependsOnUnknowns === true) {",
         "if (false) { // MUTANT no-s1-s2: the S2 rejection is removed"),
    ],
    'no-m1-mismatch': [
        ("if (resultText !== answer) {",
         "if (false) { // MUTANT no-m1-mismatch: a tool result that differs from the desk answer is accepted"),
        ("if (delivered.text !== answer) {",
         "if (false) { // MUTANT no-m1-mismatch: a delivered text that differs from the desk answer is accepted"),
    ],
    'retained-as-unknown': [
        (": S3_CONDITION_IDS.filter(id => adj.conditions?.[id]?.label === 'unknown')",
         ": S3_CONDITION_IDS.filter(id => { const label = adj.conditions?.[id]?.label; return label === 'unknown' || label === 'retained-unknown' }) // MUTANT retained-as-unknown"),
    ],
    'citations-never-resolve': [
        ("    if (citation.kind === 'user-answer') {",
         "    if (citation !== undefined) return { resolved: false, deliveredAnswer: false, detail: 'MUTANT citations-never-resolve' }\n    if (citation.kind === 'user-answer') {"),
    ],
    'no-s2': [
        ("if (adj.goalDependsOnUnknowns === true) {",
         "if (false) { // MUTANT no-s2: the S2 rejection is removed"),
    ],
    'vague-original-confirms': [
        ("      const vague = originalRequest.length > 0 && citation.quote.length > 0 && originalRequest.includes(citation.quote)",
         "      const vague = false // MUTANT vague-original-confirms: the original request is allowed to confirm"),
        ("      return { resolved: found && !vague, deliveredAnswer: false, detail }",
         "      return { resolved: found && !vague, deliveredAnswer: true, detail } // MUTANT vague-original-confirms: a user message counts as a delivered answer"),
    ],
}


def build(name: str, replacements: list[tuple[str, str]]) -> list[str]:
    target = MUTANTS / name
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    module_text = (DRIVER / 's3-criteria.ts').read_text()
    spec_text = (DRIVER / 's3-criteria.spec.ts').read_text()
    spec_text = spec_text.replace(
        "const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'",
        f"const WORKDIR = '{SCRATCH}'",
        1,
    )
    for old, new in replacements:
        count = module_text.count(old)
        if count != 1:
            sys.exit(f'{name}: anchor appears {count} times, not once: {old!r}')
        module_text = module_text.replace(old, new, 1)
    (target / 's3-criteria.ts').write_text(module_text)
    (target / 's3-criteria.spec.ts').write_text(spec_text)
    original = (DRIVER / 's3-criteria.ts').read_text().splitlines(keepends=True)
    return list(difflib.unified_diff(original, module_text.splitlines(keepends=True),
                                     fromfile='driver/s3-criteria.ts', tofile=f'mutants/{name}/s3-criteria.ts'))


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (SCRATCH / 'evidence/adjudication').mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'evidence/adjudication/original-s3.json',
                 SCRATCH / 'evidence/adjudication/original-s3.json')
    diff = []
    for name, replacements in MUTATIONS.items():
        diff.extend(build(name, replacements))
    (RESULTS / 'mutations.diff').write_text(''.join(diff))
    print(f'built {len(MUTATIONS)} mutants under {MUTANTS}')
    print(f'diff written to {RESULTS / "mutations.diff"} ({len(diff)} lines)')


if __name__ == '__main__':
    main()
