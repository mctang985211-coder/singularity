# G2 设计：真实子任务、读面板、第二个领域形状

日期：2026-10-11。基线：本树 `5779037`（G1 已交付）。装配前置审核见 [assembly-review.md](assembly-review.md)，
框架见 [assembly-blueprint.md](assembly-blueprint.md) §9，G1 记录见 [assembly-g1.md](assembly-g1.md)。
**本文件先冻结接口，再并行实现**——第 0 轮只写这一份，任何工作流动代码前先读它。

## 0. G2 的退出条件与归属（逐条，来自装配蓝图 §9）

| 退出条件 | 谁拥有它 | 形状 |
|---|---|---|
| 两个子任务存在依赖 | core（`task/decomposed` + `projectTree`，已在） | 装配层的 `decompose` 工具把模型的计划写成一条完整事实 |
| 唯 verified 解锁 | core（`requirePlanAllows`，已在） | 已在 `rsi-live` 有真实观测；G2 要的是**产品路径**也能撞上 |
| 预算/失败传播 | core（`projectTree` 的 `stopped`/`blocked`，已在） | 装配层不得启动任何非 `ready` 的子任务 |
| **父节点 waiting 期间写入被拒** | **core 新规则（本轮）** | `run/started` 的命令期检查：计划里有子任务正在 `running` 时，父任务自己的 run 被具名拒绝 |
| 准确 child 会话可读 | 装配层（本轮） | 每个子任务一个真实 DSH 会话；`agent/opened` 引用它；面板按同一 cut 读它 |
| 工具与 UI 同 cut 一致 | 装配层（本轮） | 一条只读 HTTP 路由 + 一个手写 client 面板，两者与工具读同一投影 |
| 重连/重载/unload 不重复执行或漏 disposer | 装配层（本轮） | 挂载时重扫计划（幂等）；每个 child handle 的 disposer 归 `ctx.effect` |

## 1. 三个新事实（**都要有消费者，否则不做**）

### 1.1 core：计划权限（关掉 A01 留给 G2 的那条）

**规则**：`decompose` 与 `reassign` 的 actor 必须是该任务**当前持有人**的身份。

- 位置：`task/decomposed` 与 `task/reassigned` 的 reducer（不是命令层、不是工具层）——
  不变量进 reducer 是这个仓库的既定分工，而这两个 kind 的 reducer 已经在父/子任务自己的 subject 上跑。
- 复用 `responsibility.ts` 的 `requireResponsible`：它已经同时判"没人负责"与"不是这个人"，不新增拒绝码。
- **不升版本**，理由与被接受的那两条（`bubble/opened`、`run/failed` 补责任门）同形：被拒的序列在本树
  任何真实部署的日志里不可达——G1 的部署只有一个绑定，而 `reassign` 从工具面不可达。唯一在树里**持有**
  分解事实的日志是 `scripts/rsi-live.mjs` 的探针 fixture，它的发射顺序在本轮同一提交里改正
  （先 `assigned` 后 `decomposed`），所以没有一条已记录的日志会被新规则改写。
- `assign` **不**受这条约束：第一次分配是装置的行为（它把任务交给谁去负责），而转移与规划是持有人的行为。

### 1.2 core：父任务在子任务在飞期间不得开工

**规则**：`run/started` 的命令期检查多一条——任务的计划里若有子任务正处于 `running`，则父任务自己的 run
被拒绝，理由点名那个子任务。

- 位置：`src/task/commands.ts` 的 `requirePlanAllows`（它已经为子任务做同一件事，且已经付过 `cut.tasks()` 的钱）。
- 为什么是"在飞"而不是"未完成"：这条闸拦的是**同一份验收被两个写者同时推进**，不是拦计划本身。
  `rsi-live` 的战役里根任务自己的基线 run 既发生在子任务未开工时、也发生在第一个子任务已 verified 之后——
  两种顺序都必须继续通过，这才证明闸是精确的而不是"父任务一律禁写"。
- 命令期检查，**不是** fold 规则：`task/*` 的 reducer 看单个 subject，看不见别的任务；把它写进 reducer
  要么复制状态要么引入跨 subject 读，两者都是这个仓库明确拒绝的形状。

### 1.3 装配层：`singularity_decompose_task` 工具 + 子任务调度

