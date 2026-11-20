/* Employee Assignments > Add Employee: department choices, the bulk preview's wording, when Confirm Import is
   allowed, and who sees Change password. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeDepartments, canChangeOwnPassword, confirmBlockedReason, createdMessage, departmentShown, EMPLOYEE_COLUMNS, EMPLOYEE_FILE_TYPES, joiningShown, PASSWORD_RULE, previewSummary, rowProblems } from "@/features/admin/employeeView";

const row = (overrides = {}) => ({
  row: 2,
  name: "Asha Verma",
  employee_code: "00123",
  email: "asha@example.com",
  joining_date: "2026-11-19",
  joining_date_text: "19 Nov 2026",
  department: { id: "d1", code: "OPS", name: "Operations" },
  department_text: "ops",
  status: "VALID",
  errors: [],
  ...overrides,
});
const preview = (overrides = {}) => ({ file_name: "people.csv", total_rows: 2, valid_rows: 2, invalid_rows: 0, ready: true, rows: [row()], ...overrides });

test("only active departments are offered, by name", () => {
  const list = [
    { id: "2", code: "CX", name: "Customer Experience", is_active: true },
    { id: "1", code: "OLD", name: "Archived team", is_active: false },
    { id: "3", code: "OPS", name: "Operations", is_active: true },
  ];
  assert.deepEqual(
    activeDepartments(list).map((d) => d.code),
    ["CX", "OPS"],
  );
  assert.deepEqual(activeDepartments(null), []);
});

test("Confirm Import needs a fresh, fully valid preview", () => {
  assert.equal(confirmBlockedReason(null, false), "Validate a file first.");
  assert.match(confirmBlockedReason(preview(), true), /changed after validation/);
  assert.match(confirmBlockedReason(preview({ ready: false, valid_rows: 1, invalid_rows: 1 }), false), /Every row must pass/);
  assert.equal(confirmBlockedReason(preview(), false), null);
});

test("the preview summary says nothing was saved and how many rows need correcting", () => {
  assert.equal(previewSummary(preview()), "people.csv: all 2 rows passed validation. Nothing has been saved yet.");
  assert.equal(previewSummary(preview({ ready: false, valid_rows: 1, invalid_rows: 1 })), "people.csv: 1 row of 2 need correcting. Nothing has been saved. Fix the file and validate it again.");
});

test("rows show what was read, or what the file held when it could not be read", () => {
  assert.equal(joiningShown(row()), "2026-11-19");
  assert.equal(joiningShown(row({ joining_date: null, joining_date_text: "31/02/2026" })), "31/02/2026");
  assert.equal(joiningShown(row({ joining_date: null, joining_date_text: "" })), "—");
  assert.equal(departmentShown(row()), "Operations (OPS)");
  assert.equal(departmentShown(row({ department: null, department_text: "Marketing" })), "Marketing");
  assert.equal(rowProblems(row()), "—");
  assert.equal(rowProblems(row({ errors: [{ field: "email", message: "Required." }, { field: "department", message: "Unknown department 'X'." }] })), "email: Required. department: Unknown department 'X'.");
});

test("success messages count accurately", () => {
  assert.equal(createdMessage(1), "1 employee added. They are now available in Assign Employees.");
  assert.equal(createdMessage(200), "200 employees added. They are all now available in Assign Employees.");
});

test("only L&D Admin accounts may change their own password", () => {
  assert.equal(canChangeOwnPassword(["LD_ADMIN", "EMPLOYEE"]), true);
  assert.equal(canChangeOwnPassword(["EMPLOYEE"]), false);
  assert.equal(canChangeOwnPassword([]), false);
  assert.equal(canChangeOwnPassword(undefined), false);
});

test("the file layout and password rule match the backend", () => {
  assert.deepEqual(EMPLOYEE_COLUMNS, ["name", "employee id", "email", "joiningdate", "department"]);
  assert.equal(EMPLOYEE_FILE_TYPES, ".csv,.xlsx");
  assert.match(PASSWORD_RULE, /Fin@19112026/);
});
