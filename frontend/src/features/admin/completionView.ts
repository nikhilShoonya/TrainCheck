/* Training Completion: the training cards and the per-training employee view. Pure helpers only (no React,
   no API), so the unit tests can check counts, search and links. Run: npm run test:unit */

export const COMPLETION_HOME = "/lnd/completion";

/** The training fields a completion card uses, all from the one /admin/trainings list request. */
export interface CompletionTraining {
  id: string;
  title: string;
  description: string | null;
  assigned_count: number;
  completed_count: number;
  pending_scheduling_count: number;
  unavailable_count: number;
}

/** Training completion (attendance recorded as complete) per training. Says nothing about assessments. */
export function completionCounts(t: Pick<CompletionTraining, "assigned_count" | "completed_count">) {
  return { assigned: t.assigned_count, recorded: t.completed_count, awaiting: Math.max(0, t.assigned_count - t.completed_count) };
}

/** The same three counts for the rows on screen, so they follow every update without another request. */
export function rowCounts(rows: { completed_at: string | null }[]) {
  const recorded = rows.filter((r) => r.completed_at).length;
  return { assigned: rows.length, recorded, awaiting: rows.length - recorded };
}

const normalise = (text: string) => text.trim().toLocaleLowerCase("en");

/** Trainings whose name contains the search text (case-insensitive). An empty search keeps every training. */
export function filterTrainings<T extends { title: string }>(trainings: T[], search: string): T[] {
  const needle = normalise(search);
  return needle ? trainings.filter((t) => normalise(t.title).includes(needle)) : trainings;
}

/** Employees whose name or employee code contains the search text (case-insensitive). */
export function filterEmployees<T extends { employee_name: string; employee_code: string }>(rows: T[], search: string): T[] {
  const needle = normalise(search);
  return needle ? rows.filter((r) => normalise(r.employee_name).includes(needle) || normalise(r.employee_code).includes(needle)) : rows;
}

/** The cards page, keeping the training search so Back to Trainings restores it. */
export function trainingsHref(cardSearch = ""): string {
  const q = cardSearch.trim();
  return q ? `${COMPLETION_HOME}?${new URLSearchParams({ q })}` : COMPLETION_HOME;
}

/** One training's employees. The card search travels along so the way back can restore it. */
export function trainingCompletionHref(trainingId: string, cardSearch = ""): string {
  const q = cardSearch.trim();
  return `${COMPLETION_HOME}/${encodeURIComponent(trainingId)}${q ? `?${new URLSearchParams({ q })}` : ""}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a URL segment can be a training ID. Anything else is shown as not found without asking the server. */
export const isTrainingId = (value: string | undefined | null): value is string => Boolean(value && UUID.test(value));

/** A short description for a card: the first sentence-sized part, cut at a word boundary. */
export function shortDescription(text: string | null, max = 140): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}
