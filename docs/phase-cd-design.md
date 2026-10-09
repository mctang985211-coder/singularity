# phase-cd-design.md —— C/D 的接口冻结（**先读这份，再动代码**）

> 这份文件是**冻结的接口契约**，不是建议。四个工作流并行时，唯一的协调手段就是它。
> 任何形状改动都是**升版本**，也就是所有人停下来。所以第 0 轮只做这一件事。

## 0. 目标与退出条件（`review.md` §5 原文，不要改写）

| 阶段 | 退出条件 |
|---|---|
| **C 可信评估** | 好候选通过；高分但越界拒绝；缺失分母正确；每份报告有真实 trials |
| **D 受控发布** | 批准绑定具体差异；陈旧/内容变化拒绝；head 不引用半成品；重放恢复一致 |

对应审核项：C = R02/R06/R08（+R01/R03/R05/R07 的判定部分），D = R07/U05。

**宁少勿多**：这一轮新增 4 个协议版本、10 个 kind。任何"顺便也做一下"的东西都不做（§9 列了明确不做的事）。

## 1. 文件域所有权（**不许越界**）

| 工作流 | 独占文件 | 交付 |
|---|---|---|
| **A · 度量切片** | `src/measure/**`、`src/task/bubble.ts`、`src/task/protocol.ts`（**只改 bubble manifest 那一处**）、`tests/measure-*.spec.ts`、`tests/task-bubble-manifest.spec.ts`、`scripts/measure-runner.mjs`、`scripts/measure-probe.mjs` | `measure@1` + `task@4` |
| **B · 决策层** | `src/strategy/decision.ts`、`tests/strategy-decision.spec.ts`、`tests/vectors/**`、`scripts/strategy-vectors.mjs`、`docs/divergence-ledger.md` | RRSI 纯函数 + 差分向量 |
| **C · 轮次与发布** | `src/strategy/{protocol,commands,view}.ts`、`src/release/**`、`src/environment/**`、`tests/strategy-round.spec.ts`、`tests/release-*.spec.ts`、`tests/environment-pointer.spec.ts`、`scripts/round-probe.mjs` | `strategy@1` + `release@1` + `environment@2` |
| **协调者（我）** | `src/index.ts`、`src/protocol/**`（除 refusal 码，§3）、`scripts/gates.mjs`、`protocol-baseline.json`、`tests/fixtures.ts`、`docs/**` | 集成、门禁、证据 |

**硬规矩**

1. **不碰别人的文件。** 需要对方改什么，就在报告里写出来，由协调者转达。
2. **不动 `src/index.ts`。** 导出由协调者统一加。你的门禁运行可能因此报 `no-unreferenced-export`——**这是预期的**，在报告里说明即可。
3. **不跑 `git commit` / `git checkout` / `git stash` / `git restore`。** 三个工作流共用一个工作树，git 操作会互相碾压。只看 `git diff -- <你的文件>`。
4. **不新增 refusal code**（§3 已冻结）。需要新的就在报告里提。
5. **不新增 helper 模块 / util / 抽象层。** 需要抽公共代码时，报告里说明，由协调者决定。
6. **不写 `src/index.ts` 之外的 barrel，不写 `export *`。**

## 2. 三条造型纪律（本项目已经付过学费的）

1. **加字段 ⇒ 升版本。** 没有第二种加法。已冻结的版本一个成员都不许改。
2. **跨实体前置条件放提交区**，作为 `store.emit(input, require)` 的 `require`，**不**放在外面提前算。同 subject 的纯规则放 reducer。
3. **派生量永不持久化。** receipt、aggregate、caliber digest、plan 槽位都是投影。

## 3. refusal 词汇（冻结）

**新增 4 个，其余复用。** 判据是"调用方的下一步是否不同"。

| 新码 | 何时 | 调用方下一步 |
|---|---|---|
| `caliber-mismatch` | 两个口径不可比却要放在一起判定 | 不要池化，重新度量 |
| `budget-exhausted` | 编辑预算（按 `rounds-1` 退火）已用完 | 等下一轮 |
| `stale-approval` | 批准绑定的内容摘要 ≠ 当前草稿的内容摘要 | 重新申请批准 |
| `unapproved-revision` | 指针要切到一个存在但未被批准的修订 | 先批准 |

