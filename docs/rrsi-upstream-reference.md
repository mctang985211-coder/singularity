# RRSI 上游源码对照（逐条带行号）

- 上游：[google-research/rrsi](https://github.com/google-research/rrsi) @ `be50316`，本地 `/home/ROXY/code/rrsi`
- 目的：阶段 E（RRSI 闭环）要照上游接，所以对照必须是**读过代码的**
- 本文只有两类陈述：**我本人读到的行**、以及明确标注为**未读**的部分

---

## 0. 覆盖范围

**已逐行读完（算法面全覆盖，≈2500 行）**：
`config.py`(97) `components.py`(108) `schedule.py`(54) `evaluate.py`(135) `calibrate.py`(119) `selection.py`(137) `history.py`(211) `analyst.py`(204) `digester.py`(221) `propose.py`(410) `critic.py`(147) `domain.py` 接口 `loop.py` 除 :420-452 外全部（`Run` 状态/git/evidence/baseline :71-229、`round()` :230-346、`readjudicate()` :348-420、`_draft()`/`_evaluate()` :452-605）。

**未读（纯管道，≈400 行）**：`gitops.py`(126) `llm.py`(124) `driver.py`(99) `__init__.py`(43) `loop.py`:420-452、`rrsi.py`(CLI)。下述结论不覆盖它们。

---

## 1. 符号表与默认值（`config.py`，权威）

docstring `:31-42` 明列符号；`:44-46` 明列单位：

| 符号 | 含义 | 默认 |
|---|---|---|
| `T` | 轮数 `t = 0..T-1` | 20 |
| **`k`** | **每任务 trial 数**（`Evaluate` 内） | **2** |
| **`m`** | **每轮抽取的候选数** `\|C_t\|`（筛查前） | **2** |
| `b_min`/`b_max` | 退火 L0 编辑预算上下界 | 1 / 4 |
| `w` | 停滞标志 `σ_t` 的窗口 | 3 |
| `m_draft` | 停滞时**保留给探索编辑的候选槽** | 1 |
| `delta` | 经验噪声带；`None` → 读 `calibration.json` | None |
| `delta_z` | `δ = z·sd(null ΔS)` | 2.0 |
| `beta0`/`beta1` | 增益候选的 L1 成本规则 | 0.10 / 40.0 |
| `w_s`/`w_c`/`w_n` | 带内整形规则（含 novelty 项） | 100.0 / 15.0 / 0.5 |
| `n_prune` | 近期收益摘要 `g_t` 的窗口 | 4 |

工程旋钮（docstring `:76` 明说"not part of the method"）：`repair_rounds=5`、`invalid_missing_frac=0.15`、`n_fail_traces=22`、`n_success_traces=6`、`eval_parallel=1`、三个模型名（`claude-opus-4-8`）。

**单位（`:44-46`）**：`S ∈ [0,1]`；`C` = 每 trial 的平均策略 token 数；`ΔC` 是**相对值**——所以 `beta0=0.10` 意为"10% 的 token 增量免费"，`beta1=40` 意为"每 +1pp 的 S 可换 +40% 成本"。

> **`m` 与 `k` 默认都是 2**——这正是我把"每轮 k 个候选"写错的原因（`config.py:60-61`）。

## 2. 一轮的完整流程（`loop.py:231-346` + `_draft:453-576` + `_evaluate:578-605`）

```python
def round(self, t):
    fr = self.frontier(); inc = fr["incumbent"]          # :233-234
    if inc["harness_tree"] != self.harness_tree(...): raise        # :235-237
    delta = self.delta()                                 # :241

    # 1) F_t <- Analyze(H_t, D_evolve)                    # :249-268
    traces = self.build_traces(inc["job"], inc_ev.per_task)
    if len(traces) < 0.5 * min(len(ids), n_fail + n_success): raise # :251-252
    report = analyze(d, traces, inc_ev.per_task, rdir, prior_modes=..., prior_habits=...)
    self.global_analysis.write_text(...)                 # :265-267 跨轮累积

    # 2-3) b_t, sigma_t, T_t, U_t, E_t, B_t               # :273-288
    budget = edit_budget(t, cfg.T, cfg.b_min, cfg.b_max)
    sigma  = stall_flag([x["S"] for x in fr["trajectory"]], t, cfg.w, delta)
    explore = exploration(t, sigma, self.history.tried(), cfg.m_draft)
    prune  = self.history.prune_set(t, cfg.n_prune)
    (rdir / "directives.json").write_text({...})         # :285-288

    # 4) draw and screen m candidates                     # :290-297
    for v in range(cfg.m):
        reserved = bool(sigma and explore["untried"] and v >= cfg.m - cfg.m_draft)   # :294

    # 5) evaluate the screened set, in parallel           # :299-302
    live = [c for c in cands if c.gate_failure is None]
    with ThreadPoolExecutor(max_workers=cfg.eval_parallel) as ex:
        list(ex.map(lambda c: self._evaluate(t, c, rdir, ids), live))

    # 6) Algorithm 2                                      # :304-325
    counts = self.history.incumbent_component_counts()
    winner, decisions = select_round(cands, inc_ev, fr["S_star"], delta, cfg, counts, guard_fn=d.guards)
    outcome = "ACCEPTED" if c is winner else ("LOST" if dec.admissible else "REJECTED")
    self.history.append_candidate(t, c.variant, c.edits, outcome, dec.delta_S, dec.delta_C, ...)
    self.attribute(t, c.variant, c.edits, inc_ev, c.ev)  # :323

    # 7) H_{t+1}                                          # :327-346
    if winner is not None:
        G.fast_forward(...); fr["S_star"] = max(fr["S_star"], new_S)   # :335
    else:
        new_S, new_C = inc_ev.S, inc_ev.C                              # :339 H_{t+1} = H_t
    self.save_frontier(fr)
    for c in cands: G.worktree_remove(...)                             # :345-346
```

**测量前的四道门**（都在 `_draft` 里，顺序固定）：

| 门 | 触发 | 标签 | 行 |
|---|---|---|---|
| 1 | proposer 未 `done` 或 `n_edits == 0` | `no_proposal` | `:495-496` |
| 2 | critic 拒绝（含 `repair_rounds` 次修复后仍拒） | `critic_reject` | `:532-533`、`:550-552` |
| 3 | **按 diff 重新打标签**后破坏保留槽 | `critic_reject` | `:523-530` |
| 4 | **liveness smoke 不通过** | `smoke_fail` | `:562-568` |

外加评估期一道：崩溃或缺失率 > `invalid_missing_frac`（重试一次后仍超）→ `eval_invalid`（`:588-602`）。
**因此「被筛掉的候选」有四种具名归因，且都不进 `T_t`/`g_t`。**

## 3. 证据管线（我此前完全没说清的一层）

### 3.1 选哪些轨迹看（`loop.py:134-150`）

```python
"""Worst trial of the lowest-scoring tasks plus the best trial of the
   highest-scoring ones (success habits the proposer must not break)."""
ranked = sorted(per_task.items(), key=lambda kv: kv[1].mean)
fails  = ranked[:n_fail_traces]           # 22
wins   = ranked[-n_success_traces:]       # 6，且排除已在 fails 里的
# 失败取该任务的 min-reward trial，成功取 max-reward trial
```
**失败面看得多（22）、成功面看得少但必须有（6）**，且各取该任务最有代表性的那次 trial。

### 3.2 digester：只读子代理（`digester.py`）

- 每个任务一个 **READ-ONLY subagent**，工具 jail 在该轮的 `analysis/rendered/` 目录；`ALLOWED_BASH` 白名单（grep/head/tail/wc/cat/ls/find/cut/sort/uniq/awk/jq/sed/tr/paste）+ `DENY_BASH` 正则拦 `>`/`>>`/反引号/`$(`/`sed -i`/rm/mv/cp/tee/touch/mkdir/chmod/python（`:44-49`）。
- `MAX_TURNS=15`、`DIGEST_MAX_CHARS=6000`、`TOOL_OUT_CAP=25_000`、`BASH_TIMEOUT=30`（`:41-43`）。
- **三套输出 schema**（`:56-73`）：`failure{blocker,narrative,evidence,verifier_evidence,capability_note,needed_instead}`、`capability_gap{wanted,why_couldnt,evidence,workaround_seen}`、`success{habits[],risk_if_removed}`；未知 lens 退化为 `failure`（`:160`）。
- docstring 明说目的：**"so the analyst's context carries structured conclusions, never whole traces"**。

### 3.3 analyst：三镜报告（`analyst.py`）

- **"The batch analyst never reads raw traces. It dispatches read-only digesters … and aggregates their digests"**（`:30-32`）。
- 动作：`digest_many`（每次 ≤8 个，`DIGEST_PARALLELISM=6` 并行）与 `report`（`:68-87`）。
- 预算指引（`:60-67`）：**先 digest 失败/低分任务**（失败镜），**优先覆盖每个疑似失败簇而非 digest 每一次失败**；**digest 3-5 个代表性成功任务**（成功镜，选与某个大失败簇相似的）；失败 digest 若提示是环境/脚手架管道挡住而非判断问题，走 `capability_gap` 镜或追问。
- 聚合规则（`:89-102`）：**合并**同机制、**拆分**跨两机制的标签；failure_modes 按**总影响排序**（任务数 × 该模式在每个任务上的失分）；描述必须 **entity-free 且 task-agnostic**（证据引文可含实体名）；**沿用先前的模式名**（稳定性命名）；**不规定代码改法、不归因于模型还是脚手架**；digest 互相矛盾时**先追问再报告**。
- 报告按 `-n_tasks` 排序（`:162`）；digests 落 `analysis/digests/<task>_<lens>.json`，`load_digests` 读回（`:200-204`）并作为 `findings` 交给 proposer（`loop.py:281,492`）。
- `MAX_TURNS=30`；超时返回三镜皆空 + `error`（`:196-197`）。

### 3.4 归因 scoreboard（`loop.py:152-178`）——我此前完全漏掉的机制

```python
thr = self.domain.regression_threshold(cfg.k)
pred  = predicted_affected ∩ inc.per_task ∩ cand.per_task
hits  = [p for p in pred if cand.per_task[p].mean > inc.per_task[p].mean]
drops = [x for x in inc.per_task if cand.per_task[x].mean - inc.per_task[x].mean <= -thr]
row   = {..., "n_predicted", "predicted_hit", "hit_rate", "unpredicted_regressions"}
```
`scoreboard()` 返回 `attribution.jsonl` 的**最近 20 行**（`:152-157`），并作为 proposer 上下文里的 "ATTRIBUTION SCOREBOARD（过去编辑的预测表现；`unpredicted_regressions` 是编辑大概弄坏的任务）"（`propose.py:272-274`）。**`predicted_affected` 是可被核对的具体任务 id，"over-claiming counts against you"（`propose.py:128`）。**

## 4. proposer（`propose.py`，全文读过）

- 一个**在候选 worktree 里就地改 harness 源码**的编码 agent，严格 JSON 动作协议：`list_files` / `read_file` / `list_traces` / `read_trace` / `edit_file`（`old` 必须**恰好出现一次**）/ `write_file`（**只许新建**，且扩展名在白名单内）/ `done`（`:71-88`、`Workspace:140-194`）。
- `MAX_TURNS=40`、`MAX_EDITS=80`、`TRACE_READ_CAP=60_000`（`:56-58`）。路径 jail：`_safe()` 拒绝逃出 harness 目录的路径（`:147-155`）。
- **`done()` 是机械执行点**（`:328-369`）：
  - `n_edits == 0 但声明了 edits` → 回弹"你声明了编辑却零文件改动"（`:331-335`）
  - `len(edits) > budget` → 回弹 `exceed the budget b_t`（`:338-339`）
  - 每条编辑必填 `id, component, hypothesis, targets_mode, predicted_affected, retroactive_check`（`:340-345`）
  - `component` 必须 ∈ `K`（`:346-348`）
  - **持保留槽却没有一条编辑落在未试组件上** → 回弹（`:349-354`）
  - **回弹而非接受**：模型必须重调 `done()`（`:355-359`）
- **"THERE IS NO ABORT ACTION"**（`:107-111`）："You must ship a candidate. A round that ships nothing tests nothing… A rejection is data; an abort is not." `abort` 被回弹最多 3 次（`aborts_left=3`，`:370-379`）。
- 每条编辑的**证据契约**（`:91-104`）：`hypothesis`（机制 + 为何应提升分数）、`targets_mode`、`why_not_lower_lever`、`trigger_condition`（必须可检查，"always" 几乎总是不对）、`predicted_affected`（**具体任务 id**）、`retroactive_check`（三段反事实：corrective / preservative / transfer）、`regression_risk`。
- proposer 上下文组装顺序（`:264-304`）：variant brief → **L_t**（每条已测编辑的 component/hypothesis/ΔS/ΔC/accepted）→ **scoreboard** → **E_t** → **B_t** → **F_t**（三镜）→ per-task digests → **当前 harness 源码全量** → **b_t** → 任务（或 REPAIR ROUND + `reviewer objections`）。
- **修复轮**：`repair_brief` 给出 `reasons`/`risk_notes`/`your_declared_edits`，要求"只修反对意见要求的部分"（`:292-299`），然后重调 `done`。
- `e.setdefault("mechanism", e.get("hypothesis"))`（`:362`）——`mechanism` 是 hypothesis 的别名（与 `history.py:87` 对应）。

## 5. critic（`critic.py`，全文读过）

两层，docstring `:34-36`：
1. **确定性预检**（`precheck:105-110`）：通用 denylist（凭据：`AIza…`/`sk-…`/`api_key = "…"`，`:50-52`）+ **领域自有 patterns**（`domain.critic_patterns`）。命中即**直接拒绝，不进 LLM**。
2. **LLM 意图审查**（`review:113-147`），**六条具名拒绝理由**（`:62-95`）：LEAKAGE/TASK-SPECIALIZATION、DEGENERATE（声称有机制却是空操作；或删/停用安全机制而无替代）、GRADER GAMING、UNDECLARED BUNDLING（diff 里有未被任何声明编辑覆盖的独立改动，或一条声明编辑暗藏多个机制）、**RUNTIME MEMORY / SKILL LEAKAGE**（能跨 trial 持久化/注入任务特异数据 = 记忆化）、UNBOUNDED WORK（无放弃路径的重试/自改进循环）。

其它：`empty diff` → 拒（`:120-121`）；**只看 diff 不看整文件**，并明说"运行期正确性（未定义名、崩溃、语法）**不是**你的职责：确定性的 compile/constructor/smoke 检查在你之后处理"（`:97-100`）；输出解析重试 3 次，**不可解析即拒**（fail-closed，`:145-147`）；输入含 `state_files`（机制持久化的状态）以便审查记忆化。

## 6. 选择（`selection.py:28-39` 的算法 2 + 全文）

```
admissible iff S' >= S* - delta  and  cost_rule  (and every domain guard holds)
H_{t+1} = argmax_{H' admissible} S',  or H_t if none
S*      = max(S*, S_{t+1})
```

- 带内分支**含 novelty**：`shaped = w_s·ΔS − w_c·ΔC + w_n·ν`（`:90`）。
- 增益分支 `ΔC <= β0 + β1·ΔS`，**无上界**（`:84-86`）。
- 准入顺序：噪声底线 → 成本规则 → guards（`:107-118`）。
- `argmax` 只在 admissible 内取；无则 `None`（`:133-136`）；同分时 Python `max` 取迭代序第一个。
- `relative_cost_change` 在**任一侧成本未知时返回 0.0**（静默放行，`evaluate.py:131-135`）。
- `Candidate.gate_failure ∈ {critic_reject, smoke_fail, eval_invalid}`（`:57`）。

## 7. 机制词表与 novelty（`components.py`，全文）

- `K = [prompt, control_flow, config, output_plumbing, context_mgmt, client_tool, skill, memory, subagent]`（**9 个**，`:44-45`）；`K_STR = [client_tool, skill, memory, subagent]`（`:46`）。
- `novelty = sum(1 for c in set(edit_components) if c in K_STR and incumbent_counts.get(c,0)==0)`（`:103-108`）——**`set()` 去重，所以两条同机制编辑的 novelty 仍是 1**。
- **声明标签必须有 diff 证据**才保留（`has_evidence`），否则**回退按 diff 分类**（`classify_diff`，默认 `prompt`，`:82-100`）；纯字符串/注释改动一律归 `prompt`（`text_only:58-79`）。
- docstring `:85-88` 明说理由：proposer 可以声明一个**没交付**的机制，或把控制流改动**改标成未试组件以占探索槽**，未核验的标签会污染 `T_t`/`U_t`/novelty。

## 8. 退火编辑预算（`schedule.py:43-54`）

`b_t = ceil(round(b_min + (b_max−b_min)·½(1+cos(πt/T)), 9))`，`t` clamp 到 `[0,T]`，`T<=0 → b_max`；`budget_table` 用 `range(T)`。
→ **上游除以 `T`，末轮 `budget_table(T)[-1]` 拿不到 `b_min`**；端口改成 `/ (rounds−1)`。

## 9. 评估（`evaluate.py:104-135`）

`S_hat = Σ r·w / Σ w`；`C_hat = mean(tokens>0)`；`n_expected = len(per_task)·k`。
**docstring 与代码不一致**：模块 docstring(`:33-36`) 声称缺失"contributes r = 0 **with the full denominator**"，而 `aggregate` **只遍历 `tr.rewards`**（`:110-112`），`tr.missing` 只计数（`:114`）；`TaskResult.rewards` 的字段注释(`:53`) 写 "one per trial, **missing trials -> 0.0**"——即**领域 scorer 的义务**。→ **上游本身就存在"注释描述义务、代码不实现"的缺口。**

## 10. 历史与归因（`history.py`，全文）

docstring `:30-34` 给出 `L_t`/`T_t`/`g_t`/`U_t`/`σ_t`/`B_t` 的公式。要点：

- **一条记录 = 一条 edit**（docstring `:36-38`、`append_candidate:83`），带 `t`（轮）与 `variant`（`:84-85`）。
- **`ΔS`/`ΔC` 按测量时刻写入记录**（`:91-92`），`yield_g` 直接读回（`:143-150`）→ **冻结**。
- `incumbent_component_counts` = 各组件**已接受**编辑数（读记录 `accepted` 标记，`:129-141`）。
- `prune_set` 带**要移除的具体已接受编辑**（`:152-163`）。
- `measured()` 要求 `delta_S is not None` **且** `component in K`（`:113-115`）；未测量的不进 `T_t`/`g_t`。
- `stall_flag(traj, t, w, δ) = 1[S_t − S_{t−w} <= δ]`（`:189-193`）。
- `exploration` 的文案明确 **`m_draft` 个候选槽被保留**给未试组件，"持有保留槽的变体必须把至少一条 edit 放在那些组件上"（`:196-211`）。
- `render(n=40)`：给 proposer 的视图，**未测量记录只保留最近 4 条**（"a wall of aborts is a feedback loop, not evidence"，`:166-185`）。
- 历史是**自写 JSONL**；`replace_round` 重写文件丢弃该轮 per-edit 记录（重裁用，`:101-106`）。
- `baseline` 也写一条 `BASELINE` 记录（`loop.py:201-204`）。

## 11. 噪声带（`calibrate.py`，读过 :28-119）

`δ = z·sd(null ΔS)`，`z = cfg.delta_z`，默认 2.0 → "an unchanged harness clears the floor about 97.5% of the time"（docstring `:36-40`）。≥2 次基线评估 → 直接观测 `sd_null = stdev(scores)·√2`（`:89-94`）；单次 k-trial 评估 → 每任务内 bootstrap 重采样 trials（尊重权重，`seed=7`，`reps=2000`），`sd_boot = √2·se·√(k_pooled/k)`（`:54-68,100-101`）；`sd_use = sd_null if (≥2 and sd_null>0) else sd_boot`（`:103`）。**k=1 单次评估时 bootstrap 的 pstdev 为 0 → δ=0**。允许配置固定 δ（`loop.py:102-107`，缺则 `SystemExit("no noise band")`）。

## 12. 重新裁决（`loop.py:348-420`）——冻结口径的直接证据

docstring `:349-353`：**"No new evaluation is spent: every candidate keeps the (S', C') it was measured at against the incumbent H_t it was drafted from."**

- `S_star = max(x["S"] for x in fr["trajectory"][:t + 1])`（`:363`）——**S\* 是"轮 0..t 已接受 head"的最大值**。
- 逐变体 `EvalResult.load(vdir/"eval.json")`（`:374-376`）——用存储测量，不重跑。
- `counts` 只算 **`t < 本轮`** 的已接受记录（`:381-384`）。
- winner 必须 **descend from `H_t`**（`git merge-base --is-ancestor`，`:403-406`）。
- 无 winner → `update-ref` 回 `H_t`，`S_star` 不变（`:414-420`）。

## 13. 我此前说错了什么

| # | 我此前的说法 | 实际 | 性质 |
|---|---|---|---|
| 1 | 蓝图 §2.3「**每轮 k 个候选** → argmax」 | **每轮 `cfg.m` 个候选**（`:292`）；`k` 是每任务 trial 数；`config.py:60-61` 两者默认都是 2 | **符号错误**（review 的 R01 指出过，我没改正文） |
| 2 | 「缺 `analyst.py`/`digester.py`」 | 缺的是**整条证据管线**：选轨迹 → 只读 digester → 三镜报告 → 跨轮累积 → scoreboard → proposer 上下文；另有 `constitution`、每轮 `directives.json`/`decisions.json`、每变体 `proposal.json`/`critique`/`smoke.json`/`prep.json`/`eval.json`、`harness_tree` 与 winner 后代不变量 | **严重过浅** |
| 3 | F1 设计「两条编辑 → novelty 2」 | `set()` 去重 → **1** | **错** |
| 4 | （在诊断里）「端口的缺失分母处理是错的」 | **上游 docstring 与代码就不一致**，端口忠实复制 | **措辞不准** |
| 5 | 蓝图称 `K` 与端口词表"不同" | 具体 **9 vs 5**，且轴不同（harness 组件 + diff 回退分类 vs 资产类别） | 方向对、细节缺失 |
| 6 | 我完全没提的一层 | **归因 scoreboard**（`predicted_affected` 命中率 + `unpredicted_regressions`，最近 20 行回喂）与**测量前四道具名门**（`no_proposal`/`critic_reject`/`smoke_fail`/`eval_invalid`） | **漏项** |

## 14. 对阶段 E 的直接影响

1. **分离三个量**：轮 `t` / 每轮候选 `m` / 每任务 trial `k`。端口用候选序号充当 round、用 history entry 数充当 round——**都要改成显式轮次**。
2. **每轮选择依据冻结成一份记录**：incumbent、候选集、`b_t`/`σ_t`/`T_t`/`U_t`/`B_t`、`δ`、`S*`、历史截止（上游 = `directives.json` + `decisions.json`）。
3. **一条 edit 一条 history 记录**；`ΔS`/`ΔC` 在测量时刻冻结，**收益归因不得按新 head 重算**。
4. **`novelty` 的输入是"已接受编辑的组件计数"**，来自冻结记录的 `accepted` 标记，且**只算本轮之前**。
5. **`S*` 只在有 winner 时抬高**，且是已接受 head 轨迹的最大值。
6. **保留槽必须机械约束候选生产**（上游在 `done()` 回弹 **且** 在 critic 后按 **diff** 再验一次）。
7. **`prune_set` 要带"要移除的具体编辑"**。
8. **需要一个 analyst 阶段**（三镜：失败模式/能力缺口/成功习惯）+ **只读 digester 子代理**，否则 proposer 读不到上游给它的证据；并要**跨轮累积模式名**以稳定命名。
9. **需要归因 scoreboard**：每条编辑的 `predicted_affected` 被核对命中率，`unpredicted_regressions` 抓侧效应。
10. **测量前要有具名门链**：proposer 完成 → critic（确定性预检 + 意图审查，六条理由）→ **按 diff 重新打标签** → commit → liveness smoke；被筛掉的候选有具名归因且不进 `T_t`/`g_t`。
11. **`critic` 与 `smoke` 分工要照上游**：critic 只审意图/内容（明说不管运行期正确性），smoke 管"能不能跑起来"，且 smoke **不是选择规则**（`loop.py:562`）。
12. **`ΔC` 未知时上游放行（0.0）**，端口改为拒绝——这是**有意的收紧**，应作为显式策略与测试保留。
