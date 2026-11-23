/* Paging the notification list (audit B21). The first page comes from the shared cache; older pages are appended
   below it. The server orders by (created_at, id) and continues strictly after `before`, so pages never overlap;
   merging by ID still guarantees no duplicate is shown.

   No path aliases here: the unit tests load this file directly with Node. */

/** The server's page size: the default, and the largest page it returns. */
export const NOTIFICATION_PAGE_SIZE = 100;

export interface Older<T> {
  /** The ID of the first page's last item when these older items were loaded. */
  anchor: string;
  items: T[];
  hasMore: boolean;
}

/** The notifications to show: the first page, then the older pages, each ID once, newest first. Older pages are kept
    only while the first page still ends where they started; if it no longer does (new notifications arrived and the
    first page moved), they are dropped so the list never shows a gap. */
export function shownNotifications<T extends { id: string }>(first: T[], older: Older<T> | null): T[] {
  if (!older || !first.length || first[first.length - 1].id !== older.anchor) return first;
  const seen = new Set(first.map((n) => n.id));
  return [...first, ...older.items.filter((n) => !seen.has(n.id) && seen.add(n.id))];
}

/** Whether an older page may exist: after the first page, it does when that page was full; afterwards, the server says. */
export function mayHaveOlder<T extends { id: string }>(first: T[], older: Older<T> | null): boolean {
  if (older && first.length && first[first.length - 1].id === older.anchor) return older.hasMore;
  return first.length >= NOTIFICATION_PAGE_SIZE;
}

/** The request for the next older page: after the last notification shown. */
export function olderPagePath(shown: { id: string }[]): string {
  return `/me/notifications?before=${encodeURIComponent(shown[shown.length - 1].id)}&limit=${NOTIFICATION_PAGE_SIZE}`;
}

/** Older pages after loading one more: appended in order, each ID once. */
export function withOlderPage<T extends { id: string }>(first: T[], older: Older<T> | null, page: T[], hasMore: boolean): Older<T> {
  const anchor = first[first.length - 1].id;
  const kept = older && older.anchor === anchor ? older.items : [];
  const seen = new Set([...first, ...kept].map((n) => n.id));
  return { anchor, items: [...kept, ...page.filter((n) => !seen.has(n.id) && seen.add(n.id))], hasMore };
}

/** Older pages with one notification replaced (after it was marked read or unread). */
export function replaceInOlder<T extends { id: string }>(older: Older<T> | null, changed: T): Older<T> | null {
  return older ? { ...older, items: older.items.map((n) => (n.id === changed.id ? changed : n)) } : older;
}

/* ---------- Read-state changes made while an older page is loading ----------
   A page that was requested before a Mark Read, Mark Unread or Mark All Read carries the read state from before it.
   Every such change is numbered; a page is reconciled with the changes made after it was requested, so a delayed
   page can never undo a newer change. */

export interface ReadChanges {
  /** Number of the latest change. */
  seq: number;
  /** The latest Mark Read / Mark Unread of each notification, with its number. */
  marks: Record<string, { read: boolean; seq: number }>;
  /** Number of the latest Mark All Read, or 0. */
  allReadSeq: number;
}

export const noReadChanges = (): ReadChanges => ({ seq: 0, marks: {}, allReadSeq: 0 });

export function withMark(changes: ReadChanges, id: string, read: boolean): ReadChanges {
  const seq = changes.seq + 1;
  return { ...changes, seq, marks: { ...changes.marks, [id]: { read, seq } } };
}

export function withMarkAll(changes: ReadChanges): ReadChanges {
  const seq = changes.seq + 1;
  return { ...changes, seq, allReadSeq: seq };
}

/** The notifications of a page requested when `since` was the latest change, with every later change applied. */
export function reconcileReadState<T extends { id: string; read: boolean }>(items: T[], changes: ReadChanges, since: number): T[] {
  return items.map((n) => {
    const mark = changes.marks[n.id];
    const markSeq = mark && mark.seq > since ? mark.seq : 0;
    const allSeq = changes.allReadSeq > since ? changes.allReadSeq : 0;
    if (!markSeq && !allSeq) return n;
    const read = markSeq > allSeq ? mark.read : true;
    return read === n.read ? n : { ...n, read };
  });
}
