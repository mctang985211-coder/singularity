# singularity 多智能体教程：在 React 小项目上验证分解能力

## 1. 目的

用几分钟部署一个自包含环境，在**纯软件小项目**上验证 singularity 的多层任务分解：环境里放一个故意留空的 Vite + React 看板应用 `tutorial-kanban`，它的测试即规格；给根节点一句目标后，观察它是否自然拆出多层子任务、各自独立验收、并对最终结果给出可核查的证据。

本教程不需要 nix、不需要 EDA 工具链、不依赖 Buckyball 检出：全部验证都是 Node 侧秒级的测试与构建。迭代默认开启后，目标无论通过与否都会继续产生轮次；教程的观察与 checklist 章节也用它对照轮次徽标与派生得分。

## 2. 部署

```sh
cd /home/ROXY/code/bb_work/harness
node packages/singularity/tutorial/seed-env.mjs
```

本机实际输出（已部署完成）：

```
seed-env: created project1
seed-env: env path    = /home/ROXY/code/bb_work/harness/environment/project1
seed-env: component   = /home/ROXY/code/bb_work/harness/environment/project1/tutorial/kanban
seed-env: skills      = /home/ROXY/code/bb_work/harness/environment/project1/.agents/skills
seed-env: label       = tutorial-kanban
seed-env: root prompt = /home/ROXY/code/bb_work/harness/packages/singularity/tutorial/root-prompt.md
seed-env: next step   = build a graph on this env, then paste that root prompt
```

再次执行 `--id project1` 会得到 `seed-env: project1 already seeded (idempotent re-run)`，条目不变。

脚本行为：

- 在 `environment/` 里取**下一个空闲的 projectN**（与 env-builder 的 `nextProjectId` 一致：最小未占用编号；本机已有 project46，所以是 `project1`），复制 `app/` 到 `environment/projectN/tutorial/kanban`，并做一次 `git init` + 初始提交（组件里是一个普通仓库）。
- 把教程技能写到 `environment/projectN/.agents/skills/`（技能必须在 env 根，检出内部署看不到）。
- 追加 manifest 条目（components 里 `owner=tutorial, repo=kanban, dir=tutorial/kanban, status=ready`，`url` 为空串——本地组件没有远端，但 schema 要求该字段为字符串），保持 2 空格缩进和结尾换行。
- 在组件里跑 `pnpm install`（热仓库不到 1 秒）。

常用参数：`--id projectN` 指定编号；`--label name` 换 label；`--no-install` 跳过安装。**幂等**：对同一个 `--id` 重跑只会补齐缺失部分（不会重复创建、不会二次提交）；默认重跑会创建下一个空闲编号；指定的 id 已存在且不是本教程环境时干净拒绝。

部署后项目位于 `environment/project1/tutorial/kanban`，当前是**红灯基线**：3 个测试文件、17 个用例中 16 个失败（`initialBoard` 一行已给），`pnpm build` 仍可过。

## 3. 建图

方式 A（UI）：打开部署日志里的地址（形如 `http://127.0.0.1:3080/?token=…`，token 以日志为准），进入 singularity 页面，在图谱切换器上点 **New** → Name 填一个名字 → Environment 选 `tutorial-kanban (1 components)` → **Create**。

方式 B（API）：先带 token 访问一次换取 cookie，再创建图。

```sh
TOKEN=<部署日志里的 token>
curl -c /tmp/dsh.cookies "http://127.0.0.1:3080/?token=$TOKEN"
curl -b /tmp/dsh.cookies -H 'content-type: application/json' \
  -d '{"name":"tutorial","envId":"project1"}' \
  http://127.0.0.1:3080/singularity/graphs
```

创建后根智能体会先做环境 setup（组件已 present，直接 mark ready），随后等待你的目标；此时 Tasks 页显示"未激活"是正常的。

## 4. 粘贴 root prompt

把 `/home/ROXY/code/bb_work/harness/packages/singularity/tutorial/root-prompt.md` 的全文**以真人消息发送**。这不是形式要求：`task_intake` 只接受 `source.kind=user`，系统注入或任务文本不会被当作人的目标，根节点会一直停在 setup 完成、无任务的空转状态。

发送后根节点会 `task_intake` 收下根任务，再自行决定分解。

## 5. 平台驱动的迭代（RSI loop）

只有带 `rsi` 设置的图才有迭代；驱动在平台侧（`agent-singularity` 的统一 coordination driver），不需要开关或手动调用：

