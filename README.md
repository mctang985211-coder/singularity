# dev-records/2026-09-24 — Singularity 本地开发记录归档

本分支是 `mctang985211-coder/singularity`（`DangoSys/singularity` 的 fork）上的归档分支，
用于把本机仓库外的开发过程记录、验证证据与文档一并带入 fork。

- 归档时刻：2026-09-24T16:25+08:00（本机 `amax`）
- 开发分支：`wip/task-runtime-20260917` @ `99e1311`（upstream `main` `c94024b` 之上 75 个提交）
- 本地 tag：`baseline-p4-20260921` @ `05cb27c`
- 本分支是 orphan：与开发分支没有共同历史，只承载归档内容，可随时删除而不影响开发线。

## 布局

| 路径 | 内容 |
|---|---|
| `records/` | 仓库外过程树的**可浏览副本**（240 个文件；去掉树内嵌套的 `.git` 目录） |
| `archives/` | 同一批内容树的**逐字节 tarball**（383 个文件，含嵌套 `.git`）+ `SHA256SUMS` |
| `snapshots/harness-docs/` | 外层 `harness` 仓库中关于 Singularity 的文档快照 |
| `provenance/` | 归档时刻的本地状态、内外层提交清单 |

### 过程树一览

| 树 | 内容 |
|---|---|
| `r1-evidence-2026-09-23` | R1 首次真实模型执行证据：S1/S2/S3 的 `driver.json`、`dsh-home/`、`repo/`，`budget.json`、`smoke.json`、driver 归档 tgz |
| `r1-supplemental-2026-09-24` | R1 补验证轮：`driver/`、`fixtures/`（冻结合同）、`evidence/`、`run/` |
| `r1-rework-2026-09-24` | R1 返工与独立复核：`criteria/`、`accounting/`、`adjudication/`、`GAP-TABLE.md`、`REVIEW-independent.md` |
| `r1-final-2026-09-24` | R1 最新一轮：`driver/`、`judge/`、`fixtures/`、`evidence/`、`run/` |
| `r1-scratch`、`r1-run-scratch` | R1 运行期临时工作区（`dsh-home/`、`repo/` 副本） |
| `r1-probe-run`、`r1-probe-run2` | HITL 探针运行工作区 |
| `r1-run-scratch-s2s3.log` | S2/S3 运行日志 |

这些树原本位于 `/home/ROXY/code/bb_work/`，被 `packages/singularity/docs/` 下的记录以绝对路径引用
（例如 `docs/2026-09-20-vrtc-code-change-plan.md`、`docs/execution-prompts/README.md`）。
本分支把它们一并带入 fork，使这些引用不再指向仓库外。

## 完整性

`r1-evidence-2026-09-23` 与 `r1-supplemental-2026-09-24` 受
`r1-rework-2026-09-24/accounting/` 下两份冻结清单约束（`find . -type f` 逐文件 sha256）。
从 `archives/` 的 tarball 解包后重算，与冻结清单逐行相同——归档时两条 `diff` 均为空：

```sh
ARCH=<本分支的检出根>          # 例如 git worktree 或 clone 的路径
mkdir -p /tmp/verify && cd /tmp/verify
tar xzf "$ARCH/archives/r1-evidence-2026-09-23.tar.gz" && cd r1-evidence-2026-09-23
LC_ALL=C find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum \
  | diff - "$ARCH/records/r1-rework-2026-09-24/accounting/archive-r1-evidence-2026-09-23.sha256"
```

`r1-supplemental-2026-09-24` 同理，对照
`records/r1-rework-2026-09-24/accounting/archive-r1-supplemental-2026-09-24.sha256`。

`records/` 是同一内容的可浏览副本，**去掉了树内嵌套的 `.git` 目录**——git 无法把 `.git` 当普通内容保存。
共 8 处、143 个文件：

```
r1-evidence-2026-09-23/s1/repo/.git
r1-evidence-2026-09-23/s2/repo/.git
r1-evidence-2026-09-23/s3/repo/.git
r1-run-scratch/s2/repo/.git
r1-run-scratch/s3/repo/.git
r1-scratch/s1/repo/.git
r1-supplemental-2026-09-24/evidence/s3/repo/.git
r1-supplemental-2026-09-24/run/s3/repo/.git
```

需要逐字节核对时用 `archives/` 里的 tarball（`sha256sum -c archives/SHA256SUMS`）。

## 不在本分支的内容

- 开发分支本身：在 `wip/task-runtime-20260917`（75 个本地提交）与 tag `baseline-p4-20260921`。
- 外层 `harness` 仓库的 82 个本地提交（子模块指针同步与文档 checkpoint）：未推送，清单见
  `provenance/outer-harness-local-commits.txt`。本分支只快照了其中关于 Singularity 的两份文档。
- `/home/ROXY/code/bb_work/` 下与 Singularity 无关的内容：`buckyball/`、`legacy-harness-plugins/`、
  `backup-dsh-plugin-20260909/`。

## 删除

本分支是 orphan，删除它不影响任何开发线：

```sh
git push fork --delete dev-records/2026-09-24
```