**复用（不要新造）**：槽位越界 → `illegal-transition`；槽位已被占 → `evidence-conflict`（把它的文档行
从"一个判据一个判决"扩成"一个判据一个判决、一个槽位一次观测"）；观测的输入与 bubble 不符 →
`evidence-input-mismatch`；度量实现的发射者不是 metric 声明的那一个 → `wrong-verifier`；
约束不在 judgement 里 → `unknown-criterion`；指针的 expected head 不符 → `illegal-transition`；
修订不存在 → `unknown-revision`。

## 4. `task@4`（**唯一一次任务侧升级，批量**）

`bubble/opened` 的必填成员从 `{runId, inputs, workspace}` 扩为
`{runId, inputs, workspace, model, tools, conditions}`：

```ts
readonly model: string                                   // 真正跑的模型身份，不许填 "default"
readonly tools: readonly { name: string; implementationDigest: string; version: string }[]  // 名字 + 内容摘要 + 版本
readonly conditions: readonly string[]                   // 可观测的外部条件，逐条具名
```

- 出处 R08："只固定 Skill 文本或 MCP 定义，不能保证背后的 Tool 实现没有变化。"
- 校验：`model` 非空；`tools` 每项 `name`/`version` 非空、`implementationDigest` 是 sha256；**`name` 唯一**；
  `conditions` 每项非空、**不重复**；三者都**必填**（一个不声明自己模型身份的 bubble 不是可复现的执行上下文）。
- `TASK_VERSION` 3 → 4。v1/v2/v3 按 `version-mismatch` 具名拒绝，无兼容层。

## 5. `measure@1` —— 度量（subject = evaluation id）

### 5.1 四个 kind

```ts
'evaluation/opened' {
  baseline: RevisionRef        // 对照侧
  candidate: RevisionRef       // 候选侧
  run: { taskId: string; runId: string }   // 这次度量在哪个执行上下文里发生（bubble 在那边）
  metric: {
    measured: AcceptanceCriterion          // 复用契约的判据形状（含 implementationDigest）
    unit: string
    direction: 'higher' | 'lower'
  }
  weights: { quality: number; cost: number }   // 只用于分数聚合，硬约束不经它
  trials: number                                // k：固定槽位 0..k-1
  judgement: readonly AcceptanceCriterion[]     // 硬约束，**非补偿**
}

'trial/recorded' {
  slot: number
  quality: number
  cost?: number                // 缺席 = 未知，**不是 0**
  artifactDigest: string
  inputDigests: readonly BubbleInput[]   // 必须逐项等于 run 的 bubble 声明
  detail?: string
}

'trial/missed' { slot: number; reason: string }      // 缺失是显式的，不是"没记录"

'constraint/checked' { criterionId: string; met: boolean; artifactDigest: string; detail?: string }
```

### 5.2 发射者（**沿用既有纪律，不另造一套**）

- `evaluation/opened` → `SCHEDULER_ROLE`。
- `trial/recorded` / `trial/missed` → `verifierRoleOf(payload.metric.measured)`，即
  `verifier:<ref>@<version>`。**metric 的实现和 criterion 的实现是同一件事**：部署按**内容摘要**持有的、
  被可信角色指名的实现。reducer 必须校验 `envelope.emitter` 等于 evaluation 里 metric 声明的那一个，
  且 `envelope.actor !== run.actor`（**执行者不自报数字**，抄 `evidence/produced` 的规则）。
- `constraint/checked` → 该 criterion 自己声明的实现；reducer 校验它与 judgement 里那一条一致。

### 5.3 reducer 不变量

- `evaluation/opened`：一次性；`trials >= 1`（整数）；`metric.measured` 与 `judgement` 每条各用
  `assertCriterionShape` 读；`judgement` 的 `criterionId` **不重复**；`metric.measured.criterionId`
  不得与任何 judgement 条目重名；`weights.quality > 0`。
