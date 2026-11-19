/* Deterministic tests for answer saving during an assessment. Run: npm run test:unit
   A fake clock, scheduler, server and storage drive every case; nothing touches the network or a database. */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { AnswerSync, RESULT_RETRY_LIMIT, classify, loadFinalResult, retryDelay } from "../../src/features/exam/answerSync.ts";
import {
  EXPIRED_RECORD_GRACE_MS,
  STORAGE_PREFIX,
  browserStorage,
  clearPendingAnswers,
  countUnconfirmedAnswers,
  pendingStore,
  purgePendingAnswers,
} from "../../src/lib/pendingAnswers.ts";
import { parseRetryAfter } from "../../src/lib/retryAfter.ts";

const ACCOUNT = "account-a";
const ATTEMPT = "attempt-1";
const START = 1_000_000;
const DEADLINE = START + 15 * 60 * 1000;

/* ---------- fakes ---------- */

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

/** Storage that refuses every write, as a full quota or a locked-down browser does. */
class FullStorage extends MemoryStorage {
  setItem() {
    throw new Error("QuotaExceededError");
  }
}

const fail = (status, code = "ERROR", message = "Failed", retryAfterSeconds = null) => Object.assign(new Error(message), { status, code, message, retryAfterSeconds });

function harness({ storage = new MemoryStorage(), account = ACCOUNT, attempt = ATTEMPT, random = () => 0.5 } = {}) {
  let now = START;
  let timers = [];
  const calls = []; // Every request the page sent, with controls to answer it.
  const server = new Map(); // What the server has stored.
  const snapshots = [];
  const send = (questionId, selected) =>
    new Promise((resolve, reject) => {
      calls.push({
        questionId,
        selected,
        ok: () => {
          server.set(questionId, selected);
          resolve(undefined);
        },
        fail: (error) => reject(error),
      });
    });
  const store = pendingStore(storage, account, attempt, DEADLINE);
  const sync = new AnswerSync({
    send,
    now: () => now,
    deadline: DEADLINE,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    random,
    store,
    onChange: (s) => snapshots.push(s),
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    sync,
    calls,
    server,
    storage,
    store,
    snapshots,
    settle,
    timers: () => timers,
    /** Moves the clock and runs every timer that falls due. */
    advance: async (ms) => {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((t) => t !== timer);
        timer.run();
      }
      await settle();
    },
    setNow: (value) => {
      now = value;
    },
    last: () => snapshots.at(-1),
    stored: () => JSON.parse(storage.getItem(`${STORAGE_PREFIX}${account}:${attempt}`) ?? "null"),
  };
}

/* ---------- 1. Saving: success, retryable and non-retryable failures ---------- */

