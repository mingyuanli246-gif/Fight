export interface Notebook {
  id: number;
  name: string;
  coverImagePath: string | null;
  customSortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: number;
  notebookId: number;
  parentFolderId: number | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: number;
  notebookId: number;
  folderId: number | null;
  sortOrder: number;
  title: string;
  // 第四阶段起，该字段会继续沿用现有 schema，但实际允许存储富文本 HTML。
  // 这是已知命名债：字段名仍叫 contentPlaintext，本阶段不做 schema 变更。
  contentPlaintext: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface TagWithCount extends Tag {
  noteCount: number;
}

export interface NoteTag {
  noteId: number;
  tagId: number;
  createdAt: string;
}

export interface TextTagOccurrenceDraft {
  tagId: number;
  blockId: string;
  startOffset: number;
  endOffset: number;
  nodeType: string;
  snippetText: string;
  sortOrder: number;
}

export interface TextTagSelectionState {
  hasSelection: boolean;
  isTaggableSelection: boolean;
  activeTagId: number | null;
  activeColorSnapshot: string | null;
  hasMixedOrInvalidSelection: boolean;
}

export interface LiveTextTagOccurrence {
  key: string;
  tagId: number;
  colorSnapshot: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  nodeType: string;
  snippetText: string;
  sortOrder: number;
  from: number;
  to: number;
}

export interface TextTagSummary {
  totalCount: number;
  distinctTagCount: number;
  textCount: number;
  formulaCount: number;
}

export type TextTagPanelMode = "apply" | "inspect" | "index";

export interface TextTagPanelState {
  mode: TextTagPanelMode;
  selection: TextTagSelectionState;
  activeOccurrence: LiveTextTagOccurrence | null;
  occurrences: LiveTextTagOccurrence[];
  summary: TextTagSummary;
}

export interface NoteSearchResult {
  noteId: number;
  notebookId: number;
  folderId: number | null;
  title: string;
  notebookName: string;
  folderName: string | null;
  excerpt: string;
  highlightExcerpt?: string;
  updatedAt: string;
}

export interface TaggedNoteResult {
  noteId: number;
  notebookId: number;
  folderId: number | null;
  title: string;
  notebookName: string;
  folderName: string | null;
  updatedAt: string;
}

export interface NoteOpenRequest {
  requestId: number;
  noteId: number;
  notebookId: number;
  highlightQuery?: string;
  highlightExcerpt?: string;
  source?: "global-search" | "external-open" | "review-tasks";
}

export type NoteOpenTarget = Omit<NoteOpenRequest, "requestId">;

export type NotebookShellMode = "home" | "detail";

export type NotebookHomeSort =
  | "updated-desc"
  | "created-desc"
  | "custom"
  | "name-asc"
  | "name-desc";

export interface NotebookHighlightRequest {
  requestId: number;
  query?: string;
  excerpt?: string;
  source?: NoteOpenRequest["source"];
}

export type NoteSaveStatus =
  | "unchanged"
  | "dirty"
  | "saving"
  | "saved"
  | "error";

export type SelectedEntity =
  | { kind: "notebook"; id: number }
  | { kind: "folder"; id: number }
  | { kind: "note"; id: number };