- `trial/recorded` / `trial/missed`：evaluation 必须已开盘；`slot` 是 `[0, trials)` 的整数；该槽位
  **尚无观测**（否则 `evidence-conflict`）；发射者规则见 5.2；`trial/recorded` 的
  `inputDigests` 经 **`assertInputsBound(run.bubble, inputDigests, where)`** 校验——**复用**，
  不写第二份输入绑定。`run`/`bubble` 从**同一条日志的 task subject** 读，所以这是**跨 subject**的事，
  放**命令层的前置条件**（提交区）。
- `constraint/checked`：evaluation 已开盘；`criterionId` 在 judgement 里（否则 `unknown-criterion`）；
  该约束**尚未被检查**（否则 `evidence-conflict`）；发射者是该 criterion 的实现。
  注意：约束**不参与 weights**。这就是"非补偿"——没有任何数字能买通它。

### 5.4 投影（`src/measure/view.ts` 或 `aggregate.ts`，纯函数，不持久化）

```ts
projectEvaluation(state: EvaluationState): EvaluationView
// {
//   denominator: number            // = trials，**来自计划**，不是观测条数
//   observed: number
//   missing: readonly { slot: number; reason: string }[]   // 每个没有观测的槽位，具名
//   quality: number                // sum(已观测 quality) / denominator —— 缺失计 0，分母保留
//   cost: number | null            // 任一处未知 ⇒ null（**不是 0**）
//   constraints: readonly { criterionId: string; met: boolean | null }[]   // null = 还没检查
//   admissible: boolean
//   why: string | null             // 不可采纳的具名理由
// }
```

**这就是 R06 的实测反例的修法**：`trials=2, missing=1` 必须得到 `denominator=2, quality=(唯一观测)/2,
missing=[那个槽位]`。旧仓在此返回 `quality=1, incomplete=true`——`missing` 计数不补分母。

`caliberOf(evaluation)` / `caliberDigestOf(evaluation)`：口径 = 该 evaluation 里**除去两侧修订**的全部
测量设置（run、metric、weights、trials、judgement），`digestOf` 计算，**派生不持久化**。
两个 evaluation 可比 ⟺ `caliberDigestOf` 相等，否则 `caliber-mismatch`。

## 6. `strategy@1` —— 显式轮次（subject = round id）

### 6.1 三个 kind

```ts
'round/opened' {
  round: number                  // **显式轮次号**，不是"历史条数"（R01 的实测缺陷）
  incumbent: RevisionRef         // 本轮共同对照
  candidates: number             // m 个槽位，0..m-1
  explorationSlots: number       // 保留探索槽的数量（**是计划的一部分，不是提示词里的句子**）
  editBudget: number             // 本轮允许的结构性改动条数
  historyCutoff: number          // 冻结的历史截止（日志位置），本轮只看它之前的事实
  metric: { unit: string; direction: 'higher' | 'lower' }
  weights: { quality: number; cost: number }     // 与 measure 的该轮口径一致
}
'candidate/submitted' {
  slot: number
  revision: RevisionRef          // 候选自己提出的修订
  evaluationId: string           // 它的度量
  edits: readonly { asset: 'skill' | 'tool' | 'template'; target: string }[]   // 结构性改动的**身份**
  exploratory: boolean
}
'round/decided' {
  winner: number | null                     // 槽位；null = 无胜者，保留 incumbent
  outcomes: readonly { slot: number; admitted: boolean; reason: string }[]   // **每个槽位都要有理由**
}
```

### 6.2 reducer 不变量

- `round/opened`：一次性；`round >= 1`；`candidates >= 1`；`0 <= explorationSlots <= candidates`；
  `historyCutoff >= 0`。`editBudget` **由 `round` 退火**：领域函数 `editBudgetFor(round, first)`，
  最后一轮必须能到 `b_min`（ADR 的收紧 #1：`rounds-1` 而不是 `/T`）。
- `candidate/submitted`：round 已开盘且**未结案**（否则 `illegal-transition`）；`slot` 在 `[0, candidates)`；
  该槽位**空着**（否则 `evidence-conflict`）；`edits.length <= editBudget`（否则 `budget-exhausted`）；
  `edits` 每条 `target` 非空、**`(asset,target)` 不重复**；`exploratory: true` 的提交才允许占用
  `explorationSlots` 保留槽（**机械约束，不是提示**）。
