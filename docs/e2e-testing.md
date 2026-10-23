# 私有 DSH 实跑测试

2026-10-22：领域任务与适配器已外置；下文 letters/CPU/SHA256 描述为历史运行合同，不是主仓当前内置任务。新环境由 env setup 从唯一 `domain/reference` 参考生成，部署显式指定 `SINGULARITY_DOMAIN`，领域验收在该环境包执行。


当前开发与部署使用显式配置的重建宿主，步骤见 [standalone-dsh](standalone-dsh.md)。历史实跑使用 `/home/ROXY/singularity-next/` 下的私有 `singularity-next-web` profile 与对应冻结插件；会话与原始证据保留在专用 home。

## 一轮代码验证

```bash
cd /home/ROXY/code/singularity-core
pnpm build
pnpm test
pnpm gates
git diff --check
```

构建检查 core、assembly 和前端类型，装载导出并核对产物摘要。回归与门禁不启动模型，不作为实际领域验收证据。

## 浏览器验收入口

```bash
. /home/ROXY/singularity-next/env.sh
node scripts/deploy.mjs
dsh --profile singularity-next-web --host 127.0.0.1 --port 7331 --no-open
```

从原生界面提交领域目标和自然语言验收要求，不续发阶段指令。执行节点复用相关方法或直接声明一次性任务，提交工作区产物；独立 ReviewRun 逐条判断标准，必要时创建取证 Task。所有节点使用公开 create/resume 的普通主 agent 会话，Bubble 保护输入、验收程序和其他任务历史。

root 必须委派实现，普通子节点自行决定是否继续分解。委派显式区分必须 verified 的 `required` 与可择优、可停止的 `exploration`；可用证据足够时，父停止未选探索并进入集成，停止本身不算验收通过。每次模型请求附简短的共享已用/总步数，包含后代与独立验收；不自动注入全局关系快照，也不在子节点启动时摘要父会话。首次显式 `singularity_memory()` 才准备本节点的有界父背景并分页列目录；已有 checkpoint 或失败记录不重复购买摘要，传 ref 只读。摘要失败在目录明确标记且不阻断 Task，持久化与证据完整性错误仍传播；root 看整树，独立审核仅看自己的取证分支。单会话使用 DSH 原生 BasicCompaction，在窗口 70% 触发（本轮 1M 窗口为 700k），保留原生默认尾部策略与 32768 tokens 摘要额度，替换实时上下文而保留原始事件。当前协议为 Task v24、Strategy v9、Measure v5、Review v5、snapshot v13。

依据准确会话、committed snapshot、封存附件与正式 receipt 定位问题；不得伪造模型流程。恢复使用原会话、原 Run 与冻结目录，已冻结的检查结果、审核、trial 和发布决定复用。图、依赖、能力缺口、验收及 RSI 记录取同一状态前缀，节点直接连接自己的原生会话。

## Method 进化与原生发布验收

部署 seed 初始化唯一方法指针。每个 Run 直接固定方法 Revision 和 Bubble 执行快照；临时契约不创建 Revision。根任务关闭后，后台等待原生会话结束并封存完整轨迹，再创建 RSI 节点；evaluation 根不再次触发 RSI。RSI 按路径提交含原生证据、分析和具名增量编辑的 JSON 提案契约，经结构、绑定及六项独立审查后进入冷启动候选测评；基线复用封存业务 root。审查附件只携带宿主按 RSI 权限验证的引用片段，不授予审查者跨轮 history 或 memory 权限。提案准入即冻结附件并立即返回 screening 引用，宿主自动继续 critic/selftest/测评；作者不重发路径、不轮询。搜索状态从 Task 事实派生，kind=search 读取，长资产/规则/反馈分开分页；宿主从 measure、strategy、release 事实恢复；最终发布仍要求独立 ReviewRun 和准确 expected head。

