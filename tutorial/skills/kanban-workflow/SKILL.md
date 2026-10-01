---
name: kanban-workflow
description: tutorial-kanban 应用的架构地图、改动入口、测试与构建命令、完成定义；在实现或审查本教程项目时读取。
---

# tutorial-kanban 工作流

## 位置与栈

项目在本环境根目录的 `tutorial/kanban/`。Vite + React 18 + TypeScript + Vitest(jsdom) + Testing Library，依赖与 `pnpm-lock.yaml` 已随项目提供，`pnpm install` 秒级完成。项目随附红灯基线：测试是规格，实现在少数几个位置被故意留空。

## 架构地图

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | `Card` / `BoardState` / `BoardAction` 类型与 `COLUMNS` 常量 |
| `src/state/boardReducer.ts` | 唯一的纯函数状态机：`card/add`、`card/move`、`card/archive` |
| `src/components/Board.tsx` | 三列布局 + 新建卡片表单，回调上抛 |
| `src/components/Column.tsx` | 一列：标题、未归档卡片列表 |
| `src/components/Card.tsx` | 单卡：标题、移动下拉、归档按钮 |
| `src/hooks/useLocalStorageBoard.ts` | 读写 `localStorage`（key `tutorial-kanban.board`） |
| `src/App.tsx` | 组装 reducer、hook 与组件 |
| `src/state/boardReducer.test.ts` | reducer 规格 |
| `src/components/Board.test.tsx` | 组件渲染与交互规格 |
| `src/App.test.tsx` | 端到端持久化往返规格 |

数据流：`App` 调 `useLocalStorageBoard` 得到 `board` 与 `dispatch`；`cards` 和三个回调传给 `Board`；`Board` → `Column` → `Card` 逐层渲染，交互只回抛回调，所有状态变更都走 `boardReducer`。

## 命令

```sh
pnpm install                                      # 一次性
pnpm test                                         # 全量测试
pnpm vitest run src/state/boardReducer.test.ts    # 单文件验收
pnpm build                                        # tsc --noEmit && vite build
```

## 完成定义

- `pnpm test` 全部测试文件与用例通过，退出码 0。
- `pnpm build` 退出码 0。
- 不删除、跳过或放宽任何测试；测试是规格，实现向测试对齐。
- 每条结论附最近一次真实执行的原始命令与输出。

## 分层验收

reducer 层看 `boardReducer.test.ts`，组件层看 `Board.test.tsx`，组装与持久化层看 `App.test.tsx`。每层都能单独跑单文件核对；根节点的完成判据是三个测试文件全绿加构建成功。
