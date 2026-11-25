/* Question Bank by training and test: the Training + Test cards and the links between the cards, one training's
   pre-test or post-test question table and the Import Centre. Pure helpers only (no React, no API), so the unit
   tests can check them. Run: npm run test:unit */

import type { TestType } from "@/features/admin/importView";

export const QUESTIONS_HOME = "/lnd/questions";

/** One card: a training and one of its tests (GET /admin/questions/summary). */
export interface QuestionCard {
  training_id: string;
  title: string;
  code: string;
  status: string;
  test_type: TestType;
  /** Exactly the rows of that card's table with no other filter: Active and Inactive, legacy links included. */
  question_count: number;
  active: number;
  inactive: number;
  /** Unclassified legacy links, which also count for the training's other test. */
  unclassified: number;
}

/** URL segment for each test type, and back. */
const SLUG: Record<TestType, string> = { PRE_TEST: "pre-test", POST_TEST: "post-test" };

export const testSlug = (testType: TestType): string => SLUG[testType];

/** The test type a URL segment names, or null for anything else (shown as not found). */
export function testTypeFromSlug(slug: string | undefined | null): TestType | null {
  const clean = (slug ?? "").toLowerCase();
  return clean === "pre-test" ? "PRE_TEST" : clean === "post-test" ? "POST_TEST" : null;
}

const withSearch = (path: string, cardSearch: string) => {
  const q = cardSearch.trim();
  return q ? `${path}?${new URLSearchParams({ q })}` : path;
};

/** The cards page, keeping the training search so Back to Trainings restores it. */
export const questionCardsHref = (cardSearch = ""): string => withSearch(QUESTIONS_HOME, cardSearch);

/** One training's pre-test or post-test questions. The card search travels along for the way back. */
export const questionTableHref = (trainingId: string, testType: TestType, cardSearch = ""): string =>
  withSearch(`${QUESTIONS_HOME}/${encodeURIComponent(trainingId)}/${SLUG[testType]}`, cardSearch);

/** The Import Centre with this training and test already chosen for a question import. */
export const importQuestionsHref = (trainingId: string, testType: TestType): string =>
  `/lnd/imports?${new URLSearchParams({ type: "QUESTIONS", training_id: trainingId, test_type: testType })}`;

/** The question table for a training's test, or (test type unknown, e.g. an import made before test types existed)
    the cards searched to that training's name. */
export function questionBankHref(training: { id: string; title?: string | null }, testType: string | null | undefined): string {
  return testType === "PRE_TEST" || testType === "POST_TEST" ? questionTableHref(training.id, testType) : questionCardsHref(training.title ?? "");
}

/** The test type an Import Centre link pre-selects, if it names a known one. */
export const linkedTestType = (value: string | null | undefined): TestType | "" => (value === "PRE_TEST" || value === "POST_TEST" ? value : "");

/** What the Add Question form sends so a question added from a training's test is linked for that test only. */
export function contextTestTypes(context: { trainingId: string; testType: TestType } | null | undefined, selectedTrainingIds: string[]): Record<string, TestType> {
  return context && selectedTrainingIds.includes(context.trainingId) ? { [context.trainingId]: context.testType } : {};
}

/* ---------- Unassigned Questions ---------- */

/** Questions linked to no training (GET /admin/questions/unassigned-summary). A link to an archived training counts. */
export interface UnassignedSummary {
  question_count: number;
  active: number;
  inactive: number;
}

const UNASSIGNED_TITLE = "Unassigned Questions";

/** The Unassigned Questions table: its own page, so refresh, direct links and Back keep it. */
export const unassignedHref = (cardSearch = ""): string => withSearch(`${QUESTIONS_HOME}/unassigned`, cardSearch);

/** The card is shown while at least one question has no training, unless the card search names something else. */
export function showUnassignedCard(summary: UnassignedSummary | null | undefined, cardSearch: string): boolean {
  // Anything but a positive count (no answer yet, an older or malformed response) shows no card.
  if (!summary || !(typeof summary.question_count === "number" && summary.question_count > 0)) return false;
  const needle = cardSearch.trim().toLowerCase();
  return !needle || UNASSIGNED_TITLE.toLowerCase().includes(needle);
}

/** One question's outcome from POST /admin/questions/assign. */
export type AssignStatus = "ASSIGNED" | "ALREADY_ASSIGNED" | "OTHER_TEST" | "NOT_FOUND";

export interface AssignResultRow {
  question_id: string;
  question_code: string | null;
  status: AssignStatus;
  /** The test type of this training's link after the request: PRE_TEST, POST_TEST, or null (legacy: both tests). */
  test_type: TestType | null;
  /** Why the question will still not be drawn (Inactive, no correct answer, too few options). */
  warning: string | null;
  message: string;
}

export interface AssignResult {
  training: { id: string; title: string; code: string };
  test_type: TestType;
  summary: Record<AssignStatus | "NOT_DRAWN", number>;
  results: AssignResultRow[];
}

/** Labels and badge tones for each outcome. */
export const QUESTION_ASSIGN_STATUS: Record<AssignStatus, [string, string]> = {
  ASSIGNED: ["Assigned", "success"],
  ALREADY_ASSIGNED: ["Already assigned", "info"],
  OTHER_TEST: ["Linked to the other test · not assigned", "warning"],
  NOT_FOUND: ["Not found", "danger"],
};

/** The questions that now serve the chosen test (newly or already). They leave the Unassigned list. */
const SERVES: AssignStatus[] = ["ASSIGNED", "ALREADY_ASSIGNED"];

/** The selection to keep after an assignment: everything that did not end up serving the chosen test, so it can be
    reviewed or retried. Questions that succeeded are dropped, so a retry never repeats them. */
export function remainingSelection(selected: ReadonlySet<string>, result: AssignResult): Set<string> {
  const done = new Set(result.results.filter((r) => SERVES.includes(r.status)).map((r) => r.question_id));
  return new Set([...selected].filter((id) => !done.has(id)));
}

/** One sentence for the toast and the dialog: what happened, counted per outcome. */
export function assignSummaryText(result: AssignResult, testLabel: string): string {
  const s = result.summary;
  const parts = [`${s.ASSIGNED} assigned to ${result.training.title} · ${testLabel}`];
  if (s.ALREADY_ASSIGNED) parts.push(`${s.ALREADY_ASSIGNED} already assigned`);
  if (s.OTHER_TEST) parts.push(`${s.OTHER_TEST} kept on the other test`);
  if (s.NOT_FOUND) parts.push(`${s.NOT_FOUND} not found`);
  if (s.NOT_DRAWN) parts.push(`${s.NOT_DRAWN} will not be drawn until fixed or activated`);
  return `${parts.join(", ")}.`;
}

/** Trainings that can receive questions: the Import Centre's rule (draft or active), by title. */
export function assignableTrainings<T extends { status: string; title: string }>(trainings: T[]): T[] {
  return trainings.filter((t) => t.status === "DRAFT" || t.status === "ACTIVE").sort((a, b) => a.title.localeCompare(b.title));
}
