# Singularity 重构：第一轮审核与构建交接

- 日期：2026-10-09。
- 审核对象：[blueprint.md](blueprint.md)、`singularity-core` 的 S1/S2、旧 Singularity、DSH 及 RRSI 上游。
- 定位：记录第一轮结论、补充关键遗漏、规定后续构建检查点。本文中的建议尚未作为产品代码实现。
- 构建方先处理 §2 的基础问题，再按 §5 推进；下次重要审核使用 §6 的 K1 清单。

## 1. 结论、基线与证据边界

建议继续重构，保留复用 DSH、纯领域规则、唯一权威写入路径和受控方法发布的方向；先修订当前 S3′—S9 的依赖与退出条件。现有架子证明协议可以追加、折叠和投影，尚未证明真实执行、可信验证与跨轮改进闭环成立。

收敛目标应落在三件事上：一个事实只有一个权威来源；一项领域规则只有一个实现；一次方法改进能由真实执行事实证明。文件数、事件种类数和行数是辅助指标。

| 参照物 | 审核基线 | 本次核实方式 |
|---|---|---|
| `singularity-core` | `798c6d95eb78de6402665947a75313d95ea91322` | 源码审查；第一轮运行 `pnpm verify`：41 测试、7 门禁全绿；临时反例探针 |
| 旧 Singularity | harness `6a0eddec10519bc8c30ed9c7bb9998865f89754f` | 源码与七份证据件对照；本次未重跑旧仓全量测试 |
| DSH checkout | `639ed015397290b3745d163aafe02ffee4aa3f84` | 服务接口、存储校验与恢复源码；直接调用其构建产物的事件校验器 |
| RRSI checkout | `be50316e1db05914068a973f322770ef08ed7ba1` | 本地 `/home/ROXY/code/rrsi` 的 README、loop、selection、history、components、calibrate、propose 与 domain |

旧仓测试健康度采用证据件中的 2378 passed / 1 failed / 1 skipped（unit）、557 passed / 5 skipped（integration）。单独跑失败文件通过，只能说明隔离问题是有依据的诊断，不能把全套件写成全绿。

本文区分三类结论：**实测反例**已运行并观察到结果；**源码确认**有直接生产路径依据；**构建要求**是为补齐目标提出的契约，不表示对应功能已经存在。P1 应在依赖它的产品能力构建前解决；P2 是局部正确性或维护负担问题。

## 2. 第一轮意见落实

### F01 · P1：DSH 扩展事件、持久化屏障与迁移边界

**实测反例。** DSH 的运行时事件词表是固定生成集合；仓外插件扩展 `SessionEventMap` 不会改变它。扩展事件缺少 `ignorable: true` 时，`validateStoredEvents` 拒绝；加上该标记后接受。

依据：[固定词表的仓外插件说明](/home/ROXY/code/bb_work/harness/thirdparty/deepseek-harness/packages/core/session/src/known-event-types.ts:15)、[装载校验](/home/ROXY/code/bb_work/harness/thirdparty/deepseek-harness/packages/session/session-persistence/src/storage-contract.ts:75)。蓝图 §6.1 的“默认 required”不能直接成为 Singularity 扩展事件的实现前提。

**建议。** 先验证专用控制 store：外层使用 DSH 可承载的扩展事件，内层由 Singularity 强制校验协议、版本、kind 与载荷。该 store 只能通过其领域装载入口使用；不能被当成普通 agent 会话恢复并跳过控制事实。如果产品要求宿主也识别其 required 语义，先解决上游扩展契约，再继续集成。不得借用一个已知 DSH 事件名塞入不相符的业务载荷。

DSH 的公开 [SessionHandle 接口](/home/ROXY/code/bb_work/harness/thirdparty/deepseek-harness/packages/session/session-persistence/src/handle.ts:85) 把 `flush` 定为崩溃持久性屏障。当前 JSONL 实现的 append 已落盘，适配器仍须遵循服务接口，或明确限定并测试该后端。

DSH v0→v4 迁移链处理宿主格式，不会自动迁移 Singularity 载荷。应用事件版本、载荷演进与 receipt 格式仍由领域所有者负责。

**验收。** 新进程可以重放自己的扩展事实；未知内层 kind/version/字段拒绝；持久化屏障失败不返回提交成功；升级宿主格式不改变领域载荷含义。

### F02 · P1：租约之外还需要串行提交与结果识别

**实测反例。** 对同一 `ProtocolLog` 并发执行两次 `emit`，三轮均观察到两次成功、磁盘 `seq = [0, 0]`、重开 `chain-broken`。依据：[emit 的游标读取与更新](/home/ROXY/code/singularity-core/src/protocol/log.ts:138)。该实现已计划删除，不建议继续修补其文件存储。

新适配器的领域提交顺序应为：

```text
进入同一控制 store 的共享队列
→ 读取已提交状态、认证主体、校验命令和前置条件
→ 计算完整下一状态与待提交事实
→ append + durability barrier
→ 发布已提交状态与通知
→ 返回结果
```

