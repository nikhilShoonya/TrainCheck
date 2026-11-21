import type { EnrolmentRow } from "./completionView";

export type WaiverEmployee = Pick<EnrolmentRow, "id" | "employee_name" | "employee_code" | "obligation_id" | "assessment_state">;

/** The same assessment states as the existing individual Waive action. The API rechecks on save. */
export function canWaiveAssessment(row: Pick<WaiverEmployee, "obligation_id" | "assessment_state">): boolean {
  return Boolean(row.obligation_id) && ["Due", "Scheduled", "Awaiting refresher", "Awaiting approval", "Unavailable"].includes(row.assessment_state);
}

export interface WaiverResult {
  employee: WaiverEmployee;
  status: "WAIVED" | "FAILED" | "NOT_ATTEMPTED";
  message: string;
}

/** Process each obligation once, without retries. Access/connection failures stop unsent requests;
 * a business refusal is shown for that employee while other employees can still be processed. */
export async function waiveAssessments(
  employees: WaiverEmployee[],
  save: (employee: WaiverEmployee) => Promise<void>,
  progress: (done: number, total: number) => void,
  cancelled: () => boolean = () => false,
): Promise<WaiverResult[]> {
  const rows = [...new Map(employees.map((row) => [row.obligation_id ?? row.id, row])).values()];
  const results: WaiverResult[] = [];
  let stopped = false;
  for (const employee of rows) {
    if (stopped || cancelled()) {
      results.push({ employee, status: "NOT_ATTEMPTED", message: "Not attempted because saving was interrupted. Refresh before retrying." });
      continue;
    }
    if (!canWaiveAssessment(employee)) {
      results.push({ employee, status: "FAILED", message: "This assessment is not eligible for a waiver. Refresh to see its current status." });
    } else {
      try {
        await save(employee);
        results.push({ employee, status: "WAIVED", message: "Assessment waived." });
      } catch (error) {
        const failure = error as { status?: number; code?: string; message?: string } | null;
        const status = failure?.status ?? 0;
        const uncertain = status === 0 || status >= 500 || failure?.code === "INVALID_RESPONSE";
        stopped = uncertain || [401, 403, 429].includes(status);
        const message = failure?.message || "The waiver could not be confirmed.";
        results.push({ employee, status: "FAILED", message: uncertain ? `${message} Refresh before retrying; the server may have recorded the waiver.` : message });
      }
    }
    progress(results.length, rows.length);
  }
  return results;
}
