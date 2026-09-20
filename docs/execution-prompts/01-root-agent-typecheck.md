# P1 Prompt：修复 root-agent 严格类型检查

请实现本任务。首先阅读并遵循同目录 `README.md` 的全部公共执行合同。
绝对路径：`/home/ROXY/code/bb_work/harness/packages/singularity/docs/execution-prompts/README.md`。
本任务无 P 类前置依赖，不执行 P2/P3。

## 目标和范围

修正 `agent-singularity` 的严格类型错误，并让该包正常 build 在类型错误时失败。
2026-09-21 基线发现 12 处错误：工具调用传入普通 string 而非 SessionId、DiagnosisProposal.targetType 类型扩大、Evolution mutation 校验后未收窄。该数量仅供定位，以当前实际诊断为准。

主要落点：`agent-singularity/src/evolution.ts`、相关 `src/tools/*.ts` 和该包 `package.json`。现有 `build` 只有 tsdown，不保证严格类型检查通过。

固定实现规则：

- SessionId 从上游已有的身份类型/有效构造入口取得，避免先抹掉品牌类型再硬转回来；身份缺失仍应明确拒绝。
- 目标枚举使用现有定义；动态输入必须经过真实校验，不能把任意字符串断言成合法 targetType。
- mutation 的运行时验证应向 TypeScript 正确表达收窄结果，保留非法输入拒绝。
- 包的 build 必须先类型检查，再打包；从工作区执行 `pnpm build` 也必须经过该检查。
- 不改业务流程、审批次数、持久化格式或工具输入输出合同。需要修改共享类型时仅修正真实来源，不放宽上游合同。

禁止新增 any、ts-ignore、ts-nocheck，禁止关闭 strict、排除出错源文件或通过不安全类型断言消除诊断。不以广泛重构代替局部修复。

## 验收

| 编号 | 必须满足的结果 |
|---|---|
| P1-A | 该包 `pnpm exec tsc --noEmit` 零错误；被报告的错误逐项解决 |
| P1-B | 该包 build 与工作区 build 均成功；配置明确先检查后打包 |
| P1-C | 在该包 src 范围临时加入 `const typecheckProbe: number = 'invalid'`，包 build 非零退出并报告该错误；清理临时探针后 build 再次成功，探针不进入最终 diff |
| P1-D | 现有非法 mutation、非法 proposal target 和缺失身份的拒绝行为不被放宽；相关测试通过，若改动边界有缺失测试则补充 |
| P1-E | 公共合同要求的全量测试、持久化检查和 diff 检查通过，无禁止的绕过手段 |
| P1-F | 主 guide 与建设计划同步，明确该包已具备 build 类型闸，并移除“当前仍有 12 处类型错误”的过期当前态描述；保留历史记录 |

## 下一步交接

完成后标记 P1 完成、P2 可执行。给 P2 的交接信息包含构建命令是否变化及实际测试基线，不代做 P2。
