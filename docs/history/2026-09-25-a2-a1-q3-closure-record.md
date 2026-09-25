# 第 9 项 A2+A1：Q3 单事件续读收尾记录（2026-09-25）

> 状态：**待验收**（Q3-1、Q3-2 与整组回归的证据见下；独立复核发现的一处可达缺陷已修复并回归）。最终“已验收”由进度审核填写。本记录覆盖[Q3 收尾 prompt](../execution-prompts/09-a2-a1-q3-closure.md)的全部固定交付，并记录计划所有者 2026-09-25 的追加裁决（上限与省略机制直接与 DSH 对齐）。

| 字段 | 内容 |
|---|---|
| 状态 | **交付待进度审核**：Q3-1/Q3-2 有真实工具门证据，Q1/Q2/Q4 与 A2-1～A2-6 既有用例未改动通过 |
| 执行 agent | 实现主代理（Kimi Code CLI 会话）+ 子代理 3 个（单事件读取实现、工具门验收证据、测试对齐）+ 独立复核子代理 1 个（只读，一个风险组） |
| 任务链接 | [Q3 收尾 prompt](../execution-prompts/09-a2-a1-q3-closure.md)；合同：计划 D 节（含 2026-09-25 追加裁决）、[复审记录 Q3](2026-09-25-a2-a1-progress-review.md) |
| 开始日期 | 2026-09-25 |
| 修改前基线 | 施工时实际 HEAD Singularity `d99344f`（复核裁决 `153ca8e`/`9d8b769`；被审代码为 `4115a85`），外层 harness `06b477fe`；两仓无 AGENTS.md |
| 交付版本 | 实现 `30c66f8` + 复核响应 `4b9fb4c`；文档 `740849c` 及随后的记录提交 |
| 前置验收记录 | 第 8/8a 项 R1、R3 已验收；第 9 项 Q1/Q2/Q4 与 Q3 中途读取失败经复审关闭 |

## 固定交付逐条对应

**1. `ref:"<sessionId>"` 列表仍按事件 seq/条数分页。** 语义未动（短事件、`limit` 钳制、第二窗口失败、整块事件、收尾行预留都在）。变化只有超限事件的两处文案：列表首事件放不下仍是具名 `context-too-large`，但正文改为给出该事件的精确引用 `ref:{"sessionId":"…","seq":N}`（其正文按 UTF-8 字节分页），并明说 `offset N+1` 只是显式跳过、看不到正文；页面止于超限事件时，脚注同样给出该引用。`sessionClosingReserve` 已把 session id 计入，收尾行仍是预留而非 best-effort。

**2. `ref:{sessionId, seq}` 单事件读取。** `context/src/projections.ts` 的 `sessionEventRead`：`offset` 默认 0；`limit` 为该事件**可见正文**（`extractSessionEventText`，不重定义原始 JSON 显示）的 UTF-8 字节页量，缺省上限、显式值钳在 4～上限；取源用 `sessionQuery.readEvent({sessionId, seq, before: 0, after: 0})` 并核对返回的 `seq`；正文只在这一条路径内按字节分页，没有索引、缓存、持久游标或第五参数。`ContextReadQuery.ref` 增 `SessionEventReference`（`{sessionId, seq}`），`contextRead` 按 ref 形状分派，其它形状仍走 `malformedRef`；review 分支显式拒绝非 `{taskId, runId}` 的对象。

**3. 先授权再读。** 每一页都先经 `sessionMembershipRefusal`（与会话列表同一成员表检查）：跨图 `cross-graph`、成员表读失败 `unreadable`，两者都**不触碰 DSH**；`seq`/`offset`/`limit` 的合法性判断还排在成员检查之前，非法引用/数值同样不读 DSH。DSH 错误按码映射：`SESSION_QUERY_ABORTED` 抛出、`SESSION_QUERY_EVENT_NOT_FOUND` → `stale-reference`、`SESSION_QUERY_SESSION_NOT_FOUND` → `not-found`、其余 → `unreadable`。非空正文的 `offset` 落在 UTF-8 字符中间或 `>=` 字节长度 → `stale-reference`；空正文只接受 offset 0 的终页。refusals 名称仍只用 `context/src/refusals.ts` 的八个词表。

