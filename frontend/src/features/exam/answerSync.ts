/* Answer saving for a running attempt. Every chosen answer stays queued until the server confirms that exact
   choice; nothing is reported as saved before then. Saves run one at a time, so the server always receives a
   question's answers in the order they were chosen and a late reply can never replace a newer choice.

   Retryable failures (no connection, no reply in time, an unreadable reply, 429, 408, 500, 502, 503, 504) are
   retried with bounded exponential backoff and jitter, honouring Retry-After. Other failures stop explicitly.
   Nothing is sent after the server deadline, and the deadline is never extended: an answer the server has not
   received in time does not count. Every request is bounded by a timeout, so a reply that never comes cannot
   leave saving, submission or expiry stuck.

   Overwrite protection (compare-and-set). Each saved answer has a server revision. A save names the revision its
   choice was made against, and the server refuses it (ANSWER_CONFLICT) once the answer has moved on. So an older
   tab, another device, a recovered queue or a delayed request can never overwrite a newer answer: the newer
   answer is kept and shown. A request whose reply never came may still have been stored. Every save carries a
   random operation ID and the server reports which operation wrote the answer it holds, so a conflict caused by
   this page's own earlier save is recognised exactly (never by the options chosen, which another window or device
   may choose too) and the latest choice is sent again on top of it. This protection is the server's, so it holds
   across devices, not only across tabs.

   Lifecycle. suspend() (the page unmounted, or React Strict Mode's rehearsal) cancels the request on its way and
   every timer, and invalidates their late callbacks, but keeps pending choices in memory and in storage, so start()
   can resume and a later visit can recover them. dispose() is final (sign-out, account change, attempt finished).

   Pending choices are also kept in browser storage (see lib/pendingAnswers), so a refresh or a closed browser
   can send them while the attempt is still open.

   Only a type import, and only type syntax that can be erased: the unit tests run this file directly with Node. */

import type { PendingStore, StoredEntry } from "@/lib/pendingAnswers";

/** A failed request, as the API client reports it. */
export interface SaveFailure {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number | null;
  details?: unknown;
}

export type FailureKind = "network" | "timeout" | "invalid" | "rate-limited" | "server" | "closed" | "signed-out" | "forbidden" | "conflict" | "rejected";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function classify(failure: SaveFailure): { kind: FailureKind; retry: boolean } {
  if (failure.code === "TIMEOUT") return { kind: "timeout", retry: true }; // The save may or may not have arrived.
  if (failure.code === "INVALID_RESPONSE") return { kind: "invalid", retry: true }; // Never treated as saved.
  if (failure.status === 0) return { kind: "network", retry: true };
  if (failure.status === 429) return { kind: "rate-limited", retry: true };
  if (RETRYABLE_STATUS.has(failure.status)) return { kind: "server", retry: true };
  if (failure.code === "ATTEMPT_ALREADY_SUBMITTED") return { kind: "closed", retry: false };
  if (failure.code === "ANSWER_CONFLICT") return { kind: "conflict", retry: false };
  if (failure.status === 401 || failure.code === "UNAUTHENTICATED") return { kind: "signed-out", retry: false };
  if (failure.status === 403) return { kind: "forbidden", retry: false };
  return { kind: "rejected", retry: false }; // Validation and other refusals: retrying cannot help.
}

const RETRYING_KINDS = new Set<FailureKind>(["network", "timeout", "invalid", "rate-limited", "server"]);

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;
/** A Retry-After longer than this is shortened; the deadline still bounds every wait. */
export const RETRY_AFTER_MAX_MS = 120_000;
/** The engine's own limit for one save, a backstop above the API client's timeout. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Selections remembered per question whose reply never came (oldest dropped first). */
const UNCERTAIN_LIMIT = 8;

/** Exponential backoff with equal jitter (half fixed, half random), never shorter than Retry-After. */
export function retryDelay(failures: number, random: () => number, retryAfterSeconds?: number | null): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
  const jittered = ceiling / 2 + random() * (ceiling / 2);
  const hinted = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds * 1000, RETRY_AFTER_MAX_MS) : 0;
  return Math.round(Math.max(jittered, hinted));
}

