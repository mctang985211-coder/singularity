# 私有 DSH 实跑测试

开发、构建 peers 和产品运行都使用 `/home/ROXY/singularity-next/`。旧 harness 只供只读参考。
浏览器探针从私有配置创建临时 home，加载安装的 `singularity-next-web` profile 与本仓库已构建插件；
结束时关闭自己的 server、browser 和临时 home。

## 一轮代码验证

先按目标合同写失败 spec，再实现最小改动。收口时分别检查 core 和 assembly，不能用根类型检查代替 assembly：

```bash
cd /home/ROXY/code/singularity-core
pnpm build
pnpm exec tsc --noEmit -p assembly/tsconfig.json
pnpm test
node assembly/build.mjs
node scripts/gates.mjs --probe
git diff --check
```

`--probe` 只验证检测器能失败；全量门禁是 `node scripts/gates.mjs`，其中含真实模型和浏览器调用。
必要检查通过后再启动对应产品探针；没有新改动或未解决问题时，不重复扩跑。

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
自创 TaskTemplate 的准入和评估归 W6。定向反例：`mutate:assembly-w3-child-cannot-fork-root`。

W3 的分解验收由第二个用户 turn 让父继续提交，不作为 W4 自动唤醒或同会话有界重试的证据。
原 `panel-probe.mjs` 与 `subtask-probe.mjs` 已删除；门禁目标名称保留，调用统一浏览器入口的对应 mode。

## 证据边界

脚本故障、模型/provider 故障和领域拒绝需按控制事实与 transcript 分辨。失败不能通过再次执行已封存程序来掩盖。
受控恢复和领域链证明工程行为；领域质量和成本效果仍须用 W6/W7 冻结的真实任务集、口径、预算与原始 trials 验证。
当前完成状态与证据入口见 [context.md](context.md)，其余包顺序见 [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点)。
