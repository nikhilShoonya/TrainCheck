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
  /** A question preview validated with the old template (file-supplied ID, type and status): it must be validated again. */
  needs_revalidation?: boolean;
}

/** The test type an import was validated for, as shown in previews and history. */
export function testTypeLabel(job: JobSelection): string {
  if (job.import_type !== "QUESTIONS") return "—";
  return job.test_type ? (TEST_TYPE_LABEL[job.test_type] ?? job.test_type) : "Not recorded";
}

/** A question preview made before test types existed (or whose training was deleted), or validated with the old
 *  question template, cannot be imported as it is: it must be edited and validated again. */
export function needsRevalidation(job: JobSelection): boolean {
  return job.import_type === "QUESTIONS" && (!job.test_type || !job.training || Boolean(job.needs_revalidation));
}

/** What the page shows while confirming. The server imports with the selection saved at validation and only
 *  compares these values with it, refusing a confirmation made from a form that changed since. */
export function commitSelection(job: JobSelection, form: Pick<ImportSelection, "trainingId" | "testType">): { training_id: string; test_type: string } | undefined {
  if (job.import_type !== "QUESTIONS") return undefined;
  return { training_id: form.trainingId, test_type: form.testType };
}

/** Template download path. Templates name no training: it is chosen on the import screen. */
export function templatePath(kind: string, format: "csv" | "xlsx" | "pdf"): string {
  return `/admin/imports/templates/${kind}${format === "csv" ? "" : `?format=${format}`}`;
}

/** Row outcomes reported by the server for a preview (VALID) or a finished import (IMPORTED). */
export interface ImportCounts {
  VALID?: number;
  IMPORTED?: number;
  DUPLICATE?: number;
  CONFLICT?: number;
  INVALID?: number;
}

interface SummaryJob {
  import_type: string;
  status: string;
  file_name: string;
  accepted_rows: number;
  rejected_rows: number;
  counts?: ImportCounts;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Each skipped outcome, counted separately: duplicates, conflicts (questions only) and rows with errors. */
function skippedParts(job: SummaryJob): string[] {
  const c = job.counts ?? {};
  const parts = [`${count(c.DUPLICATE ?? 0, "duplicate")} skipped`];
  if (job.import_type === "QUESTIONS") parts.push(`${count(c.CONFLICT ?? 0, "conflict")} skipped for review`);
  parts.push(`${count(c.INVALID ?? 0, "row")} with errors`);
  return parts;
}

/** What validation found and what confirming will import, or what a finished import did. */
export function importSummary(job: SummaryJob): string {
  if (!job.counts) {
    // An entry listed without its rows: only the totals are known.
    return job.status === "READY"
      ? `${job.file_name} validated. ${job.accepted_rows} valid, ${job.rejected_rows} rejected or skipped. Nothing has been imported yet.`
      : `Import finished. ${count(job.accepted_rows, "row")} imported, ${count(job.rejected_rows, "row")} rejected or skipped.`;
  }
  const skipped = skippedParts(job).join(", ");
  if (job.status === "READY") return `${job.file_name} validated. ${count(job.counts.VALID ?? 0, "row")} will be imported; ${skipped}. Nothing has been imported yet.`;
  return `Import finished. ${count(job.counts.IMPORTED ?? 0, "row")} imported; ${skipped}.`;
}
