/* Entering a post-training assessment from My Trainings. Presentation only: the server decides whether an
   assessment is open (entry_state), refuses early starts and enforces the gate on every request. */
import type { AccessState, TrainingCard } from "@/lib/types";
import { dateTimeIn } from "@/lib/utils";

/** HH:MM:SS, rounding up so the screen never shows 00:00:00 while time remains. Hours may exceed 24. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Time measured from the server's clock at the moment its answer arrived, advanced by a monotonic timer
    (performance.now), so changing the device's clock cannot move the opening. Re-synced on every server answer. */
export function serverClock(serverNowIso: string, monoAtReceipt: number) {
  const serverNow = Date.parse(serverNowIso);
  return {
    remainingMs: (dueIso: string, monoNow: number) => Date.parse(dueIso) - (serverNow + (monoNow - monoAtReceipt)),
  };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const FIXED_MILESTONES = [10 * SECOND, 30 * SECOND, MINUTE, 5 * MINUTE, 10 * MINUTE, 30 * MINUTE];

const spoken = (ms: number) => {
  if (ms >= HOUR) return `${ms / HOUR} hour${ms === HOUR ? "" : "s"}`;
  if (ms >= MINUTE) return `${ms / MINUTE} minute${ms === MINUTE ? "" : "s"}`;
  return `${ms / SECOND} seconds`;
};

/** What to announce when the remaining time goes from `before` to `after`: each whole hour, then 30, 10, 5 and
    1 minutes, 30 and 10 seconds. Never every second. After a long jump only the latest milestone is announced. */
export function milestone(before: number, after: number): string | null {
  const crossed = FIXED_MILESTONES.filter((t) => after <= t && t < before);
  const hour = Math.max(1, Math.ceil(after / HOUR)) * HOUR;
  if (after <= hour && hour < before) crossed.push(hour);
  return crossed.length ? `Your assessment opens in ${spoken(Math.min(...crossed))}.` : null;
}

export interface CardEntry {
  /** A short status for the card, e.g. "Assessment opens 2026-11-19 15:30 (Asia/Kolkata)". */
  status: string | null;
  /** An explanation under the status, or the server's reason when nothing can be done. */
  note: string | null;
  /** The action, only when the server says it can lead somewhere. */
  label: "Start Test" | "Resume Test" | null;
  href: string | null;
}

const REASON_STATUS: Record<string, string> = {
  AWAITING_COMPLETION: "Awaiting training completion",
  AWAITING_SCHEDULING: "Being scheduled by L&D",
  REFRESHER_REQUIRED: "Refresher required",
  AWAITING_APPROVAL: "Waiting for L&D approval",
  QUESTION_POOL_INSUFFICIENT: "Assessment temporarily unavailable",
  TRAINING_ARCHIVED: "Training archived",
  WAIVED: "Assessment waived",
  CANCELLED: "Assessment cancelled",
  COMPLETED: "Assessment finished",
  FEEDBACK_REQUIRED: "Feedback required",
};

type EntryFields = Pick<TrainingCard, "obligation_id" | "due_at" | "timezone" | "planned_at" | "entry_state" | "entry_reason" | "entry_message">;

/** The assessment line and action of one My Trainings card. */
export function cardEntry(card: EntryFields): CardEntry {
  const href = card.obligation_id ? `/assessment/start/${card.obligation_id}` : null;
  const none = { label: null, href: null } as const;
  switch (card.entry_state) {
    case "NOT_YET_OPEN":
      if (!href) break;
      return {
        status: `Assessment opens ${dateTimeIn(card.due_at, card.timezone)}`,
        note: "Selecting Start Test before the opening time shows a countdown. The test starts only after it opens and you confirm the instructions.",
        label: "Start Test",
        href,
      };
    case "OPEN":
      if (!href) break;
      return { status: "Assessment open now", note: null, label: "Start Test", href };
    case "IN_PROGRESS":
      if (!href) break;
      return { status: "Assessment in progress", note: "Your time keeps running on the server.", label: "Resume Test", href };
    case "UNAVAILABLE": {
      const reason = card.entry_reason ?? "";
      if (reason === "AWAITING_COMPLETION" && card.planned_at)
        return { status: REASON_STATUS[reason], note: `Planned opening ${dateTimeIn(card.planned_at, card.timezone)}, only once your completion is recorded.`, ...none };
      return { status: REASON_STATUS[reason] ?? "Assessment not available", note: reason === "COMPLETED" ? null : (card.entry_message ?? null), ...none };
    }
  }
  return { status: null, note: null, ...none };
}

/** The automatic countdown window before a scheduled post-test opens. */
export const PREPARE_WINDOW_MS = 5 * MINUTE;

/** MM:SS for the five-minute countdown (03:00 → 02:59 → … → 00:00), rounding up like countdown(). */
export function shortCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export type WaitingStep = "loading" | "wait" | "confirm" | "gate" | "workspace" | "unavailable";

/** The waiting screen's next step. The gate (with its system check, instructions and confirmation) takes over
    only when the server's access decision says an assessment is due; an "open" answer alone is re-checked.
    Expiry never starts an attempt: the employee still completes preparation and selects Start assessment. */
export function waitingStep(
  detail: Pick<TrainingCard, "entry_state"> | null,
  access: Pick<AccessState, "access_status"> | null,
): WaitingStep {
  if (!access) return "loading";
  if (access.access_status === "ASSESSMENT_REQUIRED") return "gate";
  if (access.access_status === "FEEDBACK_REQUIRED") return "workspace";
  if (!detail) return "loading";
  if (detail.entry_state === "NOT_YET_OPEN") return "wait";
  if (detail.entry_state === "OPEN" || detail.entry_state === "IN_PROGRESS") return "confirm";
  return "unavailable";
}
