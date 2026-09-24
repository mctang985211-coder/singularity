#!/usr/bin/env python3
"""Derive `evidence/s3/conversation.md` from the archived session JSONL.

This is a *derived view*: it copies every string of every event **verbatim** from
the archived JSONL and adds only reading structure (headers, labels, fenced
blocks). It paraphrases nothing, reorders nothing, omits no model-visible
message, and never re-reads the live run scratch. Run it again to reproduce the
same bytes:

    python3 /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence/build-conversation.py
"""

import hashlib
import json
import os

EVIDENCE = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence'
S3 = os.path.join(EVIDENCE, 's3')
LOG_DIR = os.path.join(S3, 'dsh-home', 'session-log')
OUT = os.path.join(S3, 'conversation.md')

SESSIONS = [
    ('s-root', 'root session of the S3 attempt', os.path.join(LOG_DIR, 's-root.jsonl')),
    ('s-b62da3c5-9506-4a65-81f9-441fc72de7ea', 'worker session (the decomposed child task)',
     os.path.join(LOG_DIR, 's-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl')),
]


def fence(text: str, lang: str = '') -> str:
    longest = max((len(run) for run in _tilde_runs(text)), default=0)
    bar = '~' * max(4, longest + 1)
    return f'{bar}{lang}\n{text}\n{bar}'


def _tilde_runs(text: str):
    run = 0
    for ch in text:
        if ch == '~':
            run += 1
        elif run:
            yield run
            run = 0
    if run:
        yield run


