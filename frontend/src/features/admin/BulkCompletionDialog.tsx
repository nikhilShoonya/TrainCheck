"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Btn, TextField } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { todayInOrg as today } from "@/lib/utils";
import { completeInBatches, type CompletionEmployee, type CompletionReply, type CompletionResult } from "./bulkCompletion";

export function BulkCompletionDialog({ trainingTitle, employees, excludedCount, onClose, onRecorded, onFinished }: {
  trainingTitle: string;
  employees: CompletionEmployee[];
  excludedCount: number;
  onClose: () => void;
  onRecorded: (reply: CompletionReply) => void;
  onFinished: (results: CompletionResult[]) => void;
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
    running.current = true;
    const form = new FormData(event.currentTarget);
    const date = String(form.get("completion_date"));
    setBusy(true);
    const results = await completeInBatches(
      employees,
      async (employee) => {
        // Each employee's recorded attendance is used (Pending becomes Present); attendance is not changed here.
        const reply = await api.post<CompletionReply>(`/admin/enrolments/${employee.id}/completion`, { completion_date: date });
        if (mounted.current) onRecorded(reply);
        return reply;
      },
      (count) => { if (mounted.current) setDone(count); },
      () => !mounted.current,
    );
    if (mounted.current) onFinished(results);
  };
  return (
    <Modal title="Complete selected employees" onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <p><strong>{employees.length} {employees.length === 1 ? "employee" : "employees"}</strong> · {trainingTitle}</p>
        <ul className="completion-selection-list" aria-label="Selected employees">
          {employees.map((employee) => <li key={employee.id}>{employee.employee_name} ({employee.employee_code})</li>)}
        </ul>
        {excludedCount ? <p className="small">{excludedCount} other selected employee(s) are not eligible for this action and will be skipped.</p> : null}
        <fieldset disabled={busy} className="completion-bulk-fields">
          <TextField label="Completion date *" name="completion_date" type="date" required defaultValue={today()} max={today()} />
        </fieldset>
        <div className="notice">This records training completion only. Required assessments follow the training&apos;s schedule; they are not marked passed. Each employee is checked separately, and any refusal is reported.</div>
        {busy ? <p role="status" aria-live="polite">Processed {done} of {employees.length} employees. Please keep this page open.</p> : null}
        <div className="dialog-actions">
          <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
          <button type="submit" className="btn primary tone-success" disabled={busy || !employees.length}>
            {busy ? "Recording completion…" : "Confirm completion"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
