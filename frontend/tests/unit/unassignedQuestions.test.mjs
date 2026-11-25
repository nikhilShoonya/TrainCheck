/* Unassigned Questions: when the card shows, its link, which trainings can receive questions, and what stays
   selected after an assignment. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignableTrainings, assignSummaryText, remainingSelection, showUnassignedCard, unassignedHref } from "@/features/admin/questionBankView";

const result = (rows, summary) => ({ training: { id: "t", title: "Product Basics", code: "PB" }, test_type: "POST_TEST", summary, results: rows });
const row = (question_id, status, warning = null) => ({ question_id, question_code: question_id.toUpperCase(), status, test_type: "POST_TEST", warning, message: "" });

test("the card shows whenever at least one question is unassigned", () => {
  assert.equal(showUnassignedCard(null, ""), false);
  assert.equal(showUnassignedCard({ question_count: 0, active: 0, inactive: 0 }, ""), false);
  assert.equal(showUnassignedCard({ question_count: 1, active: 0, inactive: 1 }, ""), true);
  assert.equal(showUnassignedCard({ question_count: 5, active: 5, inactive: 0 }, "  "), true);
  // A malformed or older response never shows an empty card.
  for (const odd of [[], {}, { question_count: "3" }, { question_count: NaN }]) assert.equal(showUnassignedCard(odd, ""), false);
});

test("a training search hides the card unless it names it", () => {
  const some = { question_count: 3, active: 3, inactive: 0 };
  assert.equal(showUnassignedCard(some, "Product"), false);
  assert.equal(showUnassignedCard(some, "unassigned"), true);
  assert.equal(showUnassignedCard(some, " Unassigned Q "), true);
});

test("the unassigned page has its own link and keeps the card search for Back", () => {
  assert.equal(unassignedHref(), "/lnd/questions/unassigned");
  assert.equal(unassignedHref("sales & ops"), "/lnd/questions/unassigned?q=sales+%26+ops");
});

test("only draft and active trainings can receive questions, sorted by title", () => {
  const list = [
    { id: "1", title: "Zeta", status: "ACTIVE" },
    { id: "2", title: "Alpha", status: "ARCHIVED" },
    { id: "3", title: "Beta", status: "DRAFT" },
  ];
  assert.deepEqual(assignableTrainings(list).map((t) => t.id), ["3", "1"]);
});

test("after an assignment, questions that now serve the test leave the selection; the rest stay for a retry", () => {
  const selected = new Set(["a", "b", "c", "d", "e"]);
  const reply = result([row("a", "ASSIGNED"), row("b", "ALREADY_ASSIGNED"), row("c", "OTHER_TEST"), row("d", "NOT_FOUND"), row("e", "ASSIGNED", "Inactive")], {});
  assert.deepEqual([...remainingSelection(selected, reply)].sort(), ["c", "d"]);
  // Questions selected but not part of this request are untouched.
  assert.deepEqual([...remainingSelection(new Set(["x", "a"]), reply)], ["x"]);
});

test("the summary sentence counts every outcome, including questions that will not be drawn", () => {
  const all = { ASSIGNED: 3, ALREADY_ASSIGNED: 1, OTHER_TEST: 1, NOT_FOUND: 1, NOT_DRAWN: 1 };
  assert.equal(
    assignSummaryText(result([], all), "Post-test"),
    "3 assigned to Product Basics · Post-test, 1 already assigned, 1 kept on the other test, 1 not found, 1 will not be drawn until fixed or activated.",
  );
  assert.equal(assignSummaryText(result([], { ASSIGNED: 2, ALREADY_ASSIGNED: 0, OTHER_TEST: 0, NOT_FOUND: 0, NOT_DRAWN: 0 }), "Pre-test"), "2 assigned to Product Basics · Pre-test.");
});
