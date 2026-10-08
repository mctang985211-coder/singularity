#!/usr/bin/env python3
"""Extract Python→TS test vectors for the RRSI strategy port.

Runs against a local checkout of google-research/rrsi @ be50316 (Apache-2.0) and
writes rrsi-vectors.json next to this script. Upstream-native vectors call the
upstream functions directly; port-adapted vectors reimplement the TypeScript
port's deterministic rules (LCG bootstrap, rounds-1 anneal denominator, absolute
cost admission) so every expected value is computed, not transcribed.

Usage: python3 extract-rrsi-vectors.py [path-to-rrsi-checkout]
"""
import json
import math
import sys
from pathlib import Path

UPSTREAM = Path(sys.argv[1] if len(sys.argv) > 1 else "/home/ROXY/code/bb_work/rrsi-review/rrsi").resolve()
sys.path.insert(0, str(UPSTREAM))

from rrsi.calibrate import calibrate as upstream_calibrate            # noqa: E402
from rrsi.config import RRSIConfig                                    # noqa: E402
from rrsi.evaluate import TaskResult, aggregate as upstream_aggregate # noqa: E402
from rrsi.history import History, stall_flag as upstream_stall_flag   # noqa: E402
from rrsi.schedule import budget_table, edit_budget                   # noqa: E402
from rrsi.selection import Candidate, cost_rule as upstream_cost_rule # noqa: E402
from rrsi.selection import select_round as upstream_select_round      # noqa: E402
import tempfile                                                       # noqa: E402

COMMIT = "be50316"
LICENSE = "Apache-2.0"
FLOOR = 0.02


def prov(source):
    path, line = source.rsplit(":", 1)
    return {"commit": COMMIT, "file": path, "line": int(line), "license": LICENSE}


def vector(vid, source, kind, function, inp, expected, note=None):
    v = {"id": vid, "source": source, "kind": kind, "function": function,
         "input": inp, "expected": expected, "provenance": prov(source)}
    if note:
        v["portNote"] = note
    return v


# ---------------------------------------------------------------- port copies
def port_edit_budget(t, rounds, bmin, bmax):
    if rounds <= 1:
        return bmin
    t = max(0, min(int(t), rounds - 1))
    return math.ceil(bmin + (bmax - bmin) * 0.5 * (1 + math.cos(math.pi * t / (rounds - 1))))


def port_aggregate(ev):
    num = den = 0.0
    toks = []
    unknown = False
    for task in ev["tasks"]:
        for tr in task["trials"]:
            num += tr["quality"] * tr["weight"]
            den += tr["weight"]
            if tr["tokens"] is None:
                unknown = True
            elif tr["tokens"] > 0:
                toks.append(tr["tokens"])
    return {"quality": num / den if den else 0.0,
            "cost": sum(toks) / len(toks) if toks else None,
            "expected": len(ev["tasks"]) * ev["trials"],
            "missing": ev["missing"],
            "incomplete": ev["missing"] > 0 or unknown}


def port_pool(evals):
    scope = evals[0]["scope"]
    tasks, order = {}, []
    trials = missing = 0
    for ev in evals:
        assert ev["scope"] == scope, "scope mismatch"
        trials += ev["trials"]
        missing += ev["missing"]
        for task in ev["tasks"]:
            if task["taskId"] not in tasks:
                tasks[task["taskId"]] = []
                order.append(task["taskId"])
            tasks[task["taskId"]] += task["trials"]
    return {"scope": scope, "trials": trials, "missing": missing,
            "tasks": [{"taskId": t, "trials": tasks[t]} for t in order]}


def port_bootstrap_se(ev, reps, seed):
    """Deterministic LCG resampler, bit-identical to the TS port. The index uses
    the high bits (state >> 16): the low bits of a 2**32-modulus LCG just
    alternate parity, which would degenerate every n=2 resample."""
    state = seed % 2**32
    tasks = [t for t in ev["tasks"] if t["trials"]]
    vals = []
    for _ in range(reps):
        num = den = 0.0
        for task in tasks:
            n = len(task["trials"])
            for _j in range(n):
                state = (state * 1664525 + 1013904223) % 2**32
                tr = task["trials"][(state >> 16) % n]
                num += tr["quality"] * tr["weight"]
                den += tr["weight"]
        vals.append(num / den if den else 0.0)
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    return math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))