**4. 可见页与续读。** 成功页的模型可见文本就是 JSON 对象 `{sessionId, seq, offset, nextOffset, hasMore, body[, note]}`：`body` 是本页原文片段，页内偏移只计原文、不计 JSON 包装；尾页的 `note` 指出事件结束并给出列表续读 `offset = seq+1`。返回的 `ProjectedRead` 续读字段与可见 JSON 逐项一致。页量按**转义后的完整 JSON** 收紧（按超界比例收缩、至少保留一个字符），因此极端转义密度既不破界也不停在原 offset。工具 schema 说明两种单位（列表 = 事件 seq/条数；单事件 = 正文 UTF-8 字节），`ref` 的 `oneOf` 增加 `{sessionId, seq}` 分支。

## 与 DSH 对齐（计划所有者 2026-09-25 追加裁决）

- **上限**：`CONTEXT_OUTPUT_LIMIT_BYTES = 50_000`，与部署自身给 `@deepseek-ai/dsh-spill-policy` 设的 `maxInlineBytes: 50000`（`thirdparty/deepseek-harness/packages/bundle/base/cordis.patch.yml:389`）一致：一次 Singularity 读取因此不会被平台自己的 spill 策略替换成预览。旧 16 KiB 是当时的本地选择，已在计划 D 节改为 50000。
- **机制不另造一套**：`context/src/limits.ts` 的 `sliceUtf8` 现在是 `@deepseek-ai/dsh-output-retention` 的 `TextRetainer({kind:'head'})` 的游标包装（字节窗口、不切 UTF-8 字符都由库负责），`omittedLine` 换成 `omissionLine`，省略措辞由 `formatRetentionNotice`/`describeOmitted` 生成、恢复指引仍由本包提供——正是该库文档写明的分工。本包只保留库没有对应物的两样：**游标 `nextOffset`** 与**按行预算 `OutputBudget`**（页面不能切成半行）。
- **依赖声明**同其它 DSH 包：`peerDependencies` + `link:` devDependency（`context/package.json`）。

## 对齐过程中修掉的分页记账缺陷（本票触及）

对齐把旧上限下不易触发的记账问题暴露出来，已修：`referenceList`、根节点的 children 列表、动态投影 related 列表、状态页条目循环原先都是“先试加条目、条目可以吃掉省略行/页脚的预留”，于是列表被切时会因省略行放不下而把整段投影变成 `context-too-large` 拒绝（或页脚加不上）。现在四处都**先量条目、再决定**：预留省略行（以及其后的固定块：运行绑定摘要、分解指引、状态页脚）之后才收条目；`referenceList` 还接受 `follow` 预留，让前一个列表为后一个列表的标题与省略行留位。

证据（主代理探针，`/tmp` 临时夹具，窄引用）：

| 引用条数 | 修复前 | 修复后 |
|---|---|---|
| 500 / 1 000 | 成功（未切） | 成功（未切） |
| 2 000 / 4 000 / 6 000 | `context-too-large` 拒绝 | 成功，约 49 990 字节，含 `Omitted N items. read them by id` |

单测 `limits.spec.ts` 的“a list of ordinary narrow references that does not fit still names its omission”把该行为钉住；同文件原有的宽引用用例保留。

## Q3-1 / Q3-2 验收证据

