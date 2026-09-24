#!/usr/bin/env python3
"""Reviewer scratch: pin the two rules changed by the §5a amendment.

- mutants/pass2-no-f1 : the amended M3 content leg removed (module copy).
- mutants/pass2-no-hook : the recordingFault hook removed (stack + wiring spec copy).
"""
import difflib, pathlib, shutil, sys

ROOT = pathlib.Path('/home/ROXY/code/bb_work/r1-supplemental-2026-09-24')
DRIVER = ROOT / 'driver'
MUTANTS = ROOT / 'evidence/review/scratch/mutants'
RESULTS = ROOT / 'evidence/review/scratch/results'

F1_LINE = """    ...(deliveryClaimed && adj?.artifactMatchesGoal === false ? [`M3: the run claims delivery but the adjudication states the artifact does not match the adjudicated goal (${checks['M3.content']!.detail})`] : []),
"""
HOOK_LINE = """      if (options.recordingFault === true) throw new Error('cannot get property "toJSON" without inject')
"""

def build_module_mutant():
    target = MUTANTS / 'pass2-no-f1'
    if target.exists(): shutil.rmtree(target)
    target.mkdir(parents=True)
    text = (DRIVER / 's3-criteria.ts').read_text()
    if text.count(F1_LINE) != 1: sys.exit('F1 line not found once')
    text = text.replace(F1_LINE, "    // MUTANT pass2-no-f1: the explicit-content-mismatch rejection is removed\n", 1)
    (target / 's3-criteria.ts').write_text(text)
    spec = (DRIVER / 's3-criteria.spec.ts').read_text().replace(
        "const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'",
        "const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence/review/scratch'", 1)
    (target / 's3-criteria.spec.ts').write_text(spec)
    return difflib.unified_diff((DRIVER/'s3-criteria.ts').read_text().splitlines(keepends=True),
                                text.splitlines(keepends=True), 'driver/s3-criteria.ts', 'mutants/pass2-no-f1/s3-criteria.ts')

def build_hook_mutant():
    target = MUTANTS / 'pass2-no-hook'
    if target.exists(): shutil.rmtree(target)
    target.mkdir(parents=True)
    stack = (DRIVER / 'r1-stack.ts').read_text().replace("'../../harness/", "'../../../../../../harness/")
    if stack.count(HOOK_LINE) != 1: sys.exit('hook line not found once')
    stack = stack.replace(HOOK_LINE, "      // MUTANT pass2-no-hook: the recording-fault hook no longer fires\n", 1)
    (target / 'r1-stack.ts').write_text(stack)
    for name in ['r1-record.ts', 'r1-scripted-model.ts', 'r1-env.ts']:
        text = (DRIVER / name).read_text().replace("'../../harness/", "'../../../../../../harness/")
        (target / name).write_text(text)
    shutil.copy2(DRIVER / 's3-criteria.ts', target / 's3-criteria.ts')
    shutil.copy2(DRIVER / 'r1-wiring.spec.ts', target / 'r1-wiring.spec.ts')
    return difflib.unified_diff((DRIVER/'r1-stack.ts').read_text().splitlines(keepends=True),
                                stack.splitlines(keepends=True), 'driver/r1-stack.ts', 'mutants/pass2-no-hook/r1-stack.ts')

diff = list(build_module_mutant()) + list(build_hook_mutant())
(RESULTS / 'pass2-mutations.diff').write_text(''.join(diff))
print('built pass2-no-f1 and pass2-no-hook; diff lines:', len(diff))
