/* Showing assessment schedules: a UTC moment as local date and time in the organisation timezone, with the
   timezone named. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dateTimeIn, nowIn } from "@/lib/utils";

test("a UTC moment is shown in the organisation timezone, with the timezone named", () => {
  assert.equal(dateTimeIn("2026-11-19T10:00:00+00:00", "Asia/Kolkata"), "2026-11-19 15:30 (Asia/Kolkata)");
  assert.equal(dateTimeIn("2026-11-19T10:00:00Z", "UTC"), "2026-11-19 10:00 (UTC)");
});

test("crossing midnight: the local date is the organisation's, not the UTC date", () => {
  assert.equal(dateTimeIn("2026-11-04T21:30:00+00:00", "Asia/Kolkata"), "2026-11-05 03:00 (Asia/Kolkata)");
  assert.equal(dateTimeIn("2026-11-05T02:00:00+00:00", "America/New_York"), "2026-11-04 21:00 (America/New_York)");
});

test("without a timezone from the server, the configured organisation timezone is used", () => {
  assert.equal(dateTimeIn("2026-11-19T10:00:00Z"), "2026-11-19 15:30 (Asia/Kolkata)");
});

test("missing or unreadable values are never shown as a made-up date", () => {
  assert.equal(dateTimeIn(null, "Asia/Kolkata", "After completion"), "After completion");
  assert.equal(dateTimeIn("not a date", "Asia/Kolkata"), "not a date");
});

test("today and the current time in a timezone, for the date and time inputs", () => {
  const late = new Date("2026-11-19T20:00:00Z"); // Already the next day in India.
  assert.deepEqual(nowIn("Asia/Kolkata", late), { date: "2026-11-20", time: "01:30" });
  assert.deepEqual(nowIn("UTC", late), { date: "2026-11-19", time: "20:00" });
});
