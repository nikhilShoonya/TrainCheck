/* Regression tests for answer-saving defects: full storage, hanging requests, invalid HTTP 200 replies, late
   callbacks after logout or unmount, and two tabs overwriting each other. Run: npm run test:unit
   A fake clock, a fake compare-and-set server that follows the backend's rules, fake storage and a mocked
   fetch drive every case; nothing touches the network or a database. */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { AnswerSync, loadFinalResult } from "../../src/features/exam/answerSync.ts";
import { answerSender, parseAnswerAck } from "@/features/exam/answerSave";
import { ApiError, api, onApiMutation } from "@/lib/api";
import { STORAGE_PREFIX, clearPendingAnswers, onPendingAnswersRevoked, pendingStore, purgePendingAnswers } from "../../src/lib/pendingAnswers.ts";

const ACCOUNT = "account-a";
const ATTEMPT = "attempt-1";
const START = 1_000_000;
const DEADLINE = START + 15 * 60 * 1000;
const TIMEOUT = 20_000;
const KEY = (account = ACCOUNT, attempt = ATTEMPT) => `${STORAGE_PREFIX}${account}:${attempt}`;

/* ---------- fakes ---------- */

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.full = false; // Every new write fails, as a full quota does. Reading and removing still work.
    this.unreadable = false;
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    if (this.unreadable) throw new Error("SecurityError");
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    if (this.full || this.unreadable) throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
    this.map.set(k, String(v));
  }
  removeItem(k) {
    if (this.unreadable) throw new Error("SecurityError");
    this.map.delete(k);
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

class Clock {
  constructor(now = START) {
    this.now = now;
    this.timers = [];
    this.schedule = (run, ms) => {
      const timer = { at: this.now + ms, run };
      this.timers.push(timer);
      return () => {
        this.timers = this.timers.filter((t) => t !== timer);
      };
    };
  }
  /** Moves the clock, running every timer that falls due, in order. */
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = Math.max(this.now, due.at);
      this.timers = this.timers.filter((t) => t !== due);
      due.run();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** Follows backend/app/modules/assessment/service.py save_answer: idempotent for the stored selection,
    compare-and-set when a base revision is given, unconditional otherwise; keeps the operation ID of the save
    that wrote the current revision and reports it on a conflict. */
class Server {
  constructor(questions = { q1: ["a", "b", "c", "d"], q2: ["e", "f"], q3: ["g", "h"] }) {
    this.options = questions;
    this.answers = new Map();
  }
  view(q) {
    const a = this.answers.get(q);
    return { selected: a ? [...a.selected] : [], revision: a ? a.revision : 0 };
  }
  /** The operation ID of the save that wrote the current answer. */
  opOf(q) {
    return this.answers.get(q)?.op ?? null;
  }
  questions() {
    return Object.entries(this.options).map(([q, option_ids]) => ({ attempt_question_id: q, option_ids, selected_option_ids: this.view(q).selected, revision: this.view(q).revision, op_id: this.opOf(q) }));
  }
  put(q, selected, base, op = null) {
    const clean = [...new Set(selected)];
    const current = this.view(q);
    const ack = () => ({ ok: true, data: { saved_at: "2026-11-19T10:00:00Z", selected_option_ids: this.view(q).selected, revision: this.view(q).revision, op_id: this.opOf(q) } });
    if (this.answers.has(q) && sameSet(current.selected, clean)) return ack();
    if (base !== null && base !== undefined && base !== current.revision) {
      const details = { selected_option_ids: current.selected, revision: current.revision, op_id: this.opOf(q) };
      return { ok: false, error: Object.assign(new Error("This answer was changed in another window or on another device. The newer answer is kept."), { status: 409, code: "ANSWER_CONFLICT", details }) };
    }
    this.answers.set(q, { selected: clean, revision: current.revision + 1, op });
    return ack();
  }
}

let pages = 0;

/** One open page: a saving queue with a controllable transport. */
function page({ clock, server = new Server(), storage = new MemoryStorage(), account = ACCOUNT, attempt = ATTEMPT, send } = {}) {
  const calls = [];
  const snapshots = [];
  const conflicts = [];
  const store = pendingStore(storage, account, attempt, DEADLINE);
  const transport = (q, selected, { baseRevision, signal, opId }) =>
    new Promise((resolve, reject) => {
      const call = {
        q,
        selected,
        base: baseRevision,
        op: opId,
        signal,
        result: null,
        /** The request reaches the server (which acts on it), but no reply yet. */
        arrive() {
          call.result = server.put(q, selected, baseRevision, opId);
          return call;
        },
        /** The reply reaches the page. */
        reply() {
          const r = call.result ?? call.arrive().result;
          if (r.ok) resolve(r.data);
          else reject(r.error);
        },
        fail: (error) => reject(error),
      };
      calls.push(call);
    });
  const sync = new AnswerSync({
    send: send ?? transport,
    now: () => clock.now,
    deadline: DEADLINE,
    schedule: clock.schedule,
    random: () => 0.5,
    store,
    onChange: (s) => snapshots.push(s),
    onConflict: (q, s) => conflicts.push([q, s]),
    requestTimeoutMs: TIMEOUT,
    newOpId: ((id, n) => () => `op-page${id}-${++n}`)(++pages, 0), // Unique per page, as random IDs are.
  });
  return {
    sync,
    calls,
    snapshots,
    conflicts,
    store,
    storage,
    server,
    last: () => snapshots.at(-1),
    stored: () => JSON.parse(storage.map.get(KEY(account, attempt)) ?? "null"),
    open: () => calls.filter((c) => !c.result),
  };
}

const writeRecord = (storage, entries, account = ACCOUNT, attempt = ATTEMPT) =>
  storage.map.set(KEY(account, attempt), JSON.stringify({ v: 1, account, attempt, expiresAt: DEADLINE, entries }));

/* ---------- mocked fetch for the real API client ---------- */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch; every request is recorded with its parsed JSON body. */
function mockFetch(reply) {
  const requests = [];
  globalThis.fetch = (url, init = {}) => {
    const request = { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    requests.push(request);
    return reply(request);
  };
  return requests;
}

const respond = (body, status = 200, headers = {}) => Promise.resolve(new Response(body, { status, headers }));

/** Paths the API client reported as changed (cached screens refresh on these). */
let mutations = [];
onApiMutation((path) => mutations.push(path));

/* ==================== 1. Recovery when browser storage is full ==================== */

describe("full browser storage", () => {
  test("an existing pending record is restored and sent although every new write fails with QuotaExceededError", async () => {
    const clock = new Clock();
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1, b: 0 }, { q: "q2", s: ["e"], n: 2, b: 0 }]);
    storage.full = true;

    const p = page({ clock, storage });
    assert.equal(p.store.available, false, "the write probe fails");
    assert.equal(p.store.readable, true, "but the record can still be read");
    const shown = p.sync.restore(p.server.questions());
    assert.deepEqual(shown, { q1: ["a"], q2: ["e"] });
    assert.equal(p.last().status, "saving", "recovered answers are not shown as saved");
    assert.equal(p.last().durable, true, "they are still held by the stored record");
    p.sync.start();
    await settle();
    p.calls[0].reply();
    await settle();
    assert.equal(p.last().status, "saving", "one recovered answer is still unconfirmed");
    assert.ok(p.snapshots.every((s) => s.status !== "saved"), "never 'saved' while a recovered answer is unconfirmed");
    p.calls[1].reply();
    await settle();
    assert.equal(p.last().status, "saved");
    assert.deepEqual(p.server.view("q1").selected, ["a"]);
    assert.equal(storage.map.has(KEY()), false, "cleanup removes the record although writes fail");
  });

  test("a new choice that cannot be written removes the outdated stored copy and is reported as not durable", async () => {
    const clock = new Clock();
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1, b: 0 }]);
    storage.full = true;
    const p = page({ clock, storage });
    p.sync.restore(p.server.questions());
    assert.equal(p.last().durable, true);
    p.sync.set("q1", ["b"]); // Replaces the recovered choice; storage cannot record it.
    assert.equal(p.last().durable, false, "the page must not promise recovery");
    assert.equal(storage.map.has(KEY()), false, "the stale stored choice is removed so a refresh cannot restore it");
    assert.notEqual(p.last().status, "saved");
  });

  test("a new question that cannot be written is reported as not durable; the stored record keeps the others", async () => {
    const clock = new Clock();
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1, b: 0 }]);
    storage.full = true;
    const p = page({ clock, storage });
    p.sync.restore(p.server.questions());
    p.sync.set("q2", ["f"]);
    assert.equal(p.last().durable, false);
    assert.deepEqual(p.stored().entries.map((e) => e.q), ["q1"], "the recoverable answer is not thrown away");
  });

  test("cleanup is attempted even when writes fail", () => {
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1 }]);
    storage.full = true;
    pendingStore(storage, ACCOUNT, ATTEMPT, DEADLINE).clear();
    assert.equal(storage.map.has(KEY()), false, "clear() removes it");
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1 }]);
    const p = page({ clock: new Clock(), storage });
    p.sync.forget();
    assert.equal(storage.map.has(KEY()), false, "forget() removes it");
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1 }]);
    purgePendingAnswers(storage, null, START);
    assert.equal(storage.length, 0, "sign-out removes it");
  });

  test("storage that cannot even be read: nothing restored, nothing promised, no crash", async () => {
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1 }]);
    storage.unreadable = true;
    const p = page({ clock: new Clock(), storage });
    assert.equal(p.store.readable, false);
    assert.deepEqual(p.sync.restore(p.server.questions()), {});
    p.sync.set("q1", ["b"]);
    assert.equal(p.last().durable, false);
  });
});

