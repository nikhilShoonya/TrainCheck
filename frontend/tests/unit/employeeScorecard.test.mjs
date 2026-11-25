/* Employee Scorecard: links by employee ID, Back to report keeping the report and its filters, the scorecard's own
   filters, the five-row rule and how missing values read. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attemptText,
  datesProblem,
  firstLatestText,
  gainText,
  isCompleteDay,
  isEmployeeId,
  limitRows,
  needsExpansion,
  parseReportState,
  parseScorecardFilters,
  presetOf,
  presetRange,
  reportsHref,
  reportStateQuery,
  ROW_LIMIT,
  scopeText,
  scorecardHref,
  scoreText,
  shiftDay,
  showingLabel,
  viewAllLabel,
} from "@/features/reports/employeeScorecardView";
import { dateTime, day } from "@/lib/utils";

const ID = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const TRAINING = "11111111-1111-4111-8111-111111111111";
const params = (text) => new URLSearchParams(text);

test("an employee is opened by database ID, never by name", () => {
  assert.equal(isEmployeeId(ID), true);
  assert.equal(isEmployeeId("Aarav Sharma"), false);
  assert.equal(isEmployeeId("E1"), false);
  assert.equal(isEmployeeId(""), false);
  assert.equal(scorecardHref(ID), `/lnd/reports/employees/${ID}`);
});

test("the report and its filters survive the round trip to a scorecard and Back to report", () => {
  const back = reportStateQuery("pass-fail", { department_id: "dep-1", date_from: "2026-11-01", grade: "G1" });
  const href = scorecardHref(ID, back);
  const url = new URL(href, "http://x");
  assert.equal(url.pathname, `/lnd/reports/employees/${ID}`);
  assert.equal(reportsHref(url.searchParams.get("back")), `/lnd/reports?${back}`);
  assert.deepEqual(parseReportState(new URLSearchParams(back)), { code: "pass-fail", filters: { date_from: "2026-11-01", department_id: "dep-1", grade: "G1" } });
});

test("Back to report only ever leads to Reports & Analytics with known values", () => {
  assert.equal(reportsHref(null), "/lnd/reports");
  assert.equal(reportsHref(""), "/lnd/reports");
  assert.equal(reportsHref("report=nope&evil=1"), "/lnd/reports?report=compliance");
  assert.equal(reportsHref("https://evil.example/x"), "/lnd/reports?report=compliance");
  assert.equal(reportsHref("report=compliance&date_from=31-12-2026"), "/lnd/reports?report=compliance");
  assert.ok(reportsHref("report=learning-gain&next=//evil.example").startsWith("/lnd/reports?report=learning-gain"));
  assert.ok(!reportsHref("report=learning-gain&next=//evil.example").includes("evil"));
});

test("the scorecard keeps only its own filters, in wire format", () => {
  assert.deepEqual(parseScorecardFilters(params(`training_id=${TRAINING}&date_from=2026-11-01&date_to=2026-11-30&department_id=x`)), { training_id: TRAINING, date_from: "2026-11-01", date_to: "2026-11-30" });
  assert.deepEqual(parseScorecardFilters(params("training_id=Data%20Privacy&date_from=01-11-2026")), {});
  assert.equal(new URL(scorecardHref(ID, "report=compliance", { training_id: TRAINING, date_to: "2026-11-30" }), "http://x").search, `?training_id=${TRAINING}&date_to=2026-11-30&back=report%3Dcompliance`);
  assert.equal(datesProblem({ date_from: "2026-11-05", date_to: "2026-11-01" }), "The start date must be on or before the end date.");
  assert.equal(datesProblem({ date_from: "2026-11-01", date_to: "2026-11-01" }), null);
  assert.equal(datesProblem({ date_from: "2026-11-01" }), null);
});

test("five rows first, then all of them; the control appears only above five", () => {
  const rows = Array.from({ length: 8 }, (_, i) => i);
  assert.equal(ROW_LIMIT, 5);
  assert.deepEqual(limitRows(rows, false), [0, 1, 2, 3, 4]);
  assert.deepEqual(limitRows(rows, true), rows);
  assert.deepEqual(limitRows([1, 2, 3], false), [1, 2, 3]);
  assert.equal(needsExpansion(5), false);
  assert.equal(needsExpansion(6), true);
  assert.equal(viewAllLabel(8, false), "View all (8)");
  assert.equal(viewAllLabel(8, true), "Show less");
  assert.equal(showingLabel(8, false, "attempt"), "Showing 5 of 8 attempts");
  assert.equal(showingLabel(8, true, "attempt"), "Showing 8 of 8 attempts");
  assert.equal(showingLabel(3, false, "training"), "Showing 3 of 3 trainings");
  assert.equal(showingLabel(1, false, "training"), "Showing 1 of 1 training");
  assert.equal(showingLabel(0, false, "response"), "No responses");
});

test("sorting happens on the whole list before the first five are taken", () => {
  // The table sorts every row, then limitRows cuts: the best score is shown even when it was the eighth row.
  const scores = [50, 40, 30, 20, 10, 5, 1, 99];
  const top = limitRows([...scores].sort((a, b) => b - a), false);
  assert.deepEqual(top, [99, 50, 40, 30, 20]);
  assert.ok(!limitRows(scores, false).includes(99));
});

test("missing scores read as a dash or Not comparable, never zero", () => {
  assert.equal(scoreText(null), "—");
  assert.equal(scoreText(undefined), "—");
  assert.equal(scoreText(0), "0%");
  assert.equal(scoreText(69.99), "69.99%"); // Never rounded up to a passing 70%.
  assert.equal(scoreText(80), "80%");
  assert.equal(firstLatestText(null, null), "—");
  assert.equal(firstLatestText(70, 85), "70 / 85");
  assert.equal(gainText({ comparable: true, gain: 40 }), "+40 points");
  assert.equal(gainText({ comparable: true, gain: -12.5 }), "-12.5 points");
  assert.equal(gainText({ comparable: true, gain: 0 }), "0 points");
  assert.equal(gainText({ comparable: false, gain: null }), "Not comparable");
});

test("attempt numbers that repeat across re-training cycles name their cycle", () => {
  assert.equal(attemptText({ attempt_number: 2, training_cycle: 1, show_cycle: false }), "2");
  assert.equal(attemptText({ attempt_number: 1, training_cycle: 2, show_cycle: true }), "Cycle 2 · Attempt 1");
});

test("dates show as DD-MM-YYYY and times in India time with AM/PM and no zone suffix", () => {
  assert.equal(day("2026-11-25"), "25-11-2026");
  assert.equal(dateTime("2026-11-25T05:00:00Z"), "25-11-2026 10:30 AM");
  assert.equal(dateTime("2026-11-25T18:45:00+00:00"), "26-11-2026 12:15 AM");
  assert.doesNotMatch(dateTime("2026-11-25T05:00:00Z"), /UTC|IST/);
  assert.equal(scopeText({}, day), "all time");
  assert.equal(scopeText({ date_from: "2026-11-01", date_to: "2026-11-30" }, day), "completed 01-11-2026 to 30-11-2026");
  assert.equal(scopeText({ date_from: "2026-11-01" }, day), "completed from 01-11-2026");
  assert.equal(scopeText({ date_to: "2026-11-30" }, day), "completed up to 30-11-2026");
});

test("the Date dropdown: presets are completion-date ranges ending today, and a URL range reopens its preset", () => {
  const today = "2026-11-25";
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.deepEqual(presetRange("all", today), {});
  assert.deepEqual(presetRange("30", today), { date_from: "2026-10-27", date_to: today });
  assert.deepEqual(presetRange("90", today), { date_from: "2026-08-28", date_to: today });
  assert.deepEqual(presetRange("year", today), { date_from: "2026-01-01", date_to: today });
  assert.equal(presetOf({}, today), "all");
  assert.equal(presetOf({ date_from: "2026-10-27", date_to: today }, today), "30");
  assert.equal(presetOf({ date_from: "2026-01-01", date_to: today }, today), "year");
  assert.equal(presetOf({ date_from: "2026-11-01", date_to: "2026-11-10" }, today), "custom");
  assert.equal(presetOf({ date_to: today }, today), "custom");
  // A date being typed is applied only once complete.
  assert.equal(isCompleteDay("0002-11-05"), false);
  assert.equal(isCompleteDay("2026-11-05"), true);
  assert.equal(isCompleteDay(""), false);
});
