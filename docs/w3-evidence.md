# W3：领域分解与封存产物合同

W3 使用 Task v7。letters 的父模板 `count-source` 保留原保护输入；`extract-letters` 独立验收保序 ASCII 字母，
`count-letters` 独立验收封存字母的 decimal 计数。child 的 `supports` 只说明工作关系，父判据由父自己的 verified Run 接受。

用户明确：父可在完整计划内创建任务并选择已声明模板；已分配 child 执行自己的 Task/Run，不可另开根任务或发布计划。
自创 TaskTemplate 的准入与评估属于 W6。

## 实现与反例

计划在任何 child node/admission/assignment 前完成责任、模板、闭合依赖、DAG、supports、预算和唯一 producer 校验。
合法计划最后以原 decomposition 事实发布；变更重送拒绝，非法计划不留下准备事实。

Task 固定模板内容身份与输入来源，artifact 准入只引用准确 producer Task。
下游开始时读取 verified producer 的封存产物，核摘要后将准确 producer Task/Run 写入现有 revision manifest，Bubble 绑定实际字节。
输入名、来源、判据与模板错配，以及未 verified、丢失或变更产物，都在新 revision/Run 前拒绝。

恢复核对准确模板、revision、producer Run 的封存摘要和自身输入副本，不重新复制上游工作区。
冻结后上游文件删除或变化不影响副本恢复；自身冻结输入或模板变更则明确失败。

接口/spec、执行和独立 verifier 有 red→green 证据。相关变异通过仓库 [账本](../mutation-baseline.json) 可运行；
保留固定 receipt、请求重送、退出码和来源规则。已删除单模板 Domain 字段、闲置 metric、重复制输入的准备路径与两个独立 G2 浏览器脚本。
新的统一入口及 mode 见 [测试方法](e2e-testing.md)。

## 产品证据边界

真实私有 DSH `--panel` 验收通过，正式结果保留在 `/tmp/singularity-w3-panel.json` 和 `/tmp/singularity-w3-panel.png`。
提取、计数与父 Run 均 verified；计数输入指向提取 Task/Run 的封存产物，三份 receipt 的 transcript 前缀、磁盘摘要和 verifier 实现均已核验。
面板在 cut 31 展示三个 verified Task 和完整计划，父判据指向父 Run；刷新和重载不提交事实。临时 host、browser 和 home 已清理。
首轮发现 child 另开根 Task 的真实权限缺口，来源保留在 `/tmp/singularity-w3-panel-first-source.json` 与 `/tmp/singularity-w3-panel-failed.json`；
按用户裁定修复后，双 child 已 verified，探针的只读 cut 适配错误记录在 `/tmp/singularity-w3-panel-probe-failed.json` 和同名 png。
失败记录不作为产品通过证据。

本轮父通过第二个用户 turn 继续提交；这不是 W4 自动父唤醒或有界重试的证据。
完整 G2 检查点仍需 W4/W5 的准确会话、有界调度、来源读面和恢复出口。

core build、assembly 类型检查及完整 spec 通过；插件产物已重建。
全量 gates（含真实浏览器调用）和检测器自测通过，日志保留在 `/tmp/singularity-w3-gates-final.log`。
源码差异检查通过；计数反例样本末尾的两个 LF 是独立 verifier 的刻意失败输入。
