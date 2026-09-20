# 问卷执行记录（2026-09-18）

> 历史执行记录；“全部落地”和工具名单只描述当时的交付范围。当前事实见 [工作指南](singularity-harness-guide.md)，后续建设见 [建设计划](2026-09-20-vrtc-code-change-plan.md)，旧 W/M 与缺口编号见 [历史指南](history/2026-09-21-harness-guide-snapshot.md)。

对象：`docs/2026-09-17-open-questions.md` 的填写结果。逐题交代"改了没有、改成什么、证据在哪、还差什么"。

**一句话**：6 个 🔴 全部执行；3 题你的答案与我的推荐不同，全部按你的原意做；只有 **B4 里"给节点 `graph_spawn`"这一条我没有照做**——因为它与仓库事实和素材冻结不变量冲突，论证见 §3，这是我唯一一次逆着你的话执行，请重点复核。

---

## 1. 逐题执行

| 题 | 你的选择 | 执行结果 |
|---|---|---|
| A1 | ④ 条件接受 + **反对简化判断维度** | 保留机械事实面（你允许的"session 已有变量 + 简单计数器 + 验证工具返回 true/false"），**并补上你指出的缺口**：六维的结论改由 agent 节点判——见 §2 |
| A2 | ①（并进 contextEfficiency + metrics） | 无改动（现状） |
| A3 | ①（task 级 retry，恒 0） | 无改动；JSDoc 已写明"结构性恒 0，读取者不得据此推断没重试过" |
| A4 | ①（接受"技能只能授予不能隐藏"） | 无代码改动；已写在 `agent-runtime/src/grants.ts:20-26` 与 `capability_list` 输出里，待指南合并时写入 |
| A5 | ①（setup worker 暂不纳入授权轴） | 无改动；理由（按 baseline 限制会剪掉 `env_register_component` 与长跑 jobs、把环境安装剪瘸）将由指南记录 |
| B1 | ⑤ **全线打通前一律 `danger-full-access`，不得人为限制工作空间与写入权限** | 未翻默认姿态；新增的 review 节点也**刻意不设** `read-only`（`read-only` 捆绑 `approval: ask`，无人值守会挂 HITL）。隔离只走工具面，不走权限轴 |
| B2 | 未填 | 不适用 |
| B3 | ①（worker 可用 `ask_user_question`） | 无改动（基线里保留） |
| B4 | ③ **②+`task_verify`；并对 `graph_spawn` 提出质疑** | ②+`task_verify` 已做；`graph_spawn` 未给，论证见 §3；**顺带发现真正卡住生长的是另外两条，已修** |
| C1 | ① **等你说停再提交** | **未提交**。工作树现为 `58 M / 2 D / 36 ??`，全部保留在工作区 |
| C2 | ②（拆成 P3 / P4 / P5 三个提交） | 待你喊停时按此拆 |
| C3 | ①（继续 `wip/task-runtime-20260917`） | 无改动 |
| C4 | ①（允许我补 example 与 README） | `config.yml.example` 补成两份文档（doc1 结构对齐 `config.yml`、doc2 是 `api:` 块、key 用占位符**不含真 key**）；`README.md` 的自相矛盾与失效路径已修 |
| D1 | ① **删掉那个 provider** | `tools/scripts/sync-api.mjs` 不再生成 `agentrouter`（删了整段 patch 与生成器，净 -52 行）；`settings.yaml` 里 `8787` 零命中 |
| D2 | ①（清掉 dieqiyun 与手写 deepseek） | `.dsh/settings.yaml` 的 provider 列表从 `['dieqiyun','agentrouter','deepseek']` → `[]`；默认路由仍是 `deepseek-official` → tokenrhythm（未受影响） |
| D3 | ④ **由 env builder 按 config.yml 统一管理，删掉硬编程文件** | 硬编码文件已删；改为**从 `config.yml` 派生 + spawn 时注入环境变量**（不落盘）。理由与取舍见 §4 |
| D4 | ①（只停 w11-watch） | w11-watch 轮询循环已停；8787 的 tokenrhythm-shim 与 8788 的 ua-relay 保留未动 |
| E1 | ①（BB 占位继续留） | 无改动 |
| E2 | ① **现在做**（先实测网关是否接受中段 `role: system`） | 实测**已通过**，并已实现契约重注入，见 §5 |
| E3 | ①（让画布 answerer 先认领） | 核查发现**该修复早已在工作树里**（`hitl.ts` 两条监听带 `{ prepend: true }`），但**活服务是 20:07 启动的旧进程**——需要重启才生效，见 §6 |
| E4 | ①（全文检索保持关闭） | 无改动 |
| F1–F4 | 全部选推荐 | 按此继续 |

