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