lease 保证跨进程写入所有权；队列保证同一进程内多个命令的判断与提交顺序。DSH 序号校验不能代替领域 CAS 的原子检查。

命令必须能识别“事实已提交但答复未送达”：同一 `commandId`、同一请求重新送达应返回原提交结果；同一 ID 携带不同请求应拒绝。它是识别重复提交的契约，不是自动重试外部副作用的许可。提交失败且结果不确定时，恢复者先从权威日志确定结果。

单条 `pointer/switched` 可以取代独立 pointer intent 文件；进程内队列、结果识别与恢复仍须保留。普通 reads 只观察已提交状态，不负责隐式启动或恢复工作。

### F03 · P1：验证独立性需要可信写入主体和具体产物

**实测反例。** 内核接口允许调用方填写 [EmitInput.actor](/home/ROXY/code/singularity-core/src/protocol/log.ts:21)。直接用验证器名称写入 pass，无产物引用也能进入 verified。当前 reducer 的 [字符串约束](/home/ROXY/code/singularity-core/src/task/protocol.ts:178) 只证明字段关系；尚未定义来源可信性。此反例不等同于证明旧产品工具存在相同越权入口。

建议把三个职责分开：agent 提出命令；可信服务产生事实；reducer 检查事实是否允许推进状态。执行者和 UI 不接触任意事实追加接口，`actor` 来自真实调用上下文。Task 的准入、Run 的创建与结算、Evidence 的生产分别有明确写入主体。

Evidence 至少绑定具体 Run、契约/判据、产物内容摘要、验证输入、验证器实现版本和配置。验证器在固定产物上执行；验证之后产物变化，旧 verdict 不得用于新产物。摘要用于内容身份，不能充当主体认证。

候选 TaskTemplate、Skill 或 Tool 可以改变方法，原任务的冻结验收、受保护输入和验证器不能随候选自行改写。契约审核、产物验收和方法发布是不同的判定。

### F04 · P1：历史重放与派生 receipt 的来源必须固定

**实测反例。** [Task admission reducer](/home/ROXY/code/singularity-core/src/task/protocol.ts:121) 重放时查询当前验证器注册表。合法日志在换成空注册表后报 `unregistered-verifier`。

新准入检查当前实现是否可用；历史事实保留当时的内容身份与准入事实。当前部署缺少旧实现时，新执行可以具名拒绝，历史事实仍应按明确支持的协议版本解释。不得把“能重放历史”混同于“现在能重跑旧任务”。

G4 receipt 可以继续采用纯推导，但 [当前 ReceiptView](/home/ROXY/code/singularity-core/src/task/view.ts:57) 尚未包括实际模型、Skill/Template/Tool 消费、用量与完整性。它还不能替代旧系统的执行凭证。

终态封存应固定：凭证格式版本、各来源 session 的截止序号、内容引用、执行子树范围以及缺失项。未来同一来源范围应生成同一摘要；后续会话消息或新 projection 实现不能悄悄改写历史凭证。跨 session 的来源使用明确截止范围，不能仅写控制日志的一个序号。

### F05 · P1：阶段安排遗漏真实 Task 主路径

蓝图 S3′—S9 没有明确安排 E3、E6，也没有覆盖 Task 分解、依赖推进、责任交接、预算终止与同会话恢复。S7 的 novelty/mechanism 变化不足以验收 RRSI 闭环；S9 的领域测量应在依赖它的搜索之前完成。

先完成真实执行纵切，再建立可信评估与单候选发布，最后实现多候选搜索。E3 优先复用 DSH 的 create/resume 生命周期和旧仓已经验证的行为；E6 接原生审批 seam。只有发现具体合同违约或重复所有权时，才重建相关旧边界。

### F06 · P2：门禁与边界校验的保证被高估

**实测反例。** 临时副本增加 default-import 的文件写者，以及只在另一文件注释中出现的导出，七条门禁仍全部通过。依据：[文件写者检查](/home/ROXY/code/singularity-core/scripts/gates.mjs:106)、[文本名称引用检查](/home/ROXY/code/singularity-core/scripts/gates.mjs:127)。

另外，未知 Task payload/contract 字段被接受；`detail: 123` 被改成空串；缺失失败理由被写成 `no reason recorded`。依据：[contract 读取](/home/ROXY/code/singularity-core/src/task/contract.ts:59)、[可选值处理](/home/ROXY/code/singularity-core/src/task/protocol.ts:86)。缺失可以是契约明确允许的状态，错误类型和未知字段应拒绝。

用 AST/符号检查替换文字匹配，区分真实生产消费者、测试消费者和公共 API。门禁应重点覆盖闭合载荷、权威写入入口、重放、失败提交与真实纵切。相同类型结构不能单独证明领域语义重复。

蓝图“不按行数拆分”和当前 400 行硬门存在张力：改成审查触发条件，或明确有限适用范围；不能迫使一个状态机拆成多个互相维护的所有者。

