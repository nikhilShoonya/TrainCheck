/* Training Completion: card counts, training and employee search, and the links that keep the card search for
   Back to Trainings. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptsLabel, completionCounts, filterEmployees, filterTrainings, isTrainingId, retryNote, rowCounts, shortDescription, trainingCompletionHref, trainingsHref } from "@/features/admin/completionView";

const ID = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";

test("a card counts assigned, recorded and awaiting training completion", () => {
  assert.deepEqual(completionCounts({ assigned_count: 5, completed_count: 2 }), { assigned: 5, recorded: 2, awaiting: 3 });
  assert.deepEqual(completionCounts({ assigned_count: 0, completed_count: 0 }), { assigned: 0, recorded: 0, awaiting: 0 });
  // Never a negative count, even if the two numbers were read at different moments.
  assert.equal(completionCounts({ assigned_count: 1, completed_count: 2 }).awaiting, 0);
});

test("the per-training counts follow the rows on screen", () => {
  const rows = [{ completed_at: "2026-11-15T00:00:00Z" }, { completed_at: null }, { completed_at: null }];
  assert.deepEqual(rowCounts(rows), { assigned: 3, recorded: 1, awaiting: 2 });
  assert.deepEqual(rowCounts([]), { assigned: 0, recorded: 0, awaiting: 0 });
});

test("training search matches the name, ignoring case and surrounding spaces", () => {
  const trainings = [{ title: "Customer Handling" }, { title: "KYC & AML Compliance" }, { title: "Data Privacy & Protection" }];
  assert.deepEqual(filterTrainings(trainings, "  kyc ").map((t) => t.title), ["KYC & AML Compliance"]);
  assert.deepEqual(filterTrainings(trainings, "PRIVACY").map((t) => t.title), ["Data Privacy & Protection"]);
  assert.equal(filterTrainings(trainings, "").length, 3);
  assert.equal(filterTrainings(trainings, "   ").length, 3);
  assert.deepEqual(filterTrainings(trainings, "payroll"), []);
});

test("employee search matches the name or the employee code", () => {
  const rows = [
    { employee_name: "Aarav Mehta", employee_code: "E001" },
    { employee_name: "Anika Sood", employee_code: "E010" },
    { employee_name: "Arjun Roy", employee_code: "E100" },
  ];
  assert.deepEqual(filterEmployees(rows, "sood").map((r) => r.employee_code), ["E010"]);
  assert.deepEqual(filterEmployees(rows, "e01").map((r) => r.employee_code), ["E010"]);
  assert.deepEqual(filterEmployees(rows, "E00").map((r) => r.employee_code), ["E001"]);
  assert.deepEqual(filterEmployees(rows, "a").length, 3);
  assert.deepEqual(filterEmployees(rows, "zz"), []);
});

test("links keep the card search, so Back to Trainings restores it", () => {
  assert.equal(trainingsHref(), "/lnd/completion");
  assert.equal(trainingsHref("  "), "/lnd/completion");
  assert.equal(trainingsHref("kyc & aml"), "/lnd/completion?q=kyc+%26+aml");
  assert.equal(trainingCompletionHref(ID), `/lnd/completion/${ID}`);
  assert.equal(trainingCompletionHref(ID, " data "), `/lnd/completion/${ID}?q=data`);
  // The training ID is a path segment, never extra path or query.
  assert.equal(trainingCompletionHref("a/b?c"), "/lnd/completion/a%2Fb%3Fc");
});

test("only a UUID can be a training ID", () => {
  assert.equal(isTrainingId(ID), true);
  assert.equal(isTrainingId(ID.toUpperCase()), true);
  for (const value of ["", null, undefined, "not-a-training", `${ID}x`, "../admin"]) assert.equal(isTrainingId(value), false, String(value));
});

test("a card shows a short description cut at a word", () => {
  assert.equal(shortDescription(null), "");
  assert.equal(shortDescription("  Short   text. "), "Short text.");
  const long = "Handle customer conversations with empathy, accuracy and the documented escalation steps, including complaints, refunds and service recovery for every channel.";
  const short = shortDescription(long, 60);
  assert.ok(short.length <= 61, short);
  assert.ok(short.endsWith("…"));
  assert.ok(long.startsWith(short.slice(0, -1)));
  assert.ok(!/\s…$/.test(short));
});

test("the Attempts column shows finished attempts of the current cycle out of the maximum", () => {
  assert.equal(attemptsLabel({ attempts_completed: 0, max_attempts: 3 }), "0/3");
  assert.equal(attemptsLabel({ attempts_completed: 3, max_attempts: 3 }), "3/3");
  assert.equal(attemptsLabel({ attempts_completed: 0, max_attempts: null }), "—"); // No assessment rules yet.
});

test("no retry action is offered while a re-attempt is authorised or running", () => {
  assert.equal(retryNote({ retry_action: "REATTEMPT", attempts_completed: 1, assessment_state: "Awaiting approval" }), null);
  assert.equal(retryNote({ retry_action: null, attempts_completed: 1, assessment_state: "Due" }), "Reattempt authorised");
  assert.equal(retryNote({ retry_action: null, attempts_completed: 2, assessment_state: "In progress" }), "Attempt in progress");
  assert.equal(retryNote({ retry_action: null, attempts_completed: 0, assessment_state: "Due" }), null); // First attempt.
  assert.equal(retryNote({ retry_action: null, attempts_completed: 1, assessment_state: "Submitted" }), null); // Passed.
});
