# G1 记录：一条真实 Web 会话走完「提出 → 执行 → 独立判决 → 凭证」

> 固定基线实测记录；本轮 G1/G2 阻塞项见 [context](context.md)，本文不能作为新合同已通过的证据。 历史正文按基线保留。

日期：2026-10-11。基线：本树 `11aed98`（本轮开工时的 HEAD，当时 `assembly/` 还是未提交的初稿）；
宿主：私有 DSH `0.2.0-rc.2`（[standalone-dsh.md](standalone-dsh.md)）。

**结论：G1 的退出条件逐条有证据，其中会话、工具调用、判决与恢复都来自真实进程与真实模型，不是探针自述。**
初稿的装配层一个工具调用都跑不通（`assign` 需要一条没人发射的 `agent/opened`；verifier 适配器被 spawn
的位置从来没被写入；`run/verified` 无条件发射，于是 fail 路径抛 `unadjudicated-criterion`），本轮把它按规格重写，
并把领域材料整体移出代码。

## 1. 建立的东西

### 1.1 核心：需要的事实所有者补齐，且只有一份

- `ControlSessionStore.declareSubject(key, identity)`：Web 的 agent 是运行时才铸造的，名册不可能在 `open` 时齐全；
  声明仍只落在 store 自己那一张角色表上（同键同身份是空操作，同键异身份具名拒绝）。
- `src/agent/commands.ts`、`src/environment/commands.ts`：`agent/opened` 与 `revision/created` 从此有命令所有者，
  装配层不再手写信封（`grep -rn "store.emit" assembly/src` 为空）。
- `TaskCommands.settle(input, as?)`：读本次 run 的证据决定收尾——全绿发 `run/verified`（装置行为，scheduler 身份），
  否则发 `run/failed`（**必须**带 responsible agent 的绑定：reducer 的责任检查就是这条规则的唯一所有者）。
  决策生产者是同步的、在 store 的串行区内解析，且**只看证据不看 run 状态**，所以重投的命令重算出同一份请求、
  由 store 既有的命令识别返回已提交事实。
- `src/verifier/command.ts`：通用 verifier 运行器，进程执行是**端口**（`src/` 不许点名 `node:child_process`），
  判据（退出码即判决、产物摘要取自运行之后的字节、缺字节具名拒绝）留在核心里；`scripts/verifier-command.mjs`
  退化成薄 CLI，stdout 契约不变，八个探针照旧。
- `declare module '@deepseek-ai/dsh-session/types'`：控制事件类型的增强此前挂在错的模块上，在任何同时加载
  `dsh-agent`/`dsh-tools` 类型的程序里被静默丢弃；`tsconfig.json` 的对应 path 一并修正。

### 1.2 装配包：一个宿主插件 + 一张 agent 面孔

`assembly/src` 重写为八个文件，职责分别是：宿主插件（开 store、开驱动器、跑恢复、提供 `singularity` 服务）、
agent 面孔（三个工具 + 一段 prompt，按 preset 子行挂进调用者的作用域）、绑定、驱动器、一次提交、崩溃恢复、
领域装载、稳定 id。行数上限从 750 抬到 800 并写明理由：把恢复从 `submission.ts` 拆出来正是这条规则要的形状，
而拆分本身要花掉模块头与进出口；两条硬规则（在飞 run 的重投拒绝、revision 只绑请求不绑工作区字节）一条没丢。

- **调用者只从 `exec.agent` 来**：`agent:<agentId>` 的键与 `<control>:agent:<agentId>` 的身份由 agent id 派生，
  工具 schema 里没有任何身份字段；匿名调用具名拒绝；读也只给任务的持有者。
- **稳定 id**：`taskId` 由 control+agent+goal 派生，`runId` 由 control+session+`exec.callId` 派生，每条命令的
  `commandId` 由它们派生；已收尾的 run 被重投时直接返回记录里的结果，不重跑副作用。
- **零领域字面量**：判据、输入、程序名、产物名、verifier 程序与自检样本全部来自
  `deployment/domain/letters/`，实现摘要按 `verifier.mjs` 的真实字节算；门禁 `assembly-domain-free` 每次检查。
- **崩溃窗口**：挂载时先显式重开控制 store（它自己 adopt 已提交事实），再把在飞的 run 收掉——有裁决的按裁决收尾，
  产物与输入仍在的重新判决，冻结字节不在的、输入改名或改内容的，全部以**具名失败**收尾；一条 run 的问题
  再也不会让整个宿主起不来。

### 1.3 部署层：profile、preset、领域、模型路由

`scripts/deploy.mjs` 把 `deployment/profile/` 落成 `$DSH_HOME/profiles/singularity-next-web/`：manifest、
部署补丁（controlId/domainDir/workspaceRoot，以及 yingjun 的模型路由）、指向本 checkout `assembly/` 的
linked root。离线、不经 pnpm、不碰全局 home。preset `singularity-next` 由 bundle 自带补丁声明。

### 1.4 门禁

