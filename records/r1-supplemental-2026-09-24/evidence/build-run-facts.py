#!/usr/bin/env python3
"""Derive `evidence/run-facts.json`: this round's raw facts, copied not summarised.

Every string below is read out of the archived evidence as-is (no paraphrase):
`evidence/s3/driver.json`, `evidence/s3/run-meta.json`, `evidence/smoke-1/result.json`
and the archived session JSONL. The file states no verdict — `driver/s3-criteria.ts`
decides afterwards against an independent adjudication.

    python3 /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence/build-run-facts.py
"""

import datetime
import hashlib
import json
import os

EVIDENCE = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence'
S3 = os.path.join(EVIDENCE, 's3')
OUT = os.path.join(EVIDENCE, 'run-facts.json')


def sha256(path: str) -> str:
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def load(path: str):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def main() -> None:
    record = load(os.path.join(S3, 'driver.json'))
    meta = load(os.path.join(S3, 'run-meta.json'))
    smoke = load(os.path.join(EVIDENCE, 'smoke-1', 'result.json'))

    log_path = os.path.join(S3, 'dsh-home', 'session-log', 's-root.jsonl')
    events = [json.loads(line) for line in open(log_path, encoding='utf-8') if line.strip()]

    clarification = record['clarifications'][0]
    call = next(item for item in record['toolCalls'] if item['name'] == 'hitl_ask')
    tool_call_event = next(e for e in events if e['type'] == 'tool/call' and e['data']['callId'] == call['callId'])
    tool_result_event = next(e for e in events if e['type'] == 'tool/result' and e['data']['message']['content'][0]['toolCallId'] == call['callId'])
    result_block = tool_result_event['data']['message']['content'][0]
    result_text_in_jsonl = ''.join(c['text'] for c in result_block['content'] if c['type'] == 'text')

    usage = record['usage']
    totals = {field: sum(item[field] for item in usage) for field in ('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens')}

    facts = {
        'schemaVersion': 'r1-run-facts/1',
        'round': 'r1-supplemental-2026-09-24',
        'scenario': 's3',
        'generatedAt': None,
        'provenance': {
            'generator': 'evidence/build-run-facts.py',
            'note': 'raw facts only, copied out of the archived evidence; no verdict is computed here',
            'verdictOwner': 'driver/s3-criteria.ts against an independent adjudication (not this file)',
        },
        'sources': {
            'evidence/s3/driver.json': sha256(os.path.join(S3, 'driver.json')),
            'evidence/s3/run-meta.json': sha256(os.path.join(S3, 'run-meta.json')),
            'evidence/smoke-1/result.json': sha256(os.path.join(EVIDENCE, 'smoke-1', 'result.json')),
            'evidence/s3/dsh-home/session-log/s-root.jsonl': sha256(log_path),
            'evidence/s3/repo/report.txt': sha256(os.path.join(S3, 'repo', 'report.txt')),
        },
        'input': record['input'],
        'model': meta['model'],
        'environment': {
            'runScratch': '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/run/s3',
            'repo': 'fresh git init empty checkout (run/s3/repo/.git present in the archive)',
            'dshHome': 'isolated DSH_HOME/HOME (run/s3/dsh-home, archived)',
            'generatedTaskReview': 'off',
            'evolution': 'off (default)',
            'entry': {
                'event': 'user/message',
                'jsonlLine': 8,
                'seq': events[7]['seq'],
                'source': events[7]['data']['source'],
                'text': events[7]['data']['content'][0]['text'],
            },
        },
        'ids': record['ids'],
        'rootContract': record['rootContract'],
        'clarificationChain': {
            'count': len(record['clarifications']),
            'toolCall': {
                'name': call['name'],
                'callId': call['callId'],
                'sessionId': call['sessionId'],
                'at': call['at'],
                'isError': call['isError'],
                'prompt_verbatim': json.loads(call['args'])['prompt'],
                'resultText_verbatim': call['resultText'],
            },
            'desk': clarification['desk'],
            'delivered': clarification['delivered'],
            'jsonlToolResult': {
                'file': 'evidence/s3/dsh-home/session-log/s-root.jsonl',
                'toolCallLine': events.index(tool_call_event) + 1,
                'toolCallSeq': tool_call_event['seq'],
                'toolCallArguments_verbatim': tool_call_event['data']['arguments'],
                'toolResultLine': events.index(tool_result_event) + 1,
                'toolResultSeq': tool_result_event['seq'],
                'source': tool_result_event['data']['message']['source'],
                'isError': result_block['isError'],
                'text_verbatim': result_text_in_jsonl,
                'equalsFixedAnswer': result_text_in_jsonl == record['input']['fixedAnswer'],
                'equalsToolResultText': result_text_in_jsonl == call['resultText'],
                'surfaceOp': tool_result_event.get('surfaceOp'),
            },
            'recordErrors': record['recordErrors'],
            'humanQuestionsCount': len(record['humanQuestions']),
        },
        'rootTerminal': meta['stopReason'],
        'artifact': [
            {'path': item['path'], 'bytes': item['bytes'], 'sha256': hashlib.sha256(item['raw'].encode()).hexdigest(), 'raw_verbatim': item['raw']}
            for item in record['artifacts']
        ],
        'verifier': {
            'evidenceBundles': [
                {
                    'evidenceId': bundle['evidenceId'],
                    'taskRunId': bundle['taskRunId'],
                    'taskId': bundle['taskId'],
                    'generatedAt': bundle['generatedAt'],
                    'verifierResults': [
                        {k: r.get(k) for k in ('criterionId', 'verifierId', 'status', 'exitCode', 'command')}
                        for r in bundle['verifierResults']
                    ],
                }
                for bundle in record['evidence']
            ],
            'reviews': [{k: item.get(k) for k in ('taskId', 'runId', 'sessionId', 'outcome', 'anomalies', 'durationMs')} for item in record['reviews']],
        },
        'usage': {
            'records': usage,
            'totals': totals,
            'bySession': {
                session: {
                    'records': sum(1 for item in usage if item['sessionId'] == session),
                    **{field: sum(item[field] for item in usage if item['sessionId'] == session) for field in ('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens')},
                }
                for session in sorted({item['sessionId'] for item in usage})
            },
            'accountingRule': "r1-stack.ts records `chunk.usage.cacheReadTokens ?? 0` / `cacheWriteTokens ?? 0`: a field the gateway did not report is stored as 0, so a 0 here means 'reported as 0 or absent'",
        },
        'requests': {
            'rootSessionRequestCount_fromNotes': 10,
            'rootSessionUsageRecords': sum(1 for item in usage if item['sessionId'] == 's-root'),
            'workerSessionUsageRecords': sum(1 for item in usage if item['sessionId'] != 's-root'),
            'rootAssistantMessagesInJsonl': sum(1 for e in events if e['type'] == 'assistant/message'),
            'note': 'one root request (turn 3 step 1, the post-terminal "batch settled" turn) has no usage record: the log ends at step/start with no assistant response. Missing, not zero.',
        },
        'toolCalls': [
            {k: item.get(k) for k in ('seq', 'sessionId', 'callId', 'name', 'at', 'isError')} | {'args_verbatim': item.get('args'), 'resultText_verbatim': item.get('resultText')}
            for item in record['toolCalls']
        ],
        'toolCallTotals': {
            'count': len(record['toolCalls']),
            'errors': sum(1 for item in record['toolCalls'] if item['isError']),
            'namesInOrder': [item['name'] for item in record['toolCalls']],
        },
        'spawns': record['spawns'],
        'events': record['events'],
        'notes': record['notes'],
        'wallClockMs': meta['wallTimeMs'],
        'stopReason': meta['stopReason'],
        'softLimits': {'limits': meta['budget']['soft']['limits'], 'usage': meta['budget']['soft']['usage'], 'exceeded': meta['budget']['soft']['exceeded']},
        'smoke': smoke['smoke'] | {'archivedAt': smoke['at'], 'note': 'the smoke gate reports connectivity and its own usage; it carries no verdict about the S3 attempt'},
        'missingOrUnrecorded': [
            'the smoke records inputTokens and outputTokens only (driver/r1-smoke.ts reads those two fields): its cacheReadTokens/cacheWriteTokens are not recorded at all, not zero',
            'one root-session model request (turn 3 step 1) produced no usage record; the run was already terminal when its turn started',
            'cacheWrite is 0 for every recorded response, but the recorder maps an absent field to 0, so "reported 0" and "not reported" cannot be told apart here',
            'the snapshot holds review records and evidence bundles for both runs; no criterion failed, so no failure log exists',
        ],
    }
    facts['generatedAt'] = datetime.datetime.now().astimezone().isoformat()

    with open(OUT, 'w', encoding='utf-8') as handle:
        json.dump(facts, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    print(f'wrote {OUT} ({os.path.getsize(OUT)} bytes)')


if __name__ == '__main__':
    main()
