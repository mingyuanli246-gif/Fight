import {
  Extension,
  Mark,
  mergeAttributes,
  type Editor,
  type Extensions,
} from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TAG_COLOR_PALETTE } from "./tagColors";
import type {
  LiveTextTagOccurrence,
  TextTagInspectionState,
  TextTagOccurrenceDraft,
  TextTagPanelState,
  TextTagSelectionState,
  TextTagSummary,
} from "./types";

export const TEXT_TAG_MARK_NAME = "textTag";
export const TEXT_TAG_SENTINEL_ATTR = "data-note-tag";
export const TEXT_TAG_ID_ATTR = "data-note-tag-id";
export const TEXT_TAG_COLOR_ATTR = "data-note-tag-color";
export const BLOCK_ID_ATTR = "data-block-id";

const SUPPORTED_BLOCK_TYPES = ["paragraph", "heading", "blockquote"] as const;
const SUPPORTED_BLOCK_TYPE_SET = new Set<string>(SUPPORTED_BLOCK_TYPES);
const TEXT_TAG_PALETTE_SET = new Set<string>(TAG_COLOR_PALETTE);
const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const BLOCK_ID_PATTERN = /^blk_[A-Za-z0-9_-]{10,}$/;
const OCCURRENCE_SNIPPET_MAX_LENGTH = 120;

type TextTagAttrs = {
  tagId: number;
  colorSnapshot: string;
};

type SupportedBlockNodeLike = {
  attrs: Record<string, unknown>;
  type: {
    name: string;
  };
};

type SelectionAnalysis = TextTagSelectionState;

type PendingOccurrence = {
  tagId: number;
  colorSnapshot: string;
  startOffset: number;
  endOffset: number;
  nodeType: string;
  snippetText: string;
  from: number;
  to: number;
};

type TextTagOperationTarget = {
  from: number;
  to: number;
  activeTagId: number | null;
  activeColorSnapshot: string | null;
};

type TextTagActivationMeta =
  | {
      type: "set";
      occurrenceKey: string;
      pulseClassName: string | null;
    }
  | {
      type: "clear";
    };

type TextTagActivationState = {
  occurrenceKey: string | null;
  pulseClassName: string | null;
};

const TEXT_TAG_ACTIVE_CLASS = "textTagActive";
const TEXT_TAG_PULSE_CLASS_A = "textTagPulseA";
const TEXT_TAG_PULSE_CLASS_B = "textTagPulseB";
const TEXT_TAG_ACTIVATION_PLUGIN_KEY = new PluginKey<TextTagActivationState>(
  "textTagActivation",
);