def sample_stdev(xs):
    if len(xs) < 2:
        return 0.0
    mean = sum(xs) / len(xs)
    return math.sqrt(sum((x - mean) ** 2 for x in xs) / (len(xs) - 1))


def port_calibrate(evals, z=2.0, reps=2000, seed=7, min_independent=3):
    aggregates = [port_aggregate(ev) for ev in evals]
    band = method = None
    se = 0.0
    if len(evals) >= min_independent:
        se = sample_stdev([a["quality"] for a in aggregates])
        sd_null = se * math.sqrt(2)
        if sd_null > 0:
            band, method = z * sd_null, "repeated-baseline-evaluations"
    if band is None:
        pooled = port_pool(evals)
        se = port_bootstrap_se(pooled, reps, seed)
        sd_boot = math.sqrt(2) * se * math.sqrt(pooled["trials"] / evals[0]["trials"])
        if sd_boot > 0:
            band, method = z * sd_boot, "within-task-bootstrap"
    degenerate = False
    if band is None:
        band, method, degenerate, se = FLOOR, "declared-floor", True, 0.0
    costs = [a["cost"] for a in aggregates if a["cost"] is not None and a["cost"] > 0]
    if len(costs) >= 2:
        spread = z * sample_stdev(costs) / (sum(costs) / len(costs))
        if spread > 0:
            rel = spread
        else:
            rel, degenerate = FLOOR, True
    else:
        rel, degenerate = FLOOR, True
    return {"qualityBand": round(band, 6), "relativeCostBand": round(rel, 6),
            "method": method, "evaluations": len(evals),
            "standardError": round(se, 6), "degenerate": degenerate}


def port_cost_rule(dS, dC, band, rel_band, base, slope, cap, min_relief):
    if dS > band:
        budget = min(base + slope * dS, cap)
        if dC is None:
            return {"ok": False, "reasonCode": "cost-inconclusive"}
        ok = dC <= budget
        return {"ok": ok, "reasonCode": "admissible" if ok else "cost-rule-failed"}
    relief = max(rel_band, min_relief)
    if dC is None:
        return {"ok": False, "reasonCode": "cost-inconclusive"}
    ok = dC <= -relief
    return {"ok": ok, "reasonCode": "admissible" if ok else "in-band-no-relief"}


def trial(q, w=1, tokens=1000):
    return {"quality": q, "weight": w, "tokens": tokens}


def ev(scope, k, rewards_by_task, tokens=1000, missing=0, weights=None):
    tasks = []
    for i, (tid, rewards) in enumerate(rewards_by_task.items()):
        ws = (weights or {}).get(tid, [1] * len(rewards))
        ts = (tokens.get(tid) if isinstance(tokens, dict) else None) or [tokens] * len(rewards)
        tasks.append({"taskId": tid,
                      "trials": [{"quality": q, "weight": w, "tokens": t}
                                 for q, w, t in zip(rewards, ws, ts)]})
    return {"scope": scope, "trials": k, "missing": missing, "tasks": tasks}


def to_upstream_ev(ev, job="v"):
    per = {t["taskId"]: TaskResult(rewards=[tr["quality"] for tr in t["trials"]],
                                   weights=[tr["weight"] for tr in t["trials"]],
                                   tokens=[tr["tokens"] for tr in t["trials"]],
                                   missing=0)
           for t in ev["tasks"]}
    return upstream_aggregate(job, ev["trials"], per)


def port_judge(cand, incumbent, best_quality, band, rel_band, guards, cap=0.25):
    if cand.get("refusedBy"):
        return {"candidateId": cand["candidateId"], "admissible": False,
                "reasonCode": "not-measured"}
    agg = cand["aggregate"]
    dS = agg["quality"] - incumbent["quality"]
    dC = ((agg["cost"] - incumbent["cost"]) / incumbent["cost"]
          if agg["cost"] is not None and incumbent["cost"] else None)
    if agg["missing"] > 0:
        return {"candidateId": cand["candidateId"], "admissible": False, "reasonCode": "quality-inconclusive"}
    if agg["quality"] < best_quality - band:
        return {"candidateId": cand["candidateId"], "admissible": False, "reasonCode": "below-floor"}
    if guards:
        return {"candidateId": cand["candidateId"], "admissible": False, "reasonCode": "guard-violated"}
    rule = port_cost_rule(dS, dC, band, rel_band, 0.10, 40.0, cap, 0.05)
    return {"candidateId": cand["candidateId"],
            "admissible": rule["ok"], "reasonCode": rule["reasonCode"] if not rule["ok"] else "admissible",
            "quality": agg["quality"]}


