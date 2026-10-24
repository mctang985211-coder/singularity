# 完整上下文与规则权威审计

2026-10-24；Task v27 / Strategy v10 / Measure v6 / Review v8 / snapshot v15。本页是维护者审计记录，不注入模型。当前架构和责任见 [architecture](architecture.md)。

## 审计结果与来源

| 模型可见材料 | 唯一权威来源 | 装配与边界 |
|---|---|---|
| DSH system policy、persona、原生工具与压缩规则 | 固定 patched DSH；dsh-baseline.json 标记身份 | 原生 systemPrompt / Tools 装配，不能只量项目角色字符串 |
| 所有节点共有的合同、读写边界、等待规则 | prompts.ts 的 protocol | guidanceFor 只追加当前 role，agent.ts 注册一个 singularity:protocol section |
| root/task/review/improve 的判断任务 | prompts.ts 的 roles | 每次只投递一种 role，不继承父角色 |
| acceptance/proposal/publication 审核用途 | prompts.ts 的 reviewGuidanceFor | review.ts 从冻结 target.kind 选择单一片段，subject 提供实际标准和证据 |
| 角色、等待态与搜索态的能力 | tool-policy.ts 的 roleTools/toolsFor/sectionAllowed | 注册限制、实际请求工具与原生 sections、执行 guard 共用；jobs section 显式归属，Skill 目录另由隔离的 pinned provider 控制 |
| 工具参数、字段含义、分页单位及上限 | agent.ts 的原生 Schema | 不复制一套工具使用手册到 system；read 结果的 next/complete 是实际分页事实 |
| Task 合同与准确输入 producer | 已提交 Task/Run / Bubble | scheduler、native-solve 派发准确冻结合同；方向、handoff、Method 不增加验收要求 |
| 父子关系、支持责任、当前轮次与预算 | coordination、rsi-state 等 committed projection | dispatch 保留必要事实；动态状态按需读，不每步重发全局快照 |
| workflow/template guidance、Skill/Tool 目录 | 固定 Method 资产；method-run.ts 控制交付与消费 | 短 guidance/目录实际投递，Skill 正文只有读取后才进入会话；绑定不等于读取或遵循 |
| 提案机制、完整性、保持的语义判断 | rsi-policy.ts 的三项 rsiProposalCriteria | 同一对象用于 authoring 和 proposal ReviewRun；从 role/说明性规则删除同义政策副本 |
| 分析流程与冻结槽的使用 | rsi-policy.ts 的 analysisRules/proposalRules | authoring 页按需提供；身份、格式、实际 diff、预算由宿主检查 |
| Method/Proposal/Report 的可解析格式 | method.ts / rsi-proposal.ts | authoring 提供模板与格式；删除格式说明中重复的“单机制”政策句 |
| 数值、分数、成本、轮次和发布状态 | 宿主 measure/strategy/release 事实 | 作者解释机制与局限，不手抄数值；review.ts 冻结事实给报告 reviewer |
| 父背景与 handoff | 原提交事实和 parent-memory.ts | 可选工作笔记；不得改合同、扩权限或当作验收证明 |
| 按需 subject、feedback、trajectory、Skill 页 | 实际有权读取的原生工具结果 | read.ts 和 Skill provider 返回真实页；消耗和分页轨迹与请求历史一起计量 |

审计发现并清除了 author role、proposal rules、proposal format 对三项 criteria 的同义要求；authoring 现在直接引用实际 reviewer criteria 对象。保留必要的接口语义和当前事实，不把“宿主能拦截参数”误当作“模型不需要知道判断任务”。人类接口文档可以解释同一行为，但不作为第二份模型政策注入。

## 可重跑的测量

`pnpm audit:context` 输出上述完整源清单、字节数和 SHA256；这是源码清单，不是实际请求费用。`node scripts/context-audit.mjs capture.json` 对完整请求逐项测量 system、所有工具 Schema、全部会话消息与 dispatch 各字段；实际读取的 Skill、模板、格式、反馈及分页结果随工具消息计入。返回每项摘要、UTF-8 字节数和位置，避免只量 system 或重复加总子字段。缺少 capture 不能声称已经量到真实上下文。

capture 是 `{schemaVersion:1,kind:"offline-native-fixture"|"research",requests:[完整原生request]}`。原始捕获应在 provider 端口收到请求后立即序列化；不得用事件摘要或只包含最后 user message 的导出冒充完整请求，不能重构压缩前已经被移出的内容。DSH system/message、request/header 与原生消息/工具结果保留为可核查来源。工具不估算 tokenizer，不将字符下降换算成账单节省。

原生 `assembly/tests/root-tools.spec.ts` 在无网络 provider 上截获真实装配的四种 role 请求；每种包含 DSH 系统规则、实际 Schema 和派发历史，检查 policy 只注入一次、工具名不重复及角色边界。可设置 `SINGULARITY_CONTEXT_CAPTURE=/persistent/audit/requests.json` 保存这些工程请求，再运行 audit:context。method-context 的独立行为用例覆盖 guidance 送达、目录不展开 Skill、实际读取才记消费；分页与冻结读取由现有 read/Review 反例覆盖。工程请求不代表实际研究任务的全部读取分布。

真实研究须把全部实际请求捕获、实际 on-demand 工具结果和原生轨迹放入证据包的 context/trajectory 类，再比较完整请求、重复回放与 native usage。capture 可能含私有任务与输入，按证据包的访问和去敏说明管理。没有实跑数据时不声称上下文、费用或质量已经改善。

## 历史漂移处理

README 的 search 入口统一为 executionPhase；工具 Schema 同步命名。所有历史计划、审阅和实验文档均在[文档目录](documentation-index.md)标明身份和适用范围；历史原文中的协议与数字保留，不能把当时的 verify 数量或阶段设计当成当前规则。不可变旧工程实验材料在 tests/fixtures/legacy，按原 commit 和 SHA256 读取，不输入当前 reducer。