新增三条：`assembly-budget`（每文件 ≤200、整包 ≤800，与仓库既有 `source-size` 同一行的口径）、
`assembly-domain-free`（domain 的名字只许写在 `deployment/domain/`，且扫 `.ts/.mts/.tsx`，与 `sourceFiles()` 同一扩展集）、
`assembly-built`（profile 挂的 bundle 是不是当前构建——stale bundle 此前没有任何门禁能看见）。三条各有合成失败腿；`evidence-budget`
的分母从此包含插件自身的源码、分子包含插件自己的 spec。

### 1.5 DSH 依赖只剩一个来源

`tsconfig.json`、`vitest.config.ts`、`scripts/dsh-control-runtime.mjs`、`dsh-baseline.json` 与
`dsh-alignment` 门禁的路径正则一起改到私有环境 `/home/ROXY/singularity-next`，全局安装与 harness checkout
不再被任何配置点名。

## 2. G1 证据

| 退出条件 | 命令 | 观察 |
|---|---|---|
| 可构建、可装载的包 | `node assembly/build.mjs`；`tsc -p assembly/tsconfig.json --noEmit` | 产出 `lib/index.js` + `lib/agent.js`；类型检查干净 |
| 真实 profile 组成 | `node scripts/deploy.mjs`；`dsh --profile singularity-next-web --dump-config` | 退出 0；装配行与 preset 行就位；stderr 无 `skipping profile bundle` |
| 旧域形状的在飞 run 不再拖垮宿主 | 把保留的旧 control 会话与旧工作区放回后 `dsh --profile singularity-next-web --help` | 退出 0、`did not activate` 0 行；三条旧 run 全部以「frozen against the input "source"，本部署不再声明该输入」具名 failed |
| 独立 pass/fail | 同上两条 + `assembly/tests` | 判决只来自 domain 的 verifier 进程；崩溃、空产物、改内容都记成 fail |
| 全树 | `pnpm verify` | 构建、测试、门禁与门禁自检全绿 |

## 3. 变异证明（本轮新增的 45 条规则）

每一条都按 `docs/debugging.md` §4 的四步跑过：找到承重行、最小改动让它失效、跑最相关的一个 spec、恢复。
下面的表格由 `mutation-baseline.json` 生成（`doc` 指向本文件的那些行），每条都可以用 `node scripts/mutate.mjs <id>` 重跑：
整本账（含 `doc` 不在本文件的行）逐条跑过，逐条结论以该命令的输出为准，不写在这段散文里。一条曾经是死的——
`mutate:assembly-m5-per-agent-key` 没有用例让第二个 agent 干自己的任务，补上那条用例后它才重新承重；
「没失败过的断言不算断言」在这个仓库是机械检查的。

### Core command owners and the verifier runner

| claim | rule it attacks | verdict | witness (the failing test) |
|---|---|---|---|
| `mutate:core-declare-empty-accepted` | a declaration must name a non-empty role and identity | caught | refuses an empty key or an empty identity |
| `mutate:core-declare-conflict-overwrites` | a key resolves to one identity, ever | caught | refuses the same key with a different identity |
| `mutate:core-declare-same-identity-refused` | declaring the same key with the identity it already has changes nothing | caught | is a no-op when the same key is declared again |
| `mutate:core-declare-not-shared-with-log` | a declared role lands in the very table the log stamps from | caught | resolves an identity declared after open |
| `mutate:core-settle-reads-status` | settle derives the fact from the evidence, never from the run status, so a redelivery recomputes it | caught | answers a redelivered settle with the fact it already committed |
| `mutate:core-settle-missing-verdict-accepted` | a criterion with no verdict from its own verifier refuses the settlement | caught | refuses while a criterion has no verdict from its own verifier |
| `mutate:core-settle-verify-takes-caller-binding` | the verified branch is emitted under the scheduler role, whatever binding the caller passes | caught | settles the run verified under the scheduler, whatever binding |
| `mutate:core-settle-fail-drops-binding` | the failed branch is emitted under the caller-supplied responsible binding | caught | refuses a failed settle emitted under a binding that is not the responsible agent |
| `mutate:core-settle-fail-drops-detail` | a failed settlement carries the failing verdict's detail | caught | settles the run failed under the responsible binding |
| `mutate:core-settle-unknown-run-accepted` | a run the task never started refuses the settlement | caught | refuses a run the task never started |
| `mutate:core-settle-verified-branch-is-failed` | all criteria passing settles verified, not failed | caught | settles the run verified under the scheduler |
| `mutate:core-verdict-lookup-broken` | a settlement asks the run evidence which criterion is answered | caught | settles the run verified under the scheduler |
| `mutate:core-agent-open-subject-not-agent` | one node is keyed by the agent id | caught | opens one node keyed by the agent id |
| `mutate:core-environment-subject-not-environment` | a revision is keyed by the environment id | caught | creates one revision whose content identity the reducer computes |
| `mutate:core-runner-verdict-always-pass` | the verdict is the exit code | caught | judges a non-zero exit as fail |
| `mutate:core-runner-no-exit-is-pass` | a process that never started fails closed | caught | reads a process that never started as a failure |
| `mutate:core-runner-artifact-before-run` | the artifact digest is read after the run | caught | judges an exit code of 0 as pass |
| `mutate:core-runner-inputs-before-run` | the input digests are read after the run | caught | judges a non-zero exit as fail |
| `mutate:core-runner-shells-an-argv` | a string runs through a shell, an argv is spawned without one | caught | decides the invocation from the command |
| `mutate:core-runner-missing-artifact-empty-success` | a missing artifact is a named refusal, never an empty success | caught | refuses an artifact that is not there |
| `mutate:core-settle-unreachable-from-foragent` | settle is trusted-surface only, not reachable from forAgent | caught | offers an agent no way to produce one |
| `mutate:core-settle-producer-outside-region` | the fact a command is is produced inside the serial region, against the state the commit left | caught | is decided inside the commit region |

