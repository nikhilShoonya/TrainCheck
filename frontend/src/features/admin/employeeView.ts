/* Employee Assignments > Add Employee: the department choices, the bulk preview's wording and when it can be
   confirmed, and who may change their own password. Pure functions, so they are unit-tested
   (tests/unit/employeeView.test.mjs). The backend re-checks every rule and generates every password; nothing here
   can create an employee or see a password. */

export type AddEmployeeMode = "single" | "bulk";

export const EMPLOYEE_FILE_TYPES = ".csv,.xlsx";
export const EMPLOYEE_COLUMNS = ["name", "employee id", "email", "joiningdate", "department"];
export const PASSWORD_RULE = "Each new employee signs in with their work email. Their password is Fin@ followed by their joining date as DDMMYYYY (for 19 Nov 2026: Fin@19112026). Employees cannot change it.";

export interface RowProblem {
  field: string;
  message: string;
}

export interface EmployeePreviewRow {
  row: number;
  name: string;
  employee_code: string;
  email: string;
  joining_date: string | null;
  joining_date_text: string;
  department: { id: string; code: string; name: string } | null;
  department_text: string;
  status: "VALID" | "INVALID";
  errors: RowProblem[];
}

export interface EmployeePreview {
  file_name: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  ready: boolean;
  rows: EmployeePreviewRow[];
}

export interface EmployeeImportResult {
  file_name: string;
  created: number;
  employees: { id: string; employee_code: string; full_name: string }[];
}

/** Only active departments can receive new employees; listed by name. */
export function activeDepartments<T extends { name: string; is_active: boolean }>(departments: T[] | null | undefined): T[] {
  return (departments ?? []).filter((d) => d.is_active).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export const plural = (count: number, word: string) => `${count.toLocaleString("en-IN")} ${word}${count === 1 ? "" : "s"}`;

/** The one line above the preview table. */
export function previewSummary(preview: EmployeePreview): string {
  if (preview.ready) return `${preview.file_name}: all ${plural(preview.total_rows, "row")} passed validation. Nothing has been saved yet.`;
  return `${preview.file_name}: ${plural(preview.invalid_rows, "row")} of ${preview.total_rows.toLocaleString("en-IN")} need correcting. Nothing has been saved. Fix the file and validate it again.`;
}

/** Why Confirm Import is unavailable, or null when the whole file can be imported. */
export function confirmBlockedReason(preview: EmployeePreview | null, fileChanged: boolean): string | null {
  if (!preview) return "Validate a file first.";
  if (fileChanged) return "The file changed after validation. Validate it again.";
  if (!preview.ready) return "Every row must pass validation before the file can be imported. Nothing is imported partly.";
  return null;
}

/** A row's problems as one readable line. */
export function rowProblems(row: EmployeePreviewRow): string {
  return row.errors.map((e) => `${e.field}: ${e.message}`).join(" ") || "—";
}

/** The joining date as the preview shows it: the date read, or what the file held when it could not be read. */
export function joiningShown(row: EmployeePreviewRow): string {
  return row.joining_date ?? (row.joining_date_text || "—");
}

/** The department as the preview shows it: the department matched, or what the file held. */
export function departmentShown(row: EmployeePreviewRow): string {
  return row.department ? `${row.department.name} (${row.department.code})` : row.department_text || "—";
}

export function createdMessage(count: number): string {
  return `${plural(count, "employee")} added. ${count === 1 ? "They are" : "They are all"} now available in Assign Employees.`;
}

/** Self-service password changes: L&D Admin accounts only. The backend refuses everyone else. */
export function canChangeOwnPassword(roles: readonly string[] | null | undefined): boolean {
  return (roles ?? []).includes("LD_ADMIN");
}