局部缺陷：[phaseOf](/home/ROXY/code/singularity-core/src/task/view.ts:90) 把已准入但无 Run 的 Task 映为 failed；应明确待运行状态。

## 3. 补查统一协议：还需要哪些约束

### U01 · P1：统一到机制，保持作用域与领域所有权

建议统一的是事实提交机制、边界校验纪律、拒绝呈现和投影来源。不同领域继续拥有自己的载荷和 reducer；每个 agent transcript 继续由 DSH 管理。

先固定 `environmentId / graphId / taskId / runId / sessionId` 的关系。方法库的目录使用 root session 名称，不能单独证明其所有权或生命周期永远属于该会话。是否跨图共享方法，由产品契约裁定；当前可以先限制一个 Environment 的控制 store，不预建宿主级库。

控制 store 与执行 agent 的 transcript 分开使用稳定身份和链接。root agent 已持有 transcript 写句柄时，领域服务不能再对同一 session 申请第二个写句柄。多个物理日志可以复用同一存储机制；无需把系统所有事实塞入一个全局物理日志。

### U02 · P1：信封的序号、时间和内容身份各有一个来源

适配 DSH 时使用其外层 `type / seq / time / data`；领域载荷保留实际需要的协议版本、subject、主体与业务数据。删掉重复的连续 seq、文件摘要链与物理日志校验。

revision、产物、冻结计划等内容仍需摘要；这是内容身份，不能和物理追加链混为一谈。持久化边界只接受无损 JSON，复用 DSH 的快照/冻结能力；协议载荷必须先通过领域校验。不能让 `NaN → null`、`undefined → 缺字段` 参与内容身份。

**实测反例。** 当前 `digestOf({v: NaN}) === digestOf({v: null})`，`digestOf({v: undefined}) === digestOf({})`。依据：[canonicalJson](/home/ROXY/code/singularity-core/src/protocol/envelope.ts:59)。这要求限制输入域，不要求自建另一套通用序列化框架。

### U03 · P1：跨实体关系需要在同一次权威判断中成立

当前 [fold 引擎](/home/ROXY/code/singularity-core/src/protocol/fold.ts:25) 每次只处理一个 protocol/version/subject。一个 Task reducer 无法仅凭其局部状态证明另一实体的 Revision 已存在、某 Agent 有执行责任或某 Evaluation 已被批准。

| 关系 | 应在同一权威提交边界检查的内容 |
|---|---|
| Run → Revision | 指定版本已完成、内容可验证；准入后保持原绑定，发布不热替换在途 Run |
| Agent → Task | 同一任务的当前执行责任唯一；委派/交接使原责任失效 |
| Draft → Evaluation | 草稿与被测内容相符；报告固定双侧版本、输入和验收 |
| Approval → Publish | 批准指向具体差异、报告和 expected head；批准后重检仍有效 |
| Pointer → Revision | 目标内容已完整持久化，条件更新在同一提交队列内判断 |

据此选择必要的聚合边界或领域命令协调。不得用捕获一个会变化的外部 registry 的 reducer closure 来伪装纯重放，也不需要引入通用事务/effect 引擎。

### U04 · P1：G1—G4 应描述可组合属性

追加持久性、批次可见性、条件更新和纯推导属于不同维度。一个条件更新事实同样需要持久化；某个条件更新也可能发布一批成员。建议取消“一个事实只能一个级别”的限制，保留必要业务操作的具体保证。

当前 runtime 限制的是 G3 owner 的 protocol 名称，允许同一协议有多个 G3 kind 和多个 subject；静态门禁统计的是源代码标签。两者都不能保证只有一个物理指针，也不能实现 CAS。

正确约束是：**每个 Environment 只有一个 active revision；publish/rollback 共用一条权威切换路径；expected revision 与 generation 在提交队列内检查。**

DSH `append([a,b])` 不应被当作多记录崩溃原子事务。其 [恢复代码](/home/ROXY/code/bb_work/harness/thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts:992) 明确保留 torn frame 中已完整写出的记录。优先把有业务原子性的操作表达成一条完整事实，例如一份分解批次或一个完整环境 manifest 的发布。

### U05 · P1：内容块与可恢复外部操作不能凭重放自动完成

manifest、报告、产物与工作区是有用途的内容，不必为了“无第二文件”塞进日志。先准备并验证完整不可变内容，再提交其引用；允许存在未被引用的准备产物，不允许生效指针引用半成品。相同 revision ID 的内容改写必须拒绝；“改动后 digest 变了”只证明哈希敏感性，不能证明不可变。

日志重放恢复决策，不会原子创建 agent、投递消息、运行 shell 或完成 worktree 克隆。为现阶段真实使用的操作明确稳定 operation/session ID、已完成事实与失败恢复路径：例如 assignment 提交前、agent 创建后但拓扑发布前、工作完成后但结算前分别崩溃，应如何识别状态。

