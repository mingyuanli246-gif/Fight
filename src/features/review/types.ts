export interface ReviewPlan {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewPlanStep {
  id: number;
  planId: number;
  stepIndex: number;
  offsetDays: number;
}

export interface ReviewPlanWithSteps extends ReviewPlan {
  steps: ReviewPlanStep[];
}

export interface NoteReviewBinding {
  noteId: number;
  planId: number;
  startDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteReviewBindingDetail {
  binding: NoteReviewBinding;
  plan: ReviewPlanWithSteps;
}

export interface ReviewTask {
  id: number;
  noteId: number;
  planId: number;
  dueDate: string;
  stepIndex: number;
  isCompleted: boolean;
  completedAt: string | null;
  createdAt: string;
}

export interface ReviewCalendarTaskItem extends ReviewTask {
  notebookId: number;
  folderId: number | null;
  title: string;
  notebookName: string;
  folderName: string | null;
  planName: string;
}