describe("saving answers", () => {
  test("success: the answer is removed only after the server confirms it", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    await h.settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.last().status, "saving");
    assert.equal(h.sync.unsaved(), 1);
    h.calls[0].ok();
    await h.settle();
    assert.equal(h.last().status, "saved");
    assert.equal(h.sync.unsaved(), 0);
    assert.deepEqual(h.server.get("q1"), ["a"]);
    assert.equal(h.stored(), null, "the durable copy is removed once confirmed");
  });

  for (const [label, error, kind] of [
    ["network failure", fail(0, "NETWORK_ERROR"), "network"],
    ["HTTP 500", fail(500, "INTERNAL_ERROR"), "server"],
    ["HTTP 503", fail(503, "SERVICE_UNAVAILABLE"), "server"],
  ]) {
    test(`${label}: stays queued, never reported as saved, and is retried with backoff`, async () => {
      const h = harness();
      h.sync.set("q1", ["a"]);
      await h.settle();
      h.calls[0].fail(error);
      await h.settle();
      const snap = h.last();
      assert.equal(snap.status, "retrying");
      assert.equal(snap.failure, kind);
      assert.equal(snap.unsaved, 1);
      assert.ok(h.snapshots.every((s) => s.status !== "saved"), "never shown as saved");
      assert.equal(snap.retryAt - START, retryDelay(1, () => 0.5)); // 750 ms: half of 1 s plus jitter.
      await h.advance(749);
      assert.equal(h.calls.length, 1, "no retry before the delay");
      await h.advance(1);
      assert.equal(h.calls.length, 2, "retried after the delay");
      h.calls[1].ok();
      await h.settle();
      assert.equal(h.last().status, "saved");
    });
  }

  test("HTTP 429 waits for Retry-After instead of the shorter backoff, and flush does not skip it", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    await h.settle();
    h.calls[0].fail(fail(429, "RATE_LIMITED", "Too many requests.", 20));
    await h.settle();
    assert.equal(h.last().failure, "rate-limited");
    assert.equal(h.last().retryAt - START, 20_000);
    const outcome = await h.sync.flush();
    assert.deepEqual(outcome, { ok: false, kind: "rate-limited", unsaved: 1, message: "Too many requests." });
    h.sync.retryNow(); // Coming back online must not skip Retry-After either.
    await h.advance(19_999);
    assert.equal(h.calls.length, 1);
    await h.advance(1);
    assert.equal(h.calls.length, 2);
  });

  test("backoff grows exponentially, is bounded, and uses jitter", () => {
    assert.equal(retryDelay(1, () => 0), 500);
    assert.equal(retryDelay(1, () => 1), 1000);
    assert.equal(retryDelay(3, () => 0), 2000);
    assert.equal(retryDelay(30, () => 1), 30_000, "never above the cap");
    assert.equal(retryDelay(1, () => 0, 10), 10_000, "Retry-After wins when longer");
    assert.equal(retryDelay(1, () => 0, 100_000), 120_000, "an absurd Retry-After is bounded");
  });

  test("Retry-After is read as seconds or as an HTTP date", () => {
    assert.equal(parseRetryAfter("7", 0), 7);
    assert.equal(parseRetryAfter(new Date(30_000).toUTCString(), 0), 30);
    assert.equal(parseRetryAfter(null, 0), null);
    assert.equal(parseRetryAfter("soon", 0), null);
  });

  test("failures are classified explicitly", () => {
    assert.deepEqual(classify(fail(0)), { kind: "network", retry: true });
    assert.deepEqual(classify(fail(429)), { kind: "rate-limited", retry: true });
    assert.deepEqual(classify(fail(502)), { kind: "server", retry: true });
    assert.deepEqual(classify(fail(401, "UNAUTHENTICATED")), { kind: "signed-out", retry: false });
    assert.deepEqual(classify(fail(403, "FORBIDDEN")), { kind: "forbidden", retry: false });
    assert.deepEqual(classify(fail(400, "VALIDATION_ERROR")), { kind: "rejected", retry: false });
    assert.deepEqual(classify(fail(409, "ATTEMPT_ALREADY_SUBMITTED")), { kind: "closed", retry: false });
    assert.deepEqual(classify(fail(501)), { kind: "rejected", retry: false });
  });

  test("validation refusal: not retried, not shown as saved, explained, and cleared by a new choice", async () => {
    const h = harness();
    h.sync.set("q1", ["bad"]);
    await h.settle();
    h.calls[0].fail(fail(400, "VALIDATION_ERROR", "That answer does not belong to this question."));
    await h.settle();
    assert.equal(h.last().status, "unsaved");
    assert.equal(h.last().message, "That answer does not belong to this question.");
    assert.equal(h.sync.unsaved(), 1);
    await h.advance(60_000);
    assert.equal(h.calls.length, 1, "never retried");
    const outcome = await h.sync.flush();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "rejected");
    h.sync.set("q1", ["good"]);
    await h.settle();
    h.calls[1].ok();
    await h.settle();
    assert.equal(h.last().status, "saved");
    assert.deepEqual(await h.sync.flush(), { ok: true });
  });

  for (const [label, error, kind] of [
    ["signed out (401)", fail(401, "UNAUTHENTICATED", "Sign in again."), "signed-out"],
    ["permission (403)", fail(403, "FORBIDDEN", "Not allowed."), "forbidden"],
  ]) {
    test(`${label}: stops, keeps the answer queued and stored, and never claims success`, async () => {
      const h = harness();
      h.sync.set("q1", ["a"]);
      await h.settle();
      h.calls[0].fail(error);
      await h.settle();
      assert.equal(h.last().status, "unsaved");
      assert.equal(h.last().failure, kind);
      await h.advance(120_000);
      assert.equal(h.calls.length, 1, "not retried indefinitely");
      assert.deepEqual(h.stored().entries.map((e) => e.q), ["q1"], "kept for recovery by the same account");
      const outcome = await h.sync.flush();
      assert.equal(outcome.ok, false);
      assert.equal(outcome.kind, kind);
    });
  }

  test("expired attempt (409 ATTEMPT_ALREADY_SUBMITTED): closes and reports unsaved answers", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    await h.settle();
    h.calls[0].fail(fail(409, "ATTEMPT_ALREADY_SUBMITTED", "Time has expired."));
    await h.settle();
    assert.equal(h.last().status, "closed");
    assert.equal(h.last().message, "Time has expired.", "the server's reason is kept for the page");
    assert.equal(h.sync.unsaved(), 1);
    assert.equal(h.sync.set("q2", ["b"]), false, "no new answers after closing");
    assert.equal((await h.sync.flush()).ok, false);
  });

  test("rapid changes during an in-flight save: one request at a time, the newest choice wins", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    await h.settle();
    h.sync.set("q1", ["b"]);
    h.sync.set("q1", ["c"]);
    await h.settle();
    assert.equal(h.calls.length, 1, "serialized: no overlapping request");
    h.calls[0].ok(); // The delayed reply for "a" arrives now.
    await h.settle();
    assert.equal(h.sync.unsaved(), 1, "the reply for an older choice does not remove the newer one");
    assert.notEqual(h.last().status, "saved");
    assert.deepEqual(h.stored().entries, [{ q: "q1", s: ["c"], n: 3 }]);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].selected, ["c"], "only the latest choice is sent next");
    h.calls[1].ok();
    await h.settle();
    assert.deepEqual(h.server.get("q1"), ["c"]);
    assert.equal(h.last().status, "saved");
  });
});

