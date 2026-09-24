#!/usr/bin/env python3
"""Reviewer scratch tool: a copy of the R1 stack with an injected recording failure.

Copies the four stack modules into `scratch/v1-copy/` (never touching `driver/`),
rewrites their repository-relative imports for the copy's depth, and injects one
throw as the first statement of `answerHuman`'s recording block — the failure the
V1 fix is supposed to keep out of the product path. The diff is printed.
"""

import difflib
import pathlib
import sys

ROOT = pathlib.Path('/home/ROXY/code/bb_work/r1-supplemental-2026-09-24')
DRIVER = ROOT / 'driver'
COPY = ROOT / 'evidence/review/scratch/v1-copy'
MODULES = ['r1-stack.ts', 'r1-env.ts', 'r1-record.ts', 'r1-scripted-model.ts']

INJECTION_OLD = """    try {
      humanQuestions.push({"""
INJECTION_NEW = """    try {
      throw new Error('injected recording failure (reviewer probe)')
      humanQuestions.push({"""


def main() -> None:
    COPY.mkdir(parents=True, exist_ok=True)
    diffs: list[str] = []
    for name in MODULES:
        original = (DRIVER / name).read_text()
        text = original.replace("'../../harness/", "'../../../../../harness/")
        if name == 'r1-stack.ts':
            if text.count(INJECTION_OLD) != 1:
                sys.exit('anchor not found exactly once in r1-stack.ts')
            text = text.replace(INJECTION_OLD, INJECTION_NEW, 1)
        (COPY / name).write_text(text)
        diffs.extend(difflib.unified_diff(original.splitlines(keepends=True),
                                          text.splitlines(keepends=True),
                                          fromfile=f'driver/{name}', tofile=f'scratch/v1-copy/{name}'))
    results = ROOT / 'evidence/review/scratch/results'
    results.mkdir(parents=True, exist_ok=True)
    (results / 'v1-copy.diff').write_text(''.join(diffs))
    print(f'copied {len(MODULES)} modules to {COPY}')
    print(f'diff written to {results / "v1-copy.diff"}')


if __name__ == '__main__':
    main()
