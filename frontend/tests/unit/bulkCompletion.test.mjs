import assert from "node:assert/strict";
import { test } from "node:test";
import { canSelectCompletion, completeInBatches } from "@/features/admin/bulkCompletion";

const employee = (id, over = {}) => ({ id, employee_name: `Person ${id}`, employee_code: id, completed_at: null, attendance_status: "PENDING", ...over });
const reply = { assessment_scheduling: { status: "SCHEDULED", message: "Assessment scheduled.", action: null } };

test("completed and absent/excused employees cannot be selected; partial remains subject to server policy", () => {
  for (const attendance_status of ["PENDING", "PRESENT", "PARTIAL"]) assert.equal(canSelectCompletion(employee("1", { attendance_status })), true);
  for (const attendance_status of ["ABSENT", "EXCUSED"]) assert.equal(canSelectCompletion(employee("1", { attendance_status })), false);
  assert.equal(canSelectCompletion(employee("1", { completed_at: "2026-11-20" })), false);
});

test("bounded workers send each enrolment once and report progress even with duplicate input IDs", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const progress = [];
  const rows = Array.from({ length: 12 }, (_, i) => employee(String(i)));
  const results = await completeInBatches([...rows, rows[0]], async (row) => {
    calls.push(row.id);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return reply;
  }, (done, total) => progress.push([done, total]));
  assert.equal(peak, 3);
  assert.equal(new Set(calls).size, 12);
  assert.equal(calls.length, 12);
  assert.equal(results.length, 12);
  assert.ok(results.every((result) => result.status === "COMPLETED"));
  assert.deepEqual(progress.at(-1), [12, 12]);
});

test("a business-rule refusal is reported per employee without abandoning others or retrying duplicates", async () => {
  const results = await completeInBatches([employee("1"), employee("2"), employee("3"), employee("4")], async (row) => {
    if (row.id === "2") throw { status: 409, code: "ATTENDANCE_NOT_COMPLETABLE", message: "Partial attendance is not allowed." };
    if (row.id === "3") throw { status: 409, code: "COMPLETION_EXISTS", message: "Completion is already recorded." };
    return reply;
  }, () => {});
  assert.deepEqual(results.map((result) => result.status), ["COMPLETED", "FAILED", "ALREADY_COMPLETED", "COMPLETED"]);
  assert.match(results[1].message, /Partial/);
});

test("an uncertain connection result stops unsent rows and never claims that nothing was saved", async () => {
  const calls = [];
  const results = await completeInBatches(Array.from({ length: 8 }, (_, i) => employee(String(i))), async (row) => {
    calls.push(row.id);
    throw { status: 0, code: "TIMEOUT", message: "Request timed out." };
  }, () => {});
  assert.equal(calls.length, 3);
  assert.equal(results.filter((result) => result.status === "NOT_ATTEMPTED").length, 5);
  assert.match(results[0].message, /server may have recorded completion/);
});

test("rate limiting and access failures stop unsent rows instead of flooding the API", async () => {
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    const results = await completeInBatches(Array.from({ length: 8 }, (_, i) => employee(String(i))), async () => {
      calls++;
      throw { status, message: "Stop and refresh." };
    }, () => {});
    assert.equal(calls, 3);
    assert.equal(results.filter((result) => result.status === "NOT_ATTEMPTED").length, 5);
  }
});

test("leaving the page does not start more requests, and an empty selection makes no calls", async () => {
  let cancelled = false;
  let calls = 0;
  const results = await completeInBatches(Array.from({ length: 8 }, (_, i) => employee(String(i))), async () => {
    calls++;
    cancelled = true;
    return reply;
  }, () => {}, () => cancelled);
  assert.equal(calls, 1);
  assert.equal(results[0].status, "COMPLETED");
  assert.equal(results.filter((result) => result.status === "NOT_ATTEMPTED").length, 7);
  assert.deepEqual(await completeInBatches([], async () => { throw new Error("Must not run"); }, () => {}), []);
});
