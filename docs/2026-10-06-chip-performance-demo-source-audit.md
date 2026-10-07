# 芯片性能回归与短 RSI demo：Buckyball 源码审计

日期：2026-10-06（Asia/Shanghai）。范围：只读查看 Buckyball 第一方源码、现有工作负载、现有日志和 graph4 原始任务；未构建、未仿真、未调用会改变运行状态的 API。本文负责业务性能测量与 demo 来源；Singularity 的角色提示词、实验评价接口由主研究报告另行审计。

## 1. 当前机制能做到什么

**有性能测量入口，未在本次所审计资料中找到“设计版本 → 同条件回归 → 晋升 champion → 不可变性能阶梯”的完整运行证据。** 不能把“存在工具”当成“闭环已打通”，也不能据此断言整个历史从未有人记录过提升。

| 能力 | 已核实第一方实现 | 局限 |
|---|---|---|
| 模型业务性能评估 | `bbdev_regression_eval_performance(chip, bitstream)` 提交 `/regression/eval-performance`，明确是 P2E 模型 Perfetto latency 路径。[MCP 定义](/home/ROXY/code/bb_work/buckyball/bbdev/mcp/tools/regression_eval_performance.py:11) | 需要实际 bitstream；不是一个接受任意短 CTest/Verilator 程序的通用性能比较器。[参数检查](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/02_eval_performance_api.step.py:23) |
| 多模型性能与精度采集 | 逐模型构建 workload/kernel、运行 P2E、解析 UART 精度与周期 trace，最后写 cycles/accuracy/models。[执行流程](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/02_eval_performance_event.step.py:201)；[结果写入](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/02_eval_performance_event.step.py:373) | 当前 pebble 配置评估 LeNet/MobileNet/ResNet/YOLO，不是 CosyVoice 或短算子任务。[模型列表](/home/ROXY/code/bb_work/buckyball/examples/chips/pebble/regression/eval/models.toml:1) |
| 真实 RTL Ball/内存周期 | Rust trace 写 `clk` 和每条操作的 `elapsed`；Verilator sim 工具可显式打开 pmctrace/ctrace。[PMC](/home/ROXY/code/bb_work/buckyball/bebop/src/nodes/lib/rtl-trace/src/pmctrace.rs:3)；[sim 工具](/home/ROXY/code/bb_work/buckyball/bbdev/mcp/tools/bebop_verilator_sim.py:12) | 各操作 elapsed 可用来诊断；重叠执行时不能简单求和冒充端到端周期。|
| 有边界的 RTL 端到端周期 | TraceBall 每个 RTL 周期递增计数器；STOP 记录相对 START 的 elapsed，ctrace 输出结构化记录。[计数](/home/ROXY/code/bb_work/buckyball/examples/balls/trace/arch/src/main/scala/Trace.scala:66)；[STOP](/home/ROXY/code/bb_work/buckyball/examples/balls/trace/arch/src/main/scala/Trace.scala:207)；[记录格式](/home/ROXY/code/bb_work/buckyball/bebop/src/nodes/lib/rtl-trace/src/ctrace.rs:3) | 测量程序仍需正确放置 fence，使 STOP 不先于待测计算和写回完成；已有 counter test 只检查指令执行不挂起，不能替代测量边界验收。[原测试约束](/home/ROXY/code/bb_work/buckyball/examples/balls/trace/workloads/ctests/bdb_counter_test.c:9) |
| 单次结果保存 | `merge_metrics` 默认写仓库根目录 `chipcrowd-eval-result.json`，读旧对象后 `data.update(fields)` 再覆盖整个文件。[实现](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/scripts/result.py:6) | 没有原生的 baseline/candidate/champion/history 结构或版本身份。调用方可设置仓库内的 `EVAL_RESULT_PATH` 做隔离，但这需要额外编排，不是自动阶梯。[路径限制](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/scripts/result.py:7) |
| correctness 回归 | regression-check 把 chip/bitstream 发给 P2E `pk-tests` batch。[实现](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/01_check_event.step.py:62) | 此入口不是相对基线的性能退化门槛或 champion 晋升。|

性能模型的 `e2e_cycles_from_perfetto` 取 complete events 的 `max(ts+dur)-min(ts)`，源码声明 ts/dur 单位为周期。因此有可消费的业务周期数字；但它没有决定什么设计更好，也没有自动关联 task/skill/tool 改进。[周期提取](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/scripts/perfetto_latency.py:11)