**Q3-1**（`tests/integration/context-read-single-event.spec.ts`，真实 JSONL 日志 + 真实 `context_read` 工具）：日志含一条超过上限的事件（中文 + `"` + `\` + 换行 + 控制字符）与前后短事件。列表页给出精确引用并在正文中不出现该事件内容；按引用逐页读取（`limit: 4096` 与 `limit: 64` 各一轮）后，`body` 拼接与 `extractSessionEventText` 原文**逐字符相同**（并与种子文本互证）；每页 `utf8Bytes(text) <= CONTEXT_OUTPUT_LIMIT_BYTES`；`nextOffset` 严格前进；尾页 `note` 给出 `offset = seq+1`，随后列表在该 offset 读到下一个事件。

**Q3-2**（同文件，同 cwd 双 graph）：他图事件即使 `{sessionId, seq}` 已知也 `cross-graph` 拒绝，且注入计数的 `readEvent` **一次未被调用**、答案中无正文字符；缺 seq/类型错 ref → `not-found`（工具 schema 对类型错先行拒绝，服务门同批断言）；`seq` 非非负安全整数 → `not-found`；`offset` 负数/非整数、字符中间、等于或超过字节长度 → `stale-reference`；日志没有的 seq → `stale-reference`；源读失败 → `unreadable`；以上均无正文。另证 `limit: 4` 的下限页正好 4 字节。

红/绿：单事件实现前，11 条新单测在 `153ca8e` 代码上全部答 `not-found`（“the reference given ({"sessionId":…,"seq":…}) is not that shape”）；工具门 5 例在实现前同样全红（列表文案里没有对象引用、按引用读取被拒、`offset`/`seq` 错误映射到 `not-found`）。修复后全绿。

## 实际检查（主代理实跑，2026-09-25）

| 命令（cwd） | 结果 |
|---|---|
| `pnpm build`（packages/singularity） | 13 包全部通过（`graphs`/`context` 的 `lib` 产物已重建） |
| `pnpm vitest run --project unit packages/singularity`（外层） | 47 文件 / 1536 项全过（本票前基线 47 / 1521；含复核响应新增的星号字符用例） |
| `pnpm vitest run --project integration packages/singularity`（外层） | 42 文件 / 302 项全过（本票前基线 41 / 296；新增 `context-read-single-event.spec.ts` 6 例，含复核响应的星号字符用例） |
| `pnpm run verify-persistence`（packages/singularity） | OK — 4 event roots 与 schema 一致（持久化零变化） |
| `git diff --check`（packages/singularity） | 干净 |
| `pnpm exec tsc --noEmit`（agent-singularity） | 退出码 0、零输出 |
| 主代理自测探针（`/tmp/q3-own`，不经仓库） | 5 种极端正文（中文/引号/反斜杠/控制字符/混合）× 3 种 `limit`（4 / 4096 / 上限）：每页 ≤ 50000、`nextOffset` 严格前进、拼接逐字符还原；字符边界与越界 offset 全部 `stale-reference` |

## 保留行为复核

- Q1/Q2/Q4 与本票前 Q3 的反例用例**未改动**且全绿（`context/tests/unit/binding.spec.ts` 28 例、`reads.spec.ts` 既有 31 例中的会话/状态用例、`tests/integration/context-assembly.spec.ts` 14 例、`context-binding-zero-input.spec.ts` 2 例）。
- A2-1～A2-6 既有真实装配、工具、恢复、取消、旧数据用例未改：`worker-contract.spec.ts`、`cancellation-gate.spec.ts`、`a3-recovery.spec.ts`、`root-intake.spec.ts`、`root-intake-recovery.spec.ts`、`proposal-recovery.spec.ts` 全绿。
- 测试文件的改动只有：尺寸/措辞随常量更新、新增单事件用例、两处 fixture 保真（见下）；没有删除任何拒绝或零副作用断言（`git diff` 逐条核对）。
- DSH 原始 Session 工具封闭、task/task-runtime/Graph 持久格式、恢复屏障与写闸均未改。

## 既有复杂度处置（本票触及的文件）

| 文件 | 处置 |
|---|---|
| `context/src/projections.ts`（≈1 400 行） | **保留**：本票在同一文件内加 `sessionEventRead` 与其小 helper、改几处列表记账与文案；仍按“会话读取 / 任务读取 / 状态 / 引用读取”分段，未按行数机械切分。 |
| `context/src/limits.ts` | **改写为库的包装**：上限常量、`sliceUtf8`（`TextRetainer` 包装）、`omissionLine`（`formatRetentionNotice` 包装）、`OutputBudget`（库无对应物，保留），文件比原来更小且不再自带切分/省略实现。 |
| `agent-singularity/src/tools/context-read.ts` | 薄适配：schema 增加 `{sessionId, seq}` 分支与两种单位说明，执行体不变。 |
| `context/tests/support/stack.ts`、`tests/support/{assembly-stack,context-plane}.ts` | fixture 保真：两处“日志没有该 seq”的替身改为抛 DSH 自己的 `SessionQueryError(..., 'SESSION_QUERY_EVENT_NOT_FOUND')`（真实引擎如此；此前替身丢码会让任何 stale-seq 用例读成 `unreadable`）。 |

## 模拟与未覆盖范围

- 未做付费真实模型实验；模型输出由 scripted provider/夹具替代，DSH 装配、工具、store、日志、恢复均为真实实现。
- **性能特性**：按字节分页在每页都重新编码/截取正文尾部（库的 `TextRetainer` 语义如此，且合同禁止建索引/缓存），因此 `limit: 4` 这种极小页在 60 KB 正文上约 1.3 s、在 240 KB 正文上约 17 s（单测给它显式 60 s 超时）。正常页量（4 KiB～上限）是毫秒级。若将来需要更快的小页遍历，那是“加缓存/索引”的合同变更，不在本票。
- `omissionLine` 把 `scope` 交给平台的 notice（`formatRetentionNotice` 的默认子句只渲染数量，不渲染 scope；列表自身的标题行已经点名），因此两条被切列表的子句文本只差数量——测试按位置钉住。
- 未覆盖：`ref` 的 `sessionId` 为空字符串、`seq` 为 0 且事件正文为空的组合在工具门只有单测覆盖；`limit` 为 `Number.MAX_SAFE_INTEGER` 的钳制路径由契约的“钳到上限”覆盖（单测有 1e99 一例）。
- 星号平面字符（emoji）现已覆盖（单测窗口、事件分页、task 记录分页、工具门逐页还原各一例）；落单代理项（无效日志才会有的文本）会被解码为 U+FFFD，属字节等价而非字符等价。
- 未覆盖：DSH `readEvent` 返回 `target.seq` 与请求不符的路径在单测里有专门用例，但真实引擎不会产生该状态。

## 未解决缺陷 / 阻塞

无已知合同违反。两处需审核知情的边界：分页性能特性（上）；`@deepseek-ai/dsh-output-retention` 作为 peer 需由部署提供（基础 bundle 已通过 `dsh-spill-policy` 间接引入，本仓由 `context` 的 link devDependency 解析）。

## 独立复核与其响应

执行者：未参与实现的只读子代理，只审“字节窗口 + 上限 + 省略/拒绝矩阵”一个风险组；复跑 unit 5/89、integration 2/8，并自写 4 组探针（上限与库等价、事件门、24 种拒绝形状、四个有界列表）。结论：**上限与复用 PASS、拒绝矩阵 PASS、有界列表 PASS（含一处边界）**，**字节逐页还原 FAIL** ——发现一处我引入的真实缺陷，已修复。

**复核发现 1（已修复，严重）**：`sliceUtf8` 重写为 `TextRetainer` 包装时，游标按**码点**计数却用**UTF-16 code unit** 下标调用 `String#slice`。含星号平面字符（emoji、U+1D11E 等一对代理项＝一个字符两个 code unit）的正文因此每页向后错一个 unit：页内出现落单代理项、`nextOffset` 指向字符中间、正文重复且部分永不显示（复核在真实工具门上用 `😀` 正文复现；同一函数也用于 task 类记录分页，9 页中 6 页字节区间错误）。处置：`limits.ts` 改为按码点走、按 code unit 切（`utf8WidthAt`/`codeUnitsAt`），游标仍由库保留的字节数推出。红/绿：新增单测与工具门用例在修复前红（`a body of astral characters walks out…` 期望整段还原、实得错页；`pages an event whose text carries astral characters byte for byte` 同理），修复后绿；原有 92 个 context 单测与 8 个 Q3 集成用例不受影响。此后我另加了一处状态页记账（把省略子句的字节算进页脚预留），消除复核指出的“最后一处子句可能悄悄放不下”的潜在点。