/* ==================== 2. Hanging requests ==================== */

describe("requests that never finish", () => {
  test("a save that never replies times out, is retried, and is never shown as saved", async () => {
    const clock = new Clock();
    const p = page({ clock });
    p.sync.set("q1", ["a"]);
    await settle();
    await clock.advance(TIMEOUT - 1);
    assert.equal(p.last().status, "saving");
    await clock.advance(1);
    assert.equal(p.calls[0].signal.aborted, true, "the hanging request is cancelled");
    assert.equal(p.last().status, "retrying");
    assert.equal(p.last().failure, "timeout");
    await clock.advance(750);
    assert.equal(p.calls.length, 2, "retried after the backoff");
    assert.ok(p.snapshots.every((s) => s.status !== "saved"), "never 'saved' before a confirmation");
    p.calls[1].reply();
    await settle();
    assert.equal(p.last().status, "saved");
  });

  test("API client: a request that never resolves fails with TIMEOUT and cancels fetch", async () => {
    const requests = mockFetch(() => new Promise(() => {}));
    await assert.rejects(api.get("/slow", { timeoutMs: 30 }), (e) => e instanceof ApiError && e.code === "TIMEOUT" && e.status === 0);
    assert.equal(requests[0].signal.aborted, true);
  });

  test("API client: a reply whose body stalls fails with TIMEOUT", async () => {
    mockFetch(() => respond(new ReadableStream({ start() {} }), 200, { "Content-Type": "application/json" }));
    const started = Date.now();
    await assert.rejects(api.put("/attempts/x/questions/q1/answer", { selected_option_ids: ["a"] }, { timeoutMs: 50 }), (e) => e.code === "TIMEOUT");
    assert.ok(Date.now() - started < 2000, "bounded by the timeout");
  });

  test("API client: an AbortSignal cancels the request", async () => {
    const requests = mockFetch(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = api.get("/slow", { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    await assert.rejects(pending, (e) => e.code === "ABORTED");
    assert.equal(requests[0].signal.aborted, true);
  });

  test("timeout during submission: the flush reports the timeout, keeps the answer queued and stored", async () => {
    const clock = new Clock();
    const p = page({ clock });
    p.sync.set("q1", ["a"]);
    let outcome = null;
    void p.sync.flush().then((o) => (outcome = o));
    await settle();
    assert.equal(outcome, null);
    await clock.advance(TIMEOUT);
    assert.deepEqual(outcome, { ok: false, kind: "timeout", unsaved: 1, message: "TrainCheck did not reply in time, so this answer is not confirmed yet." });
    assert.equal(p.sync.unsaved(), 1);
    assert.deepEqual(p.stored().entries.map((e) => e.q), ["q1"], "kept for recovery");
  });

  test("timeout during result loading: each try is abandoned and the whole process stays within its budget", async () => {
    const clock = new Clock();
    const signals = [];
    let result = null;
    void loadFinalResult(
      (signal) => {
        signals.push(signal);
        return new Promise(() => {}); // Never settles.
      },
      (ms) => new Promise((resolve) => clock.schedule(resolve, ms)),
      () => 0.5,
      { now: () => clock.now, schedule: clock.schedule, tryTimeoutMs: 15_000, budgetMs: 45_000 },
    ).then((r) => (result = r));
    for (let i = 0; i < 20 && result === null; i++) await clock.advance(5_000);
    assert.ok(result, "finished although no request ever settled");
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, "TIMEOUT");
    assert.ok(clock.now - START <= 45_000, `within the budget (${clock.now - START} ms)`);
    assert.ok(signals.length >= 2 && signals.every((s) => s.aborted), "every abandoned request is cancelled");
  });

  test("result loading does not start a wait that would overrun its budget", async () => {
    const clock = new Clock();
    let tries = 0;
    let result = null;
    void loadFinalResult(
      async () => {
        tries++;
        throw Object.assign(new Error("Busy"), { status: 503, code: "SERVICE_UNAVAILABLE" });
      },
      (ms) => new Promise((resolve) => clock.schedule(resolve, ms)),
      () => 1,
      { now: () => clock.now, schedule: clock.schedule, budgetMs: 2_500 },
    ).then((r) => (result = r));
    for (let i = 0; i < 10 && result === null; i++) await clock.advance(1_000);
    assert.equal(result.ok, false);
    assert.ok(clock.now - START <= 2_500);
    assert.ok(tries >= 2 && tries < 6);
  });

  test("a timed-out save that did reach the server: the newer choice builds on it instead of being refused", async () => {
    const clock = new Clock();
    const server = new Server();
    const p = page({ clock, server });
    p.sync.restore(server.questions());
    p.sync.set("q1", ["a"]);
    await settle();
    p.calls[0].arrive(); // Stored by the server (revision 1); the reply is lost.
    await clock.advance(TIMEOUT);
    assert.equal(p.last().failure, "timeout");
    p.sync.set("q1", ["b"]);
    await clock.advance(750);
    assert.equal(p.calls[1].base, 0);
    p.calls[1].reply(); // Refused: the answer moved on, to this page's own "a".
    await settle();
    assert.deepEqual(p.conflicts, [], "recognised as this page's own save, not another window's");
    assert.equal(p.calls[2].base, 1, "the latest choice is sent again on top of it");
    p.calls[2].reply();
    await settle();
    assert.deepEqual(server.view("q1"), { selected: ["b"], revision: 2 });
    assert.equal(p.last().status, "saved");
  });

  test("a timed-out older save arriving after a newer one cannot overwrite it", async () => {
    const clock = new Clock();
    const server = new Server();
    const p = page({ clock, server });
    p.sync.restore(server.questions());
    p.sync.set("q1", ["a"]);
    await settle();
    await clock.advance(TIMEOUT); // "a" is stuck somewhere on the network.
    p.sync.set("q1", ["b"]);
    await clock.advance(750);
    p.calls[1].reply();
    await settle();
    assert.deepEqual(server.view("q1"), { selected: ["b"], revision: 1 });
    p.calls[0].arrive(); // The delayed request finally reaches the server.
    assert.equal(p.calls[0].result.ok, false, "refused by the revision check");
    assert.deepEqual(server.view("q1").selected, ["b"], "the newer choice is kept");
    assert.equal(p.last().status, "saved");
  });

  test("the deadline is never extended: a timed-out save is not retried after it", async () => {
    const clock = new Clock(DEADLINE - 5_000);
    const p = page({ clock });
    p.sync.set("q1", ["a"]);
    await settle();
    await clock.advance(TIMEOUT);
    await clock.advance(60_000);
    assert.equal(p.calls.length, 1, "nothing sent after the deadline");
    assert.equal(p.sync.set("q2", ["e"]), false);
    assert.equal((await p.sync.flush()).kind, "expired");
  });
});

/* ==================== 3. Invalid HTTP 200 replies, through the real API client ==================== */

describe("invalid HTTP 200 replies (API client → answerSender → queue)", () => {
  const goodAck = (selected, revision = 1) => JSON.stringify({ data: { saved_at: "2026-11-19T10:00:00Z", selected_option_ids: selected, revision }, meta: { request_id: "r" } });

  function wired(clock, storage = new MemoryStorage()) {
    return page({ clock, storage, send: answerSender(ATTEMPT) });
  }

  // The last column: whether the reply is even a valid API envelope (if not, nothing is reported as changed).
  for (const [label, body, envelope] of [
    ["an HTML page", "<!doctype html><html><body>Sign in to the Wi-Fi</body></html>", false],
    ["an empty body", "", false],
    ["malformed JSON", '{"data": {"saved_at": ', false],
    ["JSON without data", JSON.stringify({ meta: { request_id: "r" } }), false],
    ["data: null", JSON.stringify({ data: null }), true],
    ["a different selection", goodAck(["b"]), true],
    ["an acknowledgement without saved_at", JSON.stringify({ data: { selected_option_ids: ["a"], revision: 1 } }), true],
    ["a malformed revision", JSON.stringify({ data: { saved_at: "2026-11-19T10:00:00Z", selected_option_ids: ["a"], revision: "1" } }), true],
  ]) {
    test(`${label}: not dequeued, never shown as saved, explained, and kept`, async () => {
      const clock = new Clock();
      mutations = [];
      const requests = mockFetch(() => respond(body, 200));
      const p = wired(clock);
      p.sync.set("q1", ["a"]);
      await settle();
      assert.equal(requests.length, 1);
      assert.equal(p.sync.unsaved(), 1, "the choice stays queued");
      assert.equal(p.last().status, "retrying");
      assert.equal(p.last().failure, "invalid");
      assert.match(p.last().message, /could not read/);
      assert.ok(p.snapshots.every((s) => s.status !== "saved"));
      assert.deepEqual(p.stored().entries.map((e) => e.s), [["a"]], "kept on this device");
      if (!envelope) assert.deepEqual(mutations, [], "an unreadable reply is not reported as a change");
      mockFetch(() => respond(goodAck(["a"]), 200));
      await clock.advance(1_000);
      assert.equal(p.last().status, "saved", "a valid acknowledgement confirms it");
      assert.equal(p.stored(), null);
    });
  }

  test("a valid acknowledgement confirms the exact selection and its revision is used for the next save", async () => {
    const clock = new Clock();
    const requests = mockFetch((r) => respond(goodAck(r.body.selected_option_ids, (r.body.base_revision ?? 0) + 1), 200));
    const p = wired(clock);
    p.sync.restore([{ attempt_question_id: "q1", option_ids: ["a", "b"], selected_option_ids: [], revision: 0 }]);
    p.sync.set("q1", ["a", "a"]); // The server removes duplicates; the acknowledgement still matches.
    await settle();
    assert.equal(p.last().status, "saved");
    assert.equal(requests[0].url, `/api/v1/attempts/${ATTEMPT}/questions/q1/answer`);
    assert.deepEqual(Object.keys(requests[0].body).sort(), ["base_revision", "op_id", "selected_option_ids"]);
    assert.deepEqual(requests[0].body.selected_option_ids, ["a", "a"]);
    assert.equal(requests[0].body.base_revision, 0);
    assert.match(requests[0].body.op_id, /^[A-Za-z0-9-]{8,64}$/, "an operation ID the server accepts");
    p.sync.set("q1", ["b"]);
    await settle();
    assert.equal(requests[1].body.base_revision, 1);
  });

  test("an error reply keeps its code; a conflict reply carries the server's answer to the queue", async () => {
    const clock = new Clock();
    mockFetch(() =>
      respond(JSON.stringify({ error: { code: "ANSWER_CONFLICT", message: "Changed elsewhere.", details: { selected_option_ids: ["b"], revision: 3 } } }), 409),
    );
    const p = wired(clock);
    p.sync.restore([{ attempt_question_id: "q1", option_ids: ["a", "b"], selected_option_ids: [], revision: 0 }]);
    p.sync.set("q1", ["a"]);
    await settle();
    assert.deepEqual(p.conflicts, [["q1", ["b"]]]);
    assert.equal(p.sync.unsaved(), 0);
  });

  test("parseAnswerAck validates against the exact selection sent", () => {
    const ack = { saved_at: "2026-11-19T10:00:00Z", selected_option_ids: ["b", "a"], revision: 2 };
    assert.deepEqual(parseAnswerAck(ack, ["a", "b"]), { selected: ["b", "a"], revision: 2 });
    assert.deepEqual(parseAnswerAck({ ...ack, selected_option_ids: [], revision: undefined }, []), { selected: [], revision: null });
    for (const bad of [null, [], "ok", { ...ack, selected_option_ids: ["a"] }, { ...ack, selected_option_ids: ["a", "b", "c"] }, { ...ack, revision: -1 }]) {
      assert.throws(() => parseAnswerAck(bad, ["a", "b"]), (e) => e.code === "INVALID_RESPONSE");
    }
  });

  test("unrelated API consumers keep working: null data, error codes and Retry-After", async () => {
    mockFetch(() => respond(JSON.stringify({ data: null, meta: {} })));
    assert.equal(await api.get("/anything"), null);
    mockFetch(() => respond(JSON.stringify({ data: { items: [1] } })));
    assert.deepEqual(await api.post("/anything", {}), { items: [1] });
    mockFetch(() => respond(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Wait." } }), 429, { "Retry-After": "7" }));
    await assert.rejects(api.get("/anything"), (e) => e.code === "RATE_LIMITED" && e.status === 429 && e.retryAfterSeconds === 7);
    mockFetch(() => respond("<html>Bad gateway</html>", 502));
    await assert.rejects(api.get("/anything"), (e) => e.status === 502 && e.code === "INTERNAL_ERROR");
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await assert.rejects(api.get("/anything"), (e) => e.status === 0 && e.code === "NETWORK_ERROR");
  });

  test("API client: an HTTP 200 that is not the API envelope is INVALID_RESPONSE for every consumer", async () => {
    for (const body of ["<!doctype html><p>Proxy page</p>", "", "{not json", JSON.stringify([1, 2]), JSON.stringify({ meta: {} })]) {
      mockFetch(() => respond(body, 200));
      await assert.rejects(api.get("/anything"), (e) => e instanceof ApiError && e.code === "INVALID_RESPONSE" && e.status === 200, `GET with ${JSON.stringify(body)}`);
      mockFetch(() => respond(body, 200));
      await assert.rejects(api.post("/anything", {}), (e) => e.code === "INVALID_RESPONSE", `POST with ${JSON.stringify(body)}`);
    }
  });
});

/* ==================== 4. Lifecycle: logout, account change, unmount ==================== */

describe("lifecycle disposal", () => {
  test("logout while a save is in flight: the late reply cannot recreate the cleared record, update the page or send again", async () => {
    const clock = new Clock();
    const p = page({ clock });
    let revoked = 0;
    const unsubscribe = onPendingAnswersRevoked(() => {
      revoked++;
      if (p.store.revoked) p.sync.dispose(); // What the exam page does.
    });
    p.sync.set("q1", ["a"]);
    p.sync.set("q2", ["e"]);
    await settle();
    assert.ok(p.stored());
    purgePendingAnswers(p.storage, null, clock.now); // Sign-out.
    unsubscribe();
    assert.equal(revoked, 1);
    assert.equal(p.store.revoked, true);
    assert.equal(p.calls[0].signal.aborted, true, "the request on its way is cancelled");
    const before = p.snapshots.length;
    p.calls[0].reply(); // The reply arrives anyway.
    await clock.advance(120_000);
    assert.equal(p.storage.length, 0, "no record is written back");
    assert.equal(p.snapshots.length, before, "the obsolete page is not updated");
    assert.equal(p.calls.length, 1, "q2 is never sent");
    assert.equal(p.sync.set("q3", ["g"]), false);
  });

  test("a revoked store refuses writes even if the queue was not disposed", async () => {
    const clock = new Clock();
    const p = page({ clock });
    p.sync.set("q1", ["a"]);
    purgePendingAnswers(p.storage, null, clock.now);
    p.sync.set("q2", ["e"]);
    assert.equal(p.storage.length, 0);
    assert.equal(p.last().durable, false, "recovery is not promised");
  });

  test("account change while a retry timer is pending: no further saves and nothing written", async () => {
    const clock = new Clock();
    const p = page({ clock });
    const stop = onPendingAnswersRevoked(() => p.store.revoked && p.sync.dispose());
    p.sync.set("q1", ["a"]);
    await settle();
    p.calls[0].fail(Object.assign(new Error("Offline"), { status: 0, code: "NETWORK_ERROR" }));
    await settle();
    assert.equal(clock.timers.length, 1, "a retry is scheduled");
    purgePendingAnswers(p.storage, "account-b", clock.now); // Another account signs in.
    stop();
    assert.equal(clock.timers.length, 0, "the retry timer is cancelled");
    await clock.advance(120_000);
    assert.equal(p.calls.length, 1);
    assert.equal(p.storage.map.has(KEY()), false);
  });

  test("a store of the account that stays signed in is not revoked", () => {
    const p = page({ clock: new Clock() });
    purgePendingAnswers(p.storage, ACCOUNT, START);
    assert.equal(p.store.revoked, false);
    p.sync.set("q1", ["a"]);
    assert.ok(p.stored());
  });

  test("unmount during an in-flight save keeps the answer recoverable and ignores the late reply", async () => {
    const clock = new Clock();
    const storage = new MemoryStorage();
    const server = new Server();
    const p = page({ clock, storage, server });
    p.sync.restore(server.questions());
    p.sync.set("q1", ["a"]);
    await settle();
    p.sync.suspend(); // Ordinary navigation away from the exam.
    assert.equal(p.calls[0].signal.aborted, true);
    const before = p.snapshots.length;
    p.calls[0].reply(); // It had reached the server; the reply comes too late.
    await clock.advance(60_000);
    assert.equal(p.snapshots.length, before);
    assert.equal(p.calls.length, 1, "no further save");
    assert.deepEqual(p.stored().entries, [{ q: "q1", s: ["a"], n: 1, b: 0, u: [p.calls[0].op] }], "kept for the next visit, with the operation sent");

    const next = page({ clock, storage, server }); // Back on the exam later.
    assert.deepEqual(next.sync.restore(server.questions()), {}, "the server already holds it, so nothing is resent");
    assert.equal(next.stored(), null);
  });

  test("unmount while a retry timer is active cancels it", async () => {
    const clock = new Clock();
    const p = page({ clock });
    p.sync.set("q1", ["a"]);
    await settle();
    p.calls[0].fail(Object.assign(new Error("Busy"), { status: 503, code: "SERVICE_UNAVAILABLE" }));
    await settle();
    assert.equal(clock.timers.length, 1);
    p.sync.suspend();
    assert.equal(clock.timers.length, 0);
    await clock.advance(120_000);
    assert.equal(p.calls.length, 1);
    assert.deepEqual(p.stored().entries.map((e) => e.q), ["q1"]);
  });

  test("React Strict Mode (start, suspend, start): one queue resumes, the abandoned request is ignored", async () => {
    const clock = new Clock();
    const server = new Server();
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1, b: 0 }]);
    const p = page({ clock, server, storage });
    p.sync.restore(server.questions());
    p.sync.start();
    await settle();
    p.sync.suspend();
    p.sync.start();
    await settle();
    assert.equal(p.calls.length, 2, "the cancelled request is sent once more, by one queue");
    assert.equal(p.calls[0].signal.aborted, true);
    p.calls[0].reply(); // Late reply of the rehearsal: ignored.
    await settle();
    assert.equal(p.calls.length, 2);
    p.calls[1].reply();
    await settle();
    assert.equal(p.last().status, "saved");
    assert.equal(p.calls.length, 2, "no duplicate loop");
    assert.deepEqual(server.view("q1"), { selected: ["a"], revision: 1 });
  });

  test("attempt finished: once forgotten, a late confirmation cannot write the record back", async () => {
    const clock = new Clock();
    const p = page({ clock });
    p.sync.set("q1", ["a"]);
    p.sync.set("q2", ["e"]);
    await settle();
    p.sync.close("expired");
    p.sync.forget();
    p.calls[0].reply();
    await settle();
    assert.equal(p.storage.length, 0);
    p.sync.dispose();
    clearPendingAnswers(p.storage, ACCOUNT, ATTEMPT);
    assert.equal(p.sync.set("q3", ["g"]), false);
    assert.deepEqual(await p.sync.flush(), { ok: false, kind: "stopped", unsaved: 1, message: null });
  });
});

/* ==================== 5. Two tabs, stale recovery and delayed requests ==================== */

describe("two tabs and stale copies", () => {
  test("simultaneous tabs: the older tab's choice cannot overwrite the newer accepted answer", async () => {
    const clock = new Clock();
    const server = new Server();
    const storage = new MemoryStorage();
    const a = page({ clock, server, storage });
    const b = page({ clock, server, storage });
    a.sync.restore(server.questions());
    b.sync.restore(server.questions());
    b.sync.set("q1", ["b"]);
    await settle();
    b.calls[0].reply();
    await settle();
    assert.deepEqual(server.view("q1"), { selected: ["b"], revision: 1 });

    a.sync.set("q1", ["a"]); // Tab A never saw tab B's answer.
    await settle();
    assert.equal(a.calls[0].base, 0);
    a.calls[0].reply();
    await settle();
    assert.deepEqual(server.view("q1"), { selected: ["b"], revision: 1 }, "the newer answer is kept");
    assert.deepEqual(a.conflicts, [["q1", ["b"]]], "tab A is told to show it");
    assert.equal(a.last().replaced, 1);
    assert.equal(a.sync.unsaved(), 0);
    assert.equal(a.last().failure, "conflict");
    const first = await a.sync.flush();
    assert.equal(first.ok, false, "submission stops once so the person sees the replaced answer");
    assert.equal(first.kind, "conflict");
    assert.deepEqual(await a.sync.flush(), { ok: true }, "then it can go ahead");
  });

  test("handover: a deliberate new choice in the older tab is accepted; the other tab becomes the stale one", async () => {
    const clock = new Clock();
    const server = new Server();
    const a = page({ clock, server });
    const b = page({ clock, server });
    a.sync.restore(server.questions());
    b.sync.restore(server.questions());
    b.sync.set("q1", ["b"]);
    await settle();
    b.calls[0].reply();
    a.sync.set("q1", ["a"]);
    await settle();
    a.calls[0].reply();
    await settle();
    a.sync.set("q1", ["c"]); // Made after seeing "b".
    await settle();
    assert.equal(a.calls[1].base, 1);
    a.calls[1].reply();
    await settle();
    assert.deepEqual(server.view("q1"), { selected: ["c"], revision: 2 });
    b.sync.set("q1", ["d"]);
    await settle();
    b.calls[1].reply();
    await settle();
    assert.deepEqual(server.view("q1").selected, ["c"]);
    assert.deepEqual(b.conflicts, [["q1", ["c"]]]);
  });

  test("delayed request across tabs: tab A's save arriving after tab B's newer save is refused", async () => {
    const clock = new Clock();
    const server = new Server();
    const a = page({ clock, server });
    const b = page({ clock, server });
    a.sync.restore(server.questions());
    b.sync.restore(server.questions());
    a.sync.set("q1", ["a"]);
    await settle(); // Tab A's request is slow.
    b.sync.set("q1", ["b"]);
    await settle();
    b.calls[0].reply();
    await settle();
    a.calls[0].reply(); // Arrives after B's.
    await settle();
    assert.deepEqual(server.view("q1"), { selected: ["b"], revision: 1 });
    assert.deepEqual(a.conflicts, [["q1", ["b"]]]);
  });

  test("stale recovery: a stored choice made against an older revision is not restored over a newer answer", async () => {
    const clock = new Clock();
    const server = new Server();
    server.put("q1", ["b"], 0); // Saved later from another device: revision 1.
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1, b: 0 }, { q: "q2", s: ["e"], n: 2, b: 0 }]);
    const p = page({ clock, server, storage });
    assert.deepEqual(p.sync.restore(server.questions()), { q2: ["e"] });
    assert.equal(p.sync.superseded(), 1);
    p.sync.start();
    await settle();
    assert.deepEqual(p.calls.map((c) => c.q), ["q2"], "the stale choice is never sent");
    assert.deepEqual(p.stored().entries.map((e) => e.q), ["q2"], "and no longer stored");
  });

  test("a record written before revisions existed is checked against revision 0", () => {
    const server = new Server();
    server.put("q1", ["b"], 0);
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["a"], n: 1 }]);
    const p = page({ clock: new Clock(), server, storage });
    assert.deepEqual(p.sync.restore(server.questions()), {});
  });

  test("recovery after this device's own save arrived without a reply: restored and rebased, not discarded", async () => {
    const clock = new Clock();
    const server = new Server();
    server.put("q1", ["b"], 0, "op-lost-0001"); // This device's earlier save, whose reply was lost.
    const storage = new MemoryStorage();
    writeRecord(storage, [{ q: "q1", s: ["c"], n: 2, b: 0, u: ["op-lost-0001"] }]);
    const p = page({ clock, server, storage });
    assert.deepEqual(p.sync.restore(server.questions()), { q1: ["c"] });
    p.sync.start();
    await settle();
    assert.equal(p.calls[0].base, 1);
    p.calls[0].reply();
    await settle();
    assert.deepEqual(server.view("q1").selected, ["c"]);
    assert.equal(server.view("q1").revision, 2);
  });

  test("another device saving the same choice as this page's lost save is not mistaken for it (live)", async () => {
    const clock = new Clock();
    const server = new Server();
    const a = page({ clock, server });
    a.sync.restore(server.questions());
    a.sync.start();
    a.sync.set("q1", ["a"]); // Device A: "a". This request is lost on the network and never arrives.
    await settle();
    await clock.advance(TIMEOUT);
    a.sync.set("q1", ["b"]); // A's person then picks "b"; it waits for the retry.
    server.put("q1", ["a"], 0, "op-device-b-01"); // LATER, device B saves "a": the newest answer.
    await clock.advance(750); // A retries "b" on revision 0, and is refused.
    a.calls.at(-1).reply();
    await settle();
    assert.deepEqual(server.view("q1"), { selected: ["a"], revision: 1 }, "device B's newer answer is kept");
    assert.equal(server.opOf("q1"), "op-device-b-01");
    assert.deepEqual(a.conflicts, [["q1", ["a"]]], "device A is told and shows it");
    assert.equal(a.calls.length, 2, "device A does not send its older choice again");
    assert.equal(a.sync.unsaved(), 0);
  });

  test("another device's matching save is not mistaken for this device's lost one after a refresh either", () => {
    const server = new Server();
    server.put("q1", ["a"], 0, "op-device-b-01"); // Device B saved "a"; this device's own "a" (op-lost) never arrived.
    for (const sent of [["op-lost-0001"], [["a"]]]) { // Current records name operations; older ones named selections.
      const storage = new MemoryStorage();
      writeRecord(storage, [{ q: "q1", s: ["b"], n: 2, b: 0, u: sent }]);
      const p = page({ clock: new Clock(), server, storage });
      assert.deepEqual(p.sync.restore(server.questions()), {}, `not restored over the newer answer (${JSON.stringify(sent)})`);
      assert.equal(p.sync.superseded(), 1);
    }
  });

  test("tabs sharing browser storage keep each other's entries, and durability is rechecked", async () => {
    const clock = new Clock();
    const server = new Server();
    const storage = new MemoryStorage();
    const a = page({ clock, server, storage });
    const b = page({ clock, server, storage });
    a.sync.restore(server.questions());
    b.sync.restore(server.questions());
    a.sync.set("q1", ["a"]); // Tab A is offline: stays pending.
    b.sync.set("q2", ["e"]);
    await settle();
    assert.deepEqual(a.stored().entries.map((e) => e.q).sort(), ["q1", "q2"]);
    b.calls[0].reply();
    await settle();
    assert.deepEqual(a.stored().entries.map((e) => e.q), ["q1"], "tab B's confirmation leaves tab A's entry");
    a.sync.recheckDurability();
    assert.equal(a.last().durable, true);
    b.sync.set("q1", ["c"]); // Tab B now stores a different choice for q1.
    a.sync.recheckDurability();
    assert.equal(a.last().durable, false, "tab A no longer promises recovery of its own choice");
  });
});