def port_select(cands, incumbent, best_quality, band, rel_band, guards_for, cap=0.25):
    admissions = [port_judge(c, incumbent, best_quality, band, rel_band,
                             guards_for.get(c["candidateId"], []), cap) for c in cands]
    adm = [(c, a) for c, a in zip(cands, admissions) if a["admissible"]]
    winner = None if not adm else max(adm, key=lambda ca: ca[1].get("quality", -1))[0]["candidateId"]
    return {"winner": winner,
            "admissions": [{k: v for k, v in a.items() if k != "quality"} for a in admissions]}


def candidate(cid, quality, cost=1000, mechanism="text", refused_by=None, expected=20):
    return {"candidateId": cid, "contentDigest": cid.lower() * 8, "scope": "s",
            "edits": [] if refused_by else [{"id": "C1", "mechanism": mechanism, "targets": ["x"]}],
            "aggregate": None if refused_by else
            {"quality": quality, "cost": cost, "expected": expected, "missing": 0, "incomplete": False},
            "refusedBy": refused_by}


INCUMBENT = {"quality": 0.5, "cost": 1000, "expected": 20, "missing": 0, "incomplete": False}

vectors = []

# ------------------------------------------------------------- schedule ------
vectors.append(vector(
    "schedule.anneal.20.1.4", "rrsi/schedule.py:53", "upstream-native", "editBudgetTable",
    {"rounds": 20, "min": 1, "max": 4}, budget_table(20, 1, 4),
    "upstream denominator T: the last in-range round stays at 2; only the out-of-range endpoint reaches min"))
for rounds, bmin, bmax in [(20, 1, 4), (20, 1, 2), (8, 1, 2), (5, 1, 2), (3, 1, 4), (1, 1, 2)]:
    vectors.append(vector(
        f"schedule.anneal.port.{rounds}.{bmin}.{bmax}", "rrsi/schedule.py:43", "port-adapted",
        "editBudgetTable", {"rounds": rounds, "min": bmin, "max": bmax},
        [port_edit_budget(t, rounds, bmin, bmax) for t in range(rounds)],
        "denominator rounds-1 (plan §4 override): table[rounds-1] === min exactly"))
vectors.append(vector(
    "schedule.anneal.upstream.endpoint", "tests/test_core.py:63", "upstream-native", "editBudget",
    {"round": 20, "rounds": 20, "min": 1, "max": 4}, edit_budget(20, 20, 1, 4),
    "upstream needs the out-of-range endpoint to hit b_min; the TS port clamps round to rounds-1"))

# ------------------------------------------------------------- evaluate ------
ev_unweighted = ev("s", 2, {"a": [1, 0], "b": [1, 1]})
assert abs(to_upstream_ev(ev_unweighted).S - 0.75) < 1e-9
vectors.append(vector(
    "evaluate.aggregate.unweighted", "tests/test_core.py:67", "deterministic", "aggregateEvaluation",
    ev_unweighted, port_aggregate(ev_unweighted)))
ev_weighted = {"scope": "s", "trials": 2, "missing": 0, "tasks": [
    {"taskId": "a", "trials": [trial(0.5, 10), trial(1.0, 10)]},
    {"taskId": "b", "trials": [trial(0.0, 90), trial(0.0, 90)]}]}
assert abs(port_aggregate(ev_weighted)["quality"] - 15 / 200) < 1e-9
vectors.append(vector(
    "evaluate.aggregate.weighted", "tests/test_core.py:69", "deterministic", "aggregateEvaluation",
    ev_weighted, port_aggregate(ev_weighted)))
