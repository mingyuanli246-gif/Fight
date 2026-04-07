# 本地笔记

面向长期自用的中文本地桌面笔记应用，技术栈固定为 `Tauri + React + TypeScript + Vite + SQLite`。

## 当前能力

- 本地笔记本 / 文件夹 / 文件三层结构 CRUD
- note 富文本编辑、自动保存、切 note 前 flush、防串写
- SQLite FTS5 搜索
- note 级标签与标签广场
- 复习方案、复习任务与复习日历
- 主题持久化、手动备份、自动备份、备份恢复

## 第九阶段重点

- 离开 notebooks 工作区前统一做未保存正文保护
- restore 前通过同一出口保护避免静默丢稿
- 搜索索引按需初始化，不再每次冷启动全量重建
- 备份 manifest 增加 `schemaVersion`，并兼容恢复旧版本合法备份

## 启动方式

```bash
npm install
npm run tauri dev
```

## 验证命令

```bash
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```