**复核确认（PASS 部分）**：50000 与基础 bundle 的 `maxInlineBytes` 一致且“恰在上限”不会被 spill 替换（`spill-policy` 只在 `> cap` 时替换）；`sliceUtf8` 在边界预算上与 `TextRetainer` 逐字节一致；`omissionLine` 与库的 `describeOmitted` 逐字一致；`src` 与已提交 `lib` 里不再有第二套字节窗口、`16 * 1024` 或旧措辞；四类列表在 1 000–6 000 条窄引用下的省略计数与真实 store 一致，其后固定块都渲染；24 种拒绝形状全部具名、除需要正文的三种 offset 外**零日志读取**。

**复核留下、需审核知情的判断（本票保留现状并记录理由）**：（a）`OmissionReport.scope/limit/kept` 与 `strategy` 传给库的 notice 但不进渲染行（库的默认子句只渲染 omitted+unit；列表自身标题已点名）；（b）session **列表**的“events shown / more follows / next event not shown”仍是本包措辞——它们是游标陈述而非省略陈述，库明确把“如何继续读”留给工具；（c）引用列表被切时，紧随其后的*固定*块（分解指引/绑定摘要）若本就放不下，整段投影仍具名 `context-too-large`（而不是丢掉该块）——顺序上“先命名省略、再拒绝命名块”是有意为之；（d）证据列表可能被压到 0 条（各列表各自命名省略）；（e）`@deepseek-ai/dsh-output-retention` 不是基础 bundle 的直接依赖（是 `dsh-spill-policy` 等的依赖），本仓由 peer + link devDependency 解析，部署侧 hoisting 由消费方保证。

