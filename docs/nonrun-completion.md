# 四项工程收尾与待实跑边界

本页记录此前四项工程治理交付。本轮递归交付和 Agent 接口修改的完整对照见[改进指南实施验收](guide-implementation-20261024.md)。

2026-10-24。依据[改进指南](优秀singularity改进指南.md)完成的工程范围如下。该清单不宣称已经完成真实效果实验、正式研究预注册或公开授权。

| 工作 | 已交付 | 验收入口 |
|---|---|---|
| 统一质量检查与覆盖率 | ESLint/Prettier、编辑器配置；质量检查进入 core/native/完整 verify；公开 CI 保存覆盖率报告；全树一次性统一代码格式并保留变异原意 | `pnpm lint`、`pnpm format:check`、`pnpm coverage:core` |
| 不可变实验证据包 | 冻结 commit/dirty/untracked/锁/DSH 补丁和输入；原生控制链/session/附件/候选/资产消费只读导出；全部 trial、未知费用与失败保留；SHA256 manifest、外部冻结身份、只读封存、聚合与搬迁重放 | [研究工具](../research/README.md)、experiment.spec、原生 root-tools 导出用例 |
| 完整上下文与漂移审计 | 原生 policy、工具 Schema、dispatch/contract/method/direction/handoff、模板/Skill/实际读取页全源目录；四角色原生请求捕获与逐组件字节计量；authoring 与审核共用三项 criteria；旧字段清理；所有文档身份目录和旧工程证据只读 fixture | [上下文审计](context-governance.md)、`pnpm audit:context`、`pnpm audit:docs` |
| 研究准备、复现与制品治理 | H0/workflow/强基线/消融的冻结合同与准入校验；family/source 隔离、独立 pilot 合同、固定顺序/预算/统计/缺失规则、heldout 前分析与 Method 冻结；跨机器步骤；private/UNLICENSED 元数据与真实 tarball 校验；RRSI/DSH 及 24 个浏览器运行时依赖的原始许可随包 | [研究合同](../research/README.md)、[LICENSE](../LICENSE)、[NOTICE](../NOTICE)、`pnpm audit:distribution --pack` |

覆盖率只用于发现盲区：core 报告中的 command/Review/Release 等空白多数由 native 集成承担，不能据 core 百分比推断完整测试缺失或项目收益。没有为提高百分比添加与实现同构的测试。

格式化只改变风格，实验工具只处理离线材料；不新增产品状态库、workflow 执行器、模型请求或研究结论。旧 mutation 中一个“trial 计数差一”编辑本身有多余逗号，已修成有效计数错误，并实际见证被领域探针的计划槽位反例捕获。其余格式化锚点保持原变异和见证含义；不声称本次执行了全部 mutation。

仍待实跑：真实独立 pilot、据此最终确定样本量并登记正式研究、H0 与冠军的真实未见族比较、按主张增加强基线/消融、实际跨机器重建与领域复验。预注册模板刻意保留未填项，校验器会拒绝把没有真实任务或 pilot 的草案冻结为研究；这些不能靠工程脚本编造完成。

远端 GitHub job 未在本地任务中触发；公开 CI 配置有本地无私有宿主验证。公开许可维持原有 private/UNLICENSED，权利人未来选择公开许可证是独立决策；本次已经明确许可边界、包元数据、制品和第三方通知。