function createBlockId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `blk_${crypto.randomUUID().replace(/-/g, "")}`;
  }

  return `blk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function normalizeBlockId(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return BLOCK_ID_PATTERN.test(normalized) ? normalized : null;
}

function isSupportedBlockNode(node: SupportedBlockNodeLike) {
  return SUPPORTED_BLOCK_TYPE_SET.has(node.type.name);
}

function findPrimarySupportedBlock(editor: Editor, position: number) {
  const $position = editor.state.doc.resolve(position);

  for (let depth = $position.depth; depth >= 1; depth -= 1) {
    const node = $position.node(depth);

    if (!isSupportedBlockNode(node) || !(node as { isTextblock?: boolean }).isTextblock) {
      continue;
    }

    return {
      pos: $position.before(depth),
      node,
    };
  }

  return null;
}

function parseTagId(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(typeof value === "string" ? value.trim() : "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseColorSnapshot(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();

  if (!HEX_COLOR_PATTERN.test(normalized)) {
    return null;
  }

  return TEXT_TAG_PALETTE_SET.has(normalized) ? normalized : null;
}

function parseTextTagAttributesFromElement(element: HTMLElement): TextTagAttrs | false {
  if (
    element.tagName !== "SPAN" ||
    element.getAttribute(TEXT_TAG_SENTINEL_ATTR) !== "true"
  ) {
    return false;
  }

  const tagId = parseTagId(element.getAttribute(TEXT_TAG_ID_ATTR));
  const colorSnapshot = parseColorSnapshot(
    element.getAttribute(TEXT_TAG_COLOR_ATTR),
  );

  if (tagId === null || colorSnapshot === null) {
    return false;
  }

  return {
    tagId,
    colorSnapshot,
  };
}

function getValidTextTagAttrsFromMark(
  marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[],
) {
  const mark = marks.find((candidate) => candidate.type.name === TEXT_TAG_MARK_NAME);

  if (!mark) {
    return null;
  }

  const tagId = parseTagId(mark.attrs.tagId);
  const colorSnapshot = parseColorSnapshot(mark.attrs.colorSnapshot);

  if (tagId === null || colorSnapshot === null) {
    return null;
  }

  return {
    tagId,
    colorSnapshot,
  };
}

function normalizeOccurrenceSnippet(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  return normalized.length > OCCURRENCE_SNIPPET_MAX_LENGTH
    ? `${normalized.slice(0, OCCURRENCE_SNIPPET_MAX_LENGTH)}…`
    : normalized;
}

function buildOccurrenceKey(
  blockId: string,
  startOffset: number,
  endOffset: number,
  tagId: number,
) {
  return `${blockId}:${startOffset}:${endOffset}:${tagId}`;
}

function createEmptyTextTagInspectionStateInternal(): TextTagInspectionState {
  return {
    activeOccurrence: null,
  };
}

function createTextTagSummary(occurrences: LiveTextTagOccurrence[]): TextTagSummary {
  return {
    totalCount: occurrences.length,
    distinctTagCount: new Set(occurrences.map((occurrence) => occurrence.tagId)).size,
    textCount: occurrences.length,
    formulaCount: 0,
  };
}

function analyzeTextTagSelection(editor: Editor | null): SelectionAnalysis {
  if (!editor) {
    return {
      hasSelection: false,
      isTaggableSelection: false,
      activeTagId: null,
      activeColorSnapshot: null,
      hasMixedOrInvalidSelection: false,
    };
  }

  const { doc, selection } = editor.state;

  if (selection.empty) {
    return {
      hasSelection: false,
      isTaggableSelection: false,
      activeTagId: null,
      activeColorSnapshot: null,
      hasMixedOrInvalidSelection: false,
    };
  }

  let selectedTextLength = 0;
  let hasUnsupportedContent = false;
  const tagStates = new Set<string>();
  let hasTaggedSegment = false;
  let hasUntaggedSegment = false;
  const startBlock = findPrimarySupportedBlock(editor, selection.from);
  const endBlock = findPrimarySupportedBlock(
    editor,
    Math.max(selection.from, selection.to - 1),
  );

  if (!startBlock || !endBlock || startBlock.pos !== endBlock.pos) {
    return {
      hasSelection: true,
      isTaggableSelection: false,
      activeTagId: null,
      activeColorSnapshot: null,
      hasMixedOrInvalidSelection: true,
    };
  }

  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.isText) {
      const overlapFrom = Math.max(selection.from, pos);
      const overlapTo = Math.min(selection.to, pos + node.nodeSize);
      const overlapLength = overlapTo - overlapFrom;

      if (overlapLength <= 0) {
        return;
      }

      selectedTextLength += overlapLength;
      const attrs = getValidTextTagAttrsFromMark(node.marks);

      if (attrs) {
        hasTaggedSegment = true;
        tagStates.add(`${attrs.tagId}:${attrs.colorSnapshot}`);
      } else {
        hasUntaggedSegment = true;
      }

      return;
    }

    if (node.isLeaf && node.type.name !== "text") {
      hasUnsupportedContent = true;
    }
  });

  const isTaggableSelection = selectedTextLength > 0 && !hasUnsupportedContent;
  const hasMixedTagState =
    tagStates.size > 1 || (hasTaggedSegment && hasUntaggedSegment);

  if (!isTaggableSelection) {
    return {
      hasSelection: true,
      isTaggableSelection: false,
      activeTagId: null,
      activeColorSnapshot: null,
      hasMixedOrInvalidSelection: true,
    };
  }

  if (tagStates.size === 1 && !hasUntaggedSegment) {
    const [rawState] = Array.from(tagStates);
    const [rawTagId, colorSnapshot] = rawState.split(":");
    const activeTagId = Number.parseInt(rawTagId ?? "", 10);

    return {
      hasSelection: true,
      isTaggableSelection: true,
      activeTagId: Number.isInteger(activeTagId) ? activeTagId : null,
      activeColorSnapshot: colorSnapshot ?? null,
      hasMixedOrInvalidSelection: false,
    };
  }

  return {
    hasSelection: true,
    isTaggableSelection: true,
    activeTagId: null,
    activeColorSnapshot: null,
    hasMixedOrInvalidSelection: hasMixedTagState,
  };
}

function findActiveOccurrence(
  editor: Editor,
  occurrences: LiveTextTagOccurrence[],
) {
  const { selection } = editor.state;

  if (!selection.empty) {
    return null;
  }

  const caretPosition = selection.from;

  return (
    occurrences.find(
      (occurrence) =>
        caretPosition >= occurrence.from && caretPosition < occurrence.to,
    ) ?? null
  );
}

export function createEmptyTextTagSelectionState(): TextTagSelectionState {
  return {
    hasSelection: false,
    isTaggableSelection: false,
    activeTagId: null,
    activeColorSnapshot: null,
    hasMixedOrInvalidSelection: false,
  };
}

export function createEmptyTextTagInspectionState(): TextTagInspectionState {
  return createEmptyTextTagInspectionStateInternal();
}

export function getTextTagInspectionStateSignature(
  inspectionState: TextTagInspectionState,
) {
  const activeOccurrence = inspectionState.activeOccurrence;

  if (!activeOccurrence) {
    return "";
  }

  return [
    activeOccurrence.key,
    activeOccurrence.tagId,
    activeOccurrence.colorSnapshot,
    activeOccurrence.from,
    activeOccurrence.to,
    activeOccurrence.snippetText,
  ].join("::");
}

export function createEmptyTextTagPanelState(): TextTagPanelState {
  return {
    mode: "index",
    selection: createEmptyTextTagSelectionState(),
    activeOccurrence: null,
    occurrences: [],
    summary: createTextTagSummary([]),
  };
}

export function getTextTagSelectionState(editor: Editor | null): TextTagSelectionState {
  return analyzeTextTagSelection(editor);
}

export function getTextTagPanelState(editor: Editor | null): TextTagPanelState {
  if (!editor) {
    return createEmptyTextTagPanelState();
  }

  const selection = analyzeTextTagSelection(editor);
  const occurrences = extractLiveTextTagOccurrences(editor.state.doc);
  const activeOccurrence = findActiveOccurrence(editor, occurrences);
  const mode = selection.hasSelection
    ? "apply"
    : activeOccurrence
      ? "inspect"
      : "index";

  return {
    mode,
    selection,
    activeOccurrence,
    occurrences,
    summary: createTextTagSummary(occurrences),
  };
}

export function getTextTagPanelStateSignature(panelState: TextTagPanelState) {
  const occurrenceSignature = panelState.occurrences
    .map(
      (occurrence) =>
        `${occurrence.key}:${occurrence.colorSnapshot}:${occurrence.snippetText}:${occurrence.from}:${occurrence.to}`,
    )
    .join("|");

  return [
    panelState.mode,
    panelState.selection.hasSelection ? "1" : "0",
    panelState.selection.isTaggableSelection ? "1" : "0",
    panelState.selection.activeTagId ?? "",
    panelState.selection.activeColorSnapshot ?? "",
    panelState.selection.hasMixedOrInvalidSelection ? "1" : "0",
    panelState.activeOccurrence?.key ?? "",
    panelState.summary.totalCount,
    panelState.summary.distinctTagCount,
    panelState.summary.textCount,
    panelState.summary.formulaCount,
    occurrenceSignature,
  ].join("::");
}

function resolveTextTagOperationTarget(
  editor: Editor | null,
): TextTagOperationTarget | null {
  if (!editor) {
    return null;
  }

  const selectionState = getTextTagSelectionState(editor);

  if (!selectionState.isTaggableSelection || selectionState.hasMixedOrInvalidSelection) {
    return null;
  }

  const { from, to } = editor.state.selection;

  if (
    selectionState.activeTagId === null ||
    selectionState.activeColorSnapshot === null
  ) {
    return {
      from,
      to,
      activeTagId: null,
      activeColorSnapshot: null,
    };
  }

  const matchedOccurrence =
    extractLiveTextTagOccurrences(editor.state.doc).find(
      (occurrence) =>
        occurrence.tagId === selectionState.activeTagId &&
        occurrence.colorSnapshot === selectionState.activeColorSnapshot &&
        from >= occurrence.from &&
        to <= occurrence.to,
    ) ?? null;

  if (!matchedOccurrence) {
    return null;
  }

  return {
    from: matchedOccurrence.from,
    to: matchedOccurrence.to,
    activeTagId: matchedOccurrence.tagId,
    activeColorSnapshot: matchedOccurrence.colorSnapshot,
  };
}

function applyTextTagToRange(
  editor: Editor | null,
  from: number,
  to: number,
  tagId: number,
  colorSnapshot: string,
) {
  if (!editor) {
    return false;
  }

  const normalizedTagId = parseTagId(tagId);
  const normalizedColorSnapshot = parseColorSnapshot(colorSnapshot);
  const markType = editor.state.schema.marks[TEXT_TAG_MARK_NAME];

  if (
    !markType ||
    normalizedTagId === null ||
    normalizedColorSnapshot === null ||
    from >= to
  ) {
    return false;
  }

  return editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      tr.removeMark(from, to, markType);
      tr.addMark(
        from,
        to,
        markType.create({
          tagId: normalizedTagId,
          colorSnapshot: normalizedColorSnapshot,
        }),
      );
      dispatch?.(tr.scrollIntoView());
      return true;
    })
    .run();
}

function clearTextTagFromRange(editor: Editor | null, from: number, to: number) {
  if (!editor) {
    return false;
  }

  const markType = editor.state.schema.marks[TEXT_TAG_MARK_NAME];

  if (!markType || from >= to) {
    return false;
  }

  return editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      tr.removeMark(from, to, markType);
      dispatch?.(tr.scrollIntoView());
      return true;
    })
    .run();
}

export function applyTextTag(
  editor: Editor | null,
  tagId: number,
  colorSnapshot: string,
) {
  if (!editor) {
    return false;
  }

  const target = resolveTextTagOperationTarget(editor);

  if (!target) {
    return false;
  }

  return applyTextTagToRange(
    editor,
    target.from,
    target.to,
    tagId,
    colorSnapshot,
  );
}

export function clearTextTag(editor: Editor | null) {
  if (!editor) {
    return false;
  }

  const target = resolveTextTagOperationTarget(editor);

  if (!target || target.activeTagId === null) {
    return false;
  }

  return clearTextTagFromRange(editor, target.from, target.to);
}

export function applyTextTagToOccurrence(
  editor: Editor | null,
  occurrence: LiveTextTagOccurrence | null,
  tagId: number,
  colorSnapshot: string,
) {
  if (!occurrence) {
    return false;
  }

  return applyTextTagToRange(editor, occurrence.from, occurrence.to, tagId, colorSnapshot);
}

export function clearTextTagFromOccurrence(
  editor: Editor | null,
  occurrence: LiveTextTagOccurrence | null,
) {
  if (!occurrence) {
    return false;
  }

  return clearTextTagFromRange(editor, occurrence.from, occurrence.to);
}

export const TextTag = Mark.create({
  name: TEXT_TAG_MARK_NAME,
  inclusive: true,
  priority: 1100,

  addAttributes() {
    return {
      tagId: {
        default: null,
        parseHTML: (element) =>
          element instanceof HTMLElement
            ? parseTagId(element.getAttribute(TEXT_TAG_ID_ATTR))
            : null,
        renderHTML: (attributes) =>
          parseTagId(attributes.tagId) !== null
            ? { [TEXT_TAG_ID_ATTR]: String(attributes.tagId) }
            : {},
      },
      colorSnapshot: {
        default: null,
        parseHTML: (element) =>
          element instanceof HTMLElement
            ? parseColorSnapshot(element.getAttribute(TEXT_TAG_COLOR_ATTR))
            : null,
        renderHTML: (attributes) => {
          const nextColorSnapshot = parseColorSnapshot(attributes.colorSnapshot);

          if (nextColorSnapshot === null) {
            return {};
          }

          return {
            [TEXT_TAG_COLOR_ATTR]: nextColorSnapshot,
            style: `--note-tag-color: ${nextColorSnapshot};`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `span[${TEXT_TAG_SENTINEL_ATTR}="true"]`,
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }

          return parseTextTagAttributesFromElement(node);
        },
      },
    ];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const tagId = parseTagId(mark.attrs.tagId);
    const colorSnapshot = parseColorSnapshot(mark.attrs.colorSnapshot);

    if (tagId === null || colorSnapshot === null) {
      return ["span", {}, 0];
    }

    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        [TEXT_TAG_SENTINEL_ATTR]: "true",
        [TEXT_TAG_ID_ATTR]: String(tagId),
        [TEXT_TAG_COLOR_ATTR]: colorSnapshot,
        style: `--note-tag-color: ${colorSnapshot};`,
      }),
      0,
    ];
  },
});

export const BlockIdExtension = Extension.create({
  name: "noteBlockIds",

  addGlobalAttributes() {
    return [
      {
        types: [...SUPPORTED_BLOCK_TYPES],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              normalizeBlockId(element.getAttribute(BLOCK_ID_ATTR)),
            renderHTML: (attributes: Record<string, unknown>) => {
              const blockId = normalizeBlockId(attributes.blockId);
              return blockId ? { [BLOCK_ID_ATTR]: blockId } : {};
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(_transactions, _oldState, newState) {
          let transaction = newState.tr;
          let shouldDispatch = false;
          const seenBlockIds = new Set<string>();

          newState.doc.descendants((node, pos) => {
            if (!isSupportedBlockNode(node)) {
              return true;
            }

            const currentBlockId = normalizeBlockId(node.attrs.blockId);

            if (currentBlockId && !seenBlockIds.has(currentBlockId)) {
              seenBlockIds.add(currentBlockId);
              return true;
            }

            const nextBlockId = createBlockId();
            seenBlockIds.add(nextBlockId);
            transaction = transaction.setNodeMarkup(
              pos,
              undefined,
              {
                ...node.attrs,
                blockId: nextBlockId,
              },
              node.marks,
            );
            shouldDispatch = true;
            return true;
          });

          return shouldDispatch ? transaction : null;
        },
      }),
    ];
  },
});

const TextTagActivationExtension = Extension.create({
  name: "textTagActivation",

  addProseMirrorPlugins() {
    return [
      new Plugin<TextTagActivationState>({
        key: TEXT_TAG_ACTIVATION_PLUGIN_KEY,
        state: {
          init: () => ({
            occurrenceKey: null,
            pulseClassName: null,
          }),
          apply(tr, pluginState) {
            const meta = tr.getMeta(
              TEXT_TAG_ACTIVATION_PLUGIN_KEY,
            ) as TextTagActivationMeta | undefined;

            if (!meta) {
              return pluginState;
            }

            if (meta.type === "clear") {
              return {
                occurrenceKey: null,
                pulseClassName: null,
              };
            }

            return {
              occurrenceKey: meta.occurrenceKey,
              pulseClassName: meta.pulseClassName,
            };
          },
        },
        props: {
          decorations(state) {
            const pluginState = TEXT_TAG_ACTIVATION_PLUGIN_KEY.getState(state);

            if (!pluginState?.occurrenceKey) {
              return DecorationSet.empty;
            }

            const occurrence = findTextTagOccurrenceByKey(
              state.doc,
              pluginState.occurrenceKey,
            );

            if (!occurrence) {
              return DecorationSet.empty;
            }

            const className = [
              TEXT_TAG_ACTIVE_CLASS,
              pluginState.pulseClassName,
            ]
              .filter(Boolean)
              .join(" ");

            return DecorationSet.create(state.doc, [
              Decoration.inline(occurrence.from, occurrence.to, {
                class: className,
              }),
            ]);
          },
        },
      }),
    ];
  },
});

export function extractLiveTextTagOccurrences(
  documentContent: Editor["state"]["doc"],
): LiveTextTagOccurrence[] {
  const occurrences: LiveTextTagOccurrence[] = [];
  let sortOrder = 0;

  documentContent.descendants((node: ProseMirrorNode, position) => {
    if (!isSupportedBlockNode(node) || !node.isTextblock) {
      return true;
    }

    const blockId = normalizeBlockId(node.attrs.blockId);

    if (!blockId) {
      return true;
    }

    let textOffset = 0;
    let pendingOccurrence: PendingOccurrence | null = null;

    const flushPendingOccurrence = () => {
      if (!pendingOccurrence) {
        return;
      }

      const snippetText = normalizeOccurrenceSnippet(pendingOccurrence.snippetText);

      if (
        pendingOccurrence.startOffset < pendingOccurrence.endOffset &&
        snippetText !== "" &&
        pendingOccurrence.from >= 0 &&
        pendingOccurrence.to > pendingOccurrence.from
      ) {
        occurrences.push({
          key: buildOccurrenceKey(
            blockId,
            pendingOccurrence.startOffset,
            pendingOccurrence.endOffset,
            pendingOccurrence.tagId,
          ),
          tagId: pendingOccurrence.tagId,
          colorSnapshot: pendingOccurrence.colorSnapshot,
          blockId,
          startOffset: pendingOccurrence.startOffset,
          endOffset: pendingOccurrence.endOffset,
          nodeType: pendingOccurrence.nodeType,
          snippetText,
          sortOrder,
          from: pendingOccurrence.from,
          to: pendingOccurrence.to,
        });
        sortOrder += 1;
      }

      pendingOccurrence = null;
    };

    node.descendants((child, childPosition) => {
      const absolutePosition = position + 1 + childPosition;

      if (child.isText) {
        const textValue = child.text ?? "";

        if (!textValue) {
          return;
        }

        const attrs = getValidTextTagAttrsFromMark(child.marks);

        if (!attrs) {
          flushPendingOccurrence();
          textOffset += textValue.length;
          return;
        }

        if (
          pendingOccurrence &&
          pendingOccurrence.tagId === attrs.tagId &&
          pendingOccurrence.colorSnapshot === attrs.colorSnapshot &&
          pendingOccurrence.endOffset === textOffset &&
          pendingOccurrence.to === absolutePosition
        ) {
          pendingOccurrence.endOffset += textValue.length;
          pendingOccurrence.snippetText += textValue;
          pendingOccurrence.to = absolutePosition + textValue.length;
        } else {
          flushPendingOccurrence();
          pendingOccurrence = {
            tagId: attrs.tagId,
            colorSnapshot: attrs.colorSnapshot,
            startOffset: textOffset,
            endOffset: textOffset + textValue.length,
            nodeType: node.type.name,
            snippetText: textValue,
            from: absolutePosition,
            to: absolutePosition + textValue.length,
          };
        }

        textOffset += textValue.length;
        return;
      }

      if (child.type.name === "hardBreak") {
        flushPendingOccurrence();
        textOffset += 1;
        return;
      }

      if (child.isLeaf) {
        flushPendingOccurrence();
      }
    });

    flushPendingOccurrence();
    return true;
  });

  return occurrences;
}

export function findTextTagOccurrenceAtPosition(
  documentContent: Editor["state"]["doc"],
  position: number,
) {
  return (
    extractLiveTextTagOccurrences(documentContent).find(
      (occurrence) => position >= occurrence.from && position < occurrence.to,
    ) ?? null
  );
}

export function findTextTagOccurrenceByKey(
  documentContent: Editor["state"]["doc"],
  occurrenceKey: string,
) {
  return (
    extractLiveTextTagOccurrences(documentContent).find(
      (occurrence) => occurrence.key === occurrenceKey,
    ) ?? null
  );
}

export function setActiveTextTagOccurrence(
  editor: Editor | null,
  occurrenceKey: string,
  pulseVariant: "A" | "B" | null = null,
) {
  if (!editor) {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(TEXT_TAG_ACTIVATION_PLUGIN_KEY, {
      type: "set",
      occurrenceKey,
      pulseClassName:
        pulseVariant === "A"
          ? TEXT_TAG_PULSE_CLASS_A
          : pulseVariant === "B"
            ? TEXT_TAG_PULSE_CLASS_B
            : null,
    } satisfies TextTagActivationMeta),
  );
}

export function clearActiveTextTagOccurrence(editor: Editor | null) {
  if (!editor) {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(TEXT_TAG_ACTIVATION_PLUGIN_KEY, {
      type: "clear",
    } satisfies TextTagActivationMeta),
  );
}

export function extractTextTagOccurrences(
  documentContent: Editor["state"]["doc"],
): TextTagOccurrenceDraft[] {
  return extractLiveTextTagOccurrences(documentContent).map((occurrence) => ({
    tagId: occurrence.tagId,
    blockId: occurrence.blockId,
    startOffset: occurrence.startOffset,
    endOffset: occurrence.endOffset,
    nodeType: occurrence.nodeType,
    snippetText: occurrence.snippetText,
    sortOrder: occurrence.sortOrder,
  }));
}

export function createTextTagExtensions(): Extensions {
  return [BlockIdExtension, TextTag, TextTagActivationExtension];
}
