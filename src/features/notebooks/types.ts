export interface Notebook {
  id: number;
  name: string;
  coverImagePath: string | null;
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

export interface NoteSearchResult {
  noteId: number;
  notebookId: number;
  folderId: number | null;
  title: string;
  notebookName: string;
  folderName: string | null;
  excerpt: string;
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
