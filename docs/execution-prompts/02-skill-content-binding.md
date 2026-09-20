# P2 Prompt：绑定单文件 Skill 候选的验证与应用内容

请实现本任务。首先阅读并遵循同目录 `README.md` 的全部公共执行合同。
绝对路径：`/home/ROXY/code/bb_work/harness/packages/singularity/docs/execution-prompts/README.md`。
前置：P1 已验收并进入当前工作区。只执行 P2，不实现 P3。

## 问题和范围

当前 replay-report 有摘要，但 apply 重新读取 sandbox 的 SKILL.md；报告未绑定候选文件内容，可能验证 A 后应用 B。

只处理现有 `targetType: skill` 的单个 `SKILL.md`，使用 SHA-256 内容身份；不扩展多文件 Skill、preset、capability 或通用内容仓库。不实现真实证据来源认证、独立 verifier 或 supervisor 调度。不能把内容身份等同于 Skill 功能正确。

主要落点：`agent-singularity/src/evolution.ts`、`src/replay.ts`、`src/tools/evolution-replay.ts`、必要的 decide/apply 预检及 Evolution 测试。

## 固定行为合同

1. prepare 为实际物化的 Skill 文件记录 SHA-256；摘要针对精确文件字节，不做 trim 或换行转换。与 proposal/target/skill 名称关联，重启可恢复。
2. Skill replay 报告携带同一候选内容身份；记录报告的服务入口必须检查身份与 prepare 一致。仅工具层检查不算完成。其他 targetType 不被强制套用 Skill 字段。
3. replay 执行前检查候选；执行结束后、写入 replayed 记录前再次检查。中途发生并持续存在的修改必须拒绝，不能留下有效 replayed 状态。运行时 overlay 必须指向被检查的该候选，禁止验证生产 Skill 却记录候选摘要。
4. 人审前预检以及 decide(PROMOTE)/apply 的服务入口均检查身份；已有报告摘要、observed/holdout 闸继续有效。
5. apply 从文件读取待应用字节，校验其摘要，然后写入这同一份已校验字节；不能检查路径后重新读路径来写生产。后续源文件替换不能让未校验内容进入生产。
6. 候选文件缺失、内容不同、非普通文件或候选路径经过符号链接时明确拒绝；在创建候选及访问时保留现有路径限制。使用 Node 标准文件 API，不引入通用文件系统平台。
7. 失败不写生产、不追加成功晋升状态；允许记录明确的失败诊断，不将失败转为成功。纠正候选需要新提案/评估，不能静默重算摘要修补旧记录。
8. 无新内容身份的旧 ledger 可读取；旧已应用对象仍可回滚。旧 Skill 候选不能直接新晋升，错误提示说明需要新建候选重新评估。

范围边界：保障正常 agent 工作流中持久存在的内容变化和 apply 的读写一致性。恶意外部进程在 replay 期间瞬时改写又恢复、特权进程篡改 ledger、跨进程文件系统隔离不属于本票；不得声称实现了这些保障。

## 验收

| 编号 | 确定性测试与结果 |
|---|---|
| P2-A | 未修改候选完成 prepare/replay/gate/decide/apply；生产内容逐字节等于被验证内容，报告和 ledger 身份一致 |
| P2-B | prepare 后、replay 执行期间、replay 后、批准前后分别改动候选；对应后续操作拒绝，生产不变、不追加成功状态 |
| P2-C | 删除候选、换成目录、候选文件或路径祖先替换为符号链接均拒绝；外部链接目标不被写入 |
| P2-D | 通过确定性受控 hook/mock 在 apply 完成候选读取后替换源文件；生产只能写入已校验字节或整体拒绝，不能写入替换内容；禁止依赖 sleep 制造竞态 |
| P2-E | 报告候选身份缺失/伪造时，即使报告其他明细与总评合法，也不能记录为有效 Skill replay 或用于晋升；直接调用服务同样拒绝 |
| P2-F | 重开服务仍执行相同检查；旧无字段 ledger 可读、旧 applied 可回滚、旧未应用 Skill 不能绕过新检查 |
| P2-G | 不合法候选在人审前被拒绝；审批等待期间发生变化，审批结束后服务复检拒绝；原有 holdout/report-digest 负例仍通过 |
| P2-H | 公共检查全部通过；持久化变更记录与两个 guide 已更新 |

正向回归必须通过实际 evolution_replay 工具路径连接运行时 stub，捕获并核对 overlay 和报告身份；不能只手造一份 report 测服务，从而遗漏真实工具接线。stub 不代表真实 LLM 执行。

## Guide 与下一步交接

主 guide §4.1、G2/G7、§5.5 更新为“单文件 Skill 候选内容已绑定”，明确其他目标与真实证据来源仍待建。建设计划只标记内容绑定的本切片完成，S1-C/S4 仍为部分完成。

交接 P3 时列出新增字段、兼容规则和内容读取/检查入口，P3 必须复用本票身份语义，不另建一套摘要体系。
