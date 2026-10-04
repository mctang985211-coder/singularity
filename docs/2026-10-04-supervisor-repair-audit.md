# Supervisor 真实运行阻塞审计与修复

三名 GPT-6.1-sol xhigh 子代理分别审计 recipe 晋升、criterionRepair 和协调会话模板读取，并继续核查真实运行暴露的引用和计量接线。实现基于 c436d9d，在独立工作区完成。

## 审计结论

| 报告 | 结论 | 处理 |
| --- | --- | --- |
| 叶子 holdout 无分解，导致 recipe 晋升必败 | 成立。晋升原先要求所有样本的每一侧消费目标 recipe；旧 DAG 测试强制叶子 holdout 分解并预写种子，掩盖了冲突 | 保留至少一个历史 verified holdout；受影响样本两侧必须真实消费 recipe，未受影响的叶子仅承担回归检查 |
| 缺失 stage 的子判据无法修复 | 不成立。原正反例复现使用固定独立父判据，不使用损坏的旧子判据 | 新增真实 command verifier 用例，证明旧子判据对正确产物仍失败时修复可以晋升；不放宽守卫 |
| 损坏的独立父判据可以在同一实验中自行修复 | 当前契约不允许。候选不能同时改答案和最终裁判，再用自己的裁判证明正确 | 保持拒绝；父验收需要纠正时，使用已有 Task intake 建立具有明确验收的新合同，保留旧 Run 历史 |
| Supervisor 没有业务 Run，因而不能读模板 | 在 c436d9d 生产接线中不成立。已有 templateCaller 接受有效协调委派，Supervisor grant 已含 task_template_list；live fixture 漏挂委派读取来源且过滤掉此工具 | 删除专用模板 read/glob/grep 通道；fixture 挂生产委派来源，使用唯一 task_template_list 入口 |
| Reviewer 不能读模板 | 成立。其 grant 缺少 task_template_list | 加入只读入口，沿用委派 Task scope；无业务 Run 可读取，越域仍拒绝 |
| 引用格式与目标词汇令 Reviewer/Supervisor 难以衔接 | prompt 确实未精确区分引用类型，且未明确 task_definition 是 TaskTemplate 的可执行类型 | 给出实际源 review ref 的有效 JSON 示例，明确各引用字段格式，统一模型可见目标词汇；保持全部引用校验 |
| 本轮实测：task_verify 在错误目录自检 | 成立。candidate 已在重放目录生成正确报告，直接 checker 通过，task_verify 却在原 graph env 执行，错误报告 report.mjs 不存在 | 删除工具自己的 graph/env cwd 解析，复用 runtime 已有会话工作目录入口；验证原图与 replay 的相反产物不会串判 |
| 本轮实测：裸 diagnosisId 提案关联丢失 | 成立。工具说明允许裸 id，propose 原样写入；supported-source、handoff 和 recovery 只认 diagnosis: 前缀，导致检查和通知漏关联 | 在唯一 propose 写入入口把当前图的真实已知诊断规范为 diagnosis:<id>，消费者不增加第二种解析；覆盖持久化、handoff、成功源检查与恢复守卫 |
| 本轮实测：声明 token 预算却无 token 消耗证据 | live fixture 漏装生产已有的 TokenMeter；文本回复还输出模拟 usage。decide 拒绝无法测量的预算正确 | live 加载真实 TokenMeter，文本与工具回复都记录真实网关 usage，缺失用量不冒充零；不放宽预算守卫 |
| 本轮实测：新 root 的子节点读到旧图合同 | ScriptedLoop fixture 的 sessionRoot 只登记 roots，没有继承 spawn 父会话归属；所有未知会话退回 primary root | 在现有 spawn 记录入口继承父 root，在启动 worker 前完成映射；新增两个 root 的模板 scope 与 Task store 隔离回归 |

