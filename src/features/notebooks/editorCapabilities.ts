export interface EditorFutureCapability {
  enabled: boolean;
  note: string;
}

// 当前正文仍然存储在 notes.content_plaintext 中，但实际承载的是 HTML。
// 这是既有 schema 的命名债，本阶段只补边界与文档，不做字段迁移。
export const EDITOR_CAPABILITIES = {
  richTextToolbar: true,
  latex: {
    enabled: true,
    note: "第十二阶段已启用行内公式与块级公式 MVP，通过工具栏插入、双击编辑。",
  },
  images: {
    enabled: true,
    note: "第十三阶段已启用正文图片 MVP，通过本地导入并保存到 resources/images/。",
  },
  markdownShortcuts: {
    enabled: true,
    note: "第十一阶段已启用最小 Markdown 快捷输入，仅支持 #、##、-、*、1.。",
  },
  localResources: {
    enabled: true,
    note: "第十三阶段已启用本地资源目录闭环，统一使用 resources/images/ 与 resources/covers/。",
  },
} satisfies Record<
  "richTextToolbar" | "latex" | "images" | "markdownShortcuts" | "localResources",
  boolean | EditorFutureCapability
>;