ev_missing = {"scope": "s", "trials": 2, "missing": 1, "tasks": [
    {"taskId": "a", "trials": [trial(1, 1, 10), trial(0, 1, None)]}]}
vectors.append(vector(
    "evaluate.missing.denominator", "rrsi/evaluate.py:104", "deterministic", "aggregateEvaluation",
    ev_missing, port_aggregate(ev_missing),
    "missing trial keeps the full denominator and unknown cost stays out of the mean"))

# ------------------------------------------------------------ calibrate ------
cal_evs = [ev("s", 2, {f"t{i}": [1, 1] if i < n else [0, 0] for i in range(10)}, tokens=tok)
           for n, tok in [(5, 1000), (3, 1100), (5, 950)]]
cal_evs[1]["tasks"][4]["trials"][0] = trial(1, 1, 1100)
cal_evs[1]["tasks"][4]["trials"][1] = trial(0, 1, 1100)  # S = 7/20 = 0.35
assert [round(port_aggregate(e)["quality"], 6) for e in cal_evs] == [0.5, 0.35, 0.5]
upstream_cal = upstream_calibrate([to_upstream_ev(e) for e in cal_evs], z=2.0, reps=200)
port_cal = port_calibrate(cal_evs, z=2.0, reps=200)
assert abs(upstream_cal["delta"] - port_cal["qualityBand"]) < 1e-6, (upstream_cal, port_cal)
vectors.append(vector(
    "calibrate.three-evals", "rrsi/calibrate.py:89", "deterministic", "calibrateNoise",
    {"evals": cal_evs, "policy": {"noise": {"z": 2.0, "bootstrapReps": 200}}},
    port_cal,
    "3 independent base evaluations satisfy minIndependentEvaluations; port and upstream agree"))
single = ev("s", 2, {f"t{i}": [i % 2, (i + 1) % 2] for i in range(40)})
vectors.append(vector(
    "calibrate.single-eval", "tests/test_core.py:75", "port-adapted", "calibrateNoise",
    {"evals": [single], "policy": {"noise": {"z": 2.0, "bootstrapReps": 300}}},
    port_calibrate([single], z=2.0, reps=300),
    "fewer than 3 independent evaluations -> within-task bootstrap; identical trial costs make "
    "cost noise unobservable, so degenerate is true and relativeCostBand falls back to the floor"))

# ------------------------------------------------------------ cost rule ------
cfg = RRSIConfig(beta0=0.1, beta1=40.0, w_s=100.0, w_c=15.0, w_n=0.5)
UPSTREAM_EQ = "upstream-equivalent"
for vid, dS, dC, line in [
    ("cost_rule.gaining.within", 0.05, 0.10 + 40 * 0.05 - 0.01, 87),
    ("cost_rule.gaining.over", 0.05, 0.10 + 40 * 0.05 + 0.01, 89),
    ("cost_rule.band.cheaper", 0.0, -0.10, 91),
    ("cost_rule.band.costlier", 0.0, 0.10, 93),
]:
    ok, _ = upstream_cost_rule(dS, dC, 0, 0.02, cfg)
    ported = port_cost_rule(dS, dC, 0.02, 0.02, 0.10, 40.0, math.inf, 0.0)
    assert ported["ok"] == ok, (vid, ok, ported)
    vectors.append(vector(
        vid, f"tests/test_core.py:{line}", "deterministic", "costRule",
        {"deltaQuality": dS, "deltaCost": round(dC, 9), "novelty": 0,
         "calibration": {"qualityBand": 0.02, "relativeCostBand": 0.02}, "policy": UPSTREAM_EQ},
        ported))
ok, _ = upstream_cost_rule(0.0, 0.0, 1, 0.02, cfg)
assert ok, "upstream admits an in-band neutral-cost candidate on novelty alone"
vectors.append(vector(
    "cost_rule.band.novel", "tests/test_core.py:95", "port-adapted", "costRule",
    {"deltaQuality": 0.0, "deltaCost": 0.0, "novelty": 1,
     "calibration": {"qualityBand": 0.02, "relativeCostBand": 0.02}, "policy": UPSTREAM_EQ},
    {"ok": False, "reasonCode": "in-band-no-relief"},
    "plan §4 override: upstream admits this on +w_n*nu (selection.py:90); the port never relaxes on novelty"))
