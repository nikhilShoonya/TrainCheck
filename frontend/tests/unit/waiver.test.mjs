import assert from "node:assert/strict";
import { test } from "node:test";
import { canWaiveAssessment, waiveAssessments } from "@/features/admin/waiver";

const person = (id, assessment_state = "Due") => ({ id, employee_name: `Person ${id}`, employee_code: id, obligation_id: `assessment-${id}`, assessment_state });

test("waiver selection matches the individual action and excludes closed or running assessments", () => {
  for (const state of ["Due", "Scheduled", "Awaiting refresher", "Awaiting approval", "Unavailable"]) assert.equal(canWaiveAssessment(person("1", state)), true);
  for (const state of ["Submitted", "Waived", "In progress", "Not scheduled", "Awaiting completion"]) assert.equal(canWaiveAssessment(person("1", state)), false);
  assert.equal(canWaiveAssessment({ ...person("1"), obligation_id: null }), false);
});

test("each obligation is waived once and business refusals leave other employees unaffected", async () => {
  const calls = [];
  const results = await waiveAssessments([person("1"), person("1"), person("2"), person("3", "Submitted"), person("4")], async (row) => {
    calls.push(row.id);
    if (row.id === "2") throw { status: 409, code: "ATTEMPT_IN_PROGRESS", message: "An attempt is in progress." };
  }, () => {});
  assert.deepEqual(calls, ["1", "2", "4"]);
  assert.deepEqual(results.map((result) => result.status), ["WAIVED", "FAILED", "FAILED", "WAIVED"]);
  assert.match(results[1].message, /in progress/);
});

test("uncertain, access and rate-limit failures stop unsent waivers without retrying", async () => {
  for (const status of [0, 401, 403, 429, 503]) {
    let calls = 0;
    const results = await waiveAssessments([person("1"), person("2")], async () => { calls++; throw { status, message: "Request refused." }; }, () => {});
    assert.equal(calls, 1);
    assert.deepEqual(results.map((result) => result.status), ["FAILED", "NOT_ATTEMPTED"]);
    if (status === 0 || status === 503) assert.match(results[0].message, /may have recorded/);
  }
});

test("leaving the page stops unsent waivers, and an empty selection makes no calls", async () => {
  let cancelled = false;
  const results = await waiveAssessments([person("1"), person("2")], async () => { cancelled = true; }, () => {}, () => cancelled);
  assert.deepEqual(results.map((result) => result.status), ["WAIVED", "NOT_ATTEMPTED"]);
  assert.deepEqual(await waiveAssessments([], async () => { throw new Error("Unexpected call"); }, () => {}), []);
});