先以 letters 取得真实“候选→独立测评→决定”记录，再以 CPU PolyBench/C 3mm 快速观察自主分解与验收；SHA256 用于较长的领域验证。无待处理批次或评估时，当前 RSI 可以继续修订，也可如实提交无改进或证据不足报告；不能把发布赢家作为正常结束的前提。真实发布并且后续 Run 实际消费该版本，才能证明方法更新生效；领域迁移仍需陌生任务证据。中断检查分别覆盖提交、独立审核、测评、发布；恢复必须复用同一对象和已完成事实，不要求模型重发长调用。历史实验只读，新实验采用新协议。

## 证据边界

CPU 快速回归的 `domainDir` 指向冻结 checkout 的 `deployment/domain/polybench`。3mm 参考提取自 PolyBench/C 4.2.1 镜像 `MatthiasJReisinger/PolyBenchC-4.2.1` 的 `3e872547cef7e5c9909422ef1e6af03cf4e56072`；保留原分发许可。任务只提供 `reference.c`、`benchmark.py` 和任务声明，交付 `kernel.c`。用 `/usr/bin/python3 inputs/benchmark.py kernel.c` 验证四组运行时尺寸的完整输出及输入不变性；MEDIUM 上固定 GCC 参数、七次交替计时取中位数，加速至少 1.20 倍。退出 0 仅代表数值通过，性能以 JSON 的 `meets_target` 为据，独立审核复跑并判断两个标准。达标可交付，不要求额外候选或穷举。

实跑宿主用 `taskset -c 0-3` 固定到同 NUMA 的四个物理核，并设置 `OMP_NUM_THREADS=4 OMP_THREAD_LIMIT=4 OMP_DYNAMIC=FALSE OMP_PROC_BIND=TRUE OMP_PLACES=cores OMP_WAIT_POLICY=PASSIVE`；评测入口也会限制 affinity 与 OpenMP 线程数。将 `POLYBENCH_LOCK` 设为冻结领域的 `reference.c` 绝对路径，让各 Bubble 通过同一只读文件的 advisory lock 串行计时。`evaluation_seconds` 包含编译和验证，不含等待锁的时间。工程冒烟样本的加速不能算作 agent 求解成绩。

SHA256 领域仅提供完整 RTL `sha256.v`、固定 Yosys 综合指导 `yosys.md` 和必要 `task.json`；不提供脚本、checker、测试平台、候选提示或额外 RTL。交付 `rtl/sha256.v`，仅改变其中的 `sha256_w_mem` 模块，保护 core/K 模块字节、端口、复位、SHA224/SHA256 功能与逐周期时序。整核面积基线为 64858.4544 µm²，同工具、库和输入下至少改善 1%，即最多 64209.869856 µm²。模型自行构造必要验证，独立 ReviewRun 判断真实证据；没有自动面积 measurement，RSI 的通用 pass 质量不能代表面积收益。

一次业务 root、子任务及独立验收截至提交的原生 token 成本增幅上限为 25%；RSI 分析、提案、评测编排和发布审核用量永不参与比较。思考档位与输出预算由运行配置固定，不设 campaign token 预算上限。根轮次结束、相关会话静默并 flush 后，读取 `token-meter` 的原生 `tokenUsage` 投影并封存至 `subject.json` 的 `summary.usage` 与逐会话四个计费桶；RSI agent 和 `node scripts/usage-report.mjs <subject.json>` 共用该统计。比较成本与 `ui-chat` 的 StatsPills 同口径，只相加原生计费桶。历史 `kind=usage` 另外返回 `audit`，单列原生投影未覆盖的父背景、压缩摘要及缺失样本；已知总量不等于供应商账单，不补算、不预留、不停止后续请求。没有固定子树、轮次或候选数量。

领域效果以真实执行的任务、产物、独立判决、原生 usage 和发布记录为据。无赢家、未改善、证据不足或用量未知如实报告。旧受控演示与离线测试不能代替当前自主任务链与 RSI 验收。
