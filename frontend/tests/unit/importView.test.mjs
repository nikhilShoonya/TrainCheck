/* Import Centre: field order, required training and test type, preview invalidation and the labels shown in
   previews and history. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedFiles, commitSelection, fileTypesLabel, importFields, importSummary, needsRevalidation, selectionChanged, selectionProblem, templatePath, TEST_TYPE_HELP, TEST_TYPE_OPTIONS, testTypeLabel } from "@/features/admin/importView";
import { exclusionNotes } from "@/lib/pool";

const TRAINING = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const OTHER = "9b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";

test("question imports show Import type, Select training and Test type, in that order", () => {
  assert.deepEqual(importFields("QUESTIONS"), ["import_type", "training_id", "test_type"]);
});

test("completion imports keep their workflow: no training or test type to choose", () => {
  assert.deepEqual(importFields("COMPLETIONS"), ["import_type"]);
  assert.equal(selectionProblem({ kind: "COMPLETIONS", trainingId: "", testType: "" }), null);
  assert.equal(commitSelection({ import_type: "COMPLETIONS" }, { trainingId: "", testType: "" }), undefined);
  assert.equal(testTypeLabel({ import_type: "COMPLETIONS", test_type: null }), "—");
});

test("the test type offers exactly Pre-test and Post-test, with no default", () => {
  assert.deepEqual(TEST_TYPE_OPTIONS, [
    { value: "PRE_TEST", label: "Pre-test" },
    { value: "POST_TEST", label: "Post-test" },
  ]);
  assert.equal(TEST_TYPE_HELP, "These questions will be linked to the selected training and used only for the selected test type.");
});

test("a question file cannot be validated until the training and the test type are chosen", () => {
  assert.match(selectionProblem({ kind: "QUESTIONS", trainingId: "", testType: "PRE_TEST" }), /Select the training/);
  assert.match(selectionProblem({ kind: "QUESTIONS", trainingId: TRAINING, testType: "" }), /test type/);
  assert.equal(selectionProblem({ kind: "QUESTIONS", trainingId: TRAINING, testType: "POST_TEST" }), null);
});

test("changing the file, training or test type invalidates the validated preview", () => {
  const file = { name: "questions.csv" };
  const sent = { kind: "QUESTIONS", trainingId: TRAINING, testType: "PRE_TEST", file };
  assert.equal(selectionChanged(sent, { ...sent }), false);
  assert.equal(selectionChanged(sent, { ...sent, testType: "POST_TEST" }), true);
  assert.equal(selectionChanged(sent, { ...sent, trainingId: OTHER }), true);
  assert.equal(selectionChanged(sent, { ...sent, file: { name: "questions.csv" } }), true); // Another file, even with the same name.
  assert.equal(selectionChanged(sent, { ...sent, file: null }), true);
  assert.equal(selectionChanged(sent, { ...sent, kind: "COMPLETIONS" }), true);
  // Completion imports are invalidated by the type or file only.
  const completion = { kind: "COMPLETIONS", trainingId: "", testType: "", file };
  assert.equal(selectionChanged(completion, { ...completion, testType: "PRE_TEST" }), false);
});

test("the stored test type is what previews and history show", () => {
  assert.equal(testTypeLabel({ import_type: "QUESTIONS", test_type: "PRE_TEST" }), "Pre-test");
  assert.equal(testTypeLabel({ import_type: "QUESTIONS", test_type: "POST_TEST" }), "Post-test");
  assert.equal(testTypeLabel({ import_type: "QUESTIONS", test_type: null }), "Not recorded"); // Imported before test types.
});

test("a legacy question preview must be validated again before it can be imported", () => {
  assert.equal(needsRevalidation({ import_type: "QUESTIONS", training: { id: TRAINING }, test_type: null }), true);
  assert.equal(needsRevalidation({ import_type: "QUESTIONS", training: null, test_type: "PRE_TEST" }), true);
  assert.equal(needsRevalidation({ import_type: "QUESTIONS", training: { id: TRAINING }, test_type: "PRE_TEST" }), false);
  assert.equal(needsRevalidation({ import_type: "COMPLETIONS", training: null, test_type: null }), false);
});

test("confirming sends what the form shows, so the server can refuse a form changed after validation", () => {
  const job = { import_type: "QUESTIONS", training: { id: TRAINING }, test_type: "PRE_TEST" };
  assert.deepEqual(commitSelection(job, { trainingId: TRAINING, testType: "PRE_TEST" }), { training_id: TRAINING, test_type: "PRE_TEST" });
  assert.deepEqual(commitSelection(job, { trainingId: OTHER, testType: "POST_TEST" }), { training_id: OTHER, test_type: "POST_TEST" });
});

test("the pool explains questions kept for the other test", () => {
  const report = { assessment_type: "POST_TEST", inactive: 0, missing_answer_key: 0, missing_answer_key_codes: [], insufficient_options: 0, insufficient_options_codes: [], other_test_type: 20 };
  assert.deepEqual(exclusionNotes(report), ["20 questions imported for the pre-test only"]);
  assert.deepEqual(exclusionNotes({ ...report, assessment_type: "PRE_TEST", other_test_type: 1 }), ["1 question imported for the post-test only"]);
  assert.deepEqual(exclusionNotes({ ...report, other_test_type: 0 }), []);
});

test("question imports also accept PDF; completion imports stay CSV and Excel", () => {
  assert.equal(acceptedFiles("QUESTIONS"), ".csv,.xlsx,.pdf");
  assert.equal(fileTypesLabel("QUESTIONS"), "CSV, Excel or PDF");
  assert.equal(acceptedFiles("COMPLETIONS"), ".csv,.xlsx");
  assert.equal(fileTypesLabel("COMPLETIONS"), "CSV or Excel");
});

test("a question preview validated with the old template must be validated again", () => {
  const job = { import_type: "QUESTIONS", training: { id: TRAINING }, test_type: "PRE_TEST" };
  assert.equal(needsRevalidation({ ...job, needs_revalidation: true }), true);
  assert.equal(needsRevalidation({ ...job, needs_revalidation: false }), false);
});

test("templates name no training: it is chosen on the import screen", () => {
  assert.equal(templatePath("QUESTIONS", "csv"), "/admin/imports/templates/QUESTIONS");
  assert.equal(templatePath("QUESTIONS", "pdf"), "/admin/imports/templates/QUESTIONS?format=pdf");
  assert.equal(templatePath("COMPLETIONS", "xlsx"), "/admin/imports/templates/COMPLETIONS?format=xlsx");
});

test("the summary counts imported, duplicate, conflict and error rows separately", () => {
  const base = { import_type: "QUESTIONS", file_name: "q.csv", accepted_rows: 3, rejected_rows: 4 };
  assert.equal(
    importSummary({ ...base, status: "READY", counts: { VALID: 3, IMPORTED: 0, DUPLICATE: 2, CONFLICT: 1, INVALID: 1 } }),
    "q.csv validated. 3 rows will be imported; 2 duplicates skipped, 1 conflict skipped for review, 1 row with errors. Nothing has been imported yet.",
  );
  assert.equal(
    importSummary({ ...base, status: "COMPLETED_WITH_ERRORS", counts: { VALID: 0, IMPORTED: 1, DUPLICATE: 0, CONFLICT: 0, INVALID: 0 } }),
    "Import finished. 1 row imported; 0 duplicates skipped, 0 conflicts skipped for review, 0 rows with errors.",
  );
  // Completion imports have no conflicts to report.
  assert.equal(
    importSummary({ ...base, import_type: "COMPLETIONS", status: "READY", counts: { VALID: 2, DUPLICATE: 1, INVALID: 0 } }),
    "q.csv validated. 2 rows will be imported; 1 duplicate skipped, 0 rows with errors. Nothing has been imported yet.",
  );
  // An entry listed without its rows: only the totals are known.
  assert.equal(importSummary({ ...base, status: "COMPLETED" }), "Import finished. 3 rows imported, 4 rows rejected or skipped.");
});