本次 root 任务验收列出了真实 BEMU/Verilator 数值对照、Ball 参与、compiler/UVM/PPA/JUnit；未在该条验收中要求候选与基线的周期改进、性能退化门槛或多代提升阶梯。因此这轮的完成或通过不能单独作为自主性能优化证据。[root 验收](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/root-prompt.md:42)

### 1.1 性能入口的静态可用性风险（未动态复现）

1. P2E `_p2e_run_cmds` 创建了 `run_log`，但生成命令时 `--log-dir` 插入的是导入的 `log_dir` 函数对象。后续仍从 `run_log` 找 UART 与 cycle trace；从当前源码看，输出路径不一致。本文没有跑 P2E，因此这是静态发现，不能写成实际失败跑次。[创建 run_log](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/02_eval_performance_event.step.py:133)；[命令插值](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/02_eval_performance_event.step.py:148)；[后续读取](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/02_eval_performance_event.step.py:306)
2. 多模型平均周期被要求必须整除；否则全阶段失败。不同模型实际整数周期总和不保证能整除模型数，故这不是稳健的统计均值实现。[mean_cycles](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/scripts/perfetto_latency.py:27)

## 2. 已有证据和反例

**确认有短算子的实际 RTL 正确性证据；未找到这些短算子的带版本身份周期提升阶梯。**

- Hibiki `act_test` 的实际 stdout 显示 ELF 被 RTL 加载，`act_test PASSED`，`sim_exit exit_code=0`。其原始程序验证 GELU 和 LEAKY_RELU，包含边界数值和 256 元素正常批次。[实际 stdout](/home/ROXY/code/bb_work/buckyball/log/2026-10-06-01-12-hibiki-sims.verilator.BuckyballHibikiVerilatorConfig-verilator-hibiki-tokgen-ctest-act_test-baremetal/stdout.log:3)；[workload](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/ctests/act_test.c:59)
- 同次 `rtl-trace-summary.json` 有 13 次 Ball PMC callback、10 次 memory PMC callback；这是 callback 参与证据，不是周期值。该次 bdb.ndjson 抽查为空，不能从此 summary 重建性能基线。trace 源码把 callback 计数与各 trace 开关分开处理。[summary](/home/ROXY/code/bb_work/buckyball/log/2026-10-06-01-12-hibiki-sims.verilator.BuckyballHibikiVerilatorConfig-verilator-hibiki-tokgen-ctest-act_test-baremetal/rtl-trace-summary.json:1)；[开关初始化](/home/ROXY/code/bb_work/buckyball/bebop/src/nodes/lib/rtl-trace/src/state.rs:32)；[summary 写入](/home/ROXY/code/bb_work/buckyball/bebop/src/nodes/lib/rtl-trace/src/state.rs:116)
- **SNAKE 不能作为现成绿色性能基线。** Hibiki 2026-10-06-01-12 与 Pebble 2026-10-02-09-16 的实际日志均有 4 处数值 mismatch，`act_snake_test FAILED`，退出 1。[Hibiki 失败](/home/ROXY/code/bb_work/buckyball/log/2026-10-06-01-12-hibiki-sims.verilator.BuckyballHibikiVerilatorConfig-verilator-hibiki-tokgen-ctest-act_snake_test-baremetal/stdout.log:4)；[Pebble 失败](/home/ROXY/code/bb_work/buckyball/log/2026-10-02-09-16-pebble-sims.verilator.BuckyballPebbleVerilatorConfig-verilator-pebble-pebble-ctest-act_snake_test-baremetal/stdout.log:5)
- Hibiki 目前 Verilator batch 只列 counter、silu、act_test，没有把失败的 act_snake_test 纳入该绿色 batch。因此通过这份 batch 不代表全部 Act 模式已通过。[batch](/home/ROXY/code/bb_work/buckyball/examples/chips/hibiki/regression/batch/verilator/workloads-elf.toml:3)
- Graph4 的大卷积 campaign 叙事记录为两阶段分区，总约 8.68 小时；canonical RTL 估算 62 小时以上。这适合工程集成能力观察，不适合快速做多代、配对、留出集 RSI 实验。[采样叙事](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/evidence/progress-log.md:785)

## 3. 必须排除的假 DSE 入口：SMatMul lane 配置

发现 `smatmul/configs/lane4/lane8/lane16/lane32.toml`，但不能把它们直接当成当前可改变 RTL 的设计空间：

