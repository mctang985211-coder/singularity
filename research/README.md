# 实验准备与证据合同

这些工具只准备、导出、分析和封存证据，不启动模型、EDA 或任务。当前结果是工程就绪；真实方法收益与迁移尚未验证。模板故意不能通过冻结校验：不能用编造的 family 或默认的三族样本量替代真实研究设计。领域材料放在外部环境包，不往内核增加特定任务。

## 冻结前

复制 `preregistration.template.json` 到外部持久研究目录。用已审核的真实任务填 `tasks`，每项包含 `id/familyId/sourceId/split/contract:{path,sha256}/inputs:[{path,sha256}]`。contract 是完整 TaskContract。所有引用均相对预注册文件，禁止绝对路径、路径穿越和符号链接。family 和 source 均不得跨 pilot/evolve/validation/heldout；一个来源切成几段不能冒充独立来源。

每个 Method 引用同时保存文件 `sha256` 和 `digest`；后者是产品 `digestOf(assets)` 的规范 JSON 身份，两者不同。provider、基础模型、revision 可见性、工具与执行底座固定；看不到 revision 时明确用 null，不能捏造固定 revision。

研究冻结需要独立 pilot 的 `variance.json`：`{kind:"independent-pilot",familyVariance:number,sampleSizeRationale:string,families:[{familyId,sourceId}],evidence:[{path,sha256}]}`。pilot 必须有至少三个不同的真实 family，且不能与确认性任务的 family/source 重叠。用其方差说明目标效应、功效或区间精度及所需 family 数量；最低三个 family、每题两个 trial 只保证工程接口可用。尚未实跑 pilot 时，保留草案，不能伪称已经完成正式预注册。

`environment` 引用审核后的环境清单，连同评分器、保护 verifier、任务输入、工具链版本/容器身份一同纳入外部证据。不要把私有 validation/heldout 文件交给 proposer；离线档案访问权限不等于模型读取权限。

## 对照与消融

| 比较臂 kind    | 固定和变化                                                     | 执行约束与允许的主张                                                                |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| frozen         | H0 初始 Method 固定，candidateBudget=0                         | 每个新任务、重复 trial 冷启动；学习关闭                                             |
| workflow       | 从同一 H0 演化 workflow/template/skill/tool                    | 演化只看 evolve；冻结 champion 后去 validation/heldout                              |
| best-of-n      | 固定方法，在相同候选机会和总步数内尝试，按冻结 validation 选择 | 不看 heldout 选最优；排除更多尝试机会的收益                                         |
| skill-tool     | 只允许改 Skill/Tool，workflowGuidance/templates 保持 H0        | 机会与总步数匹配 workflow；隔离资产组织贡献                                         |
| raw-trajectory | 与结构化臂相同证据内容、预算、模型，只去掉 Task 证据结构       | `informationEquivalence:{path,sha256}` 冻结逐项信息映射；不能减少反馈或多给解题答案 |
| single-agent   | 一个执行 agent，同模型与总预算，独立保护检查不变               | 仅在主张多 agent 价值时增加                                                         |

默认先做 H0 对 workflow 的窄领域未见族比较。`claim=task-evidence` 必须额外带 best-of-n 和 raw-trajectory；`asset-organization` 必须带 best-of-n 和 skill-tool；`multi-agent` 必须带 single-agent。所有基线使用相同输入、hard guards、验收和计分器；不能让 H0 禁用候选可用的工具。臂的目录、DSH home、controlId、native sessions 和输出彼此隔离。

按 schedule 的顺序执行，在每个 task×trial 内交错各臂，下一 trial 反转，H0/workflow 即 AB/BA。重复 trial 不增加独立 family。该离线工具不会替代原生调度或增设执行器。操作员按 schedule 为各臂配置独立固定 Method 的宿主；业务任务使用现有 CLI `task run ... --learning off --wait`，搜索阶段按原生 suite 路径执行。现有 `experiment run` 只启动首个 evolve root，不能当作完成 schedule 的全部 trial。best-of-N 的 N 个独立机会逐一记录，不能用一次 root 的子节点冒充 N 个 trial。

## 准备与核查

```sh
node scripts/experiment.mjs prepare /persistent/study/registration.json /persistent/study/frozen
```

输出登记文件、确定的 schedule、输入、commit、含 staged/unstaged 的 dirty patch、全部未忽略 tracked/untracked 源码（含删除清单）、锁文件、DSH baseline/补丁、源码逐文件摘要和冻结时间。输出必须在源码 checkout 之外且目录不存在。把返回的 `freezeSha256` 在运行前登记到独立研究记录；哈希和时间戳本身不证明公开预注册。源码冻结后改代码应新建实验，不能覆盖旧目录。

在开始 heldout 前，将分析方法及每个臂的最终 Method 固定为 `inventory.analysisFreeze:{registration:<registration.json文件SHA256>,frozenAt:<ISO时间>,methods:{<armId>:{path,sha256,digest}}}`，引用实际 Method 文件，保留独立登记回执。heldout 记录的 Method 必须一致。任何被读过或用于反馈的 heldout 都重新分类，不能继续宣称未见。