恢复可以重试契约允许、结果可识别的操作；不可识别的外部副作用应具名暴露不确定状态，不自动重复。不得承诺跨外部工具的 exactly-once。持久 Agent 身份、可恢复会话和进程内 live handle 分开处理；重启恢复同一身份，不换人或自动选举 router。

### U06 · P1：版本演进、读截止范围与故障隔离

DSH 宿主格式版本、领域事件版本、投影缓存版本、receipt 格式版本分开管理。同一 subject 的历史出现不同领域版本时，明确选择拒绝、显式迁移或确定性升级路径；不能把 [按 version 过滤](/home/ROXY/code/singularity-core/src/protocol/fold.ts:36) 当成完整状态的升级。

同一输入与同一受支持解释器应重放一致；解释器改变要进入版本纪律。投影缓存是可重建状态，存在缓存不等于有第二个权威事实来源。

agent/UI 从共同投影读取，同时携带截止序号；不同读取时点不保证字节一致。单 subject fold 的过滤也不能隔离物理日志的损坏：当前完整 open 先重放所有 subject，可能在读取目标之前就失败。写路径整体拒绝与只读诊断的隔离范围必须写清。

### U07 · P2：注册失败不能改变协议，未知 key 必须真被拒绝

**实测反例。** [ruleFor](/home/ROXY/code/singularity-core/src/protocol/registry.ts:127) 对 `toString`、`constructor`、`__proto__` 返回继承属性，没有产生 `unknown-kind`。使用只包含显式键的映射或 own-key 判断，使合法 ID/kind 不受 JavaScript 对象原型影响。

另外，[declare](/home/ROXY/code/singularity-core/src/protocol/registry.ts:90) 先修改 G3 owner，后续遇到非法 guarantee 才拒绝；失败声明会留下未注册的 owner。声明和领域提交都应遵循“全部校验成功后才发布状态”，拒绝保持之前状态。

## 4. 补查 RRSI：闭环验收不能停在 edits 透传

### R01 · P1：轮次、候选数与试验数分开

上游每轮有 m 个候选，每任务有 k 个 trials。旧仓 [StrategyPolicy](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/policy.ts:18) 也使用这一区分；蓝图“k=2 候选”的符号应避免与独立重复数混淆。

旧仓 [historyFactsOf](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/method-shared.ts:558) 用候选 index 充当 round，[decision](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/observe.ts:195) 用 history entry 数充当 round。多候选、一个 bundle 多 edit 或重测都会破坏退火和停滞窗口。

显式 round 应冻结本轮 incumbent、候选集合、预算、历史截止范围和测量上下文。候选并行起草于同一 incumbent，结束时统一选择；不能先测 A、发布 A，再把 B 当作同轮候选。所有槽位都有完成/拒绝/未测原因后结案；无胜者也要记录本轮轨迹。

### R02 · P1：可比测量口径与一次双侧评估身份分开

当前 [cohortDigestOf](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/observe.ts:67) 包含 baseline revision 与 overlay，而 [foldHistory](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/history.ts:69) 只聚合最新 scope。incumbent 正常升级就会换 scope；候选说明不同也可能使同轮候选无法比较。

最低需要区分：稳定的测量上下文（数据集/输入、契约、模型与环境、metric、weights、trial 计划和判断策略），以及带双侧版本与具体 trial 身份的 Evaluation。baseline revision 属于本轮对照身份；仅因方法更新，不应抹掉仍可解释的旧编辑历史。

口径改变时禁止把旧分数直接池化或拿来维护同一 S*；旧假设、轨迹和拒绝原因仍保留来源并可供 proposer 查阅。无需为此建立大量 scope 类型，两个真实用途足够。

### R03 · P1：冻结历史增益，正确维护 S* 和 incumbent 轨迹

上游 [loop 的历史记录](/home/ROXY/code/rrsi/rrsi/loop.py:320) 保存每个候选相对当轮 H_t 的 ΔS/ΔC，[S* 更新](/home/ROXY/code/rrsi/rrsi/loop.py:335) 基于被采用的 H_{t+1}。

旧仓 [foldHistory](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/history.ts:107) 用最新发布版本重新计算所有旧候选增益。**实测：** A=0.6、B=0.8 时，发布 B 前 B 的 Δ=+0.2；发布 B 后 B 的 Δ=0，A 的 Δ=-0.2。历史发生变化会扭曲收益归因、剪枝与停滞判断。

同一函数的 [bestQuality](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/history.ts:156) 包含所有测量候选。**实测：** B 因成本被拒绝后，bestQuality 仍为 0.8。该字段不能直接作为上游 S* 使用，否则一个不能采用的高分候选可能抬高后续准入底线。

轮次事实冻结 baseline/candidate 分数、当轮差值和选择结果；从冻结引用重算，不对今天的 head 重新求差。保持 `admissible / selected / published / consumed` 的区别。Singularity 有人审，建议实际 published 成为下一轮 incumbent；选择结果单独保留。S* 的更新据此明确，有意分歧用反例钉住。rollback 改变 active head，不能改写当时的选择和发布历史。

