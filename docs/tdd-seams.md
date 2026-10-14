# 当前接口检查表

行为与验证规范见 [spec-policy](spec-policy.md)，施工顺序见 [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点)。
本文只列实现前需固定的边界，不另建 E/F 阶段路线或用户签字流程。

| 边界 | 实现前必须能表达 |
|---|---|
| 可信工具调用 | 真实 exec.agent/callId、准确责任、同请求原结果、异请求冲突 |
| Task/Run | 完整求解、唯一未结算尝试、等待/提交写闸、结算与封存来源 |
| 领域模板与产物 | 各自 TaskContract/verifier、固定输入来源、真实字节摘要、后序输入绑定 |
| Child runtime | 准确 parent/session；open/resume、投递、等待/drain、来源读取、close 的责任与错误 |
| 读面 | 同 committed cut、只读、准确 session/依赖/receipt；当前 cutoff 与封存 cutoff 分开 |
| 方法与发布 | 四类资产必要加载适配、真实消费、双侧试验、冻结决定、内容绑定人审与唯一发布 |

接口复用已有 core/DSH 类型；没有真实消费者的扩展点不预建。
先定语义和最小形状，再沿上述端口写失败 spec 与实现；接口必须能表达故障，不能依赖内存布尔值或兜底补齐业务含义。
已批准范围见 [context](context.md)。实际领域模板/产物 schema、实验预算与阈值尚未冻结时，通过提问工具确认；
不把每个函数或所有已确认接口再次交用户批准。
