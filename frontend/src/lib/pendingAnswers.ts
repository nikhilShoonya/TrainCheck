/* Assessment answers chosen but not yet confirmed by the server, kept in browser storage so a refresh or a closed
   browser can still send them while the attempt is open. One record per signed-in account and attempt.

   Only the minimum is stored: attempt question IDs, selected option IDs, the order of the choices and, when the
   server reported it, the answer revision each choice was made against (plus choices sent whose reply never
   came). Never question text, answer keys, scores, passwords, or session or CSRF tokens. Records are removed after
   a confirmed submission, once the result page has explained them, on sign-out, when another account signs in,
   and a day after the attempt's deadline.

   Reading, writing and removing are separate capabilities: a full quota refuses writes but still lets this page
   read (and recover) a record written earlier, and removal is always attempted. Every function tolerates
   unavailable, full or corrupted storage.

   No imports: the unit tests run this file directly with Node. */

/** Browser storage, or null when the browser refuses it (private mode, policy). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The part of the Web Storage API this file uses, so tests can pass a fake or a failing store. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredEntry {
  /** Attempt question ID. */
  q: string;
  /** Selected option IDs. */
  s: string[];
  /** Order of the choice within the attempt. */
  n: number;
  /** The server's answer revision this choice was made against, when known. */
  b?: number;
  /** Operation IDs already sent for this question whose reply never came: the server may hold one of them. Records
      written before operation IDs listed selections here; those are read but never trusted. */
  u?: (string | string[])[];
}

interface StoredRecord {
  v: 1;
  account: string;
  attempt: string;
  expiresAt: number;
  entries: StoredEntry[];
}

export const STORAGE_PREFIX = "traincheck.pending-answers.v1:";
/** Records are kept this long after the attempt expires, only so the result page can explain unsaved answers. */
export const EXPIRED_RECORD_GRACE_MS = 24 * 60 * 60 * 1000;

const keyFor = (account: string, attempt: string) => `${STORAGE_PREFIX}${account}:${attempt}`;
const strings = (value: unknown) => Array.isArray(value) && value.every((x) => typeof x === "string");
const sameSelection = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function isEntry(value: unknown): value is StoredEntry {
  const e = value as StoredEntry | null;
  if (!e || typeof e.q !== "string" || !Number.isInteger(e.n) || !strings(e.s)) return false;
  if (e.b !== undefined && !(Number.isInteger(e.b) && e.b >= 0)) return false;
  return e.u === undefined || (Array.isArray(e.u) && e.u.every((x) => typeof x === "string" || strings(x)));
}

function readRecord(storage: KeyValueStorage, key: string): StoredRecord | null {
  const text = storage.getItem(key);
  if (text === null) return null;
  const record = JSON.parse(text) as StoredRecord;
  const valid =
    record?.v === 1 && typeof record.account === "string" && typeof record.attempt === "string" && typeof record.expiresAt === "number" && Array.isArray(record.entries) && record.entries.every(isEntry);
  if (!valid) throw new Error("Corrupted pending-answer record");
  return record;
}

/* ---------- Revocation: sign-out and account changes stop every live store, in every tab ---------- */

let clock = 0;
const revocations: { at: number; keep: string | null }[] = [];
const revokeListeners = new Set<() => void>();
const CHANNEL = "traincheck.pending-answers";
let channel: BroadcastChannel | null | undefined;

/** Tells other tabs of this browser; only in a browser (Node's channel would keep the test process alive). */
function tabs(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof window !== "undefined" && typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const keep = (event.data as { keep?: unknown } | null)?.keep;
        if (keep === null || typeof keep === "string") revoke(keep);
      };
    }
  } catch {
    channel = null;
  }
  return channel;
}

function revoke(keep: string | null): void {
  revocations.push({ at: ++clock, keep });
  if (revocations.length > 50) revocations.splice(0, revocations.length - 50);
  for (const listener of [...revokeListeners]) listener();
}

/** Called when a sign-out or an account change revokes stores (here or in another tab). Returns an unsubscribe. */
export function onPendingAnswersRevoked(listener: () => void): () => void {
  tabs();
  revokeListeners.add(listener);
  return () => void revokeListeners.delete(listener);
}

export interface PendingStore {
  /** Whether a write last succeeded (or the first probe did). Recovery is promised only through save()'s result. */
  readonly available: boolean;
  /** Whether a record can be read at all (it can when writes are refused, for example by a full quota). */
  readonly readable: boolean;
  /** True once a sign-out or another account's sign-in has ended this store: it never writes again. */
  readonly revoked: boolean;
  /** The saved entries; [] when there are none or the record was unreadable (it is then removed). */
  load(): StoredEntry[];
  /** Records `entries` as this page's pending choices. With `owned`, entries another tab stored for questions
      this page never touched are kept. True only when every given entry is now held in storage, either by this
      write or by the record already there; a stored record that contradicts them is removed, so an outdated
      choice is never restored. */
  save(entries: StoredEntry[], owned?: ReadonlySet<string>): boolean;
  /** Whether storage currently holds every given entry (another tab may have replaced the record). */
  covers(entries: StoredEntry[]): boolean;
  /** Removes the record. Attempted even when writes are refused. */
  clear(): void;
}