/* ---------- 2. Manual submission ---------- */

describe("flush before submitting", () => {
  test("resolves only after every pending answer is confirmed, including choices made during the flush", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    h.sync.set("q2", ["b"]);
    let outcome = null;
    void h.sync.flush().then((o) => (outcome = o));
    await h.settle();
    h.sync.set("q3", ["c"]); // Chosen while the flush is running.
    h.calls[0].ok();
    await h.settle();
    h.calls[1].ok();
    await h.settle();
    assert.equal(outcome, null, "not finished while q3 is unsaved");
    h.calls[2].ok();
    await h.settle();
    assert.deepEqual(outcome, { ok: true });
  });

  test("a failed save reports failure at once, keeps the answers, and retries continue", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    const outcome = h.sync.flush();
    await h.settle();
    h.calls[0].fail(fail(0, "NETWORK_ERROR", "TrainCheck could not be reached."));
    assert.deepEqual(await outcome, { ok: false, kind: "network", unsaved: 1, message: "TrainCheck could not be reached." });
    assert.equal(h.sync.unsaved(), 1);
    await h.advance(1000);
    assert.equal(h.calls.length, 2, "still retrying in the background");
  });

  test("flush during a backoff retries immediately instead of waiting", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    await h.settle();
    h.calls[0].fail(fail(503));
    await h.settle();
    const outcome = h.sync.flush();
    await h.settle();
    assert.equal(h.calls.length, 2);
    h.calls[1].ok();
    assert.deepEqual(await outcome, { ok: true });
  });

  test("locked during submission: new choices are refused", async () => {
    const h = harness();
    h.sync.lock();
    assert.equal(h.sync.set("q1", ["a"]), false);
    h.sync.unlock();
    assert.equal(h.sync.set("q1", ["a"]), true);
  });

  test("flush with nothing pending succeeds at once", async () => {
    assert.deepEqual(await harness().sync.flush(), { ok: true });
  });
});

/* ---------- 3. Deadline ---------- */