- 配置文件确实写了 `lane=4/8/32`；SMatMulBallParam 也有读取 lane/wsReuseTiles 的 helper。[lane4](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/configs/lane4.toml:3)；[lane8](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/configs/lane8.toml:3)；[lane32](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/configs/lane32.toml:3)；[loader helper](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/configs/SMatMulBallParam.scala:18)
- 当前 SMatMulBall 构造 SMatMulUnit；Unit 固定 `tile=16` 并创建不带 GlobalConfig 的 `new Array`；Array 也固定 `tile=16`，直接建 16×16 PE。当前这条活跃 RTL 实例链未消费 SMatMulBallParam。[Ball](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/arch/src/main/scala/SMatMulBall.scala:29)；[Unit 固定 tile](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/arch/src/main/scala/SMatMulUnit.scala:12)；[实例化 Array](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/arch/src/main/scala/SMatMulUnit.scala:110)；[Array](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/arch/src/main/scala/Array.scala:9)
- Unit 还硬要求 128-bit 行、2 个读端口、1 个写端口以及 N=16。BEMU 也以 TILE=16 和 N=16 规定契约。[硬件契约](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/arch/src/main/scala/SMatMulUnit.scala:34)；[N/K 检查](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/arch/src/main/scala/SMatMulUnit.scala:246)；[BEMU 契约](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/emu/src/smatmul.rs:81)
- Pebble 活跃 mapping 挂了 SMatMul；Toy 的活跃 mapping 只有 Gemmini/Trace/Mxfp2Int，不能因 Toy 目录下有 smatmul/lane16 文件就说 Toy 已挂该 Ball。[Pebble mapping](/home/ROXY/code/bb_work/buckyball/examples/cores/pebble/configs/balldomains/default.toml:5)；[Toy mapping](/home/ROXY/code/bb_work/buckyball/examples/cores/toy/configs/balldomains/default.toml:3)

SMatMul 当前合法的小工作负载是 `smatmul_single_block_test`（M=1,N=16,K=64，纯 C 标量算 expected）和 `smatmul_bias_accumulate_test`（M=16,N=16，两个 K=16 block 的累加链）。二者被 CMake 与 Pebble Verilator batch 注册；本地 `bb-tests/output/pebble` 可找到二者的 baremetal ELF，但本次 `log/` 搜索未找到它们的实际 RTL 周期跑次。可作为备选 demo，不应把“存在 ELF”写成“已经跑通有性能证据”。[CTest 注册](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/workloads/ctests/CMakeLists.txt:1)；[单块](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/workloads/ctests/smatmul_single_block_test.c:24)；[独立标量 expected](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/workloads/ctests/smatmul_single_block_test.c:34)；[累加链](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/workloads/ctests/smatmul_bias_accumulate_test.c:24)；[batch 注册](/home/ROXY/code/bb_work/buckyball/examples/chips/pebble/regression/batch/verilator/workloads-elf.toml:13)

BEMU 的 SMatMul latency 是 `rows*cols*k/16 + ...` 的模型公式，不是读取 RTL FSM 实际周期。BEMU host 吞吐或这个公式不会证明 RTL 变快。[BEMU latency](/home/ROXY/code/bb_work/buckyball/examples/balls/smatmul/emu/src/smatmul.rs:209)

## 4. 推荐短 demo：一组小激活批次的映射/工具使用自改进

**首选用已经有真实 RTL 绿色证据的 GELU/LEAKY_RELU 激活；先固定现存 Hibiki 已编译硬件验证通用 task/skill/tool RSI，再把硬件重建作为可选拓展。** 不需要为 Singularity 增加芯片专用实验架构。

### 4.1 固定硬件路线（优先）

业务题目：在固定 RTL、固定内存容量、固定输出语义下，生成和优化若干个 4–256 元素 GELU/LEAKY_RELU 批次的 bank/mvin/ACT/mvout/fence 排程，最小化完整批次的 RTL 周期；全过程自动提出候选、运行独立验收、读取 PMC、修订任务模板或小 skill，再在未公开的批次上复试。

具体现成来源：

