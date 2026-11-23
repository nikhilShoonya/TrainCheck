import assert from "node:assert/strict";
import test from "node:test";
import { compareTableValues, dateTime, dateTimeIn, day, greeting, longDay, nowIn, ORG_TIMEZONE, todayInOrg } from "@/lib/utils";

test("India display is fixed and equivalent explicit offsets represent the same instant", () => {
  assert.equal(ORG_TIMEZONE, "Asia/Kolkata");
  const expected = "23-11-2026 03:35 PM";
  assert.equal(dateTime("2026-11-23T10:05:00Z"), expected);
  assert.equal(dateTime("2026-11-23T15:35:00+05:30"), expected);
  assert.equal(dateTimeIn("2026-11-23T10:05:00Z", "America/New_York"), expected);
});

test("midnight, noon and a year boundary use a 12-hour clock and the India date", () => {
  assert.equal(dateTime("2026-11-23T18:30:00Z"), "24-11-2026 12:00 AM");
  assert.equal(dateTime("2026-11-23T06:30:00Z"), "23-11-2026 12:00 PM");
  assert.equal(dateTime("2026-12-31T20:55:00Z"), "01-01-2027 02:25 AM");
  assert.equal(greeting(new Date("2026-11-23T06:30:00Z")), "Good afternoon");
});

test("date-only display never shifts joining dates or changes their source value", () => {
  const joining = "2026-11-23";
  assert.equal(day(joining), "23-11-2026");
  assert.equal(longDay(joining), "23-11-2026");
  assert.equal(joining, "2026-11-23");
  assert.equal(day("2026-11-23T20:55:00Z"), "24-11-2026");
  assert.equal(day("invalid import date"), "invalid import date");
});

test("native input values remain ISO dates and 24-hour times", () => {
  assert.deepEqual(nowIn(ORG_TIMEZONE, new Date("2026-11-23T20:55:00Z")), { date: "2026-11-24", time: "02:25" });
  assert.match(todayInOrg(), /^\d{4}-\d{2}-\d{2}$/);
});

test("missing and malformed timestamps remain explicit instead of fabricated dates", () => {
  assert.equal(dateTime(null), "—");
  assert.equal(dateTimeIn(null, "UTC", "After completion"), "After completion");
  assert.equal(dateTime("not a timestamp"), "not a timestamp");
});

test("date sorting crosses months and years chronologically", () => {
  assert.deepEqual(["02-11-2026", "30-10-2026", "01-01-2027"].sort(compareTableValues), ["30-10-2026", "02-11-2026", "01-01-2027"]);
});

test("AM/PM sorting handles midnight, noon and descending order", () => {
  const values = ["23-11-2026 01:00 PM", "23-11-2026 11:00 AM", "23-11-2026 12:00 AM", "23-11-2026 12:00 PM"];
  const expected = ["23-11-2026 12:00 AM", "23-11-2026 11:00 AM", "23-11-2026 12:00 PM", "23-11-2026 01:00 PM"];
  assert.deepEqual(values.toSorted(compareTableValues), expected);
  assert.deepEqual(values.toSorted((a, b) => -compareTableValues(a, b)), expected.toReversed());
  assert.ok(compareTableValues("Employee 2", "Employee 10") < 0);
});
