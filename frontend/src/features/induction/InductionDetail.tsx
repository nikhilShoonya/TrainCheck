"use client";

/* A selected induction (UI-02): Create Batch, Add Employee and Assign Employees, with Batches, Employees and Records
   tabs. Records has Assessment Records and Feedback Form Records. Every list, count, filter and export is scoped to
   this induction by the server. */

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Badge, Btn, DataTable, Empty, ErrorPanel, Loaded, Loading, PageTitle, SelectField, TextField, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { allShownSelected, filterPeople, toggleOne, toggleShown } from "@/features/admin/assignView";
import { AddEmployeeDialog, DialogForm } from "@/features/admin/pages";
import { Glyph } from "@/features/dashboard/widgets";
import { VIOLATION_LABELS } from "@/features/exam/monitor";
import { ApiError, api, downloadFile, toQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type {
  InductionAnswer,
  InductionAssessmentRecord,
  InductionAssignResult,
  InductionBatchRow,
  InductionCard,
  InductionEligible,
  InductionExportRow,
  InductionFeedbackRecord,
  InductionMember,
  InductionPage,
  InductionRecordDetail,
  OrgUnit,
} from "@/lib/types";
import { dateTime, day, duration } from "@/lib/utils";
import { InductionForm, Tabs } from "./InductionHome";
import {
  asDetailTab,
  asRecordsTab,
  batchesInMonth,
  DEFAULT_FILTERS,
  DETAIL_TABS,
  exportFilters,
  filtersFromParams,
  filtersToParams,
  inductionDetailHref,
  keepBatch,
  monthOptions,
  MONTHS,
  percentShown,
  RECORD_TABS,
  recordQuery,
  RESULT_FILTERS,
  STATUS_FILTERS,
  STATUS_LABEL,
  STATUS_TONE,
  type DetailTab,
  type RecordFilterState,
  type RecordsTab,
} from "./inductionView";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function StatusBadge({ status }: { status: keyof typeof STATUS_LABEL }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

function StateBadge({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`badge ${ok ? "success" : "warning"}`}>{ok ? yes : no}</span>;
}

export function InductionDetail() {
  return (
    <Suspense fallback={<Loading />}>
      <InductionDetailInner />
    </Suspense>
  );
}

function InductionDetailInner() {
  const { inductionId } = useParams<{ inductionId: string }>();
  if (!UUID.test(inductionId ?? "")) return <ErrorPanel error={new ApiError(404, "NOT_FOUND", "This induction does not exist.")} />;
  return <Detail id={inductionId} />;
}

type Dialog = "batch" | "employee" | "assign" | "edit" | null;

function Detail({ id }: { id: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const tab = asDetailTab(params.get("tab"));
  const cards = params.get("cards");
  const induction = useApi<InductionCard>(`/admin/inductions/${id}`);
  const batches = useApi<InductionBatchRow[]>(`/admin/inductions/${id}/batches`);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [assignBatch, setAssignBatch] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<InductionAssignResult | null>(null);
  const go = (next: DetailTab, extra: Record<string, string | null> = {}) => router.replace(inductionDetailHref(id, next, { cards, ...extra }), { scroll: false });
  if (induction.error) return <ErrorPanel error={induction.error} retry={induction.reload} />;
  const i = induction.data;
  if (!i) return <Loading label="Loading induction…" />;
  const archived = i.status !== "ACTIVE";
  const refresh = () => {
    void induction.reload();
    void batches.reload();
  };
  return (
    <>
      <PageTitle
        eyebrow="L&D ADMIN · INDUCTION"
        title={
          <>
            {i.name} {archived ? <Badge status="ARCHIVED" /> : null}
          </>
        }
        description={`Manage batches, employee assignments and records for ${i.name}. For the ${i.department.name} department${i.trainer ? ` · Trainer: ${i.trainer.name}` : ""}.`}
        action={
          <div className="row wrap induction-actions">
            <Btn onClick={() => setDialog("edit")}>Edit details</Btn>
            <Btn disabled={archived} onClick={() => setDialog("batch")}>
              <Icon name="plus" /> Create Batch
            </Btn>
            <Btn disabled={archived || !batches.data?.length} title={!batches.data?.length ? "Create a batch first" : undefined} onClick={() => setDialog("employee")}>
              <Icon name="plus" /> Add Employee
            </Btn>
            <Btn
              kind="primary"
              disabled={archived || !batches.data?.length}
              title={!batches.data?.length ? "Create a batch first" : undefined}
              onClick={() => {
                setAssignBatch(undefined);
                setDialog("assign");
              }}
            >
              <Icon name="plus" /> Assign Employees
            </Btn>
          </div>
        }
      />
      {archived ? <div className="notice left">This induction is archived. Its records stay available; reactivate it in Edit details to add batches, employees or assignments.</div> : null}
      <Tabs tabs={DETAIL_TABS} current={tab} onChange={(next) => go(next)} label={i.name} />
      {tab === "batches" ? (
        <BatchesTab
          batches={batches}
          onView={(batch) => go("employees", { batch })}
          onAssign={(batch) => {
            setAssignBatch(batch);
            setDialog("assign");
          }}
          archived={archived}
        />
      ) : tab === "employees" ? (
        <EmployeesTab id={id} batches={batches.data ?? []} initialBatch={params.get("batch") ?? ""} />
      ) : (
        <RecordsTab induction={i} batches={batches.data ?? []} />
      )}
      {dialog === "batch" ? <CreateBatchDialog induction={i} onClose={() => setDialog(null)} onSaved={refresh} /> : null}
      {dialog === "edit" ? <InductionForm induction={i} onClose={() => setDialog(null)} onSaved={refresh} /> : null}
      {dialog === "employee" && batches.data ? (
        <AddEmployeeDialog
          onClose={() => setDialog(null)}
          batchContext={{ inductionId: i.id, inductionName: i.name, department: i.department, batches: batches.data.map((b) => ({ id: b.id, label: b.label })), defaultBatchId: params.get("batch") ?? undefined, onAdded: refresh }}
        />
      ) : null}
      {dialog === "assign" && batches.data ? (
        <AssignDialog
          induction={i}
          batches={batches.data}
          initialBatch={assignBatch ?? params.get("batch") ?? batches.data[0]?.id ?? ""}
          onClose={() => setDialog(null)}
          onSaved={(result) => {
            setDialog(null);
            setOutcome(result);
            refresh();
          }}
        />
      ) : null}
      {outcome ? <AssignOutcome result={outcome} onClose={() => setOutcome(null)} /> : null}
    </>
  );
}

/* ---------- Batches ---------- */

function BatchesTab({ batches, onView, onAssign, archived }: { batches: ReturnType<typeof useApi<InductionBatchRow[]>>; onView: (batchId: string) => void; onAssign: (batchId: string) => void; archived: boolean }) {
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState("");
  return (
    <Loaded state={batches}>
      {(all) => {
        // Create Batch stays in the page heading only, so the empty list does not repeat it.
        if (!all.length) return <Empty title="No batches yet." hint="Use Create Batch above to add one for a month, for example November 2026 · Batch 1. Each month can have several batches." />;
        const term = search.trim().toLowerCase();
        const shown = batchesInMonth(all, month).filter((b) => !term || b.label.toLowerCase().includes(term));
        return (
          <>
            <form className="filters" role="search" aria-label="Batches" onSubmit={(e) => e.preventDefault()}>
              <TextField label="Search batches" type="search" placeholder="Batch name" value={search} onChange={(e) => setSearch(e.target.value)} />
              <SelectField label="Month" value={month} onChange={(e) => setMonth(e.target.value)} placeholder="All months" options={monthOptions(all)} />
            </form>
            <p className="small" role="status" aria-live="polite">
              {shown.length} batch{shown.length === 1 ? "" : "es"}.
            </p>
            {shown.length ? (
              <section className="course-grid personal-courses completion-cards" aria-label="Batches">
                {shown.map((b, n) => (
                  <article className="panel course-card completion-card training-card" key={b.id} aria-labelledby={`batch-${b.id}`}>
                    <div className="training-card-head">
                      <Glyph index={n} icon="cap" />
                      <div className="training-card-title">
                        <h2 id={`batch-${b.id}`}>{b.label}</h2>
                        <p>
                          <Icon name="calendar" /> {b.start_date ? day(b.start_date) : `${MONTHS[b.month - 1]} ${b.year}`}
                        </p>
                      </div>
                    </div>
                    <h3 className="completion-counts-title">Induction completion</h3>
                    <dl className="completion-counts">
                      <div>
                        <dt>Assigned</dt>
                        <dd>{b.assigned}</dd>
                      </div>
                      <div className="recorded">
                        <dt>Assessment submitted</dt>
                        <dd>{b.assessment_submitted}</dd>
                      </div>
                      <div>
                        <dt>Feedback submitted</dt>
                        <dd>{b.feedback_submitted}</dd>
                      </div>
                    </dl>
                    <div className="training-card-progress">
                      <span>
                        {b.completed} of {b.assigned} completed
                      </span>
                      <progress max={Math.max(1, b.assigned)} value={b.completed} aria-label={`${b.completed} of ${b.assigned} employees completed`} />
                    </div>
                    <small className="completion-note">
                      {b.members} member{b.members === 1 ? "" : "s"}{b.members > b.assigned ? ` · ${b.members - b.assigned} not assigned yet` : ""}. Assessment and feedback are recorded once per employee.
                    </small>
                    <div className="row wrap training-card-foot">
                      <Btn kind="primary" onClick={() => onView(b.id)}>
                        View Employees<span className="sr-only"> in {b.label}</span> <Icon name="arrow" />
                      </Btn>
                      {archived ? null : <Btn onClick={() => onAssign(b.id)}>Assign</Btn>}
                    </div>
                  </article>
                ))}
              </section>
            ) : (
              <Empty title="No batch matches these filters." hint="Clear the search or choose another month." />
            )}
          </>
        );
      }}
    </Loaded>
  );
}

function CreateBatchDialog({ induction, onClose, onSaved }: { induction: InductionCard; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const now = new Date();
  return (
    <DialogForm
      title={`Create batch · ${induction.name}`}
      submitLabel="Create batch"
      onClose={onClose}
      onSubmit={async (form) => {
        const saved = await api.post<{ label: string }>(`/admin/inductions/${induction.id}/batches`, {
          year: Number(form.get("year")),
          month: Number(form.get("month")),
          batch_number: Number(form.get("batch_number")),
          name: form.get("name") || null,
          start_date: form.get("start_date") || null,
        });
        toast(`${saved.label} created.`);
        onSaved();
      }}
    >
      <div className="form-grid">
        <SelectField label="Month *" name="month" required defaultValue={String(now.getMonth() + 1)} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
        <TextField label="Year *" name="year" type="number" min={2000} max={2100} required defaultValue={now.getFullYear()} />
        <TextField label="Batch number *" name="batch_number" type="number" min={1} max={999} required defaultValue={1} />
        <TextField label="Start date" name="start_date" type="date" min="2000-01-01" max="2100-12-31" />
      </div>
      <TextField label="Batch name (optional)" name="name" maxLength={120} placeholder="Shown after the batch number" />
      <p className="small">Shown as “{MONTHS[now.getMonth()]} {now.getFullYear()} · Batch 1”. Each month can have several batches; a batch number is used once per month in this induction.</p>
    </DialogForm>
  );
}

/* ---------- Assign Employees ---------- */

function AssignDialog({ induction, batches, initialBatch, onClose, onSaved }: { induction: InductionCard; batches: InductionBatchRow[]; initialBatch: string; onClose: () => void; onSaved: (result: InductionAssignResult) => void }) {
  const [batchId, setBatchId] = useState(initialBatch);
  const people = useApi<InductionEligible[]>(batchId ? `/admin/inductions/${induction.id}/batches/${batchId}/eligible` : null);
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [wholeBatch, setWholeBatch] = useState(false);
  const all = useMemo(() => (people.data ?? []).map((p) => ({ ...p, id: p.employee_id, function: null })), [people.data]);
  const eligible = all.filter((p) => p.eligible);
  const shown = filterPeople(eligible, filter);
  const picked = eligible.filter((p) => chosen.has(p.id));
  const members = eligible.filter((p) => p.in_batch);
  const blocked = all.filter((p) => !p.eligible);
  const everyoneShown = allShownSelected(chosen, shown);
  return (
    <DialogForm
      title="Assign employees"
      submitLabel={wholeBatch ? `Assign batch members (${members.length})` : "Assign selected employees"}
      wide
      onClose={onClose}
      submitBlockedReason={!batchId ? "Choose a batch." : people.loading && !people.data ? "Loading employees…" : wholeBatch ? (members.length ? null : "This batch has no unassigned members.") : picked.length ? null : "Select at least one employee."}
      onSubmit={async () => {
        const result = await api.post<InductionAssignResult>(`/admin/inductions/${induction.id}/assignments`, { batch_id: batchId, employee_ids: wholeBatch ? [] : picked.map((p) => p.id), whole_batch: wholeBatch });
        onSaved(result);
      }}
    >
      <TextField label="Induction" value={induction.name} readOnly disabled />
      <SelectField
        label="Batch *"
        value={batchId}
        onChange={(e) => {
          setBatchId(e.target.value);
          setChosen(new Set());
        }}
        options={batches.map((b) => ({ value: b.id, label: b.label }))}
      />
      <p className="small">
        Audience: {induction.department.name} department only. Each employee takes the induction assessment once across every induction; employees already assigned anywhere are shown below and cannot be assigned again.
      </p>
      <label className="checkline">
        <input type="checkbox" checked={wholeBatch} onChange={(e) => setWholeBatch(e.target.checked)} /> Assign all current unassigned members of this batch ({members.length})
      </label>
      {wholeBatch ? (
        <p className="small">Employees who join the batch later are not assigned by this: assign them when they join.</p>
      ) : (
        <fieldset>
          <legend>Select employees</legend>
          <TextField label="Find by name, ID or department" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="row wrap between">
            <Btn kind="text" disabled={!shown.length} onClick={() => setChosen((c) => toggleShown(c, shown))}>
              {everyoneShown ? "Clear" : "Select all"} {filter.trim() ? `${shown.length} matching` : `${shown.length}`}
            </Btn>
            <span className="small" role="status">
              {picked.length} selected
            </span>
          </div>
          {people.error ? <ErrorPanel error={people.error} retry={people.reload} /> : null}
          <div className="checkbox-list">
            {shown.map((p) => (
              <label key={p.id}>
                <input type="checkbox" checked={chosen.has(p.id)} onChange={() => setChosen((c) => toggleOne(c, p.id))} /> {p.full_name} · {p.employee_code}
                <small> · {p.department ?? "No department"}{p.in_batch ? " · in this batch" : " · joins this batch"}</small>
              </label>
            ))}
          </div>
          {people.data && !shown.length ? <p className="small">{eligible.length ? "No eligible employee matches." : `No eligible ${induction.department.name} employee is left to assign.`}</p> : null}
        </fieldset>
      )}
      {blocked.length ? (
        <details>
          <summary>Not eligible ({blocked.length})</summary>
          <ul className="small">
            {blocked.map((p) => (
              <li key={p.id}>
                <strong>{p.full_name}</strong> · {p.employee_code}: {p.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="small">Assigning does not repeat anyone: existing induction records are kept, and completed employees cannot receive another assessment.</p>
    </DialogForm>
  );
}

function AssignOutcome({ result, onClose }: { result: InductionAssignResult; onClose: () => void }) {
  return (
    <Modal title={`Assignment result · ${result.batch.label}`} onClose={onClose} wide>
      <div className="notice" role="status">
        <strong>
          {result.assigned.length} employee{result.assigned.length === 1 ? "" : "s"} assigned.
        </strong>{" "}
        {result.skipped.length ? `${result.skipped.length} skipped, with the reason below.` : "Nobody was skipped."} They are asked to take the induction assessment at their next sign-in.
      </div>
      <DataTable
        all
        headers={["Employee", "Outcome"]}
        rows={[
          ...result.assigned.map((a) => [`${a.full_name} · ${a.employee_code}`, <span key="a" className="badge success">Assigned</span>]),
          ...result.skipped.map((s) => [`${s.full_name ?? "Unknown"} · ${s.employee_code ?? s.employee_id}`, s.reason]),
        ]}
      />
      <div className="dialog-actions">
        <Btn kind="primary" onClick={onClose}>
          Done
        </Btn>
      </div>
    </Modal>
  );
}

/* ---------- Employees ---------- */

function EmployeesTab({ id, batches, initialBatch }: { id: string; batches: InductionBatchRow[]; initialBatch: string }) {
  const members = useApi<InductionMember[]>(`/admin/inductions/${id}/members`);
  const [search, setSearch] = useState("");
  const [batch, setBatch] = useState(initialBatch);
  const [status, setStatus] = useState("");
  return (
    <>
      <form className="filters" role="search" aria-label="Employees" onSubmit={(e) => e.preventDefault()}>
        <TextField label="Search" type="search" placeholder="Employee name or ID" value={search} onChange={(e) => setSearch(e.target.value)} />
        <SelectField label="Batch" value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="All batches" options={batches.map((b) => ({ value: b.id, label: b.label }))} />
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" options={[{ value: "NOT_ASSIGNED", label: "Not assigned" }, ...STATUS_FILTERS]} />
      </form>
      <Loaded state={members}>
        {(all) => {
          const term = search.trim().toLowerCase();
          const shown = all.filter((m) => (!batch || m.batch.id === batch) && (!status || m.status === status) && (!term || `${m.full_name} ${m.employee_code}`.toLowerCase().includes(term)));
          return (
            <>
              <p className="small" role="status" aria-live="polite">
                {shown.length} of {all.length} employee{all.length === 1 ? "" : "s"}. Members join a batch when they are added or assigned; assigning gives them the induction assessment.
              </p>
              <DataTable
                emptyTitle={all.length ? "No employee matches these filters." : "No employees in this induction yet."}
                emptyHint={all.length ? "Clear a filter to see more." : "Use Add Employee for new joiners, or Assign Employees to choose existing employees."}
                headers={["Employee", "Department", "Batch", "Status", "Result", "Added on"]}
                rows={shown.map((m) => [
                  <div key="e" data-sort={m.full_name}>
                    <strong>{m.full_name}</strong>
                    <br />
                    <small>{m.employee_code}</small>
                  </div>,
                  m.department ?? "—",
                  m.batch.label,
                  m.elsewhere ? (
                    <span key="s" className="small">
                      Assigned under {m.elsewhere.induction_name} · {m.elsewhere.batch_label}
                    </span>
                  ) : (
                    <StatusBadge key="s" status={m.status} />
                  ),
                  m.result_status ? <Badge key="r" status={m.result_status} /> : "—",
                  day(m.added_at),
                ])}
              />
            </>
          );
        }}
      </Loaded>
    </>
  );
}

/* ---------- Records ---------- */

function RecordsTab({ induction, batches }: { induction: InductionCard; batches: InductionBatchRow[] }) {
  const params = useSearchParams();
  const router = useRouter();
  const kind = asRecordsTab(params.get("records"));
  const [filters, setFiltersState] = useState<RecordFilterState>(() => filtersFromParams(params));
  const departments = useApi<OrgUnit[]>("/admin/departments");
  // Kept in the address, so a reload or Back returns to the same filtered page.
  const setFilters = (next: RecordFilterState) => {
    setFiltersState(next);
    window.history.replaceState(window.history.state, "", inductionDetailHref(induction.id, "records", { cards: params.get("cards"), records: kind === "feedback" ? "feedback" : null, ...filtersToParams(next) }));
  };
  const change = (patch: Partial<RecordFilterState>) => setFilters({ ...filters, ...patch, page: patch.page ?? 1 });
  const switchKind = (next: RecordsTab) => {
    const reset = { ...filters, status: "", result: "", sort: "", direction: "asc" as const, page: 1 };
    setFiltersState(reset);
    router.replace(inductionDetailHref(induction.id, "records", { cards: params.get("cards"), records: next === "feedback" ? "feedback" : null, ...filtersToParams(reset) }), { scroll: false });
  };
  const monthBatches = batchesInMonth(batches, filters.month);
  return (
    <section className="panel induction-records" aria-label="Records">
      <Tabs tabs={RECORD_TABS} current={kind} onChange={switchKind} label="Records" small />
      <form className="filters" role="search" aria-label={kind === "feedback" ? "Feedback form records" : "Assessment records"} onSubmit={(e) => e.preventDefault()}>
        <SelectField label="Month / Year" value={filters.month} onChange={(e) => change({ month: e.target.value, batch: keepBatch(filters.batch, batches, e.target.value) })} placeholder="All months" options={monthOptions(batches)} />
        <SelectField label="Batch" value={filters.batch} onChange={(e) => change({ batch: e.target.value })} placeholder="All batches" options={monthBatches.map((b) => ({ value: b.id, label: b.label }))} />
        <SelectField label="Department" value={filters.department} onChange={(e) => change({ department: e.target.value })} placeholder="All departments" options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
        {kind === "assessment" ? (
          <>
            <SelectField label="Induction status" value={filters.status} onChange={(e) => change({ status: e.target.value })} placeholder="All statuses" options={STATUS_FILTERS} />
            <SelectField label="Result" value={filters.result} onChange={(e) => change({ result: e.target.value })} placeholder="All results" options={RESULT_FILTERS} />
          </>
        ) : null}
        <TextField label="Search employee" type="search" placeholder="Search name or employee ID" value={filters.q} onChange={(e) => change({ q: e.target.value })} />
        <div className="row wrap induction-filter-actions">
          <Btn onClick={() => setFilters({ ...DEFAULT_FILTERS, size: filters.size })}>Clear</Btn>
        </div>
      </form>
      {kind === "assessment" ? <AssessmentRecords induction={induction} filters={filters} change={change} /> : <FeedbackRecords induction={induction} filters={filters} change={change} />}
      <Downloads induction={induction} />
    </section>
  );
}

function ExportButtons({ induction, kind, filters }: { induction: InductionCard; kind: RecordsTab; filters: RecordFilterState }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (format: "CSV" | "XLSX" | "PDF") => {
    setBusy(format);
    try {
      const made = await api.post<InductionExportRow>(`/admin/inductions/${induction.id}/exports`, { record_kind: kind === "feedback" ? "FEEDBACK" : "ASSESSMENT", export_format: format, filters: exportFilters(filters, kind) });
      await downloadFile(`/admin/inductions/${induction.id}/exports/${made.id}/download`, made.file_name ?? `induction-records.${format.toLowerCase()}`);
      toast(`${made.row_count} record${made.row_count === 1 ? "" : "s"} exported. The file is also in Downloads below.`);
    } catch (e) {
      toast((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="row wrap induction-exports" aria-label="Export every matching record">
      {(
        [
          ["CSV", "CSV", "file"],
          ["XLSX", "Excel", "grid"],
          ["PDF", "PDF", "file"],
        ] as const
      ).map(([format, label, icon]) => (
        <Btn key={format} tone="data" disabled={busy !== null} onClick={() => void run(format)}>
          <Icon name={icon} /> {busy === format ? "Exporting…" : label}
        </Btn>
      ))}
    </div>
  );
}

interface Column {
  label: string;
  sort?: string;
}

/** A server-paged table in the existing table style: sorting and paging ask the server, which applies the induction
    scope and every filter. */
function PagedTable({ columns, rows, filters, change, total, noun, loading }: { columns: Column[]; rows: ReactNode[][]; filters: RecordFilterState; change: (patch: Partial<RecordFilterState>) => void; total: number; noun: string; loading: boolean }) {
  const pages = Math.max(1, Math.ceil(total / filters.size));
  const first = total ? (filters.page - 1) * filters.size + 1 : 0;
  return (
    <>
      <div className="table-wrap stack-on-phone" aria-busy={loading}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label} scope="col" aria-sort={c.sort && filters.sort === c.sort ? (filters.direction === "desc" ? "descending" : "ascending") : undefined}>
                  {c.sort ? (
                    <button type="button" className="table-sort" aria-label={`Sort by ${c.label}`} onClick={() => change({ sort: c.sort, direction: filters.sort === c.sort && filters.direction === "asc" ? "desc" : "asc" })}>
                      {c.label}
                      <Icon name="sort" />
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i} data-label={columns[i].label}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-pagination">
        <span>
          Showing {first}–{Math.min(filters.page * filters.size, total)} of {total} {noun}
        </span>
        <div>
          <SelectField label={<span className="sr-only">Rows per page</span>} value={String(filters.size)} onChange={(e) => change({ size: Number(e.target.value) })} options={[10, 20, 50, 100].map((n) => ({ value: String(n), label: `${n} per page` }))} />
          <Btn disabled={filters.page <= 1} onClick={() => change({ page: filters.page - 1 })}>
            <Icon name="back" /> Previous
          </Btn>
          <span>
            Page {Math.min(filters.page, pages)} of {pages}
          </span>
          <Btn disabled={filters.page >= pages} onClick={() => change({ page: filters.page + 1 })}>
            Next <Icon name="chevron" />
          </Btn>
        </div>
      </div>
    </>
  );
}

function AssessmentRecords({ induction, filters, change }: { induction: InductionCard; filters: RecordFilterState; change: (patch: Partial<RecordFilterState>) => void }) {
  const state = useApi<InductionPage<InductionAssessmentRecord>>(`/admin/inductions/${induction.id}/records/assessment${toQuery(recordQuery(filters, "assessment"))}`);
  const [open, setOpen] = useState<string | null>(null);
  const page = state.data;
  useBeyondLastPage(page, filters, change);
  return (
    <>
      <div className="row wrap between induction-records-head">
        <div>
          <h2>Assessment Records</h2>
          <p className="small">Only {induction.name}. Score and pass/fail are separate from induction completion.</p>
        </div>
        <ExportButtons induction={induction} kind="assessment" filters={filters} />
      </div>
      {state.error ? (
        <ErrorPanel error={state.error} retry={state.reload} />
      ) : !page ? (
        <Loading label="Loading records…" />
      ) : !page.total ? (
        <Empty title="No assessment records match." hint="Records appear here once employees are assigned in this induction. Clear a filter to see more." />
      ) : (
        <PagedTable
          noun="employees"
          loading={state.loading}
          filters={filters}
          change={change}
          total={page.total}
          columns={[
            { label: "Employee", sort: "employee" },
            { label: "Batch", sort: "batch" },
            { label: "Assigned on", sort: "assigned_on" },
            { label: "Assessment", sort: "assessment" },
            { label: "Score", sort: "score" },
            { label: "Result" },
            { label: "Feedback", sort: "feedback" },
            { label: "Induction status", sort: "status" },
            { label: "Action" },
          ]}
          rows={page.rows.map((r) => [
            <div key="e">
              <strong>{r.employee.full_name}</strong>
              <br />
              <small>{r.employee.employee_code}{r.department ? ` · ${r.department}` : ""}</small>
            </div>,
            r.batch.label,
            day(r.assigned_at),
            <StateBadge key="a" ok={Boolean(r.submitted_at)} yes={r.assessment_status === "TIMED_OUT" ? "Submitted (time up)" : "Submitted"} no={r.assessment_status === "IN_PROGRESS" ? "In progress" : "Pending"} />,
            <strong key="s">{percentShown(r.score_percent)}</strong>,
            r.result_status ? <Badge key="r" status={r.result_status} /> : "—",
            <StateBadge key="f" ok={r.feedback_status === "SUBMITTED"} yes="Submitted" no="Pending" />,
            <StatusBadge key="t" status={r.status} />,
            <Btn key="v" onClick={() => setOpen(r.assignment_id)}>
              View record<span className="sr-only"> for {r.employee.full_name}</span>
            </Btn>,
          ])}
        />
      )}
      {open ? <RecordDialog induction={induction} assignmentId={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function FeedbackRecords({ induction, filters, change }: { induction: InductionCard; filters: RecordFilterState; change: (patch: Partial<RecordFilterState>) => void }) {
  const state = useApi<InductionPage<InductionFeedbackRecord>>(`/admin/inductions/${induction.id}/records/feedback${toQuery(recordQuery(filters, "feedback"))}`);
  const [open, setOpen] = useState<InductionFeedbackRecord | null>(null);
  const page = state.data;
  useBeyondLastPage(page, filters, change);
  return (
    <>
      <div className="row wrap between induction-records-head">
        <div>
          <h2>Feedback Form Records</h2>
          <p className="small">Every induction feedback form submitted in {induction.name}, with its full answers and the form version it was given on.</p>
        </div>
        <ExportButtons induction={induction} kind="feedback" filters={filters} />
      </div>
      {state.error ? (
        <ErrorPanel error={state.error} retry={state.reload} />
      ) : !page ? (
        <Loading label="Loading records…" />
      ) : !page.total ? (
        <Empty title="No feedback records match." hint="Feedback appears here after employees in this induction submit the induction feedback form." />
      ) : (
        <PagedTable
          noun="submissions"
          loading={state.loading}
          filters={filters}
          change={change}
          total={page.total}
          columns={[{ label: "Employee", sort: "employee" }, { label: "Batch", sort: "batch" }, { label: "Submitted on", sort: "submitted_on" }, { label: "Form version", sort: "version" }, { label: "Average rating" }, { label: "Comment" }, { label: "Action" }]}
          rows={page.rows.map((r) => [
            <div key="e">
              <strong>{r.employee.full_name}</strong>
              <br />
              <small>{r.employee.employee_code}{r.department ? ` · ${r.department}` : ""}</small>
            </div>,
            r.batch.label,
            dateTime(r.submitted_at),
            `Version ${r.form_version}`,
            r.average_rating === null ? "—" : `${r.average_rating} / 5`,
            r.has_comment ? "Yes" : "—",
            <Btn key="v" onClick={() => setOpen(r)}>
              View answers<span className="sr-only"> of {r.employee.full_name}</span>
            </Btn>,
          ])}
        />
      )}
      {open ? (
        <Modal title={`Feedback · ${open.employee.full_name}`} onClose={() => setOpen(null)} wide>
          <p className="small">
            {open.employee.employee_code} · {open.batch.label} · Submitted {dateTime(open.submitted_at)} · Form version {open.form_version}
          </p>
          <Answers answers={open.answers} comment={open.comment} commentLabel={open.comment_label} />
          <div className="dialog-actions">
            <Btn kind="primary" onClick={() => setOpen(null)}>
              Close
            </Btn>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/** A filter or deletion that leaves fewer pages than the one shown goes back to the last page that exists. */
function useBeyondLastPage(page: InductionPage<unknown> | null, filters: RecordFilterState, change: (patch: Partial<RecordFilterState>) => void) {
  const last = page ? Math.max(1, Math.ceil(page.total / filters.size)) : null;
  useEffect(() => {
    if (last !== null && filters.page > last) change({ page: last });
  }, [last, filters.page, change]);
}

function Answers({ answers, comment, commentLabel }: { answers: InductionAnswer[]; comment: string | null; commentLabel: string | null }) {
  return (
    <>
      <DataTable all headers={["Section", "Question", "Answer"]} rows={answers.map((a) => [a.section, a.question, <strong key="a">{a.answer}</strong>])} />
      <p>
        <strong>{commentLabel || "Comments"}:</strong> {comment || "No comment."}
      </p>
    </>
  );
}

function RecordDialog({ induction, assignmentId, onClose }: { induction: InductionCard; assignmentId: string; onClose: () => void }) {
  const state = useApi<InductionRecordDetail>(`/admin/inductions/${induction.id}/records/assignments/${assignmentId}`);
  return (
    <Modal title="Induction record" onClose={onClose} wide>
      <Loaded state={state}>
        {(r) => {
          const a = r.assessment;
          const facts: [string, ReactNode][] = [
            ["Employee", `${r.employee.full_name} · ${r.employee.employee_code}`],
            ["Department", r.employee.department ?? "—"],
            ["Batch", r.batch.label],
            ["Assigned on", dateTime(r.assigned_at)],
            ["Induction status", <StatusBadge key="s" status={r.status} />],
            ["Completed on", r.completed_at ? dateTime(r.completed_at) : "—"],
          ];
          return (
            <>
              <dl className="result-facts">
                {facts.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <h3>Assessment</h3>
              {!a ? (
                <p className="small">Not started yet.</p>
              ) : !a.submitted_at ? (
                <p className="small">In progress since {dateTime(a.started_at)}{a.expires_at ? `; time runs out at ${dateTime(a.expires_at)}` : ""}.</p>
              ) : (
                <>
                  <dl className="result-facts">
                    {(
                      [
                        ["Score", `${a.obtained_marks} / ${a.total_marks} marks (${a.score_percent}%)`],
                        ["Result", a.result_status ? <Badge key="r" status={a.result_status} /> : "—"],
                        ["Pass mark", `${a.pass_mark_percent}% (rules version ${a.settings_version ?? "—"})`],
                        ["Submitted", `${dateTime(a.submitted_at)} · ${a.submission_reason === "TIME_EXPIRED" ? "time expired" : a.submission_reason === "VIOLATION_LIMIT" ? "violation limit" : "by the employee"}`],
                        ["Time taken", a.time_taken_seconds !== null && a.time_taken_seconds !== undefined ? duration(a.time_taken_seconds) : "—"],
                        ["Answered", `${a.answered_count} of ${a.question_count} · ${a.correct_count} correct`],
                      ] as [string, ReactNode][]
                    ).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {a.topics?.length ? (
                    <DataTable all headers={["Topic", "Score"]} rows={a.topics.map((t) => [t.name, t.score === null ? "—" : `${t.score}%`])} />
                  ) : null}
                  {a.violations?.length ? (
                    <p className="small">Security violations: {a.violations.map((v) => VIOLATION_LABELS[v.type as keyof typeof VIOLATION_LABELS] ?? v.type).join(", ")}.</p>
                  ) : null}
                  <p className="small">Answer review is not enabled for the induction assessment, so individual answers are not shown.</p>
                </>
              )}
              <h3>Feedback</h3>
              {r.feedback ? (
                <>
                  <p className="small">
                    Submitted {dateTime(r.feedback.submitted_at)} · Form version {r.feedback.form_version}
                  </p>
                  <Answers answers={r.feedback.answers} comment={r.feedback.comment} commentLabel={r.feedback.comment_label} />
                </>
              ) : (
                <p className="small">{a?.submitted_at ? "Feedback pending: the employee is asked for it before opening their workspace." : "Asked after the assessment is submitted."}</p>
              )}
            </>
          );
        }}
      </Loaded>
      <div className="dialog-actions">
        <Btn kind="primary" onClick={onClose}>
          Close
        </Btn>
      </div>
    </Modal>
  );
}

function Downloads({ induction }: { induction: InductionCard }) {
  const state = useApi<InductionExportRow[]>(`/admin/inductions/${induction.id}/exports`);
  const toast = useToast();
  return (
    <section className="induction-downloads" aria-labelledby="induction-downloads">
      <h2 id="induction-downloads">Downloads</h2>
      <p className="small">Files you generated for {induction.name}. Only you can download them, and your current permissions are checked each time.</p>
      <Loaded state={state}>
        {(rows) =>
          rows.length ? (
            <DataTable
              headers={["File", "Records", "Rows", "Created", "Actions"]}
              rows={rows.map((r) => [
                r.file_name ?? "—",
                r.record_kind === "FEEDBACK" ? "Feedback Form Records" : "Assessment Records",
                r.row_count,
                dateTime(r.created_at),
                <div className="row wrap" key="a">
                  <Btn kind="text" tone="data" onClick={() => downloadFile(`/admin/inductions/${induction.id}/exports/${r.id}/download`, r.file_name ?? "induction-records").catch((e: ApiError) => toast(e.message))}>
                    Download
                  </Btn>
                  <Btn
                    kind="text"
                    tone="danger"
                    onClick={() =>
                      api
                        .del(`/admin/inductions/${induction.id}/exports/${r.id}`)
                        .then(() => toast("Removed from Downloads. The records are unchanged."))
                        .catch((e: ApiError) => toast(e.message))
                    }
                  >
                    Delete
                  </Btn>
                </div>,
              ])}
            />
          ) : (
            <Empty title="No exports yet." hint="Use CSV, Excel or PDF above. Exports include every matching record, not only this page." />
          )
        }
      </Loaded>
    </section>
  );
}
