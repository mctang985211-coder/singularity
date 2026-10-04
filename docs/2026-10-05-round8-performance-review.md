# Round8：长图调度与 Supervisor 链条评估

基线：Singularity `890521c239fc4946ba8d4571dea4c1a76c0384e7`，外层 `a2a0cea922d328a032b8b9a36c26a93b7b2178b6`；两库 round7 备份标签均已核实。外层合入 GitHub main 的两个既有提交，保留同步配置修正。

## Round7 证据的实际含义

- 第一份 `2026-10-04-live-xv6-supervisor-repair.json` 是失败记录：157 请求、3436.844 秒，第二 root 尚未执行。失败来自夹具预设子节点顺序。
- `2026-10-04-live-xv6-supervisor-repair-run2.json` 才是成功记录：248 请求、6712.517 秒、31 个断言通过、真实 grader 从 69/70 到 70/70。真实 Reviewer/Supervisor 完成模板修复、四侧重放、gate、审批、发布及第二 root 消费。
- 模型发布的是 fix-first 纯顺序 recipe，未发布非空 `dependsOn`。它证明现有串行执行下的模板修复，不能证明并行 DAG 的依赖修复。
- 实验预置参考内核修复。这次证明协调模板的改善，不证明模型自主完成锁优化、长期收益或修复成本回本。
- 两份旧 JSON 的 `total.turnsWithoutUsage=0` 均错误：phase/session 实际各有一个缺 usage turn。旧 token 数字只是已测量 turn 的合计。历史文件保留，当前 spec 修正总计及未知缓存桶；未结束 turn 仍不纳入完成 turn 用量。
- evidence 写入后曾发生清理超时，所以 JSON 的 `passed` 不能等同于 Vitest 正常退出。

## 最小修改

调度继续从 task store 读取事实；只在一次读取内建立索引。`batchItems` 单遍分配边，父 task/run 复用本轮快照，ready 节点按原批次顺序直接查找，结果汇总一次索引 task/run/evidence；latest run 从尾部查找，不再复制整表。删除原来的重复扫描，没有新增持久索引、scheduler、缓存层或入口。

优化暴露了失败与取消的顺序竞态：缺 verifier 时，`failBatch` 先 abort driver，父 run 可能先被记录成 cancelled。现在先持久化 failed，再 abort。同步报告终态的 watcher 也会正确解绑。

Reviewer/Supervisor 的已发布绑定复用已读快照和恢复状态，读取各从两次变一次。精确 terminal 事件先选来源，成功子节点不会再追溯整店历史 review。Review pack 复用已有 attempts 计算展示预算，删除独立计数入口；预算准入仍在原账本串行区域判断。

一次晋升检查内，同一 session 日志只读取一次。每次 gate、审批后和提交前仍重新检查，原有日志漂移拒绝测试保留。没有跨审批缓存。

Replay driver 改用新 replay task 的身份登记，删除重复清理出口。同一样本的两个独立 workspace replay 不会互相覆盖取消追踪；一侧完成后，另一侧仍可被图取消。

测试夹具只保留一次清理入口；shell 取消和超时走同一进程组终止路径，等待退出后完成。Grader 输出只有退出状态为零才能通过，modules 第一阶段失败不会被第二阶段覆盖。真实 xv6 grader 使用固定共享锁；假 grader 单测使用本地锁，不占真实 QEMU 端口。

嵌套取消测试原先把“spawn 已登记”当作“模型 turn 已开始”，并在 loop 尚未结束时立即读 turn/end。现在按测试自己的前提等待挂起请求实际开始，取消后等待 loop idle，再检查 abort 记录。没有增加延时或重试生产逻辑。

## 测量

同一生产函数、同一基准文件，baseline/current 顺序运行。4096 tasks/runs、4095 edges、512 批成员，预热后取 11×8 次运行的中位数。

| 调度 CPU 操作 | Round7 ms | Round8 ms | 倍数 |
| --- | ---: | ---: | ---: |
| 依赖投影 | 7.393460 | 0.125230 | 59.04× |
| 子任务结果汇总 | 22.432074 | 0.675556 | 33.21× |
| 512 次 latestRun 查询 | 3.204569 | 0.491332 | 6.52× |

这是局部 CPU 测量，排除持久化、快照克隆、provider I/O、模型调用。默认每批最多 8 个子任务；不能把大批量数字当作默认工作负载或 112 分钟 live 链条的整体加速。

复现命令（先 build，再从外层运行）：

```sh
SINGULARITY_SCHEDULER_BENCH=1 pnpm exec vitest run --project unit packages/singularity/task-runtime/tests/unit/scheduler-performance.spec.ts -t 'production scheduler CPU benchmark' --maxWorkers=1
```

原始数值见 [round8-performance.json](2026-10-05-round8-performance.json)。复杂度回归另检查边和结果表的实际访问次数；长链测试检查 32 个逆索引节点的依赖顺序、24 节点失败传播、重试和首份 evidence 的语义。

## 并行与发布边界

同一 checkout 保留单写者。已验证同一 runtime/store 内两个独立 checkout 的 replay 同时在途、产物隔离、lease 释放和取消追踪。真实 grader 的锁用于隔离外部固定端口，不能算作图并行收益。

双侧 Evolution replay 保留串行：root run 名额检查与启动之间存在 await；并发还会改变“前侧结算 token 后决定下一侧是否启动”的预算语义。直接 `Promise.all` 不能保持这些约束，本轮没有增加名额预留或并行框架。

每次 task commit 仍克隆 reducer 状态并广播全快照，每个 child 仍读取新快照；完整长图执行没有变成线性复杂度。已有 CommandVerifier 仍按其截止时间完成，不提供取消接口。廉价真实框架清理回归验证三 root、第二 env、挂起模型 turn 和 shell 子进程，不代表已排除所有长验证任务的退出延迟。

本轮没有重跑 112 分钟的全真实模型 xv6 链条。沿用经审计的历史 live 证据，重新运行脚本化生产链及真实 grader；具体测试结果见 JSON 的 validation 字段。结论限定于上述修改和验证范围，不声称所有可能优化已完成。

发布验证结果：最终 unit 2320 通过（Singularity 2305、env-builder 15），默认跳过一项显式性能基准；integration 分组共 651 通过、10 跳过、零失败。首轮 full integration 正常退出，随后复验最终非 grader 用例，并复用本轮已通过的两个真实 grader 用例；用户接受分组验证。build、四个 event root 的 persistence 检查、490 文件的 2000 行限制及 diff 检查全部通过。12 个既有生产文件净增 13 行，无新增生产源文件或持久化 schema。
