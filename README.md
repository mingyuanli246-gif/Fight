# 本地笔记

面向长期自用的中文本地桌面笔记应用，按“本地优先”的桌面工具来设计，技术栈固定为 `Tauri + React + TypeScript + Vite + SQLite`。

## 当前定位

- 数据完全存储在本地电脑
- 中文界面，面向学习笔记、标签、复习计划、复习日历、备份恢复
- 正文编辑器使用 Tiptap
- 搜索索引使用 SQLite FTS5
- 备份格式使用本地 zip，恢复走真实目录替换

## 当前已实现能力

- 主导航 Rail：笔记本、复习日历、标签广场、设置
- 笔记本模块：笔记本 -> 文件夹 -> 文件三层结构，本地 SQLite 持久化，新建、重命名、删除
- note 编辑：Tiptap 富文本正文、Markdown 快捷输入 MVP（`#`、`##`、`-`、`*`、`1.`）、LaTeX 公式 MVP（行内 / 块级）、图片插入 MVP（本地导入到 `resources/images/`）、自动保存、切 note 前 flush、防串写
- 未保存正文保护：切 section 前统一 flush；窗口关闭、刷新前增加保护链路；恢复备份前增加保存检查入口
- 全局搜索：搜索 note 标题和正文，点击结果直达目标 note
- 标签系统：note 级标签、标签广场、标签关联 note 打开链路
- 复习系统：复习方案、note 绑定、任务生成、月历查看、完成/取消完成
- 设置页：主题持久化、数据目录展示、手动备份、自动备份、备份恢复、手动重建搜索索引；创建备份后列表会立即出现新备份项，并在后台补齐最终刷新
- 笔记本封面：支持设置、更换、清除封面，封面图通过本地导入落到 `resources/covers/`，在侧栏列表与详情区预览展示
- 备份恢复：支持 `schemaVersion`，兼容合法旧版本备份推断恢复

## 第十阶段新增

- 关闭窗口 / WebView 刷新前的未保存正文保护补齐
- Settings 恢复备份前增加统一正文保存检查入口
- review 高风险写路径迁到 Rust command：
  - `renameReviewPlan`
  - `deleteReviewPlan`
  - `setReviewTaskCompleted`
- 新增编辑器扩展边界文件：
  - `src/features/notebooks/editorCapabilities.ts`
  - `src/features/notebooks/editorCommands.ts`
  - `src/features/notebooks/editorResources.ts`
- 工具栏改为 descriptor 结构，预留未来插入类按钮分组
- 新增阶段十手动回归清单：
  - [docs/stage-10-smoke-checklist.md](/Users/lihongxia/Downloads/Fight/docs/stage-10-smoke-checklist.md)

## 第十一阶段新增

- 新增 Markdown 快捷输入 MVP：
  - `# ` -> 一级标题
  - `## ` -> 二级标题
  - `- ` / `* ` -> 无序列表
  - `1. ` -> 有序列表
- 空列表项按回车退出列表，标题行回车后下一行回到普通段落
- 新增专用编辑器边界文件：
  - `src/features/notebooks/editorShortcuts.ts`
  - `src/features/notebooks/editorInputRules.ts`
  - `src/features/notebooks/editorExtensions.ts`
- 编辑器只对白名单扩展启用 `markdownShortcuts` 输入规则，避免 `StarterKit` 默认更宽的 Markdown 规则直接进入主干
- 编辑区新增最小提示文案，并把快捷输入验证步骤并入现有 smoke checklist

## 第十二阶段新增

- 新增 LaTeX 最小闭环：
  - 支持行内公式与块级公式
  - 通过工具栏按钮插入
  - 双击已插入公式重新编辑源码
  - 非法公式会在轻量对话框内给出中文错误提示，不写入正文
- 公式渲染使用 `KaTeX`
- HTML 主存储新增公式节点约定：
  - 行内公式：`<span data-note-math="inline" data-latex="...">源码</span>`
  - 块级公式：`<div data-note-math="block" data-latex="...">源码</div>`
- 搜索索引会提取公式源码，而不是 KaTeX 运行时 DOM
- 当前不启用 `$...$` 或 `$$...$$` 自动解析，LaTeX 入口以工具栏插入 + 双击编辑为准

## 第十三阶段新增

- 新增图片与本地资源最小闭环：
  - 工具栏“图片”按钮已启用
  - 选择本地图片后会复制到应用数据目录下的 `resources/images/`
  - 正文中持久化的是相对资源路径，不依赖用户原始绝对路径
  - note 关闭重开后图片仍可恢复显示
- 新增 notebook 封面 MVP：
  - 支持设置、替换、清除封面
  - 封面图复用同一套本地资源体系，保存到 `resources/covers/`
  - 当前展示形态为“侧栏缩略图 + 详情区预览”，不新增独立封面网格
