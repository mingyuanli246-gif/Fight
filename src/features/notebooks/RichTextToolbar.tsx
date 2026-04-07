import type { Editor } from "@tiptap/react";
import styles from "./NotebookWorkspace.module.css";

interface RichTextToolbarProps {
  editor: Editor | null;
  disabled: boolean;
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
}: RichTextToolbarProps) {
  const isUnavailable = disabled || editor === null;
  const isCentered = editor?.isActive({ textAlign: "center" }) ?? false;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="正文编辑工具栏">
      <div className={styles.toolbarGroup}>
        <ToolbarButton
          label="正文"
          active={editor?.isActive("paragraph") ?? false}
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().setParagraph().run() ?? false)
          }
          onClick={() => {
            editor?.chain().focus().setParagraph().run();
          }}
        />
        <ToolbarButton
          label="H1"
          active={editor?.isActive("heading", { level: 1 }) ?? false}
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().toggleHeading({ level: 1 }).run() ??
              false)
          }
          onClick={() => {
            editor?.chain().focus().toggleHeading({ level: 1 }).run();
          }}
        />
        <ToolbarButton
          label="H2"
          active={editor?.isActive("heading", { level: 2 }) ?? false}
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().toggleHeading({ level: 2 }).run() ??
              false)
          }
          onClick={() => {
            editor?.chain().focus().toggleHeading({ level: 2 }).run();
          }}
        />
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          label="加粗"
          active={editor?.isActive("bold") ?? false}
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().toggleBold().run() ?? false)
          }
          onClick={() => {
            editor?.chain().focus().toggleBold().run();
          }}
        />
        <ToolbarButton
          label="下划线"
          active={editor?.isActive("underline") ?? false}
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().toggleUnderline().run() ?? false)
          }
          onClick={() => {
            editor?.chain().focus().toggleUnderline().run();
          }}
        />
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          label="无序列表"
          active={editor?.isActive("bulletList") ?? false}
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().toggleBulletList().run() ?? false)
          }
          onClick={() => {
            editor?.chain().focus().toggleBulletList().run();
          }}
        />
        <ToolbarButton
          label="有序列表"
          active={editor?.isActive("orderedList") ?? false}
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().toggleOrderedList().run() ?? false)
          }
          onClick={() => {
            editor?.chain().focus().toggleOrderedList().run();
          }}
        />
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          label="居中"
          active={isCentered}
          disabled={
            isUnavailable ||
            !(
              isCentered
                ? editor?.can().chain().focus().unsetTextAlign().run() ?? false
                : editor?.can().chain().focus().setTextAlign("center").run() ??
                  false
            )
          }
          onClick={() => {
            if (isCentered) {
              editor?.chain().focus().unsetTextAlign().run();
              return;
            }

            editor?.chain().focus().setTextAlign("center").run();
          }}
        />
      </div>

      <div className={styles.toolbarGroup}>
        <ToolbarButton
          label="撤销"
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().undo().run() ?? false)
          }
          onClick={() => {
            editor?.chain().focus().undo().run();
          }}
        />
        <ToolbarButton
          label="重做"
          disabled={
            isUnavailable ||
            !(editor?.can().chain().focus().redo().run() ?? false)
          }
          onClick={() => {
            editor?.chain().focus().redo().run();
          }}
        />
      </div>
    </div>
  );
}
