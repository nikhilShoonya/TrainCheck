/* Employee Scorecard: links, filters and the five-row rule, as plain functions the unit tests can load.
   No path aliases and no React here: tests/unit/employeeScorecard.test.mjs imports this file directly. */

export interface ScorecardProfile {
  id: string;
  name: string;
  employee_code: string;
  department: string | null;
  location: string | null;
  grade: string | null;
  joining_date: string | null;
  email: string | null;
}

export interface TrainingRecord {
  enrolment_id: string;
  training_id: string;
  training: string;
  assigned_at: string;
  completed_at: string | null;
  first_score: number | null;
  latest_score: number | null;
  highest_score: number | null;
  attempts: number;
  assessment_timing: string;
  result: string;
  training_cycle: number;
}

export interface GainItem {
  training_id: string;
  training: string;
  pre_test: number | null;
  first_post_test: number | null;
  gain: number | null;
  comparable: boolean;
  note: string | null;
}

export type FeedbackKey = "relevance" | "clarity" | "alignment" | "fairness" | "confidence";

export interface FeedbackItem {
  training_id: string;
  training: string;
  training_cycle: number;
  show_cycle: boolean;
  status: "SUBMITTED" | "NOT_SUBMITTED" | "NOT_REQUIRED";
  ratings: Record<FeedbackKey, number> | null;
  overall: number | null;
  comment: string | null;
  submitted_at: string | null;
}

export interface AttemptItem {
  id: string;
  training_id: string;
  training: string;
  assessment_type: "PRE_TEST" | "POST_TEST";
  attempt_number: number;
  training_cycle: number;
  show_cycle: boolean;
  score: number | null;
  result: string;
  submitted_at: string | null;
  submission: string;
}

export interface EmployeeScorecardData {
  employee: ScorecardProfile;
  filters: ScorecardFilters;
  date_basis: string;
  training_options: { id: string; name: string }[];
  summary: { assigned: number; completed: number; passed: number; overdue: number };
  trainings: TrainingRecord[];
  learning_gain: GainItem[];
  feedback: FeedbackItem[];
  attempts: AttemptItem[];
  definitions: string[];
  generated_at: string;
}

export interface ScorecardFilters {
  training_id?: string;
  date_from?: string;
  date_to?: string;
}

/** Each table first shows this many rows; "View all" shows the rest. */
export const ROW_LIMIT = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isEmployeeId = (value: string | null | undefined): value is string => Boolean(value && UUID.test(value));

/* ---------- Reports & Analytics state in the URL (so Back to report restores it) ---------- */

export const REPORT_CODES = ["compliance", "pass-fail", "learning-gain", "behaviour", "question-analytics", "employee-history", "scorecard"] as const;
export const DEFAULT_REPORT = "compliance";
/** The filters the report page offers. Anything else in a URL is ignored. */
export const REPORT_FILTER_KEYS = ["date_from", "date_to", "department_id", "location_id", "training_id", "trainer_id", "grade"] as const;

type Params = { get(name: string): string | null };

function cleanValue(key: string, value: string | null): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text || text.length > 120) return null;
  if (key === "date_from" || key === "date_to") return ISO_DAY.test(text) ? text : null;
  return text;
}

/** The report and filters a Reports & Analytics URL selects. Unknown reports fall back to the default. */
export function parseReportState(params: Params): { code: string; filters: Record<string, string> } {
  const requested = params.get("report") ?? "";
  const code = (REPORT_CODES as readonly string[]).includes(requested) ? requested : DEFAULT_REPORT;
  const filters: Record<string, string> = {};
  for (const key of REPORT_FILTER_KEYS) {
    const value = cleanValue(key, params.get(key));
    if (value) filters[key] = value;
  }
  return { code, filters };
}

/** "report=…&department_id=…" for a report and its filters, without a leading "?". */
export function reportStateQuery(code: string, filters: Record<string, string>): string {
  const query = new URLSearchParams();
  query.set("report", code);
  for (const key of REPORT_FILTER_KEYS) if (filters[key]) query.set(key, filters[key]);
  return query.toString();
}

/** Back to report: always the Reports & Analytics page, with only the known report state from `back`. A crafted
    `back` value can never send the browser anywhere else. */
export function reportsHref(back: string | null | undefined): string {
  if (!back) return "/lnd/reports";
  const { code, filters } = parseReportState(new URLSearchParams(back.startsWith("?") ? back.slice(1) : back));
  return `/lnd/reports?${reportStateQuery(code, filters)}`;
}

/** The scorecard of one employee, identified by database ID, remembering the report state to return to. */
export function scorecardHref(employeeId: string, back?: string, filters: ScorecardFilters = {}): string {
  const query = new URLSearchParams();
  for (const key of ["training_id", "date_from", "date_to"] as const) if (filters[key]) query.set(key, filters[key]!);
  if (back) query.set("back", back);
  const text = query.toString();
  return `/lnd/reports/employees/${encodeURIComponent(employeeId)}${text ? `?${text}` : ""}`;
}

