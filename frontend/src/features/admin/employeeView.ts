/* Employee Assignments > Add Employee: the department choices, the bulk preview's wording and when it can be
   confirmed, and who may change their own password. Pure functions, so they are unit-tested
   (tests/unit/employeeView.test.mjs). The backend re-checks every rule and generates every password; nothing here
   can create an employee or see a password. */

export type AddEmployeeMode = "single" | "bulk";

export const EMPLOYEE_FILE_TYPES = ".csv,.xlsx";
/** The file's column headings, as in Finvasia's HR export (the server also accepts the earlier template's names). */
export const EMPLOYEE_COLUMNS = ["Employee Number", "Full Name", "Email", "Date of Joining", "Department"];
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

/** Self-service password changes, as the server reports them (L&D Admins always; employees only when
 *  EMPLOYEE_PASSWORD_CHANGE_ENABLED=true). Without that report, L&D Admins only. The backend enforces it either way. */
export function canChangeOwnPassword(user: { roles?: readonly string[] | null; features?: { password_change?: boolean } } | null | undefined): boolean {
  const reported = user?.features?.password_change;
  return typeof reported === "boolean" ? reported : (user?.roles ?? []).includes("LD_ADMIN");
}

/* ---------- Employee Assignments: the employee list and the selected employee ---------- */

/** One employee record from GET /admin/employees (employee fields only; never account or password data). */
export interface EmployeeListItem {
  id: string;
  employee_code: string;
  full_name: string;
  work_email: string;
  department: string | null;
  employment_status: string;
}

export const NO_TRAINING_ASSIGNED = "No training assigned to this employee yet.";
const ASSIGNMENTS_HOME = "/lnd/assignments";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a URL value can be an employee ID. Anything else is shown as not found without asking the server. */
export const isEmployeeId = (value: string | null | undefined): value is string => Boolean(value && UUID.test(value));

/** The list's Department and Status filters. "" means all. */
export interface EmployeeFilters {
  department?: string | null;
  status?: string | null;
}

/** Department filter value for employees without a department. */
export const NO_DEPARTMENT = "__none__";
export const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

/** The page's address: the employee search and filters, and the selected employee by ID (never by name or search text). */
export function assignmentsHref({ employee, search, department, status }: { employee?: string | null; search?: string | null } & EmployeeFilters): string {
  const query = new URLSearchParams();
  if (employee) query.set("employee", employee);
  if (department) query.set("department", department);
  if (status) query.set("status", status);
  // Kept as typed (only an all-space search is dropped), so the box is never rewritten mid-word.
  if ((search ?? "").trim()) query.set("search", search!);
  const text = query.toString();
  return text ? `${ASSIGNMENTS_HOME}?${text}` : ASSIGNMENTS_HOME;
}

const normalise = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/** Employees whose name, Employee ID or email contains the search, in list order. */
export function searchEmployees<T extends Pick<EmployeeListItem, "full_name" | "employee_code" | "work_email">>(employees: T[], search: string): T[] {
  const needle = normalise(search);
  if (!needle) return employees;
  return employees.filter((e) => normalise(e.full_name).includes(needle) || normalise(e.employee_code).includes(needle) || normalise(e.work_email).includes(needle));
}

/** The selected employee, matched by ID only. */
export function findEmployee<T extends { id: string }>(employees: T[] | null | undefined, id: string | null | undefined): T | undefined {
  if (!isEmployeeId(id)) return undefined;
  return (employees ?? []).find((e) => e.id.toLowerCase() === id.toLowerCase());
}

export const isInactive = (e: Pick<EmployeeListItem, "employment_status">) => e.employment_status === "INACTIVE";

/** The Department filter's choices: the departments the listed employees have, by name, plus "No department". */
export function departmentOptions(employees: Pick<EmployeeListItem, "department">[] | null | undefined): { value: string; label: string }[] {
  const names = [...new Set((employees ?? []).map((e) => e.department).filter((d): d is string => Boolean(d)))].sort((a, b) => a.localeCompare(b, "en"));
  const options = names.map((name) => ({ value: name, label: name }));
  return (employees ?? []).some((e) => !e.department) ? [...options, { value: NO_DEPARTMENT, label: "No department" }] : options;
}

/** Employees matching the search (name, Employee ID or email) and both filters. */
export function filterEmployeeList<T extends Pick<EmployeeListItem, "full_name" | "employee_code" | "work_email" | "department" | "employment_status">>(employees: T[], search: string, { department, status }: EmployeeFilters): T[] {
  return searchEmployees(employees, search).filter(
    (e) =>
      (!department || (department === NO_DEPARTMENT ? !e.department : e.department === department)) &&
      (!status || (status === "inactive" ? isInactive(e) : !isInactive(e))),
  );
}

/** The three summary cards, counted from the given (one employee's) assignments. */
export function assignmentCounts(rows: { completed_at: string | null }[]): { assigned: number; pending: number; completed: number } {
  const completed = rows.filter((r) => r.completed_at).length;
  return { assigned: rows.length, pending: rows.length - completed, completed };
}
