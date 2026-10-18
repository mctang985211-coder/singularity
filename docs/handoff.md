# 接手入口

更新：2026-10-19。整体审查基线 `4314487`；当前 Task v23 / Strategy v9 / Measure v5 / Review v5 / snapshot v13，只用于新图。已实现与待验证出口统一维护在计划第 9 节。

按以下顺序阅读，无需重读全部历史：

1. [Task / Workflow RSI 终局计划](task-first-domain-rsi-plan.md)：先读第 1/6 节架构和第 9.1 节施工顺序；含 20 项发现、T00–T16、研究/Buckyball 与提示词规范。
2. [blueprint](blueprint.md)：总目标、范围、架构与文档职责。
3. [context](context.md)：用户已确认的合同、未关闭问题与验证边界。
4. [assembly-blueprint](assembly-blueprint.md)：现有装配边界及历史施工依据，新顺序以整体计划为准。
5. [phase-g2-design](phase-g2-design.md)：当前任务运行合同。
6. [spec-policy](spec-policy.md) 与 [standalone-dsh](standalone-dsh.md)：验证规范与私有环境。

最新 RSI 提示与 JSON 合同统一后 `pnpm verify`：退出 0，构建/类型检查、90 文件/946 测试/7 门禁通过，日志 `/tmp/singularity-rsi-prompt-verify.log`。静态拒绝、模板填写与解析、read.kind 必填、批次附件冷恢复、取消/失败收口、步骤上限、非法 prune 和发布提交区竞态已有回归。本轮尚未部署或真实模型重跑；更早异步等待不稳定仍保留为未定位历史问题；各阶段历史验证见计划第 2.2 节。

最新只读复核：`/home/ROXY/singularity-next/buckyball-commandcode-rsi-20261018-214154`，snapshot cutoff 80。业务根 `task-039780304071e184` 已验收；RSI 报告已验收、completed，但六个单槽批次全部 invalid，零 round、零候选比较、零 transfer 或新方法发布。第 1–3 次缺 `eventSeq`，第 4、6 次 finding label 跨三类重名，第 5 次缺完整 Method 集合；其 workflow target 本身正确。报告将失败归因于 `rootId` 或 workflow target 宿主错误的解释不成立。运行中一次 DSH 原生重试已恢复；此次无测评的直接原因是结构提交失败。

本轮采用唯一 paths 入口内的纯静态整批预检：JSON/schema、完整 Method、实际 diff、冻结 evolve case/family ID。新批次任一文件失败则整批不冻结、不扣槽；通过后冻结预检的同一份 bytes。已有 pending 只从附件恢复。冻结后的证据有效性、reserved/prune、critic、duplicate 与 smoke 失败仍扣槽，repair=0，不新建工具或候选状态机；预检不读取证据正文、不调用模型或执行候选。完整 Method 必须包含 workflowGuidance/templates/skills/tools，三类 finding label 全局唯一，错误须定位文件与字段。

RSI 提示与输出合同已统一，见 [RSI agent 工作合同](rsi-agent-contract.md)。开始、恢复或压缩后无 `ref` 读取 `kind=method`，完整资产只在 `proposal.template.method` 中返回一次，另有 `reportTemplate`；审核 dispatch 提供真实 digest/criteria 的 `output.template`，默认 verdict 为合法 `unknown`。`singularity_read.kind` 必填；公开领域知识与题目答案泄漏分开；报告陈述提交前事实，suite 私有验证/发布在报告封存后由宿主执行。尚未用真实模型重跑新模板。

用户要求 provider 直接使用 DSH：已删除 `provider.ts`、partial-output veto、自定义 flush/耗尽判断、整图停机/重启和 provider 状态侧日志；失败映射只消费原生 turn/end，保留原始错误码。历史 CommandCode 的第 58/151 步无重试断流均由旧 veto 导致，原始记录保持只读。该阶段 snapshot 为 v12，部署重试阈值未变，88 文件/903 测试/7 门禁通过，日志 `/tmp/singularity-native-provider-final-verify.log`；当前协议与验证以上文为准。

Task/Workflow、整图预算、case×trial 矩阵、历史 S*、有界单机制搜索、反馈，以及冻结 champion 后的独立验证/审核/CAS 已有工程实现与离线见证；T06 采用稀疏模式，不实施退火。Buckyball 最小 C/ISA 投影、6 题/3 族合成 pilot、私有独立 scalar+BEMU oracle 与隔离预检已具备。完整 pilot 逐题执行入口尚未接通：experiment run 只启动第一个 evolve 业务 root，有效候选触发 round 后才运行相应 split 的完整测评矩阵，冻结 suite 不会自动补跑其他 pilot 业务案例。

较早只读检查 cutoff 247：首次业务根 `task-2d32b3cb8b21b08e` 已 `verified / accepted`；一个候选通过 critic 和加载检查，基线有效 2/4、候选有效 0/4，学习因 DeepSeek HTTP 402（余额不足）失败；未进入 transfer，也无新方法发布。完整状态保存到 `/home/ROXY/singularity-next/buckyball-pilot-20261018/progress-check-20261018.json`，保留该历史事实。

真实模型策略的因果效果、复杂任务收敛和领域迁移仍未验收。pilot 每 split 只有一族，未达冻结的最少三族统计门；不覆盖全仓递归依赖、MLIR/RTL/PPA。T12 仍缺另一机器复现与公开交付条件，T14/T16 实验和 T13 领域效果保持未完成。实现基线与提交记录以 Git 为准，旧协议实验不迁移。常规实现按已授权目标推进；真正影响业务含义且无法从契约确定的歧义才询问。

每包完成后更新 context 的当前状态和原计划中的出口状态，删除关联失效代码、注释和重复断言。
历史实测按基线保留，过程解释放 Git；不追加新交接计划，不把静态绿色结果改写为产品完成。
