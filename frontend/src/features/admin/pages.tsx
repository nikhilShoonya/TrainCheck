"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Badge, Btn, BtnLink, DataTable, Empty, ErrorPanel, Field, fieldErrors, FormError, Loaded, Loading, Metrics, PageTitle, SelectField, TextField, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { MonthlyTrend } from "@/features/dashboard/charts";
import { ActionItem, DepartmentBars, EvidenceHelp, EvidenceTiles, Glyph, GoodMorning, ImageMetrics, Panel, ScorecardCta, ScoreTag, ViewAll, Welcome } from "@/features/dashboard/widgets";
import { ReportsHub } from "@/features/reports/ReportView";
import { ScorecardPage } from "@/features/reports/ScorecardView";
import { ApiError, api, downloadFile, toQuery } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import { checkPlan, defaultQuestionsPerAttempt, describePool, DIFFICULTIES, DIFFICULTY_LABEL, exclusionNotes, shortfallSentence, type Difficulty, type PlanCheck, type PoolReport } from "@/lib/pool";
import type { ConfigView, Named, OrgUnit, Summary, TrainingAdmin, TrendPoint } from "@/lib/types";
import { dateTime, day, firstName, percent } from "@/lib/utils";
import Link from "next/link";

const EYEBROW = "L&D ADMIN";
const SCOPE_LABEL: Record<string, string> = { COMMON: "Common (all departments)", DEPARTMENT: "Department-specific", FUNCTION: "Function-specific", COMBINED: "Department and function" };
const TYPE_LABEL: Record<string, string> = { MCQ_SINGLE: "Single choice", MCQ_MULTIPLE: "Multiple choice", TRUE_FALSE: "True / False", SCENARIO: "Scenario" };
const SCHEDULE_LABEL: Record<string, string> = { SAME_DAY: "Same day", NEXT_WORKING_DAY: "Next working day", DELAY_DAYS: "After a delay", FIXED_DATE: "On a specific date" };
/** Today's date in the browser, as the YYYY-MM-DD a date input uses. */
const todayInput = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

const names = (items?: Named[]) => (items ?? []).map((x) => ({ value: x.id, label: x.name }));

