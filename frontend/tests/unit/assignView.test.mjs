/* Assign employees: search and "select all shown". Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allShownSelected, filterPeople, toggleOne, toggleShown } from "@/features/admin/assignView";

const people = [
  { id: "1", full_name: "Aarav Mehta", employee_code: "E001", department: "Operations", function: "Compliance" },
  { id: "2", full_name: "Anika Sood", employee_code: "E010", department: "Customer Experience", function: "Customer Support" },
  { id: "3", full_name: "Isha Rao", employee_code: "E002", department: "Operations", function: "Compliance" },
  { id: "4", full_name: "Dev Malhotra", employee_code: "H001", department: "Human Resources", function: null },
];

test("search matches name, ID, department or function, ignoring case and spaces", () => {
  assert.deepEqual(filterPeople(people, "  operations ").map((p) => p.id), ["1", "3"]);
  assert.deepEqual(filterPeople(people, "e010").map((p) => p.id), ["2"]);
  assert.deepEqual(filterPeople(people, "support").map((p) => p.id), ["2"]);
  assert.equal(filterPeople(people, "").length, 4);
});

test("Select all picks everyone the search shows, department-wise, and keeps earlier picks", () => {
  const before = new Set(["4"]);
  const operations = filterPeople(people, "Operations");
  const after = toggleShown(before, operations);
  assert.deepEqual([...after].sort(), ["1", "3", "4"]);
  assert.equal(allShownSelected(after, operations), true);
  // Changing the search does not drop anyone already selected.
  assert.equal(allShownSelected(after, filterPeople(people, "Customer")), false);
  assert.deepEqual([...toggleShown(after, filterPeople(people, "Customer"))].sort(), ["1", "2", "3", "4"]);
});

test("when all shown are selected the same button clears only them", () => {
  const all = new Set(["1", "2", "3", "4"]);
  assert.deepEqual([...toggleShown(all, filterPeople(people, "Operations"))].sort(), ["2", "4"]);
  assert.equal(allShownSelected(new Set(), []), false); // Nothing shown: nothing to clear.
});

test("a single tick toggles one person", () => {
  assert.deepEqual([...toggleOne(new Set(["1"]), "2")].sort(), ["1", "2"]);
  assert.deepEqual([...toggleOne(new Set(["1", "2"]), "1")], ["2"]);
});