### The assembly package

编辑、运行命令与目标见证见 [mutation-baseline.json](../mutation-baseline.json)。

`mutate:assembly-m1-replay-guard`、`mutate:assembly-m2-verifier-digest-bytes`、`mutate:assembly-m3-program-argv-input`
`mutate:assembly-m4-anonymous-caller`、`mutate:assembly-m5-per-agent-key`、`mutate:assembly-m6-repair-settles-recorded`
`mutate:assembly-m7-repair-artifact-gone`、`mutate:assembly-m8-closed-config`、`mutate:assembly-m9-effect-owns-tools`
`mutate:assembly-m10-fail-uses-responsible-binding`、`mutate:assembly-m11-revision-digest-read-back`、`mutate:assembly-m13-effect-owns-section`
`mutate:assembly-m14-read-holder-only`、`mutate:assembly-m15-frozen-input-drift`、`mutate:assembly-m16-placeholders-closed`
`mutate:assembly-m17-bubble-names-what-ran`、`mutate:assembly-m18-frozen-name-not-declared`
`mutate:assembly-m21-inflight-redelivery-refused`、`mutate:assembly-m22-revision-names-the-request`、`mutate:assembly-m23-holder-checked-before-writing`

## 4. 写下来的边界

- **一个 domain 一条判据、一个输入**：本版每条 run 写一份裁决、每份契约一个输入，声明别的数量在装载时**具名拒绝**，
  不静默截断；G3 要的多样本、多判据届时先改协议再改装载器。
- **读只给持有者**：`singularity_task_status` 拒绝非持有者的读（具名 `not-responsible`），父子读规则是 G2 的读面板
  的第一个消费者，届时一并定。
- **恢复探针构造的是状态，不是时序**：它用核心自己的命令把 run 停在「已 startRun + 已 openBubble、无裁决」，
  再由真实 profile 启动去收尾；「SIGKILL 恰好停在这个窗口」由浏览器探针的 `--recovery` 腿覆盖。
- **模型会写错程序，这不是缺陷**：契约只承诺「写进工作区、作为 node 的 ES module 运行、只判 stdout」，
  崩溃或空产物是记录下来的 fail；记录里的 `detail` 始终是判据 verifier 的原话，不掺程序自己的 stderr。
- **一个 control 一个 Environment**：仓库里的部署只有一个 control；多会话共享同一份事实与同一份指针。
- **`reassign` 的权威仍是调用者自己的绑定（实测，G2 的活）**：非持有者可以把别人的任务转给自己，转手之后连
  `failRun` 也通过了——reducer 只要求 `from` 是当前持有者，没有「谁有权转移」这一条。工具面里没有 `reassign`，
  所以 G1 的产品路径不可达；这正是 [assembly-review.md](assembly-review.md) 的 A01 明确留给 G2 的「计划权限」问题
  （当时针对 `decompose`），G2 定义计划权限时一并收口，而不是在这里猜一条规则。
- **对抗审查改掉的两条（本轮的第三次实质修正）**：一次对抗审查实测出「在飞 run 被同 callId 重投会再跑一遍程序」与
  「revision id 取自工作区字节，程序改掉自己的输入后重投会追加第二条 revision 并把同一调用的兄弟命令永久锁死」，两条都已修并各自有变异证明
  （`mutate:assembly-m21-inflight-redelivery-refused`、`mutate:assembly-m22-revision-names-the-request`）；顺带把「非持有者的拒绝
  必须在任何写入之前」也钉成规则（`mutate:assembly-m23-holder-checked-before-writing`）。
- **构造期的「一键一执行者」检查不覆盖后加入的 agent**：装配层给每个 agent 派生的键与身份都是 agent id 的
  单射函数，所以两个 agent 不可能共享一键；这条检查在名册动态增长时不会被触发，是限制而不是漏洞。
- **未做**：G2 的任务树/读面板与父子调度；G3 的方法闭环（A03 的 `draftFromDecision`/`requestPublish`、
  A05 的累计采用历史入 proposer）；真实领域任务（`f-domain` 三任务）留给 G3，G1 的验收变量只用 letters。

## 5. 账本

规模数字（源文件、spec 文件、测试、门禁）在 [tree-baseline.json](../tree-baseline.json)，由 `tree-inventory` 门禁逐次比对；
变异声明在 [mutation-baseline.json](../mutation-baseline.json)，由 `mutation-claims` 门禁检查每条锚点是否仍然唯一可应用、
以及本文是否点名了每一条新的 claim。
