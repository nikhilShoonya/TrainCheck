/* Permanent training deletion: what the confirmation dialog lists, and when the typed code confirms it. Pure helpers
   only (no React, no API), so the unit tests can check them. The backend counts the records again under its lock,
   checks the typed code and the user's role, and deletes everything or nothing. Run: npm run test:unit */

/** GET /admin/trainings/{id}/deletion-preview → counts: what deleting the training removes right now. */
export interface DeletionCounts {
  assignments: number;
  completions: number;
  assessments: number;
  attempts: number;
  submitted_attempts: number;
  attempt_answers: number;
  violations: number;
  feedback: number;
  assessment_configs: number;
  batches: number;
  sessions: number;
  materials: number;
  behaviour_reviews: number;
  behaviour_questionnaires: number;
  question_links: number;
  /** Questions linked to this training only: they stay in the Question Bank, under Unassigned Questions. */
  questions_becoming_unassigned: number;
  question_imports: number;
  report_exports: number;
  report_schedules: number;
  notifications: number;
}

export interface DeletionPreview {
  training: { id: string; code: string; title: string; status: string };
  counts: DeletionCounts;
}

/** The records listed in the dialog, in this order, with their singular and plural names. Answers, violations,
    sessions and configuration versions are part of the attempts, batches and assessments shown. */
const LISTED: [keyof DeletionCounts, string, string][] = [
  ["assignments", "employee assignment", "employee assignments"],
  ["completions", "training completion record", "training completion records"],
  ["assessments", "assessment (pre-test, post-test or re-training cycle)", "assessments (pre-tests, post-tests and re-training cycles)"],
  ["attempts", "assessment attempt with its answers and score", "assessment attempts with their answers and scores"],
  ["feedback", "feedback response", "feedback responses"],
  ["batches", "batch", "batches"],
  ["materials", "training material link", "training material links"],
  ["behaviour_reviews", "behaviour follow-up", "behaviour follow-ups"],
  ["question_links", "link to Question Bank questions", "links to Question Bank questions"],
  ["question_imports", "question import record", "question import records"],
  ["report_exports", "report export filtered to this training", "report exports filtered to this training"],
  ["report_schedules", "scheduled report filtered to this training", "scheduled reports filtered to this training"],
  ["notifications", "notification about this training", "notifications about this training"],
];

/** "3 employee assignments", … for every listed record type the training has. Empty for an unused training. */
export function deletionLines(counts: DeletionCounts): string[] {
  return LISTED.filter(([key]) => (counts[key] ?? 0) > 0).map(([key, one, many]) => `${counts[key]} ${counts[key] === 1 ? one : many}`);
}

/** What stays, including how many questions move to Unassigned Questions. */
export function keptSentence(counts: DeletionCounts): string {
  const moved = counts.questions_becoming_unassigned ?? 0;
  const questions =
    moved > 0
      ? ` ${moved} ${moved === 1 ? "question is" : "questions are"} linked only to this training and will be listed under Unassigned Questions.`
      : "";
  return `Employees and their accounts, departments, functions, locations and competencies, other trainings, and every Question Bank question with its options, correct answers and versions are kept.${questions}`;
}

/** Whether the typed text confirms the deletion: the training code, ignoring surrounding spaces and letter case. */
export function codeMatches(typed: string, code: string): boolean {
  const clean = typed.trim();
  return clean.length > 0 && clean.toUpperCase() === code.trim().toUpperCase();
}

export const ALREADY_DELETED = "This training was already deleted. The list has been refreshed.";
