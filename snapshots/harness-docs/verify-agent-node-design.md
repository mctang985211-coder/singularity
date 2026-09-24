# 本地 verify agent 子节点设计

> **状态（2026-09-18，W21）**：本文是 2026-09-16 时代的设计稿，其"工具全走本地 cordis 注册、不引入 MCP"的结论已被推翻——bbdev 工具面改经 spawn 级 per-env MCP 挂载（`mcp__bbdev__*`，见 `packages/singularity/docs/singularity-harness-guide.md` §4.3 W21 记录与 §5.1），`buckyball_bbdev_*` 插件不再被任何 preset 挂载。下文仅作历史参考。

## 0. 基线与范围

本文回答两件事：singularity 的「节点生长方式」是什么（§1），以及如何把原 CI 验证流程（除留 CI 的 EDA 段）改造成按该方式生长的本地 verify agent 子节点（§2）。

分析基线（引用行号以这些版本为准）：

- singularity：`packages/singularity` 子模块 **origin/main = c94024b**（本次分析已 checkout 该提交，未 commit 任何改动）。注意父仓库 gitlink 当前记录 **3c8443a**，工作副本之前在 f7a83ad，三者不同；落地实现时应先把子模块指针推进到 c94024b 或更新。
- CI 侧：fork 仓库工作副本 `/tmp/bb-slim` 的 `.github/workflows/bb-verify.yml` 与 `.github/scripts/bb-verify/*.sh`（11 个脚本）；harness 侧 `packages/verify-runner`（其 `ci/bb-verify.yml` 与 fork 的 workflow 逐字节相同，已用 `diff` 核实）。
- 深层 harness（cordis 运行时、agent preset 机制）：`thirdparty/deepseek-harness/packages/`。

---

## 1. singularity 的节点生长方式（任务一分析）

### 1.1 节点如何定义/声明：agent preset + graph 节点记录

singularity 里没有单独的「节点 spec」文件格式。一个 agent 节点由两层构成：

**(a) 可复用的 agent 组成 = preset**。preset 是一个目录，含两个文件（以 shipped `standard` 为样板）：

- `preset.yml`：元数据（`name` / `description` / `order`），见 `thirdparty/deepseek-harness/packages/preset/agent-presets/presets/standard/preset.yml:1-3`。
- `agent.cordis.yml`：一份 **cordis 组合（composition）**，逐行声明这个 agent 挂载哪些插件/工具/prompt 段——persona（`presets/standard/agent.cordis.yml:24-29`）、shell/fs/jobs/skill 工具行（`:45-88`）、带 `isolate` realm 的 group（plan-mode `:105-125`、compaction `:138-156`、delegation `:169-234`）。模型不在 preset 里，见 §1.5。

preset 由 `agentPresets.mount` 挂到 agent 的 scope context 下（`agent-presets/src/mount.ts:378-433`），挂载是 per-session 的：组合里的注册项只对挂载它的那个 agent 生效，且发布进程级服务的行会被拒绝（`mount.ts:407-413`）。runtime 侧入口是 `ctx.agentPresets.mount(agentCtx, agentPreset)`，root 与 spawn 两条路径都调它（`packages/singularity/agent-runtime/src/index.ts:120,148,198`）。

**(b) 图上的节点记录 = `AgentNode`**：`{ id: SessionId, name, status }`（`packages/singularity/graph/src/types.ts:6-14`），通过 `GraphEvent`（`agent/add`、`edge/add` 等五种，`graph/src/types.ts:40-45`）提交进 graph store；画布布局另由 layout 服务负责（`agent-runtime/src/index.ts:160,217-221`）。

### 1.2 节点如何「生长」：graph_spawn 工具 → AgentRuntime.spawn

父 agent（root/router）**不直接调 API，而是通过一个模型可见的工具** `graph_spawn` 生长子节点：