模型供应（工具参数）：

```ts
{ taskId: string,
  children: [{ key: string,            // 批内局部名，稳定 id 由它派生
               goal: string,
               dependsOn: readonly string[],   // 批内 key
               supports: readonly string[],    // 父契约的 criterionId
               maxRuns: number }] }
```

driver 决定：子任务 id、契约、工作区、负责的 agent 节点、会话、以及何时启动。

- **稳定 id**：`childTaskIdOf(controlId, parentTaskId, key)`；子任务的 **agent id 就是它的 task id**
  （单射，且面板上一眼能看出"哪个 agent 负责哪个子任务"）。
- **契约**：子任务的 goal 是模型给的，输入与判据与父任务**同源**（都来自 domain 声明），
  所以子契约由装配层组装、不经模型填判据。
- **启动条件**：`projectTree` 给出该子任务 `ready`，且它还没有会话。
- **指令**：child 会话的第一条用户消息由**契约**拼出（goal + 判据陈述 + 工作区 + 工具纪律），
  不含任何领域字面量。
- **推进时机**：`decompose` 之后、以及每次 run 结算之后，重扫计划，把新 `ready` 的子任务开起来；
  挂载时也扫一次（幂等）。
- **不得**启动非 `ready` 的子任务——那正是 core 的闸，装配层不许绕过；装配层只是不主动撞它。

## 2. domain 声明 v2：一个声明，两种提交形状

G1 的形状是「模型写一个**程序** → 装配层运行它 → 判据的验证器判它写出的**产物**」。
sha256 域是「模型写**改动后的源码** → 判据的验证器编译并仿真它」。协议、run、verdict、receipt **一个都不变**；
变的是**工作区怎么来**与**提交到哪去**，那是声明的事，不是协议的事。

```jsonc
{
  "inputs": [ { "path": "rtl/sha256_w_mem.v", "from": "seed/sha256_w_mem.v" },   // 受保护输入：v2 由 domain 装载，不由模型填
               { "path": "tb/tb_sha256_w_mem_selfcheck.v", "from": "tb/tb_sha256_w_mem_selfcheck.v" } ],
  "workspace": {
    "submission": "program",              // "program" | "source"
    "file":       "program.mjs",          // 提交写进工作区的路径
    "artifact":   "report.txt",           // 判据的验证器被指向的路径
    "initial":    "seed/sha256_w_mem.v"   // 可选：工作区建立时把这份字节放在 `file`（source 形状的起点）
  },
  "criteria": [ ... ],                    // 仍然恰好一条（v1 的边界不变）
  "verifiers": [ ... ],                   // 仍然带 selftest，且必须既有 pass 又有 fail 样本
  "metric": {                             // 可选；声明了就**必须**有消费者（见 §3）
    "unit": "um^2", "direction": "lower",
    "measured": { "criterionId": "area", "statement": "...", "verifier": "area" }
  }
}
```

装载期拒绝（全部具名，`malformed-declaration`）：

1. `submission` 不在 `{"program","source"}` 里；
2. `submission === "source"` 而 `file !== artifact`（判据会去判一个没人写过的路径）；
3. `submission === "program"` 而声明了 `initial`（工作区把要判的字节先放好了，程序再写它是第二个写者）；
4. 任何 `inputs[].from` 或 `initial` 解析到 domain 目录之外（沿用 `inside` 的既有判据）。

- **`inputs` 的语义变了，这是 v2 的核心**：v1 的 `inputs` 是"模型在 `propose` 时交的一段文本"，
  v2 的 `inputs` 是"**domain 目录里一份受保护材料，stage 到工作区的哪个路径**"。
- letters 域按同一个形状改写：`{"path":"in/source.txt","from":"samples/source.txt"}`，
  `submission` 仍是 `"program"`（它测的正是"模型真的会写程序"），`file`/`artifact` 不变。
  **G1 已交付的语义（程序作为 node 的 ES module 运行、只判 stdout）一个字不改**，
  变的只是那段输入文本从此住在 domain 里，而不是从模型手里过一遍。

## 3. 度量：声明的消费者是 `measure@4` 的一次评估

`metric` 若只被写进 JSON 而没人读，就是这个仓库的根因三（声明了没有消费者）。所以：

