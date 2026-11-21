import type { EnrolmentRow, SchedulingOutcome } from "./completionView";

/** Bulk completion reuses the individual endpoint: every row is validated, committed and audited by the server. */
export interface CompletionCandidate {
  id: string;
  completed_at: string | null;
  attendance_status: string;
}

/** Partial attendance is still subject to the server's policy. Absent/Excused must be corrected explicitly first. */
export function canSelectCompletion(row: CompletionCandidate): boolean {
  return !row.completed_at && ["PENDING", "PRESENT", "PARTIAL"].includes(row.attendance_status);
}

export interface CompletionEmployee extends CompletionCandidate {
  employee_name: string;
  employee_code: string;
}

export interface CompletionReply extends EnrolmentRow {
  assessment_scheduling: SchedulingOutcome;
}

export interface CompletionResult {
  employee: CompletionEmployee;
  status: "COMPLETED" | "ALREADY_COMPLETED" | "FAILED" | "NOT_ATTEMPTED";
  message: string;
  reply?: CompletionReply;
}

/** A small worker pool avoids a request storm. A connection/auth/rate-limit failure stops unsent rows; an
 *  individual business-rule refusal does not prevent other employees being completed. No automatic retries:
 *  a lost reply can mean the completion was committed, so the operator must refresh before trying again. */
export async function completeInBatches(
  employees: CompletionEmployee[],
  save: (employee: CompletionEmployee) => Promise<CompletionReply>,
  progress: (done: number, total: number) => void,
  cancelled: () => boolean = () => false,
): Promise<CompletionResult[]> {
  const rows = [...new Map(employees.map((e) => [e.id, e])).values()];
  const results: CompletionResult[] = new Array(rows.length);
  let next = 0;
  let done = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && !cancelled() && next < rows.length) {
      const index = next++;
      const employee = rows[index];
      try {
        const reply = await save(employee);
        results[index] = { employee, status: "COMPLETED", message: "Training completion recorded.", reply };
      } catch (error) {
        const failure = error as { code?: string; status?: number; message?: string } | null;
        const already = failure?.code === "COMPLETION_EXISTS";
        const status = failure?.status ?? 0;
        const uncertain = status === 0 || status >= 500 || failure?.code === "INVALID_RESPONSE";
        stopped ||= uncertain || [401, 403, 429].includes(status);
        const message = failure?.message || "Completion could not be confirmed.";
        results[index] = {
          employee,
          status: already ? "ALREADY_COMPLETED" : "FAILED",
          message: uncertain ? `${message} Refresh the list before retrying; the server may have recorded completion.` : message,
        };
      }
      progress(++done, rows.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, () => worker()));
  return rows.map((employee, index) => results[index] ?? {
    employee, status: "NOT_ATTEMPTED", message: "Not attempted because the batch was interrupted. Refresh the list before retrying.",
  });
}