describe("the deadline", () => {
  test("no new answers are accepted at the server deadline", async () => {
    const h = harness();
    h.setNow(DEADLINE);
    assert.equal(h.sync.set("q1", ["a"]), false);
    assert.equal(h.last().closed, "expired");
  });

  test("timeout while answers are queued in backoff: nothing is sent late and the unsaved answers are counted", async () => {
    const h = harness();
    h.setNow(DEADLINE - 2000);
    h.sync.set("q1", ["a"]);
    h.sync.set("q2", ["b"]);
    await h.settle();
    h.calls[0].fail(fail(0));
    await h.settle();
    assert.ok(h.timers()[0].at <= DEADLINE, "a retry wait never runs past the deadline");
    h.setNow(DEADLINE);
    h.sync.close("expired");
    await h.advance(60_000);
    assert.equal(h.calls.length, 1, "no request after the deadline");
    assert.equal(h.sync.unsaved(), 2);
    assert.deepEqual(await h.sync.flush(), { ok: false, kind: "expired", unsaved: 2, message: null });
  });

  test("timeout during an in-flight save: the page waits for it, and a confirmation still counts", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    h.sync.set("q2", ["b"]);
    await h.settle();
    h.setNow(DEADLINE);
    h.sync.close("expired");
    let settled = false;
    void h.sync.settled().then(() => (settled = true));
    await h.settle();
    assert.equal(settled, false, "the in-flight save is still awaited");
    h.calls[0].ok(); // The server accepted it before its deadline.
    await h.settle();
    assert.equal(settled, true);
    assert.equal(h.calls.length, 1, "q2 is not sent after the deadline");
    assert.equal(h.sync.unsaved(), 1, "only q2 is unsaved");
  });

  test("an in-flight save refused by the server after the deadline stays counted as unsaved", async () => {
    const h = harness();
    h.sync.set("q1", ["a"]);
    await h.settle();
    h.sync.close("expired");
    h.calls[0].fail(fail(409, "ATTEMPT_ALREADY_SUBMITTED"));
    await h.sync.settled();
    assert.equal(h.sync.unsaved(), 1);
  });

  test("the final result is retried on temporary failures and when the server is not ready yet", async () => {
    const waits = [];
    let tries = 0;
    const result = await loadFinalResult(
      async () => {
        tries++;
        if (tries === 1) throw fail(0);
        if (tries === 2) throw fail(409, "RESULT_NOT_READY");
        if (tries === 3) throw fail(503);
        return { score: 80 };
      },
      async (ms) => waits.push(ms),
      () => 0.5,
    );
    assert.deepEqual(result, { ok: true, result: { score: 80 } });
    assert.equal(waits.length, 3);
    assert.ok(waits[1] > waits[0] && waits[2] > waits[1], "backs off");
  });

  test("the final result gives up after a bounded number of tries, and at once on a permanent error", async () => {
    let tries = 0;
    const bounded = await loadFinalResult(async () => {
      tries++;
      throw fail(503);
    }, async () => {}, () => 0);
    assert.equal(bounded.ok, false);
    assert.equal(tries, RESULT_RETRY_LIMIT);
    tries = 0;
    const permanent = await loadFinalResult(async () => {
      tries++;
      throw fail(404, "NOT_FOUND");
    }, async () => {}, () => 0);
    assert.equal(permanent.ok, false);
    assert.equal(tries, 1);
  });
});

/* ---------- 4. Recovery after refresh or a closed browser ---------- */

const QUESTIONS = [
  { attempt_question_id: "q1", option_ids: ["a", "b"], selected_option_ids: [] },
  { attempt_question_id: "q2", option_ids: ["c", "d"], selected_option_ids: ["c"] },
  { attempt_question_id: "q3", option_ids: ["e", "f"], selected_option_ids: [] },
];

