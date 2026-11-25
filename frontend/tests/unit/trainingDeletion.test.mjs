/* Permanent training deletion: what the confirmation lists, what it says stays, and when the typed code confirms.
   Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeMatches, deletionLines, keptSentence } from "@/features/admin/trainingDeletionView";

const ZERO = {
  assignments: 0, completions: 0, assessments: 0, attempts: 0, submitted_attempts: 0, attempt_answers: 0, violations: 0, feedback: 0,
  assessment_configs: 0, batches: 0, sessions: 0, materials: 0, behaviour_reviews: 0, behaviour_questionnaires: 0, question_links: 0,
  questions_becoming_unassigned: 0, question_imports: 0, report_exports: 0, report_schedules: 0, notifications: 0,
};

test("an unused training lists no records", () => {
  assert.deepEqual(deletionLines(ZERO), []);
});

test("only the record types the training has are listed, with real counts and singular forms", () => {
  const lines = deletionLines({ ...ZERO, assignments: 3, completions: 1, attempts: 4, feedback: 2, question_links: 11, report_exports: 1, attempt_answers: 40 });
  assert.deepEqual(lines, [
    "3 employee assignments",
    "1 training completion record",
    "4 assessment attempts with their answers and scores",
    "2 feedback responses",
    "11 links to Question Bank questions",
    "1 report export filtered to this training",
  ]);
  // Answers are part of the attempts line, never listed separately.
  assert.ok(!lines.some((line) => line.includes("40")));
});

test("the kept sentence names employees, departments and questions, and how many become unassigned", () => {
  const none = keptSentence(ZERO);
  assert.match(none, /Employees/);
  assert.match(none, /departments/);
  assert.match(none, /every Question Bank question/);
  assert.doesNotMatch(none, /Unassigned Questions/);
  assert.match(keptSentence({ ...ZERO, questions_becoming_unassigned: 1 }), /1 question is linked only to this training and will be listed under Unassigned Questions/);
  assert.match(keptSentence({ ...ZERO, questions_becoming_unassigned: 10 }), /10 questions are linked only/);
});

test("the typed training code confirms, ignoring spaces and letter case; anything else does not", () => {
  assert.equal(codeMatches("TRN-01", "TRN-01"), true);
  assert.equal(codeMatches("  trn-01 ", "TRN-01"), true);
  for (const typed of ["", "   ", "TRN-0", "TRN-011", "Training 1", "TRN 01"]) assert.equal(codeMatches(typed, "TRN-01"), false, typed);
});
