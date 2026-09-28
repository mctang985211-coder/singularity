# BB-1：把已有 Buckyball 方法改为通用 Skill

工作区：`/home/ROXY/code/bb_work/buckyball/.agents/skills`（独立 Skill 子模块），上层 Buckyball：`/home/ROXY/code/bb_work/buckyball`。旧方法来源在 `/home/ROXY/code/bb_work/legacy-harness-plugins`，只读参考；通用 Task 参考在 `/home/ROXY/code/bb_work/harness/.agents/skills/bb-pipeline/references/tasks.md`。修改前基线已保存在本仓库 `backup/bb-general-adaptation-20260928`。本票只交付领域方法，能力和 MCP 接线另属 BB-2。不要改 CosyVoice 实验、Singularity runtime、Harness 配置或其他 BB 工作树。

## 改动范围

1. 从 `legacy-harness-plugins/workload-integration/src/prompts/0-hints.prompts.ts` 提取已有模型来源、参考输出、导入、注册与运行比较的方法，新增 `model-integration/SKILL.md`。保留实际 BB ModelTest/CTests 路径与可复用 importer 的查找办法；去掉固定“模型侧/绑定轮”、CI/PR、阶段图、静态 audit 即完成的规则。不要增加模型导入器、脚本或服务。
2. 修订已有 `chip-designer`、`ball-align`、`verify`：把目标/验收/派发阶段从方法中分离。保留芯片拓扑/容量/IO 合同、Ball 语义/ISA/布局/足迹、参考与实测证据的方法；删除固定 lead/core 角色树、固定 Task 图/派发顺序、固定 replica/core 数量、占位目录即交付等规则。真实产物依赖仍保留：参考来源先于比较、构建产物先于仿真、提交先于终态查询；这些不规定节点图。节点自己决定实现或分解，Skill 不能决定图的形状，也不能宣布 Task PASS。
3. `verify` 只按任务要求选择 BEMU、RTL、UVM 或测量取证，保留必要的 submit → status/cancel 工具协议；不能无条件把所有 backend 或性能分析跑一遍。Verilator 示例按实际 bbdev MCP schema 使用 `chip`，不再用不存在的 `config` 参数或硬编码 ELF 命名。删除不存在的 `/debug` 依赖。只读 `check` 和 `waveform`，仅修正明确的工具名/参数/方法边界错误。
4. README 的现有 Skill 表同步新增模型接入行并更新用途，不另写指南。Skill frontmatter 保持 loader 支持的形状。通用资产不出现本次实验的模型版本、shape、权重哈希、专属测试目录、固定根图或 checker；BB 通用测试路径与现有项目先例可以保留。

## 验收

BB1-1：所有改动 Skill 经现有 Skill validator 解析；引用的是本仓库可用的 Skill、实际 BB 路径或真实工具，不依赖不存在的 legacy Skill 名。

BB1-2：独立审核者用两个不同场景阅读产物：已有 Ball 的行为修正、一个非指定模型的 workload 接入。二者均能找到适用方法；已有 chip 可满足目标时无需新建 chip，不要求固定子 Task 数量/顺序，不自动扩大 backend/性能范围。这是内容审核，不要求收费模型或跑仿真。

BB1-3：按 `buckyball/bbdev/mcp/tools/` 的实际声明逐项核对 Skill 中的工具名与示例参数；记录定位，`chip`/`binary`/`trace_id` 等不得从旧文档猜测。Skill 的说明和 agent 的自报不能替代独立 Task 判据。

BB1-4：diff 只含本票 Skill 与现有 README，不产生 runtime、框架、CosyVoice 或测试脚本改动；记录方法来源和删除清单。只做 Skill 解析和上述定向审核，不跑构建/全量测试，不下载模型。提交 Skill 子模块，再只提交上层 Buckyball 的 `.agents/skills` 指针，保护其他工作树改动。完成后停在待验收。