function toFailure(error: unknown): SaveFailure {
  const e = error as Partial<SaveFailure> | null;
  return {
    status: typeof e?.status === "number" ? e.status : 0,
    code: typeof e?.code === "string" ? e.code : "UNKNOWN",
    message: typeof e?.message === "string" ? e.message : "The answer could not be saved.",
    retryAfterSeconds: typeof e?.retryAfterSeconds === "number" ? e.retryAfterSeconds : null,
    details: e?.details,
  };
}

const TIMEOUT_FAILURE = { status: 0, code: "TIMEOUT", message: "TrainCheck did not reply in time, so this answer is not confirmed yet." };
const STOPPED = Symbol("stopped");

const sameSelection = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The server's answer in an ANSWER_CONFLICT refusal, or null when the refusal does not carry a usable one. */
function serverAnswer(details: unknown): { selected: string[]; revision: number; op: string | null } | null {
  const d = details as { selected_option_ids?: unknown; revision?: unknown; op_id?: unknown } | null;
  if (!d || !Array.isArray(d.selected_option_ids) || !d.selected_option_ids.every((x) => typeof x === "string") || !isRevision(d.revision)) return null;
  return { selected: d.selected_option_ids as string[], revision: d.revision, op: typeof d.op_id === "string" ? d.op_id : null };
}

/** A random operation ID (letters, digits and hyphens, as the server accepts). */
function randomOpId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Operation IDs a stored entry lists as sent without a reply. Older records listed selections: proof of nothing. */
const ownOps = (entry: StoredEntry): string[] => (entry.u ?? []).filter((x): x is string => typeof x === "string");

/* ---------- The queue ---------- */

export type SyncStatus = "saved" | "saving" | "retrying" | "unsaved" | "closed";
export type ClosedReason = "expired" | "closed" | "submitted";

export interface SyncSnapshot {
  status: SyncStatus;
  /** Choices not yet confirmed by the server, including any refused ones. */
  unsaved: number;
  failure: FailureKind | null;
  /** The server's explanation for a refusal, when there is one. */
  message: string | null;
  /** When the next automatic retry is due (deps clock), while retrying. */
  retryAt: number | null;
  /** Whether every unsaved choice is actually held in browser storage, so it survives a refresh. */
  durable: boolean;
  closed: ClosedReason | null;
  /** Choices of this page dropped because another window or device saved a newer answer (it is shown instead). */
  replaced: number;
}

export type FlushOutcome = { ok: true } | { ok: false; kind: FailureKind | "expired" | "stopped"; unsaved: number; message: string | null };

export interface SendOptions {
  /** The revision this choice was made against; null when unknown (the save is then unconditional). */
  baseRevision: number | null;
  /** Aborted when the save times out or the engine is suspended or disposed. */
  signal: AbortSignal | null;
  /** This choice's operation ID: the same for every retry of it, so the server can say who wrote its answer. */
  opId: string;
}

export interface SyncDeps {
  /** Saves one answer. Resolves only with a validated confirmation of that exact selection, optionally carrying
      the answer's new `revision`; throws (rejects) otherwise. */
  send: (questionId: string, selected: string[], options: SendOptions) => Promise<unknown>;
  /** The server clock in milliseconds (device clock corrected by the server's offset). */
  now: () => number;
  /** The server deadline in milliseconds. */
  deadline: number;
  /** Runs `run` after `ms`; returns a function that cancels it. */
  schedule: (run: () => void, ms: number) => () => void;
  random: () => number;
  store: PendingStore | null;
  onChange: (snapshot: SyncSnapshot) => void;
  /** Another window or device saved a newer answer for this question; it is kept, and the page should show it. */
  onConflict?: (questionId: string, selected: string[]) => void;
  /** The engine's limit for one save reply; REQUEST_TIMEOUT_MS by default. */
  requestTimeoutMs?: number;
  /** Makes operation IDs (tests pass a predictable one); random by default. */
  newOpId?: () => string;
}