### R04 · P1：实际生产决策仍使用空历史，F1 范围不足

**源码确认。** [recordDecision](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/method-shared.ts:498) 调用 [deriveDecision](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/method-shared.ts:688)，后者构造空 HistoryFacts，`bestQuality = 本次 baseline quality`，只用本次 baseline 校准噪声。因此 F1+F3+F3b 即使完成字段透传，仍不会让真实历史参与生产选择。

决策需要冻结实际 history/frontier 截止范围与 calibration 来源；proposer 也需要读到历史中的假设、差异、失败/成功轨迹及来源引用。仅把几个派生列表写进提示词不能证明完整编辑历史已消费。

验收在至少两轮中进行：第一轮发布后，第二轮生产决策和提案确实读到第一轮事实；重放同一截止范围生成相同决策。不能重新传空 history 获得一份可重算的记录便宣称接通。

### R05 · P1：声明编辑需要真实改动核验，保留探索与剪枝消费者

保持 asset kind 与 search mechanism 的定义清楚。Singularity 的可进化范围可以限定在模板/Skill/Tool；不必为匹配上游九类组件扩大产品范围。词表中的每个值应有真实修改和核验路径。

`edits` 是可归因的独立变更，不是改动行数或文件数。验证适配器绑定基准、候选完整 diff 与真实 targets；不能由 proposer 自填 `mechanismUnverified: false` 获得结构性标签。critic 通过也不能替代结构核验或独立验收。

novelty 数不同结构机制类型：两条 skill edit 的 novelty 仍可能为 1；两类此前未接受的结构机制才是 2。未测量/screen 拒绝不进入 measured/tried/yield；已测但未采用仍保留其假设和结果。

停滞后 reserved exploration slots 应实际约束候选生产，并有失败反例；剪枝建议应真的能产生移除已接受结构的候选并重新评估。若暂未实现，阶段交付注明其边界，不把派生字段存在写成能力完成。

### R06 · P1：trial 身份、固定槽位、缺失与噪声来源

每个 trial 有稳定身份和独立执行证据；调用方的 `repetition = 2` 不能制造三次求解。旧仓 [evaluate 的已有报告短路](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/pipeline/evaluate.ts:119) 与 repetition 计数不能作为真实重复的实现。

一个 Evaluation 可以拥有多次 trial 与多个尝试，但最终报告只对应一个冻结计划和固定槽位集合。同一请求重试不产生新重复；明确重测保留新 Evaluation/attempt 身份，不覆盖旧结果，不挑最好一次报告晋升。

**实测反例。** [aggregateEvaluation](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/measure.ts:36) 对 `trials=2, missing=1`、实际只含一个质量 1 的观测返回 quality=1、expected=2、incomplete=true。missing 计数本身不会补足分母。生产者必须依据冻结槽位和权重显式表示缺失观测，或聚合器直接依据该槽位计划计算；不能靠注释保证。

缺失质量按冻结策略计 0 与分母保留，是显式评价规则；未知成本仍保持 unknown。测量数值、单位、方向、归一化、硬约束和缺失策略由领域提供真实执行器。禁止候选自述数字或把命令只交给 LLM 阅读。

上游允许配置固定 delta，或通过 baseline trials/bootstrap/repeated evaluation 校准，见 [README](/home/ROXY/code/rrsi/README.md:53)。Singularity 要求更多独立重复是有意收紧，不应误写成上游唯一规则。冻结校准出处，区分实测噪声与 declared floor；bootstrap 重采样不是新模型运行。A/A 未改动对照、任务配对、并行资源限制与模型实际身份必须能查证。

### R07 · P1：选择、人审和重检必须使用同一份冻结依据

按同轮共同 incumbent、口径、策略和噪声，对全部候选做 admissibility，再从可采用候选中选优。高分但违反任一硬约束的候选不进入 argmax。无胜者保留 incumbent；同分有明确的确定性处理；恢复后与完成顺序无关。

选择事实保留每个候选报告、拒绝原因、winner、策略版本、历史截止范围和噪声依据。发布前重算原决策，检查 active head 与 expected generation，重新验证批准所绑定的具体内容。重检若生成了不同实验依据或变更 winner，应形成新决定，不能借旧批准发布。

旧仓 [guards.bound 被直接标真](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/pipeline/validate.ts:187) 和未接线的 `assertStrategyDecisionRecomputes` 是必须关闭的口子。策略纯函数的重算保证不覆盖文件内容、实际身份和原始测量的验证。

### R08 · P1：实验隔离、发布后消费与真实收益

Bubble 需要明确输入快照、方法内容、工具实现/依赖/工具链版本，以及模型实际身份和可观测外部条件。只固定 Skill 文本或 MCP 定义，不能保证背后的 Tool 实现没有变化。git clone 的工作区分离也不能独自证明缓存、可写挂载与外部服务状态隔离。