- Chip 入口：`examples/chips/hibiki/configs/chip.toml` 指定 `sims.verilator.BuckyballHibikiVerilatorConfig`；该类进入 `examples.hibiki.BuckyballHibikiConfig`，后者读取生成的 chip.pb。这是真实配置消费链，不是只存在一个 TOML。[chip](/home/ROXY/code/bb_work/buckyball/examples/chips/hibiki/configs/chip.toml:4)；[TargetConfig](/home/ROXY/code/bb_work/buckyball/examples/chips/hibiki/arch/src/main/scala/sims/verilator/TargetConfigs.scala:5)；[实际 PB 消费](/home/ROXY/code/bb_work/buckyball/examples/chips/hibiki/arch/src/main/scala/CustomConfigs.scala:23)
- `tokgen` core 实际挂 TraceBall/ActBall，funct7 为 4/75；用 hart 0 现有 sim 即可测。无需先证明全图异构芯片所有核心都在工作。[mapping/ISA](/home/ROXY/code/bb_work/buckyball/examples/cores/tokgen/configs/balldomains/default.toml:27)
- 精确 seed workload：现成 `hibiki-tokgen-ctest-act_test-baremetal`，其源文件 `examples/balls/act/workloads/ctests/act_test.c` 的 `run` 给出正确的 bank/mvin/ACT/mvout/fence 顺序；CMake/新 microbenchmark 仍需要冻结测量边界及输出数量。[run](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/ctests/act_test.c:42)；[实际加载该 ELF](/home/ROXY/code/bb_work/buckyball/log/2026-10-06-01-12-hibiki-sims.verilator.BuckyballHibikiVerilatorConfig-verilator-hibiki-tokgen-ctest-act_test-baremetal/stdout.log:3)
- ISA 参数 `n`/slope 是真正消费的指令字段，4 fp32/16B；GELU 与 LEAKY_RELU 的宏明确发送不同 mode，不用 lane 配置猜测硬件行为。[ISA](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/isa/act.h:33)
- 工具：只改软件排程时用 workload-build 的 ctest 路线构建 CTest，再用 `bbdev_bebop_verilator_sim(binary,chip,pmctrace=true,ctrace=true,no_wave=true)` 复用 RTL。`run` 是 full flow；不要混用而每个候选都重新生成硬件。[workload-build](/home/ROXY/code/bb_work/buckyball/bbdev/mcp/tools/workload_build.py:12)；[sim](/home/ROXY/code/bb_work/buckyball/bbdev/mcp/tools/bebop_verilator_sim.py:12)；[full run](/home/ROXY/code/bb_work/buckyball/bbdev/mcp/tools/bebop_verilator_run.py:25)

建议冻结以下 demo 合同（这是建议，尚未实现和跑次）：

1. Train 用固定若干批次形状与输入，holdout 用不同 seed、N=4/12/36/128/256、不同斜率及边界值；所有待测元素与操作序列在两个方法版本间相同。已有 `act_test` 能提供黄金/边界样例，但 holdout 应在独立运行器内冻结，不让搜索 agent 编辑它。[已有边界值](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/ctests/act_test.c:61)
2. 验收器重算每个输出并检查恰好覆盖全部批次、无遗漏/常量替代；LEAKY_RELU 可用独立 IEEE 标量参考，GELU 用冻结数学参考与既定容差。现有 golden 是仓库契约算法，而非独立官方参考；不能让 candidate 同时改 golden 来获得通过。[现存容差检查](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/ctests/act_test.c:27)；[golden 来源](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/ctests/act_golden.h:1)
3. 业务主指标用固定完整批次的 RTL ctrace elapsed，包括必要输入搬运和最终输出可见的 fence；golden 的 CPU 计算排除在该区间。另记 Ball PMC、load/store PMC、构建时间/墙钟/工具调用数。不得只把 CPU 仿真速度或更短 timeout 当收益。[计数实现](/home/ROXY/code/bb_work/buckyball/examples/balls/trace/arch/src/main/scala/Trace.scala:207)；[原始 PMC 字段](/home/ROXY/code/bb_work/buckyball/bebop/src/nodes/lib/rtl-trace/src/pmctrace.rs:8)
4. 软件优化空间是复用已分配 banks、保留中间数据、合并合法批次、重排彼此独立的数据搬运、减少不必要 fence。是否能减少业务周期必须由 RTL 实测决定；不能承诺任何百分比。原 seed 每次 run 都 alloc/mvin/ACT/mvout/fence/release，提供可观察但未经证明的排程优化机会。[seed 次序](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/ctests/act_test.c:42)
5. 至少比较两个可持久化方法版本：M0 原 skill/task/tool 使用合同；M1 由 agent 依据诊断提出并修订的合同。M1 在同预算、同硬件、同冻结测试下产生更好输出周期，且方法应用到 holdout 的新任务后仍有效，才形成 task/skill/tool RSI 的业务收益证据。单个 kernel 的 C0→C1 提升只证明业务设计优化，不证明自改进方法泛化。
6. 每个候选写不可变记录，带方法资产 hash、业务产物/ELF hash、RTL hash、输入/验收器 hash、原始 trace 路径、正确性状态、train/holdout cycles、成本与晋升理由。原生 `merge_metrics` 的覆盖写入不提供这份合同，需由通用实验结果记录器保存。[覆盖写入](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/regression/scripts/result.py:17)

