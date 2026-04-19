export interface NoteReviewSchedule {
  noteId: number;
  dates: string[];
  updatedAt: string | null;
  activatedAt: string | null;
}

export interface TodayReviewTaskItem {
  noteId: number;
  notebookId: number;
  folderId: number | null;
  title: string;
  notebookName: string;
  folderPath: string;
  dueDate: string;
}
