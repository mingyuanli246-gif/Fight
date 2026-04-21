import type { Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface OccurrenceFocusHighlightPayload {
  from: number;
  to: number;
}

const OCCURRENCE_FOCUS_HIGHLIGHT_PLUGIN_KEY =
  new PluginKey<DecorationSet>("occurrence-focus-highlight");

export function createOccurrenceFocusHighlightExtension(className: string) {
  return Extension.create({
    name: "occurrenceFocusHighlight",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: OCCURRENCE_FOCUS_HIGHLIGHT_PLUGIN_KEY,
          state: {
            init: () => DecorationSet.empty,
            apply(transaction, previous) {
              const payload = transaction.getMeta(
                OCCURRENCE_FOCUS_HIGHLIGHT_PLUGIN_KEY,
              ) as OccurrenceFocusHighlightPayload | null | undefined;

              if (payload === null) {
                return DecorationSet.empty;
              }

              if (payload) {
                return DecorationSet.create(transaction.doc, [
                  Decoration.inline(payload.from, payload.to, {
                    class: className,
                  }),
                ]);
              }

              if (transaction.docChanged) {
                return previous.map(transaction.mapping, transaction.doc);
              }

              return previous;
            },
          },
          props: {
            decorations(state) {
              return this.getState(state);
            },
          },
        }),
      ];
    },
  });
}

export function clearOccurrenceFocusHighlight(editor: Editor | null) {
  if (!editor) {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(OCCURRENCE_FOCUS_HIGHLIGHT_PLUGIN_KEY, null),
  );
}

export function setOccurrenceFocusHighlight(
  editor: Editor | null,
  payload: OccurrenceFocusHighlightPayload,
) {
  if (!editor) {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(OCCURRENCE_FOCUS_HIGHLIGHT_PLUGIN_KEY, payload),
  );
}
