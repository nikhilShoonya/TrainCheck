/* Automatic countdown for a scheduled post-test: where sign-in lands, the MM:SS countdown and the hand-off
   to the existing manual preparation flow. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { countdownTarget, landingPath } from "@/components/shell/nav";
import { PREPARE_WINDOW_MS, shortCountdown, waitingStep } from "@/features/exam/assessmentEntry";

const employee = { primary_role: "EMPLOYEE" };
const soon = { obligation_id: "o1", training_title: "Synthetic KYC", due_at: "2026-11-19T10:00:00Z", timezone: "Asia/Kolkata" };
const allowed = (over = {}) => ({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], feedback_due: null, countdown: null, ...over });

test("the window is five minutes", () => {
  assert.equal(PREPARE_WINDOW_MS, 300_000);
});

test("MM:SS counts down to 00:00 and never shows 00:00 while time remains", () => {
  assert.equal(shortCountdown(180_000), "03:00");
  assert.equal(shortCountdown(179_000), "02:59");
  assert.equal(shortCountdown(300_000), "05:00");
  assert.equal(shortCountdown(400), "00:01");
  assert.equal(shortCountdown(0), "00:00");
  assert.equal(shortCountdown(-3_000), "00:00");
});

test("sign-in lands on the countdown only when the server reports one, after a due assessment and owed feedback", () => {
  assert.equal(landingPath(employee, allowed()), "/employee");
  assert.equal(landingPath(employee, allowed({ countdown: soon })), "/assessment/start/o1");
  assert.equal(landingPath(employee, { ...allowed({ countdown: soon }), access_status: "ASSESSMENT_REQUIRED" }), "/access/assessment-required");
  assert.equal(landingPath(employee, { ...allowed({ countdown: soon }), access_status: "FEEDBACK_REQUIRED", feedback_due: { attempt_id: "a9", obligation_id: "o9" } }), "/results/a9");
  assert.equal(landingPath(employee, null), "/employee");
  assert.equal(countdownTarget({ ...allowed({ countdown: soon }), access_status: "FEEDBACK_REQUIRED" }), null);
  assert.equal(landingPath({ primary_role: "LD_ADMIN" }, allowed({ countdown: soon })), "/assessment/start/o1"); // Same rule for anyone with an assessment.
});

test("a due assessment always hands off to manual preparation and never returns an automatic start step", () => {
  for (const entry_state of ["OPEN", "IN_PROGRESS", "NOT_YET_OPEN", "UNAVAILABLE"]) {
    assert.equal(waitingStep({ entry_state }, { access_status: "ASSESSMENT_REQUIRED" }), "gate");
  }
  assert.equal(waitingStep({ entry_state: "NOT_YET_OPEN" }, allowed()), "wait");
  assert.equal(waitingStep({ entry_state: "OPEN" }, allowed()), "confirm");
  assert.equal(waitingStep({ entry_state: "OPEN" }, { access_status: "FEEDBACK_REQUIRED" }), "workspace");
});