- 工具定义：`agent-singularity/src/tools/spawn.ts:6-44`。参数只有两个：`name`（图上显示名）和 `task`（完整任务文本）；description 明确「Delegate one task to a new Singularity worker node and wait for its final response」（`spawn.ts:9`）。该工具由 `SingularityAgent` 服务连同 `graph_mark_ready`、`hitl_ask`、`hitl_approve` 一起注册（`agent-singularity/src/index.ts:25-28`）。
- root 节点被**限制**只能用这四个工具：`ROOT_TOOLS = ['graph_spawn','graph_mark_ready','hitl_ask','hitl_approve']`（`agent-runtime/src/index.ts:20`），在 createRoot/resumeRoot 的 setup 里 `agentCtx.tools.restrict({ allow: ROOT_TOOLS })`（`index.ts:123,151`）。root 的 persona 也写明「connect workers, not implement tasks」（`agent-runtime/src/prompts/root.prompts.ts:2-4`）。
- 工具执行体调 `ctx.agentRuntime.spawn(parent, request)`（`spawn.ts:19-24`），`SpawnRequest = { sessionId, name, prompt: ContentBlock[], agentOptions?, signal? }`（`agent-runtime/src/types.ts:34-40`）。`AgentRuntime.spawn` 的实际路径（`index.ts:181-241`）：
  1. `ctx.agents.create(...)` 建子会话（`index.ts:192-201`）。**prompt 的传递**就是 `SpawnRequest.prompt`，spawn 成功后经 `handle.agent.followup(createUserMessage(...))` 作为子 agent 的首条用户消息注入（`index.ts:228`）。
  2. **工具/preset 的传递**：当前实现里子节点**继承父节点的 preset**——`const agentPreset = parent.session.header.agentPreset!`（`index.ts:191`），再 `agentPresets.mount(agentCtx, agentPreset)`（`index.ts:198`）。子节点**不做** `tools.restrict`，所以它拿到的是 preset 组合的完整工具目录（与 root 的白名单形态不同）。
  3. 权限统一 `danger-full-access`（`index.ts:199`）。
  4. 图登记：一次性 commit `agent/add` + `edge/add { kind: 'spawn', from: parent, to: child }`（`index.ts:209-215`），随后发 `agentRuntime/spawned` 事件（`index.ts:227`）。
- 序列化：同一 graph 上的所有结构变更经 `inGraph()` 串成操作链（`index.ts:298-310`）。

### 1.3 子节点结果如何回流

**回流通道就是 `graph_spawn` 的工具返回值**，不是 canvas-report，也不是 graph edge：

- `spawn.ts:28` 等 `handle.agent.whenIdle()`（父 agent 这次工具调用阻塞到子节点跑完；父 abort 会级联 cancel 子节点，`spawn.ts:25-31`）。
- 然后从子会话事件流里取**最后一条 `assistant/message`**，拼出全部 text block 作为工具结果字符串返回给父 agent（`spawn.ts:33-42`）；子节点没有产出文本则抛错。集成测试 `tests/integration/spawn-tool.spec.ts` 验证的正是这条语义。
- 状态（idle/running/failed 等）经 `ctx.on('agent/status')` 同步进 graph（`index.ts:56-59`），供画布展示；edge 只记录 spawn/handoff 关系（`graph/src/types.ts:4`），不承载结果数据。
- 注意：`packages/singularity/canvas-report/` 目前是**空壳**（只有 node_modules，无 src/package.json），不要把它当作现成的报告通道。

### 1.4 现有最近模板

- 节点组合模板：`presets/standard/agent.cordis.yml`（全功能编码 agent）。verify 子节点的 preset 应以它为骨架裁剪。
- 调用范式模板：root router（rootPromptText + ROOT_TOOLS + graph_spawn）——「父节点只路由、子节点干活」正是 design agent → verify 子节点要的形态。
- verify 子节点要的工具与 playbook 已经以 dsh 插件形式存在：`packages/verify-runner/src/index.ts:119-179`（注册 7 个 `buckyball_bbdev_*` 工具 + 静态 playbook 段 + 事件触发的 next-step prompts）。preset 组合里加一行指向这个插件即可，无需新写工具。

### 1.5 工具与模型的来源机制

- **工具不是 MCP**，是本地 cordis 插件：各 `dsh-tool-*` 包在 apply 时 `ctx.tools.register(defineTool({...}))`（如 verify-runner `src/index.ts:130-136`；singularity 自己的工具 `agent-singularity/src/index.ts:25-28`）。一个节点能用哪些工具 = 它的 preset 组合里有哪些工具行（标准组合示例 `presets/standard/agent.cordis.yml:45-252`），再叠加 `tools.restrict({ allow })` 白名单（root 用法，`index.ts:123`）。
- **模型/思考挡位**：来自 `agentDefaultModel.currentSelection()`，在 create/spawn 时与请求的 `agentOptions` 合并（`index.ts:146`、`:195`：`{ ...currentSelection(), ...request.agentOptions }`）。`AgentOptions = { provider?, model?, reasoningEffort?, maxTokens? }`（`thirdparty/deepseek-harness/packages/core/agent/src/runtime-types.ts:26-35`）。即：默认走部署级选择，单次 spawn 可覆盖。

