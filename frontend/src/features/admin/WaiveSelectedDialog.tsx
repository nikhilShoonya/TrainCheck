"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Btn, Field } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { api, invalidResponse } from "@/lib/api";
import { waiveAssessments, type WaiverEmployee, type WaiverResult } from "./waiver";

export function WaiveSelectedDialog({ employees, excludedCount, onClose, onWaived, onFinished }: {
  employees: WaiverEmployee[];
  excludedCount: number;
  onClose: () => void;
  onWaived: (employee: WaiverEmployee) => void;
  onFinished: (results: WaiverResult[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running.current) return;
    const form = event.currentTarget;
    const reason = String(new FormData(form).get("reason") ?? "").trim();
    const input = form.elements.namedItem("reason") as HTMLTextAreaElement;
    input.setCustomValidity(reason.length < 5 ? "Enter a reason of at least 5 characters." : "");
    if (!form.reportValidity()) return;
    running.current = true;
    setBusy(true);
    const results = await waiveAssessments(employees, async (employee) => {
      const reply = await api.post<{ status: string }>(`/admin/obligations/${employee.obligation_id}/waive`, { reason });
      if (reply.status !== "WAIVED") throw invalidResponse(200);
      if (mounted.current) onWaived(employee);
    }, (count) => { if (mounted.current) setDone(count); }, () => !mounted.current);
    if (mounted.current) onFinished(results);
  };
  return (
    <Modal title="Waive selected assessments" onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <p>Waive assessments for <strong>{employees.length} {employees.length === 1 ? "employee" : "employees"}</strong>?</p>
        <ul className="completion-selection-list" aria-label="Selected employees">
          {employees.map((employee) => <li key={employee.id}>{employee.employee_name} ({employee.employee_code})</li>)}
        </ul>
        {excludedCount ? <p className="small">{excludedCount} other selected employee(s) are not eligible for this action and will be skipped.</p> : null}
        <Field label="Reason *">
          <textarea name="reason" required minLength={5} maxLength={1000} disabled={busy} onChange={(event) => event.currentTarget.setCustomValidity("")} />
        </Field>
        <p className="small">The same reason is recorded for each waiver. Waiving removes the assessment requirement; it does not mark a pass or change training completion.</p>
        {busy ? <p role="status" aria-live="polite">Processed {done} of {employees.length} employees. Please keep this page open.</p> : null}
        <div className="dialog-actions">
          <Btn disabled={busy} onClick={onClose}>Cancel</Btn>
          <button type="submit" className="btn primary" disabled={busy || !employees.length}>{busy ? "Waiving assessments…" : "Confirm waiver"}</button>
        </div>
      </form>
    </Modal>
  );
}