- 每条 run 结算后，装配层开一次 `measure@4` 的评估（`trials: 1`）：
  `run` 指向该 run，`baseline`/`candidate` 指向两次真实修订，`judgement` = 该任务的判据（硬约束），
  `metric.measured` = domain 声明的度量判据；
- 度量程序（domain 目录里的 `area.mjs`）真实跑 yosys，端口把它报告的**数**与**实现摘要**交给
  `recordTrial`；`checkConstraint` 用 `recordedVerdictDigest` 把硬约束**引用**到那次判决上；
- 硬约束与度量**必须**是两个不同 criterionId——`measure@4` 的 reducer 已经在拒绝同一 id
  既当可交易的分又当不可补偿的约束；
- **不建轮次、不建选择**：`strategy` 本轮一个消费者都不加。选择是 G3 的事。
- 口径（comparability）不新造：`contextDigestOf(bubble)` 已经覆盖模型、工具摘要、条件与输入；
  sha256 域把 **yosys 二进制的字节摘要**放进 `tools`、把 **liberty 的字节摘要**放进受保护输入，
  于是"同一个问题"这句话里包含了合成器与工艺库。

## 4. 读面板：一条只读路由 + 一个手写 client bundle

**已实测的缝**（装好的 `0.2.0-rc.2`，见 §6 的证据行）：插件可以贡献 Web 界面
（`dsh.client` + `exports["./client"]`，槽位 `main` 与 `sidebar.panellist`，客户端入口导出 `apply`/`inject`），
但**运行时没有打包器**——宿主直接 `readFileSync` 那个 client 文件，所以它必须是仓库里手写的、
`window.__ModuleLoader__.load({ id, factory })` 形式的纯 JS，且只许 `require` 平台种子模块
（`react`、`react/jsx-runtime`）。宿主路由：`ctx.webServer.register({kind, path, handler})`，
门是 `ctx.connection.requestRejection(req)`。

**`assembly/src/web.ts`（第三个入口，独立一行挂载）**：

- `inject: ['singularity', 'webServer']`；缺 `webServer` 的 profile 不挂这一行，而不是让插件静默消失
  （`inject` 缺席 = 整行不激活，这是既有约束 10）。
- `GET /singularity/tasks` → 一个 **cut** 的 JSON：

```jsonc
{ "formatVersion": 1, "controlId": "...", "cutoff": 42,
  "tasks": [ { "taskId", "goal", "phase", "runs": [ { "runId", "status", "detail" } ] } ],
  "plans": [ { "parentTaskId", "complete",
               "children": [ { "taskId", "status", "dependsOn", "supports", "maxRuns", "runsUsed", "reason" } ],
               "criteria": [ { "criterionId", "satisfiedBy" } ] } ] }
}
```

- `cutoff` 由事实算出（`store.load().entries().at(-1).seq + 1` 的口径与 receipt 同源），**不由调用方传**。
- 只读：非 GET → 405；**读不提交任何事实**（探针断言事实数不变）。
- 门：`requestRejection` 拒绝即原样回它的状态码，其余处理不做。

**`assembly/client.js`（手写，进 git）**：`load({id: "@dangosys/dsh-singularity-next", factory})`；
注册 `main`（key = 面板 id）与 `sidebar.panellist`（同一 id）；组件用 `react/jsx-runtime` 的 `jsx`，
挂载时 fetch 一次路由，渲染成任务/子任务列表 + 一个 Refresh 按钮；渲染出的 cut 号与它读到的 `cutoff` 一致。
`package.json` 增 `exports["./client"]` 与 `dsh.client = { platform: "web", inject: [...] }`。

**证据**：`scripts/panel-probe.mjs`（门禁）——真 boot profile、真 Chromium：
① 路由返回的投影与同一 cut 的 core 投影逐字段相等；② 面板渲染出的 task id 与 agent 用工具报回的一致；
③ 点 Refresh 后面板显示的 cutoff == 路由此时返回的 cutoff；④ 面板读完事实数不变；
⑤ 断线重载后不重复执行（同一个 run 不被重跑）。

## 5. 明确不做（写下来，免得下一个人以为是漏了）