---

## 2. verify agent 子节点设计（任务二）

### 2.1 节点 spec（全部用 singularity 真实概念）

**新增一个 agent preset `bb-verify`**（目录：`preset.yml` + `agent.cordis.yml`，放 harness 自己的 preset root，作为 user/system root 被 discovery 扫到；机制见 `agent-presets/src/preset.ts:44-69`）。组合骨架：

```yaml
# preset.yml
name: bb-verify
description: Buckyball 验证子节点：消费确定性判定块，经 bbdev 三件套执行验证，输出 VERDICT + report.md
order: 10
```

```yaml
# agent.cordis.yml（行语义同 presets/standard/agent.cordis.yml）
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: 你是 Buckyball 验证子节点（verify agent）。只验证，不修改仓库；结论只经 VERDICT 行与 report.md 交付。
- id: verify-runner
  name: '@dango/dsh-verify-runner'        # 现有插件，原样复用（src/index.ts:119-179）
  config:
    repoPath: <持久根路径>                 # 现 CI 里由 setup-dsh.sh 写进 cordis.patch.yml:47
    taskDir:  <每轮任务目录>
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'        # 读日志、写 report.md（唯一写路径，仓库外）
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
```

要点对应关系：

- **prompt 模板骨架 = 两段式**。（i）静态段：现有 playbook（`verify-runner/src/prompt.ts:26-121`：判定块消费硬约束、layer 语义/blockedLanes、结论承载、终止契约）原样作为插件的 `systemPrompt.section`（`src/index.ts:125-129`）随 preset 常驻，相当于现在 CI 会话开局就有的部分。（ii）动态段：现在由 `verdict-inputs.sh:87-109` 拼进 `task-prompt.md` 的内容——分支上下文 JSON + 五段判定块（`[stage]/[manifest]/[binding]/[slices-gate]/[perf-gate]`）+ EDA capability 行——改为由调用方在 spawn 时填进 `SpawnRequest.prompt`（即 graph_spawn 的 `task` 文本）。**确定性注入语义完整保留**：判定块仍由纯 node 脚本（`verify-runner/scripts/infer-stage.mjs`、`validate-manifest.mjs`、`binding-check.mjs`、`slices-verify.mjs`、`probe-loop-check.mjs`、`ref-context.mjs`）产出，LLM 只消费不重判——只是注入点从「CI step 写文件」挪到「父节点 spawn 参数」。
- **工具面**：plan + 三件套 + junit/probe 四件 = 现有 verify-runner 插件的 7 个工具（`src/index.ts:130-136`），本地 cordis 注册、随 preset 挂载而生灭，不引入 MCP。bbdev 定位顺序沿用 `bbdev-common.ts:371-384`（PATH → `nix develop -c bbdev`，cwd=repoPath）。
- **模型/思考挡位**：不再来自 `ci/settings.ci.yaml:25-27`（CI 专用 DSH_HOME 废弃），而是部署级 `agentDefaultModel` + 可选的 spawn 覆盖。等价配置：`SpawnRequest.agentOptions = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'max' }`（对应 settings.ci.yaml:19-24 的现状）。

### 2.2 design agent 如何 call 它

**现状**：design agent（ball-designer）通过 bash 跑 `node ci-dispatch.mjs` 把验证推给云端 CI，靠插件监听 bash 结果注入后续 prompt（`ball-designer/src/index.ts:159-183`、`src/prompt.ts:32`）。

**目标形态**：ball-designer 拿到 `graph_spawn` 工具（或一个语义更窄的封装工具，见下），调用点：

```
graph_spawn({
  name: "verify-<chip>-<round>",
  task: <确定性块 + 任务参数拼成的文本>
})
```