/** The scorecard's own filters from its URL: training and completion-date range only. */
export function parseScorecardFilters(params: Params): ScorecardFilters {
  const filters: ScorecardFilters = {};
  const training = params.get("training_id");
  if (training && UUID.test(training)) filters.training_id = training;
  for (const key of ["date_from", "date_to"] as const) {
    const value = cleanValue(key, params.get(key));
    if (value) filters[key] = value;
  }
  return filters;
}

export function datesProblem(filters: ScorecardFilters): string | null {
  return filters.date_from && filters.date_to && filters.date_from > filters.date_to ? "The start date must be on or before the end date." : null;
}

/* ---------- Five rows, then View all ---------- */

/** The rows on screen: the first five of the full (already sorted) list, or all of them once expanded. */
export function limitRows<T>(rows: T[], expanded: boolean, limit = ROW_LIMIT): T[] {
  return expanded ? rows : rows.slice(0, limit);
}

export const needsExpansion = (total: number, limit = ROW_LIMIT) => total > limit;

export const viewAllLabel = (total: number, expanded: boolean) => (expanded ? "Show less" : `View all (${total})`);

/** "Showing 5 of 8 attempts", "Showing 3 of 3 trainings", "No trainings". */
export function showingLabel(total: number, expanded: boolean, singular: string, plural = `${singular}s`, limit = ROW_LIMIT): string {
  if (total === 0) return `No ${plural}`;
  const shown = expanded ? total : Math.min(total, limit);
  return `Showing ${shown} of ${total} ${total === 1 ? singular : plural}`;
}

/* ---------- Values ---------- */

/** A score as recorded (already rounded down to two decimals by the server). Missing is "—", never zero. */
export function scoreText(value: number | null | undefined, unit = "%"): string {
  if (value === null || value === undefined) return "—";
  return `${Number(value.toFixed(2))}${unit}`;
}

export function firstLatestText(first: number | null, latest: number | null): string {
  return first === null && latest === null ? "—" : `${scoreText(first, "")} / ${scoreText(latest, "")}`;
}

export function gainText(item: GainItem): string {
  if (!item.comparable || item.gain === null) return "Not comparable";
  const value = Number(item.gain.toFixed(2));
  return `${value > 0 ? "+" : ""}${value} points`;
}

export const ratingText = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toFixed(1));

export function attemptText(item: AttemptItem): string {
  return item.show_cycle ? `Cycle ${item.training_cycle} · Attempt ${item.attempt_number}` : String(item.attempt_number);
}

export const TYPE_LABEL: Record<AttemptItem["assessment_type"], string> = { PRE_TEST: "Pre-test", POST_TEST: "Post-test" };

/** Describes which dates the tables cover, for the "Showing …" lines. */
export function scopeText(filters: ScorecardFilters, show: (iso: string) => string): string {
  if (!filters.date_from && !filters.date_to) return "all time";
  if (filters.date_from && filters.date_to) return `completed ${show(filters.date_from)} to ${show(filters.date_to)}`;
  return filters.date_from ? `completed from ${show(filters.date_from)}` : `completed up to ${show(filters.date_to!)}`;
}

/* ---------- The Date dropdown: training completion date ranges ---------- */

export type DatePreset = "all" | "30" | "90" | "year" | "custom";

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: "all", label: "All dates" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "year", label: "This year" },
  { value: "custom", label: "Custom range" },
];

/** A calendar date moved by whole days (YYYY-MM-DD in and out; no timezone involved). */
export function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The completion-date range of a preset, ending today (the organisation's today, YYYY-MM-DD). */
export function presetRange(preset: DatePreset, today: string): Pick<ScorecardFilters, "date_from" | "date_to"> {
  if (preset === "30") return { date_from: shiftDay(today, -29), date_to: today };
  if (preset === "90") return { date_from: shiftDay(today, -89), date_to: today };
  if (preset === "year") return { date_from: `${today.slice(0, 4)}-01-01`, date_to: today };
  return {};
}

/** Which Date option a URL's range is: a preset when it matches one exactly, otherwise Custom range. */
export function presetOf(filters: ScorecardFilters, today: string): DatePreset {
  if (!filters.date_from && !filters.date_to) return "all";
  for (const preset of ["30", "90", "year"] as const) {
    const range = presetRange(preset, today);
    if (range.date_from === filters.date_from && range.date_to === filters.date_to) return preset;
  }
  return "custom";
}

/** A typed date is applied only once it is a complete, plausible date (not "0002-11-05" while the year is typed). */
export const isCompleteDay = (value: string) => /^(19|20)\d{2}-\d{2}-\d{2}$/.test(value);