明确 Graph 与 Bubble 的生命周期：Graph 若跨轮存在，则每轮/候选执行实例绑定自己的 bubble；若每个 bubble 有独立 Graph，则保留实验血缘。目录嵌套本身不能定义“graph 在 bubble 里”。先实现当前实验实际需要的隔离，不建设通用沙箱平台。

RRSI 搜索使用的 evolve 集、发布前回归集和独立留出/OOD 任务分别记录。被反复反馈给 proposer 的数据已进入搜索，不应继续宣称为未使用的留出证据。TaskTemplate 候选不得通过放宽验收取得提升。

发布后的新 Run 必须实际加载/调用所宣称的方法，凭证记录具体版本及消费来源。只证明 Run 钉住某 revision，不能证明其中某 Skill 或 Tool 被使用。消费反馈纳入后续诊断；一次普通任务成功不能单独构成因果收益证明，还需要同口径对照。

### R09 · P2：上游一致性、产品收紧与收益分别验证

上游 [带内成本规则](/home/ROXY/code/rrsi/rrsi/selection.py:90) 使用 novelty 项；Singularity 当前 [costRule](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/strategy/selection.ts:65) 有意取消它，收紧成本上限、拒绝未知成本，并增加确定性 tie-break。保留这些选择可以合理，但需作为显式策略及对应测试。

对第一轮 novelty 风险作精确限定：恒值确实污染记录和搜索信息；当前 m=1 的准入不会因 novelty=1 单独放宽成本规则。接入多候选后，它会影响该实现的同分排序。不得用这个常数单独证明已经错误发布。

现有 [向量提取脚本](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/tests/vectors/extract-rrsi-vectors.py:4) 区分 upstream-native 与 port-adapted；其中 history 向量注明了 [单个冻结 incumbent 的移植口径](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/tests/vectors/extract-rrsi-vectors.py:414)。同规则的 Python/TS 两份实现相等，不足以证明跨轮语义等同于上游。

后续验证分三层：上游同输入的差分向量；有意收紧的独立反例；真实两轮/多候选/崩溃恢复的闭环场景。真实收益再用冻结任务集、相同模型配置与预算比较 H0/发布方法，必要时做 history/noise/成本规则的对照，避免把“函数已接线”当成“正则化有效”。

## 5. 建议执行顺序与蓝图决策

| 阶段 | 交付 | 必须达到的退出条件 | 对应原阶段 |
|---|---|---|---|
| A：提交与协议适配 | 专用控制 store、DSH 承载实验、串行提交、严格边界、命令结果识别 | 双进程互斥；并发命令正确；屏障失败不成功；提交后答复前崩溃可识别原结果 | 修订 S3′，处理 F01/F02、U01—U04/U06 |
| B：真实执行纵切 | 最小 E3、Task 分解与责任、初始不可变 Revision、最小 Bubble、真实 verifier 与固定来源 receipt | 根/子任务执行与依赖推进；产物独立验收；SIGKILL 后恢复同会话、责任与绑定 | 最小 S4/S8，加原计划缺失的 E3/Task 主路径；K1 |
| C：可信评估 | 冻结双侧输入、真实领域取数、非补偿约束、真实重复与噪声依据 | 好候选通过；高分但越界拒绝；缺失分母正确；每份报告有真实 trials | S6 的评估部分，提前 S9；处理 R02/R06/R08 |
| D：受控发布 | draft 状态机、E6 原生审批、决定重算、唯一指针切换 | 批准绑定具体差异；陈旧/内容变化拒绝；head 不引用半成品；重放恢复一致 | 完整 S4/S5/S6，处理 U05/R07 |
| E：RRSI 闭环 | 显式 round、真实历史与 frozen deltas、m≥2 选优、探索/剪枝消费者、消费反馈 | 至少两轮完整执行；保留与失败能结案；第二轮读第一轮；历史不被新 head 改写 | 修订 S7；K2 |
| F：替代旧栈 | 关键行为回归、固定领域任务集对照与部署替代 | 恢复/边界行为满足新契约，真实质量和成本满足冻结标准 | 最终替代检查点 |

下一次重要审核在 A+B 完成时提出，不必等完整多组拓扑或多候选搜索。协议作用域与 RRSI 数据身份现在确定，搜索实现等可信评估后完成。若 A 的扩展事件承载实验失败，先修订适配契约，不向 B 叠加功能。

| 蓝图 §7 的问题 | 审核建议 |
|---|---|
| 三层划分 | 保留职责分层；纯领域规则、DSH 适配器、副作用编排均有明确边界，逐项核实上游保证 |
| E3/E6 重建或复用 | E3 复用 DSH 生命周期和已有行为，重建必要领域边界；E6 接原生审批；不依据包数决定全量重写 |
| S7 是否插队 | 实现留在可信评估之后；轮次、历史、消费与决定依据的数据契约先确定 |
| storageDomain | 当前无真实用途就不预建；以后按跨图共享需求与所有权选择，不依据现有目录名决定 |
| 旧仓去留 | 冻结为行为参照，必要维护独立处理；新闭环和关键回归完成后归档，不迁移只约束旧包结构的测试 |