vectors.append(vector(
    "cost_rule.gaining.capped", "rrsi/config.py:70", "port-adapted", "costRule",
    {"deltaQuality": 0.05, "deltaCost": round(0.10 + 40 * 0.05 - 0.01, 9), "novelty": 0,
     "calibration": {"qualityBand": 0.02, "relativeCostBand": 0.02}, "policy": "default"},
    port_cost_rule(0.05, 0.10 + 40 * 0.05 - 0.01, 0.02, 0.02, 0.10, 40.0, 0.25, 0.05),
    "plan §4 override: the 25% maxRelativeIncrease cap binds where upstream beta1 = 40 would allow +209%"))
vectors.append(vector(
    "cost_rule.gaining.missing-cost", "rrsi/evaluate.py:131", "port-adapted", "costRule",
    {"deltaQuality": 0.05, "deltaCost": None, "novelty": 0,
     "calibration": {"qualityBand": 0.02, "relativeCostBand": 0.02}, "policy": "default"},
    {"ok": False, "reasonCode": "cost-inconclusive"},
    "plan §4 override: upstream relative_cost_change returns 0 here and the L1 rule silently passes"))

# ------------------------------------------------------------ selection ------
a = candidate("A", 0.7, mechanism="text")
b = candidate("B", 0.6, mechanism="skill")
c = candidate("C", 0.3, mechanism="parameter")
d = candidate("D", None, refused_by="critic-reject")
sel_in = {"candidates": [a, b, c, d], "incumbent": INCUMBENT, "incumbentScope": "s",
          "bestQuality": 0.55, "calibration": {"qualityBand": 0.05, "relativeCostBand": 0.02},
          "guards": {}, "policy": "default"}
vectors.append(vector(
    "selection.argmax.floor", "tests/test_core.py:99", "port-adapted", "selectRound", sel_in,
    port_select(sel_in["candidates"], INCUMBENT, 0.55, 0.05, 0.02, {}),
    "mechanisms mapped to the port vocabulary (prompt->text, config->parameter); the critic-rejected "
    "candidate reports not-measured with refusedBy instead of upstream's gate_failure string"))
e = candidate("E", 0.7, cost=1000 * (1 + 0.1 + 40 * 0.2 + 0.5))
sel_cost = {"candidates": [e], "incumbent": INCUMBENT, "incumbentScope": "s", "bestQuality": 0.55,
            "calibration": {"qualityBand": 0.05, "relativeCostBand": 0.02}, "guards": {}, "policy": "default"}
vectors.append(vector(
    "selection.cost.blocked", "tests/test_core.py:117", "deterministic", "selectRound", sel_cost,
    port_select(sel_cost["candidates"], INCUMBENT, 0.55, 0.05, 0.02, {}),
    "dC = 8.6 exceeds both the upstream budget 8.1 and the port cap 0.25"))
sel_guard = {"candidates": [a], "incumbent": INCUMBENT, "incumbentScope": "s", "bestQuality": 0.55,
             "calibration": {"qualityBand": 0.05, "relativeCostBand": 0.02},
             "guards": {"A": ["valid rate fell"]}, "policy": "default"}
vectors.append(vector(
    "selection.guard.noncompensatory", "tests/test_core.py:123", "deterministic", "selectRound",
    sel_guard, port_select(sel_guard["candidates"], INCUMBENT, 0.55, 0.05, 0.02, {"A": ["valid rate fell"]}),
    "guards reject regardless of the quality gain"))
# cross-check the port expectations against upstream's own selection run
up_inc = to_upstream_ev(ev("s", 2, {f"t{i}": [1, 1] if i < 5 else [0, 0] for i in range(10)}))
up_a = Candidate("A", [{"id": "C1", "component": "prompt"}],
                 ev=to_upstream_ev(ev("s", 2, {f"t{i}": [1, 1] if i < 7 else [0, 0] for i in range(10)})))
up_c = Candidate("C", [{"id": "C1", "component": "config"}],
                 ev=to_upstream_ev(ev("s", 2, {f"t{i}": [1, 1] if i < 3 else [0, 0] for i in range(10)})))
