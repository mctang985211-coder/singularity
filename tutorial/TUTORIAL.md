# singularity 多智能体教程：在 React 小项目上验证分解能力

## 1. 目的

用几分钟部署一个自包含环境，在**纯软件小项目**上验证 singularity 的多层任务分解：环境里放一个故意留空的 Vite + React 看板应用 `tutorial-kanban`，它的测试即规格；给根节点一句目标后，观察它是否自然拆出多层子任务、各自独立验收、并对最终结果给出可核查的证据。

本教程不需要 nix、不需要 EDA 工具链、不依赖 Buckyball 检出：全部验证都是 Node 侧秒级的测试与构建。

## 2. 部署

```sh
cd /home/ROXY/code/bb_work/harness
node packages/singularity/tutorial/seed-env.mjs
```

本机实际输出（已部署完成）：

```
seed-env: created project1
seed-env: env path    = /home/ROXY/code/bb_work/harness/environment/project1
seed-env: component   = /home/ROXY/code/bb_work/harness/environment/project1/tutorial/kanban
seed-env: skills      = /home/ROXY/code/bb_work/harness/environment/project1/.agents/skills
seed-env: label       = tutorial-kanban
seed-env: root prompt = /home/ROXY/code/bb_work/harness/packages/singularity/tutorial/root-prompt.md
seed-env: next step   = build a graph on this env, then paste that root prompt
```

再次执行 `--id project1` 会得到 `seed-env: project1 already seeded (idempotent re-run)`，条目不变。

脚本行为：

- 在 `environment/` 里取**下一个空闲的 projectN**（与 env-builder 的 `nextProjectId` 一致：最小未占用编号；本机已有 project46，所以是 `project1`），复制 `app/` 到 `environment/projectN/tutorial/kanban`，并做一次 `git init` + 初始提交（组件里是一个普通仓库）。
- 把教程技能写到 `environment/projectN/.agents/skills/`（技能必须在 env 根，检出内部署看不到）。
- 追加 manifest 条目（components 里 `owner=tutorial, repo=kanban, dir=tutorial/kanban, status=ready`，`url` 为空串——本地组件没有远端，但 schema 要求该字段为字符串），保持 2 空格缩进和结尾换行。
- 在组件里跑 `pnpm install`（热仓库不到 1 秒）。

常用参数：`--id projectN` 指定编号；`--label name` 换 label；`--no-install` 跳过安装。**幂等**：对同一个 `--id` 重跑只会补齐缺失部分（不会重复创建、不会二次提交）；默认重跑会创建下一个空闲编号；指定的 id 已存在且不是本教程环境时干净拒绝。

部署后项目位于 `environment/project1/tutorial/kanban`，当前是**红灯基线**：3 个测试文件、17 个用例中 16 个失败（`initialBoard` 一行已给），`pnpm build` 仍可过。

## 3. 建图

方式 A（UI）：打开部署日志里的地址（形如 `http://127.0.0.1:3080/?token=…`，token 以日志为准），进入 singularity 页面，在图谱切换器上点 **New** → Name 填一个名字 → Environment 选 `tutorial-kanban (1 components)` → **Create**。

方式 B（API）：先带 token 访问一次换取 cookie，再创建图。

```sh
TOKEN=<部署日志里的 token>
curl -c /tmp/dsh.cookies "http://127.0.0.1:3080/?token=$TOKEN"
curl -b /tmp/dsh.cookies -H 'content-type: application/json' \
  -d '{"name":"tutorial","envId":"project1"}' \
  http://127.0.0.1:3080/singularity/graphs
```

创建后根智能体会先做环境 setup（组件已 present，直接 mark ready），随后等待你的目标；此时 Tasks 页显示"未激活"是正常的。

## 4. 粘贴 root prompt

把 `/home/ROXY/code/bb_work/harness/packages/singularity/tutorial/root-prompt.md` 的全文**以真人消息发送**。这不是形式要求：`task_intake` 只接受 `source.kind=user`，系统注入或任务文本不会被当作人的目标，根节点会一直停在 setup 完成、无任务的空转状态。

发送后根节点会 `task_intake` 收下根任务，再自行决定分解。

## 5. 观察指南（六个页签）

| 页签 | 看什么 |
| --- | --- |
| Canvas | 拓扑：根→子节点的连线、层级深度、节点状态（每个子节点应有自己的目标）。 |
| Tasks | 任务树与状态徽标：子任务的目标、依赖、运行状态；确认子任务是"可独立核查"的粒度。 |
| Proposals | 提案与 HITL：如有节点请求人工确认，会出现在这里。 |
| Evolution | 默认关闭，正常流程应为空，本教程不需要。 |
| Recovery | 失败重试/接管的记录；一切顺利时为空。 |
| Verifier | 验收判据与证据（EvidenceBundle）：每个验收点的命令、退出码、结论都在这里核对。 |

## 6. 预期形态

根任务目标明确后，自然分解大致是"一个汇总验证节点 + 三块互不阻塞的实现子任务"：

- reducer 状态机（`src/state/boardReducer.ts`，`boardReducer.test.ts` 验收）；
- 三个组件的渲染与交互（`src/components/*`，`Board.test.tsx` 验收）；
- localStorage 持久化 hook（`src/hooks/useLocalStorageBoard.ts`，`App.test.tsx` 端到端验收）；
- 根节点做组合验收：全量测试 + 构建。

具体形状由节点自己决定，上面只是合理的预期；不要因为它和预期不同就判定失败，看的是每层是否有独立可核查的交付。

## 7. 复核验收（自己动手）

不采信智能体转述，直接进环境跑原始命令：

```sh
cd /home/ROXY/code/bb_work/harness/environment/project1/tutorial/kanban
pnpm test     # 期望 Test Files 3 passed，Tests 17 passed
pnpm build    # 期望退出码 0
```

红灯基线时 `pnpm test` 的 16 个失败就是待实现清单；完成后应全绿。

## 8. 退役

本环境的组件是**副本**（`environment/project1/tutorial/kanban` 是一个普通 git 仓库），不是指向真实检出目录的符号链接。因此与 README 中 `bb-local`（project46 的 buckyball 是符号链接）的警告相反：**对这个图执行 UI Delete 是安全的**——env-clean 只会在副本里执行清理，不会碰到任何真实仓库。

删除图（UI 上 Delete → Confirm delete，或 `POST /singularity/graphs/<id>/delete`）会停止会话并清理绑定；此后该 env 会重新出现在可选环境列表里。想彻底清掉，可在图删除后删掉 `environment/project1` 目录与 manifest 条目（或保留它，下次教程直接 `--id project1` 复用）。

## 9. 常见问题

- **重复部署**：默认再跑会建 `project2`；想复用原有环境就带 `--id project1`（幂等补齐）。
- **端口**：本部署 web 在 `127.0.0.1:3080`，以启动日志为准；换端口时 API 示例同步改。
- **超时**：本教程的验证是秒级测试，默认 `verifyTimeoutMs: 600000`（10 分钟）远远够用，不需要为教程调大。
- **别改测试**：测试是规格；删测试、跳过或用 mock 绕过都会让验收失去意义。
- **独立的 pnpm 工程**：`tutorial/kanban` 带自己的 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`，不会并入 singularity 的 workspace。