F1 还须修正：生产 history consumer 一并接通；两条 edit 不等于 novelty=2；已冻结/分发的格式增加必填字段使用新版本。无旧数据可以直接拒绝旧格式，无须因此引入兼容层。不能由“本机没有旧账本”推导“已分发的同版本格式可随意改变”。

## 6. 下次检查点与交回材料

### K1：DSH 提交路径 + 真实 Task 执行/恢复纵切

在这一检查点审核控制与执行边界，防止把一套纯协议测试误当作产品已经可运行。

| # | 验收场景 | 必须观察到的结果 |
|---|---|---|
| 1 | 独立进程重开控制 store | 自有扩展事实可解释；未知版本/kind/字段具名拒绝；不占用 agent 的第二个 transcript 写句柄 |
| 2 | 两个进程竞争、杀死持有者 | 第二写者拒绝；持有者死亡后后继获得所有权 |
| 3 | 同进程并发准入或更新 | 正确串行结果，无重复序号；同一 expected head 的冲突恰好一方提交 |
| 4 | 持久化屏障失败；成功提交后答复前杀进程 | 前者不返回成功；后者重送同命令可识别原结果，ID 内容冲突拒绝 |
| 5 | 身份伪造与协议非法输入 | agent 无法声明验证器/审批者身份；未知字段、错误类型、原型 key 与拒绝声明不污染状态 |
| 6 | 根节点提出并执行分解 | 两个真实子任务有明确依赖和执行责任；责任转移后原节点不能继续同项工作 |
| 7 | 真实验证器处理具体产物 | pass/fail 均来自实际执行及固定产物；换掉产物、输入或验证器实现后旧 verdict 不放行 |
| 8 | 准入后方法版本更新 | 在途 Run 保留原版本；新 Run 使用明确选择的版本；同 ID 内容覆盖拒绝 |
| 9 | 在执行和结算边界 SIGKILL | 恢复同一 session/身份/责任；已提交结果不重复创建或结算，外部不确定操作明确呈现 |
| 10 | 子任务失败或耗尽既定预算 | 失败/停止如实传播，父任务不会提前完成或隐式扩大预算 |
| 11 | 完成后追加会话消息、卸载当前验证器 | 固定来源 receipt 摘要不变；历史按受支持版本重放；新执行的缺少实现拒绝与历史读取分开 |
| 12 | agent、API/UI 读取同一已提交截止范围 | Task 状态、证据与完整性相符；未启动 Task 不显示失败；读路径不追加或启动工作 |

使用真实 DSH session 与验证器，边界故障注入可以采用受控 fixture。真实模型调用应有至少一条小任务冒烟；断言确定性不依赖模型恰好输出某句话。若实际部署需要 group/router，把唯一公开端点和同会话恢复纳入 K1；无当前消费者的完整嵌套组能力不作为提前建平台的理由。

### K2：受控发布 + 至少两轮 RRSI

1. 同轮至少两个候选从同一 incumbent 出发，统一选优；高分但违反 guard 者拒绝，合格者能经批准发布，无合格者保留原版并结案。
2. 同分规则、真实重复数、fixed denominator、成本 unknown、declared floor 和 A/A 对照都有反例。
3. 第二轮 proposer/decision 消费第一轮完整历史；冻结 ΔS/ΔC 不随新 head 改写，未采用高分候选不被误作上游 S*。
4. 两条同机制 edit 与两条不同机制 edit 的 novelty 不混淆；reserved slot、剪枝候选和真实改动核验有消费者。
5. 在候选评估完成、选择完成、批准后、指针提交后分别崩溃；恢复到同一轮次与结果，不制造额外独立 trial，不借旧批准发布新内容。
6. 新独立 Run 真的消费发布方法，记录消费证据并回馈下一轮；独立留出任务提供迁移效果证据。

### 构建方交回材料

- 固定的代码提交、DSH/RRSI 版本与运行环境；各 F/U/R 项的处理状态及对应实现/反例测试。延期项写明其依赖功能是否仍未启用。
- 更新后的 blueprint：作用域、权威写入表、版本纪律、阶段依赖与退出条件；不要把本文建议未经实现直接改标为已完成。
- `pnpm verify` 及新增集成/恢复测试结果；一条真实任务的 command/run/session/revision/产物/验证/receipt 来源引用；故障点与重放结果。
- K2 再提供两轮原始 trial、冻结 plans/reports/decisions、指针与批准事实、实际消费证据。缺失项保持明确缺失，不能用“全绿”或调用次数替代。

## 7. 反例记录与快速复核

第一轮探针均在临时目录或临时副本执行，未修改产品源码。以下记录用于建设回归，不要求保留已决定删除的文件存储实现。