interface Pending {
  selected: string[];
  seq: number;
  /** The operation ID this choice is sent under. */
  op: string;
}

export interface RestorableQuestion {
  attempt_question_id: string;
  option_ids: string[];
  selected_option_ids: string[];
  /** The server's answer revision; when absent, recovered choices are not checked against it. */
  revision?: number;
  /** The operation ID of the save that wrote the server's answer, when known. */
  op_id?: string | null;
}

export class AnswerSync {
  private deps: SyncDeps;
  private pending = new Map<string, Pending>();
  private refused = new Map<string, Pending & { message: string }>();
  /** The revision each question's next save builds on, when the server has told us. */
  private revisions = new Map<string, number>();
  /** Operation IDs sent since that revision whose reply never came: the server may hold any of them. */
  private uncertain = new Map<string, string[]>();
  /** Questions this page has written to storage (other tabs' entries for other questions are left alone). */
  private touched = new Set<string>();
  private seq = 0;
  private running: Promise<void> | null = null;
  private failures = 0;
  private lastFailure: { kind: FailureKind; message: string } | null = null;
  private halted: FailureKind | null = null;
  private closedReason: ClosedReason | null = null;
  private locked = false;
  private durable: boolean;
  private retryAt: number | null = null;
  private wake: (() => void) | null = null;
  private cancelRequest: (() => void) | null = null;
  private waiters: ((outcome: FlushOutcome) => void)[] = [];
  private restored = false;
  private discarded = 0;
  private replaced = 0;
  private unseenReplacements = 0;
  /** Bumped by suspend() and dispose(): callbacks of an older generation change nothing. */
  private generation = 0;
  private suspended = false;
  private disposed = false;
  private forgotten = false;

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.durable = deps.store?.available ?? false;
  }

  /** Puts back the choices this device kept for the attempt (after a refresh or a closed browser), keeping
      only those the server does not already hold, that fit the question and, when the server reports answer
      revisions, that were made against the answer the server still holds. Call once, before start(). */
  restore(questions: RestorableQuestion[]): Record<string, string[]> {
    if (this.restored) return {};
    this.restored = true;
    const shown: Record<string, string[]> = {};
    const byId = new Map(questions.map((q) => [q.attempt_question_id, q]));
    for (const q of questions) if (isRevision(q.revision)) this.revisions.set(q.attempt_question_id, q.revision);
    const entries = [...(this.deps.store?.load() ?? [])].sort((a, b) => a.n - b.n);
    for (const entry of entries) {
      const question = byId.get(entry.q);
      this.seq = Math.max(this.seq, entry.n);
      if (!question || !entry.s.every((o) => question.option_ids.includes(o))) continue; // Not this attempt's question or options.
      this.touched.add(entry.q);
      if (sameSelection(question.selected_option_ids, entry.s)) {
        this.pending.delete(entry.q); // Already saved before the page closed.
        continue;
      }
      if (isRevision(question.revision) && !this.stillCurrent(entry, question)) {
        this.pending.delete(entry.q); // The server holds a newer answer, saved elsewhere: it is kept.
        this.discarded += 1;
        continue;
      }
      this.pending.set(entry.q, { selected: [...entry.s], seq: entry.n, op: this.newOp() });
      if (isRevision(question.revision)) this.uncertain.set(entry.q, ownOps(entry)); // Still unanswered, still ours.
      shown[entry.q] = [...entry.s];
    }
    this.persist();
    this.emit();
    return shown;
  }

  /** How many recovered choices were not restored because a newer answer had been saved elsewhere. */
  superseded(): number {
    return this.discarded;
  }

  /** Starts (or, after suspend(), resumes) sending whatever is queued. Safe to call more than once. */
  start(): void {
    if (this.disposed) return;
    this.suspended = false;
    this.kick();
  }

  /** A new choice. Refused (false) after the deadline, once the attempt is closed, during submission, or once
      disposed. */
  set(questionId: string, selected: string[]): boolean {
    if (this.closedReason || this.locked || this.disposed) return false;
    if (this.deps.now() >= this.deps.deadline) {
      this.close("expired");
      return false;
    }
    this.refused.delete(questionId);
    this.touched.add(questionId);
    this.pending.set(questionId, { selected: [...selected], seq: ++this.seq, op: this.newOp() });
    if ((this.lastFailure?.kind === "rejected" || this.lastFailure?.kind === "conflict") && !this.refused.size) this.lastFailure = null;
    this.persist();
    this.emit();
    this.kick();
    return true;
  }

  /** Sends everything queued now and reports whether every choice is confirmed. It does not wait out a
      retry delay: a retryable failure is reported at once while retrying continues in the background. */
  flush(): Promise<FlushOutcome> {
    if (this.disposed || this.suspended) return Promise.resolve(this.failed("stopped", null));
    if (this.closedReason) return Promise.resolve(this.closedOutcome());
    if (this.halted) return Promise.resolve(this.failed(this.halted, this.lastFailure?.message ?? null));
    if (!this.pending.size && !this.running) return Promise.resolve(this.idleOutcome());
    if (this.retryAt !== null && this.lastFailure?.kind === "rate-limited") {
      return Promise.resolve(this.failed("rate-limited", this.lastFailure.message)); // Retry-After is respected.
    }
    const outcome = new Promise<FlushOutcome>((resolve) => this.waiters.push(resolve));
    this.wake?.();
    this.kick();
    return outcome;
  }

  /** After the connection returns: retry now instead of waiting (not when the server asked us to wait). */
  retryNow(): void {
    if (this.lastFailure?.kind !== "rate-limited") this.wake?.();
  }

  /** While submitting: no new choices are accepted. */
  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }

  /** Stops all saving: the deadline passed, or the server reports the attempt finished. A request already on
      its way still completes, and its confirmation is still recorded. */
  close(reason: ClosedReason): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.wake?.();
    this.settle(this.closedOutcome());
    this.emit();
  }

  /** Resolves once no request is on its way. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  unsaved(): number {
    return this.pending.size + this.refused.size;
  }

  /** The page went away (unmount, ordinary navigation, or React Strict Mode's rehearsal). Cancels the request
      on its way and every timer; their late callbacks change nothing. Pending choices stay in memory and in
      storage: start() resumes, and a later visit recovers them. */
  suspend(): void {
    if (this.suspended || this.disposed) return;
    this.suspended = true;
    this.stopActivity();
  }

  /** Final: sign-out, account change, or the attempt finished. Nothing is sent, stored or reported afterwards.
      Storage is left as it was: sign-out cleanup removes it, and the result page explains it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopActivity();
  }

  /** Removes the durable copy (after a confirmed submission or once the result has been shown). Nothing is
      written back afterwards, even by a save that completes later. */
  forget(): void {
    this.forgotten = true;
    this.deps.store?.clear();
  }

  /** Re-reads whether storage still holds every unsaved choice (another tab may have rewritten the record). */
  recheckDurability(): void {
    if (this.disposed || this.forgotten || !this.deps.store) return;
    const durable = this.deps.store.covers(this.entries());
    if (durable !== this.durable) {
      this.durable = durable;
      this.emit();
    }
  }

  snapshot(): SyncSnapshot {
    const retrying = this.pending.size > 0 && this.lastFailure !== null && RETRYING_KINDS.has(this.lastFailure.kind);
    let status: SyncStatus;
    if (this.closedReason) status = "closed";
    else if (this.halted) status = "unsaved";
    else if (retrying) status = "retrying";
    else if (this.pending.size) status = "saving";
    else if (this.refused.size) status = "unsaved";
    else status = "saved";
    return {
      status,
      unsaved: this.unsaved(),
      failure: this.halted ?? this.lastFailure?.kind ?? null,
      message: this.lastFailure?.message ?? [...this.refused.values()][0]?.message ?? null,
      retryAt: this.retryAt,
      durable: this.durable,
      closed: this.closedReason,
      replaced: this.replaced,
    };
  }

  /* ---------- internals ---------- */

  private active(generation: number): boolean {
    return generation === this.generation && !this.suspended && !this.disposed;
  }

  private stopActivity(): void {
    this.generation += 1;
    this.cancelRequest?.();
    this.wake?.();
    this.running = null; // The old loop ends on its own; a resume must not wait for it.
    this.retryAt = null;
    this.settle(this.failed("stopped", null));
  }

  /** A recovered choice is still current if the server's answer has not moved since it was made, or moved only
      because one of this device's own saves (whose reply never came) arrived. */
  private newOp(): string {
    return (this.deps.newOpId ?? randomOpId)();
  }

  private stillCurrent(entry: StoredEntry, question: RestorableQuestion): boolean {
    const server = question.revision as number;
    const base = entry.b ?? 0; // Records written before revisions existed were made against revision 0.
    if (server === base) return true;
    // Moved on: only by this device's own save if the server names one of the operations this device sent. Matching
    // options prove nothing (another window or device may have chosen the same); neither do older records,
    // which listed selections instead of operations.
    return server > base && typeof question.op_id === "string" && ownOps(entry).includes(question.op_id);
  }

  private kick(): void {
    if (this.running || this.closedReason || this.halted || !this.pending.size || this.suspended || this.disposed) return;
    const run: Promise<void> = this.loop(this.generation).finally(() => {
      if (this.running !== run) return; // A newer loop (after resume) owns the state now.
      this.running = null;
      this.retryAt = null;
      this.emit();
    });
    this.running = run;
  }

  private async loop(generation: number): Promise<void> {
    while (this.pending.size && !this.closedReason && !this.halted && this.active(generation)) {
      if (this.deps.now() >= this.deps.deadline) {
        this.close("expired");
        return;
      }
      const [questionId, entry] = this.pending.entries().next().value as [string, Pending];
      const base = this.revisions.get(questionId) ?? null;
      if (base !== null) {
        // Until a reply comes, the server may or may not hold this operation's choice; remembered (and stored) first.
        const sent = this.uncertain.get(questionId) ?? [];
        if (!sent.includes(entry.op)) this.uncertain.set(questionId, [...sent, entry.op].slice(-UNCERTAIN_LIMIT));
        this.persist();
      }
      this.emit();
      let ack: unknown;
      try {
        ack = await this.request(questionId, entry.selected, base, entry.op);
      } catch (error) {
        if (error === STOPPED || !this.active(generation)) return; // Suspended or disposed meanwhile: change nothing.
        if (await this.failure(questionId, entry, base, toFailure(error))) return;
        continue;
      }
      if (!this.active(generation)) return;
      // Confirmed. A newer choice made meanwhile stays queued and is sent next, on top of the new revision.
      const revision = (ack as { revision?: unknown } | null)?.revision;
      if (isRevision(revision)) this.revisions.set(questionId, revision);
      else this.revisions.delete(questionId); // Unknown: later saves of this question are unconditional.
      this.uncertain.delete(questionId);
      if (this.pending.get(questionId)?.seq === entry.seq) this.pending.delete(questionId);
      this.failures = 0;
      if (this.lastFailure && RETRYING_KINDS.has(this.lastFailure.kind)) this.lastFailure = null;
      this.persist();
      this.emit();
    }
    if (!this.pending.size && this.active(generation) && this.waiters.length) this.settle(this.idleOutcome());
  }

  /** Handles a failed save. True when the loop must stop. */
  private async failure(questionId: string, entry: Pending, base: number | null, failure: SaveFailure): Promise<boolean> {
    const generation = this.generation;
    const { kind, retry } = classify(failure);
    if (kind === "closed") {
      this.lastFailure = { kind, message: failure.message }; // The server's reason (time expired, or submitted).
      this.close("closed");
      return true;
    }
    if (kind === "signed-out" || kind === "forbidden") {
      // Kept queued (and stored) so the same account can send them after signing in again.
      this.halted = kind;
      this.lastFailure = { kind, message: failure.message };
      this.settle(this.failed(kind, failure.message));
      this.emit();
      return true;
    }
    const server = kind === "conflict" ? serverAnswer(failure.details) : null;
    if (server) {
      const sent = this.uncertain.get(questionId) ?? [];
      // Ours only if the server names an operation this page sent and never heard back about. Anything else, even
      // the same options, is someone else's newer answer.
      const ownSave = base !== null && server.revision > base && server.op !== null && sent.includes(server.op);
      this.revisions.set(questionId, server.revision);
      this.uncertain.delete(questionId);
      if (ownSave) {
        // This page's earlier save arrived although its reply never came: build on it and send the latest choice.
        this.persist();
        return false;
      }
      // Another window or device saved a newer answer. It is kept; this page's choices for the question, all made
      // without seeing it, are dropped and the page shows the server's answer. A new choice here builds on it.
      this.pending.delete(questionId);
      this.refused.delete(questionId);
      this.replaced += 1;
      this.unseenReplacements += 1;
      this.lastFailure = { kind: "conflict", message: failure.message };
      this.persist();
      this.deps.onConflict?.(questionId, [...server.selected]);
      this.emit();
      return false;
    }
    if (!retry) {
      // This choice will never be accepted. It is reported, not retried, and not stored.
      if (this.pending.get(questionId)?.seq === entry.seq) {
        this.pending.delete(questionId);
        this.refused.set(questionId, { ...entry, message: failure.message });
      }
      this.lastFailure = { kind: kind === "conflict" ? "rejected" : kind, message: failure.message };
      this.persist();
      this.emit();
      return false;
    }
    this.failures += 1;
    this.lastFailure = { kind, message: failure.message };
    const delay = retryDelay(this.failures, this.deps.random, failure.retryAfterSeconds);
    this.retryAt = this.deps.now() + delay;
    this.settle(this.failed(kind, failure.message)); // Anyone waiting to submit learns of it now.
    this.emit();
    await this.pause(delay);
    if (generation !== this.generation) return true;
    this.retryAt = null;
    return false;
  }

  /** One save, bounded by the engine's own timeout and cancellable by suspend() and dispose(). */
  private request(questionId: string, selected: string[], baseRevision: number | null, opId: string): Promise<unknown> {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    return new Promise((resolve, reject) => {
      let done = false;
      let cancelTimer: () => void = () => undefined;
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        cancelTimer();
        if (this.cancelRequest === cancel) this.cancelRequest = null;
        settle();
      };
      const cancel = () => {
        controller?.abort();
        finish(() => reject(STOPPED));
      };
      this.cancelRequest = cancel;
      cancelTimer = this.deps.schedule(() => {
        controller?.abort(); // The request may still have arrived: its operation stays "uncertain".
        finish(() => reject(TIMEOUT_FAILURE));
      }, this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(this.deps.send(questionId, selected, { baseRevision, signal: controller?.signal ?? null, opId }));
      } catch (error) {
        sent = Promise.reject(error);
      }
      sent.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  /** Waits for the retry delay, but never past the deadline; flush(), retryNow(), close() and suspend() end it. */
  private pause(ms: number): Promise<void> {
    const untilDeadline = Math.max(0, this.deps.deadline - this.deps.now());
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.wake === wake) this.wake = null;
        resolve();
      };
      const cancel = this.deps.schedule(finish, Math.min(ms, untilDeadline));
      const wake = () => {
        cancel();
        finish();
      };
      this.wake = wake;
    });
  }

  private entries(): StoredEntry[] {
    return [...this.pending.entries()].map(([q, p]) => {
      const entry: StoredEntry = { q, s: p.selected, n: p.seq };
      const base = this.revisions.get(q);
      if (base !== undefined) {
        entry.b = base;
        const sent = this.uncertain.get(q);
        if (sent?.length) entry.u = sent;
      }
      return entry;
    });
  }

  private persist(): void {
    const store = this.deps.store;
    if (!store || this.disposed || this.forgotten) return;
    this.durable = store.save(this.entries(), this.touched);
  }

  private settle(outcome: FlushOutcome): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(outcome);
  }

  private failed(kind: FailureKind | "expired" | "stopped", message: string | null): FlushOutcome {
    return { ok: false, kind, unsaved: this.unsaved(), message };
  }

  /** Reported to whoever waits on flush(). An answer replaced by a newer one from elsewhere stops one submission,
      so the person sees it before submitting; submitting again goes ahead. */
  private idleOutcome(): FlushOutcome {
    if (this.refused.size) return this.failed("rejected", [...this.refused.values()][0].message);
    if (this.unseenReplacements) {
      this.unseenReplacements = 0;
      return this.failed("conflict", this.lastFailure?.kind === "conflict" ? this.lastFailure.message : null);
    }
    return { ok: true };
  }

  private closedOutcome(): FlushOutcome {
    if (!this.unsaved()) return { ok: true };
    return this.failed(this.closedReason === "expired" ? "expired" : "closed", null);
  }

  private emit(): void {
    if (this.disposed) return; // Nothing may update a page that has finished with this attempt.
    this.deps.onChange(this.snapshot());
  }
}

