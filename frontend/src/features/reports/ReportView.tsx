"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { Btn, DataTable, ErrorPanel, Loaded, SelectField, TextField, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api, downloadFile, toQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Named, ReportData } from "@/lib/types";

interface FilterOptions {
  departments: Named[];
  locations: Named[];
  trainings: Named[];
  trainers: Named[];
  batches: Named[];
  grades: string[];
}

type Filters = Record<string, string>;
const toOptions = (items: Named[] = []) => items.map((i) => ({ value: i.id, label: i.name }));

export function FilterBar({ filters, onApply, showDates = true }: { filters: Filters; onApply: (f: Filters) => void; showDates?: boolean }) {
  const options = useApi<FilterOptions>("/reports/filter-options");
  const [error, setError] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries([...new FormData(event.currentTarget).entries()].map(([k, v]) => [k, String(v)]).filter(([, v]) => v));
    if (values.date_from && values.date_to && values.date_from > values.date_to) {
      setError("The start date must be before the end date.");
      return;
    }
    setError("");
    onApply(values);
  };
  const o = options.data;
  return (
    <form className="filters" id="filters" onSubmit={submit} key={JSON.stringify(filters)}>
      {showDates ? (
        <>
          <TextField label="Completed from" name="date_from" type="date" defaultValue={filters.date_from ?? ""} />
          <TextField label="Completed to" name="date_to" type="date" defaultValue={filters.date_to ?? ""} />
        </>
      ) : null}
      <SelectField label="Department" name="department_id" placeholder="All departments" options={toOptions(o?.departments)} defaultValue={filters.department_id ?? ""} />
      <SelectField label="Location" name="location_id" placeholder="All locations" options={toOptions(o?.locations)} defaultValue={filters.location_id ?? ""} />
      <SelectField label="Training" name="training_id" placeholder="All training" options={toOptions(o?.trainings)} defaultValue={filters.training_id ?? ""} />
      <SelectField label="Trainer" name="trainer_id" placeholder="All trainers" options={toOptions(o?.trainers)} defaultValue={filters.trainer_id ?? ""} />
      <SelectField label="Batch" name="batch_id" placeholder="All batches" options={toOptions(o?.batches)} defaultValue={filters.batch_id ?? ""} />
      <SelectField label="Employee grade" name="grade" placeholder="All grades" options={(o?.grades ?? []).map((g) => ({ value: g, label: g }))} defaultValue={filters.grade ?? ""} />
      <button className="btn secondary" type="submit">
        Apply filters
      </button>
      <Btn kind="text" onClick={() => onApply({})}>
        Clear
      </Btn>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function ExportButtons({ code, filters, ownRecord = false }: { code: string; filters: Filters; ownRecord?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const run = async (format: "CSV" | "XLSX" | "PDF") => {
    setBusy(format);
    try {
      const record = await api.post<{ id: string; file_name: string }>("/reports/exports", { report_code: code, export_format: format, filters, own_record: ownRecord });
      await downloadFile(`/reports/exports/${record.id}/download`, record.file_name);
      toast("Report exported using your current filters and permissions.");
    } catch (e) {
      toast((e as ApiError).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      {(["CSV", "XLSX", "PDF"] as const).map((format) => (
        <Btn key={format} tone="data" disabled={Boolean(busy)} onClick={() => void run(format)}>
          {busy === format ? "Preparing…" : format === "XLSX" ? "Excel (.xlsx)" : format}
        </Btn>
      ))}
    </>
  );
}

function ScheduleDialog({ code, filters, onClose }: { code: string; filters: Filters; onClose: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api.post("/reports/schedules", { report_code: code, cadence: form.get("cadence"), export_format: form.get("format"), filters });
      toast("Schedule saved.");
      onClose();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <Modal title="Schedule this report" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <SelectField label="How often" name="cadence" options={[{ value: "WEEKLY", label: "Weekly" }, { value: "MONTHLY", label: "Monthly" }]} />
        <SelectField label="Format" name="format" options={[{ value: "XLSX", label: "Excel (.xlsx)" }, { value: "CSV", label: "CSV" }, { value: "PDF", label: "PDF" }]} />
        <div className="notice">You are the only recipient. Each run applies your permissions at that time and appears in your downloads and notifications. Email delivery is not connected until Finvasia approves a provider.</div>
        {error ? <ErrorPanel error={error} /> : null}
        <div className="dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button className="btn primary" type="submit">
            Save schedule
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One report: filters, definitions, table and exports. Used by every role, scoped by the backend. */
export function ReportPanel({ code, canSchedule = true, showFilters = true }: { code: string; canSchedule?: boolean; showFilters?: boolean }) {
  const [filters, setFilters] = useState<Filters>({});
  const path = useMemo(() => `/reports/${code}${toQuery(filters)}`, [code, filters]);
  const state = useApi<ReportData>(path);
  const [scheduling, setScheduling] = useState(false);
  return (
    <section className="panel">
      {showFilters ? <FilterBar filters={filters} onApply={setFilters} /> : null}
      <Loaded state={state}>
        {(report) => (
          <>
            <div className="section-heading">
              <div>
                <h2>{report.title}</h2>
                <p className="small">
                  {report.rows.length} rows · {report.description}
                </p>
              </div>
              <div className="row wrap">
                <ExportButtons code={code} filters={filters} />
                {canSchedule ? (
                  <Btn onClick={() => setScheduling(true)}>
                    <Icon name="calendar" /> Schedule
                  </Btn>
                ) : null}
              </div>
            </div>
            <DataTable headers={report.columns} rows={report.rows} emptyTitle="No rows match these filters." />
            {report.definitions.map((d) => (
              <p className="small" key={d}>
                {d}
              </p>
            ))}
          </>
        )}
      </Loaded>
      {scheduling ? <ScheduleDialog code={code} filters={filters} onClose={() => setScheduling(false)} /> : null}
    </section>
  );
}

const CODES: [string, string][] = [
  ["compliance", "Training Completion and Compliance"],
  ["pass-fail", "Pass/Fail and Red-Flag Employees"],
  ["learning-gain", "Pre-Test vs Post-Test Learning Gain"],
  ["behaviour", "Behaviour Change Tracker"],
  ["question-analytics", "Question Analytics"],
  ["employee-history", "Employee Training History"],
  ["scorecard", "Training Learning & Behaviour Scorecard"],
];

export function ReportsHub() {
  const [code, setCode] = useState("compliance");
  const exportsState = useApi<{ id: string; report_code: string; export_format: string; row_count: number; file_name: string; created_at: string }[]>("/reports/exports");
  const schedules = useApi<{ id: string; report_code: string; cadence: string; export_format: string; next_run_at: string; is_active: boolean; deliveries: { run_at: string; status: string }[] }[]>("/reports/schedules");
  const toast = useToast();
  const stop = async (id: string) => {
    try {
      await api.del(`/reports/schedules/${id}`);
      toast("Schedule stopped.");
      void schedules.reload();
    } catch (e) {
      toast((e as ApiError).message);
    }
  };
  return (
    <>
      <section className="panel">
        <SelectField label="Report" value={code} onChange={(e) => setCode(e.target.value)} options={CODES.map(([value, label]) => ({ value, label }))} />
      </section>
      <ReportPanel key={code} code={code} />
      <section className="panel">
        <h2>Downloads</h2>
        <p className="small">Files you generated. Only you can download them, and your current permissions are checked each time.</p>
        <Loaded state={exportsState}>
          {(rows) => (
            <DataTable
              headers={["Report", "Format", "Rows", "Generated (UTC)", ""]}
              emptyTitle="No exports yet."
              emptyHint="Use CSV, Excel or PDF above."
              rows={rows.map((r) => [
                r.report_code,
                r.export_format,
                r.row_count,
                r.created_at.slice(0, 16).replace("T", " "),
                <Btn key={r.id} kind="text" tone="data" onClick={() => downloadFile(`/reports/exports/${r.id}/download`, r.file_name).catch((e: ApiError) => toast(e.message))}>
                  Download
                </Btn>,
              ])}
            />
          )}
        </Loaded>
      </section>
      <section className="panel">
        <h2>Scheduled delivery</h2>
        <Loaded state={schedules}>
          {(rows) => (
            <DataTable
              headers={["Report", "Cadence", "Format", "Next run (UTC)", "Last delivery", ""]}
              emptyTitle="No schedules yet."
              emptyHint="Open a report and choose Schedule."
              rows={rows.map((s) => [
                s.report_code,
                s.cadence === "WEEKLY" ? "Weekly" : "Monthly",
                s.export_format,
                s.is_active ? s.next_run_at.slice(0, 16).replace("T", " ") : "Stopped",
                s.deliveries[0] ? `${s.deliveries[0].status} · ${s.deliveries[0].run_at.slice(0, 10)}` : "None yet",
                s.is_active ? (
                  <Btn key={s.id} kind="text" tone="danger" onClick={() => void stop(s.id)}>
                    Stop
                  </Btn>
                ) : null,
              ])}
            />
          )}
        </Loaded>
      </section>
    </>
  );
}
