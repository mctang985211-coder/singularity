# BB-2：通用 BB Task / Skill / MCP 接线

前置：BB-1 的通用 Skill 已验收。工作区为 `/home/ROXY/code/bb_work/harness`，Singularity 子模块为 `packages/singularity`。本票只装配 BB 能力，不运行模型实验，不改 graph、Task 契约、准入/恢复协议或自进化机制。共享工作树中已有修改必须保留，提交只包含本票 hunk。

## 所有者与范围

- 通用 Task 参考正本是 Harness `.agents/skills/bb-pipeline/references/tasks.md`；方法正本是 Buckyball `.agents/skills`（Skill 子模块）。每个长图的环境 setup 将所需 Skill 安装到该图运行 cwd 的 `.agents/skills`；已有 loader 先读取该目录，Run binding 冻结实际选中的文件及内容身份。不新增搜索服务、包装 Skill 或模板数据库；不要用全局同名 Skill 冒充已安装的本图资源。
- 能力映射归 Harness 部署配置 `config.yml.example` 和本机忽略的 `config.yml`。`integrate-model` 使用 `model-integration`；设计 Skill 只给方法，构建/验证由目标需要的能力取得工具。设计节点不必为了读取构建事实直接获得所有 MCP，也可派具备对应能力的子 Task。
- 删除 `task-runtime/src/index.ts` 内置的 BB 能力表：核心无 BB 默认能力，部署未配置能力时保留空表并对请求显式报缺口。更新实际消费者与必要测试夹具，不把领域表搬到另一个核心文件，不留旧导出/兼容别名。不重写能力解析或 provider 规则。
- 删除 BB 回归能力对未安装的 `bb-verify` preset 的强依赖，复用已存在的部署默认/standard preset 和 per-Run 工具授权；不把 legacy verify-runner 搬回来。若本机显式 defaultPreset 有现场配置，保留它，不能由本票偷偷替换。
- 复用已有 `bbdev` MCP；配置中增加需要实际使用的 `run-uvm-regression`、`measure-ppa`（均为现有 `verify` 方法 + `bbdev`），它们只在任务要求时使用，不自动开启。把 `waveform` 的真实程序 `{repoRoot:buckyball}/thirdparty/waveform-mcp/target/release/waveform-mcp` 经现有 `MCP_SERVER_REGISTRY` 接线，并使 `analyze-waveform` 绑定它。RTL 回归仅挂 bbdev，波形分析另取能力，不要求每次 RTL 运行启动波形工具。
- 复用 bbdev 中已有构建、validate、BEMU、Verilator、UVM、DC/Yosys、task_status/cancel 工具；不为同一事实再建 tools、submit/poll 队列或 CLI fallback。仅按真实 MCP schema 修订 `bb-pipeline` / `bb-obligations` 的相关接线说明。

## 验收（派发时原样交给实现方）

BB2-1：未配置 BB 的 runtime 不再发布 BB capability；显式 BB 配置仍解析并产生正确的 Skill/MCP manifest。`integrate-model` 指向本票领域 Skill；能力不引用缺失 preset；未知能力/MCP 和缺资源保持具名拒绝。定向验证移除默认表后的实际消费者，不恢复硬编码。

BB2-2：在无用户全局 Skill 的隔离 cwd 中安装 BB-1 Skill 和 BB Task 参考，真实 loader 能发现并读取它们；每份 Run binding 指向正确的已安装文件及内容身份。实例化两个不同通用子契约并经现有规范化/准入接口接受（例如注册检查、模型接入），不需要新 Task 模板服务；一个未列入目录但合法的契约也能接受。用 scripted fixture 验接线，不跑模型。

BB2-3：同一 env 绑定将 `bbdev` 与 `waveform` 解析到该 env 的真实 Buckyball 路径；实际 MCP `initialize/list_tools` 成功。用 `validate` 对显式 chip 取得真实结果，再用一个临时 VCD 做 waveform 的最小读操作，证明工具可达；缺 binary/server 必须失败，不能只拿 mock 或工具名列表填通过。不要求构建模型、跑 RTL/UVM/PPA；这里验的是已有工具装配，实际任务功能验收另由实例承担。

BB2-4：只跑能力、Skill 发现、MCP env 绑定的定向检查及必要的受影响包构建/类型检查；不跑全量单测/集成或下载模型。交付各项真实命令、结果、文件/符号及删除清单；本机 `config.yml` 不提交。同步主 guide 与唯一计划最多标待验收，提交内层和外层对应指针，完成后停止。
