# CosyVoice2 project3 根图验收

独立复核对象：store `sg-t-d3468969-4617-4505-9bef-2fcaf4d858d6`，root run `r-3fbeec30-2d5a-4e29-862b-23a033fb0298`；原始会话在 `cosyvoice-bb-live-2026-09-28/deployment-restart3/.dsh/sessions/_no-cwd/`，bbdev 原始日志在同一实验目录 `environment/project3/DangoSys/buckyball/bbdev/server.log`。只判这张图，不把先前 graph2 的局部成功拼进来。

| 判据 | 结论 | 证据与边界 |
| --- | --- | --- |
| 已冻结 `PreLookaheadLayer` 的 BEMU CPU 切片 | **PASS** | store seq60–62 有独立 checker exit 0、`TaskVerified` 和 verified Review；同图 build 与 BEMU trace 终态 rc=0；完整 `[1,25,512]` 的 12,800 个值 `mismatch_count=0`，`max_abs_diff=7.152557e-06`。 |
| 节点根据证据创建 Task | **观察到，范围有限** | 1 root 运行时提出 3 个子 Task，2 个 verified；一个因缺 `bb-verify` preset failed，父节点读取诊断后重新提出可执行 Task。只到深度 1，并经人工审批；不外推任意深度或无人工运行。 |
| 节点自行完成模型接入 | **未证明** | 根 intake 前，CTest、ELF、模型参数和 checker 已由夹具准备；现有 CTest 是纯 C 循环。 |
| Ball 加速及 Verilator RTL 对照 | **未证明** | 本次 Ball 加速为零；无目标 Ball 指令轨迹和 RTL 数值对照。相关第三方 RTL / verify 子模块在该环境未初始化。 |
| 构建过程只经 bbdev MCP | **未通过** | 执行笔记记录曾直接运行 CMake 并损坏缓存；之后经 MCP 重新构建成功，故数值根判据仍通过，但工具使用约束不能判通过。 |

后续建设按唯一计划完成通用 BB Task / Skill / MCP 适配。模型接入与硬件数值证据是本实例尚未证明的内容，不能据此把通用资产写成模型专用工作流。具体实例只冻结用户目标、独立判据和必要资源，子 Task 的数量、顺序和 Skill 选择由节点根据实际证据决定。用户要求的最终硬件验收须有 Verilator RTL 与同一冻结算子合同的参考对照；仅有 BEMU CPU 或 Ball trace 不能代替它。完整 CosyVoice2 模型适配芯片仍需覆盖被宣称支持的全部模型范围，本记录不作该宣称。