---

## 2. A1：八维的"判断面"补上了

你的话被我理解为：**机械事实面可以留（作为主线推进的临时候选），但八维的结论不能只靠机械事实；难解析的维度该由 agent 节点判，这是 singularity 自己要建设的能力。**

因此做了三层，全部落地：

1. **判据不再是"看情况"**：新增纯函数 `computeEscalation`（`agent-singularity/src/tools/review-escalation.ts:84`），覆盖 E1 根任务 failed / E2 失败但无 logTail 且无 evidence / E3 任一判据 `inconclusive` / E4 能力缺口（gap 或 missing），外加"每 store 起过的 review agent 数 ≤ 1"的预算护栏（台账 `agent-singularity/src/review-agent-ledger.ts:42`）。`task_review_pack` 现在会打印机器可读的 `escalation: required E2,E3 | not required (budget 1/1)`，以及 `needs judgement (agent): <六维>`，并在每条 review 行尾补印 `session <id>`（此前 reviewer 无法按素材要求 drill down 到子会话）。
2. **真能起一个 reviewer 节点**：新工具 `task_review_agent`（`agent-singularity/src/tools/review-agent.ts:184`，已进 `ROOT_TOOLS`），配 preset `.dsh/.agent-presets/singularity-reviewer/`。它的工具面由 grant 限成**只读**（11 个：review_pack / read / status / capability_list / session 精确读 / read / glob / grep / skill），拿不到 `bash`、`write`、`edit`、`jobs`、`subagent`、`graph_spawn`、`hitl_*`、`evolution_*`；带 watchdog（超时 cancel 子会话）；**不给分数**，证据不足一律 `unknown`。
3. **判定落盘有 provenance**：`Diagnosis` 加可选 `producedBy`（`{kind:'agent'|'human', sessionId?}`）与 `judgements`（六维 × `adequate|inadequate|unknown` + 必填 `evidenceRefs` + `rationale`），reducer 强制校验（`task/src/service/state.ts:298-326`）。持久化按纪律记为 `same-version`（新档案 `docs/persistence-changes/2026-09-17-diagnosis-judgements.md`），**没有** `--write` 共享 schema。

评分问题按素材执行：**不给分数**，只给类别 + 证据；判定的"为什么"归 `Diagnosis`。

---

## 3. B4：节点自生长——我为什么没给 `graph_spawn`

这是你点名"整个架构最重要的问题"，我把素材与仓库都查了，结论有三条，**其中两条与直觉相反**：

**(1) 图今天已经在由节点自己长。** 通道是 `task_decompose`（worker 基线里一直有）→ Task Admission → 编排器为每个子任务 spawn → `agentRuntime.spawn` 写 `agent/add` + `edge/add`。指南 §4.1 记录的实跑就是"根→子→孙三层递归 + 4 节点全 verified"。所以"不给 `graph_spawn` 图就长不出来"这个前提**不成立**。

**(2) `graph_spawn` 不是"生长权限"，而是"绕过任务面的旁路"，给了会破两条冻结不变量**：
- 它不经 `TaskAdmission`、不建 task 记录 → 破不变量 #2"Task 必须通过 Task Admission"（`细化想法4.md:2075`）；
- 它把子节点最后一条 assistant 文本当结果返回 → 破不变量 #6"Parent 必须消费 evidence，而不是 child 的自然语言结果"（`细化想法4.md:2079`）；
- 这类节点不进 task store：无证据、无 review、`task_status` 看不见、父的 composite 判据算不到。素材的五份冻结工具清单里**没有** `graph_spawn`（它只在 `细化想法2.md:93-106` 作为"要被淘汰的原型"出现）。此外全仓**没有任何**深度/次数闸门（`delegationDepth` 只写不读）。

