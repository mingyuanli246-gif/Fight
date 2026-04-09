# 第14B阶段：事务边界审计与定点收口

## 审计范围

本轮只审计当前仓库中仍由前端直接写 SQLite 的路径，不重写整体 repository 架构，也不把所有写路径一次性搬到 Rust。

审计结果确认：

- 剩余前端直写写路径都集中在 [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts)
- `review` / `settings` 模块没有新增漏网的前端直写数据库写路径
- 当前主干后续收口说明：
  - `createFolder` 已在后续阶段迁到 Rust `create_folder_tx`
  - 下表保留的是 14B 当时的审计快照，后续变化以文末“后续收口顺序”与 README 当前状态为准

## 完整审计表

| 路径名 | 所在文件 | 当前实现方式 | 涉及表 | 是否跨资源/跨表 | 风险级别 | 本阶段建议 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `createNotebook` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) | 前端直写 | `notebooks` | 否 | 低 | 保留 | 单表单次 `INSERT`，失败不会留下半成功状态，也没有外部资源联动。 |
| `renameNotebook` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) | 前端直写 | `notebooks` | 否 | 低 | 保留 | 单表单次 `UPDATE`，只有名称变更，无跨资源风险。 |
| `updateNotebookCoverImage` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) + [src/features/notebooks/NotebookWorkspace.tsx](/Users/lihongxia/Downloads/Fight/src/features/notebooks/NotebookWorkspace.tsx) | Rust command | `notebooks` | 是，跨 `notebooks` 行、`resources/covers/` 文件、资源解析缓存/UI 状态 | 高 | 迁移 | 新封面导入、数据库写入、旧封面清理分散在前端编排中，是剩余最高风险路径；14B 将数据库事务边界收口到 Rust。 |
| `clearNotebookCoverImage` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) + [src/features/notebooks/NotebookWorkspace.tsx](/Users/lihongxia/Downloads/Fight/src/features/notebooks/NotebookWorkspace.tsx) | Rust command | `notebooks` | 是，跨 `notebooks` 行、`resources/covers/` 文件、资源解析缓存/UI 状态 | 高 | 迁移 | 清除封面同样跨 DB 与资源文件；虽然比设置封面少一步导入，但仍属于多资源链路。 |
| `createFolder` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) | 前端直写 | `folders` | 否；同表两步（算 `sort_order` 再 `INSERT`） | 中 | 保留 | 有非原子 `sort_order` 分配问题，但只影响排序稳定性，不涉及跨资源或跨表脏状态。 |
| `renameFolder` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) | 前端直写 | `folders` | 否 | 低 | 保留 | 单表单次 `UPDATE`，失败面窄。 |
| `createTag` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) | 前端直写 | `tags` | 否；同表两步（算颜色再 `INSERT`） | 低 | 保留 | 两步逻辑只影响颜色分配，竞态最多导致颜色重复，不会破坏标签关系正确性。 |
| `renameTag` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) | 前端直写 | `tags` | 否 | 低 | 保留 | 单表改名，唯一约束已存在，失败无跨资源残留。 |
| `deleteTag` | [src/features/notebooks/repository.ts](/Users/lihongxia/Downloads/Fight/src/features/notebooks/repository.ts) | 前端直写 | `tags`、`note_tags` | 是，跨表；但由 SQLite FK 级联在单语句内完成 | 中 | 保留 | 虽然会联动 `note_tags`，但删除由数据库级联原子处理，不经过额外前端补动作。 |

## 本阶段实际迁移路径

- `updateNotebookCoverImage`
- `clearNotebookCoverImage`

迁移策略：

- 只把 notebook 封面的数据库写路径迁到 Rust command
- 使用单连接真实事务更新 `notebooks.cover_image_path`
- 保持现有中文错误包装与调用方语义不变
- 不把资源导入、旧封面删除、缓存清理并进本轮 Rust command

## 暂时保留前端实现的路径与原因

- `createNotebook`
  - 单表单次 `INSERT`，失败不会留下跨资源脏状态。
- `renameNotebook`
  - 单表名称更新，低耦合。
- `createFolder`
  - 当前问题主要是 `sort_order` 分配非原子；属于排序稳定性债务，不是高风险一致性故障。
- `renameFolder`
  - 单表名称更新，失败面窄。
- `createTag`
  - 颜色分配采用“先计数、再插入”，竞态只会造成颜色重复，不影响 tag/note 关系正确性。
- `renameTag`
  - 单表改名，唯一约束由数据库保证。
- `deleteTag`
  - 虽然会联动 `note_tags`，但依赖 SQLite 外键级联在单语句中原子完成，不需要额外前端补事务。

## 后续工程债

- `createFolder` 的 `sort_order` 分配仍是同表两步逻辑，后续可考虑收口到 Rust 事务。
- `createTag` 的颜色分配仍可能在并发下出现重复颜色；这是体验层债务，不是数据正确性故障。
- notebook 封面资源文件的导入、旧资源 best-effort 清理、资源缓存同步仍在前端编排中，14B 只收口数据库事务边界，没有处理孤儿文件回收。
- repository 与 Rust command 仍是混合态；后续如继续迁移，必须继续按“真实风险优先”逐条审计，不做一刀切重写。

## 后续收口顺序

基于当前主干事实，建议后续仍按风险而不是按“整齐度”推进：

1. `createFolder`
   - 已在后续阶段迁到 Rust `create_folder_tx`，优先解决 `sort_order` 竞争条件。
2. `createNotebook` / `renameNotebook` / `renameFolder`
   - 继续保留前端直写；单表、低耦合、失败后无跨资源脏状态。
3. `createTag` / `renameTag` / `deleteTag`
   - 继续保留前端直写；`createTag` 的主要问题是颜色分配可能重复，`deleteTag` 依赖 SQLite FK 级联仍是单语句原子完成。
