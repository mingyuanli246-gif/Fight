import type { Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface SearchHighlightPayload {
  from: number;
  to: number;
}

const SEARCH_HIGHLIGHT_PLUGIN_KEY = new PluginKey<DecorationSet>(
  "search-highlight",
);

function normalizeCandidate(value: string) {
  return value
    .replace(/…/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
}

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
              ) as SearchHighlightPayload | null | undefined;

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
  payload: SearchHighlightPayload,
) {
  if (!editor) {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(SEARCH_HIGHLIGHT_PLUGIN_KEY, payload),
  );
}

export function findFirstHighlightRange(
  doc: ProseMirrorNode,
  candidates: string[],
) {
  const normalizedCandidates = candidates
    .flatMap((candidate) => {
      const normalized = normalizeCandidate(candidate);

      if (!normalized) {
        return [];
      }

      const tokens = normalized.split(" ").filter((token) => token.length >= 2);
      return [normalized, ...tokens];
    })
    .filter((candidate, index, current) => current.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);

  if (normalizedCandidates.length === 0) {
    return null;
  }

  let match: SearchHighlightPayload | null = null;

  doc.descendants((node, position) => {
    if (match || !node.isText || !node.text) {
      return !match;
    }

    const normalizedText = node.text.toLocaleLowerCase("zh-CN");

    for (const candidate of normalizedCandidates) {
      const index = normalizedText.indexOf(candidate);

      if (index >= 0) {
        match = {
          from: position + index,
          to: position + index + candidate.length,
        };
        return false;
      }
    }

    return true;
  });

  return match;
}