`task` 文本由**调用方的确定性前置步骤**生成（不交给 LLM 写）：依次跑 `ref-context.mjs` → `infer-stage.mjs` → `validate-manifest.mjs` → `binding-check.mjs` → `slices-verify.mjs` → `probe-loop-check.mjs`（全部纯 node、无构建，直接复用 `verify-runner/scripts/`），加上 EDA capability 探测行（现 `verdict-inputs.sh:83-85` 的 `command -v` 逻辑，本地形态探测的是本机 PATH）。这层「先跑脚本再 spawn」建议做成 design 侧插件里的一个宿主工具（如 `bb_verify_spawn`），内部完成：flock → checkout 持久根到目标 head → provision 预热 → 生成判定块 → 调 `agentRuntime.spawn` → 解析回流文本执行 verdict 门禁。它等价于把现在 `prepare.sh`/`provision.sh`/`verdict-inputs.sh`/`run-verify.sh` 四个脚本的编排内化为一段 node 代码，**门禁留在 LLM 够不到的地方**（呼应现 `run-verify.sh:100-121` 的 verdict-gate 角色）。

- **传入**：layer（merge/complete）、chip、phase、round、stems、models、目标 head sha、判定块五段、runner EDA capability 行、repoPath/taskDir/report 输出路径——即现 task-prompt.md 的全部信息（`verdict-inputs.sh:93-108`）。
- **拿回**：graph_spawn 的返回字符串（子节点最终回答），契约沿用 `prompt.ts:113-121`：首行 `VERDICT: PASS|FAIL|INFRA` + `$VERIFY_OUT/report.md` 完整报告 + `head sha:` 行。调用方工具把返回值结构化为 `{ verdict, reportPath, headSha, summary }`；**没有 VERDICT 行一律按 INFRA**（fail-closed，与 `run-verify.sh:116-119` 同语义）。report.md 同时是后续 EDA 段与 slices-gate 检索的证据载体（`head sha:` 行义务保留）。

**对 singularity 的两处小扩展需求**（生长机制本身不变）：

1. `SpawnRequest` 目前不带 preset 选择，子节点恒定继承父 preset（`index.ts:191`）。verify 子节点需要 `bb-verify` preset 而非父的 designer preset——给 `SpawnRequest` 加一个可选 `agentPreset` 字段即可，`RootRequest` 已有同款先例（`agent-runtime/src/types.ts:26`）。
2. graph_spawn 返回纯文本；若想让 verdict 解析更稳，可在封装工具里约束子节点最终回答的机器可读头（首行 VERDICT 已足够，报告全文走文件）。

### 2.3 职责切分表

