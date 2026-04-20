import { useEditorState, type Editor } from "@tiptap/react";
import { useEffect, useState, type ReactNode } from "react";
import { EDITOR_CAPABILITIES } from "./editorCapabilities";
import {
  getSelectedNoteImageDisplaySize,
  setSelectedNoteImageDisplaySize,
} from "./editorCommands";
import styles from "./NotebookWorkspace.module.css";

interface RichTextToolbarProps {
  editor: Editor | null;
  disabled: boolean;
  onInsertInlineMath: () => void;
  onInsertBlockMath: () => void;
  onInsertImage: () => void;
  trailingContent?: ReactNode;
}

interface ToolbarButtonDescriptor {
  key: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  disabled: boolean;
  onClick: () => void;
}

function ToolbarButton({
  label,
  icon,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      className={`${styles.toolbarButton} ${
        active ? styles.toolbarButtonActive : ""
      }`}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "4px",
      }}
    >
      {icon ?? label}
    </button>
  );
}

const Icons = {
  Bold: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 12a4 4 0 0 0 0-8H6v8" />
      <path d="M15 20a4 4 0 0 0 0-8H6v8Z" />
    </svg>
  ),
  Underline: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
      <line x1="4" y1="21" x2="20" y2="21" />
    </svg>
  ),
  BulletList: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  OrderedList: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="10" y1="6" x2="21" y2="6" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <line x1="10" y1="18" x2="21" y2="18" />
      <path d="M4 6h1v4" />
      <path d="M4 10h2" />
      <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
    </svg>
  ),
  AlignCenter: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="6" />
      <line x1="21" y1="12" x2="3" y2="12" />
      <line x1="18" y1="18" x2="6" y2="18" />
    </svg>
  ),
  Image: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  Undo: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  ),
  Redo: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
    </svg>
  ),
  Formula: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7V5h16v2" />
      <path d="M4 19v2h16v-2" />
      <path d="M20 5 12 12l8 7" />
    </svg>
  ),
};