/** A dialog form that keeps what was typed when the server rejects it. */
function DialogForm({ title, onClose, onSubmit, submitLabel, children, wide, submitBlockedReason }: { title: string; onClose: () => void; onSubmit: (form: FormData) => Promise<void>; submitLabel: string; children: ReactNode; wide?: boolean; submitBlockedReason?: string | null }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(new FormData(event.currentTarget));
      onClose();
    } catch (e) {
      setError(fieldErrors(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form onSubmit={(e) => void submit(e)}>
        {children}
        <FormError message={error} />
        {submitBlockedReason ? (
          <p className="small" id="submit-blocked-reason">
            {submitBlockedReason}
          </p>
        ) : null}
        <div className="dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button className="btn primary" type="submit" disabled={busy || Boolean(submitBlockedReason)} aria-describedby={submitBlockedReason ? "submit-blocked-reason" : undefined}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ title, body, confirmLabel, danger, onClose, onConfirm, needsReason }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void>; needsReason?: boolean }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onConfirm(String(new FormData(event.currentTarget).get("reason") ?? ""));
      onClose();
    } catch (e) {
      setError(fieldErrors(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        {body}
        {needsReason ? (
          <Field label="Reason *">
            <textarea name="reason" required minLength={5} maxLength={1000} />
          </Field>
        ) : null}
        <FormError message={error} />
        <div className="dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button className={`btn primary${danger ? " tone-danger" : ""}`} type="submit" disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- Dashboard ---------- */

interface AdminDashboardData {
  total_employees: number;
  training_programmes: number;
  summary: Summary;
  departments: ({ department: string } & Summary)[];
  trend: TrendPoint[];
  recent_trainings: { id: string; title: string; status: string; enrolled: number; pass_rate: number | null }[];
  completions_awaiting: number;
  import_rows_need_review: number;
  programmes_need_setup: number;
}

export function AdminDashboard() {
  const { user } = useSession();
  const state = useApi<AdminDashboardData>("/admin/dashboard");
  const behaviour = useApi<{ behaviour_trend: { self_mean: number | null; manager_mean: number | null; self_count: number; manager_count: number }[] }>("/reports/analytics");
  const latest = behaviour.data?.behaviour_trend.at(-1);
  return (
    <Loaded state={state}>
      {(d) => (
        <div className="reference-dashboard image-role-dashboard admin-image-dashboard">
          <Welcome heading={<GoodMorning name={firstName(user?.full_name ?? "")} />} description="Manage trainings, assessments, question bank and behaviour follow-ups." />
          <ImageMetrics
            cards={[
              ["users", "Total Employees", d.total_employees, "purple", "Active employee records"],
              ["cap", "Training Programmes", d.training_programmes, "blue", "Draft and active programmes"],
              ["check", "Training Completion", percent(d.summary.completion_rate), "green", "Completed / assigned records"],
              ["target", "Assessment Pass Rate", percent(d.summary.pass_rate), "red", "Passed / assessed outcomes"],
              ["question", "Red-Flag Employees", d.summary.not_passed_employees, "amber", "At least one Not Passed outcome"],
            ]}
          />
          <div className="image-primary-grid admin-primary">
            <Panel title={<>Learning & Behaviour <span className="heading-note">(Evidence)</span></>} action={<EvidenceHelp />}>
              <EvidenceTiles learning={d.summary.mean_latest_score} assessed={d.summary.assessed} behaviour={latest ?? null} />
            </Panel>
            <Panel title="Training Completion by Department">
              <DepartmentBars departments={d.departments} />
            </Panel>
            <Panel title="Training Trend">
              <MonthlyTrend points={d.trend} dual />
            </Panel>
          </div>
          <div className="admin-secondary-grid">
            <Panel title="Recent Trainings" action={<ViewAll href="/lnd/trainings" />}>
              {d.recent_trainings.map((t, i) => (
                <Link className="recent-training" href="/lnd/trainings" key={t.id}>
                  <Glyph index={i} />
                  <span className="recent-training-copy">
                    <strong>{t.title}</strong>
                    <small>
                      <i className={`dot ${t.status === "ACTIVE" ? "green" : "grey"}`} />
                      {t.status === "ACTIVE" ? "Active" : "Draft"} · {t.enrolled} enrolled
                    </small>
                  </span>
                  <ScoreTag value={t.pass_rate} />
                </Link>
              ))}
            </Panel>
            <Panel title="Pending Admin Actions" action={<ViewAll href="/lnd/completion" />}>
              <ActionItem icon="calendar" heading={`${d.completions_awaiting} Completions Awaiting Recording`} description="Update attendance after training is complete." href="/lnd/completion" label="Update" />
              <ActionItem icon="file" heading={`${d.import_rows_need_review} Import Rows Need Review`} description="Rejected rows in imports not yet finished." href="/lnd/imports" label="Review" />
              <ActionItem icon="settings" heading={`${d.programmes_need_setup} Programmes Need Configuration`} description="Draft programmes or insufficient question pools." href="/lnd/assessment-config" label="Configure" />
            </Panel>
            <Panel title="Quick Actions">
              <div className="dashboard-quick-actions">
                {(
                  [
                    ["plus", "Create Training", "/lnd/trainings"],
                    ["upload", "Import Questions", "/lnd/imports"],
                    ["users", "Assign Employees", "/lnd/assignments"],
                    ["settings", "Assessment Settings", "/lnd/assessment-config"],
                    ["chart", "View Scorecards", "/lnd/scorecards"],
                    ["file", "Generate Reports", "/lnd/reports"],
                  ] as [string, string, string][]
                ).map(([icon, label, href]) => (
                  <Link href={href} key={label}>
                    <Icon name={icon} />
                    <span>{label}</span>
                  </Link>
                ))}
              </div>
            </Panel>
          </div>
          <ScorecardCta heading="Organisation Learning & Behaviour Scorecard" description="View learning gain and behaviour evidence for each training." href="/lnd/scorecards" label="View Scorecards" />
        </div>
      )}
    </Loaded>
  );
}

/* ---------- Training management ---------- */

function useCatalogue() {
  return {
    departments: useApi<OrgUnit[]>("/admin/departments"),
    functions: useApi<OrgUnit[]>("/admin/functions"),
    trainers: useApi<(Named & { is_active: boolean })[]>("/admin/trainers"),
    competencies: useApi<(Named & { description: string | null; is_active: boolean })[]>("/admin/competencies"),
  };
}

function TrainingForm({ training, onClose, onSaved }: { training: TrainingAdmin | null; onClose: () => void; onSaved: () => void }) {
  const c = useCatalogue();
  const toast = useToast();
  const { user } = useSession();
  const behaviourOn = Boolean(user?.features?.behaviour);
  const [scope, setScope] = useState(training?.target_scope ?? "COMMON");
  const save = async (form: FormData) => {
    const body = {
      ...(training ? {} : { training_code: form.get("training_code") || null }),
      title: form.get("title"),
      description: form.get("description") || null,
      category: form.get("category") || null,
      trainer_id: form.get("trainer_id") || null,
      target_scope: form.get("target_scope"),
      department_ids: form.getAll("department_ids"),
      function_ids: form.getAll("function_ids"),
      competency_ids: form.getAll("competency_ids"),
      refresher_text: form.get("refresher_text") || null,
      refresher_url: form.get("refresher_url") || null,
      pretest_enabled: form.has("pretest_enabled"),
      // Level 3 settings are hidden while Behaviour is switched off; the stored values are kept unchanged.
      behaviour_enabled: behaviourOn ? form.has("behaviour_enabled") : (training?.behaviour_enabled ?? false),
      followup_days: behaviourOn
        ? String(form.get("followup_days") ?? "")
            .split(",")
            .map((x) => Number(x.trim()))
            .filter(Boolean)
        : (training?.followup_days ?? []),
      item_minimum_sample: Number(form.get("item_minimum_sample")),
    };
    if (training) await api.patch(`/admin/trainings/${training.id}`, body);
    else await api.post("/admin/trainings", body);
    toast("Training saved.");
    onSaved();
  };
  const checklist = (label: string, name: string, items: Named[] | undefined, selected: Named[] | undefined) => (
    <fieldset>
      <legend>{label}</legend>
      <div className="checkbox-list">
        {(items ?? []).map((x) => (
          <label key={x.id}>
            <input type="checkbox" name={name} value={x.id} defaultChecked={selected?.some((s) => s.id === x.id)} /> {x.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <DialogForm title={training ? "Edit training" : "Create training"} onClose={onClose} onSubmit={save} submitLabel="Save training" wide>
      {training ? null : <TextField label="Training code (optional)" name="training_code" maxLength={40} />}
      <TextField label="Training name *" name="title" required maxLength={200} defaultValue={training?.title} />
      <TextField label="Category / topic" name="category" maxLength={120} defaultValue={training?.category ?? ""} />
      <Field label="Description">
        <textarea name="description" maxLength={2000} defaultValue={training?.description ?? ""} />
      </Field>
      <SelectField label="Trainer" name="trainer_id" placeholder="Not assigned" options={names(c.trainers.data ?? [])} defaultValue={training?.trainer_id ?? ""} />
      <SelectField label="Who is this training for?" name="target_scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} options={Object.entries(SCOPE_LABEL).map(([value, label]) => ({ value, label }))} />
      {scope === "DEPARTMENT" || scope === "COMBINED" ? checklist("Departments *", "department_ids", c.departments.data ?? [], training?.departments) : null}
      {scope === "FUNCTION" || scope === "COMBINED" ? checklist("Functions *", "function_ids", c.functions.data ?? [], training?.functions) : null}
      {checklist("Competencies and skills", "competency_ids", c.competencies.data ?? [], training?.competencies)}
      <Field label="Refresher guidance">
        <textarea name="refresher_text" maxLength={4000} defaultValue={training?.refresher_text ?? ""} />
      </Field>
      <TextField label="Refresher link (optional HTTPS)" name="refresher_url" type="url" defaultValue={training?.refresher_url ?? ""} />
      <label className="checkline">
        <input type="checkbox" name="pretest_enabled" defaultChecked={training?.pretest_enabled} /> Offer an optional pre-test before completion
      </label>
      {behaviourOn ? (
        <label className="checkline">
          <input type="checkbox" name="behaviour_enabled" defaultChecked={training?.behaviour_enabled ?? true} /> Schedule behaviour follow-ups (Level 3)
        </label>
      ) : null}
      <div className="form-grid">
        {behaviourOn ? <TextField label="Follow-up days (comma separated)" name="followup_days" defaultValue={(training?.followup_days ?? [30, 60, 90]).join(",")} /> : null}
        <TextField label="Minimum responses for question flags" name="item_minimum_sample" type="number" min={1} max={1000} defaultValue={training?.item_minimum_sample ?? 10} />
      </div>
      <div className="notice">New programmes start as drafts and cannot be assigned until they are active. Add questions and configure the assessment before activating.</div>
    </DialogForm>
  );
}

interface ScheduleResult {
  scheduled: { employee_code: string; employee_name: string }[];
  reconfigured: { employee_code: string; employee_name: string }[];
  still_blocked: { employee_code: string; employee_name: string; reason: string }[];
}

const people = (items: { employee_name: string; employee_code: string }[]) => items.map((p) => `${p.employee_name} (${p.employee_code})`).join(", ");

/** Recovery after a configuration or question-pool fix. The server re-checks readiness. */
async function schedulePending(trainingId: string): Promise<string> {
  const r = await api.post<ScheduleResult>(`/admin/trainings/${trainingId}/schedule-assessments`);
  const parts = [`${r.scheduled.length} assessment(s) scheduled`, `${r.reconfigured.length} moved to the current configuration`];
  if (r.still_blocked.length) parts.push(`${r.still_blocked.length} still need action: ${r.still_blocked.map((b) => `${b.employee_name} (${b.reason})`).join("; ")}`);
  return `${parts.join(". ")}.`;
}

/** Completions with no assessment, and assessments that can no longer start, for one training. */
function AssessmentAttention({ training, onChanged }: { training: TrainingAdmin; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!training.pending_scheduling_count && !training.unavailable_count) return null;
  const readiness = training.assessment_readiness;
  const run = async () => {
    setBusy(true);
    try {
      toast(await schedulePending(training.id));
      onChanged();
    } catch (e) {
      toast((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice danger">
      <div>
        {training.pending_scheduling_count ? (
          <p>
            <strong>{training.pending_scheduling_count} completion(s) have no assessment scheduled</strong>
            {training.pending_scheduling?.length ? `: ${people(training.pending_scheduling)}` : ""}.
          </p>
        ) : null}
        {training.unavailable_count ? (
          <p>
            <strong>{training.unavailable_count} due assessment(s) cannot start</strong> because the question pool no longer satisfies their configuration
            {training.unavailable_assessments?.length ? `: ${people(training.unavailable_assessments)}` : ""}. These employees are not blocked meanwhile.
          </p>
        ) : null}
        {readiness.ready ? (
          <Btn tone="attention" disabled={busy} onClick={() => void run()}>
            {busy ? "Scheduling…" : "Schedule pending assessments"}
          </Btn>
        ) : (
          <p className="small">
            {readiness.message} {readiness.action}
          </p>
        )}
      </div>
    </div>
  );
}

function TrainingDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (t: TrainingAdmin) => void }) {
  const state = useApi<TrainingAdmin>(`/admin/trainings/${id}`);
  const toast = useToast();
  const [error, setError] = useState("");
  const addMaterial = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const v = new FormData(form);
    try {
      await api.post(`/admin/trainings/${id}/materials`, { kind: v.get("kind"), title: v.get("title"), url: v.get("url") });
      setError("");
      form.reset();
      toast("Material attached.");
      void state.reload();
    } catch (e) {
      setError(fieldErrors(e));
    }
  };
  const remove = async (materialId: string) => {
    await api.del(`/admin/trainings/${id}/materials/${materialId}`).catch(() => {});
    void state.reload();
  };
  return (
    <Modal title="Training details" onClose={onClose} wide>
      <Loaded state={state}>
        {(t) => (
          <>
            <span className="badge info">{t.category ?? "Uncategorised"}</span>
            <h3 style={{ marginTop: 14 }}>{t.title}</h3>
            <p>{t.description}</p>
            <div className="detail-grid">
              <div>
                <small>Code</small>
                <strong>{t.training_code}</strong>
              </div>
              <div>
                <small>Trainer</small>
                <strong>{t.trainer_name ?? "Not assigned"}</strong>
              </div>
              <div>
                <small>Audience</small>
                <strong>{SCOPE_LABEL[t.target_scope]}</strong>
              </div>
              <div>
                <small>Status</small>
                <strong>{t.status}</strong>
              </div>
            </div>
            <p>Competencies: {t.competencies.map((c) => c.name).join(", ") || "None linked"}.</p>
            <p>
              Audience: {SCOPE_LABEL[t.target_scope]}
              {t.departments.length ? ` · Departments: ${t.departments.map((d) => d.name).join(", ")}` : ""}
              {t.functions.length ? ` · Functions: ${t.functions.map((f) => f.name).join(", ")}` : ""}. Assigned {t.assigned_count}, completed {t.completed_count}.
            </p>
            {!t.config ? <div className="notice danger">{t.assessment_readiness.message} {t.assessment_readiness.action}</div> : t.pool_problem ? <div className="notice danger">The assessment cannot run yet. {describePool(t.pool_problem, t.title)}</div> : <div className="notice">The question pool satisfies this assessment ({t.eligible_questions} eligible questions).</div>}
            <AssessmentAttention training={t} onChanged={() => void state.reload()} />
            <h3>Materials and recordings</h3>
            {t.materials?.length ? (
              <ul>
                {t.materials.map((m) => (
                  <li key={m.id}>
                    <a href={m.url} target="_blank" rel="noopener noreferrer">
                      {m.title}
                    </a>{" "}
                    ({m.kind.toLowerCase()}){" "}
                    <Btn kind="text" tone="danger" onClick={() => void remove(m.id)}>
                      Remove
                    </Btn>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No materials attached.</p>
            )}
            <form onSubmit={(e) => void addMaterial(e)}>
              <div className="form-grid">
                <SelectField label="Type" name="kind" options={[{ value: "LINK", label: "Link" }, { value: "DOCUMENT", label: "Document" }, { value: "RECORDING", label: "Recording" }]} />
                <TextField label="Title *" name="title" required maxLength={200} />
              </div>
              <TextField label="HTTPS address *" name="url" type="url" required />
              <FormError message={error} />
              <button className="btn secondary" type="submit">
                Attach material
              </button>
            </form>
            <div className="dialog-actions">
              <Btn kind="primary" onClick={() => onEdit(t)}>
                Edit training
              </Btn>
            </div>
          </>
        )}
      </Loaded>
    </Modal>
  );
}

export function TrainingManagement() {
  const [search, setSearch] = useState({ search: "", status: "" });
  const state = useApi<TrainingAdmin[]>(`/admin/trainings${toQuery(search)}`);
  const [form, setForm] = useState<{ training: TrainingAdmin | null } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [status, setStatus] = useState<TrainingAdmin | null>(null);
  const [removing, setRemoving] = useState<TrainingAdmin | null>(null);
  const toast = useToast();
  return (
    <>
      <PageTitle
        eyebrow={EYEBROW}
        title="Training Management"
        description="Manage programmes, owners, materials and assessment readiness."
        action={
          <Btn kind="primary" onClick={() => setForm({ training: null })}>
            <Icon name="plus" /> Create Training
          </Btn>
        }
      />
      <section className="panel">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget);
            setSearch({ search: String(v.get("search")), status: String(v.get("status")) });
          }}
        >
          <TextField label="Search programmes" name="search" type="search" placeholder="Training, category or code" />
          <SelectField label="Status" name="status" placeholder="All statuses" options={[{ value: "ACTIVE", label: "Active" }, { value: "DRAFT", label: "Draft" }, { value: "ARCHIVED", label: "Archived" }]} />
          <button className="btn secondary" type="submit">
            Apply Filters
          </button>
        </form>
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Training / Category", "Trainer", "Audience", "Status", "Assigned", "Completion", "Assessment", "Actions"]}
              emptyTitle="No trainings match."
              rows={rows.map((t) => [
                <div key="t" data-sort={t.title}>
                  <strong>{t.title}</strong>
                  <small>{t.category}</small>
                </div>,
                t.trainer_name ?? "Not assigned",
                <div key="aud" data-sort={SCOPE_LABEL[t.target_scope]}>
                  {SCOPE_LABEL[t.target_scope]}
                  {t.departments.length || t.functions.length ? <small>{[...t.departments, ...t.functions].map((x) => x.name).join(", ")}</small> : null}
                </div>,
                <Badge key="s" status={t.status} />,
                t.assigned_count,
                `${t.completed_count} / ${t.assigned_count}`,
                <div key="c" data-sort={t.config_ready ? "1" : "0"}>
                  {t.config ? `${t.config.question_count} questions · ${t.config.duration_minutes} min` : "Not configured"}
                  <small>
                    {t.config ? `${t.config.pass_mark_percent}% pass · ${t.config.max_attempts} attempts · ` : ""}
                    {t.eligible_questions} eligible · {t.config_ready ? "Ready" : t.config ? "Needs questions" : "Needs configuration"}
                  </small>
                  {t.pending_scheduling_count || t.unavailable_count ? (
                    <small className="form-error">
                      {t.pending_scheduling_count ? `${t.pending_scheduling_count} not scheduled` : ""}
                      {t.pending_scheduling_count && t.unavailable_count ? " · " : ""}
                      {t.unavailable_count ? `${t.unavailable_count} cannot start` : ""}
                    </small>
                  ) : null}
                </div>,
                <div className="row wrap" key="a">
                  <Btn kind="text" onClick={() => setDetail(t.id)}>
                    Details
                  </Btn>
                  <Btn kind="text" onClick={() => setForm({ training: t })}>
                    Edit
                  </Btn>
                  <Btn kind="text" tone={t.status === "ACTIVE" ? "danger" : "success"} onClick={() => setStatus(t)}>
                    {t.status === "ACTIVE" ? "Archive" : "Activate"}
                  </Btn>
                  <Btn kind="text" tone="danger" onClick={() => setRemoving(t)}>
                    Delete
                  </Btn>
                </div>,
              ])}
            />
          )}
        </Loaded>
      </section>
      {form ? <TrainingForm training={form.training} onClose={() => setForm(null)} onSaved={() => void state.reload()} /> : null}
      {detail ? (
        <TrainingDetail
          id={detail}
          onClose={() => setDetail(null)}
          onEdit={(t) => {
            setDetail(null);
            setForm({ training: t });
          }}
        />
      ) : null}
      {status ? (
        <ConfirmDialog
          title={status.status === "ACTIVE" ? "Archive training?" : "Activate training?"}
          danger={status.status === "ACTIVE"}
          confirmLabel="Confirm"
          body={<p>{status.title}. Historical results are preserved. {status.status === "ACTIVE" ? "No new assignments can be added while it is archived." : "The active question pool must satisfy the assessment."}</p>}
          onClose={() => setStatus(null)}
          onConfirm={async () => {
            await api.post(`/admin/trainings/${status.id}/status`, { status: status.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE" });
            toast("Training status updated.");
            void state.reload();
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title="Delete training?"
          danger
          confirmLabel="Delete training"
          body={<p>{removing.title}. This permanently removes the programme and its setup. Only a training that was never assigned or assessed can be deleted; otherwise archive it to keep its history.</p>}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api.del(`/admin/trainings/${removing.id}`);
            toast("Training deleted.");
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- Departments, functions, trainers, competencies, calendar ---------- */

function UnitTable({ title, path, label }: { title: string; path: string; label: string }) {
  const state = useApi<OrgUnit[]>(path);
  const [edit, setEdit] = useState<{ unit: OrgUnit | null } | null>(null);
  const toast = useToast();
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{title}</h2>
        <Btn onClick={() => setEdit({ unit: null })}>
          <Icon name="plus" /> Add {label}
        </Btn>
      </div>
      <Loaded state={state}>
        {(rows) => (
          <DataTable
            headers={["Code", "Name", "Status", ""]}
            emptyTitle={`No ${title.toLowerCase()} yet.`}
            rows={rows.map((u) => [
              u.code,
              u.name,
              <Badge key="s" status={u.is_active ? "ACTIVE" : "INACTIVE"} />,
              <Btn key="e" kind="text" onClick={() => setEdit({ unit: u })}>
                Edit
              </Btn>,
            ])}
          />
        )}
      </Loaded>
      {edit ? (
        <DialogForm
          title={`${edit.unit ? "Edit" : "Add"} ${label}`}
          submitLabel="Save"
          onClose={() => setEdit(null)}
          onSubmit={async (form) => {
            const body = { code: form.get("code"), name: form.get("name"), is_active: form.has("is_active") };
            if (edit.unit) await api.patch(`${path}/${edit.unit.id}`, body);
            else await api.post(path, body);
            toast("Saved.");
            void state.reload();
          }}
        >
          <TextField label="Code *" name="code" required maxLength={40} defaultValue={edit.unit?.code} />
          <TextField label="Name *" name="name" required maxLength={120} defaultValue={edit.unit?.name} />
          <label className="checkline">
            <input type="checkbox" name="is_active" defaultChecked={edit.unit?.is_active ?? true} /> Active
          </label>
        </DialogForm>
      ) : null}
    </section>
  );
}

function SimpleList({ title, path, label, fields, columns, rowOf }: { title: string; path: string; label: string; fields: ReactNode; columns: string[]; rowOf: (r: never) => ReactNode[] }) {
  const state = useApi<never[]>(path);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{title}</h2>
        <Btn onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add {label}
        </Btn>
      </div>
      <Loaded state={state}>{(rows) => <DataTable headers={columns} emptyTitle={`No ${title.toLowerCase()} yet.`} rows={rows.map(rowOf)} />}</Loaded>
      {adding ? (
        <DialogForm
          title={`Add ${label}`}
          submitLabel="Save"
          onClose={() => setAdding(false)}
          onSubmit={async (form) => {
            await api.post(path, { ...Object.fromEntries(form.entries()), is_active: true });
            toast("Saved.");
            void state.reload();
          }}
        >
          {fields}
        </DialogForm>
      ) : null}
    </section>
  );
}

interface CalendarData {
  name: string;
  timezone: string;
  working_weekdays: number[];
  holidays: { id: string; date: string; name: string }[];
  policy_note: string;
}
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function CalendarPanel() {
  const state = useApi<CalendarData>("/admin/calendar");
  const toast = useToast();
  const [error, setError] = useState("");
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const v = new FormData(event.currentTarget);
    try {
      await api.patch("/admin/calendar", { name: v.get("name"), timezone: v.get("timezone"), working_weekdays: v.getAll("weekday").map(Number) });
      setError("");
      toast("Calendar saved. Dates already calculated keep their original schedule.");
      void state.reload();
    } catch (e) {
      setError(fieldErrors(e));
    }
  };
  const addHoliday = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const v = new FormData(form);
    try {
      await api.post("/admin/calendar/holidays", { holiday_date: v.get("holiday_date"), name: v.get("name") || "Holiday" });
      setError("");
      form.reset();
      void state.reload();
    } catch (e) {
      setError(fieldErrors(e));
    }
  };
  return (
    <section className="panel">
      <h2>Working calendar and timezone</h2>
      <Loaded state={state}>
        {(c) => (
          <>
            <div className="notice">{c.policy_note}</div>
            <form onSubmit={(e) => void save(e)}>
              <div className="form-grid">
                <TextField label="Calendar name *" name="name" required defaultValue={c.name} />
                <TextField label="Timezone *" name="timezone" required defaultValue={c.timezone} />
              </div>
              <fieldset>
                <legend>Working days</legend>
                <div className="checkbox-list">
                  {WEEKDAYS.map((day, i) => (
                    <label key={day}>
                      <input type="checkbox" name="weekday" value={i} defaultChecked={c.working_weekdays.includes(i)} /> {day}
                    </label>
                  ))}
                </div>
              </fieldset>
              <button className="btn secondary" type="submit">
                Save calendar
              </button>
            </form>
            <h3>Holidays</h3>
            <DataTable
              all
              headers={["Date", "Name", ""]}
              emptyTitle="No holidays set."
              emptyHint="Add dates that should not count as working days."
              rows={c.holidays.map((h) => [
                h.date,
                h.name,
                <Btn key="r" kind="text" tone="danger" onClick={() => void api.del(`/admin/calendar/holidays/${h.id}`).then(state.reload)}>
                  Remove
                </Btn>,
              ])}
            />
            <form className="filters" onSubmit={(e) => void addHoliday(e)}>
              <TextField label="Holiday date" name="holiday_date" type="date" required />
              <TextField label="Name" name="name" maxLength={120} />
              <button className="btn secondary" type="submit">
                Add holiday
              </button>
            </form>
            <FormError message={error} />
          </>
        )}
      </Loaded>
    </section>
  );
}

export function Organisation() {
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Department and Function Management" description="Organisation dimensions used for training targeting, question categories and reporting." />
      <UnitTable title="Departments" path="/admin/departments" label="department" />
      <UnitTable title="Functions" path="/admin/functions" label="function" />
      <SimpleList
        title="Trainers"
        label="trainer"
        path="/admin/trainers"
        columns={["Name", "Email"]}
        rowOf={(t: { name: string; email: string | null }) => [t.name, t.email ?? "—"]}
        fields={
          <>
            <TextField label="Name *" name="name" required maxLength={160} />
            <TextField label="Email" name="email" type="email" />
          </>
        }
      />
      <SimpleList
        title="Competencies and skills"
        label="competency"
        path="/admin/competencies"
        columns={["Competency", "Description"]}
        rowOf={(c: { name: string; description: string | null }) => [c.name, c.description ?? "—"]}
        fields={
          <>
            <TextField label="Name *" name="name" required maxLength={160} />
            <Field label="Behaviour description">
              <textarea name="description" maxLength={2000} />
            </Field>
          </>
        }
      />
      <CalendarPanel />
    </>
  );
}

/* ---------- Batches ---------- */

interface Batch {
  id: string;
  name: string;
  batch_code: string;
  training_id: string;
  training_title: string;
  trainer_name: string | null;
  start_date: string | null;
  end_date: string | null;
  assigned_count: number;
  sessions: { id: string; title: string; session_date: string; delivery_mode: string | null; venue: string | null }[];
}

export function Batches() {
  const state = useApi<Batch[]>("/admin/batches");
  const trainings = useApi<TrainingAdmin[]>("/admin/trainings");
  const trainers = useApi<Named[]>("/admin/trainers");
  const [creating, setCreating] = useState(false);
  const [sessionFor, setSessionFor] = useState<Batch | null>(null);
  const toast = useToast();
  return (
    <>
      <PageTitle
        eyebrow={EYEBROW}
        title="Batches & Sessions"
        description="Create delivery cohorts, then assign employees and record completion separately."
        action={
          <Btn kind="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Create Batch
          </Btn>
        }
      />
      <section className="panel">
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Batch", "Training", "Trainer", "Dates", "Sessions", "Assigned", ""]}
              emptyTitle="No batches yet."
              rows={rows.map((b) => [
                b.name,
                b.training_title,
                b.trainer_name ?? "Not assigned",
                b.start_date ? `${b.start_date} to ${b.end_date ?? "open"}` : "Not scheduled",
                b.sessions.map((s) => `${s.title} (${s.session_date})`).join("; ") || "None",
                b.assigned_count,
                <Btn key="s" kind="text" onClick={() => setSessionFor(b)}>
                  Add Session
                </Btn>,
              ])}
            />
          )}
        </Loaded>
      </section>
      {creating ? (
        <DialogForm
          title="Create training batch"
          submitLabel="Create batch"
          onClose={() => setCreating(false)}
          onSubmit={async (form) => {
            await api.post("/admin/batches", { training_id: form.get("training_id"), name: form.get("name"), trainer_id: form.get("trainer_id") || null, start_date: form.get("start_date") || null, end_date: form.get("end_date") || null });
            toast("Batch created.");
            void state.reload();
          }}
        >
          <SelectField label="Training *" name="training_id" required options={(trainings.data ?? []).map((t) => ({ value: t.id, label: t.title }))} />
          <TextField label="Batch name *" name="name" required maxLength={160} />
          <SelectField label="Trainer" name="trainer_id" placeholder="Use the training's trainer" options={names(trainers.data ?? [])} />
          <div className="form-grid">
            <TextField label="Start date" name="start_date" type="date" />
            <TextField label="End date" name="end_date" type="date" />
          </div>
        </DialogForm>
      ) : null}
      {sessionFor ? (
        <DialogForm
          title={`Add session · ${sessionFor.name}`}
          submitLabel="Add session"
          onClose={() => setSessionFor(null)}
          onSubmit={async (form) => {
            await api.post(`/admin/batches/${sessionFor.id}/sessions`, { title: form.get("title"), session_date: form.get("session_date"), delivery_mode: form.get("delivery_mode") || null, venue: form.get("venue") || null });
            toast("Session added.");
            void state.reload();
          }}
        >
          <TextField label="Session title *" name="title" required maxLength={160} />
          <TextField label="Session date *" name="session_date" type="date" required />
          <div className="form-grid">
            <TextField label="Delivery mode" name="delivery_mode" maxLength={40} placeholder="Virtual or in person" />
            <TextField label="Venue" name="venue" maxLength={160} />
          </div>
        </DialogForm>
      ) : null}
    </>
  );
}

/* ---------- Assignments and completion ---------- */

interface EnrolmentRow {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  department: string | null;
  training_id: string;
  training_title: string;
  batch_name: string | null;
  assigned_at: string;
  attendance_status: string;
  completed_at: string | null;
  completion_source: string | null;
  due_at: string | null;
  assessment_state: string;
  assessment_issue: { code: string; message: string; action: string | null } | null;
  outcome: string | null;
  retraining_flag: string;
  obligation_id: string | null;
}

interface SchedulingOutcome {
  status: "SCHEDULED" | "NOT_SCHEDULED" | "ALREADY_SCHEDULED";
  reason: string | null;
  message: string;
  action: string | null;
  due_at: string | null;
}

function resultOf(e: EnrolmentRow): string {
  if (e.retraining_flag === "NEEDS_RETRAINING") return "NEEDS_RETRAINING";
  return e.outcome ?? "PENDING";
}

interface AssignmentResult {
  created: number;
  skipped_existing: number;
  skipped_out_of_target: number;
  skipped_inactive: number;
  not_found: number;
  results: { employee_id: string; employee_code: string | null; employee_name: string | null; status: string; reason: string | null }[];
}

const ASSIGN_STATUS: Record<string, [string, string]> = {
  ASSIGNED: ["Assigned", "success"],
  ALREADY_ASSIGNED: ["Already assigned", "info"],
  OUT_OF_TARGET: ["Outside audience", "warning"],
  INACTIVE: ["Inactive employee", "warning"],
  NOT_FOUND: ["Not found", "danger"],
};

function AssignmentOutcome({ result, onClose }: { result: AssignmentResult; onClose: () => void }) {
  const skipped = result.results.filter((r) => r.status !== "ASSIGNED");
  return (
    <Modal title="Assignment result" onClose={onClose}>
      <Metrics
        items={[
          ["Assigned", result.created, "New assignments created"],
          ["Already assigned", result.skipped_existing, "No duplicate created"],
          ["Outside audience", result.skipped_out_of_target, "Department or function does not match"],
          ["Inactive", result.skipped_inactive, "No new assignments for inactive employees"],
        ]}
      />
      {skipped.length ? (
        <DataTable
          all
          headers={["Employee", "Outcome", "Reason"]}
          rows={skipped.map((r) => {
            const [label, tone] = ASSIGN_STATUS[r.status] ?? [r.status, "info"];
            return [
              r.employee_name ? `${r.employee_name} · ${r.employee_code}` : r.employee_id,
              <span key="s" className={`badge ${tone}`}>
                {label}
              </span>,
              r.reason ?? "—",
            ];
          })}
        />
      ) : (
        <p>Every selected employee was assigned.</p>
      )}
      <div className="dialog-actions">
        <Btn kind="primary" onClick={onClose}>
          Close
        </Btn>
      </div>
    </Modal>
  );
}

function AssignDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (result: AssignmentResult) => void }) {
  const trainings = useApi<TrainingAdmin[]>("/admin/trainings?status=ACTIVE");
  const batches = useApi<Batch[]>("/admin/batches");
  const employees = useApi<{ id: string; full_name: string; employee_code: string; department: string | null; function: string | null; employment_status: string }[]>("/admin/employees");
  const [trainingId, setTrainingId] = useState("");
  const [useTarget, setUseTarget] = useState(false);
  const [filter, setFilter] = useState("");
  const list = trainings.data ?? [];
  const selected = trainingId || list[0]?.id || "";
  const training = list.find((t) => t.id === selected);
  const needle = filter.trim().toLowerCase();
  // Inactive employees cannot receive new assignments, so they are not offered.
  const active = (employees.data ?? []).filter((p) => p.employment_status !== "INACTIVE");
  const shown = needle ? active.filter((p) => `${p.full_name} ${p.employee_code} ${p.department ?? ""} ${p.function ?? ""}`.toLowerCase().includes(needle)) : active;
  return (
    <DialogForm
      title="Assign employees"
      submitLabel="Assign selected employees"
      wide
      submitBlockedReason={trainings.data && !list.length ? "No active training can take assignments. Activate a training in Training Management first." : null}
      onClose={onClose}
      onSubmit={async (form) => {
        const result = await api.post<AssignmentResult>("/admin/enrolments", { training_id: selected, batch_id: form.get("batch_id") || null, employee_ids: form.getAll("employee_ids"), use_training_target: useTarget });
        onSaved(result);
      }}
    >
      <SelectField label="Training (active only) *" value={selected} onChange={(e) => setTrainingId(e.target.value)} options={list.map((t) => ({ value: t.id, label: t.title }))} />
      <SelectField label="Batch" name="batch_id" placeholder="No batch" options={(batches.data ?? []).filter((b) => b.training_id === selected).map((b) => ({ value: b.id, label: b.name }))} />
      {training ? (
        <p className="small">
          Audience: {SCOPE_LABEL[training.target_scope]}
          {training.departments.length ? ` · ${training.departments.map((d) => d.name).join(", ")}` : ""}
          {training.functions.length ? ` · ${training.functions.map((f) => f.name).join(", ")}` : ""}. Employees outside this audience are reported and skipped.
        </p>
      ) : null}
      <label className="checkline">
        <input type="checkbox" checked={useTarget} onChange={(e) => setUseTarget(e.target.checked)} /> Assign everyone in this training&apos;s audience
      </label>
      {useTarget ? null : (
        <fieldset>
          <legend>Select employees</legend>
          <TextField label="Find by name, ID, department or function" name="employee_filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="checkbox-list">
            {shown.map((p) => (
              <label key={p.id}>
                <input type="checkbox" name="employee_ids" value={p.id} /> {p.full_name} · {p.employee_code}
                {p.department || p.function ? <small> · {[p.department, p.function].filter(Boolean).join(" / ")}</small> : null}
              </label>
            ))}
          </div>
          {employees.data && !shown.length ? <p className="small">No active employee matches.</p> : null}
        </fieldset>
      )}
      <p className="small">Existing assignments are skipped, so no one is enrolled twice. Record completion separately after attendance.</p>
    </DialogForm>
  );
}

export function Assignments() {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const state = useApi<EnrolmentRow[]>(`/admin/enrolments${toQuery({ search })}`);
  const [assigning, setAssigning] = useState(false);
  const [outcome, setOutcome] = useState<AssignmentResult | null>(null);
  const [cancel, setCancel] = useState<EnrolmentRow | null>(null);
  const toast = useToast();
  return (
    <>
      <PageTitle
        eyebrow={EYEBROW}
        title="Employee Assignments"
        description="Training assignment and completion are independent records. Only active trainings and active employees in the audience can be assigned."
        action={
          <Btn kind="primary" onClick={() => setAssigning(true)}>
            <Icon name="plus" /> Assign Employees
          </Btn>
        }
      />
      <section className="panel">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget);
            setSearch(String(v.get("search")));
            setStage(String(v.get("stage") ?? ""));
          }}
        >
          <TextField label="Search" name="search" placeholder="Employee name or ID" />
          <SelectField label="Stage" name="stage" placeholder="All assignments" options={[{ value: "pending", label: "Awaiting completion" }, { value: "completed", label: "Completed" }]} />
          <button className="btn secondary" type="submit">
            Apply filters
          </button>
        </form>
        <Loaded state={state}>
          {(all) => {
            const rows = stage === "pending" ? all.filter((e) => !e.completed_at) : stage === "completed" ? all.filter((e) => e.completed_at) : all;
            return (
            <>
            <Metrics
              items={[
                ["Assigned", all.length, "Live assignments"],
                ["Awaiting completion", all.filter((e) => !e.completed_at).length, "Completion not yet recorded"],
                ["Completed", all.filter((e) => e.completed_at).length, "Completion recorded"],
              ]}
            />
            <DataTable
              headers={["Employee", "Training / Batch", "Assigned", "Completion", "Assessment", "Result", ""]}
              emptyTitle="No assignments match."
              rows={rows.map((e) => [
                <div key="p" data-sort={e.employee_name}>
                  {e.employee_name}
                  <small>{e.employee_code}</small>
                </div>,
                <div key="t" data-sort={e.training_title}>
                  {e.training_title}
                  <small>{e.batch_name ?? "No batch"}</small>
                </div>,
                day(e.assigned_at),
                day(e.completed_at),
                e.assessment_state,
                resultOf(e),
                e.completed_at ? null : (
                  <Btn key="c" kind="text" tone="danger" onClick={() => setCancel(e)}>
                    Cancel
                  </Btn>
                ),
              ])}
            />
            </>
            );
          }}
        </Loaded>
      </section>
      {assigning ? (
        <AssignDialog
          onClose={() => setAssigning(false)}
          onSaved={(result) => {
            setOutcome(result);
            void state.reload();
          }}
        />
      ) : null}
      {outcome ? <AssignmentOutcome result={outcome} onClose={() => setOutcome(null)} /> : null}
      {cancel ? (
        <ConfirmDialog
          title="Cancel this assignment?"
          danger
          needsReason
          confirmLabel="Cancel assignment"
          body={
            <p>
              {cancel.employee_name} · {cancel.training_title}. The record and reason are kept.
            </p>
          }
          onClose={() => setCancel(null)}
          onConfirm={async (reason) => {
            await api.post(`/admin/enrolments/${cancel.id}/cancel`, { reason });
            toast("Assignment cancelled.");
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

const ATTENDANCE = ["PENDING", "PRESENT", "PARTIAL", "ABSENT", "EXCUSED"];
const today = () => new Date().toISOString().slice(0, 10);

/** Trainings whose completed employees have no usable assessment, with the fix and the people affected. */
function SchedulingAttention({ rows, onChanged }: { rows: EnrolmentRow[]; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const groups = new Map<string, { title: string; rows: EnrolmentRow[] }>();
  for (const row of rows.filter((r) => r.assessment_issue)) {
    const group = groups.get(row.training_id) ?? { title: row.training_title, rows: [] };
    group.rows.push(row);
    groups.set(row.training_id, group);
  }
  if (!groups.size) return null;
  const run = async (trainingId: string) => {
    setBusy(trainingId);
    try {
      toast(await schedulePending(trainingId));
      onChanged();
    } catch (e) {
      toast((e as ApiError).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="panel">
      <h2>Assessments needing attention</h2>
      {[...groups.entries()].map(([trainingId, group]) => {
        const first = group.rows[0].assessment_issue!;
        return (
          <div className="notice danger" key={trainingId}>
            <div>
              <p>
                <strong>{group.title}</strong>: {group.rows.length} employee(s) affected: {group.rows.map((r) => `${r.employee_name} (${r.employee_code})`).join(", ")}.
              </p>
              <p className="small">
                {first.message} {first.action}
              </p>
              <Btn tone="attention" disabled={Boolean(busy)} onClick={() => void run(trainingId)}>
                {busy === trainingId ? "Scheduling…" : "Schedule pending assessments"}
              </Btn>
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function Completion() {
  const state = useApi<EnrolmentRow[]>("/admin/enrolments");
  const { user } = useSession();
  const [completing, setCompleting] = useState<EnrolmentRow | null>(null);
  const [waiving, setWaiving] = useState<EnrolmentRow | null>(null);
  const [cycle, setCycle] = useState<EnrolmentRow | null>(null);
  const [lastOutcome, setLastOutcome] = useState<SchedulingOutcome | null>(null);
  const toast = useToast();
  const setAttendance = async (e: EnrolmentRow, status: string) => {
    try {
      await api.patch(`/admin/enrolments/${e.id}/attendance`, { attendance_status: status });
      void state.reload();
    } catch (error) {
      toast((error as ApiError).message);
    }
  };
  return (
    <>
      <PageTitle
        eyebrow={EYEBROW}
        title="Training Completion"
        description={`Record attendance and completion. Only Present attendance counts as completion. Completion schedules the assessment when the training's configuration and question pool are ready${user?.features?.behaviour ? ", and the 30/60/90-day follow-ups" : ""}.`}
        action={<BtnLink href="/lnd/imports" tone="data">Import Attendance</BtnLink>}
      />
      {lastOutcome && lastOutcome.status === "NOT_SCHEDULED" ? (
        <div className="notice danger" role="alert">
          <div>
            <strong>Assessment not scheduled.</strong> {lastOutcome.message} {lastOutcome.action}
          </div>
        </div>
      ) : null}
      {state.data ? <SchedulingAttention rows={state.data} onChanged={() => void state.reload()} /> : null}
      <section className="panel">
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Employee", "Training", "Attendance", "Completion", "Assessment Due", "Assessment", "Result", ""]}
              emptyTitle="No assignments yet."
              rows={rows.map((e) => [
                <div key="p" data-sort={e.employee_name}>
                  {e.employee_name}
                  <small>{e.employee_code}</small>
                </div>,
                e.training_title,
                <select key="a" aria-label={`Attendance for ${e.employee_name}`} value={e.attendance_status} onChange={(ev) => void setAttendance(e, ev.target.value)}>
                  {ATTENDANCE.map((a) => (
                    <option key={a} value={a}>
                      {a.charAt(0) + a.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>,
                e.completed_at ? `${day(e.completed_at)} (${e.completion_source === "IMPORT" ? "import" : "manual"})` : "Not recorded",
                day(e.due_at, "Not scheduled"),
                <div key="s" data-sort={e.assessment_state}>
                  {e.assessment_state}
                  {e.assessment_issue ? <small className="form-error">{e.assessment_issue.code === "UNAVAILABLE" ? "Cannot start: question pool" : "No assessment scheduled"}</small> : null}
                </div>,
                resultOf(e),
                <div className="row wrap" key="x">
                  {e.completed_at ? null : (
                    <Btn tone="success" onClick={() => setCompleting(e)}>
                      Mark Completed
                    </Btn>
                  )}
                  {["Due", "Scheduled", "Retake pending", "Unavailable"].includes(e.assessment_state) && e.obligation_id ? (
                    <Btn kind="text" onClick={() => setWaiving(e)}>
                      Waive
                    </Btn>
                  ) : null}
                  {e.retraining_flag === "NEEDS_RETRAINING" ? (
                    <Btn kind="text" tone="attention" onClick={() => setCycle(e)}>
                      New Cycle
                    </Btn>
                  ) : null}
                </div>,
              ])}
            />
          )}
        </Loaded>
      </section>
      {completing ? (
        <DialogForm
          title="Record training completion"
          submitLabel="Record completion"
          onClose={() => setCompleting(null)}
          onSubmit={async (form) => {
            const done = await api.post<EnrolmentRow & { assessment_scheduling: SchedulingOutcome }>(`/admin/enrolments/${completing.id}/completion`, { completion_date: form.get("completion_date"), attendance_status: form.get("attendance_status") });
            const scheduling = done.assessment_scheduling;
            setLastOutcome(scheduling);
            toast(scheduling.status === "SCHEDULED" ? `Completion recorded. ${scheduling.message}` : "Completion recorded, but the assessment was not scheduled. See the notice at the top of the page.");
            void state.reload();
          }}
        >
          <p>
            {completing.employee_name} · {completing.training_title}
          </p>
          <SelectField
            label="Attendance *"
            name="attendance_status"
            defaultValue={completing.attendance_status === "PENDING" ? "PRESENT" : completing.attendance_status}
            options={ATTENDANCE.filter((a) => a !== "PENDING").map((a) => ({ value: a, label: a.charAt(0) + a.slice(1).toLowerCase() }))}
          />
          <p className="small">Absent and Excused employees cannot be marked complete. Partial counts only if your L&amp;D policy setting allows it.</p>
          <TextField label="Completion date *" name="completion_date" type="date" required defaultValue={today()} max={today()} />
          <div className="notice">The due date uses this training&apos;s schedule and the working calendar. It is stored with the record, so later calendar changes do not move it. If the training has no valid assessment configuration, completion is still recorded and you are told which assessments were not scheduled.</div>
        </DialogForm>
      ) : null}
      {waiving ? (
        <ConfirmDialog
          title="Waive this assessment?"
          needsReason
          confirmLabel="Waive assessment"
          body={
            <p>
              {waiving.employee_name} · {waiving.training_title}. A waiver removes the assessment from the gate. It is never recorded as a pass, and the reason is audited.
            </p>
          }
          onClose={() => setWaiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/admin/obligations/${waiving.obligation_id}/waive`, { reason });
            toast("Assessment waived.");
            void state.reload();
          }}
        />
      ) : null}
      {cycle ? (
        <ConfirmDialog
          title="Open a new assessment cycle?"
          needsReason
          confirmLabel="Open new cycle"
          body={
            <p>
              {cycle.employee_name} · {cycle.training_title}. Use this after re-training. Earlier attempts and the failure record are kept.
            </p>
          }
          onClose={() => setCycle(null)}
          onConfirm={async (reason) => {
            await api.post(`/admin/obligations/${cycle.obligation_id}/retraining-cycle`, { reason });
            toast("New cycle opened. The employee will see it at their next page load.");
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- Question bank ---------- */

interface QuestionRow {
  id: string;
  question_code: string;
  topic: string;
  competency_id: string | null;
  competency: string | null;
  department_id: string | null;
  department: string | null;
  function_id: string | null;
  function: string | null;
  question_type: string;
  question_text: string;
  difficulty: string;
  language: string;
  marks: number;
  status: string;
  version: number;
  randomise_options: boolean;
  trainings: { id: string; title: string; code: string }[];
  explanation?: string | null;
  options?: { id: string; text: string; is_correct: boolean }[];
}

function QuestionForm({ question, onClose, onSaved, defaultTrainingId }: { question: QuestionRow | null; onClose: () => void; onSaved: () => void; defaultTrainingId?: string }) {
  const c = useCatalogue();
  const trainings = useApi<TrainingAdmin[]>("/admin/trainings");
  const toast = useToast();
  const [type, setType] = useState(question?.question_type ?? "MCQ_SINGLE");
  const optionsDefault = type === "TRUE_FALSE" ? "True\nFalse" : (question?.options?.map((o) => o.text).join("\n") ?? "");
  const correctDefault = (question?.options ?? []).map((o, i) => (o.is_correct ? i + 1 : 0)).filter(Boolean).join(",");
  return (
    <DialogForm
      title={question ? "Edit question" : "Add question"}
      submitLabel="Save question"
      wide
      onClose={onClose}
      onSubmit={async (form) => {
        const body = {
          ...(question ? { question_code: question.question_code } : { question_code: form.get("question_code") || null }),
          topic: form.get("topic"),
          competency_id: form.get("competency_id") || null,
          department_id: form.get("department_id") || null,
          function_id: form.get("function_id") || null,
          question_type: type,
          question_text: form.get("question_text"),
          options: String(form.get("options")).split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          correct_option_indexes: String(form.get("correct")).split(",").map((x) => Number(x.trim()) - 1),
          explanation: form.get("explanation") || null,
          difficulty: form.get("difficulty"),
          marks: Number(form.get("marks")),
          language: form.get("language"),
          randomise_options: form.has("randomise_options"),
          training_ids: form.getAll("training_ids"),
          status: question?.status ?? "ACTIVE",
        };
        if (question) await api.patch(`/admin/questions/${question.id}`, body);
        else await api.post("/admin/questions", body);
        toast("Question saved. Historical attempts are unchanged.");
        onSaved();
      }}
    >
      {question ? null : <TextField label="Question ID (optional)" name="question_code" maxLength={60} />}
      <SelectField label="Question type" value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
      <Field label="Question text *">
        <textarea name="question_text" required maxLength={4000} defaultValue={question?.question_text} />
      </Field>
      <Field label="Options * (one per line; up to 12)">
        <textarea key={type === "TRUE_FALSE" ? "tf" : "other"} name="options" required defaultValue={optionsDefault} />
      </Field>
      <TextField label="Correct option number(s) * (for example 1 or 1,3)" name="correct" required defaultValue={correctDefault} />
      <Field label="Explanation">
        <textarea name="explanation" maxLength={4000} defaultValue={question?.explanation ?? ""} />
      </Field>
      <div className="form-grid">
        <TextField label="Topic *" name="topic" required maxLength={160} defaultValue={question?.topic} />
        <SelectField label="Competency" name="competency_id" placeholder="None" options={names(c.competencies.data ?? [])} defaultValue={question?.competency_id ?? ""} />
        <SelectField label="Department" name="department_id" placeholder="Common" options={names(c.departments.data ?? [])} defaultValue={question?.department_id ?? ""} />
        <SelectField label="Function" name="function_id" placeholder="Common" options={names(c.functions.data ?? [])} defaultValue={question?.function_id ?? ""} />
        <SelectField label="Difficulty" name="difficulty" options={[["EASY", "Easy"], ["MEDIUM", "Medium"], ["HARD", "Hard"]].map(([value, label]) => ({ value, label }))} defaultValue={question?.difficulty ?? "EASY"} />
        <TextField label="Marks *" name="marks" type="number" min={0.01} max={100} step="any" required defaultValue={question?.marks ?? 1} />
        <SelectField label="Language" name="language" options={["English", "Hindi", "Hinglish"].map((value) => ({ value, label: value }))} defaultValue={question?.language ?? "English"} />
      </div>
      <fieldset>
        <legend>Used by these trainings</legend>
        <p className="small">A question counts towards a training&apos;s assessment only when it is linked here, Active, has a correct answer and has at least two options.</p>
        <div className="checkbox-list">
          {(trainings.data ?? []).map((t) => (
            <label key={t.id}>
              <input type="checkbox" name="training_ids" value={t.id} defaultChecked={question ? question.trainings.some((x) => x.id === t.id) : t.id === defaultTrainingId} /> {t.title}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="checkline">
        <input type="checkbox" name="randomise_options" defaultChecked={question?.randomise_options ?? true} /> Randomise option order (turn off for &quot;All of the above&quot;)
      </label>
      <p className="small">Edits create a new version. Past and running attempts keep the version they started with.</p>
    </DialogForm>
  );
}

export function QuestionBank() {
  return (
    <Suspense fallback={<Loading />}>
      <QuestionBankInner />
    </Suspense>
  );
}

function QuestionBankInner() {
  const trainingFromLink = useSearchParams().get("training_id") ?? "";
  const [filters, setFilters] = useState<Record<string, string>>(trainingFromLink ? { training_id: trainingFromLink } : {});
  const state = useApi<QuestionRow[]>(`/admin/questions${toQuery(filters)}`);
  const trainings = useApi<TrainingAdmin[]>("/admin/trainings");
  const c = useCatalogue();
  const [form, setForm] = useState<{ question: QuestionRow | null } | null>(null);
  const [preview, setPreview] = useState<QuestionRow | null>(null);
  const [toggling, setToggling] = useState<QuestionRow | null>(null);
  const toast = useToast();
  const load = async (id: string) => api.get<QuestionRow>(`/admin/questions/${id}`);
  return (
    <>
      <PageTitle
        eyebrow={EYEBROW}
        title="Question Bank"
        description="One central bank. Search, preview and maintain the reusable questions that verify learning."
        action={
          <Btn kind="primary" onClick={() => setForm({ question: null })}>
            <Icon name="plus" /> Add Question
          </Btn>
        }
      />
      <section className="panel">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(Object.fromEntries([...new FormData(e.currentTarget).entries()].map(([k, v]) => [k, String(v)]).filter(([, v]) => v)));
          }}
        >
          <TextField label="Search questions" name="search" type="search" placeholder="Question, topic or ID" />
          <SelectField key={trainings.data ? "loaded" : "loading"} label="Training" name="training_id" placeholder="All training" options={(trainings.data ?? []).map((t) => ({ value: t.id, label: t.title }))} defaultValue={filters.training_id ?? ""} />
          <SelectField label="Competency" name="competency_id" placeholder="All competencies" options={names(c.competencies.data ?? [])} />
          <SelectField label="Department" name="department_id" placeholder="All departments" options={names(c.departments.data ?? [])} />
          <SelectField label="Function" name="function_id" placeholder="All functions" options={names(c.functions.data ?? [])} />
          <SelectField label="Question Type" name="question_type" placeholder="All types" options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          <SelectField label="Difficulty" name="difficulty" placeholder="All difficulties" options={[["EASY", "Easy"], ["MEDIUM", "Medium"], ["HARD", "Hard"]].map(([value, label]) => ({ value, label }))} />
          <SelectField label="Language" name="language" placeholder="All languages" options={["English", "Hindi", "Hinglish"].map((value) => ({ value, label: value }))} />
          <SelectField label="Status" name="status" placeholder="All statuses" options={[{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }]} />
          <button className="btn secondary" type="submit">
            Apply Filters
          </button>
          <BtnLink href="/lnd/imports" kind="text" tone="data">
            Import Questions
          </BtnLink>
        </form>
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Question / Topic", "Trainings / Competency", "Type / Difficulty", "Marks / Language", "Version / Status", "Actions"]}
              emptyTitle="No questions match."
              rows={rows.map((q) => [
                <div key="q" data-sort={q.question_text}>
                  <strong>{q.question_text}</strong>
                  <small>
                    {q.question_code} · {q.topic}
                  </small>
                </div>,
                <div key="t">
                  {q.trainings.map((t) => t.title).join(", ") || "Not linked"}
                  <small>{q.competency ?? "No competency"}</small>
                </div>,
                <div key="d">
                  {TYPE_LABEL[q.question_type]}
                  <small>{q.difficulty.charAt(0) + q.difficulty.slice(1).toLowerCase()}</small>
                </div>,
                <div key="m">
                  {q.marks}
                  <small>{q.language}</small>
                </div>,
                <div key="v">
                  v{q.version}
                  <small>{q.status === "ACTIVE" ? "Active" : "Inactive"}</small>
                </div>,
                <div className="row wrap" key="a">
                  <Btn kind="text" onClick={() => void load(q.id).then(setPreview)}>
                    Preview
                  </Btn>
                  <Btn kind="text" onClick={() => void load(q.id).then((full) => setForm({ question: full }))}>
                    Edit
                  </Btn>
                  <Btn kind="text" tone={q.status === "ACTIVE" ? "danger" : "success"} onClick={() => setToggling(q)}>
                    {q.status === "ACTIVE" ? "Deactivate" : "Activate"}
                  </Btn>
                </div>,
              ])}
            />
          )}
        </Loaded>
      </section>
      {form ? <QuestionForm question={form.question} defaultTrainingId={filters.training_id} onClose={() => setForm(null)} onSaved={() => void state.reload()} /> : null}
      {preview ? (
        <Modal title="Question Preview" onClose={() => setPreview(null)}>
          <span className="badge info">Admin Preview · Answer Key Visible</span>
          <h3 style={{ marginTop: 16 }} lang={preview.language === "Hindi" ? "hi" : "en"}>
            {preview.question_text}
          </h3>
          <ol>
            {preview.options?.map((o) => (
              <li key={o.id}>
                {o.text} {o.is_correct ? <strong className="success">Correct</strong> : null}
              </li>
            ))}
          </ol>
          <p>{preview.explanation ?? "No explanation supplied."}</p>
          <p className="small">
            {preview.competency ?? "No competency"} · {preview.difficulty} · {preview.marks} mark(s) · {preview.language} · v{preview.version}
          </p>
        </Modal>
      ) : null}
      {toggling ? (
        <ConfirmDialog
          title={toggling.status === "ACTIVE" ? "Deactivate question?" : "Activate question?"}
          danger={toggling.status === "ACTIVE"}
          confirmLabel="Confirm"
          body={
            <>
              <p>{toggling.question_text}</p>
              <p>Past and in-progress attempts keep their saved version. New attempts use active questions only.</p>
            </>
          }
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            await api.post(`/admin/questions/${toggling.id}/status`, { status: toggling.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" });
            toast("Question updated.");
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- Import centre ---------- */

interface ImportTraining {
  id: string;
  code: string;
  title: string;
  status: string;
}

interface ImportJob {
  id: string;
  import_type: string;
  file_name: string;
  training?: ImportTraining | null;
  trainings?: ImportTraining[];
  status: string;
  total_rows: number;
  accepted_rows: number;
  rejected_rows: number;
  created_at: string;
  rows?: { row: number; record: string; status: string; errors: { field: string; message: string }[] }[];
  assessments_not_scheduled?: number;
  assignments_created?: number;
}

/** What accepted completion rows will do (preview) or did (after import). Rule failures are listed per row below. */
function importNotes(job: ImportJob): string {
  if (job.import_type !== "COMPLETIONS") return "";
  const done = job.status !== "READY";
  const parts = [];
  if (job.assignments_created) parts.push(`${rows(job.assignments_created, "row")} ${done ? "created" : "will create"} an assignment for an eligible employee`);
  if (job.assessments_not_scheduled) parts.push(`${rows(job.assessments_not_scheduled, "row")} ${done ? "had" : "will have"} completion recorded without a scheduled assessment, because the training's assessment is not ready. Fix the configuration, then use Schedule pending assessments in Training Management`);
  return parts.length ? ` ${parts.join(". ")}.` : "";
}

const rows = (n: number, noun = "row") => `${n} ${noun}${n === 1 ? "" : "s"}`;

const ROW_STATUS: Record<string, [string, string]> = {
  VALID: ["Valid", "success"],
  IMPORTED: ["Imported", "success"],
  DUPLICATE: ["Duplicate · skipped", "warning"],
  INVALID: ["Rejected", "danger"],
};

/** Where a question import's questions go: the selected training, or the trainings named in a file-based import. */
function ImportTrainingLinks({ job }: { job: ImportJob }) {
  const list = job.training ? [job.training] : (job.trainings ?? []);
  if (job.import_type !== "QUESTIONS" || !list.length) return null;
  return (
    <p className="import-training">
      {job.training ? "Linked training: " : "Linked trainings (from the file): "}
      {list.map((t, i) => (
        <span key={t.id}>
          {i ? "; " : ""}
          <strong>{t.title}</strong> ({t.code}){t.status === "DRAFT" ? " · Draft" : ""} ·{" "}
          <Link href={`/lnd/questions?training_id=${t.id}`}>Open in Question Bank</Link>
        </span>
      ))}
    </p>
  );
}

export function ImportCentre() {
  const [kind, setKind] = useState("QUESTIONS");
  const [trainingId, setTrainingId] = useState("");
  const trainings = useApi<TrainingAdmin[]>("/admin/trainings");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const recent = useApi<ImportJob[]>("/admin/imports");
  const [editing, setEditing] = useState<ImportJob | null>(null);
  const [deleting, setDeleting] = useState<ImportJob | null>(null);
  const toast = useToast();

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("import_type", kind);
    if (kind === "QUESTIONS" && !trainingId) {
      setError("Select the training these questions belong to.");
      return;
    }
    const sent = formSnapshot();
    setBusy(true);
    setError("");
    setJob(null);
    try {
      const validated = await api.upload<ImportJob>("/admin/imports", form);
      const current = formSnapshot();
      if (current.training !== sent.training || current.file !== sent.file) {
        // The type, training or file changed while validating: this preview no longer matches the form.
        void api.post(`/admin/imports/${validated.id}/cancel`).catch(() => {});
        return;
      }
      setJob(validated);
      void recent.reload();
    } catch (e) {
      setError(fieldErrors(e));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const done = await api.post<ImportJob>(`/admin/imports/${job.id}/commit`);
      setJob(done);
      toast(`${rows(done.accepted_rows)} imported; ${rows(done.rejected_rows)} rejected or skipped as duplicates.`);
      void recent.reload();
    } catch (e) {
      setError(fieldErrors(e));
    } finally {
      setBusy(false);
    }
  };
  const download = (path: string, name: string) => downloadFile(path, name).catch((e: ApiError) => toast(e.message));
  /** Shows an import's rows in the preview above, with the form set to match it. */
  const showJob = (full: ImportJob) => {
    setKind(full.import_type);
    setTrainingId(full.training?.id ?? "");
    setJob(full);
    setError("");
  };

  /** Drops a validated preview. One that was never imported is cancelled, so it cannot be imported later by mistake. */
  const discardPreview = () => {
    if (job?.status === "READY") void api.post(`/admin/imports/${job.id}/cancel`).then(recent.reload).catch(() => {});
    setJob(null);
    setError("");
  };
  const fileInput = () => document.querySelector<HTMLInputElement>("#import-form input[type=file]");
  /** What the form holds now. The training select exists only for question imports, so a type change shows here too. */
  const formSnapshot = () => ({ training: document.querySelector<HTMLSelectElement>("#import-form select[name=training_id]")?.value ?? null, file: fileInput()?.files?.[0] ?? null });
  const focusById = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus({ preventScroll: true });
  };

  const finished = Boolean(job && job.status !== "READY");
  const step = job ? (finished ? 2 : 1) : 0;
  const steps: { label: string; enabled: boolean; done: boolean; go: () => void }[] = [
    {
      label: "1 · Choose file",
      enabled: true,
      done: Boolean(job),
      go: () => {
        discardPreview();
        const input = fileInput();
        if (input) input.value = "";
        input?.focus();
      },
    },
    { label: "2 · Review validation", enabled: Boolean(job), done: finished, go: () => focusById("import-summary") },
    { label: "3 · Confirm import", enabled: finished || Boolean(job?.accepted_rows), done: finished, go: () => focusById(finished ? "import-summary" : "import-commit") },
  ];
  const importable = (trainings.data ?? []).filter((t) => t.status !== "ARCHIVED");
  const hint = !job
    ? kind === "QUESTIONS"
      ? "Choose the training and a file, then select Validate file. Nothing is saved until step 3."
      : "Choose the import type and a file, then select Validate file. Nothing is saved until step 3."
    : finished
      ? "Import finished. Select 1 · Choose file to import another file."
      : job.accepted_rows
        ? `Check the rows below, then select Import ${rows(job.accepted_rows, "valid row")} to save them.`
        : "No row can be imported. Download the error report, correct the file and validate it again.";

  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Import Centre" description="Preview and validate records before making changes." />
      <section className="panel import-panel">
        <ol className="import-steps" aria-label="Import steps">
          {steps.map((s, i) => (
            <li key={s.label} className={`${i === step ? "active" : ""}${s.done ? " done" : ""}`}>
              <button type="button" disabled={!s.enabled} aria-current={i === step ? "step" : undefined} onClick={s.go}>
                {s.done ? <span aria-hidden="true">✓ </span> : null}
                {s.label}
                {s.done ? <span className="sr-only"> (completed)</span> : null}
              </button>
            </li>
          ))}
        </ol>
        <p className="small import-hint" role="status">
          {hint}
        </p>
        <form
          id="import-form"
          onSubmit={(e) => void upload(e)}
          onChange={(e) => {
            if ((e.target as HTMLElement).getAttribute("type") === "file" && job) discardPreview();
          }}
        >
          <SelectField
            label="Import type"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (job) discardPreview();
            }}
            options={[{ value: "QUESTIONS", label: "Question bank" }, { value: "COMPLETIONS", label: "Training completions" }]}
          />
          {kind === "QUESTIONS" ? (
            <div className="import-training-select">
              <SelectField
                label="Select training *"
                name="training_id"
                required
                value={trainingId}
                placeholder={trainings.data ? "Choose a draft or active training" : "Loading trainings…"}
                onChange={(e) => {
                  setTrainingId(e.target.value);
                  if (job) discardPreview();
                }}
                options={importable.map((t) => ({ value: t.id, label: `${t.title} (${t.training_code})${t.status === "DRAFT" ? " · Draft" : ""}` }))}
              />
              <p className="small">All questions in this file will be linked to the selected training. The file&apos;s training column can be left blank; a code in it must match this training.</p>
              {trainings.data && !importable.length ? <p className="small form-error">No draft or active training exists. Create one in Training Management first.</p> : null}
              {trainings.error ? <p className="small form-error">Trainings could not be loaded. {trainings.error.message}</p> : null}
            </div>
          ) : null}
          <div
            className={`upload-zone${dragging ? " is-dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const input = e.currentTarget.querySelector<HTMLInputElement>("input[type=file]");
              if (input && e.dataTransfer.files.length) {
                // Setting files does not fire a change event, so the old preview is invalidated here.
                if (job) discardPreview();
                input.files = e.dataTransfer.files;
                toast("File selected. Choose Validate file to review its rows.");
              }
            }}
          >
            <Icon name="download" />
            <h2>Drop your question or attendance file here</h2>
            <p>Drag and drop a CSV/XLSX file, or select one below. Up to 5 MB and 5,000 rows.</p>
            <label className="field">
              Select CSV or Excel file
              <input type="file" name="file" accept=".csv,.xlsx" required />
            </label>
            <small>The first worksheet is read as plain values. Formulas, macros and external links are rejected.</small>
          </div>
          <div className="row wrap">
            <Btn tone="data" onClick={() => void download(`/admin/imports/templates/${kind}`, "template.csv")}>
              Download CSV template
            </Btn>
            <Btn tone="data" onClick={() => void download(`/admin/imports/templates/${kind}?format=xlsx`, "template.xlsx")}>
              Download Excel template
            </Btn>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Validating file…" : "Validate file"}
            </button>
          </div>
          <FormError message={error} />
        </form>
        {job ? (
          <div id="import-preview">
            <div className="notice" id="import-summary" tabIndex={-1}>
              {job.status === "READY" ? `${job.file_name} validated. ${job.accepted_rows} valid, ${job.rejected_rows} rejected or duplicate. Nothing has been imported yet.` : `Import finished. ${rows(job.accepted_rows)} imported, ${rows(job.rejected_rows)} rejected or skipped as duplicates.`}
              {importNotes(job)}
              <ImportTrainingLinks job={job} />
            </div>
            <DataTable
              headers={["Row", "Record", "Status", "Problem"]}
              rows={(job.rows ?? []).map((r) => {
                const [label, tone] = ROW_STATUS[r.status] ?? [r.status, "info"];
                return [
                  r.row,
                  r.record,
                  <span key="s" className={`badge ${tone}`} data-sort={label}>
                    {label}
                  </span>,
                  r.errors.map((e) => `${e.field}: ${e.message}`).join("; ") || "—",
                ];
              })}
            />
            <div className="row wrap">
              {job.rejected_rows ? (
                <Btn tone="data" onClick={() => void download(`/admin/imports/${job.id}/error-report`, "errors.csv")}>
                  Download error report
                </Btn>
              ) : null}
              {job.status === "READY" ? (
                <Btn kind="primary" id="import-commit" disabled={!job.accepted_rows || busy} onClick={() => void commit()}>
                  Import {rows(job.accepted_rows, "valid row")}
                </Btn>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
      <section className="panel">
        <h2>Recent imports</h2>
        <Loaded state={recent}>
          {(rows) => (
            <DataTable
              headers={["File", "Type", "Training", "Status", "Rows", "Accepted", "Rejected", "Uploaded (UTC)", ""]}
              emptyTitle="No imports yet."
              emptyHint="Validate a file above to begin."
              rows={rows.map((j) => [
                j.file_name,
                j.import_type === "QUESTIONS" ? "Question bank" : "Completions",
                j.training ? `${j.training.title} (${j.training.code})` : j.import_type === "QUESTIONS" ? "Named in file" : "—",
                j.status.replaceAll("_", " ").toLowerCase(),
                j.total_rows,
                j.accepted_rows,
                j.rejected_rows,
                dateTime(j.created_at),
                <div className="row wrap" key="a">
                  <Btn kind="text" onClick={() => void api.get<ImportJob>(`/admin/imports/${j.id}`).then(showJob).catch((e: ApiError) => toast(e.message))}>
                    View
                  </Btn>
                  {UNAPPLIED_IMPORT.includes(j.status) ? (
                    <>
                      <Btn kind="text" onClick={() => setEditing(j)}>
                        Edit
                      </Btn>
                      <Btn kind="text" tone="danger" onClick={() => setDeleting(j)}>
                        Delete
                      </Btn>
                    </>
                  ) : null}
                </div>,
              ])}
            />
          )}
        </Loaded>
      </section>
      {editing ? (
        <DialogForm
          title="Edit import"
          submitLabel="Validate file"
          onClose={() => setEditing(null)}
          onSubmit={async (form) => {
            const updated = await api.upload<ImportJob>(`/admin/imports/${editing.id}/replace`, form);
            showJob(updated);
            void recent.reload();
            toast(`${updated.file_name} validated. ${updated.accepted_rows} valid, ${updated.rejected_rows} rejected or duplicate. Nothing has been imported yet.`);
          }}
        >
          <p className="small">
            {editing.file_name} · {rows(editing.total_rows)}. Choose a corrected file{editing.import_type === "QUESTIONS" ? " and the training" : ""}. Its rows replace the current ones in this import and are validated again; nothing is imported until you confirm.
          </p>
          {editing.import_type === "QUESTIONS" ? (
            <SelectField
              label="Select training *"
              name="training_id"
              required
              defaultValue={editing.training?.id ?? ""}
              placeholder="Choose a draft or active training"
              options={importable.map((t) => ({ value: t.id, label: `${t.title} (${t.training_code})${t.status === "DRAFT" ? " · Draft" : ""}` }))}
            />
          ) : null}
          <label className="field">
            Select CSV or Excel file *
            <input type="file" name="file" accept=".csv,.xlsx" required />
          </label>
        </DialogForm>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete import?"
          danger
          confirmLabel="Delete import"
          body={<p>{deleting.file_name} · {rows(deleting.total_rows)}. This removes the import and its validation results. Nothing was imported from it, so no questions or completions are affected.</p>}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/admin/imports/${deleting.id}`);
            if (job?.id === deleting.id) setJob(null);
            toast("Import deleted.");
            void recent.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** Imports that never applied anything. Only these can be edited or deleted; completed imports are the record of what was added. */
const UNAPPLIED_IMPORT = ["READY", "CANCELLED", "FAILED"];

/* ---------- Assessment configuration ---------- */

/** Live question pool readiness inside the settings form. Counts come from the backend. */
function PoolPanel({ training, report, count, mix, check, reload, onUseEligible }: { training: TrainingAdmin; report: PoolReport; count: number | null; mix: Record<Difficulty, number> | null; check: PlanCheck; reload: () => void; onUseEligible: () => void }) {
  const exclusions = exclusionNotes(report);
  const bankHref = `/lnd/questions?training_id=${training.id}`;
  const actions = (
    <div className="row wrap">
      <a className="btn secondary" href={bankHref} target="_blank" rel="noopener noreferrer">
        <Icon name="file" /> Open Question Bank
      </a>
      <a className="btn secondary tone-data" href="/lnd/imports" target="_blank" rel="noopener noreferrer">
        <Icon name="upload" /> Import questions
      </a>
      {check.shortfall && report.eligible > 0 ? (
        <Btn tone="attention" onClick={onUseEligible}>
          Set questions per attempt to {report.eligible}
        </Btn>
      ) : null}
      <Btn kind="text" onClick={reload}>
        <Icon name="refresh" /> Refresh counts
      </Btn>
    </div>
  );
  return (
    <section className="tc-pool" aria-labelledby="pool-title" aria-live="polite">
      <h3 id="pool-title">Question pool</h3>
      {report.eligible === 0 ? (
        <div className="notice danger">
          <div>
            <strong>Configuration incomplete.</strong> {training.title} has no eligible active questions yet. Add questions in the Question Bank and link them to this training, or import them, then select Refresh counts.
          </div>
        </div>
      ) : check.shortfall && count ? (
        <div className="notice danger">
          <div>{shortfallSentence(training.title, report.eligible, count)}</div>
        </div>
      ) : check.ready ? (
        <div className="notice">
          <div>
            Ready. {training.title} has {report.eligible} eligible active questions; this assessment uses {count} per attempt.
          </div>
        </div>
      ) : null}
      <Metrics
        items={[
          ["Eligible questions", report.eligible, "Active, linked, with a correct answer and 2+ options"],
          ["Required questions", count ?? "—", "Questions per attempt"],
          ["Missing questions", check.shortfall, check.shortfall ? "Add these or reduce the count" : "None"],
        ]}
      />
      {exclusions.length ? <p className="small">Linked to this training but not counted: {exclusions.join("; ")}.</p> : null}
      {mix ? (
        <>
          <DataTable
            all
            headers={["Difficulty", "Available", "Required", "Status"]}
            rows={DIFFICULTIES.map((d) => {
              const gap = check.gaps.find((g) => g.difficulty === d);
              return [
                DIFFICULTY_LABEL[d],
                report.eligible_by_difficulty[d],
                mix[d] || 0,
                <span key="s" className={`badge ${gap ? "danger" : "success"}`}>
                  {gap ? `Short by ${gap.shortfall}` : "Enough"}
                </span>,
              ];
            })}
          />
          {check.mixMismatch ? (
            <p className="form-error" role="alert">
              The difficulty counts total {check.mixTotal}, but questions per attempt is {count ?? "not set"}. Make them equal.
            </p>
          ) : null}
        </>
      ) : null}
      {actions}
    </section>
  );
}

const mixFor = (count: number): Record<Difficulty, string> => {
  const easy = Math.round(count * 0.4);
  const medium = Math.round(count * 0.4);
  return { EASY: String(easy), MEDIUM: String(medium), HARD: String(Math.max(0, count - easy - medium)) };
};

function ConfigForm({ training, kind, onClose, onSaved }: { training: TrainingAdmin; kind: "POST_TEST" | "PRE_TEST"; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const current: ConfigView | null | undefined = kind === "POST_TEST" ? training.config : training.pre_test_config;
  const pool = useApi<PoolReport>(`/admin/trainings/${training.id}/question-pool`);
  const reloadPool = pool.reload;
  // Questions are often added in another tab (the Question Bank opens in one), so recount on return.
  useEffect(() => {
    const onFocus = () => void reloadPool();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadPool]);

  // An admin-configured count is kept as it is; a new form suggests min(10, eligible) from the backend.
  const [countInput, setCountInput] = useState<string | null>(current ? String(current.question_count) : null);
  const suggested = pool.data ? defaultQuestionsPerAttempt(null, pool.data.eligible) : null;
  const countText = countInput ?? (suggested === null ? "" : String(suggested));
  const count = countText === "" ? null : Number(countText);
  const [useMix, setUseMix] = useState(Boolean(current?.difficulty_mix));
  const [mixInput, setMixInput] = useState<Record<Difficulty, string>>(() => (current?.difficulty_mix ? { EASY: String(current.difficulty_mix.EASY ?? 0), MEDIUM: String(current.difficulty_mix.MEDIUM ?? 0), HARD: String(current.difficulty_mix.HARD ?? 0) } : mixFor(current?.question_count ?? 10)));
  const mix = useMix ? { EASY: Number(mixInput.EASY) || 0, MEDIUM: Number(mixInput.MEDIUM) || 0, HARD: Number(mixInput.HARD) || 0 } : null;
  const check = pool.data ? checkPlan(pool.data, count, mix) : null;
  const [mode, setMode] = useState(current?.schedule_mode ?? "NEXT_WORKING_DAY");
  const post = kind === "POST_TEST";

  const blocked = !pool.data ? null : pool.data.eligible === 0 ? "Add eligible questions to this training before saving." : !count ? "Enter the questions per attempt." : check && !check.ready ? "Fix the question pool problem shown above before saving." : null;

  return (
    <DialogForm
      title={`${post ? "Assessment" : "Pre-test"} settings · ${training.title}`}
      submitLabel="Save settings"
      wide
      submitBlockedReason={blocked}
      onClose={onClose}
      onSubmit={async (form) => {
        try {
          await api.post(`/admin/trainings/${training.id}/assessment-configs`, {
            assessment_type: kind,
            question_count: count,
            duration_minutes: Number(form.get("duration_minutes")),
            pass_mark_percent: Number(form.get("pass_mark_percent")),
            max_attempts: post ? Number(form.get("max_attempts")) : 1,
            schedule_mode: post ? form.get("schedule_mode") : "SAME_DAY",
            schedule_delay_days: post ? Number(form.get("schedule_delay_days") ?? 0) : 0,
            schedule_uses_working_days: form.has("schedule_uses_working_days"),
            schedule_date: post && mode === "FIXED_DATE" ? form.get("schedule_date") : null,
            difficulty_mix: mix,
            show_explanations: form.has("show_explanations"),
            shuffle_questions: form.has("shuffle_questions"),
            shuffle_options: form.has("shuffle_options"),
            violation_limit: post ? Number(form.get("violation_limit")) : 3,
            require_fullscreen: post ? form.has("require_fullscreen") : false,
          });
        } catch (e) {
          // The server is the authority. Its counts may be newer than ours, so refresh them; the form keeps every value.
          if (e instanceof ApiError && e.code === "QUESTION_POOL_INSUFFICIENT") void reloadPool();
          throw e;
        }
        toast("Settings saved for new attempts. Existing attempts keep their original settings.");
        onSaved();
      }}
    >
      <p>Changes create a new version and apply to new attempts. Submitted results never change.</p>
      {pool.error ? <ErrorPanel error={pool.error} retry={reloadPool} /> : pool.data && check ? <PoolPanel training={training} report={pool.data} count={count} mix={mix} check={check} reload={reloadPool} onUseEligible={() => setCountInput(String(pool.data!.eligible))} /> : <Loading label="Counting eligible questions…" />}
      <div className="form-grid">
        <TextField label="Questions per attempt *" name="question_count" type="number" required min={1} max={200} value={countText} onChange={(e) => setCountInput(e.target.value)} />
        <TextField label="Time limit (minutes) *" name="duration_minutes" type="number" required min={1} max={240} defaultValue={current?.duration_minutes ?? 15} />
        <TextField label="Pass mark (%) *" name="pass_mark_percent" type="number" required min={0} max={100} step="0.01" defaultValue={current?.pass_mark_percent ?? 70} />
        {post ? <TextField label="Maximum attempts *" name="max_attempts" type="number" required min={1} max={10} defaultValue={current?.max_attempts ?? 3} /> : null}
      </div>
      {current && pool.data && current.question_count > pool.data.eligible ? <p className="small">Your saved value of {current.question_count} is kept as entered. It is not reduced automatically.</p> : null}
      {post ? (
        <>
          <h3>Scheduling after completion</h3>
          <div className="form-grid">
            <SelectField label="When the assessment becomes due" name="schedule_mode" value={mode} onChange={(e) => setMode(e.target.value)} options={Object.entries(SCHEDULE_LABEL).map(([value, label]) => ({ value, label }))} />
            {mode === "DELAY_DAYS" ? <TextField label="Delay in days *" name="schedule_delay_days" type="number" required min={1} max={365} defaultValue={current?.schedule_delay_days || 7} /> : null}
            {mode === "FIXED_DATE" ? <TextField label="Assessment date *" name="schedule_date" type="date" required min={todayInput()} defaultValue={current?.schedule_date ?? ""} /> : null}
          </div>
          {mode === "FIXED_DATE" ? <p className="small">The assessment opens on this date for everyone whose completion is recorded by then. If completion is recorded after this date, the assessment is due straight away.</p> : null}
          {mode === "DELAY_DAYS" ? (
            <label className="checkline">
              <input type="checkbox" name="schedule_uses_working_days" defaultChecked={current?.schedule_uses_working_days} /> Count working days instead of calendar days
            </label>
          ) : null}
        </>
      ) : null}
      <h3>Difficulty mix</h3>
      <label className="checkline">
        <input
          type="checkbox"
          checked={useMix}
          onChange={(e) => {
            setUseMix(e.target.checked);
            if (e.target.checked && !current?.difficulty_mix && count) setMixInput(mixFor(count));
          }}
        />{" "}
        Use exact counts by difficulty
      </label>
      {useMix ? (
        <div className="form-grid">
          {DIFFICULTIES.map((d) => (
            <TextField key={d} label={`${DIFFICULTY_LABEL[d]} (${pool.data?.eligible_by_difficulty[d] ?? "…"} available)`} name={d.toLowerCase()} type="number" min={0} value={mixInput[d]} onChange={(e) => setMixInput((m) => ({ ...m, [d]: e.target.value }))} />
          ))}
        </div>
      ) : (
        <p className="small">Off: questions are drawn from the whole eligible pool regardless of difficulty.</p>
      )}
      <h3>Delivery</h3>
      <label className="checkline">
        <input type="checkbox" name="shuffle_questions" defaultChecked={current?.shuffle_questions ?? true} /> Randomise question order
      </label>
      <label className="checkline">
        <input type="checkbox" name="shuffle_options" defaultChecked={current?.shuffle_options ?? true} /> Randomise option order
      </label>
      <label className="checkline">
        <input type="checkbox" name="show_explanations" defaultChecked={current?.show_explanations} /> Show correct answers and explanations after submission
      </label>
      {post ? (
        <>
          <h3>Secure browser policy</h3>
          <label className="checkline">
            <input type="checkbox" name="require_fullscreen" defaultChecked={current?.require_fullscreen ?? true} /> Require full screen
          </label>
          <TextField label="Violations before automatic submission *" name="violation_limit" type="number" required min={1} max={10} defaultValue={current?.violation_limit ?? 3} />
          <div className="notice">Monitoring is browser-level and best-effort. A lost internet connection is never counted as a violation. The default policy awaits L&D, Security and HR approval.</div>
        </>
      ) : null}
    </DialogForm>
  );
}

export function AssessmentConfig() {
  const list = useApi<TrainingAdmin[]>("/admin/trainings");
  const [editing, setEditing] = useState<{ id: string; kind: "POST_TEST" | "PRE_TEST" } | null>(null);
  const detail = useApi<TrainingAdmin>(editing ? `/admin/trainings/${editing.id}` : null);
  const reloadList = list.reload;
  useEffect(() => {
    const onFocus = () => void reloadList();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadList]);
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Assessment Configuration" description="Control the learning check without changing historical attempts." />
      <section className="panel">
        <Loaded state={list}>
          {(rows) => (
            <DataTable
              headers={["Training", "Eligible Questions", "Readiness", "Pass Mark", "Questions", "Duration", "Attempts", "Schedule", "Actions"]}
              emptyTitle="No trainings yet."
              rows={rows.map((t) => [
                t.title,
                t.eligible_questions,
                <span key="r" className={`badge ${t.config_ready ? "success" : t.config ? "danger" : "info"}`}>
                  {t.config_ready ? "Ready" : t.config ? "Needs questions" : "Not configured"}
                </span>,
                t.config ? `${t.config.pass_mark_percent}%` : "Not configured",
                t.config?.question_count ?? "—",
                t.config ? `${t.config.duration_minutes} min` : "—",
                t.config?.max_attempts ?? "—",
                t.config ? (t.config.schedule_mode === "FIXED_DATE" && t.config.schedule_date ? `On ${day(t.config.schedule_date)}` : SCHEDULE_LABEL[t.config.schedule_mode]) : "—",
                <div className="row wrap" key="a">
                  <Btn onClick={() => setEditing({ id: t.id, kind: "POST_TEST" })}>Assessment Rules</Btn>
                  {t.pretest_enabled ? (
                    <Btn kind="text" onClick={() => setEditing({ id: t.id, kind: "PRE_TEST" })}>
                      Pre-test Rules
                    </Btn>
                  ) : null}
                </div>,
              ])}
            />
          )}
        </Loaded>
      </section>
      {editing && detail.data && detail.data.id === editing.id ? (
        <ConfigForm
          training={detail.data}
          kind={editing.kind}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void list.reload();
            void detail.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- Behaviour questionnaire templates ---------- */

interface Template {
  id: string;
  code: string;
  version: number;
  name: string;
  training_id: string | null;
  training_title: string | null;
  function_id: string | null;
  function_name: string | null;
  questions: { id: string; competency_id: string; competency: string; prompt: string; example_required: boolean }[];
}

function TemplateForm({ template, onClose, onSaved }: { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const c = useCatalogue();
  const trainings = useApi<TrainingAdmin[]>("/admin/trainings");
  const toast = useToast();
  const [rows, setRows] = useState(() => template?.questions.map((q) => ({ key: q.id, competency_id: q.competency_id, prompt: q.prompt, example_required: q.example_required })) ?? [{ key: "new-0", competency_id: "", prompt: "", example_required: true }]);
  const update = (key: string, patch: Partial<(typeof rows)[number]>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <DialogForm
      title={template ? "Edit questionnaire (creates a new version)" : "New behaviour questionnaire"}
      submitLabel="Save questionnaire"
      wide
      onClose={onClose}
      onSubmit={async (form) => {
        const body = {
          name: form.get("name"),
          training_id: form.get("training_id") || null,
          function_id: form.get("function_id") || null,
          questions: rows.map(({ competency_id, prompt, example_required }) => ({ competency_id, prompt, example_required })),
        };
        if (template) await api.patch(`/admin/behaviour-templates/${template.id}`, body);
        else await api.post("/admin/behaviour-templates", body);
        toast("Questionnaire saved. Follow-ups already created keep the version they started with.");
        onSaved();
      }}
    >
      <TextField label="Questionnaire name *" name="name" required maxLength={200} defaultValue={template?.name} />
      <div className="form-grid">
        <SelectField label="Training" name="training_id" placeholder="Any training" options={(trainings.data ?? []).map((t) => ({ value: t.id, label: t.title }))} defaultValue={template?.training_id ?? ""} />
        <SelectField label="Function" name="function_id" placeholder="Any function" options={names(c.functions.data ?? [])} defaultValue={template?.function_id ?? ""} />
      </div>
      <p className="small">The most specific match wins: training and function, then training, then function.</p>
      {rows.map((row, i) => (
        <fieldset className="competency-field" key={row.key}>
          <legend>Question {i + 1}</legend>
          <SelectField label="Competency *" required placeholder="Choose" value={row.competency_id} onChange={(e) => update(row.key, { competency_id: e.target.value })} options={names(c.competencies.data ?? [])} />
          <Field label="Behavioural question *">
            <textarea required minLength={5} maxLength={2000} value={row.prompt} onChange={(e) => update(row.key, { prompt: e.target.value })} />
          </Field>
          <label className="checkline">
            <input type="checkbox" checked={row.example_required} onChange={(e) => update(row.key, { example_required: e.target.checked })} /> A workplace example is required
          </label>
          {rows.length > 1 ? (
            <Btn kind="text" tone="danger" onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}>
              Remove question
            </Btn>
          ) : null}
        </fieldset>
      ))}
      <Btn onClick={() => setRows((list) => [...list, { key: `new-${Date.now()}`, competency_id: "", prompt: "", example_required: true }])}>
        <Icon name="plus" /> Add question
      </Btn>
    </DialogForm>
  );
}

export function BehaviourTemplates() {
  const state = useApi<Template[]>("/admin/behaviour-templates");
  const [form, setForm] = useState<{ template: Template | null } | null>(null);
  const [retiring, setRetiring] = useState<Template | null>(null);
  const toast = useToast();
  return (
    <>
      <PageTitle
        eyebrow={EYEBROW}
        title="Behaviour Questionnaire Management"
        description="Configure Level 3 questionnaires by training and function. Each question maps to a competency."
        action={
          <Btn kind="primary" onClick={() => setForm({ template: null })}>
            <Icon name="plus" /> New Questionnaire
          </Btn>
        }
      />
      <section className="panel">
        <Loaded state={state}>
          {(rows) =>
            rows.length ? (
              <DataTable
                headers={["Questionnaire", "Training", "Function", "Competencies", "Version", "Actions"]}
                rows={rows.map((t) => [
                  t.name,
                  t.training_title ?? "Any",
                  t.function_name ?? "Any",
                  t.questions.map((q) => q.competency).join(", "),
                  `v${t.version}`,
                  <div className="row wrap" key="a">
                    <Btn kind="text" onClick={() => setForm({ template: t })}>
                      Edit
                    </Btn>
                    <Btn kind="text" tone="danger" onClick={() => setRetiring(t)}>
                      Retire
                    </Btn>
                  </div>,
                ])}
              />
            ) : (
              <Empty title="No questionnaires yet." hint="Without one, behaviour evidence shows Not configured." />
            )
          }
        </Loaded>
      </section>
      {form ? <TemplateForm template={form.template} onClose={() => setForm(null)} onSaved={() => void state.reload()} /> : null}
      {retiring ? (
        <ConfirmDialog
          title="Retire this questionnaire?"
          danger
          confirmLabel="Retire"
          body={<p>{retiring.name}. It will not be used for new follow-ups. Existing follow-ups and answers are kept.</p>}
          onClose={() => setRetiring(null)}
          onConfirm={async () => {
            await api.del(`/admin/behaviour-templates/${retiring.id}`);
            toast("Questionnaire retired.");
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- Scorecards, reports and audit ---------- */

export const AdminScorecards = () => <ScorecardPage eyebrow={EYEBROW} />;

export function AdminReports() {
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Reports & Analytics" description="Select any report. Every export uses the same scope and filters." />
      <ReportsHub />
    </>
  );
}

export function AuditLogs() {
  const [action, setAction] = useState("");
  const state = useApi<{ id: string; created_at: string; actor: string; action: string; target_type: string | null; target_id: string | null; reason: string | null; before: unknown; after: unknown }[]>(`/admin/audit-logs${toQuery({ action })}`);
  const [detail, setDetail] = useState<{ action: string; reason: string | null; before: unknown; after: unknown } | null>(null);
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Audit Logs" description="Read-only history of administrative and security-relevant actions." />
      <section className="panel">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setAction(String(new FormData(e.currentTarget).get("action")));
          }}
        >
          <TextField label="Action contains" name="action" placeholder="For example ASSESSMENT or LOGIN" />
          <button className="btn secondary" type="submit">
            Apply filters
          </button>
        </form>
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Time (UTC)", "Actor", "Action", "Target", ""]}
              emptyTitle="No audit records match."
              rows={rows.map((a) => [
                dateTime(a.created_at),
                a.actor,
                a.action,
                a.target_type ?? "—",
                <Btn key="d" kind="text" onClick={() => setDetail(a)}>
                  Details
                </Btn>,
              ])}
            />
          )}
        </Loaded>
      </section>
      {detail ? (
        <Modal title={detail.action} onClose={() => setDetail(null)}>
          {detail.reason ? (
            <p>
              <strong>Reason:</strong> {detail.reason}
            </p>
          ) : null}
          <h3>Before</h3>
          <pre className="tc-audit-json">{detail.before ? JSON.stringify(detail.before, null, 2) : "Not recorded"}</pre>
          <h3>After</h3>
          <pre className="tc-audit-json">{detail.after ? JSON.stringify(detail.after, null, 2) : "Not recorded"}</pre>
        </Modal>
      ) : null}
    </>
  );
}

