# 私有 DSH 实跑测试

开发、构建 peers 和产品运行都使用 `/home/ROXY/singularity-next/`。旧 harness 只供只读参考。
浏览器探针从私有配置创建临时 home，加载安装的 `singularity-next-web` profile 与本仓库已构建插件；
结束时关闭自己的 server 和 browser；Method 发布探针保留临时 home 与原始证据。

## 一轮代码验证

先按目标合同写失败 spec，再实现最小改动。每包运行相关 spec 并分别检查 core 和 assembly；完整产品验收在 W9 收口：

```bash
cd /home/ROXY/code/singularity-core
pnpm build
pnpm test
pnpm gates
git diff --check
```

`pnpm build` 同时检查 core/assembly 类型，构建并装载四个导出面，核对源与产物的内容摘要。
`pnpm gates` 检查直接合同；`--probe` 复用检测器 spec。门禁不隐式启动模型或浏览器。
产品探针只运行当前主链需要的 mode；不因增加边界覆盖重复启动模型。

## 浏览器验收入口

```bash
node scripts/browser-probe.mjs --screenshot /tmp/singularity-live.png
node scripts/browser-probe.mjs --recovery --screenshot /tmp/singularity-working.png
node scripts/browser-probe.mjs --submitted --screenshot /tmp/singularity-submitted.png
node scripts/browser-probe.mjs --aborted --screenshot /tmp/singularity-aborted.png
node scripts/browser-probe.mjs --decompose --screenshot /tmp/singularity-chain.png
node scripts/browser-probe.mjs --panel --screenshot /tmp/singularity-panel.png
```

每次只选择一个 mode。核对进程 exit code、脱敏 JSON 来源与对应成功 marker；不能仅凭截图或 marker 判断通过。
源码解析、控制事实前缀、session transcript、磁盘摘要及正式 receipt 必须一致。

- 默认：真实 propose → submit → status，程序实际执行且经独立 verifier。
- `--recovery`：working Run 在飞 SIGKILL 后，恢复相同 session、Task、Run 和工作区。
- `--submitted`：封存提交后 SIGKILL，恢复原 submission/source，仅结算与只读 status，不重复执行程序。
- `--aborted`：原生 Stop 关联准确 session 的 Run failed，另一 session 的 working Task 不变。
- `--decompose`：`extract-letters` 独立验收 ASCII 保序提取；`count-letters` 使用准确 producer Task/Run 的封存字节和摘要，独立验收计数；父继续对原保护输入独立提交。
- `--panel`：执行同一完整领域链，再比对 API/core 同 cut、页面所有 Task/Run/依赖/判据行，以及刷新和重载无事实写入。

本轮父可在完整计划内创建任务并选择已声明模板；持久 role 为 child 的调用方只执行分配任务，不能另开根 Task 或发布计划。
自创 TaskTemplate 通过 Method 的完整内容准入；输入来源与独立验收仍由部署固定。
模板、Skill 与 Tool 共用一个 Revision、评估与发布入口。定向反例：`mutate:assembly-w3-child-cannot-fork-root`。

分解与面板 mode 只发送一个用户 turn，后序 child 与父通过宿主原生消息自动推进。
按每条 `singularity` source 核对准确控制事实；DSH 原生 `runtime-context` 不算重复派发。
程序、输入、产物从原生附件存储核对，不以可写工作区作为封存来源。

## Method 进化与原生发布验收

```bash
node scripts/method-browser-probe.mjs --output /tmp/singularity-method-review
```

两轮各两个候选，共十次独立真实 DSH 求解；第二轮模型先读取第一轮冻结历史。
每次核对准确 Revision 的模板、原生系统消息中的 Skill、实际执行 Tool、封存程序和独立判决。
原始成本取原生 `usage.totalTokens`，策略比较相对变化 `(candidate - incumbent) / incumbent`，上限为 25%。
基线故意多计一个字母，正确候选与错误候选只用于受控工程验收，不能作为正式领域效果证明。

两轮结束后，用户通过输出目录的 `approval-url.txt` 打开原生 Web，依次批准临时 Method 库的 baseline bootstrap 和真实选中候选；
探针等待真人答复，不代点批准。无胜者或拒绝不发布。批准后新建独立原生会话，不传 Method 引用，
验证默认加载 published head、三类资产真实消费与独立验收，再关闭自己的服务。
`evidence.json` 记录 trials、决定、人审来源及发布后的新 Run；失败记录为 `failure.json`，均保留原始 home。
若两轮已完成而审批尚未开始，可用 `--home` 指定原有 home，先核对完整证据，再继续原会话的发布步骤；不重跑求解。

## 证据边界

W5/W9 面板完整主链已实跑通过：`/tmp/singularity-w9-panel.log`、`/tmp/singularity-w9-panel.png`。
日志核对真实 session、依赖来源、封存附件与页面完整 receipt，成功 marker 为 `panel-probe: OK`。

W6—W9 Method 工程主链已通过：`/tmp/singularity-method-review/evidence.json`，最终阶段为
`published-head-next-run-verified`，探针 exit 0；截图为同目录的 `published-head-next-run.png`。
两轮共十个独立原生求解会话，质量分别为 `[0,0,1,0,0]`；正确候选均被选中，相对冻结基线的 token 成本变化为 -19.39% / -6.52%。
十次求解原始成本合计 88139 tokens；两次真人原生批准及 head 更新已核对。
新独立会话未指定 Method，Run `run-9a75b8ead347739f` 默认消费发布的模板、Skill、Tool，并独立验收为 verified。
本轮完整 build、64 文件 / 755 项测试、七项直接合同门禁通过；探针收口另通过 44 项相关浏览器检查。
这些结果证明受控 letters 工程闭环；正式领域质量和成本改善尚未评测。

脚本故障、模型/provider 故障和领域拒绝需按控制事实与 transcript 分辨。失败不能通过再次执行已封存程序来掩盖。
受控恢复和领域链证明工程行为；领域质量和成本效果仍须用 W6/W7 冻结的真实任务集、口径、预算与原始 trials 验证。
当前完成状态与证据入口见 [context.md](context.md)，其余包顺序见 [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点)。