- `round/decided`：round 已开盘且未结案；`outcomes` 覆盖**每一个已提交的槽位**，且**每个槽位的处置都带理由**；
  `winner` 必须是某个 `admitted: true` 的槽位，或 `null`。

### 6.3 判定（投影 + 命令前置条件，`src/strategy/{view,commands}.ts`）

`projectRound(state, evaluations, measureStates)` → 每个槽位的：
`aggregate`（来自 §5.4）、`caliberDigest`、`noise`、`gain`。判定顺序**冻结**：

1. **admissibility**：口径一致（否则 `caliber-mismatch`）、约束全 `met`、观测完整（`missing` 为空）。
   **高分但越界者在这里出局**——先于任何 argmax。
2. **noise band**：`gain` 必须在噪声带之外才算真增益（R06：区分实测噪声与 declared floor）。
3. **cost rule**：ADR 的收紧 #2（增益分支上界 +25%）与 #3（去掉 `w_n·ν`，用确定性 tie-break）。
4. **argmax**，确定性 tie-break（槽位号升序）。
5. 无胜者 ⇒ `winner: null`，**保留 incumbent**。

**历史增益必须冻结在事实里**：`ΔS`/`ΔC` 相对**当轮** incumbent 计算并记录；绝不对"今天的 head"重算。
这是 R03 的实测反例（A=0.6、B=0.8：发布 B 前 Δ_B=+0.2，发布 B 后 Δ_B=0、Δ_A=-0.2）。

## 7. `release@1` —— 受控发布（subject = **被发布的修订 id**）

```ts
'release/drafted'  { draftDigest: string }        // 草稿的内容摘要：批准要绑定的就是它
'release/approved' { draftDigest: string; approvedBy: string }
```

- `release/drafted`：修订必须已创建（跨 subject ⇒ 命令前置条件）；一次性；
  `draftDigest` 是 **sha256**；它必须等于**该修订内容的摘要**（`unknown-revision` 若不是）——
  **这就是"批准绑定具体差异"**：批准绑的是内容，不是一个 id、一句"我同意"。
- `release/approved`：草稿必须存在；`draftDigest` 必须**等于当前草稿的摘要**，否则 `stale-approval`；
  `approvedBy` 非空（人审身份的记录；E6 原生审批只提供"人授权过"这一件事，**载荷摘要由我们绑**，
  见 `context.md` §10 给 D 的预告）。一次性。
- **发布本身不是这个协议的 kind**——发布 = 环境指针切换（§8）。少一个 kind，且"head 不引用半成品"
  由指针的前置条件保证。

## 8. `environment@2` —— 唯一指针切换（subject = environment id）

```ts
'pointer/switched' { expected: string; to: string }   // guarantees: { appended: true, conditional: true, atomicFact: true }
```

- **这是全栈唯一的条件更新**（门禁 `single-conditional-owner` 会强制）。`environment@1` → `@2`。
- reducer（additive 检查，保证 `@2` 是**唯一**条件更新点）：
  - `to` 指向的修订必须**存在**且内容摘要相符（同 subject 纯判，**不**依赖 `assertPinnedRevision`
    的跨 subject 版本——修订在同一个 environment 的 state 里）；
  - `state.pointer === payload.expected`，否则 `illegal-transition`（这就是"同一 expected head 冲突
    恰好一方提交"——`context.md` 里留给 D 的场景 3）；
  - `payload.to !== payload.expected`（无变化的切换是错误，不是幂等）。
- **跨 subject 的前置条件（命令层）**：`to` 这个修订必须**已被批准**（`release@1` 有 `release/approved`
  且摘要相符），否则 `unapproved-revision`。**这就是"head 不引用半成品"。**
- `pointer` 进入 `EnvironmentState`：`readonly pointer?: string`（修订 id）。**未设置 = head 为空**，
  不是"默认指向第一个修订"。

## 9. 明确不做

通用沙箱、group/router、`storageDomain`、发布审批的 UI/状态机（只做事实与前置条件）、
第二套轮次编排、第二个状态存储、Python 侧任何运行时调用、给已冻结版本加成员、
`CandidateFact.edits` 式的"透传但生产端永远为空"的字段、多候选搜索的并行调度器。

## 10. 每个工作流的交付要求