up_d = Candidate("D", [], gate_failure="critic_reject")
win, decs = upstream_select_round([up_a, up_c, up_d], up_inc, 0.55, 0.05, cfg, {})
assert win is up_a and not decs[1].admissible and "floor" in decs[1].reason

# -------------------------------------------------------------- novelty ------
vectors.append(vector(
    "novelty.structural", "tests/test_core.py:151", "port-adapted", "noveltyOf",
    {"cases": [
        {"mechanisms": ["capability", "text"], "incumbentCounts": {"text": 1}},
        {"mechanisms": ["skill"], "incumbentCounts": {"skill": 2}}]},
    [1, 0],
    "vocabulary mapping of the upstream vector (client_tool->capability, prompt->text)"))

# ------------------------------------------------------------ stall flag -----
traj = [0.50, 0.53, 0.53, 0.535, 0.60]
cases = [(3, 3), (3, 2), (4, 2), (1, 3)]
expected = [upstream_stall_flag(traj, t, w, 0.02) for t, w in cases]
assert expected == [0, 1, 0, 0]
vectors.append(vector(
    "stall.flag", "tests/test_core.py:154", "deterministic", "stallFlag",
    {"trajectory": traj, "band": 0.02, "cases": [{"t": t, "window": w} for t, w in cases]},
    expected))

# --------------------------------------------------------- exploration -------
vectors.append(vector(
    "exploration.stall", "tests/test_core.py:159", "port-adapted", "exploration",
    {"t": 3, "stall": 1, "tried": ["text"], "reservedDrafts": 1},
    {"sigma": 1, "untried": ["skill", "capability", "task-template", "parameter"],
     "reservedDrafts": 1, "textIncludes": "RESERVED"},
    "mechanism vocabulary differs from upstream K; the RESERVED wording is kept"))

# --------------------------------------------------------------- history -----
with tempfile.TemporaryDirectory() as td:
    h = History(Path(td) / "history.jsonl")
    h.append_candidate(0, "A", [{"id": "C1", "component": "prompt", "hypothesis": "h1"}],
                       "ACCEPTED", 0.03, 0.05, True, 0.53, 1000, None)
    h.append_candidate(1, "A", [{"id": "C1", "component": "prompt", "hypothesis": "h2"}],
                       "REJECTED", -0.01, 0.0, False, 0.52, 1000, None)
    h.append_candidate(1, "B", [{"id": "C1", "component": "skill", "hypothesis": "h3"},
                                {"id": "C2", "component": "memory", "hypothesis": "h4"}],
                       "REJECTED", -0.02, 0.3, False, 0.51, 1300, None)
    h.append_candidate(2, "A", [{"id": "C1", "component": "config", "hypothesis": "h5"}],
                       "critic_reject", None, None, False, None, None, None, "leak")
    g3 = h.yield_g(t=3, n_prune=4)
    vectors.append(vector(
        "history.tried.yield.prune", "tests/test_core.py:128", "upstream-native",
        "foldHistory", {"scenario": "test_core.py:128-153 verbatim append_candidate calls"},
        {"tried": sorted(h.tried()),
         "yieldAt3": {k: (None if v == -math.inf else v) for k, v in sorted(g3.items())},
         "yieldPromptAt5": h.yield_g(t=5, n_prune=4)["prompt"],
         "yieldPromptAt6": None,
         "pruneComponentsAt5": sorted(p["component"] for p in h.prune_set(t=5, n_prune=4)),
         "incumbentPromptEdits": h.incumbent_component_counts()["prompt"]},
        "documentation of upstream semantics; the port derives these from facts with a single "
        "frozen incumbent baseline and its own vocabulary, pinned inline in strategy-history.spec.ts"))

doc = {
    "provenance": {
        "repository": "https://github.com/google-research/rrsi",
        "commit": COMMIT,
        "license": LICENSE,
        "licenseFile": "rrsi/LICENSE",
        "extractedBy": "evolution/tests/vectors/extract-rrsi-vectors.py",
    },
    "vectors": vectors,
}
out = Path(__file__).resolve().parent / "rrsi-vectors.json"
out.write_text(json.dumps(doc, indent=1) + "\n")
print(f"wrote {len(vectors)} vectors to {out}")