| 现有逻辑块 | 归属 | 理由 |
|---|---|---|
| `verdict-inputs.sh`（五段判定块生成 + EDA 探测，`verdict-inputs.sh:83-109`） | **本地子节点侧**（调用方确定性前置） | 判定语义必须跟着验证会话走；脚本全是纯 node 调用，原样复用 |
| `run-verify.sh` 会话运行（`run-verify.sh:54-58`） | **本地子节点**（即 spawn 本身） | headless dsh 会话 → graph_spawn 的子 agent 会话，同构替换 |
| `run-verify.sh` verdict 门禁 + INFRA fail-closed（`run-verify.sh:100-121`） | **本地子节点侧**（封装工具内，LLM 外） | 门禁语义不变，执行点从 CI step 挪到调用方工具 |
| `provision.sh`（nix build + bbdev config/compiler/workload 预热 + provision_exempt） | **本地子节点侧**（spawn 前置，确定性代码） | 预热是验证的前置，跟验证同机；`provision_exempt` 语义依赖判定块输出，两处本来就要一起搬 |
| `prepare.sh`（flock + fetch + detached checkout + 子模块对齐） | **本地子节点侧**（封装工具内） | 持久根与互斥语义本地仍需要（见 §2.5） |
| `pre-commit-gate.sh` | **本地子节点侧**（spawn 前置的确定性 lane） | 它是内容失败（FAIL）而非 INFRA，属验证面；一条 `nix develop -c pre-commit run --all-files` 即可保留 |
| `final-gates.sh`（verdict 产物齐全 + 持久根只读 diff 门禁） | **本地子节点侧**（封装工具的收尾检查） | 只读纪律在本地形态更重要（子节点与设计同机） |
| `validate-inputs.sh`（ref/sha/layer 校验） | **不再需要** | 没有 workflow_dispatch 输入面；参数由 design agent 程序内生成 |
| `check-prereqs.sh`（工具链/secret/bootstrap 探测） | **本地子节点侧**（一次性环境体检，封装工具 fail-fast） | 本地机器同样需要；改为本地 preflight |
| `post-status.sh` / `backstop.sh` / report job（commit status 通道） | **不再需要（对本地段）** | commit status 是给云端轮询者的通道；本地调用是同步返回 |
| workflow 的 concurrency group、`Finalize verdict files`、artifact 上传（`bb-verify.yml:53-55,150-167`） | **不再需要（对本地段）** | 互斥由 flock 承担；verdict 文件落本地目录即可 |
| `setup-dsh.sh`（插件 staging + 新鲜 DSH_HOME + headless profile） | **不再需要** | 子节点是宿主 dsh 进程内的 preset 挂载，不再起独立 dsh |
| `ci/settings.ci.yaml`（CI 专用模型路由） | **不再需要** | 模型走宿主 `agentDefaultModel` / `agentOptions` |
| **EDA 段**：`dc --area/--power`、`uvm --run`、`bebop-p2e --verilog/--buildbitstream` 车道（plan 的 `EDA_LANES`，`bbdev-plan.ts:48-63`）、vivado/dc_shell/vcs 缺失 → blockedLanes INFRA 语义（`prompt.ts:91-95`）、`EDA_SESSION_BINDS` bwrap 沙箱（`bb-verify.yml:30`、`run-verify.sh:36-52`） | **留在 CI**（裁剪版 workflow） | 设计者已定：商业 EDA 环境车道留 CI；沙箱 binds 是那台 runner 的部署事实，随之留在 CI |
| 裁剪版 workflow 的 dispatch/status 通道（`ci-dispatch.mjs` 的 EDA 子集） | **留在 CI** | 本地段完成后，EDA 段仍经 `workflow_dispatch` 触发、commit status/artifact 回传 |

**EDA 段的感知/调用方式（建议）**：本地子节点的 plan 工具把 complete 层的 EDA 车道**不生成本地命令**，标记为 `delegatedLanes`（沿用 blockedLanes 的数据形状 `{lane, tool, reason}`），report.md 照录「EDA 车道转交 CI 段」；本地 verdict 只覆盖本地车道。EDA 段的触发仍走 **workflow_dispatch**（建议，而非本地直跑）：触发者是 design agent——拿到本地 PASS 后经裁剪版 `ci-dispatch.mjs` 派一个「仅 EDA」的 run（输入带本地 report 的 head sha），EDA runner 有 dc_shell/vcs/vivado 与 EDA_SESSION_BINDS 部署。权衡：本地直跑 EDA 要求 design 机器装商业 EDA 与 license 环境，违背「EDA 留 CI」的决定，也丢掉 runner 上已解决的 lc_shell/libstdc++/nsswitch 沙箱事实（`bb-verify.yml:26-30`）；走 dispatch 则保留现有部署，代价是 design agent 的交付变成两段式（本地 verdict → EDA status 轮询），这部分轮询体验 ball-designer 已有现成的 dispatch-pending 提示可复用（`ball-designer/src/prompts/1.8-dispatch-pending.prompts.ts`）。

### 2.4 与 verify-runner 包的关系

- **原样复用**：`scripts/*.mjs` 六个判定脚本（infer-stage / validate-manifest / binding-check / slices-verify / probe-loop-check / ref-context）+ `scripts/manifest.mjs`；`src/tools/` 全部 7 个工具；`src/prompts/` 五个事件 prompt；`src/prompt.ts` playbook 全文；`src/index.ts` 插件本体（改个包名/暴露形态进 preset 即可）。
- **迁移**：`ci-dispatch.mjs` 裁成「仅 EDA 段」的 dispatch 客户端（去掉 merge 层任务面），或保留全量但仅由 design agent 在 EDA 阶段调用；`ci/bb-verify.yml` 裁成 EDA-only workflow（保留 env 部署块、EDA 沙箱、status/backstop 通道，删掉本地段全部 step）。
- **废弃**：`ci/settings.ci.yaml`、`ci/bootstrap-persistent-root.sh` 中 CI runner 特化的部分（持久根 bootstrap 概念本地仍需要，见 §2.5，但脚本要按本机重写）、`scripts/bb-verify-watchdog.sh`、`scripts/runner-orphan-sweep.sh`（runner 运维件）、`ci/runner-setup.md`/`upstream-ci-proposal.md` 等 CI 部署文档（改写为本地节点部署文档）。

