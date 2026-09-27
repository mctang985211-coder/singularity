# K3 返工记录：审查两项可达缺陷（2026-09-27，待验收）

- 合同：[execution-prompts/12c-k3-skill-unit.md](../execution-prompts/12c-k3-skill-unit.md)；公共合同：execution-prompts/README.md。
- 返工基线：Singularity `4030076`（K3 首轮交付：代码 `9998026` + 文档）、外层 `1b930f2f81`；开工前两仓工作树干净（外层 thirdparty/deepseek-harness 未跟踪，保留未动）；子模块全量备份 bundle `/tmp/k3-round2-baseline-9998026.bundle`。
- 触发：GPT-6 Sol 独立审查给出的**两项可达合同缺陷**——固定 1/2（生产未声明资源与完整对象）与固定 4/K3-2/K3-4（写前拒绝角色漂移、第三方变化不被覆盖）已承诺而未落地。本记录只写返工部分；首轮交付证据见[交付记录](2026-09-27-k3-delivery-record.md)。
- 无真实模型费用、无推送、无部署；不改任何持久化格式（ledger 仍 v4、实验报告仍 v3），K3 持久化记录不变。

## 缺陷 1：prepare 漏掉生产目录里未声明的文件

- 症状：`prepare` 只拒绝 sidecar 声明的 `content.resources`（`evolution.ts` 约 1358）。无 sidecar 的指导型生产目录带 `references/notes.md` 或词表外条目时，`loadSkillSidecar` 无声明可比对、不报 defect，prepare 只把 SKILL.md 复制进沙箱并记录其身份——漏文件后仍宣称完整对象。
- 修复（最小复用既有扫描，无新框架）：`evolution/src/evolution.ts` 的 prepare 在既有"声明资源"拒绝之后，用 loader 已扫描结果 `[...loaded.content.resources, ...loaded.uncovered]` 具名拒绝，消息点名文件并含 `nothing was written`。
- 红：新集成例（`tests/integration/k3-skill-unit.spec.ts` K3-2 段，`-t "leaves a file undeclared"`，形状 `references/notes.md` 与 `helper.sh`）在未修复树上 **2 failed**——工具入口返回 `[prepared]`、只 `wrote skills/…/SKILL.md`，sandbox 已建。
- 绿：同批 **2 passed**；K3-2 段 12 passed；unit 新例（guidance 版，`evolution/tests/unit/evolution.spec.ts` K3 prepare 段）与 `-t "K3: prepare"` 5 passed；全量 unit 1916 passed（首轮基线 1915）。

## 缺陷 2：rollback/恢复入口"先写后验"

- 症状：`rollback` 写前只逐个比对 intent 所列文件摘要（`evolution.ts` 约 2077）。指导型 apply 后外部新增 `SKILL.contract.json`（角色漂移）→ 正文摘要检查通过 → `commitIntent` 先替换正文 → `verifyCommitted`（约 2380）才报角色不符，留下**开放意图与已修改生产**。新增未声明资源时更糟：写后复检对 guidance 的 resources 不报 defect，rollback 直接"成功"并把未声明资源留在原地。恢复入口（`settleOpenIntent` → `commit.ts` 的 `reconcileIntent`）同样不查目录新增条目。
- 修复：`CommitHost.objectWriteRefusal(intent)`（`commit.ts` 声明；`evolution.ts` 服务侧实现，`commit.ts` 保持不 import task-runtime）——**写前整对象核对**：
  - 1 文件 intent（指导型）：用 `loadSkillSidecar` 读目录，拒 sidecar（角色漂移）、受支持资源位置上的文件（未声明资源）、任何 loader defect；词表外条目（`uncovered`）按 K2 钉定的容忍语义放行（提交只替换对象自身文件、绝不覆盖或删除其它条目）。
  - 2 文件 intent（执行型）：目录条目必须恰为两个 target basename 与各自 `.${basename}.tmp-` 非目录 staging 残留；一 old 一 new 的混合态放行（恢复要收尾的在途状态）；陌生残留同样拒（执行型声明的身份必须点名目录里每个文件，写后复检也会拒它）。
  - 调用点：`commitIntent` 在 `host.append` 与任何写之前（抛错零行零写）；`reconcileIntent` 在逐文件分类之后、任何写分支之前（blocked 零写、意图保持开放）。目录不可列返回具名原因：新鲜路径抛错、恢复路径 blocked（批次不被中断，与同目录 readProduction 失败形状一致）。
  - 工具返回说明同步：`evolution_rollback`、`evolution_apply` 描述各加一个最小子句。
- 红：未修树上新例（`-t "before anything is written"`）**3 failed**——角色漂移例失败原文来自写后的 `verifyCommitted`（"loads as execution-provider after the rollback …, not as the guidance…"），账本尾 `["applied","commit_intent"]`、生产已被替换；资源例 `refused === ''`（rollback 竟成功），账本尾 `["commit_intent","rolledback"]`、未声明资源原样留下；恢复重试例同样写后失败。
- 绿：同批 3 passed；k3 整文件 **41 passed | 1 skipped**（nested child 按设计跳过）；`-t "K3-4"` 22 passed | 20 skipped；k2 集成 19 passed | 1 skipped；unit `evolution.spec.ts` 203 passed、`commit-durability.spec.ts` 32 passed（该文件**未改一字节**）。

## 独立复核（子代理 C，两轮，均实跑）