1. **测试**：每条承重规则一个用例；**每条新规则一个变异证明**（关掉规则的那一行，对应用例必须失败；
   关不掉就说明规则是死的，**删掉它**而不是补测试）。报告里给出变异前后的实际输出。
2. **探针**：行为检查写成 `scripts/*.mjs`，自己打印结论行（`xxx: OK`），并**在报告里说明该接到哪条门禁**
   （接线由协调者做，同一次提交）。
3. **报告**：给出**量出来的数字**，不是"能跑"。行数、用例数、变异结果、以及任何**你认为契约有问题的地方**。
4. **文件预算**：单文件 ≤ 400 行（门禁 `source-size`）。超了就按职责切，不按行数切。
5. **文字风格**：docstring 写**为什么**（尤其是"不这样做会错在哪"），拒绝消息**点名替代方案**，
   不写"注意""请确保"这类没有机制支撑的话。
6. **不写 TODO / 不写未来的钩子 / 不留未使用的成员。** `noUnusedLocals` 已开。

---

## 11. 冻结：`src/strategy/decision.ts` 的接口（B 实现，C 消费）

**这是 C 与 B 之间唯一的接口。** 纯函数，不碰日志、不碰事实：输入是普通数据，输出是判定。
**B 拥有这个文件的实现，C 只 import 它，不修改它。**

```ts
/** 一次候选的度量结果，已由 src/measure/** 的投影算好。cost 未观测 = null（**不是 0**）。 */
export interface Measurement { readonly quality: number; readonly cost: number | null; readonly denominator: number; readonly missing: number }

/** 一个候选，按它在轮里的槽位。 */
export interface Candidate {
  readonly slot: number
  readonly exploratory: boolean
  /** 它改动的结构性资产类（`skill`/`tool`/`template`），去重后。 */
  readonly assets: readonly string[]
  /** 度量不完整或未度量时为 null。 */
  readonly measurement: Measurement | null
  /** 硬约束是否**全部**满足。false 时任何分数都不进 argmax（非补偿）。 */
  readonly constraintsMet: boolean
  /** 不可采纳的具名理由；可采纳时为 null。 */
  readonly inadmissible: string | null
}

/** 冻结的历史：只看 historyCutoff 之前的事实，绝不按"今天的 head"重算（R03 的实测反例）。 */
export interface History {
  /** 已经**实际发布**过的资产类，用于 novelty（R05：两条 skill edit 的 novelty 仍是 1）。 */
  readonly acceptedAssets: readonly string[]
  /** 每个槽位相对**当轮** incumbent 的增益，测量时冻结。 */
  readonly deltas: readonly { readonly slot: number; readonly deltaQuality: number; readonly deltaCost: number | null }[]
}

/** 噪声依据：实测校准还是声明的下限。两者必须可区分（R06）。 */
export interface Calibration { readonly floor: number; readonly source: 'measured' | 'declared' }

export interface Outcome { readonly slot: number; readonly admitted: boolean; readonly reason: string }
export interface Selection { readonly winner: number | null; readonly outcomes: readonly Outcome[] }

/** 编辑预算按轮次退火，`rounds-1` 而不是 `/T`：最后一轮必须真的能到 minimum（ADR 收紧 #1）。 */
export function editBudgetFor(round: number, rounds: number, first: number, minimum: number): number

/** 此前未被接受过的结构性机制类型的数量（类型，不是条数）。 */
export function noveltyOf(assets: readonly string[], history: History): number

/**
 * 先 admissibility，再噪声带，再成本规则，最后 argmax。顺序是冻结的：
 * **高分但越界者必须在 argmax 之前出局**，噪声带内的增益不算增益，同分按槽位号升序。
 * 每个候选都要有一个 `Outcome`，无论采纳与否。
 */
export function select(
  candidates: readonly Candidate[],
  history: History,
  calibration: Calibration,
  weights: { readonly quality: number; readonly cost: number },
): Selection
```

**C 的用法**：`src/strategy/view.ts` 从 `measure@1` 的投影和 `strategy@1` 的 state 构造
`Candidate[]` / `History` / `Calibration`，调用 `select`，把结果写进 `round/decided`。
`constraintsMet` / `inadmissible` 由 C 从 `projectEvaluation`（§5.4）填。
