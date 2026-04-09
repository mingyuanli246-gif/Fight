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
- 笔记本模块：笔记本首页 + 笔记本内部沉浸式工作区；笔记本 -> 文件夹 -> 文件三层结构，本地 SQLite 持久化，新建、重命名、删除
- note 编辑：Tiptap 富文本正文、Markdown 快捷输入 MVP（`#`、`##`、`-`、`*`、`1.`）、LaTeX 公式 MVP（行内 / 块级）、图片插入 MVP（本地导入到 `resources/images/`）、自动保存、切 note 前 flush、防串写
- 未保存正文保护：切 section 前统一 flush；窗口关闭、刷新前增加保护链路；恢复备份前增加保存检查入口
- 全局搜索：搜索 note 标题和正文，点击结果直达目标 note；从笔记本首页搜索进入时会触发一次正文首次命中高亮
- 标签系统：note 级标签、标签广场、标签关联 note 打开链路
- 复习系统：复习方案、note 绑定、任务生成、月历查看、完成/取消完成
- 设置页：主题持久化、数据目录展示、手动备份、自动备份、备份恢复、手动重建搜索索引；创建备份后列表会立即出现新备份项，并在后台补齐最终刷新；首次打开设置页时备份列表会先显示轻量信息，再异步补校验状态
- 笔记本封面：支持设置、更换、清除封面，封面图通过本地导入落到 `resources/covers/`，并用于首页封面网格展示
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
- restore 前的严格校验保持不变，仍会对 zip、manifest、schema、settings 和 resources 做最终把关
- `resources/` 下的已压缩图片资源按扩展名改为 `Stored` 写入 zip，其他资源仍保持 `Deflated`
- 新增第十四A阶段最小回归清单：
  - [docs/stage-14a-backup-regression-checklist.md](/Users/lihongxia/Downloads/Fight/docs/stage-14a-backup-regression-checklist.md)

## 第十五阶段新增

- 设置页备份列表首开改为“轻列表优先”：
  - `list_backups` 只读取目录基础信息，不再首开严格扫描全部 zip
  - 备份项状态改为 `unknown` / `validating` / `valid` / `invalid`
  - 首屏只对排序靠前的 5 项做后台串行补校验，其余项按需单独校验
- 新增单项严格校验 command：
  - `validate_backup`
  - 仅在用户显式校验或准备恢复某个备份时触发
- restore 链路新增 `[backup.perf]` 阶段日志：
  - `restore_backup.open_archive`
  - `restore_backup.read_manifest`
  - `restore_backup.validate_database`
  - `restore_backup.validate_settings`
  - `restore_backup.validate_resources`
  - `restore_backup.extract_archive`
  - `restore_backup.prepare_rollback`
  - `restore_backup.swap_data`
  - `restore_backup.rollback`
  - `restore_backup.finalize`
- restore 失败原因统一按中文错误分类透出，前端不再只看到笼统“恢复失败”
- 第十四A清单已扩展为备份与恢复回归清单，继续复用原路径：
  - [docs/stage-14a-backup-regression-checklist.md](/Users/lihongxia/Downloads/Fight/docs/stage-14a-backup-regression-checklist.md)

## 当前工程守门

- 新增 `npm run lint`，补上最小 ESLint 入口，优先拦截前端接线与基础 TS/React Hook 问题
- 新增 `npm run check:tauri-commands`，静态比对前端 `invoke(...)` 与 `src-tauri/src/lib.rs` 中的 `generate_handler![]` 注册列表，防止命令接线漂移
- `createFolder` 已迁到 Rust `create_folder_tx`，避免前端 “先查 MAX(sort_order) 再插入” 在快速重复创建、批量导入或多窗口场景下留下排序竞争条件
- `security.csp` 当前仍保持 `null`；本轮只补来源审计与白名单草案，不直接硬收紧配置
- CSP 审计记录见：
  - [docs/tauri-csp-audit.md](/Users/lihongxia/Downloads/Fight/docs/tauri-csp-audit.md)

## 第十六阶段新增

- notebooks UI 改成两种显式模式：
  - 首页模式：保留主导航 Rail，右侧主区域显示居中搜索与笔记本封面网格
  - 内部模式：隐藏 Rail，进入沉浸式三栏工作区
- 笔记本首页新增：
  - 封面网格展示
  - 排序切换（最近更新、创建时间、名称正序、名称逆序）
  - 卡片右键菜单（重命名、更换封面、清除封面、删除）
  - 首页排序状态本地记忆
- notebooks 内部工作区新增：
  - 左上角返回首页入口
  - 左树 / 中间编辑区 / 右侧标签与复习计划的三栏布局
  - 右侧功能区折叠为窄竖条，并记忆上次展开 / 折叠状态
  - 文件夹与文件双击名称重命名
  - `Command + Delete` 删除确认
- 中间编辑区重排：
  - 顶部信息头固定显示当前文件标题、所属路径、保存状态、最近更新时间
  - 工具栏固定到信息头下方
  - 标签与复习计划从正文编辑区移到右侧功能区
- 首页搜索结果点击后会继续走既有 open note 链路，并对正文首个命中位置做一次 5 秒高亮
- 新增第十六阶段实现说明：
  - [docs/stage-16-notebooks-ui-rebuild.md](/Users/lihongxia/Downloads/Fight/docs/stage-16-notebooks-ui-rebuild.md)

## 事务写路径审计

当前仓库仍是“部分 Rust command + 部分前端直写”的混合态，这里只收口真实高风险路径，不做一把梭重写。

| 风险级别 | 路径 | 当前处理 | 说明 |
| --- | --- | --- | --- |
| A | `createNote` `renameNote` `updateNoteContent` `deleteNote` | Rust command | 涉及正文落盘、搜索索引同步或高频切换路径 |
| A | `deleteNotebook` `deleteFolder` | Rust command | 删除链路依赖事务一致性 |
| A | `createFolder` | Rust command | 后续阶段迁移；使用单连接事务与 `IMMEDIATE` 行为收口顶层 folder 的 `sort_order` 分配，避免快速重复创建或批处理下的排序竞争 |
| A | `updateNotebookCoverImage` `clearNotebookCoverImage` | Rust command | 第十四B阶段迁移；封面路径同时跨 `notebooks`、`resources/covers/` 与前端资源状态，是剩余最高风险写路径 |
| A | `addTagToNoteByName` `removeTagFromNote` | Rust command | 涉及 note/tag 关系写入 |
| A | `createReviewPlan` `renameReviewPlan` `deleteReviewPlan` | Rust command | 复习方案及其步骤/关联任务需要单连接事务 |
| A | `bindReviewPlanToNote` `removeReviewPlanBinding` | Rust command | 涉及绑定与任务生成/清理 |
| A | `setReviewTaskCompleted` | Rust command | 复习任务完成状态是高频关键写路径 |
| B | `deleteTag` | 前端直写保留 | 虽联动 `note_tags`，但由 SQLite FK 级联单语句原子完成 |
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

## 启动与验证

```bash
npm install
npm run tauri dev
```

```bash
npm run typecheck
npm run lint
npm run check:tauri-commands
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