export function pendingStore(storage: KeyValueStorage | null, account: string | null, attempt: string, expiresAt: number): PendingStore {
  tabs();
  const key = account ? keyFor(account, attempt) : null;
  const born = ++clock;
  let writable = false;
  let readable = false;
  if (storage && key) {
    try {
      storage.getItem(key);
      readable = true;
    } catch {
      readable = false; // Storage that cannot even be read is unusable.
    }
    try {
      storage.setItem(`${STORAGE_PREFIX}probe`, "1");
      storage.removeItem(`${STORAGE_PREFIX}probe`);
      writable = true;
    } catch {
      writable = false; // Private mode, disabled storage or a full quota. Reading may still work.
    }
  }
  const revoked = () => revocations.some((r) => r.at > born && r.keep !== account);
  const remove = () => {
    try {
      if (key) storage?.removeItem(key);
    } catch {
      /* Nothing more can be done. */
    }
  };
  /** This account's and attempt's record; a corrupted or foreign one is removed and reads as none. */
  const own = (): StoredRecord | null => {
    if (!readable || !key) return null;
    try {
      const record = readRecord(storage!, key);
      if (record && (record.account !== account || record.attempt !== attempt)) throw new Error("Foreign pending-answer record");
      return record;
    } catch {
      remove();
      return null;
    }
  };
  const holds = (record: StoredRecord | null, entries: StoredEntry[]) => entries.every((e) => record?.entries.some((r) => r.q === e.q && sameSelection(r.s, e.s)));

  return {
    get available() {
      return writable && !revoked();
    },
    get readable() {
      return readable;
    },
    get revoked() {
      return revoked();
    },
    load() {
      if (revoked()) return [];
      return own()?.entries ?? [];
    },
    save(entries, owned) {
      if (!storage || !key || !account || revoked()) return false;
      const existing = own();
      let next = entries;
      if (owned && existing) {
        const mine = new Set(entries.map((e) => e.q));
        next = [...existing.entries.filter((e) => !owned.has(e.q) && !mine.has(e.q)), ...entries];
      }
      try {
        if (!next.length) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify({ v: 1, account, attempt, expiresAt, entries: next } satisfies StoredRecord));
        writable = true;
        return true;
      } catch {
        writable = false;
      }
      // The write was refused. The record already there may still hold these choices; if it holds a different
      // choice for any of these questions, it is removed (removal works even when the quota is full).
      if (existing?.entries.some((r) => entries.some((e) => e.q === r.q && !sameSelection(e.s, r.s)))) {
        remove();
        return entries.length === 0;
      }
      return holds(existing, entries);
    },
    covers(entries) {
      if (!entries.length) return true;
      if (revoked()) return false;
      return holds(own(), entries);
    },
    clear: remove,
  };
}

function storedKeys(storage: KeyValueStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Removes records left by another account and records long past their attempt's deadline. With no
    account (sign-out), removes every record. Live stores of any other account (every store, on sign-out) are
    revoked first, in this tab and in this browser's other tabs, so a save finishing later cannot write a record
    back. Never throws. */
export function purgePendingAnswers(storage: KeyValueStorage | null, keepAccount: string | null, nowMs: number): void {
  revoke(keepAccount);
  try {
    tabs()?.postMessage({ keep: keepAccount });
  } catch {
    /* Other tabs learn of it when their own requests are refused. */
  }
  if (!storage) return;
  try {
    for (const key of storedKeys(storage)) {
      let keep = false;
      try {
        const record = readRecord(storage, key);
        keep = Boolean(record && keepAccount && record.account === keepAccount && key === keyFor(record.account, record.attempt) && record.expiresAt + EXPIRED_RECORD_GRACE_MS > nowMs);
      } catch {
        keep = false;
      }
      if (!keep) storage.removeItem(key);
    }
  } catch {
    /* Storage unavailable: nothing is kept there anyway. */
  }
}

/** For the result page: how many choices this device still held unconfirmed for a finished attempt. Read
    only; call clearPendingAnswers once it has been shown. Null when there is none or storage is unreadable. */
export function countUnconfirmedAnswers(storage: KeyValueStorage | null, account: string, attempt: string): number | null {
  if (!storage) return null;
  try {
    const record = readRecord(storage, keyFor(account, attempt));
    return record && record.account === account && record.attempt === attempt && record.entries.length ? record.entries.length : null;
  } catch {
    return null;
  }
}

export function clearPendingAnswers(storage: KeyValueStorage | null, account: string, attempt: string): void {
  try {
    storage?.removeItem(keyFor(account, attempt));
  } catch {
    /* Nothing more can be done. */
  }
}