这条路线刻意把短反馈放在软件 mapping 与方法资产改进上：它可以证明通用 Singularity 的业务指标驱动 RSI，但不应被称为“已经自主设计出更快的全新芯片 RTL”。

### 4.2 可选硬件路线（需要重建）

若要求额外展示自主芯片设计，可让 agent 新建一个单 tile、单 core、Act+Trace 的精简 chip，从现成合法结构出发，以固定 SRAM/端口/近似算法与资源上限优化 GELU/LEAKY_RELU 的读算写流水。当前 Act FSM 明确按 read→compute→write→wait-write-response→下一行串行，故存在真实硬件排程改造点；具体收益未测。[FSM](/home/ROXY/code/bb_work/buckyball/examples/balls/act/arch/src/main/scala/Act.scala:240)；[串行状态迁移](/home/ROXY/code/bb_work/buckyball/examples/balls/act/arch/src/main/scala/Act.scala:390)

这需要真实 config generation、Verilog generation、Verilator build，不能沿用旧 sim 假装新 RTL。现成工具入口分别为 `bbdev_bebop_verilator_verilog(chip)` 与 `bbdev_bebop_verilator_build(chip,jobs)`。[Verilog](/home/ROXY/code/bb_work/buckyball/bbdev/mcp/tools/bebop_verilator_verilog.py:11)；[build](/home/ROXY/code/bb_work/buckyball/bbdev/mcp/tools/bebop_verilator_build.py:11)

不能用 SNAKE 的“同 channel alpha/reciprocal cache”当第一轮纯性能演示，因为原基线已失败；这可以独立成为“先自动定位并修复数值缺陷，再优化”的更长题目。重复 alpha/divide 的静态位置在 `Act.scala`，但它目前仅说明潜在优化机会。[每行 alpha/divide](/home/ROXY/code/bb_work/buckyball/examples/balls/act/arch/src/main/scala/Act.scala:397)

### 4.3 时长证据边界

本文未测 cold build、warm build 或短 workload 运行墙钟，现存短算子 stdout 也没有开始/结束时钟。可以把 1–3 小时作为工具链已经预热、只做少数方法候选的规划假设，不能当已验证 SLA。先跑一次冻结 baseline 测量后才可决定候选数和是否允许 RTL 重建。现有大卷积分区的 8.68 小时证据不可移植成这个小题的估时。[大 campaign 叙事](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/evidence/progress-log.md:785)

## 5. 并行比较的实际工具路径约束

通用实验层即使允许并行，业务工具也必须隔离。当前 workload output/build、bebop target、arch build 都主要按 chip 名分目录，而不是按候选 revision 或 experiment ID。相同 chip 的两个候选同时构建或生成可能写同一路径。[workload/output](/home/ROXY/code/bb_work/buckyball/bbdev/api/utils/path.py:41)；[cargo target](/home/ROXY/code/bb_work/buckyball/bbdev/api/utils/path.py:55)；[arch root](/home/ROXY/code/bb_work/buckyball/bbdev/api/utils/path.py:64)

config-install 还会扫描全部 `examples/chips/*/configs/chip.toml` 并为全部芯片写 generated/config.json、derived.json、chip.pb。它不是默认只操作一个候选的局部工具。[扫描/JSON 写入](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/config/01_install_event.step.py:44)；[PB/安装](/home/ROXY/code/bb_work/buckyball/bbdev/api/steps/config/01_install_event.step.py:90)

因此建议先并行只读分析/候选生成；重建阶段让每候选使用隔离 checkout、隔离 bbdev service 根与构建缓存命名，或由通用 workspace/tool resource lease 串行保护同一路径。`BUCKYBALL_ROOT` 不能让一份公共 bbdev 任意指向另一个 checkout：代码要求 root 与这份 bbdev 的 inferred root 一致。[root 校验](/home/ROXY/code/bb_work/buckyball/bbdev/api/utils/path.py:8)

这里需要的是通用实验与资源隔离能力，让业务工具按其实际写路径声明共享资源；不要求新增“芯片专用 RSI”框架。