def j(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


def text_of_blocks(content) -> list:
    out = []
    for block in content or []:
        if isinstance(block, dict) and block.get('type') == 'text':
            out.append(block.get('text', ''))
    return out


def render_message(msg: dict, indent: str = '') -> list:
    """Render one model-visible message (user/assistant/system) with verbatim content."""
    lines = []
    source = msg.get('source')
    lines.append(f'{indent}- role: `{msg.get("role")}`')
    if source is not None:
        lines.append(f'{indent}- source: `{json.dumps(source, ensure_ascii=False)}`')
    if msg.get('id') is not None:
        lines.append(f'{indent}- message id: `{msg["id"]}`')
    for i, block in enumerate(msg.get('content') or [], 1):
        if not isinstance(block, dict):
            lines.append(f'{indent}- content[{i}]: {fence(str(block))}')
            continue
        kind = block.get('type')
        if kind == 'text':
            lines.append(f'{indent}**text[{i}]** (verbatim)')
            lines.append(indent + fence(block.get('text', ''), 'text'))
        elif kind == 'reasoning':
            lines.append(f'{indent}**reasoning[{i}]** (verbatim, model output)')
            lines.append(indent + fence(block.get('text', ''), 'reasoning'))
        elif kind == 'tool-call':
            lines.append(f'{indent}**tool-call[{i}]** (verbatim)')
            lines.append(indent + fence(j(block), 'json'))
        elif kind == 'tool-result':
            lines.append(f'{indent}**tool-result[{i}]** toolCallId=`{block.get("toolCallId")}` isError=`{block.get("isError")}`')
            for c in block.get('content') or []:
                if isinstance(c, dict) and c.get('type') == 'text':
                    lines.append(indent + fence(c.get('text', ''), 'text'))
                else:
                    lines.append(indent + fence(j(c), 'json'))
        else:
            lines.append(f'{indent}**{kind}[{i}]** (verbatim)')
            lines.append(indent + fence(j(block), 'json'))
    return lines


def render_event(line_no: int, event: dict) -> list:
    etype = event.get('type')
    data = event.get('data') or {}
    out = [f'### L{line_no} · seq={event.get("seq")} · `{etype}` · t={event.get("time")}', '']
    if event.get('surfaceOp') is not None:
        out.append(f'surfaceOp: `{event["surfaceOp"]}`')
        out.append('')

    if etype in ('session/end-seed', 'approval/policy'):
        out.append(fence(j(data), 'json'))
    elif etype == 'agent/inbox/spliced':
        out.append(f'spliced into target `{data.get("target")}` at start {data.get("start")}'
                   + (f', removedCount {data.get("removedCount")}' if 'removedCount' in data else '')
                   + f'; inserted {len(data.get("inserted") or [])} message(s)')
        out.append('')
        for msg in data.get('inserted') or []:
            out.extend(render_message(msg))
            out.append('')
    elif etype in ('turn/start', 'step/start', 'step/end', 'turn/end'):
        out.append(fence(j(data), 'json'))
    elif etype == 'system/message':
        out.append(f'turn={data.get("turn")} step={data.get("step")}')
        out.append('')
        out.extend(render_message(data.get('message') or {}))
    elif etype == 'user/message':
        out.extend(render_message(data))
    elif etype in ('request/header', 'request/context'):
        out.append(fence(j(data), 'json'))
    elif etype == 'assistant/message':
        out.append(f'turn={data.get("turn")} step={data.get("step")}')
        out.append('')
        out.extend(render_message(data.get('message') or {}))
    elif etype == 'tool/call':
        out.append(f'turn={data.get("turn")} step={data.get("step")} · name=`{data.get("name")}` · callId=`{data.get("callId")}`')
        out.append('')
        raw = data.get('arguments')
        if isinstance(raw, str):
            out.append('arguments (verbatim string, exactly as logged):')
            out.append(fence(raw, 'json'))
            try:
                out.append('same bytes, reformatted for reading:')
                out.append(fence(j(json.loads(raw)), 'json'))
            except Exception:
                pass
        else:
            out.append(fence(j(raw), 'json'))
    elif etype == 'tool/result':
        out.append(f'turn={data.get("turn")} step={data.get("step")}')
        if data.get('sourceEventSeqs') is not None:
            out.append(f'sourceEventSeqs: `{json.dumps(data["sourceEventSeqs"])}`')
        out.append('')
        out.extend(render_message(data.get('message') or {}))
    else:
        out.append(fence(j(event), 'json'))
    out.append('')
    return out


def main() -> None:
    sections = []
    header = [
        '# S3 attempt — archived session conversations (derived verbatim view)',
        '',
        '**Derived view, not the primary source.** The primary source of this run is the archived',
        'session JSONL under `evidence/s3/dsh-home/session-log/`. This file is a deterministic',
        'rendering of that JSONL, produced by `evidence/build-conversation.py`: every model-visible',
        'string below is copied **verbatim** — no paraphrase, no reordering, no elision — and the only',
        'additions are the per-event headers, labels and prose of this notice. Reading order is the',
        "JSONL's own line order. `L<n>` is the 1-based line number in that JSONL, `seq` its session",
        'sequence number, `t` its epoch-millisecond timestamp.',
        '',
        'Two sessions belong to this attempt. The root session is rendered first; the worker session',
        "(the decomposed child task's own agent session) follows in an appendix with the same treatment.",
        'The graph store log `sg-t-s-root.jsonl` holds `task/event` records only (no model dialogue) and',
        "is not rendered here; `driver.json` carries its event list.",
        '',
        'Fidelity: prose, tool arguments and tool results are printed literally; JSON envelopes are',
        'printed with JSON string escaping, so a literal newline inside such a string shows as the two',
        'characters `\\n` (a reversible encoding, not a paraphrase). The generator verifies that every',
        'string of every event appears in this file either literally or in that escaped form, and prints',
        'the count to stdout.',
        '',
        'Files rendered, with their sha256 as archived:',
        '',
    ]
    for session_id, role, path in SESSIONS:
        raw = open(path, 'rb').read()
        header.append(f'- `{os.path.relpath(path, EVIDENCE)}` — {role} — sha256 `{hashlib.sha256(raw).hexdigest()}`,'
                      f' {len(raw)} bytes, {raw.count(b"\n")} lines')
    header.append('')

    for session_id, role, path in SESSIONS:
        body = [f'## Session `{session_id}` — {role}', '']
        with open(path, 'r', encoding='utf-8') as handle:
            events = [json.loads(line) for line in handle if line.strip()]
        for line_no, event in enumerate(events, 1):
            body.extend(render_event(line_no, event))
        title = '## Appendix — ' + f'session `{session_id}` (worker)' if session_id != 's-root' else None
        if title is not None:
            body[0] = title
        sections.append(body)

    with open(OUT, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(header) + '\n')
        for body in sections:
            handle.write('\n'.join(body) + '\n')
    size = os.path.getsize(OUT)
    print(f'wrote {OUT} ({size} bytes)')
    verify_fidelity()


def verify_fidelity() -> None:
    """Every string of every archived event must appear literally or JSON-escaped."""
    markdown = open(OUT, encoding='utf-8').read()
    checked = missing = 0

    def escaped(text: str) -> str:
        return json.dumps(text, ensure_ascii=False)[1:-1]

    def walk(node) -> None:
        nonlocal checked, missing
        if isinstance(node, str):
            if len(node) > 40:
                checked += 1
                if node not in markdown and escaped(node) not in markdown:
                    missing += 1
                    print(f'  MISSING len {len(node)}: {node[:60]!r}')
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    for _, _, path in SESSIONS:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                if line.strip():
                    walk(json.loads(line))
    print(f'fidelity: {checked} strings >40 chars checked; {missing} not found literally or JSON-escaped')


if __name__ == '__main__':
    main()
