# RRSI 上游源码对照（逐条带行号）

- 上游：[google-research/rrsi](https://github.com/google-research/rrsi) @ `be50316`，本地 `/home/ROXY/code/rrsi`
- 目的：阶段 E（RRSI 闭环）要照着上游接，所以对照必须是**读过代码的**，不能是读 README 推的
- 本文只有两类陈述：**我本人读到的行**、以及明确标注为**未读**的范围

---

## 0. 我读了什么、没读什么

**读了（逐行）**：`selection.py`(137) `components.py`(108) `evaluate.py`(135) `schedule.py`(54) `history.py`(211) `calibrate.py`(119，跳过版权头从 :28 起) `domain.py` 的接口清单 `loop.py` 的 `round()`(:230-346) 与 `readjudicate()`(:348-420)。

**没读**：`propose.py`(410) `analyst.py`(204) `digester.py`(221) `critic.py`(147) `driver.py`(99) `config.py`(97) `gitops.py`(126) `llm.py`(124)，以及 `loop.py` 的 :1-229 与 :420-605。**约 1400 行未读**，下述结论不覆盖它们。

---

## 1. 轮次结构（`loop.py:231-346`，我逐行读过）

```python
def round(self, t):
    fr = self.frontier(); inc = fr["incumbent"]        # :233-234 一个 incumbent
    if inc["harness_tree"] != self.harness_tree(...): raise   # :235-237 incumbent 是一个 commit
    delta = self.delta()                               # :241 噪声带，每轮取一次

    # 1) F_t <- Analyze(H_t, D_evolve)                 # :249-268 真实的 analyst 阶段
    traces = self.build_traces(inc["job"], inc_ev.per_task)
    report = analyze(d, traces, inc_ev.per_task, rdir,
                     prior_modes=prior.get("failure_modes"),
                     prior_habits=prior.get("success_habits"), model=cfg.analyst_model)
    self.global_analysis.write_text(...)               # :265-267 跨轮累积

    # 2-3) b_t, sigma_t, T_t, U_t, E_t, B_t            # :273-288
    budget = edit_budget(t, cfg.T, cfg.b_min, cfg.b_max)
    traj  = [x["S"] for x in fr["trajectory"]]
    sigma = stall_flag(traj, t, cfg.w, delta)
    tried = self.history.tried()
    explore = exploration(t, sigma, tried, cfg.m_draft)
    prune = self.history.prune_set(t, cfg.n_prune)
    (rdir / "directives.json").write_text({... "b_t","sigma_t","tried","explore","prune_set","delta","S_star" ...})

    # 4) draw and screen m candidates                   # :290-297
    for v in range(cfg.m):
        reserved = bool(sigma and explore["untried"] and v >= cfg.m - cfg.m_draft)

    # 5) evaluate the screened set, in parallel         # :299-302
    live = [c for c in cands if c.gate_failure is None]
    with ThreadPoolExecutor(max_workers=cfg.eval_parallel) as ex:
        list(ex.map(lambda c: self._evaluate(t, c, rdir, ids), live))

    # 6) Algorithm 2                                    # :304-325
    counts = self.history.incumbent_component_counts()
    winner, decisions = select_round(cands, inc_ev, fr["S_star"], delta, cfg, counts, guard_fn=d.guards)
    outcome = "ACCEPTED" if c is winner else ("LOST" if dec.admissible else "REJECTED")
    self.history.append_candidate(t, c.variant, c.edits, outcome, dec.delta_S, dec.delta_C, c is winner, ...)
    self.attribute(t, c.variant, c.edits, inc_ev, c.ev)

    # 7) H_{t+1}                                        # :327-346
    if winner is not None:
        G.fast_forward(...); fr["S_star"] = max(fr["S_star"], new_S)     # :335 S* 在 if 内
    else:
        new_S, new_C = inc_ev.S, inc_ev.C                                # :339 H_{t+1} = H_t
    for c in cands: G.worktree_remove(...)                                # :345-346
```

**读出来的关键事实**：

| # | 事实 | 行 |
|---|---|---|
| 1 | **每轮 `cfg.m` 个候选**（标签 A..H），**每任务 `k` 次 trial**——`m` 与 `k` 是两件事 | `:292`、`VARIANT_LABELS`(:68)、`evaluate.py:104` |
| 2 | 候选**从同一个 incumbent 起草**（同一 `inc_ev`），**并行评估**，**轮末统一选优** | `:295-297`、`:301-302`、`:306` |
| 3 | 保留探索槽是**机械**的：`v >= cfg.m - cfg.m_draft` 的变体拿保留槽 | `:294` |
| 4 | **每轮有一个真实的 analyst 阶段**：从 traces 产出 `failure_modes`/`success_habits`，并**跨轮累积**到 `global_analysis` | `:249-268` |
| 5 | 每轮落盘 `directives.json`（b_t/σ_t/tried/explore/prune/delta/S_star）与 `decisions.json`；每个变体落 `prep.json`/`eval.json` | `:285-288`、`:308-309`、`:370-378` |
| 6 | **`S* = max(S*, S_{t+1})` 在 `if winner is not None:` 之内**——被拒候选永不抬高 S* | `:335` |
| 7 | 无合格候选 → `H_{t+1} = H_t`，S* 不变 | `:338-340` |
| 8 | 有 `attribute(...)` 阶段（逐候选归因） | `:323` |
| 9 | `d.constitution(repo)` 给 proposer 一份 constitution（SKILL.md + PATTERNS.md） | `:282`、`domain.py:109` |
| 10 | `d.guards(incumbent, candidate)` **吃双侧**，返回违规串列表 | `domain.py:78`、`loop.py:307` |

## 2. 选择（`selection.py`，全文读过）

docstring(:28-39) 给出算法 2：

```
Delta S = S' - S_t,   Delta C = (C' - C_t) / C_t
c = [Delta C <= beta0 + beta1 Delta S]            if Delta S > delta
    [w_s Delta S - w_c Delta C + w_n nu(l') > 0]  otherwise
admissible iff S' >= S* - delta and c (and every domain guard holds)
H_{t+1} = argmax_{H' admissible} S',  or H_t if none
S*      = max(S*, S_{t+1})
```

| # | 事实 | 行 |
|---|---|---|
| 1 | 带内分支**含 novelty 项**：`shaped = w_s·ΔS − w_c·ΔC + w_n·ν` | `:90` |
| 2 | 增益分支用 `β0 + β1·ΔS` 作成本预算（**无上界**） | `:84-86` |
| 3 | 准入顺序：先噪声底线 `S' >= S* − δ`，再成本规则，再 guards | `:107-118` |
| 4 | `argmax` 只在 admissible 内取；无则返回 `None`（保留 incumbent） | `:133-136` |
| 5 | `relative_cost_change` 在**任一侧成本未知时返回 0.0**（静默放行） | `evaluate.py:131-135` |
| 6 | 同分时 `max` 取**迭代序第一个**（隐式确定性 tie-break） | `:136` |
| 7 | `Candidate.gate_failure ∈ {critic_reject, smoke_fail, eval_invalid}`——评估前有 critic+smoke 门 | `:57` |

## 3. 机制词表与 novelty（`components.py`，全文读过）

| # | 事实 | 行 |
|---|---|---|
| 1 | `K = [prompt, control_flow, config, output_plumbing, context_mgmt, client_tool, skill, memory, subagent]`（**9 个**） | `:44-45` |
| 2 | `K_STR = [client_tool, skill, memory, subagent]` | `:46` |
| 3 | `novelty = sum(1 for c in set(edit_components) if c in K_STR and incumbent_counts.get(c,0) == 0)` | `:103-108` |
| 4 | **`set()` 去重** → 两条同机制编辑的 novelty 仍是 1 | `:107` |
| 5 | **声明标签必须有 diff 证据**才保留（`has_evidence`），否则**回退按 diff 正则分类**（`classify_diff`，默认 `prompt`） | `:82-100` |
| 6 | 回退信号是**文件名/正则信号**（`memory`/`skill`/`client_tool`/`subagent` 各一组） | `:49-55` |
| 7 | 纯字符串/注释改动一律归 `prompt`（`text_only`） | `:58-79` |
| 8 | docstring 明说理由：proposer 可以**声明一个没交付的机制**，或把控制流改动**改标成未试组件以占探索槽**，未核验的标签会污染 `T_t`/`U_t`/novelty | `:85-88` |

## 4. 退火编辑预算（`schedule.py`，全文读过）

`b_t = ceil(round(b_min + (b_max − b_min)·½(1 + cos(πt/T)), 9))`，`t` 被 clamp 到 `[0,T]`，`T<=0 → b_max`（`:43-50`）；`budget_table` 用 `range(T)`（`:53-54`）。
→ **上游用 `/T`，所以 `budget_table(T)[-1]` 拿不到 `b_min`**；只有越界的 `t=T` 才到。端口改成 `/ (rounds−1)`。✅ 旧端口 README 的记载准确。

## 5. 评估（`evaluate.py`，全文读过）

`S_hat = Σ r·w / Σ w`，`C_hat = mean(tokens>0)`（`:104-119`）。

**这里的 docstring 与代码不一致**（重要）：
- 模块 docstring(:33-36) 写"a missing trial contributes r = 0 **with the full denominator**"；
- 但 `aggregate` **只遍历 `tr.rewards`**（`:110-112`），`tr.missing` 只被累加进计数（`:114`），**从不进入 `num`/`den`**；
- `TaskResult.rewards` 的字段注释(:53) 写 "one per trial, **missing trials -> 0.0**"——即**领域 scorer 有义务把缺失物化成 0 分观测**；`n_expected = len(per_task)·k`（`:118`）另行记录。

→ 所以 E12 的准确定性是：**上游本身就存在"注释描述调用方义务、代码不实现"的缺口**，旧端口是忠实复制它。既不是端口的独创缺陷（我此前的说法），也不是 pipeline 可见的分母 bug（review 的措辞偏重）。

## 6. 历史（`history.py`，全文读过）

docstring(:30-34)：

```
L_t = {(t_i, l_i, h_i, d_i, ΔS_i, ΔC_i, a_i) : i <= n_t}
T_t = {l_i : i <= n_t}
g_t(l) = max{ΔS_i : l_i = l, t − t_i <= n_prune},  max(empty) = −inf
U_t = K \ T_t,  σ_t = 1[S_t − S_{t−w} <= δ]
B_t = {l in T_t : g_t(l) <= 0}
```

| # | 事实 | 行 |
|---|---|---|
| 1 | **一条记录 = 一条 edit**；一个 bundle 的 n 条 edit 各拿同一次测量 | docstring `:36-38`、`append_candidate:83` |
| 2 | **每个候选记录带 `t`（轮）与 `variant`，不是候选序号充当轮** | `:84-85` |
| 3 | **`delta_S`/`delta_C` 按测量时刻写入记录** | `:91-92` |
| 4 | `yield_g` 直接读**记录里的** `delta_S`，不按今天的 head 重算 | `:143-150` |
| 5 | `incumbent_component_counts` = 各组件**已接受**编辑数（读记录的 `accepted` 标记） | `:129-141` |
| 6 | `prune_set` 不只给组件名，还带**要移除的具体已接受编辑** | `:152-163` |
| 7 | `measured()` 要求 `delta_S is not None` **且** `component in K` | `:113-115` |
| 8 | 未测量的（critic/module 拒绝、smoke 失败、eval 无效）记 `delta_S=None`，**不进 `T_t`/`g_t`** | docstring `:39-40` |
| 9 | `stall_flag(traj, t, w, δ) = 1[S_t − S_{t−w} <= δ]`，轮数不足 w 时 0 | `:189-193` |
| 10 | `exploration` 的 stall 文案：**`m_draft` 个候选槽被保留**给未试组件，"持有保留槽的变体必须把至少一条 edit 放在那些组件上" | `:196-211` |
| 11 | `render(n=40)`：给 proposer 的最近记录视图，**未测量记录只保留最近 4 条**（"a wall of aborts is a feedback loop, not evidence"） | `:166-185` |
| 12 | 历史是**自写 JSONL**，`replace_round` 会重写文件丢弃该轮的 per-edit 记录（重新裁决用） | `:60-106` |

## 7. 噪声带（`calibrate.py`，读过 :28-119）

| # | 事实 | 行 |
|---|---|---|
| 1 | `delta = z · sd(null ΔS)`，`z = cfg.delta_z`，默认 **2.0** → "an unchanged harness clears the floor about 97.5% of the time" | docstring `:36-40`、`:104` |
| 2 | ≥2 次基线评估 → **直接观测** `sd_null = stdev(scores)·√2` | `:89-94` |
| 3 | 单次 k-trial 评估 → **bootstrap** 每个任务内重采样 trials（尊重权重，`seed=7`，`reps=2000`），`sd_boot = √2·se·√(k_pooled/k)` | `:54-68`、`:100-101` |
| 4 | `sd_use = sd_null if (≥2 evals and sd_null>0) else sd_boot` | `:103` |
| 5 | **k=1 且单次评估时 `bootstrap_se` 的 pstdev 为 0 → δ=0**；端口因此加了下限 | `:68`、`:103` |
| 6 | 允许**配置固定 δ**（`read_delta`，`drivers` 里可覆盖） | `:115-119`、README:53 |

## 8. 重新裁决（`loop.py:348-420`）——冻结口径的直接证据

docstring `:349-353`：**"Re-run Algorithm 2 on the STORED measurements of round t … No new evaluation is spent: every candidate keeps the (S', C') it was measured at against the incumbent H_t it was drafted from."**

| # | 事实 | 行 |
|---|---|---|
| 1 | `S_star = max(x["S"] for x in fr["trajectory"][:t + 1])`——**S\* 是"轮次 0..t 已接受 head"的最大值** | `:363` |
| 2 | 逐变体 `EvalResult.load(vdir / "eval.json")`——**用存储的测量**，不重跑 | `:374-376` |
| 3 | `counts` 重建为**只算 `t < 本轮` 的已接受记录** | `:381-384` |
| 4 | winner 必须 **descend from `H_t`**（`git merge-base --is-ancestor`），否则 `SystemExit` | `:403-406` |
| 5 | 无 winner → `update-ref` 回到 `H_t`，`S_star` 不变 | `:414-420` |

---

## 9. 因此：我此前说错了什么

| # | 我此前的说法 | 实际 | 性质 |
|---|---|---|---|
| 1 | 蓝图 §2.3「**每轮 k 个候选** → argmax 选优」 | **每轮 `cfg.m` 个候选；`k` 是每任务 trial 数** | **符号错误**（review 的 R01 已指出，我当时没改蓝图） |
| 2 | 蓝图 §2.3 把缺失项列成"`analyst.py`/`digester.py` 缺失" | 缺失的是**一整条证据管线**：analyze（含跨轮累积的 `global_analysis`）→ directives → propose → critic/smoke 门 → 并行评估 → `attribute` → history；另有 `constitution`（SKILL.md+PATTERNS.md）、每轮 `directives.json`/`decisions.json`、每变体 `prep.json`/`eval.json`、`harness_tree` 与 commit 后代不变量 | **描述过浅** |
| 3 | F1 设计里"两条编辑 → novelty 2" | `set()` 去重 → **1**；两条**不同**结构机制才是 2 | **错**（复核子代理已指出，现由我读码确认） |
| 4 | 我引用 review 说端口"用候选 index 充当 round" | 上游记录的是 `t`（轮）+ `variant`，且**一条记录一条 edit** | 转述正确，现已自证 |
| 5 | 我（在诊断里）说端口"缺失分母处理是错的" | **上游 docstring 与代码就不一致**（§5），端口是忠实复制 | **我的措辞不准**；准确说法是"上游即有的注释/契约缺口" |
| 6 | 蓝图称 `K` 与端口词表"不同" | 具体是 **9 vs 5**，且轴不同：上游按**harness 组件**（带 diff 回退分类），端口按**资产类别** | 方向对，细节缺失 |

## 10. 对阶段 E 的直接影响

1. **先分离三个量**：轮次 `t` / 每轮候选 `m` / 每任务 trial `k`。端口的 `historyFactsOf` 用候选序号充当 round、`decision` 用 history entry 数充当 round——**都要改成显式轮次**。
2. **选择事实必须冻结**：每轮的 incumbent、候选集合、`b_t`/`σ_t`/`T_t`/`U_t`/`B_t`、`δ`、`S*`、历史截止范围，落成一份 per-round 记录（上游是 `directives.json` + `decisions.json`）。
3. **每轮一条 candidate 记录，每条 edit 一条 history 记录**，`ΔS`/`ΔC` 在测量时刻冻结；**收益归因不得按新 head 重算**。
4. **`novelty` 的输入是"已接受编辑的组件计数"**，来自冻结记录的 `accepted` 标记，且**只算本轮之前**。
5. **`S*` 只在有 winner 时抬高**，且是"已接受 head 的轨迹最大值"。
6. **保留探索槽要机械约束候选生产**，不能只在提示词里说。
7. **`prune_set` 要带"要移除的具体编辑"**，不是只有组件名。
8. **需要一个 analyst 阶段**（失败模式/成功习惯，跨轮累积），否则 proposer 读不到上游给它的那份证据——这正是端口缺的那一环。
