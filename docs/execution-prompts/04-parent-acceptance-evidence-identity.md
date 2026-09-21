# P4 Prompt：独立父验收与证据身份（S1-V 切片 1+3）

请实现本任务。首先阅读并遵循同目录 `README.md` 的全部公共执行合同。
绝对路径：`/home/ROXY/code/bb_work/harness/packages/singularity/docs/execution-prompts/README.md`。
前置：P1/P2/P3 已验收并进入当前工作区（基线：Singularity `05cb27c`，外层 harness `c198457d56`，双仓 tag `baseline-p4-20260921`）。只执行 P4；S1-V 切片 2（verifier selftest 执行与输入身份）不在本票范围，后续单独派发。

## 问题和范围

当前父验收 = composite verifier 只检查"所有子任务 verified"（`verifier/src/composite-verifier.ts:verifyIn`），不能证明根目标：子任务各自通过但组合接口错误时父照样绿。同时 `requiresArtifact` 只查 store 中存在同名 evidence/kind（`task-runtime/src/orchestrate.ts:missingRequiredArtifacts`），不检查证据的验证状态与来源——失败 run 的同名产物可能被当作正确性证据。依据 KISS §6（C2/C4 最小机械版）与 §5.1，本票补两件事：

1. **父级验收**：父 AC 能声明"需要哪些子任务的哪条判据/哪类证据"，composite 校验该映射真实存在且证据来自 verified 状态；另加至少一个独立父级组合检查（接口/数值级机械判据；自然语言条款显式标注启发式，不计入确定性闭包）。
2. **证据身份与状态**：证据引用区分"原始输入"与"必须已验证的参考产物"；已验证要求检查证据所属 run 的终态与判据通过状态；失败/过期 run 的同名产物不满足依赖。

不做什么（明确排除）：通用自然语言蕴含求解器；C3 假设满足性的完整证明（只做映射指向存在性的结构检查）；verifier 四值语义与 PARTIAL/UNKNOWN 处置（S2-R 范围）；preset/MCP/skill 预检（S1-C 范围）；verifier selftest 正负样本执行（S1-V 切片 2）。

## 固定行为合同

1. 父级声明用可选新字段表达（父任务级或父 AC 级 evidence map，字段名由实现定），缺省完全兼容现行 composite 行为；旧任务、旧 store、旧事件回放行为不变。
2. 父 AC 声明了证据映射而映射不完整（指向的子任务/判据/证据不存在，或证据不是 verified 状态）→ 父验收拒绝，reason 逐字点名缺失项；不得退化成"子全 verified 即父过"。
3. 独立父级组合检查至少一条可机械执行（command 或结构化断言）：子任务全 verified 但组合接口错误时父必须拒绝。
4. `requiresArtifact` 语义收紧为"已验证参考产物"；为"原始输入"提供独立表达（不同字段名或显式前缀，由实现定），失败 run 产出的同名证据不满足依赖；产物已在且验证通过的合法跳过保持不变。
5. admission 对父级声明做结构校验（字段形状；指向存在性在验收期判）。未声明映射的父 AC 按现行行为，不额外拒绝。
6. "删掉父 AC 的证据映射必须拒绝"：父任务要求独立父验收（契约级标记或父 AC 带映射）而映射缺失/被删 → 新建/分解路径 admission 响亮拒绝，不静默降级为合取；已落库任务的 AC 不可变，删除只可能发生在新建/分解路径。
7. 新字段进事件载荷时遵守持久化纪律：先跑 `verify-persistence` 复核指纹，必要时补 `docs/persistence-changes/` 档案（照 diagnosis-recorded 格式，same-version 增量）；外部 Evolution ledger 合同不变。
8. 旧任务（无新字段）读取、回放、验收行为不变；replay 路径与普通分解共用同一校验规则。

## 验收

| 编号 | 确定性测试与结果 |
|---|---|
| P4-A | 父 AC 带完整证据映射且子任务全 verified，父验收通过（现行兼容正例） |
| P4-B | 子任务全 verified 但父映射指向的判据/证据缺失，父拒绝且 reason 点名缺失项 |
| P4-C | 证据来自 failed run（同名过期产物）时，依赖该证据的子任务与父验收均拒绝；verified run 的同类证据正常满足 |
| P4-D | 子任务全 verified 但组合接口错误（独立父级检查失败），父拒绝；自然语言型父 AC 的启发式判定显式标注、不计入确定性通过 |
| P4-E | 删除/篡改父 AC 证据映射后，按合同 6 拒绝 |
| P4-F | 旧任务（无新字段）读取、回放、验收行为不变；`verify-persistence` 指纹按纪律处置并有记录 |
| P4-G | 公共检查全部通过；guide §4.1（父验收 / Evidence 依赖行）与 §4.2 G1/G3 状态同步，建设计划 S1-V 切片 1+3 标记完成、切片 2 仍待建 |
| P4-H | 无范围外改动：不改 verifier 四值、不动 preset/MCP/skill 预检、不重启服务、不调真实模型 |

测试用真实临时 store 与真实 verifier/composite 链；并发时序不用 sleep 或概率循环；反例先红后绿。

## Guide 与完成交接

主 guide 更新 §4.1 父验收与 Evidence 依赖两行、G1/G3 标"部分"并写清剩余（C3 完整证明、verifier selftest 执行、证据来源真实性认证属后续票）。建设计划记录备份提交、实际验证命令与测试数、S1-V 局部进度；下一批列明：S1-V 切片 2、S2-E 自动缺口持久化。不要开始实现这些工作，也不要因 P4 通过就宣称独立父验收全部完成（C3 与 selftest 仍缺）。