- **每一轮 = 根任务的一次终态 run**：verified 或 failed 都算一轮，图上的 `rsi.iterationRounds` 决定跑几轮。
- **终态即受监督**：驱动为该轮写入一条 assignment 并 spawn 一个 supervisor（读工具 + 六个 `method_*` 工具），由它调查、起草候选（`method_draft`）、评估（`method_evaluate`）并决定发布、试用或弃置。
- **显式完成**：supervisor 以 `supervisor_complete({businessAction, reason, evidenceRefs})` 结案——`continue`（verified 轮用改进后的方法再跑一次）、`recover`（failed 轮修复重试）、`finish`（业务不再继续）；正常结束却没调用完成工具记为协议失败，不再催问，要重来只能显式提升图的 `rsi.epoch`。
- **下一轮由驱动打开**：driver 等会话收尾落盘后才开下一轮 Run；round 调度只属于驱动。
- **非 RSI 图没有 supervisor**：没有 `rsi` 的图，失败就是失败，没有自动迭代，也没有自动复盘 reviewer。
- **每一轮都是根任务下的一次新 run**：Tasks 页签里，带 recovery 记录的 run 行显示 ↻ 徽标——`↻ recovery · round N` 或 `↻ improve · round N`，N 是该 run 在 `task.runIds` 里的 1 基序号。每个 run 有自己的一条 review（逐条判据、退出码、证据），展开 run 行即可核对。
- **supervisor 拿到上一轮的 review 事实**：上一轮的判据 verdict、metrics 与派生的 passed/total 随交接提供；supervisor 可以用 `finish` 结束这一来源的迭代。
- **ReviewRecord 没有 score 字段**：轮次得分是派生读数——按 `task.runIds` 顺序取每个 run 的终态 review，数 criterion verdict 的 passed/total。

轮次与得分表的三个读取入口（同一份事实，任选）：

| 入口 | 读什么 |
| --- | --- |
| Tasks 页签 | 每个 run 的 ↻ 徽标与轮次号；展开看该轮 review 的逐条判据表 |
| `GET /singularity/task?storeId=sg-t-<rootSessionId>` | 同一个 store 的 tasks/runs/reviews 原始投影，每个 run 一条 review |
| `$DSH_HOME/coordination/assignments.jsonl` | 协调的 assignment/completion 行：每轮谁被指派、以什么 businessAction 结案、协调预算消耗到哪 |

**迭代一定会停**：每来源的 recovery/improvement 轮到硬上限即不再开新轮；协调预算（reviewer+supervisor 的启动计数，默认 8，`SINGULARITY_COORDINATION_BUDGET` 或配置 `supervision.coordinationBudget` 覆盖）用尽后也不再有新协调 agent；supervisor 判定 `finish` 同样终止来源。三者先到先停，每轮通常消耗 2 次（reviewer + supervisor），默认 8 大约够 4 轮；想一次看满 3+2 的上限可把预算调到 16。

## 6. 观察指南（六个页签）

| 页签 | 看什么 |
| --- | --- |
| Canvas | 拓扑：根→子节点的连线、层级深度、节点状态（每个子节点应有自己的目标）。 |
| View | 统一读模型：访问模式、当前生效的环境版本（active revision）、最近一次评估与派生进度；与工具面读的是同一份事实。 |
| Methods | 方法库状态：生效版本指针、每个 draft 的状态与判定、正在试用的候选；方法变更只经 draft → 评估 → 发布发生，页签是只读视图。 |
| Tasks | 任务树与运行：子任务目标、依赖、状态；迭代开始后根任务下持续新增 run，带 `↻ recovery · round N` / `↻ improve · round N` 徽标；展开每个 run 核对那一轮的 review 判据与退出码。 |
| Recovery | store 屏障/接管状态（reconcile），不是轮次列表；轮次看 Tasks 的 ↻ run。一切顺利时为空。 |
| Verifier | 验收判据与证据（EvidenceBundle）：每个 run（含每一轮）的判据、命令、退出码、结论都在这里核对；定位某轮失败在哪条 criterion。 |

## 7. 今晚实战 checklist

前提：环境已按 §2 部署（project1），图还没建。

1. **核对 seed 环境**（已完成）：`environment/project1/tutorial/kanban` 是红灯基线（3 个测试文件、17 个用例 16 个失败）。要重建见 §2。
2. **UI 建图**：图谱切换器 → New → Name 任意 → Environment 选 `tutorial-kanban (1 components)` → Create。等根节点 setup 完成（组件已 present，直接 ready）；Tasks 页显示"未激活"是正常的。
3. **粘贴 root prompt**：把 `tutorial/root-prompt.md` 全文以**真人消息**发送（原因见 §4）。根节点 `task_intake` 收下根任务后开始分解。
4. **盯 Tasks**：第一批子任务出现并运行；根提交后进入验收，然后迭代开始——根任务下持续新增 run 行，读徽标：`↻ recovery · round N`（失败来源重试）或 `↻ improve · round N`（通过来源改进）。点开某轮的 run，复核该轮 review 的判据表（criterion → verdict → exit）与起止时间。
5. **盯 HITL**：只有真正的 HITL 请求才需要动作（例如生成任务审核或方法发布审批）。默认迭代不会产生必须点掉的卡片。
6. **盯 Verifier**：按 run 看判据与 logTail；用它读每一轮失败/通过在哪条 criterion、退出码多少。
7. **（可选）盯 Recovery**：看 store 屏障与 reconcile 状态；轮次本身不在这里。
8. **旋钮**（在部署配置里给 id 为 `singularity-agent` 的条目加 `config.supervision`；条目按 id 覆盖整段 config，仓库根 `config.yml` 当前还没有这一行）：
   - `supervision.coordinationBudget`：协调预算次数，默认 8；环境变量 `SINGULARITY_COORDINATION_BUDGET` 优先于它；
   - 每图轮数由图的 `rsi.iterationRounds` 决定（前端 GraphSwitcher 里可设），不再有 `autoReview` / `maxRecoveryRounds` / `maxImprovementRounds` 这些键；
   - `verifyTimeoutMs: 600000`（task-runtime 行）：本教程的验证是秒级测试，10 分钟绰绰有余，不需要调。
   默认值即上述取值，不改也能跑；改完配置重启部署（部署读取的是 `.dsh/profiles/web/cordis.patch.yml`，由仓库根 `config.yml` 拷贝）；未知键会被 schema 拒绝，以部署实际接受为准。