- **不建 group/router**：上游没有，且今天没有消费者（`context.md` §10）。
- **不建策略轮次**：`strategy` 本轮零改动，选择留给 G3。
- **不给 worker 一个可以绕过评估的裸发布入口**（那是 G3 的 `requestPublish`）。
- **不做通用画布**：只做"一个 cut 的只读列表"，旧 `graph`/`canvas-view` 的复用留给真正需要画布的那一轮。
- **不新造沙箱**：RTL 编译与综合在真实进程里跑，受保护输入靠**摘要**判没被判据以外的东西动过，
  不靠文件权限（那不是本层能保证的，也不是它声称的）。

## 6. 已实测的缝（写下来，实现的人不用再查一遍）

装好的 DSH `0.2.0-rc.2`（`/home/ROXY/singularity-next/dsh/node_modules/@deepseek-ai/`）：

| 事实 | 位置 |
|---|---|
| `ctx.webServer.register({kind:'exact'|'prefix', path, handler(req,res)})`，无鉴权参数 | `dsh-host-webserver/lib/types/index.d.ts` |
| 现成的 JSON 只读路由样板（含 `requestRejection` 门与 `sendJson`） | `dsh-host-open-in-app/lib/index.js` |
| `requestRejection` 实现：403 门 → 401 cookie | `dsh-client-connection/lib/index.js` |
| 客户端 bundle 由宿主 `readFileSync`，运行时无打包器 | `dsh-client-modules/lib/index.js` |
| 客户端入口契约：`apply(ctx)` + `inject: string[]`，`load({id, factory})` 返回 module.exports | `dsh-client-ui-jobs/lib/types/client/index.d.ts`；`dsh-package-manifest/lib/types/types.d.ts` |
| 槽位注册样板（`main` + `sidebar.panellist` 同一个 id） | `dsh-client-ui-schedule/lib/client.js` |
| 子树不可见是客户端过滤（`origin === 'subagent'`），服务端列表不滤 | `dsh-client-ui-workspace/lib/client.js:358` |
| `ctx.agents.create` 可从工具调用内发起；`setup` 在发布前跑一次 | `dsh-agent-loop/lib/index.js:1889` |
| 预设是**作用域父**，不是字段：子 agent 要在 `setup` 里 `composeFrom(childCtx, parent.ctx)` | `dsh-subagent/lib/types/child-agent.js:158` |
| 无级联销毁：父会话结束不处理子会话；SIGKILL 后内存里的挂载全部消失 | `dsh-agent-loop/lib/index.js:1713` |
| resume 需要独占写租约，活的持有者在时抛 `SessionAlreadyOwnedError` | `dsh-agent-loop/lib/index.js:1944` |

**sha256 装置的实测事实**（`labs/sha256`，实测而非转引）：

| 事实 | 读数 |
|---|---|
| 基线可复现 | `verdict pass` / `area 35163.724800` / `yosys_from nix-profile`，一次约 2.24 s |
| **被评的数是 `sha256_core` 的局部面积**，`sha256_w_mem`（27689.06）与 `sha256_k_constants`（2005.67）是**另外的模块** | yosys `stat` 输出 |
| 报告的数**不是分区不变量**：同一份逻辑换模块划分可让数掉 17.7%，换 `read_verilog` 文件顺序可动 ±0.36% | 实测，见本文件 §7 |
| 上游 `tb_sha256_w_mem.v` **不是自检的**（注释自认），且判过的是 `grep` 一行字面量 → 它是**可作弊输入** | `labs/sha256/src/tb/tb_sha256_w_mem.v:186` |
| `yosys_from` 仍是双路解析（nix 0.69 / buckyball 0.67） | `labs/sha256/grader.sh` |

**由此冻结的两条纪律**（比源报告更严，因为本轮实测）：

1. **判据的验证器不看 `grader.sh` 的数**，也不复用它的 `grep`：sha256 域的判据用**我们自己的自检
   testbench**（对已知块比对 W 调度与摘要），判据只认它自己的字面行；面积由**度量**这条腿单独取。
2. **度量程序固定 `read_verilog` 的文件列表与顺序、模块划分与工具路径**，并把它们的摘要放进口径；
   换任何一项都是换 caliber，不是"优化"。

## 6b. 三个冻结的接口（实现方照这个写，不照这个改）

### 6b.1 `assembly/src/domain.ts` 的出口（`Domain` 增三处，其余不变）

