# 私有 DSH 实跑测试

开发、构建 peers 和产品运行都使用 `/home/ROXY/singularity-next/`。旧 harness 只供只读参考。
真实运行加载私有 `singularity-next-web` profile 与本仓库已构建插件；会话与原始证据保留在专用 home。

## 一轮代码验证

```bash
cd /home/ROXY/code/singularity-core
pnpm build
pnpm test
pnpm gates
git diff --check
```

构建检查 core、assembly 和前端类型，装载导出并核对产物摘要。回归与门禁不启动模型，不作为实际领域验收证据。

## 浏览器验收入口

```bash
. /home/ROXY/singularity-next/env.sh
node scripts/deploy.mjs
dsh --profile singularity-next-web --host 127.0.0.1 --port 7331 --no-open
```

从原生界面提交 RTL 目标和自然语言验收要求，不续发阶段指令。执行节点复用相关方法或直接声明一次性任务，提交工作区产物；独立 ReviewRun 逐条判断标准，必要时创建取证 Task。所有节点使用公开 create/resume 的普通主 agent 会话，Bubble 保护输入、验收程序和其他任务历史。

依据准确会话、committed snapshot、封存附件与正式 receipt 定位问题；不得伪造模型流程。恢复使用原会话、原 Run 与冻结目录，已冻结的检查结果、审核、trial 和发布决定复用。图、依赖、能力缺口、验收及 RSI 记录取同一状态前缀，节点直接连接自己的原生会话。

## Method 进化与原生发布验收

部署 seed 初始化唯一方法指针。每个 Run 直接固定方法 Revision 和 Bubble 执行快照；临时契约不创建 Revision。根任务关闭后，后台等待原生会话结束并封存完整轨迹，再创建 RSI 节点；evaluation 根不再次触发 RSI。候选由 RSI 节点按路径提交，经过结构、绑定、工具正反例及保护边界检查，直接进入隔离双侧测评。测评请求立即返回持久引用，宿主从 measure、strategy、release 事实恢复；最终发布仍要求独立 ReviewRun 和准确 expected head。

先以 letters 取得真实“候选→独立测评→决定”记录，再运行 SHA256。无赢家可以证明流程闭环；只有真实发布并且后续 Run 实际消费该版本，才能证明方法更新生效。中断检查分别覆盖提交、独立审核、测评、发布；恢复必须复用同一对象和已完成事实，不要求模型重发长调用。历史实验只读，新实验采用新协议。

## 证据边界

本轮优化仅改变 `sha256_w_mem.v`，保护完整 core/K、端口、复位、SHA224/SHA256 功能与逐周期时序。整核面积基线为 64858.4544 µm²，同工具、库和输入下至少改善 1%。包含审核的原生 token 成本增幅上限为 25%；每批提案成本均摊到候选，各候选另计自身求解、验收与最终发布审核。总预算为 3 亿 tokens，high 思考。没有固定子树、轮次或候选数量。

领域效果以真实执行的任务、产物、独立判决、原生 usage 和发布记录为据。无赢家、未改善、证据不足或预算耗尽如实报告。旧受控演示与离线测试不能代替当前自主任务链与 RSI 验收。