### 2.5 开放的硬问题

1. **持久根与 nix 环境从哪来**：CI 里持久根是 runner 上一次性 bootstrap 的 `/home/ROXY/bb-verify/buckyball`（`bb-verify.yml:17`）。本地形态下 design agent 的机器（可能每人一台）是否都建持久根？候选：a) 验证子节点集中部署在那台已有持久根/EDA 的机器上，design agent 远程调；b) 每台 design 机器各自 bootstrap（buddy-mlir/llvm 预热成本可观）；c) design 直接用本地工作副本当 repoPath（失去增量预热与只读基线，不推荐）。倾向 (a) 或 (b)，需与设计者确认拓扑。
2. **flock 的生命周期**：现 CI 是「一次 run 一把锁」（`prepare.sh:21-49`）。本地形态锁要覆盖「checkout→provision→会话→只读 diff 收尾」全程，holder 是封装工具进程；跨 design agent 并发 call 时的排队/超时策略要定（现 CI 用 concurrency group 排队，`bb-verify.yml:53-55`）。
3. **fail-closed 门禁的强制点**：CI 里门禁是 shell 脚本，LLM 物理够不到。本地形态下封装工具必须是 cordis 服务/工具代码（不经 LLM 文本通道），且子节点的 `tools.restrict` 不允许它自己写 verdict——目前 singularity spawn 的子节点拿全量 preset 工具、无 per-spawn restrict（`index.ts:191-201`），需要确认是否加 spawn 级 `tools` 白名单（对称于 root 的 `ROOT_TOOLS` 机制，`index.ts:123`）。
4. **工具生命周期**：本设计工具全走本地 cordis 注册（随 preset 挂载生灭，`mount.ts:378-433`），不引入 MCP；但 bbdev 三件套 spawn 的 bbdev 任务进程是 detached 长跑任务（`src/tools/bbdev-submit.ts`），子 agent 被父 abort 级联 cancel（`spawn.ts:25-31`）时，已提交的 bbdev 任务如何回收（现有 `buckyball_bbdev_cancel` 是否够用、要不要在封装工具里兜底）需要明确。
5. **spawn 的 preset 选择与长会话**：`SpawnRequest.agentPreset` 字段需要上游 singularity 接受（或本地 patch）；complete 层验证可能跑数小时，`whenIdle()` 阻塞式等待（`spawn.ts:28`）对父 agent 的占用与超时策略也要定（也许需要 graph_spawn 的 background 变体）。
6. **secret/网络环境**：CI 里 DEEPSEEK_API_KEY 是 repo secret、HF_HUB_OFFLINE=1（`run-verify.sh:29`）；本地形态走宿主 settings.yaml 与模型缓存，HF 离线策略、EDA 段的 license 环境变量（`bb-verify.yml:23-24`）在裁剪版 workflow 里保留即可，但本地子节点侧不再承担。
7. **graph 拓扑**：verify 子节点挂在 design agent 的 graph 上还是独立 graph？挂在同图能在画布上看到 spawn edge（`index.ts:213`）与状态，符合 singularity 的可视化语义；但跨机器拓扑（问题 1a）下 graph store 是否共享是新问题。

---

## 附：关键文件索引

- singularity 生长机制：`packages/singularity/agent-runtime/src/index.ts`（createRoot `:136`、spawn `:181`、ROOT_TOOLS `:20`）、`agent-singularity/src/tools/spawn.ts`、preset 机制 `thirdparty/deepseek-harness/packages/preset/agent-presets/`（mount.ts、preset.ts、`presets/standard/`）。
- CI 现状：`/tmp/bb-slim/.github/workflows/bb-verify.yml`、`/tmp/bb-slim/.github/scripts/bb-verify/*.sh`（11 个）。
- 验证能力包：`packages/verify-runner/`（`src/index.ts`、`src/prompt.ts`、`src/tools/*`、`scripts/*`、`ci/*`）。
- design 侧调用现状：`packages/ball-designer/src/prompt.ts:32`、`src/index.ts:159-183`、`src/ci-dispatch.ts`。
