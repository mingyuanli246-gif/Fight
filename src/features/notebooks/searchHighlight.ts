import type { Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  buildExactSearchPattern,
  splitExactSearchTokens,
} from "./searchQuery";

export interface SearchHighlightPayload {
  from: number;
  to: number;
}

const SEARCH_HIGHLIGHT_PLUGIN_KEY = new PluginKey<DecorationSet>("search-highlight");

export function createSearchHighlightExtension(className: string) {
  return Extension.create({
    name: "searchHighlight",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: SEARCH_HIGHLIGHT_PLUGIN_KEY,
          state: {
            init: () => DecorationSet.empty,
            apply(transaction, previous) {
              const payload = transaction.getMeta(
                SEARCH_HIGHLIGHT_PLUGIN_KEY,
              ) as SearchHighlightPayload[] | null | undefined;

              if (payload === null) {
                return DecorationSet.empty;
              }

              if (payload) {
                return DecorationSet.create(transaction.doc, [
                  ...payload.map((entry) =>
                    Decoration.inline(entry.from, entry.to, {
                      class: className,
                    }),
                  ),
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

export function clearSearchHighlight(editor: Editor | null) {
  if (!editor) {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(SEARCH_HIGHLIGHT_PLUGIN_KEY, null),
  );
}

export function setSearchHighlight(
  editor: Editor | null,
  payload: SearchHighlightPayload[],
) {
  if (!editor) {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(SEARCH_HIGHLIGHT_PLUGIN_KEY, payload),
  );
}

export function findHighlightRanges(doc: ProseMirrorNode, query: string) {
  const tokens = splitExactSearchTokens(query);
  const pattern = buildExactSearchPattern(tokens);

  if (!pattern) {
    return [] as SearchHighlightPayload[];
  }

  const matches: SearchHighlightPayload[] = [];

  doc.descendants((node, position) => {
    if (!node.isText || !node.text) {
      return true;
    }

    pattern.lastIndex = 0;
    for (const match of node.text.matchAll(pattern)) {
      const start = match.index ?? -1;
      const content = match[0] ?? "";

      if (start < 0 || content.length === 0) {
        continue;
      }

      matches.push({
        from: position + start,
        to: position + start + content.length,
      });
    }

    return true;
  });

  return matches;
}
