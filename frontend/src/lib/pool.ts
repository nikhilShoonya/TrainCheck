/* Question pool readiness, as reported by GET /admin/trainings/{id}/question-pool.
   Counts always come from the backend; this file only compares them with what L&D is typing.
   The backend re-validates every save, so nothing here can bypass the rules. */

export type Difficulty = "EASY" | "MEDIUM" | "HARD";
export const DIFFICULTIES: Difficulty[] = ["EASY", "MEDIUM", "HARD"];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { EASY: "Easy", MEDIUM: "Medium", HARD: "Hard" };

export interface DifficultyGap {
  difficulty: Difficulty;
  available: number;
  required: number;
  shortfall: number;
}

export interface PoolReport {
  training_id: string;
  linked_total: number;
  active: number;
  inactive: number;
  missing_answer_key: number;
  missing_answer_key_codes: string[];
  insufficient_options: number;
  insufficient_options_codes: string[];
  eligible: number;
  eligible_by_difficulty: Record<Difficulty, number>;
  suggested_question_count: number;
  required: number | null;
  shortfall: number | null;
  difficulty_mix: Record<Difficulty, number> | null;
  mix_total: number | null;
  difficulty_shortfalls: DifficultyGap[];
  reason: string | null;
  reasons?: string[];
  ready: boolean | null;
}

export const SUGGESTED_MAX_QUESTIONS = 10;

/** An existing admin-configured value always wins and is never reduced.
 *  Otherwise suggest min(10, eligible). With no eligible questions there is no sensible default. */
export function defaultQuestionsPerAttempt(configured: number | null | undefined, eligible: number): number | null {
  if (configured) return configured;
  return eligible > 0 ? Math.min(SUGGESTED_MAX_QUESTIONS, eligible) : null;
}

export interface PlanCheck {
  shortfall: number;
  mixTotal: number | null;
  mixMismatch: boolean;
  gaps: DifficultyGap[];
  ready: boolean;
}

/** Compares a planned configuration with the backend's counts. Difficulty is checked only when a mix is set. */
export function checkPlan(report: PoolReport, count: number | null, mix: Record<Difficulty, number> | null): PlanCheck {
  const shortfall = count ? Math.max(0, count - report.eligible) : 0;
  const mixTotal = mix ? DIFFICULTIES.reduce((sum, d) => sum + (mix[d] || 0), 0) : null;
  const gaps = mix
    ? DIFFICULTIES.filter((d) => (mix[d] || 0) > report.eligible_by_difficulty[d]).map((d) => ({ difficulty: d, available: report.eligible_by_difficulty[d], required: mix[d], shortfall: mix[d] - report.eligible_by_difficulty[d] }))
    : [];
  const mixMismatch = mix !== null && count !== null && mixTotal !== count;
  return { shortfall, mixTotal, mixMismatch, gaps, ready: Boolean(count) && shortfall === 0 && !mixMismatch && gaps.length === 0 };
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The plain-language sentence from the brief, e.g.
 *  "Sales has 8 eligible active questions, but your assessment requires 10. Please add 2 more questions or reduce questions per attempt to 8." */
export function shortfallSentence(title: string, eligible: number, required: number): string {
  if (eligible === 0) return `${title} has no eligible active questions, but your assessment requires ${required}. Please add or import at least ${plural(required, "question")} for this training.`;
  return `${title} has ${plural(eligible, "eligible active question")}, but your assessment requires ${required}. Please add ${required - eligible} more ${required - eligible === 1 ? "question" : "questions"} or reduce questions per attempt to ${eligible}.`;
}

/** Why questions linked to the training are not counted. Empty when nothing is excluded. */
export function exclusionNotes(report: PoolReport): string[] {
  const notes: string[] = [];
  const codes = (list: string[], total: number) => (list.length ? ` (${list.join(", ")}${total > list.length ? ", …" : ""})` : "");
  if (report.inactive) notes.push(`${plural(report.inactive, "inactive question")} not counted`);
  if (report.missing_answer_key) notes.push(`${plural(report.missing_answer_key, "question")} without a correct answer${codes(report.missing_answer_key_codes, report.missing_answer_key)}`);
  if (report.insufficient_options) notes.push(`${plural(report.insufficient_options, "question")} with fewer than 2 options${codes(report.insufficient_options_codes, report.insufficient_options)}`);
  return notes;
}

/** A summary of a saved configuration's problem, for places other than the settings form. */
export function describePool(report: PoolReport, title: string): string {
  if (report.reason === "NOT_CONFIGURED") return `No assessment is configured yet. ${title} has ${plural(report.eligible, "eligible active question")}.`;
  const parts: string[] = [];
  if (report.required !== null && report.shortfall) parts.push(shortfallSentence(title, report.eligible, report.required));
  if (report.mix_total !== null && report.required !== null && report.mix_total !== report.required) parts.push(`The difficulty counts total ${report.mix_total}, but questions per attempt is ${report.required}.`);
  for (const gap of report.difficulty_shortfalls) parts.push(`${DIFFICULTY_LABEL[gap.difficulty]}: ${gap.available} available, ${gap.required} required.`);
  return parts.join(" ") || "The question pool satisfies this assessment.";
}
