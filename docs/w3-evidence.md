# W3/W4：领域分解与封存产物合同

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

当前使用 Task v8。letters 的父模板 `count-source` 保留原保护输入；`extract-letters` 独立验收保序 ASCII 字母，
`count-letters` 独立验收封存字母的 decimal 计数。child 的 `supports` 只说明工作关系，父判据由父自己的 verified Run 接受。

每个节点拥有完整 DSH standard 预设；已分配 child 继续自己的 Task/Run，也可选择已声明模板分解自己的 Task。
自创 TaskTemplate 的准入与评估属于 W6。

## 实现与反例

计划在任何 child node/admission/assignment 前完成责任、模板、闭合依赖、DAG、supports、预算和唯一 producer 校验。
合法计划最后以原 decomposition 事实发布；变更重送拒绝，非法计划不留下准备事实。

Task 固定模板内容身份与输入来源，artifact 准入只引用准确 producer Task。
提交把真实程序、输入和产物存入 DSH 原生附件存储，并持久绑定 `sha256:` 内容引用。
下游从准确 verified producer 的附件读取字节；既有 revision manifest 记录 producer Task/Run，Bubble 绑定摘要。
输入名、来源、判据与模板错配及未 verified 在 Run 前拒绝；权威存储读失败在 Run 准备阶段记 runtime failed。

submitted 恢复和验证只读取权威附件；工作区文件改删不改变封存结果。
working 恢复仍核对已准备输入、模板与 revision。

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

W4 自动链已通过，证据为 `/tmp/singularity-w4-panel.json` 与同名 png：只发送一个用户 turn，
两个 child 与父 Run 分别 verified；dispatch/outcome 的 Task/Run/factSeq、原生附件字节与真实模型路由一致。
同会话重试、预算耗尽、准确父和 pending 唤醒有端口 spec；本轮没有追加对应模型 campaign。
来源读面归 W5。

core build、assembly 类型检查及完整 spec 通过；插件产物已重建。
W3 全量 gates 日志保留在 `/tmp/singularity-w3-gates-final.log`；W4 按主链节奏运行构建、相关 spec 和一次成功浏览器验收。
源码差异检查通过；计数反例样本末尾的两个 LF 是独立 verifier 的刻意失败输入。