## 提交

- Singularity 实现 + 构建产物：`30c66f8`；独立复核响应（星号字符分页修复、状态页子句预留）：`4b9fb4c`
- 文档同步（本记录、主 guide、计划、审核记录、派发入口）：`740849c` 及写入复核结论的后续记录提交
- 外层子模块指针：见外层同批提交

## 第二轮审核意见应答（2026-09-25）

被审 SHA：`aaf0601`。审核两项，逐项核对如下；本段**不改变任何生产行为**，只收紧证据与同步文档。

**1.「非法 `seq`/`ref` 形状在公开工具入口没有具名拒绝」——事实成立，判断为平台第一道门的正常行为，不返工。**
- 事实核对（子代理实测复现）：`seq: 1.5`、`sessionId: 42`、`ref` 为数字这类**违反工具自身声明形状**的调用，由 DSH typed-tool 在 `execute` 之前拒绝（`thirdparty/deepseek-harness/packages/core/tools/src/schema.ts:587` 抛 `ToolArgsError`），模型看到的是 `Error: invalid arguments: "ref" must match exactly one oneOf branch (matched 0)`——点名 `ref`，且注入计数的 `readEvent` 一次未被调用。
- 判断依据：(a) 计划 D 节的「非法引用/数值具名拒绝，不调用 DSH」针对的是**通过声明类型但数值/引用非法**的调用（负数 `seq`、非整数/字符中间/越界的 `offset`、缺失事件、跨图），这些全部由读核按八词表具名返回且零日志读取，Q3-2 反例保留；(b) 要让形状错误落到读核，只能把 `ref`/`seq` 的声明放宽成 `json`/`number`——等同复制平台已有的参数校验，并拿掉模型可见的形状声明，与既定「不再自己做一套」的复用裁决方向相反；(c) 本仓既有约定即「工具声明 schema 是运行时前面的一道门」，见 `tests/integration/task-contract.spec.ts` 的 `toolSchemaRefusal` 用例；(d) 服务门对同一形状答 `not-found`（同批断言），所以两道具名门都不读日志。
- 处置（只收紧证据，不改行为）：`tests/integration/context-read-single-event.spec.ts` 把原先「`invalid arguments` 或 `not-found` 二者皆可」的弱断言拆成两条确定断言——`seq: -1` 走读核 `not-found`（非错误结果）、`seq: 1.5` 走平台门并被逐字钉住（含 registry 的 `Error: ` 渲染），另补 `ref: 7` 一例；计划 D 节写明两道门的名字分工（形状→声明 schema；数值/引用→八词表）。

**2.「主 guide 仍留旧状态」——成立，已修。** `docs/singularity-harness-guide.md` 多处**当前态**行仍写「仍返工 / Q3 单事件续读待实现 / 整组待复验」（能力表、缺口表 G11/G13、Handoff 行、§5.15 标题与尾段等），与交付实况不符——上一轮只改了文首与 §5.15 正文，没扫全 guide。现已逐行改为「待验收」并指向本记录，另补 `context-read-single-event.spec.ts` 到测试锚。

**本轮检查（改动后重跑整组）**：`pnpm build` 13 包通过（`BUILD_EXIT=0`）；外层 `pnpm vitest run --project unit packages/singularity` = 47 文件 / 1536 项全过；`--project integration packages/singularity` = 42 文件 / 302 项全过；`pnpm run verify-persistence` OK（4 event roots）；`agent-singularity` 的 `pnpm exec tsc --noEmit` 退出 0；`git diff --check` 干净。
**未覆盖**：形状门由 DSH 校验与渲染，钉住的是当前平台文本（升级平台需同步该断言）；未跑付费真实模型实验、未推送、未部署；A4 未开始。
**票状态**：Q1–Q4、A2-1～A2-6 与公共检查均有证据，**仍为待验收，停在进度审核**。
