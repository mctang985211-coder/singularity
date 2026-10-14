# 接手入口

更新：2026-10-12，起点 `dc3f375`，本轮已修 `fb6b18b`、`67c7ffe`。

按以下顺序阅读，无需重读全部历史：

1. [round-10-plan](round-10-plan.md)：本轮实测到的三个产品级缺陷、当前能力状态与待接线工作包（W10—W14）。
2. [blueprint](blueprint.md)：总目标、范围、架构与文档职责。
3. [context](context.md)：用户已确认的合同、未关闭问题与验证边界。
4. [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点)：唯一施工顺序和退出条件。
5. [phase-g2-design](phase-g2-design.md)：当前任务运行合同。
6. [spec-policy](spec-policy.md) 与 [standalone-dsh](standalone-dsh.md)：验证规范与私有环境。

**先跑，再信文档。** 本轮三个缺陷（部署模板缺必填键、网关断流被判不可重试、`max-tokens` 结束不结算 Run）
全都是实跑暴露的，静态门禁与 `pnpm verify` 当时分别全绿。`pnpm verify` 离线且不含探针，
它通过**不构成**任何产品结论。

下一施工包是 W10—W12（gate 资产、进度读面、单命令验收），顺序与出口见 [round-10-plan §3](round-10-plan.md#3-待接线工作包)。
涉及尚未确认的领域模板、输入产物或实验预算/阈值时，带背景与选项通过提问工具确认；已定问题不重复询问。

每包完成后更新 context 的当前状态和原计划中的出口状态，删除关联失效代码、注释和重复断言。
历史实测按基线保留，过程解释放 Git；不追加新交接计划，不把静态绿色结果改写为产品完成。
