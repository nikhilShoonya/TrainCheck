/* Import Centre: which fields the form shows and in what order, what must be chosen before validating, and when a
   validated preview no longer matches the form. Pure functions, so they are unit-tested (tests/unit/importView.test.mjs).
   The backend re-checks every rule; nothing here can import a row. */

export type ImportField = "import_type" | "training_id" | "test_type";
export type TestType = "PRE_TEST" | "POST_TEST";

export const TEST_TYPE_OPTIONS: { value: TestType; label: string }[] = [
  { value: "PRE_TEST", label: "Pre-test" },
  { value: "POST_TEST", label: "Post-test" },
];
export const TEST_TYPE_LABEL: Record<string, string> = { PRE_TEST: "Pre-test", POST_TEST: "Post-test" };
export const TEST_TYPE_HELP = "These questions will be linked to the selected training and used only for the selected test type.";

/** The form's fields in display order. Desktop shows them side by side and mobile stacks them, in this same order.
 *  Completion files name the training on each row, so they have no training or test type to choose. */
export function importFields(kind: string): ImportField[] {
  return kind === "QUESTIONS" ? ["import_type", "training_id", "test_type"] : ["import_type"];
}

/** The file types each import accepts. Question imports also take a PDF in the TrainCheck labelled-block layout. */
export function acceptedFiles(kind: string): string {
  return kind === "QUESTIONS" ? ".csv,.xlsx,.pdf" : ".csv,.xlsx";
}

/** How the accepted file types are named to the person choosing a file. */
export function fileTypesLabel(kind: string): string {
  return kind === "QUESTIONS" ? "CSV, Excel or PDF" : "CSV or Excel";
}

/** What the form holds now. `file` is the chosen File object (or its name), compared by identity. */
export interface ImportSelection {
  kind: string;
  trainingId: string;
  testType: string;
  file: unknown;
}

/** Why the file cannot be validated yet, or null. Nothing is defaulted: the training and test type are always chosen. */
export function selectionProblem(selection: Pick<ImportSelection, "kind" | "trainingId" | "testType">): string | null {
  if (selection.kind !== "QUESTIONS") return null;
  if (!selection.trainingId) return "Select the training these questions belong to.";
  if (!selection.testType) return "Select the test type: Pre-test or Post-test.";
  return null;
}

/** Whether a preview validated for `before` is stale for `after`: any change to the type, file, training or test type. */
export function selectionChanged(before: ImportSelection, after: ImportSelection): boolean {
  if (before.kind !== after.kind || before.file !== after.file) return true;
  if (before.kind !== "QUESTIONS") return false;
  return before.trainingId !== after.trainingId || before.testType !== after.testType;
}

interface JobSelection {
  import_type: string;
  training?: { id: string } | null;
  test_type?: string | null;
}

/** The test type an import was validated for, as shown in previews and history. */
export function testTypeLabel(job: JobSelection): string {
  if (job.import_type !== "QUESTIONS") return "—";
  return job.test_type ? (TEST_TYPE_LABEL[job.test_type] ?? job.test_type) : "Not recorded";
}

/** A question preview made before test types existed (or whose training was deleted) cannot be imported as it is:
 *  it must be edited and validated again with a training and test type. */
export function needsRevalidation(job: JobSelection): boolean {
  return job.import_type === "QUESTIONS" && (!job.test_type || !job.training);
}

/** What the page shows while confirming. The server imports with the selection saved at validation and only
 *  compares these values with it, refusing a confirmation made from a form that changed since. */
export function commitSelection(job: JobSelection, form: Pick<ImportSelection, "trainingId" | "testType">): { training_id: string; test_type: string } | undefined {
  if (job.import_type !== "QUESTIONS") return undefined;
  return { training_id: form.trainingId, test_type: form.testType };
}
