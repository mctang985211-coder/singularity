# K3：按实际可加载单位改进 Skill

你是本票实现主代理，工作区和检查沿用[公共合同](README.md)。修改前保存基线；核对 K2 已验收及其恢复/阻断入口。本文件为完整合同，只读当前 guide 与相关源码。

## 交付与固定范围

已有执行型 Skill 可以同名改进、真实比较、应用和回滚，不需要不停换名或人工改摘要。`evolution` 拥有候选、实验与生产提交；`task-runtime` 沿用唯一 sidecar 校验、provider 准入与 Run 内容绑定；工具只适配。

1. 一个候选的完整目标固定为一个已有 Skill：无 sidecar 的指导型只有 `SKILL.md`；带执行型 sidecar 的有 `SKILL.md + SKILL.contract.json`，且 `resources=[]`。其他资源、knowledge sidecar 和角色转换本票明确拒绝。保留指导型路径，不把它另包装成一种引擎。
2. 保留现有 Skill mutation 的 name/content 输入。prepare 从生产读取并冻结完整支持对象；存在执行型 sidecar 时只按候选正文重算其中 `content.skillMdSha256`，其他字段逐项保持。模型不提交任意 sidecar 补丁；未知输入字段直接拒绝。变更 verifier、capabilities、requiredTools 或新增 provider 仍属其他合同，不借内容更新提权。生产未声明的资源也拒绝，不能漏掉文件后声称是完整对象。
3. champion 与 candidate 实验工作区都装入各自完整对象；复用 DSH loader、统一 provider 校验与 S4-E 双侧真实运行。冻结、报告、PROMOTE、apply 复检均比较同一完整内容身份；不能沙盒验证指导型、生产留下旧执行型 sidecar。已有 Skill sidecar 的 verifier 身份和冻结任务裁判均不随候选弱化。
4. apply/rollback 扩展 K2 的同一意图与恢复入口处理这两个固定文件，不新建第二提交器。涉及文件恢复前可读到各自旧/新内容的组合，但此 Skill 始终不可新准入；全部文件对账、可加载检查及 registry 更新完成后才记完成并放行。已绑定 Run 保持原版本。rollback 同样覆盖完整对象且拒绝覆盖后续变更。
5. 同票更新 candidate/prepare/replay/gate/decide/apply/rollback 的实际消费者、schema、返回说明与部署 prompt；删除“只接受单文件所以已有 execution Skill 无法更新”的分支。A6 后续只增加 capability 行和新 provider，不再重做已有 Skill 更新、实验或提交机制。

不建任意目录打包器、patch DSL、Skill 版本服务、资源扫描新框架或兼容别名。复用已存在的内容扫描/摘要 API，能直写两种具体形状就直写。副作用一致性不能通过删除 sidecar 校验“简化”。

## 验收

| 编号 | 必须证明的结果 |
|---|---|
| K3-1 | 真实注册的同名 execution Skill，旧内容失败、新内容通过，回归/holdout 不退化；候选及应用后新 Run 确实加载正确正文+sidecar，未靠人工改生产摘要。 |
| K3-2 | 无 sidecar 的指导型原路径仍通过；sidecar 非摘要字段变化、任意资源、角色转换、坏摘要、裁判/权限漂移在相应写前拒绝。 |
| K3-3 | prepare 后改任一文件，实验或晋升/应用拒绝；baseline 与 candidate 各自完整且隔离，不能把历史 Review 当本次基线。 |
| K3-4 | 两文件应用及回滚每次替换后、registry 更新前和完成记录前退出重开，混合版本不能准入；恢复成完整目标、完成记录唯一。旧绑定 Run 不热换，第三方变化不被覆盖。 |
| K3-5 | 当前格式读回/回滚及公开工具完整链通过；生产只有一个实验器和一个提交协议，schema/prompt 无旧单文件误导，公共检查通过。 |

确定性 provider 只替换模型，其他实际模块不替换；本票证明可执行机制，不声称模型已经自主学会更好技能。数据格式需要变更按公共单版本规则处理，不加兼容 reader。

更新主 guide、唯一计划 K3 状态与受影响的 F.2/F.4、角色说明和持久化记录。只写一份精简交付记录，提交本票及外层指针，最高填待验收并停止；审核后派 K4。
