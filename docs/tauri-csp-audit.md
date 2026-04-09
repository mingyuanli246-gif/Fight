# Tauri CSP 审计草案

当前 `src-tauri/tauri.conf.json` 里仍是：

```json
"security": {
  "csp": null
}
```

这不是本轮直接收紧的对象。本轮只先把运行时依赖源做成草案，避免后续一刀切改 CSP 时把编辑器、公式或图片显示打坏。

## 当前已识别的资源来源

- 应用自身前端资源：`'self'`
- Tauri 本地资源协议：
  - `asset:`（图片、封面等 `resources/` 目录资源）
- 本地图像与可能的内联图片回退：
  - `data:`
  - `blob:`
- 开发态前端资源：
  - `http://localhost:1420`
  - `ws://localhost:1420`
- KaTeX 字体与样式：
  - 当前构建产物内联到应用资源中，按 `'self'` 处理

## 当前阻塞点

- 前端仍存在实例级 `style={...}` 用法，生产态若直接启用严格 `style-src`，大概率需要：
  - 暂时保留 `'unsafe-inline'`
  - 或先把这些 inline style 收口回 className
- 编辑器使用 Tiptap HTML，需在收紧前确认：
  - 不依赖额外远程脚本
  - 不依赖运行时注入的第三方样式来源

## 最小白名单草案

以下仅作为后续阶段的起点，不代表本轮已经启用：

```text
default-src 'self' asset: tauri:
img-src 'self' asset: data: blob:
font-src 'self' data:
style-src 'self' 'unsafe-inline'
script-src 'self'
connect-src 'self' http://localhost:1420 ws://localhost:1420
```

说明：

- 生产态可以进一步从 `connect-src` 中移除 dev server 项
- 若后续完全消除 inline style，再考虑移除 `style-src 'unsafe-inline'`
- 真正启用前，应至少回归：
  - 首页与 notebooks 内部工作区
  - 正文图片显示
  - notebook 封面显示
  - KaTeX 公式渲染
  - 设置页备份/恢复