## 原始记录与报告

`results.json` 是数组，每个 schedule slot 都有一行，包括失败、取消和缺测：

```json
{
  "slot": 0,
  "armId": "h0",
  "taskId": "actual-id",
  "trial": 0,
  "rootId": "actual-native-task-id",
  "methodDigest": "64-lowercase-hex-runtime-digest",
  "startedAt": "2026-10-24T00:00:00Z",
  "actualOrder": 0,
  "modelRevision": null,
  "outcome": "failed",
  "hardGuards": false,
  "reason": "actual frozen failure reason",
  "costUnit": "tokens",
  "costs": { "business": null, "search": null, "review": null, "publication": null },
  "evidence": [{ "path": "native/exported-record.json", "sha256": "actual-file-sha256" }]
}
```

outcome 为 accepted/failed/cancelled/review-inconclusive/infrastructure-failure。只有根完整交付且全部 guards=true 才能记 accepted。明确失败及取消保留在分母；不可判定和基础设施缺测不补零，抑制相应比较推断。未开始的取消写 `startedAt/actualOrder/rootId=null`；费用没有测到就明确 null，零费用需要原始计量证明。分别记录在线业务、离线搜索、独立审核和发布费用，避免同一账单在不同桶重复分配。tokens 与货币费用不能混用；没有供应商完整计量就不声称总金额。

```sh
node scripts/experiment.mjs analyze /persistent/study/registration.json /persistent/study/results.json > /persistent/study/report.preview.json
```

脚本从全部原始行生成各臂、split、独立 family 的根成功率，失败/缺测数量、已知费用和未知覆盖、逐 trial 质量—成本数据。主估计先算 family 内均值，再对独立 family 等权汇总；配对 family bootstrap 使用预注册种子、重复数和 95% 分位区间。缺测、不够 family 或执行顺序偏离会保留记录并停止对应推断；不自动宣布赢家或论文显著性。多个探索比较的区间属描述性分析，不能按最优 p 值选主张。

## 导出与不可变证据包

先停止写入并确认原生会话静默，显式指定原实验 persistence 编码。导出仅开 read handle，不 flush、不写回原图、不读取凭据文件；源在导出中变化会失败。

```sh
node scripts/evidence-export.mjs /persistent/private-home/sessions /persistent/private-home actual-control zstd /persistent/study/raw
```

导出完整控制链，按原版本做 frame/digest/chain/schema/fold 复验，递归收集原生 session 和不可变附件，保留全部方法 manifest、候选 diff 事实、资产消费、测量、findings、上下文事件及准确 cutoff。历史旧版本使用该实验冻结 checkout 的同版本 exporter/reader；不可用当前 reducer 改算旧结果。输出 inventory 可增补真实的外部 deterministic recheck、环境制品、完整请求捕获和计量/费用对账。复验控制链不等于重新运行保护 scorer，也不证明 LLM 判断正确。

`inventory.json` 格式为 `{schemaVersion:1,files:[{path,sha256,category}],analysisFreeze?:...}`，引用相对 inventory 文件的真实原始文件。research 包必须含 control/trajectory/artifact/findings/measurement/methods/diffs/consumption/deterministic-recheck/context/build 类。`build` 引用启动时的 `assembly/lib/build.json`，其 inputs 必须与冻结源码一致，outputs 对应的完整 bundle 逐文件入包。所有 trial evidence 必须在 inventory 中。空候选集合按原生事实保留，不编造候选；相应 negative result 不得删掉。

```sh
node scripts/experiment.mjs seal /persistent/study/frozen /persistent/study/results.json /persistent/study/raw/inventory.json /persistent/study/sealed PRE-RUN-FREEZE-SHA256
node scripts/experiment.mjs verify /persistent/study/sealed EXTERNALLY-RECORDED-MANIFEST-SHA256
node scripts/experiment.mjs replay /persistent/study/sealed EXTERNALLY-RECORDED-MANIFEST-SHA256
```

seal 核对运行前独立登记的 freeze 摘要，拒绝覆盖，拷贝材料、从记录重算 report、生成全包 SHA256 manifest，将文件和目录设为只读。verify/replay 要求外部保留的 manifest 身份，拒绝文件被改、被加或被删，重算报告并逐位比较。只读权限和哈希可发现篡改，不是防恶意管理员的硬件 WORM。敏感原始档案留在访问受限的持久目录；共享副本单独导出、注明全部脱敏/删减与前后摘要，不能修改原生 envelope 后保留旧 digest。去敏不是自动保证，seal 不会自动公开材料。

跨机器：传输整个 sealed 目录及独立 manifest 身份，先执行 verify/replay；这一步不需要 DSH 或模型。重建软件时从 `source/tree` 安装锁定依赖，按 dsh-baseline/补丁重建授权宿主，执行 setup:host、doctor 和 verify。新机器本地路径不入协议；对原实验的独立外部评分器复验保留新日志和工具身份，不改旧 trial。跨机器真实重跑和真实模型比较仍待实跑。