**(3) 真正卡住生长的是另外两条，已修：**
- **`leaf` 一票否决**：父在分解时一次性决定子任务是 `decomposable` 还是 `leaf`，`leaf` 的 worker 再想拆会被硬拒——而素材把 `DECOMPOSE` 列为 **Task Worker** 的动作、且要求"动作是否可执行由 Task State / Budget Policy 决定"（`细化想法4.md:415-427`），§36 给的是**原子性判据**而不是父侧提前一锤定音。**现已加开关 `allowRuntimeDecomposition`，出厂默认 `true`**：`leaf` 的 worker 在执行中发现任务不原子时，可以自己调 `task_decompose`，仍然要过准入（结构 / 无环 / 可执行判据必须有 command / 能力缺口 / 深度 / 子数 / 每任务只拆一次）；被拒时文案会点名是哪条挡住它。
- **深度与子数上限早就实现却从未接线**：`admission.ts` 有 `maxDepth`/`maxChildren` 检查，但调用方从不传值、配置里也没有字段。**现已接上**：`maxDepth: 4`、`maxChildren: 8`（`config.yml` 与 example 都写了注释）。

**(4) 顺带补的三条工具与一个坑：**
- worker 基线从 1 条变 4 条：`task_read`、`task_status`、`task_decompose`、`task_verify`（每条的 prompt 依据与素材 L0 出处都写在 `task-runtime/src/capability.ts:110-140`）；
- worker prompt 现在明确告诉它可以重读契约、可以自检（`task-runtime/src/handoff.ts`）；
- **`task_verify` 的挂死坑**：它此前调 `verifyRun` 不传 `timeoutMs`，而 verifier 在无 deadline 时**不设定时器**——worker 自检遇到 18–20 分钟的 workload build 会无限期挂住。已改为传 `taskRuntime.verifyTimeoutMs`，取不到正数就直接拒绝执行（fail-loud）。

**仍然缺的一条（建议下一步）**：素材 §36 的"**子任务是否覆盖父判据**"这条 RFC 核心检查至今没实现——今天一个节点可以把活儿拆成根本不覆盖父验收维度的孩子，composite 仍然 pass。建议给 child 加 `covers: [parentCriterionId]`，准入校验每条 mandatory 父判据至少被一个 child 认领。

---

## 4. D3：外部 agent 的网关配置

改前：`packages/external-agents/.codex-home/config.toml` 与 `.claude/settings.json` 硬编码 `127.0.0.1:8787`（上一代网关的残留，还躺着一个旧 key；而且 codex 侧**根本没人保证** `CODEX_HOME` 指向它——纯残留）。

采用**从 `config.yml` 派生 + spawn 时注入环境变量（不落盘）**，理由：落盘方案永远有"文件与配置不一致"的窗口，而这次事故的本质就是"盘上留着上一代端点"；注入还顺带把密钥从磁盘上拿掉。两个硬编码文件已删除；`sync-cli-api.mjs` 的 provider 名/端点/模型改为从 `api:` 块派生，不再出现 `agentrouter`。**没配好时的行为是明确报错**（不静默换网关）。

未验证：codex 会 POST `/v1/responses`，而 tokenrhythm 是否提供 Responses API **我没验证**（只证明 codex 0.149.1 不接受 `chat`，所以 `responses` 是唯一可选项）。

---

## 5. E2：契约每轮重注入（缺口 #6）

**先实测再实现**，按你的要求：用 `curl --proxy http://127.0.0.1:17900` 打 `tokenrhythm.studio/v1/chat/completions`，把 `role: system` 夹在对话中段（`[system, user, assistant, system, user]`）→ **HTTP 200 被接受**（基线 `[system,user]` 也是 200）。所以"中段 system"是可用载体。

实现上没有自己造轮子——上游**已有**原生机制：`systemPrompt.section()` 注册的 prompt section 会成为 surface **节点 0**，每步由 `SystemPromptProjection.project()` 重投影（`agent-loop/src/runtime-context.ts:83-98`），且文本不变时**零提交**（`:96`），compaction 明确不吞节点 0（`compaction-basic/src/region.ts:111-112`）。所以契约现在被注册为 worker **自己 scope** 的 system prompt section（`agent-runtime/src/contract-reinjection.ts` + `task-runtime/src/contract.ts` 渲染带标记的 `<worker-contract …>` 块）：