9. **终止预期**：迭代在 recovery ≤3、improvement ≤2、协调预算用尽、或 supervisor 以 `finish` 结案（协议失败同样停轮）中先到者处停止，一定会停。停止后 Tasks 页不再新增 ↻ run；若最后一轮仍是 failed，那是本轮的最终结果，如实记录 review 与 evidence，不要等它"再试一次"。
10. **人工复核**：按 §9 直接在环境里跑 `pnpm test` / `pnpm build`，不采信智能体转述。

## 8. 预期形态

根任务目标明确后，自然分解大致是"一个汇总验证节点 + 三块互不阻塞的实现子任务"：

- reducer 状态机（`src/state/boardReducer.ts`，`boardReducer.test.ts` 验收）；
- 三个组件的渲染与交互（`src/components/*`，`Board.test.tsx` 验收）；
- localStorage 持久化 hook（`src/hooks/useLocalStorageBoard.ts`，`App.test.tsx` 端到端验收）；
- 根节点做组合验收：全量测试 + 构建。

具体形状由节点自己决定，上面只是合理的预期；不要因为它和预期不同就判定失败，看的是每层是否有独立可核查的交付。迭代轮次会在这之后继续产生新 run（§5），第一轮无论通过或失败都算预期内。

## 9. 复核验收（自己动手）

不采信智能体转述，直接进环境跑原始命令：

```sh
cd /home/ROXY/code/bb_work/harness/environment/project1/tutorial/kanban
pnpm test     # 期望 Test Files 3 passed，Tests 17 passed
pnpm build    # 期望退出码 0
```

红灯基线时 `pnpm test` 的 16 个失败就是待实现清单；完成后应全绿。

## 10. 退役

本环境的组件是**副本**（`environment/project1/tutorial/kanban` 是一个普通 git 仓库）。删除图（UI 上 Delete → Confirm delete，或 `POST /singularity/graphs/<id>/delete`）只停止会话、解绑 env 并归档图记录——不会 spawn 清理会话，也不会碰检出目录，所以无论组件是副本还是符号链接都可以安全删除；此后该 env 会重新出现在可选环境列表里。想彻底清掉，可在图删除后删掉 `environment/project1` 目录与 manifest 条目（或保留它，下次教程直接 `--id project1` 复用）。

## 11. 常见问题

- **重复部署**：默认再跑会建 `project2`；想复用原有环境就带 `--id project1`（幂等补齐）。
- **端口**：本部署 web 在 `127.0.0.1:3080`，以启动日志为准；换端口时 API 示例同步改。
- **超时**：本教程的验证是秒级测试，默认 `verifyTimeoutMs: 600000`（10 分钟）远远够用，不需要为教程调大。
- **迭代只跑了一两轮就停**：先看图上的 `rsi.iterationRounds`（轮数上限）与协调预算。预算默认 8 次，每轮通常 supervisor 一次；用尽后不再开新轮，`$DSH_HOME/coordination/assignments.jsonl` 的 assignment/completion 行能看到消耗。要跑更多轮就调大 `SINGULARITY_COORDINATION_BUDGET`（或配置 `supervision.coordinationBudget`）。
- **迭代没触发**：只有带 `rsi` 设置的图才迭代；在 GraphSwitcher 里确认该图的 RSI 设置已写入，且改动后已重启部署。supervisor 以 `businessAction: 'finish'` 结案、或一轮正常结束却没有调用完成工具（记为协议失败）也会让 loop 停下；原因在 View 页签的派生进度与 completion 记录里。
- **run 行没有 ↻ 徽标**：徽标来自该 run 的 `recovery` 记录（`TaskRun.recovery`）；没有该记录的普通 run 不显示，历史 run 按原样读取。
- **轮次得分在哪**：`ReviewRecord` 没有 score 字段；轮次得分是派生值，按 `task.runIds` 顺序统计该轮 review 的 criterion verdict（passed/total）与 outcome、metrics。
- **别改测试**：测试是规格；删测试、跳过或用 mock 绕过都会让验收失去意义。
- **独立的 pnpm 工程**：`tutorial/kanban` 带自己的 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`，不会并入 singularity 的 workspace。
