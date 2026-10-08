# Bubble 机制下 MCP Server 适配要求（2026-10-08）

本文给 buckyball、bbdev 等外部 MCP server 维护者：RSI 每轮 agent 执行将进入 bubblewrap 气泡，MCP server 必须满足下列契约才能在气泡内挂载。契约对象是 Harness `config.yml` 的 `task-runtime.config.mcpServers` 部署条目，以及 `{repoRoot:<repo>}` 占位符解析后的 `command` / `args` / `env` / `cwd`（`packages/singularity/task-runtime/src/mcp-servers.ts`）。

## 背景：每轮 bwrap 气泡

每个 RSI 轮次的 agent 执行发生在一个 bubblewrap 气泡里。气泡的可写根是本轮 workspaceRoot，语义不变，即 `session.cwd`（`thirdparty/deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts` 的 `resolve`）。bwrap profile 在现有 workspace-write profile（`--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind <ws> <ws>`，见 `sandbox-local/src/profiles.ts`）基础上，在 `--bind workspaceRoot` 之前插入 tmpfs 遮盖清单，遮住 `$DSH_HOME` 与仓库 `environment/` 等历史根（清单来自 sandbox-local 的 `isolationHiddenRoots`）。因此气泡内的进程看到的是：本轮工作区（可写）+ 只读的宿主根；看不到历史轮次的 state、日志与 `$DSH_HOME`。不遮 `$HOME`，不动网络命名空间。

root、round worker、replay worker 进气泡；supervisor 与评估面 agent 不进气泡（保持 danger-full-access）。MCP server 由 worker 进程以子进程方式启动，随 worker 一起落在气泡内，`cwd` 就是部署条目里的 `cwd`（`{repoRoot:<repo>}` 解析结果），环境是 Harness 净化后的父环境加显式 `env`（`mcp-client/src/transport.ts`）。

## 对 MCP server 的五条要求

**① 单命令启动，cwd 在工作区内即可运行。** server 必须能由一条 `command` + `args` 从 `cwd` 直接拉起，不依赖宿主机绝对路径，不依赖历史轮次遗留的宿主目录。`command` / `args` / `cwd` 经 `{envRoot}`、`{repoRoot:<repo>}` 解析后必须落在气泡内可见的路径。确实必需的外部路径（`/nix`、工具链、系统库等）必须在该 MCP server 的部署条目里显式声明为只读挂载需求，由 bubble profile 加入只读 bind；未声明的宿主路径一律视为不可用。

**② 状态写入限于工作区内或显式声明的状态目录。** 运行期产生的 pid、端口、日志、数据库、缓存都落在工作区内，或落在条目里显式声明的可写状态目录。不得写 `$DSH_HOME`、宿主 `$HOME` 缓存、或本轮 `--tmpfs /tmp` 之外的宿主临时路径。气泡的 `/tmp` 是本轮临时 tmpfs，轮次结束即丢弃，不能作为跨调用持久状态。

**③ stdio transport，默认不联网。** 走 DSH mcp-client 的 `transport: 'stdio'`（子进程 stdin/stdout，`env` 是净化环境加显式 `env`）。默认不得访问外部网络；需要联网（含 `nix develop` 拉取 flake input、下载依赖、访问远端服务）必须在条目里声明。`127.0.0.1` loopback 不受影响（气泡未 `--unshare-net`），但 server 若依赖 loopback 守护也必须声明，便于审计。

**④ 路径参数以气泡内工作区为根解析。** 工具入参（`file_path`、`log_dir`、`workdir` 等）与内部派生路径都从 process cwd（= 气泡工作区）= MCP `cwd` 相对解析，不得假设宿主绝对路径，也不得缓存跨轮次才有效的绝对路径。server 自身的位置应从 `__file__` / `argv[0]` 这类相对自身的锚点回推 repo root，而不是写死宿主检出路径。

**⑤ 不满足契约的 MCP server 不挂入气泡。** 契约是准入条件，不是尽力而为：起不来或写越界会响亮失败（DSH 行为），不得静默降级。退路是气泡内禁用该 server，agent 改走 `bash` / fs 工具完成等价操作；禁用必须显式记录，不能把缺工具伪装成能力缩减。

## bbdev 现状差距

buckyball 检出根 `scripts/claude/run_mcp_server.sh` 是 bbdev MCP 入口：`cd "$ROOT"` 后 `exec nix develop "$ROOT" -c python3 -u bbdev/mcp/__main__.py`。它与五条要求的差距：