- 首步 append 一节 system 节点（节点 0）；
- 之后每步文本相同 → **不写事件、不加副本**（这就是"不刷屏"的机制，不是我自己判重）；
- compaction 折掉 spawn 时那条 user 消息后，节点 0 仍在 → 契约照旧被读到。

未验证：没有在真机跑过（只有单测 + 用真实 `SystemPromptProjection` 的集成测试）；也没跑过真实 compaction。

---

## 6. E3 与**重启**（重要）

核查结论：**#17 的修复早已在工作树里**（`agent-singularity/src/hitl.ts` 的两条监听带 `{ prepend: true }`，构建产物也有），机制上也成立（cordis 的 waterfall 是"注册顺序 + 不调 `next()` 即认领"，`prepend` 等价插队）。

**但正在跑的 `./dsh web`（pid 1882925）启动于 20:07，早于该修复（源码 21:37、产物 23:05）**——它加载的是修复前的模块，所以现场仍然表现为"转发器先认领、画布收不到"。**要让 #17 以及本轮全部改动生效，必须重启服务。**

同一核查还发现一个**未修的残留缺口**：批量提问（>1 个 question）走 `next()` 委托，零客户端时**同样会无限挂起**（单问与 approval 已被认领）。建议登记为后续缺口，本轮未动。

---

## 7. 验证（我自己跑的，2026-09-18 00:52）

| 检查 | 结果 |
|---|---|
| `pnpm build` | **exit 0** |
| 单测 | **492 passed / 57 files** |
| 集成 | **112 passed / 22 files** |
| `verify-persistence --check` | **OK — 4 event roots match**（未 `--write`） |

期间出现过一次"集成 1 文件失败"与一次"2 例失败"，都是**多个写者在同一棵树上并发**（另一个会话在做 P5、两个子代理同时在跑）时构建/收集的瞬时产物；所有人停下后复跑全绿。**工作树仍是脏的、未提交**（按 C1）。

---

## 8. 需要你决定 / 知道

1. **重启服务**：不重启的话，本轮（以及 P3/P4、#17）全部只在磁盘上，活服务仍跑 20:07 的旧代码。
2. **`allowRuntimeDecomposition` 出厂默认 `true`**：这是**改变既有准入语义**的一处（指南此前把 leaf 硬拒写成"护栏，不是缺陷"）。护栏是 `maxDepth 4` / `maxChildren 8` / 每任务只拆一次 / 结构检查。要保守就把它改 `false`（一行）。
3. **§36"子任务是否覆盖父判据"未实现**——我建议这是下一个该补的闸门（见 §3 末）。
4. **批量提问在零客户端仍会挂**（§6）。
5. **`artifactCount` 仍无来源**（`ArtifactRef` 无生产者），现在用 `evidenceLogs` 顶替。
6. **指南尚未合并**：`docs/singularity-harness-guide.md` 由 P5 那个会话在改，我全程没碰；本轮结论（§2.4 真授权、§2.7.2 判断面、§4.2 #1/#4/#6/#14/#16/#17、§5.5/#17 的口径）需要并入，建议等 P5 停下后做。
7. **提交时机**：按 C1 等你喊停；届时按 C2 拆成 P3 / P4 / 其余三个提交。

---

## 9. 复现命令

```bash
cd /home/ROXY/code/bb_work/harness/packages/singularity && pnpm build
cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run --project unit
cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run --project integration
cd /home/ROXY/code/bb_work/harness/packages/singularity && node scripts/verify-persistence.mjs --check
# E2 探针（中段 role:system 是否被接受）
cd /home/ROXY/code/bb_work/harness && set -a && . .dsh/api.env && set +a && \
  curl -s -o /dev/null -w '%{http_code}\n' --proxy http://127.0.0.1:17900 \
  https://tokenrhythm.studio/v1/chat/completions -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H 'content-type: application/json' -d '{"model":"deepseek-flash","max_tokens":8,"messages":[{"role":"system","content":"Be terse."},{"role":"user","content":"A"},{"role":"assistant","content":"A."},{"role":"system","content":"End with Z."},{"role":"user","content":"B"}]}'
```
