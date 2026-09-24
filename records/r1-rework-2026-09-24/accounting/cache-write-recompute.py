#!/usr/bin/env python3
"""Recompute the cache-write column of the r1-supplemental-2026-09-24 account from raw evidence.

Read-only, standard library only, no network. Run exactly:

    python3 /home/ROXY/code/bb_work/r1-rework-2026-09-24/accounting/cache-write-recompute.py

Prints the per-response table, the totals under both reporting conventions, the
missing usage record, the smoke's cache columns, the historical restatement, the
protocol structure of the cache-write field, and the sha256 provenance of every
file read. Exits 1 if any consistency check fails.
"""

import glob
import hashlib
import json
import os
import re
import sys

ARCHIVE = "/home/ROXY/code/bb_work/r1-supplemental-2026-09-24"
OLD_ROUND = "/home/ROXY/code/bb_work/r1-evidence-2026-09-23"
PROTOCOLS = (
    "/home/ROXY/code/bb_work/harness/thirdparty/deepseek-harness/"
    "packages/llm/llm-deepseek/src/protocols"
)

RULE = (
    "a figure the run never reported is recorded as 'not reported' (\u672a\u62a5\u544a), never as 0; "
    "a genuine reported 0 stays 0"
)

problems = []
provenance = []


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def read_text(path):
    provenance.append((path, sha256(path), os.path.getsize(path)))
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def read_json(path):
    return json.loads(read_text(path))


def check(ok, message):
    if not ok:
        problems.append(message)
    return ok


def manifest(root):
    rows = []
    for directory, _, names in os.walk(root):
        for name in names:
            full = os.path.join(directory, name)
            rows.append((os.path.relpath(full, root), sha256(full)))
    rows.sort(key=lambda row: os.fsencode("./" + row[0]))
    body = "".join("%s  ./%s\n" % (digest, name) for name, digest in rows)
    return hashlib.sha256(body.encode()).hexdigest(), len(rows)


def label(path):
    for root, prefix in ((ARCHIVE, ""), (OLD_ROUND, "")):
        if path.startswith(root + os.sep):
            return os.path.relpath(path, root)
    return path


def line_of(path, *needles):
    for number, text in enumerate(read_text(path).splitlines(), 1):
        if all(needle in text for needle in needles):
            return number
    return None


def head(title):
    print("")
    print("=" * 118)
    print(title)
    print("=" * 118)


