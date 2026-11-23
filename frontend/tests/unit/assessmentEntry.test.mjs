/* Entering an assessment from My Trainings: the countdown before it opens, what is announced to screen readers,
   the card's action and the waiting screen's next step. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardEntry, countdown, milestone, serverClock, waitingStep } from "@/features/exam/assessmentEntry";

const card = (over) => ({ obligation_id: "o1", due_at: "2026-11-19T10:00:00+00:00", timezone: "Asia/Kolkata", planned_at: null, entry_state: "NOT_YET_OPEN", entry_reason: null, entry_message: null, ...over });

test("the countdown reads HH:MM:SS and never shows zero while time remains", () => {
  assert.equal(countdown(0), "00:00:00");
  assert.equal(countdown(3725_000), "01:02:05");
  assert.equal(countdown(90_061_000), "25:01:01"); // More than a day stays in hours.
  assert.equal(countdown(400), "00:00:01"); // 0.4 s left is not yet open.
  assert.equal(countdown(-5_000), "00:00:00");
});

test("remaining time comes from the server's clock and a monotonic timer, not the device clock", () => {
  // Received at monotonic 1 000 ms: server says 09:59:00, opening at 10:00:00.
  const clock = serverClock("2026-11-19T09:59:00Z", 1_000);
  assert.equal(clock.remainingMs("2026-11-19T10:00:00Z", 1_000), 60_000);
  assert.equal(clock.remainingMs("2026-11-19T10:00:00Z", 31_000), 30_000);
  assert.equal(clock.remainingMs("2026-11-19T10:00:00Z", 91_000), -30_000);
  assert.ok(Number.isNaN(serverClock("not a date", 0).remainingMs("2026-11-19T10:00:00Z", 0)));
});

test("screen readers hear meaningful milestones only, not every second", () => {
  assert.equal(milestone(500_000, 499_000), null);
  assert.equal(milestone(3_601_000, 3_600_000), "Your assessment opens in 1 hour.");
  assert.equal(milestone(7_201_000, 7_199_000), "Your assessment opens in 2 hours.");
  assert.equal(milestone(601_000, 600_000), "Your assessment opens in 10 minutes.");
  assert.equal(milestone(61_000, 59_500), "Your assessment opens in 1 minute.");
  assert.equal(milestone(11_000, 10_000), "Your assessment opens in 10 seconds.");
  // A long jump (sleep, background tab) announces only the latest milestone passed.
  assert.equal(milestone(4_000_000, 100_000), "Your assessment opens in 5 minutes.");
  assert.equal(milestone(1_000, 0), null); // Opening is announced by the recheck, which confirms it with the server.
});

test("a scheduled assessment offers Start Test, which shows the countdown before the opening time", () => {
  const entry = cardEntry(card());
  assert.equal(entry.label, "Start Test");
  assert.equal(entry.href, "/assessment/start/o1");
  assert.equal(entry.status, "Assessment opens 19-11-2026 03:30 PM");
  assert.match(entry.note, /before the opening time shows a countdown/);
});

test("a due assessment leads into the entry flow and a running one says Resume Test", () => {
  assert.deepEqual([cardEntry(card({ entry_state: "OPEN" })).label, cardEntry(card({ entry_state: "OPEN" })).href], ["Start Test", "/assessment/start/o1"]);
  const resume = cardEntry(card({ entry_state: "IN_PROGRESS" }));
  assert.deepEqual([resume.label, resume.href], ["Resume Test", "/assessment/start/o1"]);
});

test("without recorded completion there is no action, only the planned opening and the reason", () => {
  const entry = cardEntry(card({ obligation_id: null, due_at: null, planned_at: "2026-11-21T04:30:00+00:00", entry_state: "UNAVAILABLE", entry_reason: "AWAITING_COMPLETION", entry_message: "Awaiting training completion. Your assessment is created when L&D records that you completed the training." }));
  assert.equal(entry.href, null);
  assert.equal(entry.label, null);
  assert.equal(entry.status, "Awaiting training completion");
  assert.match(entry.note, /Planned opening 21-11-2026 10:00 AM, only once your completion is recorded/);
});

test("an unavailable assessment shows the backend's reason and offers nothing that would fail", () => {
  const message = "This assessment cannot start yet because its question pool is incomplete.";
  const entry = cardEntry(card({ entry_state: "UNAVAILABLE", entry_reason: "QUESTION_POOL_INSUFFICIENT", entry_message: message }));
  assert.deepEqual([entry.href, entry.label, entry.note], [null, null, message]);
  // An actionable state without an assessment to open is never offered.
  assert.equal(cardEntry(card({ entry_state: "OPEN", obligation_id: null })).href, null);
});

test("the waiting screen hands over to the gate only once the backend confirms the assessment is due", () => {
  const allowed = { access_status: "DASHBOARD_ALLOWED" };
  assert.equal(waitingStep({ entry_state: "NOT_YET_OPEN" }, allowed), "wait");
  assert.equal(waitingStep({ entry_state: "OPEN" }, { access_status: "ASSESSMENT_REQUIRED" }), "gate");
  assert.equal(waitingStep({ entry_state: "IN_PROGRESS" }, { access_status: "ASSESSMENT_REQUIRED" }), "gate");
  assert.equal(waitingStep({ entry_state: "NOT_YET_OPEN" }, { access_status: "ASSESSMENT_REQUIRED" }), "gate"); // Another assessment is due first.
  assert.equal(waitingStep({ entry_state: "OPEN" }, allowed), "confirm"); // Not yet blocking: re-check, never open the exam.
  assert.equal(waitingStep({ entry_state: "UNAVAILABLE" }, allowed), "unavailable");
  assert.equal(waitingStep({ entry_state: "UNAVAILABLE" }, { access_status: "FEEDBACK_REQUIRED" }), "workspace");
  assert.equal(waitingStep(null, allowed), "loading");
  assert.equal(waitingStep(null, { access_status: "ASSESSMENT_REQUIRED" }), "gate"); // The gate never waits for details.
  assert.equal(waitingStep({ entry_state: "NOT_YET_OPEN" }, null), "loading");
});
