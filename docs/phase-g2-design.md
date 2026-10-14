# G2：任务、审核与运行合同

日期：2026-10-14。当前协议 Task v10、Review v1、snapshot v6。
用户裁定见 [context.md §18](context.md#18-g1g2-接手审核与用户裁定2026-10-11基线-35b0c7c)；剩余顺序只在 [assembly-blueprint.md §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 维护。

## 1. 不可降低的行为合同

| 项 | 合同 |
|---|---|
| Task | 目标、冻结输入来源、交付物、稳定标准；模板是可选来源 |
| Run | 一次完整求解；直接固定方法 Revision，Bubble 保存执行快照；同 Task 一个未结算 Run |
| ReviewRun | 独立身份和 Session；固定审核对象、输入、标准、证据引用和逐条判断 |
| 失败 | fail 判断完成审核；审核运行失败另记；单次 Run 失败不立即关闭根 Task |
| 分解 | 一次性契约直接调度；子责任有独立交付和标准，并支持父标准 |
| 依赖 | 只有 verified 封存产物解锁输入；child 支持不生成父 pass |
| 会话 | 从持久责任解析准确父，恢复同 Session、Run 和工作区；内存只持有资源 |
| 读面 | 工具、API、UI 同一 committed cut；读取不执行、不调度 |

## 2. 最小领域模板与输入产物

TaskContract 只含 `goal / artifact / inputs / criteria / template?`。criterion 只含 `criterionId / statement`；审核节点决定如何取证、执行检查并逐条判断。部署受保护 checker 固定要求及实现；测量另存 verifier ref、version、implementation digest，不能因精简 Task 丢掉可比性。

输入来源为部署冻结引用或明确依赖 Task 的封存产物。上游摘要在其完成前未知；契约固定来源，Run/Bubble 开始前绑定准确附件和摘要。源工作目录之后的变动不改变已授权字节；缺失、摘要不符或错误 producer 明确拒绝。

模板提供可复用 goal、applicability、Skill/Tool 绑定和直接孩子 recipe；其来源摘要可查。一次性调查、报告或取证任务无需模板、方法 Revision 或资产审核。调查可以用证据否定假设；调查完成和优化目标达成分别判断。

## 3. 计划权限与发布

模型声明 batch key、可选 template 或一次性 contract、dependsOn、supports、maxRuns；宿主稳定派生真实 Task、Agent、Session ID。当前 Task、Run、角色和 caller 由宿主绑定。

完整权限、标准关联、输入来源、DAG 和尝试预算先校验，再准备并发布一份完整计划事实。相同输入和契约的祖先责任不得通过新 ID 或模板 provenance 再次生成；不加入自然语言语义进度审核器。责任内的小实验直接执行。

合法准备中断后按稳定身份恢复；未发布准备项不可调度。多个 append 不宣称跨进程原子事务，不建第二份计划或工作流存储。子任务继承父 Run 的方法版本，不能由普通执行节点切换方法。

## 4. Run、提交与独立审核

开始前校验责任、依赖、方法、输入和预算。Bubble 冻结输入附件、模型、工具、工作区及作用域；Run 不再创建一份执行 Environment Revision。

执行者写工作区产物，再以相对路径提交。宿主关闭写准入并 drain，冻结实际字节和原生 transcript 前缀，以 `run/submitted` 原子记录提交，进入 `working → submitted` 的唯一阶段路径。缺失文件、修改输入、持久化失败、取消与执行异常不返回成功空结果；恢复读取相同封存字节和检查。

每次提交创建独立 ReviewRun，执行者不能审自己的产物。ReviewRun 固定精确对象、criterion 和独立会话；review.json 必须逐条给出 judgment 和证据引用。protected fail 不能被覆盖为 pass。审核可分解取证 Task，后者各自独立审核；ReviewRun 本身不创建审核审核者。

审核的 fail / partial / unknown 都是有效完成的判断；运行失败有独立 failed 事实。调查的负结果保留。父节点必须消费已审核子证据并完成自己的集成与验收，不能把 child support 当父结论。

## 5. 调度与 DSH 固定端口

使用公开 create/resume、followup、whenIdle、flush、drain、close。三个角色分别挂载 task / review / improve preset，保留原生编程能力；不合并父角色的治理工具。执行面只给读取、分解、提交、重试和绑定方法执行；审核只给读取、取证分解和判断；RSI 只给读取、候选和测评。

默认上下文只含当前契约、冻结输入、相关方法摘要和完成依赖引用；完整方法、产物及轨迹按需读取。不可把完整方法目录、轨迹和治理长提示推给每个节点。

首消息和重试反馈从冻结契约及真实结论生成；decompose 投递即返回。普通验收失败在 maxRuns 内继续同一 child 会话的新 Run；耗尽或依赖阻塞通知准确父。原生会话 idle 不等于 Task 成功；根 agent 在回合内可重试失败 Run，静默后由宿主关闭终局。

Run 的原生 turn/error 与准确责任会话关联；不可借最近 caller 推进别人的子树。错误传播给消费者，disposer 归创建者；卸载撤销准入、取消/排空并关闭自管会话，Web 根由宿主拥有。

## 6. 封存、恢复与只读面板

正式 receipt 固定目标 Run 的控制事实截止、实际 Session/transcript 截止与内容引用；完整连续合法前缀均校验。后续聊天和无关事实不能改变正式凭证。snapshot v6 同 cut 展示 Task、ReviewRun、计划、closure、RSI、round 请求、测评、发布和消费；会话引用直接连接原生面板。

根关闭后先返回业务结果；后台等待相关会话静默并 flush，再封存完整成功/失败轨迹和成本，启动 RSI。evaluation 根不递归 RSI。预算不足记录 skipped 原因，不加预算、不宣称已完成。

测评工具只提交持久请求并立即返回引用。宿主从已有 measure / strategy / release 事实继续 trials、决定与最终发布审核，通知复用带身份的原生消息；无需模型重发长调用。发布要求准确 independent witness 和 expected head，seed 直接初始化指针。候选不经独立资产准入审核，结构、绑定、工具样例和受保护边界检查后进入隔离测评。

| 崩溃窗口 | 必须证明 |
|---|---|
| 计划准备中、未发布 | 不执行半计划，同一合法准备可辨认 |
| Run 开始、投递前后 | 同一 Run、Session、冻结工作区与来源 |
| 提交、审核途中 | 同一封存产物、ReviewRun、检查与逐条结论 |
| 测评途中 | 复用完成 trial，恢复未完成对象与相同请求 |
| 决定、发布途中 | 同一决定和审核，唯一指针不重复切换 |
| 卸载途中 | 后台等待可中断，错误可观察，无遗留写租约 |

## 7. Spec 顺序与产品证据

协议、装配、投影与必要检查同步修改；反例验证不可自审、负审核完成、取证结束、父消费子产物、祖先重复拒绝、角色工具隔离和持久边界恢复。新协议明确拒绝旧解释，历史记录只读。

build / tests / gates / mutation 与离线探针证明工程边界，不证明真实模型 RSI。先取得小领域真实“候选→双侧独立测评→决定”；无赢家允许闭环。随后按冻结 SHA256 范围和累计预算运行。只有真实发布且后续 Run 实际消费该版本，才能证明方法更新有效。

## 8. 原 G2 变异记录的证据边界

以下仅保留现有门禁要求的历史查找标识；编辑与 witness 在 mutation baseline。它们不证明新合同已实现，
被替换规则的变异在对应实现提交更新/删除，不能为旧绿色结果保留陈旧限制。

| 历史 claim | 对应范围 |
|---|---|
| `mutate:assembly-m24-plan-belongs-to-holder`、`mutate:assembly-m25-transfer-belongs-to-holder` | 计划/交接责任 |
| `mutate:assembly-m26-parent-waits-for-a-running-child` | 旧 startRun 闸，不覆盖新的完整求解写闸 |
| `mutate:assembly-m27-initial-source-not-overwritten`、`mutate:assembly-m29-staging-writes-the-loader-bytes` | 初始/输入字节 |
| `mutate:assembly-m28-one-input` | 每模板单输入的闭合 name/source 合同 |
| `mutate:runtime-m30-seams-resolve-through-get` | Cordis 服务解析 |
| `mutate:assembly-m31-children-own-their-tasks`、`mutate:assembly-m32-advance-after-settle` | 子 Task 归属与前序结算后的依赖启动；完整产品链另验 |