- 新增资源目录初始化：
  - 应用启动时会显式确保 `resources/`、`resources/images/`、`resources/covers/` 存在
  - 资源路径只接受 `resources/...` 相对路径，拒绝空路径、绝对路径、`..`、`.` 和反斜杠逃逸
- 正文图片 HTML 持久化契约：
  - `<img data-note-image="true" data-resource-path="resources/images/xxx.png" alt="" />`
  - `data-resource-path` 是唯一权威字段，不把运行时 `src` 写回正文
- 搜索与恢复兼容：
  - 图片节点不会破坏现有纯文本抽取和搜索索引
  - 若后续为图片补 `alt` 文本，索引会按 `alt` 参与纯文本提取；当前 MVP 默认 `alt=""`
  - 现有 zip 备份 / 恢复继续打包和恢复 `resources/`，正文图片与 notebook 封面可随备份 roundtrip

## 第十四A阶段新增

- 备份链路新增 `[backup.perf]` 分阶段耗时日志：
  - `create_backup.database_snapshot`
  - `create_backup.resources_zip`
  - `create_backup.zip_write`
  - `create_backup.result`
  - `validate_backup_archive`
- 创建备份后不再对新生成 zip 立即重复自检；新备份返回项直接基于本次创建时的 manifest 与文件元数据构造
- 设置页创建备份成功后，会先把新备份立即插入当前列表，再静默触发一次后台补刷新，不再同步阻塞在全量重扫全部 zip
- restore 前的严格校验保持不变，仍通过 `validate_backup_archive` 进行最终把关
- `resources/` 下的已压缩图片资源按扩展名改为 `Stored` 写入 zip，其他资源仍保持 `Deflated`
- 新增第十四A阶段最小回归清单：
  - [docs/stage-14a-backup-regression-checklist.md](/Users/lihongxia/Downloads/Fight/docs/stage-14a-backup-regression-checklist.md)

## 事务写路径审计

当前仓库仍是“部分 Rust command + 部分前端直写”的混合态，这里只收口真实高风险路径，不做一把梭重写。

| 风险级别 | 路径 | 当前处理 | 说明 |
| --- | --- | --- | --- |
| A | `createNote` `renameNote` `updateNoteContent` `deleteNote` | Rust command | 涉及正文落盘、搜索索引同步或高频切换路径 |
| A | `deleteNotebook` `deleteFolder` | Rust command | 删除链路依赖事务一致性 |
| A | `updateNotebookCoverImage` `clearNotebookCoverImage` | Rust command | 第十四B阶段迁移；封面路径同时跨 `notebooks`、`resources/covers/` 与前端资源状态，是剩余最高风险写路径 |
| A | `addTagToNoteByName` `removeTagFromNote` | Rust command | 涉及 note/tag 关系写入 |
| A | `createReviewPlan` `renameReviewPlan` `deleteReviewPlan` | Rust command | 复习方案及其步骤/关联任务需要单连接事务 |
| A | `bindReviewPlanToNote` `removeReviewPlanBinding` | Rust command | 涉及绑定与任务生成/清理 |
| A | `setReviewTaskCompleted` | Rust command | 复习任务完成状态是高频关键写路径 |
| B | `createFolder` `deleteTag` | 前端直写保留 | `createFolder` 只有同表 `sort_order` 分配竞态，`deleteTag` 虽联动 `note_tags` 但由 SQLite FK 级联单语句原子完成 |
| C | `createNotebook` `renameNotebook` `renameFolder` `createTag` `renameTag` | 前端直写保留 | 单表、低耦合、失败后不会留下跨资源脏状态；`createTag` 的两步颜色分配只会带来颜色重复，不影响关系正确性 |

第十四B阶段完整审计表与保留理由见：
- [docs/stage-14b-transaction-audit.md](/Users/lihongxia/Downloads/Fight/docs/stage-14b-transaction-audit.md)

## 存储与索引约定

- `notes.content_plaintext` 字段名仍沿用旧 schema，但当前实际承载 HTML
- 这是已知命名债，本阶段只补注释和文档，不做 schema 迁移
- 当前搜索索引的权威纯文本提取在 Rust `database_ops.rs` 中完成；前端仅保留等价辅助边界，供后续编辑器扩展复用
- 公式节点在索引中按 LaTeX 源码降级，不索引 KaTeX 渲染结果
- 图片节点在正文中按本地资源相对路径持久化，不索引二进制内容，也不保存用户原始绝对路径
- 启动时会先确保资源目录存在，再继续自动备份检查

## 当前未实现的产品能力

- 更完整的 Markdown 规则集与 Markdown 导出
- `$...$` / `$$...$$` 自动公式解析与更完整的数学输入体系
- 图片裁切、缩放、caption、拖拽排版、OCR、资源管理器
- 笔记本封面网格视图

## 启动与验证

```bash
npm install
npm run tauri dev
```

```bash
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
