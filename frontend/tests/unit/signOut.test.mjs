import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "@/lib/api";
import { pendingStore, purgePendingAnswers, stopPendingAnswerQueues } from "../../src/lib/pendingAnswers.ts";
import { signOutFlow } from "@/lib/signOut";

/* Sign-out leaves the workspace only once the server confirms the session is over. Synthetic data only. */

function steps(logout) {
  const calls = [];
  return {
    calls,
    steps: {
      stopAnswerQueues: () => calls.push("stop"),
      logout: async () => {
        calls.push("logout");
        return logout();
      },
      finish: () => calls.push("finish"),
    },
  };
}

test("a successful sign-out stops answer queues first, then clears and redirects", async () => {
  const { calls, steps: s } = steps(() => ({ signed_out: true }));
  assert.equal(await signOutFlow(s), "SIGNED_OUT");
  assert.deepEqual(calls, ["stop", "logout", "finish"]);
});

test("a session that had already ended counts as signed out", async () => {
  const { calls, steps: s } = steps(() => {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in again.");
  });
  assert.equal(await signOutFlow(s), "SESSION_ALREADY_ENDED");
  assert.deepEqual(calls, ["stop", "logout", "finish"]);
});

for (const [name, error] of [
  ["a server error", new ApiError(503, "SERVICE_UNAVAILABLE", "TrainCheck is temporarily unavailable.")],
  ["a network failure", new ApiError(0, "NETWORK_ERROR", "TrainCheck could not be reached.")],
  ["a timeout", new ApiError(0, "TIMEOUT", "TrainCheck did not reply in time.")],
  ["a refused request (the session is still valid)", new ApiError(403, "CSRF_FAILED", "Your session needs refreshing.")],
]) {
  test(`after ${name} nothing is cleared, nothing redirects, and the error is reported`, async () => {
    const { calls, steps: s } = steps(() => {
      throw error;
    });
    await assert.rejects(signOutFlow(s), (thrown) => thrown === error);
    assert.deepEqual(calls, ["stop", "logout"]);
  });
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

test("stopping queues keeps saved answers (a failed sign-out loses nothing); the purge after a confirmed sign-out removes them", () => {
  const storage = new MemoryStorage();
  const deadline = Date.now() + 60_000;
  const live = pendingStore(storage, "synthetic-account", "synthetic-attempt", deadline);
  assert.equal(live.save([{ q: "q1", s: ["o1"], n: 1 }]), true);
  stopPendingAnswerQueues(null);
  assert.equal(live.revoked, true); // A save finishing now cannot write the record back...
  assert.equal(live.save([{ q: "q1", s: ["o2"], n: 2 }]), false);
  assert.equal(storage.length, 1); // ...but what was saved is still here, in case the sign-out fails.
  const afterReload = pendingStore(storage, "synthetic-account", "synthetic-attempt", deadline);
  assert.deepEqual(afterReload.load().map((e) => e.s), [["o1"]]); // Reloading to stay signed in restores it.
  purgePendingAnswers(storage, null, Date.now());
  assert.equal(storage.length, 0);
});