- **① 单命令启动**：脚本先要求 PATH 里有 `nix`，否则回退 `/nix/var/nix/profiles/default/bin/nix`；随后 `nix develop` 需要可求值的 flake、可见的 `/nix/store`，以及可写的 nix eval / state 目录。气泡里 `/` 只读、`$DSH_HOME` 被遮、`$HOME` 只读，`nix develop` 很可能因无法写缓存而失败；lock 未缓存时还可能需要联网拉取 input。`/nix`、工具链、可能的网络都还没在部署条目里声明。
- **② 状态写入**：`bbdev/mcp/common.py` 的 `REPO = Path(__file__).resolve().parents[2]` 相对自身文件回推，这一点好；但它用 `nix develop --command <checkout>/bbdev/bbdev start --server --port 5100-5500` 拉起本机 HTTP 守护（`start_new_session=True`），并写 `bbdev/api/data/state_store.db`、`bbdev/server.log`，依赖 `bbdev/api/.venv/bin/motia`。这些都在检出内，落在工作区内（②满足），但 `.venv` 必须在气泡工作区内已存在——当前缺 `.venv` 时的报错是让用户用 `uv venv` 安装，气泡内多半装不了。守护进程的生命周期必须与本轮气泡一致，不能假设跨轮复用同一 server、端口或 state。
- **③ 网络/transport**：MCP 本体是 stdio，运行时 HTTP 守护只绑 `127.0.0.1`，不触发外部网络要求；但 loopback 依赖与 `nix develop` 的潜在联网都还没显式声明。

## waveform 现状差距

部署条目 `command = {repoRoot:buckyball}/thirdparty/waveform-mcp/target/release/waveform-mcp`，`cwd = {repoRoot:buckyball}`。占位符解析后是工作区内路径，路径面本身满足①；差距在产物供给与参数解析：

- **① 单命令启动**：`thirdparty/waveform-mcp` 是 submodule（`https://github.com/jiegec/waveform-mcp.git`），`target/release/waveform-mcp` 是 cargo 构建产物、被 `.gitignore` 排除、不在提交内。每轮全新工作区不会有这个二进制，spawn 会失败。要么随工作区提供固定 digest 的预编译二进制（并显式声明为只读挂载需求），要么在气泡内构建（需要 rust 工具链、可写 `target/`、可能联网）。
- **④ 路径参数**：工具 `open_waveform(file_path)` 等直接接收路径。必须支持以气泡工作区为根的相对路径，并在大波形下遵守 `toolCallTimeoutMs`。
- 默认 stdio 满足③（README 另述可选的 streamable HTTP，正式挂载不启用）。

## 声明面

buckyball 上游的 MCP 声明约定是 `.agents/mcps/<name>/cmd`：文件只放一行相对检出根的启动命令，由 `.agents/mcps/scripts/install.sh` 用 `npx add-mcp` 注册到 cursor / codex / claude-code。现有两条分别是 `./scripts/claude/run_mcp_server.sh`（bbdev）与 `./thirdparty/waveform-mcp/target/release/waveform-mcp`（waveform）——用相对路径这一点与要求①一致，是气泡适配的现成挂点：外部路径声明、状态目录、网络需要可随这条命令一起写进 Harness 的 `mcpServers` 条目。

## 迁移建议

- 在部署 `mcpServers` 条目补齐声明：外部只读挂载需求（如 `/nix`）、可写状态目录、网络需要（none / loopback / outbound）、启动前置（预置二进制或 venv 是否随工作区提供）。bubble profile 据此加入只读 bind；未声明者不进气泡，按⑤禁用。
- **bbdev**：把 `nix develop` 从气泡内启动路径移出。要么把 flake 环境物化为随工作区提供的只读前缀（含 `python3` 与所需 store 闭包），把 `run_mcp_server.sh` 改成直接 exec 该前缀的 python；要么在气泡外提供长驻 bbdev HTTP 守护，气泡内 MCP 只做 loopback 客户端（需声明 loopback 与显式状态/日志目录）。最小改动是先在条目声明 `/nix` 只读、nix 可写缓存目录与（如需）网络，接受气泡内 `nix develop` 的开销；不满足则由⑤禁用。
- **waveform**：改为随工作区提供 `target/release/waveform-mcp`（固定 digest 的只读挂载，或在 env setup 阶段于宿主预构建后复制进工作区）；不要让工具调用依赖 submodule 构建产物在当轮恰好存在。
- 通用：MCP 启动脚本不要 `cd` 到宿主绝对路径，从进程 cwd 解析 repo root；任何参数缓存都不得跨轮持久。

## 验证与范围

本轮只交付本文，未改任何代码，因此无类型检查或测试可跑。气泡 profile（`workspace-isolated` 模式、`isolationHiddenRoots`）与 MCP 挂载准入由对应的 singularity/sandbox 改动票实现并验证；本文是外部维护者的契约输入。