```ts
export interface DomainInput {
  readonly path: string          // 工作区相对路径：stage 到哪
  readonly sourcePath: string    // domain 目录内的相对路径：字节从哪来
  readonly digest: string        // 装载时按真实字节算，不由声明给出
}
export interface DomainMetric {
  readonly unit: string
  readonly direction: 'higher' | 'lower'
  readonly measured: AcceptanceCriterion   // 它自己的实现必须与判据的实现不同
}
export interface Domain {
  readonly dir: string
  readonly templateDigest: string
  readonly inputs: readonly DomainInput[]  // v1 的 `inputPath` 被它取代
  readonly submission: 'program' | 'source'
  readonly file: string                    // 提交写进工作区的路径
  readonly artifact: string                // 判据的验证器被指向的路径
  readonly initial?: { readonly path: string; readonly bytes: Uint8Array }  // source 形状的起点
  readonly criterion: AcceptanceCriterion
  readonly verifier: DomainVerifier
  readonly verifiers: readonly DomainVerifier[]
  readonly metric?: DomainMetric
}
```
`loadDomain(dir, runProcess)` 的签名不变。四条装载期拒绝见 §2。`Domain.inputPath` 删除（v2 由 `inputs` 取代），
`assembly/src/{driver,submission,repair}.ts` 里对它的引用在同一次提交里改掉。

### 6b.2 `singularity` 服务的形状（面板与工具读同一条路）

```ts
interface AssemblyService {
  forCall(exec: ToolRunContext): AgentTaskSurface
  /** 一个 committed cut 的只读投影。面板与探针读它；它不提交任何事实。 */
  read(): Promise<ControlSnapshot>
  /** 推进计划：把新 ready 的子任务开起来。幂等，返回它这一轮启动了什么。 */
  advance(): Promise<readonly string[]>
}
interface ControlSnapshot {
  readonly formatVersion: 1
  readonly controlId: string
  readonly cutoff: number
  readonly tasks: readonly { taskId: string; goal: string; phase: string; runs: readonly { runId: string; status: string; detail: string | null }[] }[]
  readonly plans: readonly { parentTaskId: string; complete: boolean;
    children: readonly { taskId: string; status: string; dependsOn: readonly string[]; supports: readonly string[];
                          maxRuns: number; runsUsed: number; reason: string | null }[];
    criteria: readonly { criterionId: string; satisfiedBy: string | null }[] }[]
}
```

### 6b.3 子会话（`src/runtime/child-session.ts`）

```ts
export interface ChildSeams {
  readonly sessionPersistence?: SessionPersistence
  readonly sessions?: SessionStore
  readonly agents?: AgentRegistry
  readonly agentLoop?: unknown
  readonly agentPresets?: { composeFrom(ctx: Context, parent: Context): void }
}
export interface ChildSessionRequest {
  readonly agentId: string          // 子任务的 task id；会话 id 由它派生（既有 agentSessionIdOf 的口径）
  readonly cwd: string
  readonly parent: Agent            // 父 agent 的活对象：预设从它 join，模型路由从它的 header 读
  readonly model: { readonly provider: string; readonly model: string }
  readonly instruction: string
  readonly setup: (childCtx: Context, agent: Agent) => void | Promise<void>   // 见下：预设 join + 我们的工具注册
}
export async function openChildSession(ctx: ChildSeams, request: ChildSessionRequest): Promise<{ agentId: string; sessionId: string; agent: Agent }>
export async function closeChildSession(agentId: string): Promise<void>
```

**实测的四个必须做对的点**（装好的 `0.2.0-rc.2`，见 §6 与本节末）：

1. **预设是作用域父，不是字段**。`ctx.agents.create({meta:{agentPreset}})` 不会挂任何东西；子 agent 的工具表会是空的。
   必须在 `setup` 里 `agentPresets.composeFrom(childCtx, parent.ctx)`（`dsh-subagent/lib/types/child-agent.js` 是这么做的），
   我们的 agent 面孔（`./agent`）也因此在子 agent 的作用域里重挂一次——这正是 `openChildSession` 收一个 `setup` 的原因。
2. **子 agent 不继承模型路由**。`ctx.agents.create` 不接受就不给；`agentOptions: {provider, model}` 必须显式传，
   值从父 agent 的 `session.requestHeader().config` 读（`callerOf` 已经在读同一个值，不新增第二个来源）。
