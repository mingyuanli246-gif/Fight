# 第十六阶段：笔记本首页与笔记本内部工作区 UI 重构

这份文档只记录第十六阶段 notebooks UI 的当前实现事实，不重复描述既有数据层、备份链路或事务审计细节。

## 1. 模式切换

- `notebooks` section 现在有两种显式模式：
  - `home`：显示 App 左侧主导航 Rail，右侧主区域为笔记本首页
  - `detail`：隐藏 Rail，进入沉浸式笔记本内部工作区
- `NotebookWorkspace` 仍然是 notebooks 数据读取、mutation、flush guard 和 open note 请求的统一编排点。
- `AppShell` 只根据 notebooks 当前模式决定是否显示 Rail 和全局顶部搜索，不改 section 切换保护。

## 2. 笔记本首页

- 首页顶部为居中全局搜索，复用现有 `GlobalSearch` 搜索逻辑。
- 搜索结果点击后继续走 `App -> onOpenNote -> NotebookWorkspace openRequest` 正式链路，不做旁路打开。
- 首页主体为笔记本封面网格：
  - 有封面时显示本地 `resources/covers/` 图片
  - 无封面时使用固定低饱和纯色渐变 fallback
- 首页支持排序切换：
  - `updated-desc`
  - `created-desc`
  - `name-asc`
  - `name-desc`
- 排序值本地持久化到：
  - `localStorage["notebooks.home.sort"]`
- 卡片支持：
  - 单击进入 notebooks 内部工作区
  - 双击名称进入重命名输入态
  - 右键菜单：重命名、更换封面、清除封面、删除

## 3. 笔记本内部工作区

- 内部态顶部固定显示：
  - 返回箭头
  - 当前笔记本名称
- 主体采用三栏：
  - 左栏：文件夹与文件树
  - 中栏：编辑器信息头 + 工具栏 + 正文区
  - 右栏：标签与复习计划
- 右栏支持折叠为窄竖条，并本地持久化到：
  - `localStorage["notebooks.detail.right-panel-collapsed"]`
- 中栏继续复用现有 `NoteEditorPane` 的自动保存、flush、图片、公式与错误提示链路。

## 4. 左树与交互迁移

- 左树顶部保留两个创建入口：
  - 新建文件夹
  - 新建文件
- 新建使用默认名称，不自动进入重命名。
- 文件夹支持展开 / 收起；进入某个 note 时会自动确保其父 folder 已展开。
- 文件夹与文件名称支持双击重命名：
  - `Enter` 先进入小型确认态
  - `确认` 后才真正调用现有 rename handler
  - `Esc` 或取消放弃修改
- 统一删除快捷键为 `Command + Delete`：
  - 首页：作用于当前选中的笔记本卡片
  - 内部态：作用于左树当前选中的文件夹或文件
  - 如果焦点在输入框、按钮、`contenteditable` 或 ProseMirror 中，不触发

## 5. 搜索直达高亮

- `NoteOpenRequest` 已扩展为可选高亮负载：
  - `highlightQuery`
  - `highlightExcerpt`
  - `source`
- `GlobalSearch` 点击结果时会把查询词和 excerpt 一起带入 open request。
- `NoteEditorPane` 内新增一次性搜索高亮装饰层：
  - 打开目标 note 后定位首个可匹配正文文本
  - 自动滚动到可见区域
  - 高亮保留 5 秒后清除
- 第十六阶段只做首次命中高亮，不支持多命中导航。

## 6. 保持不变的边界

- 不改 SQLite schema。
- 不改 autosave / flush / beforeunload / close guard 语义。
- 不改搜索索引写入逻辑。
- 不改标签与复习计划数据语义。
- 不改备份恢复链路。
- 不做图片高级编辑和资源 GC。