describe("recovery", () => {
  let storage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  test("stores only question IDs, option IDs and order, scoped to the account and attempt", async () => {
    const h = harness({ storage });
    h.sync.set("q1", ["a"]);
    const record = h.stored();
    assert.deepEqual(Object.keys(record).sort(), ["account", "attempt", "entries", "expiresAt", "v"]);
    assert.deepEqual(record.entries, [{ q: "q1", s: ["a"], n: 1 }]);
    assert.equal(record.account, ACCOUNT);
    assert.equal(record.attempt, ATTEMPT);
    assert.ok(![...storage.map.values()].some((v) => /csrf|token|password|answer_key|question_text/i.test(v)));
  });

  test("refresh: unconfirmed choices are restored, reconciled with the server, and sent", async () => {
    const first = harness({ storage });
    first.sync.set("q1", ["a"]);
    first.sync.set("q2", ["c"]); // The server already holds this one (saved before the page closed).
    first.sync.set("q3", ["f"]);
    await first.settle(); // The page closes before any reply.

    const second = harness({ storage });
    const shown = second.sync.restore(QUESTIONS);
    assert.deepEqual(shown, { q1: ["a"], q3: ["f"] }, "already-saved choices are not resent");
    second.sync.start();
    await second.settle();
    assert.deepEqual(second.calls.map((c) => c.questionId), ["q1"]);
    second.calls[0].ok();
    await second.settle();
    second.calls[1].ok();
    await second.settle();
    assert.equal(second.last().status, "saved");
    assert.equal(second.stored(), null);
    second.sync.set("q1", ["b"]);
    assert.equal(second.stored().entries[0].n, 4, "ordering continues after the restored choices");
  });

  test("restored choices for options that are not in the question are ignored", async () => {
    harness({ storage }).sync.set("q1", ["zzz"]);
    const h = harness({ storage });
    assert.deepEqual(h.sync.restore(QUESTIONS), {});
  });

  test("account isolation: another account never receives recovered answers", async () => {
    harness({ storage, account: "account-a" }).sync.set("q1", ["a"]);
    const other = harness({ storage, account: "account-b" });
    assert.deepEqual(other.sync.restore(QUESTIONS), {});
    // A record copied under another account's key is rejected and removed.
    const record = JSON.parse(storage.getItem(`${STORAGE_PREFIX}account-a:${ATTEMPT}`));
    storage.setItem(`${STORAGE_PREFIX}account-b:${ATTEMPT}`, JSON.stringify(record));
    assert.deepEqual(harness({ storage, account: "account-b" }).sync.restore(QUESTIONS), {});
    assert.equal(storage.getItem(`${STORAGE_PREFIX}account-b:${ATTEMPT}`), null);
    // Signing in as account-b removes account-a's records from this browser.
    purgePendingAnswers(storage, "account-b", START);
    assert.equal(storage.getItem(`${STORAGE_PREFIX}account-a:${ATTEMPT}`), null);
  });

  test("attempt isolation: another attempt's record is never used", async () => {
    harness({ storage, attempt: "attempt-1" }).sync.set("q1", ["a"]);
    assert.deepEqual(harness({ storage, attempt: "attempt-2" }).sync.restore(QUESTIONS), {});
  });

  test("corrupted storage is discarded without crashing", async () => {
    storage.setItem(`${STORAGE_PREFIX}${ACCOUNT}:${ATTEMPT}`, "{not json");
    const h = harness({ storage });
    assert.deepEqual(h.sync.restore(QUESTIONS), {});
    assert.equal(storage.getItem(`${STORAGE_PREFIX}${ACCOUNT}:${ATTEMPT}`), null);
    storage.setItem(`${STORAGE_PREFIX}${ACCOUNT}:${ATTEMPT}`, JSON.stringify({ v: 1, account: ACCOUNT, attempt: ATTEMPT, expiresAt: DEADLINE, entries: [{ q: 1 }] }));
    assert.deepEqual(harness({ storage }).sync.restore(QUESTIONS), {});
  });

  test("full or unavailable storage: saving still works, but recovery is not promised", async () => {
    for (const store of [new FullStorage(), null]) {
      const h = harness({ storage: store });
      assert.equal(h.store.available, false);
      h.sync.set("q1", ["a"]);
      assert.equal(h.last().durable, false, "the page must not promise recovery");
      await h.settle();
      h.calls[0].ok();
      await h.settle();
      assert.equal(h.last().status, "saved");
    }
  });

  test("storage that fills up mid-attempt is reported as not durable", async () => {
    const h = harness({ storage });
    h.sync.set("q1", ["a"]);
    assert.equal(h.last().durable, true);
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    h.sync.set("q2", ["c"]);
    assert.equal(h.last().durable, false);
  });

  test("cleanup after finalization, sign-out and expiry", async () => {
    const h = harness({ storage });
    h.sync.set("q1", ["a"]);
    h.sync.forget(); // After a confirmed submission or a shown result.
    assert.equal(storage.length, 0);

    harness({ storage }).sync.set("q1", ["a"]);
    purgePendingAnswers(storage, null, START); // Sign-out.
    assert.equal(storage.length, 0);

    harness({ storage }).sync.set("q1", ["a"]);
    purgePendingAnswers(storage, ACCOUNT, DEADLINE + 1000);
    assert.equal(storage.length, 1, "kept briefly after expiry so the result page can explain");
    purgePendingAnswers(storage, ACCOUNT, DEADLINE + EXPIRED_RECORD_GRACE_MS + 1);
    assert.equal(storage.length, 0, "removed once the grace period ends");
  });

  test("the result page can read how many choices were never confirmed, then clear them", async () => {
    const h = harness({ storage });
    h.sync.set("q1", ["a"]);
    h.sync.set("q3", ["e"]);
    assert.equal(countUnconfirmedAnswers(storage, "account-b", ATTEMPT), null, "not another account");
    assert.equal(countUnconfirmedAnswers(storage, ACCOUNT, ATTEMPT), 2);
    assert.equal(countUnconfirmedAnswers(storage, ACCOUNT, ATTEMPT), 2, "reading does not remove");
    clearPendingAnswers(storage, ACCOUNT, ATTEMPT);
    assert.equal(countUnconfirmedAnswers(storage, ACCOUNT, ATTEMPT), null);
    assert.equal(countUnconfirmedAnswers(null, ACCOUNT, ATTEMPT), null);
    clearPendingAnswers(new FullStorage(), ACCOUNT, ATTEMPT); // Never throws.
  });

  test("outside a browser there is no storage, and nothing is promised", () => {
    assert.equal(browserStorage(), null);
  });
});
