import { useEffect, useRef } from "react";
import type { MathDisplayMode } from "./mathSerialization";
import editorStyles from "./NoteEditorSurface.module.css";
import styles from "./NotebookWorkspace.module.css";

interface MathEditorDialogProps {
  open: boolean;
  intent: "insert" | "edit";
  displayMode: MathDisplayMode;
  latex: string;
  errorMessage: string | null;
  onLatexChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function getDialogTitle(
  intent: "insert" | "edit",
  displayMode: MathDisplayMode,
) {
  const prefix = intent === "insert" ? "插入" : "编辑";
  return `${prefix}${displayMode === "inline" ? "行内公式" : "块级公式"}`;
}

function getPlaceholder(displayMode: MathDisplayMode) {
  return displayMode === "inline"
    ? "例如：E=mc^2"
    : "例如：\\frac{a}{b}";
}

export function MathEditorDialog({
  open,
  intent,
  displayMode,
  latex,
  errorMessage,
  onLatexChange,
  onConfirm,
  onCancel,
}: MathEditorDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(latex.length, latex.length);
    }, 0);
  }, [latex, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className={editorStyles.mathDialogOverlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        className={editorStyles.mathDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="math-editor-title"
      >
        <div className={editorStyles.mathDialogHeader}>
          <h4 id="math-editor-title" className={editorStyles.mathDialogTitle}>
            {getDialogTitle(intent, displayMode)}
          </h4>
          <p className={editorStyles.mathDialogHint}>
            输入 LaTeX 源码后确认插入。当前阶段不启用 `$` 或 `$$` 自动解析。
          </p>
        </div>

        <textarea
          ref={textareaRef}
          className={editorStyles.mathTextarea}
          value={latex}
          rows={displayMode === "block" ? 5 : 3}
          placeholder={getPlaceholder(displayMode)}
          onChange={(event) => onLatexChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }

            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            }
          }}
        />

        {errorMessage ? (
          <p className={editorStyles.mathDialogError}>{errorMessage}</p>
        ) : (
          <p className={editorStyles.mathDialogHint}>
            提示：可用 `Ctrl+Enter` 或 `Cmd+Enter` 快速确认。
          </p>
        )}

        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className={styles.actionButton}
            onClick={onConfirm}
          >
            {intent === "insert" ? "确认插入" : "确认更新"}
          </button>
        </div>
      </div>
    </div>
  );
}