- 第一轮：全 diff 审查 + 点名重跑 + 4 项变异 + 6 组独立探针。发现 **F1**（2 文件分支零测试：把 foreign filter 改成恒假后 289 例全绿）与 **F2**（目录不可列时 readdir 抛错中断整个 reconcile 批次，与 `commit.ts` 文档"目录类问题=blocked"不符；安全性未破）。
- 第二轮（对 F1/F2 修复后）：F1 变异（filter→`() => false`）→ **4 failed | 1 passed**（apply 三形状 + rollback 全红，自己的 staging 残留放行例仍绿），按原字节复原（sha256 `351fecaa…`）；附加变异 M3b（把"本对象前缀"放宽为任意 `*.tmp-`）→ 恰 1 例红，钉住前缀规则；F2 探针：留开放意图 + `chmod 0300` → `reconcile()` **不抛**、返回 blocked 并点出目录与 EACCES、零写、意图仍开放；同场景新鲜 apply/rollback 仍具名拒绝且含 `nothing was written`；k3 41 passed、k2 19、unit 202/32，全量 unit 2044、integration 536 passed | 2 skipped、工作树按字节复原。
- 复核确认修复真实、无死代码、`commit.ts` 未 import task-runtime、新闸在两处写前位置被调用；独立探针另证明：apply 方向未声明资源由新闸（而非 P3）拒绝、词表外条目容忍与 K2 一致、混合两文件窗口恢复正例不受影响。
- F2 的**常驻**单元例（`reports the blocked intent, instead of throwing, when the production directory cannot be listed`）在第二轮后补入，由实现方以"catch→throw"变异证明会红（`reconcile() threw instead of reporting a blocked intent: …EACCES…`）、按 sha256 复原后转绿；主代理复跑全部公共检查。

## 删除 / 收窄（无新增服务、无新框架）

- 未新建扫描框架、第二提交器、兼容分支或通用闸；缺陷 1 复用 loader 扫描结果，缺陷 2 复用 `loadSkillSidecar` 与 commit 路径既有的 staging 前缀规则。
- 收窄一处首轮测试：`evolution/tests/unit/evolution.spec.ts`（约 2155，K2/S4-E 遗留例）删掉 `reference.md` 夹具与两处"aux 文件原地不动"断言——该场景在新 prepare 规则下不可构造；用例保留本来的主题（apply 只替换 SKILL.md、rollback 复原 champion 字节）。容忍语义仍由未改动的 `commit-durability.spec.ts:1164`（K2）与复核探针 P2 覆盖。
- 未删除任何有效验收或检查；未改 `commit-durability.spec.ts`（`git diff --exit-code` 通过）。

## 公共检查（主代理实跑，最终字节）

- `pnpm build`（packages/singularity）：exit 0；跟踪 lib 仅 `evolution/lib/*` 与 `agent-singularity/lib/index.js` 随 src 更新，无其它包 lib 变动。
- `pnpm vitest run --project unit packages/singularity`：**60 文件 / 1917 passed**。
- `pnpm vitest run --project integration packages/singularity`：**58 文件 / 494 passed | 2 skipped**（首轮 484+2；+10 为本票新例）。
- `pnpm run verify-persistence`：OK（4 event roots 匹配）。
- `git diff --check`（两仓）：干净；`pnpm exec tsc --noEmit`（agent-singularity、evolution）：exit 0。

## 未覆盖 / 对应排除

- 合同明确排除：其他资源、knowledge sidecar、角色转换、新增 provider、改 verifier/capabilities/requiredTools；真实模型效果实验（本票不授权，机制修复不声称效果）。
- 单进程写者前提不变（无跨进程锁）。写前闸与写入之间不是原子的：第三方若恰在该窗口内加条目，写后 `verifyCommitted` 仍具名拒绝并留下开放意图（由 K2 意图/恢复协议兜住），本票把"已知状态"的拒绝前移到写前。
- 恢复批次"其余意图继续结算"只有复核的临时探针证据（两个开放意图下另一条 completed-redone），无常驻用例（构造成本高）；单条恢复 blocked 已由 F2 单元例钉住。
- 2 文件 intent 不放过陌生 staging 文件（`.other.md.tmp-*`）：有意收窄，已由新用例固化（执行型声明的身份必须点名每个文件）。
- prepare 拒收词表外条目与提交路径容忍词表外条目并存：分别对应"冻结完整对象"与"只替换对象自身文件"（后者为 K2 钉定语义）；代价是词表外杂散文件（如编辑器备份）会让该 Skill 的改进路径在 prepare 处具名停住。
- `packages/singularity/tests/` 无 tsconfig 覆盖为既有状况。

## 子代理分工

- A：缺陷 1（prepare 未声明文件拒绝 + 集成/单元红绿）。
- B：缺陷 2（`objectWriteRefusal` 写前闸、两处接线、工具文案 + 集成用例）；第二轮补 2 文件分支用例与目录不可列 → blocked；第三轮补 F2 常驻单元例。
- C（独立复核，两轮）：全 diff 审查、点名重跑、变异 M1–M4/M3b、独立探针（apply 方向、容忍面、混合正例、EACCES、符号链接/嵌套/删目录等反例搜索）；发现并推动 F1/F2 闭合。
- 主代理：合同拆分与派发、核心 diff 亲审、返工记录/guide §5.20/计划 12c 同步、公共检查全跑、提交子模块与外层指针。
