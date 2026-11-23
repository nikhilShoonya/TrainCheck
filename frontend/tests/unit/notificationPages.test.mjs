import assert from "node:assert/strict";
import test from "node:test";
import { mayHaveOlder, noReadChanges, NOTIFICATION_PAGE_SIZE, olderPagePath, reconcileReadState, replaceInOlder, shownNotifications, withMark, withMarkAll, withOlderPage } from "@/features/common/notificationPages";

/* Audit B21: notifications beyond the newest 100. Synthetic notifications only, newest first. */
const all = Array.from({ length: 250 }, (_, i) => ({ id: `n${String(i).padStart(3, "0")}`, read: false }));
const page = (from) => all.slice(from, from + NOTIFICATION_PAGE_SIZE);

test("a full first page may have older notifications; a short one does not", () => {
  assert.equal(mayHaveOlder(page(0), null), true);
  assert.equal(mayHaveOlder(all.slice(0, 40), null), false);
  assert.equal(mayHaveOlder([], null), false);
});

test("older pages continue after the last notification shown, each exactly once and in order", () => {
  const first = page(0);
  assert.equal(olderPagePath(first), "/me/notifications?before=n099&limit=100");
  let older = withOlderPage(first, null, page(100), true);
  let shown = shownNotifications(first, older);
  assert.equal(olderPagePath(shown), "/me/notifications?before=n199&limit=100");
  older = withOlderPage(first, older, page(200), false);
  shown = shownNotifications(first, older);
  assert.deepEqual(shown.map((n) => n.id), all.map((n) => n.id));
  assert.equal(mayHaveOlder(first, older), false);
});

test("an overlapping reply never shows a notification twice", () => {
  const first = page(0);
  const older = withOlderPage(first, null, all.slice(95, 150), true);
  const ids = shownNotifications(first, older).map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, all.slice(0, 150).map((n) => n.id));
});

test("when the first page moves (new notifications arrived), older pages are dropped instead of leaving a gap", () => {
  const older = withOlderPage(page(0), null, page(100), true);
  const moved = [{ id: "new", read: false }, ...page(0).slice(0, 99)];
  assert.deepEqual(shownNotifications(moved, older), moved);
  assert.equal(mayHaveOlder(moved, older), true); // A full page again: older ones can be loaded afresh.
});

test("marking an older notification updates it in place", () => {
  const older = withOlderPage(page(0), null, page(100), true);
  const updated = replaceInOlder(older, { id: "n150", read: true });
  assert.equal(updated.items.find((n) => n.id === "n150").read, true);
  assert.equal(updated.items.length, 100);
  assert.equal(replaceInOlder(null, { id: "x", read: true }), null);
});

/* A page requested before a read-state change arrives after it (a delayed "Load older notifications"). */
test("a Mark All Read made while a page was loading marks that page's notifications read", () => {
  let changes = noReadChanges();
  const since = changes.seq; // The page is requested now...
  changes = withMarkAll(changes); // ...then Mark All Read succeeds before the page arrives.
  const stale = page(100).slice(0, 5); // Unread, as the server sent them before Mark All Read.
  assert.deepEqual(reconcileReadState(stale, changes, since).map((n) => n.read), [true, true, true, true, true]);
});

test("a Mark Unread made after a Mark All Read wins for that notification; earlier changes do not apply again", () => {
  let changes = withMark(noReadChanges(), "n101", true); // Before the page was requested: already in the page's data.
  const since = changes.seq;
  changes = withMarkAll(changes);
  changes = withMark(changes, "n102", false);
  const reconciled = reconcileReadState([{ id: "n101", read: true }, { id: "n102", read: false }, { id: "n103", read: false }], changes, since);
  assert.deepEqual(reconciled.map((n) => [n.id, n.read]), [["n101", true], ["n102", false], ["n103", true]]);
});

test("a page requested after every change is taken as the server sent it", () => {
  const changes = withMarkAll(withMark(noReadChanges(), "n150", true));
  const fresh = [{ id: "n150", read: false }, { id: "n151", read: false }];
  assert.deepEqual(reconcileReadState(fresh, changes, changes.seq), fresh);
});

test("merging a delayed page into the current older pages keeps a Mark Read made meanwhile, in order and without duplicates", () => {
  const first = page(0);
  const before = withOlderPage(first, null, page(100), true);
  const current = replaceInOlder(before, { id: "n150", read: true }); // Marked while the next page was loading.
  const merged = withOlderPage(first, current, page(200), false);
  const shown = shownNotifications(first, merged);
  assert.equal(shown.find((n) => n.id === "n150").read, true);
  assert.deepEqual(shown.map((n) => n.id), all.map((n) => n.id));
});