| 编号 | 输入/操作 | 已观察结果 | 对应项 |
|---|---|---|---|
| E01 | DSH 校验 `plugin:singularity:event`，分别缺席/携带 ignorable | 前者 `SessionFormatUnsupportedError`；后者接受 | F01 |
| E02 | 同一空 ProtocolLog 并发两次 emit，重复三轮 | 两次 fulfilled，磁盘 `[0,0]`，重开 `chain-broken` | F02 |
| E03 | 用验证器名称填写 actor，提交 pass，无产物引用 | Run 可以 verified | F03 |
| E04 | 合法 Task 日志换用空当前验证器 registry 重开 | `unregistered-verifier` | F04 |
| E05 | 临时副本增加 default fs import 写者、comment-only 导出引用 | 7/7 门禁通过 | F06 |
| E06 | unknown contract/payload 字段、`detail:123`、无 Run 的已准入 Task | 字段接受，detail 变空串，Task phase=failed | F06 |
| E07 | digest 输入 NaN/null、undefined/缺字段 | 各对摘要相同 | U02 |
| E08 | unknown kind 为 toString/constructor/__proto__；声明先 G3 后 G9 | 继承属性被返回；失败声明留下 G3 owner | U07 |
| E09 | A=.6、B=.8，发布 B 前后对同一历史投影 | B Δ从+.2变0，A从0变-.2 | R03 |
| E10 | B=.8 被成本拒绝，A=.6 为已发布版本 | bestQuality 仍为.8 | R03 |
| E11 | B Evaluation 换 scope，其余候选历史不变 | A 从 measured=true 变为 false | R02 |
| E12 | 计划2 trials，missing=1，仅提供一条质量1观测 | quality=1，expected=2，incomplete=true | R06 |

DSH 词表复核（读取基线构建产物，不创建会话或修改词表）：

```sh
cd /home/ROXY/code/bb_work/harness
node --input-type=module <<'NODE'
import { validateStoredEvents } from './thirdparty/deepseek-harness/packages/session/session-persistence/lib/types/storage-contract.js'
const event = { type: 'plugin:singularity:event', seq: 0, time: 0, data: { protocol: 'task', version: 1 } }
for (const ignorable of [false, true]) {
  try {
    validateStoredEvents({ id: 'review-probe' }, [{ ...event, ...(ignorable ? { ignorable: true } : {}) }])
    console.log({ ignorable, result: 'accepted' })
  } catch (error) {
    console.log({ ignorable, error: error.name })
  }
}
NODE
```

RRSI 历史与缺失分母复核（直接运行已审查的 TS 源码，无 I/O）：

```sh
cd /home/ROXY/code/bb_work/harness/packages/singularity
node --input-type=module <<'NODE'
import { foldHistory } from './evolution/src/strategy/history.ts'
import { DEFAULT_STRATEGY_POLICY as policy } from './evolution/src/strategy/policy.ts'
import { aggregateEvaluation } from './evolution/src/strategy/measure.ts'
const measurement = (quality, scope = 's') => ({ scope, trials: 1, missing: 0,
  tasks: [{ taskId: 'task', trials: [{ quality, weight: 1, tokens: 100 }] }] })
const candidates = ['A', 'B'].map((id, round) => ({ candidateId: id, libraryId: 'L',
  contentDigest: id, round, edits: [{ id: 'e' + id, mechanism: 'skill', targets: ['skill'] }] }))
const evaluations = [0.6, 0.8].map((quality, index) => ({ candidateId: ['A', 'B'][index],
  scope: 's', measurement: measurement(quality), verdict: 'pass', evidenceRefs: ['eval-' + index] }))
const facts = { candidates, evaluations, consumption: [], refutations: [],
  versions: [{ round: 0, libraryId: 'L', revisionId: 'rA', contentDigest: 'A' }] }
const view = value => foldHistory(value, policy, 2)
console.log('before B', view(facts).entries.map(e => [e.candidateId, e.deltaQuality]))
console.log('after B', view({ ...facts, versions: [...facts.versions,
  { round: 1, libraryId: 'L', revisionId: 'rB', contentDigest: 'B' }] }).entries.map(e => [e.candidateId, e.deltaQuality]))
console.log('rejected B bestQuality', view({ ...facts, refutations: [{ candidateId: 'B',
  contentDigest: 'B', round: 1, reasonCode: 'cost-rule-failed', reason: 'cost', evidenceRefs: [] }] }).bestQuality)
console.log('new scope', view({ ...facts, evaluations: [evaluations[0], { ...evaluations[1],
  scope: 'new-baseline', measurement: measurement(0.8, 'new-baseline') }] }).entries.map(e => [e.candidateId, e.measured]))
console.log('missing slot', aggregateEvaluation({ scope: 's', trials: 2, missing: 1,
  tasks: [{ taskId: 'task', trials: [{ quality: 1, weight: 1, tokens: 100 }] }] }))
NODE
```

这些反例描述审核基线，不要求新实现保留相同 API。修复后的验证应断言业务不变量，而非仅断言代码已经多传一个字段。