recipe 晋升只改变适用范围：历史子树消费过目标 recipe，或任一重放侧消费了它的样本，需要两侧各自匹配冻结版本、工具调用、准入 proposal、批次、子合同和边。候选 recipe 至少一次严格消费；仅给子任务写上 templateRef 不能冒充。叶子 holdout 的模型绑定、独立验收、输入、预算和回归判定继续执行。没有新增叶/协调者实验类型或零 holdout 路径。

修复模板判据时，应重放使用该模板的负责父 Task，并用其未改变的独立验收评价子模板。若把损坏判据所在的 Task 本身当作最终 oracle 样本，修复就会被自己的旧判据阻塞；这不是允许候选替换最终 oracle 的理由。正反例也必须来自相同父验收，不能把不同 stage 的成功叶子冒充该父 oracle 的正例。

第五次运行的精简证据保留在 `2026-10-03-live-supervisor-repair.json`。它包含失败协调者、成功叶子及重放图状态，但未保留完整 Evolution 工具返回，不能仅凭该文件独立确认逐次调用、6/6 gate 或此前 Reviewer 的 1/3 成功率。新 live fixture 的失败落盘增加实验 verdict、双侧结果和 Evolution 工具返回；新运行写入单独的 `2026-10-04-live-supervisor-repair.json`。模型选择也按实际网关 provider/model 绑定，不再记录为 mock。

## 验证

- DAG 回归使用真正不分解的叶子 holdout；覆盖晋升、审批发布、仅新 Run 重规划、缺 holdout 拒绝、双侧消费证据篡改拒绝、历史受影响样本绕过拒绝和 holdout 退化拒绝。
- criterionRepair 覆盖缺失 stage 的旧子判据、损坏的父 oracle 拒绝、历史正例的当前输入不再通过 oracle 时拒绝。
- 委派 Reviewer/Supervisor 无业务 Run 的模板摘要和 exact templateRef 读取通过；Worker 与 Reviewer 对 scope 外模板的访问继续拒绝。
- 引用类型混淆继续拒绝，不把格式不合法的诊断自动转换为有效证据。
- 自检与最终提交使用同一 replay 工作目录；原图坏/replay 好与原图好/replay 坏的真实 verifier 回归均通过，证据属于 replay Run，历史 source 和原图产物不变。
- 已知裸诊断只在写入时规范化，重新打开 ledger 后关联不丢失；无法以裸 id 绕过成功源支持检查或未应用变更的 recovery 守卫。

最终 Singularity 完整单元套件 2290/2290 通过。加入双 root fixture 修复前，完整集成套件 647 通过、9 跳过、0 失败。修复后串行完整集成为 647 通过、9 跳过、1 项取消流程断言间歇失败；该文件单跑 6/6 通过（live 验证默认 opt-in）。自检工作目录的针对性单元与集成检查 46/46 通过；双 root 隔离文件 7/7 通过。build、持久化 schema 检查、源码行数检查与 git diff 检查通过，484 个源文件各不超过 2000 行。

live spec 必须检查全部 assertions，并验证 Supervisor 会话确实通过生产 task_template_list exact templateRef 读到目标完整模板。不能只记录 JSON 中的 false，却让 Vitest 通过。

新输入必须留下 admitted v2 recipe proposal、实际 child consumption，并忠实保留已发布 recipe 的每条依赖边；仅绑定 v2 和产物通过不足以证明 recipe 被使用。发布内容必须等于已评估的冻结候选。闭环证据按最终 applied proposal 检查七工具与 ledger 序列，允许模型放弃未通过晋升的早期提案。未完成实验不能重建完整报告，失败落盘保留其已完成 sides 和原始错误。

首轮 all-real 实测的 Reviewer 通过严格校验，定位 recipe 顺序缺陷并提出 task_definition；Supervisor 通过生产模板入口读取完整内容，一次空文本回复后由既有中性继续提示推进到真实双侧重放。baseline 失败；candidate 的正确 report 被错误目录的 task_verify 多次判失败。停止该次运行以修复真实接线，证据保留在 `2026-10-04-live-supervisor-workspace-failure.json`。未将此运行计为闭环成功。

