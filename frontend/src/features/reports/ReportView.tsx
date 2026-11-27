"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Btn, DataTable, ErrorPanel, Loaded, Loading, SelectField, TextField, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { parseReportState, reportStateQuery, scorecardHref } from "@/features/reports/employeeScorecardView";
import { ApiError, api, downloadFile, toQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Named, ReportData } from "@/lib/types";
import { dateTime, day } from "@/lib/utils";

interface FilterOptions {
  departments: Named[];
  locations: Named[];
  trainings: Named[];
  trainers: Named[];
  grades: string[];
}

type Filters = Record<string, string>;
const toOptions = (items: Named[] = []) => items.map((i) => ({ value: i.id, label: i.name }));

/** `showTraining={false}` where the page already has its own training selector (the Learning Scorecard): a second
    Training control could only disagree with it. */
export function FilterBar({ filters, onApply, showDates = true, showTraining = true }: { filters: Filters; onApply: (f: Filters) => void; showDates?: boolean; showTraining?: boolean }) {
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
      {showTraining ? <SelectField label="Training" name="training_id" placeholder="All training" options={toOptions(o?.trainings)} defaultValue={filters.training_id ?? ""} /> : null}
      <SelectField label="Trainer" name="trainer_id" placeholder="All trainers" options={toOptions(o?.trainers)} defaultValue={filters.trainer_id ?? ""} />
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

interface ExportRow {
  id: string;
  report_code: string;
  export_format: string;
  row_count: number;
  file_name: string;
  created_at: string;
}

/** Asks before deleting a generated file from Downloads. Deleting cannot be undone; the report can be exported again. */
function DeleteExportDialog({ row, onClose, onDeleted }: { row: ExportRow; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.del(`/reports/exports/${row.id}`);
      toast("File deleted.");
      onDeleted();
      onClose();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete file" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <p>
          Delete <strong>{row.file_name || `${row.report_code} (${row.export_format})`}</strong>, generated {dateTime(row.created_at)}? This cannot be undone. You can export the report again at any time.
        </p>
        {error ? <ErrorPanel error={error} /> : null}
        <div className="dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button className="btn primary tone-danger" type="submit" disabled={busy}>
            Delete file
          </button>
        </div>
      </form>
    </Modal>
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

/** The report's rows with each employee's name as a link to their Employee Scorecard (by employee ID, keeping
    the report and filters to come back to). `hrefs` maps each row to its link, so a click anywhere on the row
    opens it too; keyboard users reach the name link with Tab. */
function linkedRows(report: ReportData, back: string): { rows: ReactNode[][]; hrefs: WeakMap<ReactNode[], string> } {
  const hrefs = new WeakMap<ReactNode[], string>();
  const ids = report.employee_ids ?? [];
  const column = report.columns.indexOf("Employee");
  if (column < 0 || ids.length !== report.rows.length) return { rows: report.rows, hrefs };
  const rows = report.rows.map((row, index) => {
    const href = scorecardHref(ids[index], back);
    const name = String(row[column]);
    const cells: ReactNode[] = [...row];
    cells[column] = (
      <Link key="employee" href={href} className="employee-scorecard-link" data-sort={name} aria-label={`Open the employee scorecard of ${name}`}>
        {name}
      </Link>
    );
    hrefs.set(cells, href);
    return cells;
  });
  return { rows, hrefs };
}

/** One report: filters, definitions, table and exports. Used by every role, scoped by the backend. Filters are the
    caller's when it passes them (Reports & Analytics keeps them in the URL); otherwise the panel keeps its own. */
export function ReportPanel({ code, canSchedule = true, showFilters = true, filters: given, onFiltersChange }: { code: string; canSchedule?: boolean; showFilters?: boolean; filters?: Filters; onFiltersChange?: (filters: Filters) => void }) {
  const [own, setOwn] = useState<Filters>({});
  const filters = given ?? own;
  const setFilters = onFiltersChange ?? setOwn;
  const path = useMemo(() => `/reports/${code}${toQuery(filters)}`, [code, filters]);
  const state = useApi<ReportData>(path);
  const [scheduling, setScheduling] = useState(false);
  const router = useRouter();
  const back = reportStateQuery(code, filters);
  return (
    <section className="panel">
      {showFilters ? <FilterBar filters={filters} onApply={setFilters} /> : null}
      <Loaded state={state}>
        {(report) => {
          const { rows, hrefs } = linkedRows(report, back);
          return (
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
            <DataTable
              headers={report.columns}
              rows={rows}
              emptyTitle="No rows match these filters."
              onRowClick={(row) => {
                const href = hrefs.get(row);
                if (href) router.push(href);
              }}
            />
            {report.definitions.map((d) => (
              <p className="small" key={d}>
                {d}
              </p>
            ))}
          </>
          );
        }}
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
const REPORT_NAMES: Record<string, string> = Object.fromEntries(CODES);

/** The chosen report and its filters live in the URL, so a refresh, a shared link and Back to report (from an
    Employee Scorecard) all show the same report with the same filters. */
export function ReportsHub() {
  return (
    <Suspense fallback={<Loading />}>
      <ReportsHubInner />
    </Suspense>
  );
}

function ReportsHubInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = params.toString();
  const { code, filters } = useMemo(() => parseReportState(new URLSearchParams(query)), [query]);
  const show = (nextCode: string, nextFilters: Filters) => router.replace(`${pathname}?${reportStateQuery(nextCode, nextFilters)}`, { scroll: false });
  const exportsState = useApi<ExportRow[]>("/reports/exports");
  const [deleting, setDeleting] = useState<ExportRow | null>(null);
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
        {/* Choosing another report starts it without filters, as before. */}
        <SelectField label="Report" value={code} onChange={(e) => show(e.target.value, {})} options={CODES.map(([value, label]) => ({ value, label }))} />
      </section>
      <ReportPanel key={code} code={code} filters={filters} onFiltersChange={(next) => show(code, next)} />
      <section className="panel downloads-card">
        <h2>Downloads</h2>
        <p className="small">Files you generated. Only you can download them, and your current permissions are checked each time.</p>
        <Loaded state={exportsState}>
          {(rows) => (
            <DataTable
              headers={["Report", "Format", "Rows", "Generated", ""]}
              emptyTitle="No exports yet."
              emptyHint="Use CSV, Excel or PDF above."
              rows={rows.map((r) => [
                <div key="n" className="export-name" data-sort={REPORT_NAMES[r.report_code] ?? r.report_code}>
                  <strong>{REPORT_NAMES[r.report_code] ?? r.report_code}</strong>
                  {r.file_name ? <span>{r.file_name}</span> : null}
                </div>,
                r.export_format,
                r.row_count,
                dateTime(r.created_at),
                <div key={r.id} className="export-actions">
                  <Btn kind="text" tone="data" onClick={() => downloadFile(`/reports/exports/${r.id}/download`, r.file_name).catch((e: ApiError) => toast(e.message))}>
                    Download
                  </Btn>
                  <Btn kind="text" tone="danger" onClick={() => setDeleting(r)}>
                    Delete<span className="sr-only"> {r.file_name || r.report_code}</span>
                  </Btn>
                </div>,
              ])}
            />
          )}
        </Loaded>
        {deleting ? <DeleteExportDialog row={deleting} onClose={() => setDeleting(null)} onDeleted={() => void exportsState.reload()} /> : null}
      </section>
      <section className="panel">
        <h2>Scheduled delivery</h2>
        <Loaded state={schedules}>
          {(rows) => (
            <DataTable
              headers={["Report", "Cadence", "Format", "Next run", "Last delivery", ""]}
              emptyTitle="No schedules yet."
              emptyHint="Open a report and choose Schedule."
              rows={rows.map((s) => [
                s.report_code,
                s.cadence === "WEEKLY" ? "Weekly" : "Monthly",
                s.export_format,
                s.is_active ? dateTime(s.next_run_at) : "Stopped",
                s.deliveries[0] ? <span key="delivery" data-sort={s.deliveries[0].run_at}>{s.deliveries[0].status} · {day(s.deliveries[0].run_at)}</span> : "None yet",
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
