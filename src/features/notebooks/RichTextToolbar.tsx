import { useEditorState, type Editor } from "@tiptap/react";
import type { ReactNode } from "react";
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
  active?: boolean;
  disabled: boolean;
  onClick: () => void;
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.toolbarButton} ${
        active ? styles.toolbarButtonActive : ""
      }`}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function RichTextToolbar({
  editor,
  disabled,
  onInsertInlineMath,
  onInsertBlockMath,
  onInsertImage,
  trailingContent,
}: RichTextToolbarProps) {
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
      key: "paragraph",
      label: "正文",
      active: editor?.isActive("paragraph") ?? false,
      disabled:
        isUnavailable ||
        !(editor?.can().chain().focus().setParagraph().run() ?? false),
      onClick() {
        editor?.chain().focus().setParagraph().run();
      },
    },
    {
      key: "heading-1",
      label: "H1",
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
      label: "H2",
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
      disabled: isUnavailable,
      onClick() {
        onInsertInlineMath();
      },
    });
    insertionButtons.push({
      key: "block-math",
      label: "块级公式",
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
      label: "图片",
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