第二轮 all-real Reviewer 再次通过严格引用校验。真实实验的失败协调者 baseline failed→candidate verified，另一个成功样本和叶子 holdout 的双侧均 verified，gate 6/6。裸诊断引用使生产关联与 fixture 等待均失效，此外首个提案的 token ceiling 因缺投影被正确拒绝；模型自建了无该 ceiling 的替代提案。停止运行修复引用及装配，保留 `2026-10-04-live-supervisor-reference-failure.json`，未修改 live ledger 或计为闭环成功。

第三轮 all-real 已完成七工具链与审批发布，真实实验 fixed，未使用继续提示。fixture 随后在新输入开始前失败：它要求候选一定新增两条 dependsOn，而模型只调整了 recipe 顺序。当前串行调度下，顺序修复已经通过未改变的独立验收，生产没有要求必须采用特定修法。删除该测试预设，改为核验发布与冻结候选一致、新 Run 实际消费 recipe 并保持所有已声明的边。保留 `2026-10-04-live-supervisor-fixture-failure.json`，此轮仍不计为新输入闭环通过。显式依赖边的晋升、消费和篡改拒绝由 DAG 集成回归验证，顺序修复本身不证明并行调度正确。

第四轮 all-real 再次到达 applied；新输入阶段，fixture 把第二 root 的子会话落到了第一个 root 图，子协调者因此读取错误合同并失败。停止并保留 `2026-10-04-live-supervisor-lineage-failure.json`，修复 fixture 父 root 继承后，双 root scope/store 隔离回归 7/7 通过。未把这轮计为新输入闭环成功。

最终 all-real 运行通过，证据在 `2026-10-04-live-supervisor-repair.json`：真实 Reviewer 定位共享 recipe 顺序缺陷，Supervisor 自主完成 propose→candidate→prepare→replay→gate→decide→apply；失败协调者 baseline failed→candidate verified，两个真实叶子 holdout 双侧 verified；gate 6/6，审批 seam 发布 v2，v1 与原失败 Run 保持冻结。第二 root 在新输入下消费 admitted v2 recipe，三个叶子与根验收 verified，统计由 12 条重算为 8 条（INFO 4、WARN 2、ERROR 2）。21 项断言全为 true，全部 Run 绑定 Skill，未出现无关模板内容。模型为 deepseek/deepseek-v4.1-flash，202 次真实请求，774.138 秒，零继续提示。此次候选修复 recipe 顺序，无新增 dependsOn；只证明当前串行调度下的顺序修复收益。

live 验证仍使用测试装配和自动回答的既有审批 seam。bash 路径检测是 fixture 的普通命令检查，不是 OS sandbox；它不能证明任意 shell 程序无法访问外部文件。单次模型通过也不能证明 Reviewer 稳定成功率或长期净资源收益。

现有 token metrics 是会话累计值，实验未汇总 child Run 的 token 消耗；它不能证明整个执行子树的 token 总成本。此轮未改变计量范围，也未声称净资源收益。并行集成复跑还出现问答冷启动、恢复诊断等待或恢复错误措辞的间歇失败，恢复两个文件单跑 9/9 通过；这些失败原始报告随备份保留。整个 harness 的额外宽泛测试遇到与本变更无关的 agent-observer/external-agents 缺依赖；上述结果限定于 Singularity，不声称全仓或完整集成最终全绿。

只读模板入口继续使用当前委派 Task 的 catalog scope；整图证据可读不意味着把全局模板库或其他业务方向注入上下文。未新增第二套模板索引、recipe/holdout 类型、判据 bypass、消息讨论框架或错误重试系统。

源码与生成 lib 在同一轮提交。原工作区及其未提交文件保持原样；修复工作区提交不等于合并、部署或对外发布。