export function RichTextToolbar({
  editor,
  disabled,
  onInsertInlineMath,
  onInsertBlockMath,
  onInsertImage,
  trailingContent,
}: RichTextToolbarProps) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const handleTransaction = () => {
      forceUpdate((prev) => prev + 1);
    };

    editor.on("transaction", handleTransaction);

    return () => {
      editor.off("transaction", handleTransaction);
    };
  }, [editor]);

  const selectedImageDisplaySize = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) =>
      getSelectedNoteImageDisplaySize(currentEditor),
  });
  const isUnavailable = disabled || editor === null;
  const isCentered = editor?.isActive({ textAlign: "center" }) ?? false;
  const hasSelectedImage = selectedImageDisplaySize !== null;
  const blockButtons: ToolbarButtonDescriptor[] = [
    {
      key: "heading-1",
      label: "一级标题",
      icon: (
        <span style={{ fontWeight: 800, fontSize: "14px", fontFamily: "serif" }}>
          H1
        </span>
      ),
      active: editor?.isActive("heading", { level: 1 }) ?? false,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().toggleHeading({ level: 1 }).run() ?? false),
      onClick() {
        editor?.chain().focus().toggleHeading({ level: 1 }).run();
      },
    },
    {
      key: "heading-2",
      label: "二级标题",
      icon: (
        <span style={{ fontWeight: 700, fontSize: "14px", fontFamily: "serif" }}>
          H2
        </span>
      ),
      active: editor?.isActive("heading", { level: 2 }) ?? false,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().toggleHeading({ level: 2 }).run() ?? false),
      onClick() {
        editor?.chain().focus().toggleHeading({ level: 2 }).run();
      },
    },
  ];
  const inlineButtons: ToolbarButtonDescriptor[] = [
    {
      key: "bold",
      label: "加粗",
      icon: Icons.Bold,
      active: editor?.isActive("bold") ?? false,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().toggleBold().run() ?? false),
      onClick() {
        editor?.chain().focus().toggleBold().run();
      },
    },
    {
      key: "underline",
      label: "下划线",
      icon: Icons.Underline,
      active: editor?.isActive("underline") ?? false,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().toggleUnderline().run() ?? false),
      onClick() {
        editor?.chain().focus().toggleUnderline().run();
      },
    },
  ];
  const listButtons: ToolbarButtonDescriptor[] = [
    {
      key: "bullet-list",
      label: "无序列表",
      icon: Icons.BulletList,
      active: editor?.isActive("bulletList") ?? false,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().toggleBulletList().run() ?? false),
      onClick() {
        editor?.chain().focus().toggleBulletList().run();
      },
    },
    {
      key: "ordered-list",
      label: "有序列表",
      icon: Icons.OrderedList,
      active: editor?.isActive("orderedList") ?? false,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().toggleOrderedList().run() ?? false),
      onClick() {
        editor?.chain().focus().toggleOrderedList().run();
      },
    },
  ];
  const alignmentButtons: ToolbarButtonDescriptor[] = [
    {
      key: "text-align-center",
      label: "居中",
      icon: Icons.AlignCenter,
      active: isCentered,
      disabled:
        isUnavailable ||
        !(
          isCentered
            ? editor?.can().chain().focus().unsetTextAlign().run() ?? false
            : editor?.can().chain().focus().setTextAlign("center").run() ?? false
        ),
      onClick() {
        if (isCentered) {
          editor?.chain().focus().unsetTextAlign().run();
          return;
        }

        editor?.chain().focus().setTextAlign("center").run();
      },
    },
  ];
  const insertionButtons: ToolbarButtonDescriptor[] = [];

  if (
    EDITOR_CAPABILITIES.latex.enabled &&
    typeof EDITOR_CAPABILITIES.latex !== "boolean"
  ) {
    insertionButtons.push({
      key: "inline-math",
      label: "行内公式",
      icon: (
        <span style={{ fontWeight: "bold", fontStyle: "italic", fontSize: "14px" }}>
          ∑
        </span>
      ),
      disabled: isUnavailable,
      onClick() {
        onInsertInlineMath();
      },
    });
    insertionButtons.push({
      key: "block-math",
      label: "块级公式",
      icon: Icons.Formula,
      disabled: isUnavailable,
      onClick() {
        onInsertBlockMath();
      },
    });
  }

  if (
    EDITOR_CAPABILITIES.images.enabled &&
    typeof EDITOR_CAPABILITIES.images !== "boolean"
  ) {
    insertionButtons.push({
      key: "image",
      label: "插入图片",
      icon: Icons.Image,
      disabled: isUnavailable,
      onClick() {
        onInsertImage();
      },
    });
  }

  const imageSizeButtons: ToolbarButtonDescriptor[] = hasSelectedImage
    ? [
        {
          key: "image-size-small",
          label: "小图",
          active: selectedImageDisplaySize === "small",
          disabled: isUnavailable,
          onClick() {
            setSelectedNoteImageDisplaySize(editor, "small");
          },
        },
        {
          key: "image-size-medium",
          label: "中图",
          active: selectedImageDisplaySize === "medium",
          disabled: isUnavailable,
          onClick() {
            setSelectedNoteImageDisplaySize(editor, "medium");
          },
        },
        {
          key: "image-size-large",
          label: "大图",
          active: selectedImageDisplaySize === "large",
          disabled: isUnavailable,
          onClick() {
            setSelectedNoteImageDisplaySize(editor, "large");
          },
        },
        {
          key: "image-size-default",
          label: "默认",
          active: selectedImageDisplaySize === "default",
          disabled: isUnavailable,
          onClick() {
            setSelectedNoteImageDisplaySize(editor, "default");
          },
        },
      ]
    : [];

  const historyButtons: ToolbarButtonDescriptor[] = [
    {
      key: "undo",
      label: "撤销",
      icon: Icons.Undo,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().undo().run() ?? false),
      onClick() {
        editor?.chain().focus().undo().run();
      },
    },
    {
      key: "redo",
      label: "重做",
      icon: Icons.Redo,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().redo().run() ?? false),
      onClick() {
        editor?.chain().focus().redo().run();
      },
    },
  ];
  const toolbarGroups = [
    blockButtons,
    inlineButtons,
    listButtons,
    alignmentButtons,
    insertionButtons,
    imageSizeButtons,
    historyButtons,
  ].filter((group) => group.length > 0);

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="正文编辑工具栏">
      {toolbarGroups.map((group, index) => (
        <div key={index} className={styles.toolbarGroup}>
          {group.map((button) => (
            <ToolbarButton
              key={button.key}
              label={button.label}
              icon={button.icon}
              active={button.active}
              disabled={button.disabled}
              onClick={button.onClick}
            />
          ))}
        </div>
      ))}
      {trailingContent ? (
        <div className={styles.toolbarUtilityGroup}>{trailingContent}</div>
      ) : null}
    </div>
  );
}
