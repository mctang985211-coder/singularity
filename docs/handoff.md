# 接手入口

更新：2026-10-18。整体审查基线 `4314487`；当前 Task v23 / Strategy v9 / Measure v5 / Review v5 / snapshot v13，只用于新图。已实现与待验证出口统一维护在计划第 9 节。

按以下顺序阅读，无需重读全部历史：

1. [Task / Workflow RSI 终局计划](task-first-domain-rsi-plan.md)：先读第 1/6 节架构和第 9.1 节施工顺序；含 20 项发现、T00–T16、研究/Buckyball 与提示词规范。
2. [blueprint](blueprint.md)：总目标、范围、架构与文档职责。
3. [context](context.md)：用户已确认的合同、未关闭问题与验证边界。
4. [assembly-blueprint](assembly-blueprint.md)：现有装配边界及历史施工依据，新顺序以整体计划为准。
5. [phase-g2-design](phase-g2-design.md)：当前任务运行合同。
6. [spec-policy](spec-policy.md) 与 [standalone-dsh](standalone-dsh.md)：验证规范与私有环境。

RSI 减量修复后 `pnpm verify`：退出 0，构建/类型检查、90 文件/944 测试/7 门禁通过，`pnpm run doctor`、`git diff --check` 通过。日志 `/tmp/singularity-rsi-state-final-verify.log`。错误提交不再提前关闭搜索；批次附件冷恢复、启动恢复、取消/失败收口、步骤上限、非法 prune 和发布提交区竞态已有回归。更早异步等待不稳定仍保留为未定位历史问题；详细证据见计划第 2.2 节。

用户要求 provider 直接使用 DSH：已删除 `provider.ts`、partial-output veto、自定义 flush/耗尽判断、整图停机/重启和 provider 状态侧日志；失败映射只消费原生 turn/end，保留原始错误码。历史 CommandCode 的第 58/151 步无重试断流均由旧 veto 导致，原始记录保持只读。该阶段 snapshot 为 v12，部署重试阈值未变，88 文件/903 测试/7 门禁通过，日志 `/tmp/singularity-native-provider-final-verify.log`；当前协议与验证以上文为准。

Task/Workflow、整图预算、case×trial 矩阵、历史 S*、有界单机制搜索、反馈，以及冻结 champion 后的独立验证/审核/CAS 已有工程实现与离线见证；T06 采用稀疏模式，不实施退火。Buckyball 最小 C/ISA 投影、6 题/3 族合成 pilot、私有独立 scalar+BEMU oracle 与隔离预检已具备。用户唤起后只读检查 cutoff 247：首次业务根 `task-2d32b3cb8b21b08e` 已 `verified / accepted`；一个候选通过 critic 和加载检查，基线有效 2/4、候选有效 0/4，学习因 DeepSeek HTTP 402（余额不足）失败；未进入 transfer，也无新方法发布。完整状态保存到 `/home/ROXY/singularity-next/buckyball-pilot-20261018/progress-check-20261018.json`，本次未重启任务。

真实模型策略的因果效果、复杂任务收敛和领域迁移仍未验收。pilot 每 split 只有一族，未达冻结的最少三族统计门；不覆盖全仓递归依赖、MLIR/RTL/PPA。T12 仍缺另一机器复现与公开交付条件，T14/T16 实验和 T13 领域效果保持未完成。实现基线与提交记录以 Git 为准，旧协议实验不迁移。常规实现按已授权目标推进；真正影响业务含义且无法从契约确定的歧义才询问。

每包完成后更新 context 的当前状态和原计划中的出口状态，删除关联失效代码、注释和重复断言。
历史实测按基线保留，过程解释放 Git；不追加新交接计划，不把静态绿色结果改写为产品完成。
