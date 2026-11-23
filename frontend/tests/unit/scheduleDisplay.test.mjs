/* Human timestamps use India time without a timezone suffix. Native input values stay ISO/24-hour.
   Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dateTimeIn, nowIn } from "@/lib/utils";

test("timestamps display in India time without timezone labels", () => {
  assert.equal(dateTimeIn("2026-11-19T10:00:00+00:00", "Asia/Kolkata"), "19-11-2026 03:30 PM");
  assert.equal(dateTimeIn("2026-11-19T10:00:00Z", "UTC"), "19-11-2026 03:30 PM");
});

test("crossing midnight: the local date is the organisation's, not the UTC date", () => {
  assert.equal(dateTimeIn("2026-11-04T21:30:00+00:00", "Asia/Kolkata"), "05-11-2026 03:00 AM");
  assert.equal(dateTimeIn("2026-11-05T02:00:00+00:00", "America/New_York"), "05-11-2026 07:30 AM");
});

test("without a timezone from the server, India time is used", () => {
  assert.equal(dateTimeIn("2026-11-19T10:00:00Z"), "19-11-2026 03:30 PM");
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