/* ---------- The authoritative result after time runs out ---------- */

export const RESULT_RETRY_LIMIT = 6;
/** Each try of loading the result is abandoned after this long. */
export const RESULT_TRY_TIMEOUT_MS = 15_000;
/** The whole result loading, tries and waits together, never takes longer than this. */
export const RESULT_BUDGET_MS = 45_000;

export interface ResultLoadOptions {
  tryTimeoutMs?: number;
  budgetMs?: number;
  /** Milliseconds, for measuring the budget. */
  now?: () => number;
  /** Runs `run` after `ms`; returns a function that cancels it. */
  schedule?: (run: () => void, ms: number) => () => void;
}

const realSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** Loads the result, retrying temporary failures and "not ready yet" (the server's clock decides when the
    deadline has passed). Bounded three ways: a number of tries, a timeout for each try (the request is aborted),
    and a budget for the whole process, so a request that never settles cannot keep the page waiting. */
export async function loadFinalResult<T>(
  load: (signal: AbortSignal | null) => Promise<T>,
  wait: (ms: number) => Promise<void>,
  random: () => number,
  options: ResultLoadOptions = {},
): Promise<{ ok: true; result: T } | { ok: false; failure: SaveFailure }> {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? realSchedule;
  const tryTimeout = options.tryTimeoutMs ?? RESULT_TRY_TIMEOUT_MS;
  const started = now();
  const budget = options.budgetMs ?? RESULT_BUDGET_MS;
  let last: SaveFailure = { status: 0, code: "UNKNOWN", message: "" };
  for (let tryNumber = 1; tryNumber <= RESULT_RETRY_LIMIT; tryNumber++) {
    const left = budget - (now() - started);
    if (left <= 0) break;
    try {
      return { ok: true, result: await bounded(load, Math.min(tryTimeout, left), schedule) };
    } catch (error) {
      last = toFailure(error);
      const retry = classify(last).retry || last.code === "RESULT_NOT_READY";
      if (!retry || tryNumber === RESULT_RETRY_LIMIT) break;
      const delay = retryDelay(tryNumber, random, last.retryAfterSeconds);
      if (now() - started + delay >= budget) break; // Waiting would overrun the budget: let the person choose.
      await wait(delay);
    }
  }
  if (!last.message) last = { ...TIMEOUT_FAILURE, message: "TrainCheck did not reply in time." };
  return { ok: false, failure: last };
}

function bounded<T>(load: (signal: AbortSignal | null) => Promise<T>, ms: number, schedule: (run: () => void, ms: number) => () => void): Promise<T> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const cancel = schedule(() => {
      if (done) return;
      done = true;
      controller?.abort();
      reject({ ...TIMEOUT_FAILURE, message: "TrainCheck did not reply in time." });
    }, ms);
    let loading: Promise<T>;
    try {
      loading = Promise.resolve(load(controller?.signal ?? null));
    } catch (error) {
      loading = Promise.reject(error);
    }
    loading.then(
      (value) => {
        if (done) return;
        done = true;
        cancel();
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        cancel();
        reject(error);
      },
    );
  });
}