3. **投递一条消息 = `agent.followup(createUserMessage(...))` + `await agent.whenIdle()`**。
   `followup` 同步唤醒驱动器（内部 `wakeDriver`），`whenIdle()` 是唯一的完成等待；
   它是"整个 agent 静默"，而我们是**只为这一个子会话投递一条消息**，所以两者在这里同义——
   这一点是本模块的接口存在的原因，写进 JSDoc。
   不要用 `ctx.subagents.sendMessage`：它要求 `subagent/descriptor` 事实（只有 `dsh-subagent` 自己的创建路径写），
   对一个我们自建的子会话会抛 `NOT_RESUMABLE`；也不要手写 `user/message`（surface-eligible，缺 `surfaceOp` 会被拒）。
4. **没有级联销毁**。父会话结束不处理子会话，SIGKILL 后内存里的挂载全没了。所以：
   每个打开的 child 由装配层的独占 `ctx.effect` 拥有 disposer；重挂时按计划重开（幂等）；
   活的子会话**不许** resume（写租约是独占的，活的持有者在时抛 `SessionAlreadyOwnedError`）。

**不做的事**：不改 `src/**` 的协议来承载会话；子会话不写任何控制事实（它写的是 DSH 自己的 transcript），
子任务的**责任、契约与判决**仍然只由装配层的命令写进控制 store。

## 6c. 本轮的变异证明（每条新规则一个，缺一个就删规则）

`node scripts/mutate.mjs <id>`，各自独立跑，实测结果：

| claim | 规则 | 见证（会失败的那个测试） |
|---|---|---|
| `mutate:assembly-m24-plan-belongs-to-holder` | 计划是持有人的行为：`task/decomposed` 要求 actor 是当前持有人 | refuses a plan its task-holder did not write |
| `mutate:assembly-m25-transfer-belongs-to-holder` | 转移是持有人的行为：`task/reassigned` 要求 actor 是当前持有人（第一次的见证撞的是 `from` 那条规则，MISSED，换成"换一张可信身份表"的见证后才 caught） | refuses a transfer emitted under an identity that is not the holder |
| `mutate:assembly-m26-parent-waits-for-a-running-child` | 父任务不在自己委托出去的验收上与子任务同时开工 | refuses the parent while a sub-task of its own plan is running |
| `mutate:assembly-m27-initial-source-not-overwritten` | 再次准备工作区不会用种子覆盖已有提交 | leaves a submission in place when the workspace is prepared again |
| `mutate:assembly-m28-one-input` | 声明恰好一个输入（`{input}` 只有一个名字） | refuses a domain that declares more than one input, by name |
| `mutate:assembly-m29-staging-writes-the-loader-bytes` | 工作区写入的是装载时摘要过的字节，不是重新读的源 | stages the bytes it digested even when the declared source has changed since |

前两条是**在新表下重放同一批事实**：`from` 成员能挡住"名字指错人"，挡不住"不是这个人在做"，
后者只有 actor 能表达，所以见证必须换一个可信身份表（换表这个动作本身就是事实，见上表 m25 那一行）。

## 7. 工作流与文件域（一个文件域一个 owner；共享文件只有协调者动）

| 工作流 | 独占文件 | 交付 |
|---|---|---|
| **W0 协调者（Lead）** | `src/task/{commands,decomposition,responsibility}.ts`、`artifacts/baselines`、`scripts/gates.mjs`、`docs/**`、`assembly/src/{index,agent,apparatus,driver,submission,repair}.ts` | §1.1/§1.2 的 core 规则 + 接线 + 门禁 + 文档 |
| **W1 领域 v2** | `assembly/src/domain.ts`、`assembly/tests/domain.spec.ts`、`deployment/domain/sha256/**`、`deployment/domain/letters/*.json` | §2 的装载器与两个真实域 |
| **W2 面板** | `assembly/src/web.ts`、`assembly/client.js`、`scripts/panel-probe.mjs` | §4 的路由、面板与探针 |
| **W3 子任务调度** | `assembly/src/scheduler.ts`（新）、`scripts/subtask-probe.mjs` | §1.3 的调度与推进 |

串行点：`assembly/package.json`、`deployment/profile/**`、`src/**` 的其他文件——只有 W0 动。
