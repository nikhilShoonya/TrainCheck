/* Pure helpers for the Induction pages (no React), so unit tests can load them directly. */

import type { InductionAssignmentStatus, InductionBatch } from "@/lib/types";

export const INDUCTION_HOME = "/lnd/induction";

export type MainTab = "inductions" | "assessment" | "feedback";
export type DetailTab = "batches" | "employees" | "records";
export type RecordsTab = "assessment" | "feedback";

export const MAIN_TABS: [MainTab, string][] = [
  ["inductions", "Inductions"],
  ["assessment", "Common Assessment"],
  ["feedback", "Common Feedback Form"],
];

export const DETAIL_TABS: [DetailTab, string][] = [
  ["batches", "Batches"],
  ["employees", "Employees"],
  ["records", "Records"],
];

export const RECORD_TABS: [RecordsTab, string][] = [
  ["assessment", "Assessment Records"],
  ["feedback", "Feedback Form Records"],
];

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const asMainTab = (value: string | null): MainTab => (value === "assessment" || value === "feedback" ? value : "inductions");
export const asDetailTab = (value: string | null): DetailTab => (value === "employees" || value === "records" ? value : "batches");
export const asRecordsTab = (value: string | null): RecordsTab => (value === "feedback" ? "feedback" : "assessment");

/** The main Induction page, on a tab and with its card search kept. */
export function inductionHref(tab: MainTab | null, q?: string | null): string {
  const params = new URLSearchParams();
  if (tab && tab !== "inductions") params.set("tab", tab);
  if (q?.trim()) params.set("q", q.trim());
  const query = params.toString();
  return query ? `${INDUCTION_HOME}?${query}` : INDUCTION_HOME;
}

/** A selected induction, on a tab. `q` carries the main page's card search for Back to Induction. */
export function inductionDetailHref(id: string, tab: DetailTab = "batches", extra: Record<string, string | null | undefined> = {}): string {
  const params = new URLSearchParams();
  if (tab !== "batches") params.set("tab", tab);
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  const query = params.toString();
  return `${INDUCTION_HOME}/${id}${query ? `?${query}` : ""}`;
}

export const STATUS_TONE: Record<InductionAssignmentStatus | "NOT_ASSIGNED", string> = {
  ASSIGNED: "info",
  IN_PROGRESS: "info",
  FEEDBACK_PENDING: "warning",
  COMPLETED: "success",
  NOT_ASSIGNED: "info",
};

export const STATUS_LABEL: Record<InductionAssignmentStatus | "NOT_ASSIGNED", string> = {
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  FEEDBACK_PENDING: "Feedback pending",
  COMPLETED: "Completed",
  NOT_ASSIGNED: "Not assigned",
};

export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "ASSIGNED", label: "Assigned" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "FEEDBACK_PENDING", label: "Feedback pending" },
  { value: "COMPLETED", label: "Completed" },
];

export const RESULT_FILTERS = [
  { value: "PASSED", label: "Passed" },
  { value: "NOT_PASSED", label: "Not passed" },
];

export const CONTROL_LABEL: Record<"STARS" | "SCALE", string> = { STARS: "1–5 stars", SCALE: "Very Poor … Excellent" };

/** "November 2026" choices present in these batches, newest first, as "2026-11". */
export function monthOptions(batches: Pick<InductionBatch, "year" | "month">[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const b of [...batches].sort((x, y) => y.year - x.year || y.month - x.month)) seen.set(`${b.year}-${String(b.month).padStart(2, "0")}`, `${MONTHS[b.month - 1]} ${b.year}`);
  return [...seen].map(([value, label]) => ({ value, label }));
}

export function parseMonth(value: string | null | undefined): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
}

/** The batches of a month ("2026-11"), or all of them. */
export function batchesInMonth<T extends Pick<InductionBatch, "year" | "month">>(batches: T[], month: string | null | undefined): T[] {
  const parsed = parseMonth(month);
  return parsed ? batches.filter((b) => b.year === parsed.year && b.month === parsed.month) : batches;
}

/** A batch filter that no longer fits the chosen month is cleared, so the list never shows an impossible filter. */
export function keepBatch(batchId: string, batches: Pick<InductionBatch, "id" | "year" | "month">[], month: string): string {
  return batchId && batchesInMonth(batches, month).some((b) => b.id === batchId) ? batchId : "";
}

export interface RecordFilterState {
  q: string;
  month: string;
  batch: string;
  department: string;
  status: string;
  result: string;
  sort: string;
  direction: "asc" | "desc";
  page: number;
  size: number;
}

export const DEFAULT_FILTERS: RecordFilterState = { q: "", month: "", batch: "", department: "", status: "", result: "", sort: "", direction: "asc", page: 1, size: 20 };

/** The server query for a records tab. Every filter is applied by the server, scoped to the induction. */
export function recordQuery(f: RecordFilterState, kind: RecordsTab): Record<string, string> {
  const out: Record<string, string> = { page: String(f.page), page_size: String(f.size) };
  const month = parseMonth(f.month);
  if (f.q.trim()) out.q = f.q.trim();
  if (month) {
    out.year = String(month.year);
    out.month = String(month.month);
  }
  if (f.batch) out.batch_id = f.batch;
  if (f.department) out.department_id = f.department;
  if (kind === "assessment" && f.status) out.status = f.status;
  if (kind === "assessment" && f.result) out.result = f.result;
  if (f.sort) {
    out.sort = f.sort;
    out.direction = f.direction;
  }
  return out;
}

/** The same filters for an export, without paging: every matching record is exported. */
export function exportFilters(f: RecordFilterState, kind: RecordsTab): Record<string, string> {
  const { page: _page, page_size: _size, ...rest } = recordQuery(f, kind);
  return rest;
}

/** The filters kept in the address, so Back from a record detail and a reload return to the same list. */
export function filtersFromParams(params: { get(name: string): string | null }): RecordFilterState {
  const n = (v: string | null, fallback: number) => (v && /^\d+$/.test(v) ? Math.max(1, Number(v)) : fallback);
  return {
    q: params.get("q") ?? "",
    month: parseMonth(params.get("month")) ? (params.get("month") as string) : "",
    batch: params.get("batch") ?? "",
    department: params.get("department") ?? "",
    status: params.get("status") ?? "",
    result: params.get("result") ?? "",
    sort: params.get("sort") ?? "",
    direction: params.get("direction") === "desc" ? "desc" : "asc",
    page: n(params.get("page"), 1),
    size: [10, 20, 50, 100].includes(Number(params.get("size"))) ? Number(params.get("size")) : 20,
  };
}

export function filtersToParams(f: RecordFilterState): Record<string, string | null> {
  return {
    q: f.q.trim() || null,
    month: f.month || null,
    batch: f.batch || null,
    department: f.department || null,
    status: f.status || null,
    result: f.result || null,
    sort: f.sort || null,
    direction: f.sort && f.direction === "desc" ? "desc" : null,
    page: f.page > 1 ? String(f.page) : null,
    size: f.size !== 20 ? String(f.size) : null,
  };
}

export function minutes(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const m = Math.round(seconds / 60);
  return `${m} min`;
}

export function percentShown(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value}%`;
}
