# BB-2 交付记录（待验收）

合同：[通用 BB Task / Skill / MCP 接线](../execution-prompts/17-bb-capability-mcp-wiring.md)。基线：Singularity `8f6a275`、Harness `93b1996`、Buckyball `3d9ad0b9`（Skill 子模块 `ef89fa7`）。内层与显式路径以外的 Harness 资源见外层同步提交；原始工具证据在 `/tmp/bb2-evidence/{bb2-1,bb2-2,bb2-3,verify-bb2-1,verify-bb2-2,verify-bb2-3}/`。

## BB2-1 核心删除与部署能力映射

- 删除 `task-runtime/src/index.ts` 的 `DEFAULT_CAPABILITIES`（原 995–1035）及 doc block/导出：核心无 BB 默认能力，无替换表、无兼容别名。`ConfigSchema` 缺省与构造回退为空表（`src/index.ts:1015,1771`），未配置能力的请求走既有具名缺口路径（`capability.ts:250-275`、`index.ts:4119-4141` 等），解析/provider 规则未动。
- `task-runtime/src/mcp-servers.ts` 增 `waveform` 注册项（`{repoRoot:buckyball}/thirdparty/waveform-mcp/target/release/waveform-mcp`，args `[]`，cwd `{repoRoot:buckyball}`）；`bbdev` 复用未改。
- `config.yml.example`（tracked）的 task-runtime 行改为可用示例：15 行能力表；`integrate-model → [model-integration]`；verify/bemu/verilator/uvm/ppa = `[verify] + [bbdev]`（verilator 只挂 bbdev；`run-uvm-regression`/`measure-ppa` 仅任务要求时命中）；`analyze-waveform = [waveform] + [waveform]`；去掉全部 `bb-verify` preset；`research = preset standard`。本机 `config.yml` 同表且 `defaultPreset: standard` 等现场设置保留；`tools/scripts/sync-api.mjs --emit-patch` 已重新生成 `.dsh/profiles/web/cordis.patch.yml`。
- 测试夹具改为局部表：`capability` / `orchestrate` / `mcp-servers` / `obligation` / `review-record` / `task-tools` 各 spec，另修 `agent-runtime/tests/unit/skill-file.spec.ts` 中因 BB-1 改标题而过期的断言行（HEAD 即红）。
- Harness 两个 Skill 只改接线说明：`.agents/skills/bb-pipeline/{SKILL.md,references/tasks.md}`、`bb-obligations/{SKILL.md,obligations.yml}`。
- 命令与结果：`pnpm -C packages/singularity/task-runtime exec tsc --noEmit` exit 2、34 个错误全部为 HEAD 已有（改前行区间 0 命中，证据 `21-attribution`/`41-attribution`）；`pnpm -C packages/singularity/task-runtime run build` 成功并重建 `lib/index.js`、`lib/index.d.ts`；定向 vitest 173（capability+orchestrate）+ 112（task-tools）+ 23（mcp-servers+obligation）全过；配置解析证明脚本输出 15 行、skill/MCP manifest、空表具名缺口、未知 MCP 具名拒绝。

## BB2-2 Skill 安装 / 发现 / Run binding / 契约准入

- 安装机制：loader 的发现根为 `<env 检出根>/.agents/skills`（`agent-runtime/src/skill-file.ts:113-128`），安装沿用现有文件操作（`mkdir -p` + `cp -rT`，与既有 spec 的做法一致）；runtime 无安装服务、无全局 Skill 回退，不把用户全局同名 Skill 当领域资源。
- 实装 `environment/project42`（bb-live，gitignored）：6 份 BB-1 Skill + `bb-pipeline`/`bb-obligations`（8 目录 10 文件），逐文件 sha256 与来源一致，重复执行幂等；命令注释见 `config.yml.example:130-137`。
- 新增 `packages/singularity/tests/integration/bb-skill-install.spec.ts`：隔离 HOME/DSH_HOME + 同名 decoy；真实 loader/pre-check 发现并读取安装文件；Run binding 指向已安装快照且摘要一致（decoy 从不被采用，worker 只挂快照）；三个子契约——`check-ball-registration`、`integrate-model` 与目录外合法的 `track-bb-obligations`——经现有规范化/准入通过并 verified。无新 Task 模板服务。
- 命令与结果：该 spec 2 用例通过（verbose 下两个 describe 均实际执行）；回归 `run-binding`/`provider-precheck`/`sidecar`/`skill-file` 88 通过。

## BB2-3 真实 MCP 可达

- 同一 env 绑定：从真实 graph 记录（`graph22 → envId project42`，`.dsh/sessions/_no-cwd/graphs-registry`）与真实 `EnvStore` 记录出发，经 runtime 自身的 `resolveMcpEnv`/`resolveMcpServerSpecs` 解析：`bbdev = <env>/DangoSys/buckyball/scripts/claude/run_mcp_server.sh`，`waveform = <env>/DangoSys/buckyball/thirdparty/waveform-mcp/target/release/waveform-mcp`（realpath 指向 `/home/ROXY/code/bb_work/buckyball`，两者可执行）。
- 实际 `initialize`/`list_tools`：bbdev `buckyball-dev` 45 tools；waveform `rmcp` 7 tools。
- 真实调用：`validate{chip:"toy"}` → `passed:true`（chip 配置与 balldomain TOML 独立复核）；`validate{chip:"poly"}` → 真实失败 `'tiles'`；临时 VCD 上 `open_waveform` + `read_signal{top.data,time_index:6}` → `8'h03`（按 VCD 文本独立核算一致）。部署挂载路径（`applyWorkerGrant` + 真实 `dsh-mcp-client`）worker A/B 分别得到 45/7 个 `mcp__*` 工具，互不泄漏，root 为空。
- 负例：缺 binary 时真实 `spawn … ENOENT` 与具名挂载失败；无 buckyball 组件的 env、无 env 绑定的 session 均具名报错（`no "buckyball" checkout` / `needs an env binding`）。
- 未覆盖：未启动完整 orchestrator 循环（用同一持久记录 + runtime 自身解析/挂载函数验证）；不跑模型/RTL/UVM/PPA。

## BB2-4 范围与检查

- 只跑能力、Skill 发现、MCP env 绑定的定向检查与受影响包构建/类型检查；未跑全量单测/集成、未下载模型、未跑 BEMU/RTL/UVM/PPA 实验、未推送、未部署；本机 `config.yml` 不提交。
- 删除清单：`DEFAULT_CAPABILITIES`（含 doc block 与导出）；`config.yml`/`config.yml.example` 能力行中的全部 `bb-verify` preset 引用（legacy `tool-verify-runner` 注释块保留未启用）。
- 已知边界（非本票范围）：`task-runtime` tsc 34 个错误与 `evolution.spec.ts` 17 个失败均为 HEAD 既有；`environment/` 安装是机器本地产物（gitignored），其他 Buckyball env 需按同一命令安装。
- 自检：BB2-1/2/3 的独立复核（V1/V2/V3）全部 PASS，证据见 `/tmp/bb2-evidence/verify-bb2-*`；外部定向审核未完成前不写已验收。
