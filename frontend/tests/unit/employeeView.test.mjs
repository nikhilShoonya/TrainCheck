/* Employee Assignments > Add Employee: department choices, the bulk preview's wording, when Confirm Import is
   allowed, and who sees Change password. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeDepartments, assignmentCounts, assignmentsHref, departmentOptions, filterEmployeeList, NO_DEPARTMENT, canChangeOwnPassword, findEmployee, isEmployeeId, isInactive, NO_TRAINING_ASSIGNED, searchEmployees, confirmBlockedReason, createdMessage, departmentShown, EMPLOYEE_COLUMNS, EMPLOYEE_FILE_TYPES, joiningShown, PASSWORD_RULE, previewSummary, rowProblems } from "@/features/admin/employeeView";

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

test("the password form follows the server's setting, defaulting to L&D Admins only", () => {
  // The server's answer decides (EMPLOYEE_PASSWORD_CHANGE_ENABLED applies to employees only).
  assert.equal(canChangeOwnPassword({ roles: ["EMPLOYEE"], features: { password_change: false } }), false);
  assert.equal(canChangeOwnPassword({ roles: ["EMPLOYEE"], features: { password_change: true } }), true);
  assert.equal(canChangeOwnPassword({ roles: ["LD_ADMIN"], features: { password_change: true } }), true);
  // Without it: L&D Admins only.
  assert.equal(canChangeOwnPassword({ roles: ["LD_ADMIN", "EMPLOYEE"] }), true);
  assert.equal(canChangeOwnPassword({ roles: ["EMPLOYEE"] }), false);
  assert.equal(canChangeOwnPassword({ roles: [] }), false);
  assert.equal(canChangeOwnPassword(undefined), false);
});

test("the file layout and password rule match the backend", () => {
  assert.deepEqual(EMPLOYEE_COLUMNS, ["Employee Number", "Full Name", "Email", "Date of Joining", "Department"]);
  assert.equal(EMPLOYEE_FILE_TYPES, ".csv,.xlsx");
  assert.match(PASSWORD_RULE, /Fin@19112026/);
});

/* ---------- Employee Assignments: the employee list and the selected employee ---------- */

const ID_A = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const ID_B = "9b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const people = [
  { id: ID_A, full_name: "Aarav Mehta", employee_code: "E001", work_email: "aarav@example.com", department: "Operations", employment_status: "ACTIVE" },
  { id: ID_B, full_name: "Isha Rao", employee_code: "00457", work_email: "isha.rao@example.com", department: null, employment_status: "INACTIVE" },
];

test("the employee search matches name, Employee ID or email, ignoring case and spaces", () => {
  assert.deepEqual(searchEmployees(people, "  aarav ").map((p) => p.id), [ID_A]);
  assert.deepEqual(searchEmployees(people, "00457").map((p) => p.id), [ID_B]);
  assert.deepEqual(searchEmployees(people, "ISHA.RAO@").map((p) => p.id), [ID_B]);
  assert.deepEqual(searchEmployees(people, "example.com").length, 2);
  assert.deepEqual(searchEmployees(people, "Operations"), []); // Department is shown, not searched.
  assert.equal(searchEmployees(people, ""), people);
});

test("the selected employee is found by ID only", () => {
  assert.equal(findEmployee(people, ID_A.toUpperCase())?.full_name, "Aarav Mehta");
  assert.equal(findEmployee(people, "Aarav Mehta"), undefined);
  assert.equal(findEmployee(people, "E001"), undefined);
  assert.equal(findEmployee(null, ID_A), undefined);
  assert.equal(isEmployeeId(ID_B), true);
  assert.equal(isEmployeeId("00457"), false);
});

test("the page address keeps the search as typed and the employee by ID", () => {
  assert.equal(assignmentsHref({}), "/lnd/assignments");
  assert.equal(assignmentsHref({ search: "   " }), "/lnd/assignments");
  assert.equal(assignmentsHref({ search: "Isha " }), "/lnd/assignments?search=Isha+");
  assert.equal(assignmentsHref({ employee: ID_A, search: "aarav" }), `/lnd/assignments?employee=${ID_A}&search=aarav`);
});

test("summary counts and labels for one employee", () => {
  assert.deepEqual(assignmentCounts([]), { assigned: 0, pending: 0, completed: 0 });
  assert.deepEqual(assignmentCounts([{ completed_at: null }, { completed_at: "2026-11-19T10:00:00Z" }, { completed_at: null }]), { assigned: 3, pending: 2, completed: 1 });
  assert.equal(NO_TRAINING_ASSIGNED, "No training assigned to this employee yet.");
  assert.equal(isInactive(people[1]), true);
  assert.equal(isInactive(people[0]), false);
});

test("Department and Status filters combine with the search", () => {
  const staff = [...people, { id: "c", full_name: "Hidayat Ullah Khan", employee_code: "161", work_email: "hkhan@example.com", department: "HR", employment_status: "ACTIVE" }];
  assert.deepEqual(departmentOptions(staff), [
    { value: "HR", label: "HR" },
    { value: "Operations", label: "Operations" },
    { value: NO_DEPARTMENT, label: "No department" },
  ]);
  assert.deepEqual(departmentOptions(people.slice(0, 1)), [{ value: "Operations", label: "Operations" }]);
  assert.deepEqual(filterEmployeeList(staff, "", { department: "HR" }).map((e) => e.employee_code), ["161"]);
  assert.deepEqual(filterEmployeeList(staff, "", { department: NO_DEPARTMENT }).map((e) => e.employee_code), ["00457"]);
  assert.deepEqual(filterEmployeeList(staff, "", { status: "inactive" }).map((e) => e.employee_code), ["00457"]);
  assert.deepEqual(filterEmployeeList(staff, "", { status: "active" }).map((e) => e.employee_code), ["E001", "161"]);
  assert.deepEqual(filterEmployeeList(staff, "khan", { department: "HR", status: "active" }).map((e) => e.employee_code), ["161"]);
  assert.deepEqual(filterEmployeeList(staff, "khan", { department: "Operations" }), []);
  assert.equal(filterEmployeeList(staff, "", {}).length, 3);
});

test("the address keeps the filters too", () => {
  assert.equal(assignmentsHref({ search: "khan", department: "HR", status: "active" }), "/lnd/assignments?department=HR&status=active&search=khan");
  assert.equal(assignmentsHref({ department: "", status: "" }), "/lnd/assignments");
});