def main():
    driver = read_json(os.path.join(ARCHIVE, "evidence", "s3", "driver.json"))
    records = driver["usage"]
    notes = driver.get("notes", [])

    log_paths = sorted(glob.glob(os.path.join(ARCHIVE, "evidence", "s3", "dsh-home", "session-log", "*.jsonl")))

    raw = {}
    per_log = []
    for path in log_paths:
        text = read_text(path)
        messages = 0
        responses = 0
        for number, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            event = json.loads(line)
            kind = event.get("type")
            data = event.get("data") or {}
            if kind == "turn/start":
                messages += 1
            if kind != "assistant/message":
                continue
            usage = data.get("usage")
            if usage is None:
                continue
            responses += 1
            key = (usage["inputTokens"], usage["outputTokens"], usage["cacheReadTokens"])
            raw[key] = {
                "file": os.path.relpath(path, ARCHIVE),
                "line": number,
                "logSeq": event.get("seq"),
                "time": event.get("time"),
                "turn": data.get("turn"),
                "step": data.get("step"),
                "usage": usage,
            }
        per_log.append({"file": os.path.relpath(path, ARCHIVE), "turns": messages, "responses": responses})

    check(
        len(raw) == len([row for row in records]),
        "the durable logs must hold exactly one usage object per normalised record",
    )

    head("V5 account correction \u2014 cache-write column recomputed from raw evidence")
    print("archive (read-only)  %s" % ARCHIVE)
    print("old round (read-only) %s" % OLD_ROUND)
    print("rule                 %s" % RULE)
    print("")
    print("The ledger's normalised column is written by driver/r1-stack.ts:")
    stack_line = line_of(os.path.join(ARCHIVE, "driver", "r1-stack.ts"), "cacheWriteTokens: chunk.usage.cacheWriteTokens")
    print("  driver/r1-stack.ts:%d  cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0" % stack_line)

    head("1. per-response table \u2014 normalised record vs the durable usage object")
    print(
        "%-4s %-42s %-9s %-22s %12s %12s %12s %12s  %s"
        % ("seq", "sessionId", "recorded", "raw", "cacheRead", "input", "output", "total", "rawSource")
    )
    print("-" * 118)
    rows = []
    for record in records:
        key = (record["inputTokens"], record["outputTokens"], record["cacheReadTokens"])
        source = raw.get(key)
        if not check(source is not None, "no durable usage object for record seq %s" % record["seq"]):
            continue
        usage = source["usage"]
        reported = usage["cacheWriteTokens"] if "cacheWriteTokens" in usage else False
        check(
            record.get("cacheWriteTokens") == 0,
            "record seq %s does not carry the normalised 0" % record["seq"],
        )
        check(
            (record["inputTokens"], record["outputTokens"], record["cacheReadTokens"]) == key,
            "record seq %s disagrees with its durable source" % record["seq"],
        )
        check(
            "totalTokens" not in record
            or record["totalTokens"] == record["inputTokens"] + record["outputTokens"] + record["cacheReadTokens"],
            "record seq %s: totalTokens is not input+output+cacheRead" % record["seq"],
        )
        source_text = "%s:%d (data.usage, log seq %s, turn %s step %s)" % (
            source["file"],
            source["line"],
            source["logSeq"],
            source["turn"],
            source["step"],
        )
        print(
            "%-4s %-42s %-9s %-22s %12d %12d %12d %12s  %s"
            % (
                record["seq"],
                record["sessionId"],
                record.get("cacheWriteTokens"),
                "false (key absent)" if reported is False else str(reported),
                record["cacheReadTokens"],
                record["inputTokens"],
                record["outputTokens"],
                record.get("totalTokens", "-"),
                source_text,
            )
        )
        rows.append((record, source, reported))
    print("-" * 118)
    absent = sum(1 for _, _, reported in rows if reported is False)
    print(
        "responses %d | normalised cacheWriteTokens = 0 on all %d | raw cacheWriteTokens key absent on %d | present on %d"
        % (len(rows), len(rows), absent, len(rows) - absent)
    )
    print(
        "genuine reported zeros that *are* visible in the raw objects (so absence would show as an absent key, not as 0):"
    )
    print(
        "  raw cacheReadTokens present on %d of %d, of which the value is 0 on %d"
        % (
            sum(1 for _, source, _ in rows if "cacheReadTokens" in source["usage"]),
            len(rows),
            sum(1 for _, source, _ in rows if source["usage"].get("cacheReadTokens") == 0),
        )
    )
    print(
        "  raw reasoningTokens present on %d of %d, of which the value is 0 on %d"
        % (
            sum(1 for _, source, _ in rows if "reasoningTokens" in source["usage"]),
            len(rows),
            sum(1 for _, source, _ in rows if source["usage"].get("reasoningTokens") == 0),
        )
    )
    for _, source, reported in rows:
        if reported is False and "cacheWriteTokens" in source["usage"]:
            check(False, "a durable object does report cacheWriteTokens")

    head("2. totals under the two conventions")
    fields = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")
    totals_a = {field: sum(record[field] for record in records) for field in fields}
    total_reported = sum(record["totalTokens"] for record in records if "totalTokens" in record)
    input_plus_output = totals_a["inputTokens"] + totals_a["outputTokens"]
    print("A. as computed with `?? 0` (what the ledger states):")
    print("     records            %d" % len(records))
    for field in fields:
        print("     %-18s %d" % (field, totals_a[field]))
    print("     %-18s %d" % ("input+output", input_plus_output))
    print("     %-18s %d" % ("sum totalTokens", total_reported))
    print("")
    print("B. not reported (`\u672a\u62a5\u544a`):")
    print("     records            %d" % len(records))
    print("     %-18s %d" % ("inputTokens", totals_a["inputTokens"]))
    print("     %-18s %d" % ("outputTokens", totals_a["outputTokens"]))
    print("     %-18s %d" % ("cacheReadTokens", totals_a["cacheReadTokens"]))
    print(
        "     %-18s %s"
        % (
            "cacheWriteTokens",
            "\u672a\u62a5\u544a (not reported) \u2014 not summable: no response of this run reported the field",
        )
    )
    print("     %-18s %d" % ("input+output", input_plus_output))
    print("     %-18s %d" % ("sum totalTokens", total_reported))
    print("")
    print(
        "column changed by this correction: cacheWriteTokens only (%d \u2192 \u672a\u62a5\u544a). "
        "inputTokens, outputTokens, cacheReadTokens and every totalTokens are untouched."
        % totals_a["cacheWriteTokens"]
    )
    print(
        "why nothing else can move: totalTokens == inputTokens + outputTokens + cacheReadTokens on %d of %d records, "
        "i.e. cache write is not an addend of any recorded total on this protocol."
        % (
            sum(
                1
                for record in records
                if record["totalTokens"] == record["inputTokens"] + record["outputTokens"] + record["cacheReadTokens"]
            ),
            len(records),
        )
    )
    print(
        "cache reads are kept in their own column and are not folded into inputTokens/outputTokens: "
        "input+output %d, cacheRead %d (separate)."
        % (input_plus_output, totals_a["cacheReadTokens"])
    )

    head("3. missing usage \u2014 the request that produced no record at all")
    root_log = os.path.join(ARCHIVE, "evidence", "s3", "dsh-home", "session-log", "s-root.jsonl")
    root_text = read_text(root_log).splitlines()
    last = len(root_text)
    starts = []
    step_starts = []
    for number, text in enumerate(root_text, 1):
        if '"turn/start"' in text or '"step/start"' in text:
            event = json.loads(text)
            if event["type"] == "turn/start":
                starts.append((event["data"]["turn"], number))
            else:
                step_starts.append((event["data"]["turn"], event["data"]["step"], number))
    turn_three = [(turn, number) for turn, number in starts if turn == 3]
    check(len(turn_three) == 1, "s-root.jsonl does not start exactly one turn 3")
    check(
        len([row for row in step_starts if row[0] == 3]) == 1 and step_starts[-1][0] == 3 and step_starts[-1][1] == 1,
        "the last step/start of s-root.jsonl is not turn 3 step 1",
    )
    step_start = step_starts[-1][2]
    responses_after = [
        number
        for number in range(step_start, last + 1)
        if '"type":"assistant/message"' in root_text[number - 1] or '"type":"step/end"' in root_text[number - 1]
    ]
    check(not responses_after, "turn 3 does contain a response or a step/end")
    root_records = [record for record in records if record["sessionId"] == "s-root"]
    boundary = None
    boundary_note = None
    for index, note in enumerate(notes):
        found = re.search(r"saw (\d+) model request", note)
        if found:
            boundary = int(found.group(1))
            boundary_note = index
    check(boundary is not None, "driver.json notes do not state the root-session request count")
    check(
        boundary == len(root_records) + 1,
        "the adapter-boundary request count does not exceed the record count by exactly one",
    )
    print("sessionId            s-root")
    print("request              turn 3 step 1 (the post-terminal 'batch settled' turn)")
    print("last durable line    s-root.jsonl:%d  %s" % (step_start, root_text[step_start - 1][:90]))
    print(
        "                     the log ends at line %d (the inbox splice); no step/end, no turn/end, no assistant/message follows"
        % last
    )
    print(
        "turns with a turn/start in s-root     %s"
        % ", ".join("%d (line %d)" % (turn, number) for turn, number in starts)
    )
    print(
        "turns with a model response in s-root %s"
        % sorted({row[1]["turn"] for row in rows if row[1]["file"].endswith("s-root.jsonl")})
    )
    print(
        "adapter boundary     %d model request(s) for s-root, %d usage record(s) \u2014 source: evidence/s3/driver.json notes[%d]"
        % (boundary, len(root_records), boundary_note)
    )
    print("value                \u672a\u62a5\u544a (missing) \u2014 stays missing, never 0")

    head("4. smoke \u2014 the connectivity gate's cache columns")
    smoke = read_json(os.path.join(ARCHIVE, "evidence", "smoke-1", "result.json"))["smoke"]
    smoke_meta = read_json(os.path.join(ARCHIVE, "evidence", "s3", "run-meta.json"))["smoke"]["result"]
    smoke_driver = read_text(os.path.join(ARCHIVE, "driver", "r1-smoke.ts"))
    check(sorted(smoke) == sorted(smoke_meta), "the archived smoke record and run-meta's copy disagree")
    check("cacheReadTokens" not in smoke and "cacheWriteTokens" not in smoke, "the smoke record carries a cache column")
    check(
        "chunk.usage.inputTokens" in smoke_driver
        and "chunk.usage.outputTokens" in smoke_driver
        and "chunk.usage.cacheReadTokens" not in smoke_driver
        and "chunk.usage.cacheWriteTokens" not in smoke_driver,
        "driver/r1-smoke.ts does not match the stated accounting",
    )
    print("record               evidence/smoke-1/result.json (keys: %s)" % ", ".join(sorted(smoke)))
    print("inputTokens          %d" % smoke["inputTokens"])
    print("outputTokens         %d" % smoke["outputTokens"])
    print("cacheReadTokens      \u672a\u62a5\u544a (not recorded at all)")
    print("cacheWriteTokens     \u672a\u62a5\u544a (not recorded at all)")
    print("why                  driver/r1-smoke.ts reads only chunk.usage.inputTokens/outputTokens; the smoke's own")
    print("                     SmokeResult carries no cache column, so neither 0 nor a number exists for it")

    head("5. historical lower bounds (V6) \u2014 restated exactly as they stand, not recomputed, not extended")
    contract = read_text(os.path.join(ARCHIVE, "fixtures", "frozen-contract.md"))
    contract_lines = [
        text.strip() for text in contract.splitlines() if "175461" in text or "501349" in text
    ]
    ledger = read_json(os.path.join(ARCHIVE, "evidence", "ledger.json"))
    history = ledger["historyCorrection"]
    check(len(contract_lines) == 1, "the frozen contract does not state the V6 lower bound on exactly one line")
    for figure in ("175461", "58", "501349"):
        check(figure in contract, "the frozen contract does not restate %s" % figure)
        check(figure in json.dumps(history), "the ledger's historyCorrection does not restate %s" % figure)
    print("frozen-contract.md \u00a75 (verbatim):")
    for text in contract_lines:
        print("  %s" % text)
    print("")
    print("evidence/ledger.json:historyCorrection (verbatim):")
    print(json.dumps(history, ensure_ascii=False, indent=2))
    print("")

    old_logs = sorted(glob.glob(os.path.join(OLD_ROUND, "*", "dsh-home", "session-log", "*.jsonl")))
    old_objects = 0
    old_no_write = 0
    old_read_zero = 0
    old_reasoning = 0
    old_per_log = []
    for path in old_logs:
        text = read_text(path)
        count = 0
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            event = json.loads(line)
            if event.get("type") != "assistant/message":
                continue
            usage = (event.get("data") or {}).get("usage")
            if usage is None:
                continue
            count += 1
            old_objects += 1
            if "cacheWriteTokens" not in usage:
                old_no_write += 1
            if usage.get("cacheReadTokens") == 0:
                old_read_zero += 1
            if "reasoningTokens" in usage:
                old_reasoning += 1
        old_per_log.append((os.path.relpath(path, OLD_ROUND), count))
    budget = read_json(os.path.join(OLD_ROUND, "budget.json"))
    check(old_no_write == old_objects, "the old round does report cacheWriteTokens somewhere")
    check(
        budget["counted"]["cacheWriteTokens"] == 0,
        "the old round's budget.json does not carry the collapsed 0",
    )
    print("old-round census (durable session logs, for the field's presence only \u2014 no figure is recomputed):")
    for name, count in old_per_log:
        print("  %-70s usage objects %d" % (name, count))
    print("  %-70s usage objects %d" % ("total", old_objects))
    print("  %-70s %d" % ("of those, carrying a cacheWriteTokens key", old_objects - old_no_write))
    print("  %-70s %d" % ("of those, lacking the key (=> 'not reported' there too)", old_no_write))
    print("  %-70s %d" % ("of those, carrying a cacheReadTokens value of 0 (genuine reported zero)", old_read_zero))
    print("  %-70s %d" % ("of those, carrying reasoningTokens", old_reasoning))
    print(
        "  old budget.json:%d  \"cacheWriteTokens\": 0  \u2014 same collapse; every old-round response is in the 'absent' case,"
        % line_of(os.path.join(OLD_ROUND, "budget.json"), "cacheWriteTokens")
    )
    print("  so the old round's cache-write column is likewise \u672a\u62a5\u544a, not a measured 0.")
    print("")
    print("effect on the lower bound: none, and none is claimed here.")
    print("  175461 is input+output; 501349 is the cache-inclusive figure (input+output+cacheRead, ledger arithmeticCorrection).")
    print("  Neither sum contains a cache-write term, so re-reading the old cache-write 0 as 'not reported' moves nothing.")
    print("  No cache-write lower bound is stated for the old round: the field was never reported there, exactly as here.")
    print("  The lower bound itself is restated, not recomputed and not extended.")

    head("6. protocol structure \u2014 where a cache-write number could have come from")
    chat = read_text(os.path.join(PROTOCOLS, "chat-completions", "translate.ts"))
    messages = read_text(os.path.join(PROTOCOLS, "messages", "translate.ts"))
    chat_hits = chat.count("cacheWriteTokens")
    messages_hits = messages.count("cacheWriteTokens")
    check(chat_hits == 0, "the chat-completions protocol does map cacheWriteTokens")
    check(messages_hits > 0, "the messages protocol does not map cacheWriteTokens")
    print("protocol/chat-completions/translate.ts  'cacheWriteTokens' occurrences: %d" % chat_hits)
    print("  mapUsage emits, at most: inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens")
    print("  cache read comes from prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens and is")
    print("  subtracted out of inputTokens; there is no cache-write field on this wire mapping at all.")
    print("protocol/messages/translate.ts          'cacheWriteTokens' occurrences: %d" % messages_hits)
    print("  (cache_creation_input_tokens -> cacheWriteTokens), so the optional field exists in the")
    print("  harness TokenUsage type but only the messages protocol fills it. This run used chat-completions.")
    print("")
    print("=> `chunk.usage.cacheWriteTokens ?? 0` therefore fires on every response of this run. The recorded")
    print("   0 is the fallback, not a gateway figure: the collapse is structural, not incidental.")

    head("7. provenance \u2014 every file read, sha256 computed at run time")
    unique = {}
    for path, digest, size in provenance:
        unique[path] = (digest, size)
    for path in sorted(unique):
        digest, size = unique[path]
        print("  %s  %8d bytes  %s" % (digest, size, label(path)))
    print("")
    print("  files read: %d" % len(unique))

    head("8. frozen trees \u2014 manifest recomputed read-only from the trees themselves")
    for root in (ARCHIVE, OLD_ROUND):
        digest, count = manifest(root)
        print("  %-52s %3d files  manifest sha256 %s" % (os.path.basename(root), count, digest))
    print("")
    print("  The manifest is byte-ordered (LC_ALL=C): for every file, sha256 + two spaces + './' + path,")
    print("  joined in sorted order, hashed once. The same digests come out of the shell equivalent")
    print("  `cd <tree> && LC_ALL=C find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum`,")
    print("  so any later change to either frozen tree shows up as a different digest.")

    head("checks")
    if problems:
        for message in problems:
            print("  FAIL %s" % message)
        print("  %d check(s) failed" % len(problems))
        return 1
    print("  all consistency checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
