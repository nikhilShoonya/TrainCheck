"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Badge, Btn, BtnLink, DataTable, Empty, ErrorPanel, Field, fieldErrors, FormError, Loaded, Loading, Metrics, PageTitle, SelectField, TextField, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { MonthlyTrend } from "@/features/dashboard/charts";
import { ActionItem, DepartmentBars, EvidenceHelp, EvidenceTiles, Glyph, GoodMorning, ImageMetrics, Panel, ScorecardCta, ScoreTag, ViewAll, Welcome } from "@/features/dashboard/widgets";
import { ReportsHub } from "@/features/reports/ReportView";
import { ScorecardPage } from "@/features/reports/ScorecardView";
import { completionCounts, filterEmployees, filterTrainings, isTrainingId, rowCounts, shortDescription, trainingCompletionHref, trainingsHref, type EnrolmentRow, type SchedulingOutcome } from "@/features/admin/completionView";
import { allShownSelected, filterPeople, toggleOne, toggleShown } from "@/features/admin/assignView";
import { canSelectCompletion } from "@/features/admin/bulkCompletion";
import { BulkCompletionDialog } from "@/features/admin/BulkCompletionDialog";
import { TrainingActionsMenu } from "@/features/admin/TrainingActionsMenu";
import { WaiveSelectedDialog } from "@/features/admin/WaiveSelectedDialog";
import { canWaiveAssessment, type WaiverEmployee } from "@/features/admin/waiver";
import { activeDepartments, assignmentCounts, assignmentsHref, confirmBlockedReason, createdMessage, departmentOptions, departmentShown, EMPLOYEE_COLUMNS, EMPLOYEE_FILE_TYPES, filterEmployeeList, findEmployee, isEmployeeId, isInactive, joiningShown, NO_TRAINING_ASSIGNED, PASSWORD_RULE, plural, previewSummary, rowProblems, STATUS_OPTIONS, type AddEmployeeMode, type EmployeeImportResult, type EmployeeListItem, type EmployeePreview } from "@/features/admin/employeeView";
import { acceptedFiles, commitSelection, fileTypesLabel, importFields, importSummary, needsRevalidation, selectionChanged, selectionProblem, templatePath, TEST_TYPE_HELP, TEST_TYPE_LABEL, TEST_TYPE_OPTIONS, testTypeLabel, type ImportCounts, type ImportSelection, type TestType } from "@/features/admin/importView";
import { QuestionDocIcon, QuestionSheetsArt } from "@/features/admin/QuestionCardArt";
import { contextTestTypes, importQuestionsHref, linkedTestType, questionBankHref, questionCardsHref, questionTableHref, testTypeFromSlug, type QuestionCard } from "@/features/admin/questionBankView";
import { ApiError, api, downloadFile, toQuery } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import { checkPlan, defaultQuestionsPerAttempt, describePool, DIFFICULTIES, DIFFICULTY_LABEL, exclusionNotes, shortfallSentence, type Difficulty, type PlanCheck, type PoolReport } from "@/lib/pool";
import type { ConfigView, Named, OrgUnit, Summary, TrainingAdmin, TrendPoint } from "@/lib/types";
import { dateTime, dateTimeIn, day, firstName, nowIn, ORG_TIMEZONE, percent, todayInOrg } from "@/lib/utils";
import Link from "next/link";

const EYEBROW = "L&D ADMIN";
const SCOPE_LABEL: Record<string, string> = { COMMON: "Common (all departments)", DEPARTMENT: "Department-specific", FUNCTION: "Function-specific", COMBINED: "Department and function" };
const TYPE_LABEL: Record<string, string> = { MCQ_SINGLE: "Single choice", MCQ_MULTIPLE: "Multiple choice", TRUE_FALSE: "True / False", SCENARIO: "Scenario" };
const SCHEDULE_LABEL: Record<string, string> = { SAME_DAY: "Same day", NEXT_WORKING_DAY: "Next working day", DELAY_DAYS: "After a delay", FIXED_DATE: "Custom date and time" };
/** The one behaviour follow-up: a self-assessment 30 days after training completion (no 60- or 90-day cycles). */
const FOLLOWUP_DAYS = 30;

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
            <Panel title={<>{user?.features?.behaviour ? "Learning & Behaviour" : "Learning"} <span className="heading-note">(Evidence)</span></>} action={<EvidenceHelp />}>
              <EvidenceTiles learning={d.summary.mean_latest_score} assessed={d.summary.assessed} behaviour={latest ?? null} behaviourEnabled={Boolean(user?.features?.behaviour)} />
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
          {user?.features?.behaviour ? (
            <ScorecardCta heading="Organisation Learning & Behaviour Scorecard" description="View learning gain and behaviour evidence for each training." href="/lnd/scorecards" label="View Scorecards" />
          ) : (
            // Level 3 Behaviour is switched off (outside the approved scope), so the scorecard is Learning only.
            <ScorecardCta heading="Organisation Learning Scorecard" description="View learning gain for each training." href="/lnd/scorecards" label="View Scorecards" />
          )}
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
      // There is one behaviour follow-up, 30 days after completion ([] = none). While Level 3 is switched off
      // the training keeps whether it has one.
      followup_days: (behaviourOn ? form.has("behaviour_enabled") : Boolean(training?.followup_days?.length)) ? [FOLLOWUP_DAYS] : [],
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
      <TextField label="Training code" name="training_code" value={training?.training_code ?? ""} placeholder="Generated automatically when saved" readOnly />
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
          <input type="checkbox" name="behaviour_enabled" defaultChecked={training?.behaviour_enabled ?? true} /> Schedule the {FOLLOWUP_DAYS}-day behaviour follow-up (Level 3)
        </label>
      ) : null}
      <div className="form-grid">
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
            {!t.config ? <div className="notice danger">{t.assessment_readiness.message} {t.assessment_readiness.action}</div> : t.pool_problem ? <div className="notice danger">The assessment cannot run yet. {describePool(t.pool_problem, t.title)}</div> : <div className="notice">The question pool satisfies this assessment ({t.eligible_questions} eligible post-test questions).</div>}
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
              headers={["Training code", "Training / Category", "Trainer", "Audience", "Status", "Assigned", "Completion", "Assessment", "Actions"]}
              emptyTitle="No trainings match."
              rows={rows.map((t) => [
                t.training_code,
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
                    {t.eligible_questions} eligible post-test · {t.config_ready ? "Ready" : t.config ? "Needs questions" : "Needs configuration"}
                  </small>
                  {t.pending_scheduling_count || t.unavailable_count ? (
                    <small className="form-error">
                      {t.pending_scheduling_count ? `${t.pending_scheduling_count} not scheduled` : ""}
                      {t.pending_scheduling_count && t.unavailable_count ? " · " : ""}
                      {t.unavailable_count ? `${t.unavailable_count} cannot start` : ""}
                    </small>
                  ) : null}
                </div>,
                <div className="training-row-actions" key="a">
                  <Btn kind="text" tone={t.status === "ACTIVE" ? "danger" : "success"} onClick={() => setStatus(t)}>
                    {t.status === "ACTIVE" ? "Archive" : "Activate"}
                  </Btn>
                  <TrainingActionsMenu title={t.title} onDetails={() => setDetail(t.id)} onEdit={() => setForm({ training: t })} onDelete={() => setRemoving(t)} />
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

function UnitTable({ title, path, label, showCode = true }: { title: string; path: string; label: string; showCode?: boolean }) {
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
            headers={[...(showCode ? ["Code"] : []), "Name", "Status", ""]}
            emptyTitle={`No ${title.toLowerCase()} yet.`}
            rows={rows.map((u) => [
              ...(showCode ? [u.code] : []),
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
            const body = { ...(showCode ? { code: form.get("code") } : {}), name: form.get("name"), is_active: form.has("is_active") };
            if (edit.unit) await api.patch(`${path}/${edit.unit.id}`, body);
            else await api.post(path, body);
            toast("Saved.");
            void state.reload();
          }}
        >
          {showCode ? <TextField label="Code *" name="code" required maxLength={40} defaultValue={edit.unit?.code} /> : null}
          <TextField label="Name *" name="name" required maxLength={120} defaultValue={edit.unit?.name} />
          <label className="checkline">
            <input type="checkbox" name="is_active" defaultChecked={edit.unit?.is_active ?? true} /> Active
          </label>
        </DialogForm>
      ) : null}
    </section>
  );
}

/** A small master-data list with an Add dialog. With `editFields`, each row also gets an Edit dialog (PATCH to
    `${path}/{id}`); the row's active status is sent back unchanged, and an emptied optional field is saved as blank. */
function SimpleList({ title, path, label, fields, editFields, columns, rowOf }: { title: string; path: string; label: string; fields: ReactNode; editFields?: (r: never) => ReactNode; columns: string[]; rowOf: (r: never) => ReactNode[] }) {
  const state = useApi<never[]>(path);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ row: never } | null>(null);
  const toast = useToast();
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{title}</h2>
        <Btn onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add {label}
        </Btn>
      </div>
      <Loaded state={state}>
        {(rows) => (
          <DataTable
            headers={editFields ? [...columns, ""] : columns}
            emptyTitle={`No ${title.toLowerCase()} yet.`}
            rows={rows.map((r) =>
              editFields
                ? [
                    ...rowOf(r),
                    <Btn key="e" kind="text" onClick={() => setEditing({ row: r })}>
                      Edit<span className="sr-only"> {(r as { name?: string }).name}</span>
                    </Btn>,
                  ]
                : rowOf(r),
            )}
          />
        )}
      </Loaded>
      {editing && editFields ? (
        <DialogForm
          title={`Edit ${label}`}
          submitLabel="Save"
          onClose={() => setEditing(null)}
          onSubmit={async (form) => {
            const row = editing.row as { id: string; is_active?: boolean };
            const values = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v).trim() || null]));
            await api.patch(`${path}/${row.id}`, { ...values, is_active: row.is_active ?? true });
            toast("Saved.");
            void state.reload();
          }}
        >
          {editFields(editing.row)}
        </DialogForm>
      ) : null}
      {adding ? (
        <DialogForm
          title={`Add ${label}`}
          submitLabel="Save"
          onClose={() => setAdding(false)}
          onSubmit={async (form) => {
            // As in Edit: a blank optional field is sent as missing (null), not as an empty string.
            await api.post(path, { ...Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v).trim() || null])), is_active: true });
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
      <UnitTable title="Functions" path="/admin/functions" label="function" showCode={false} />
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
        editFields={(t: { name: string; email: string | null }) => (
          <>
            <TextField label="Name *" name="name" required maxLength={160} defaultValue={t.name} />
            <TextField label="Email" name="email" type="email" maxLength={254} defaultValue={t.email ?? ""} />
          </>
        )}
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

/* ---------- Assignments and completion ---------- */

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
  const employees = useApi<{ id: string; full_name: string; employee_code: string; department: string | null; function: string | null; employment_status: string }[]>("/admin/employees");
  const [trainingId, setTrainingId] = useState("");
  const [useTarget, setUseTarget] = useState(false);
  const [filter, setFilter] = useState("");
  // Kept by ID, so a ticked employee stays selected when the search changes and hides them.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const list = trainings.data ?? [];
  const selected = trainingId || list[0]?.id || "";
  const training = list.find((t) => t.id === selected);
  // Inactive employees cannot receive new assignments, so they are not offered.
  const active = (employees.data ?? []).filter((p) => p.employment_status !== "INACTIVE");
  const shown = filterPeople(active, filter);
  const picked = active.filter((p) => chosen.has(p.id));
  const everyoneShown = allShownSelected(chosen, shown);
  return (
    <DialogForm
      title="Assign employees"
      submitLabel="Assign selected employees"
      wide
      submitBlockedReason={
        !trainings.data ? "Loading active trainings…" : !list.length ? "No active training can take assignments. Activate a training in Training Management first." : !useTarget && !picked.length ? "Select at least one employee." : null
      }
      onClose={onClose}
      onSubmit={async (form) => {
        const result = await api.post<AssignmentResult>("/admin/enrolments", { training_id: selected, employee_ids: useTarget ? [] : picked.map((p) => p.id), use_training_target: useTarget });
        onSaved(result);
      }}
    >
      <SelectField label="Training (active only) *" value={selected} onChange={(e) => setTrainingId(e.target.value)} placeholder={trainings.data ? undefined : "Loading trainings…"} options={list.map((t) => ({ value: t.id, label: t.title }))} />
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
          <div className="row wrap between">
            <Btn kind="text" disabled={!shown.length} onClick={() => setChosen((c) => toggleShown(c, shown))}>
              {everyoneShown ? "Clear" : "Select all"} {filter.trim() ? `${shown.length} matching` : `${shown.length}`}
            </Btn>
            <span className="small" role="status">
              {picked.length} selected
            </span>
          </div>
          <div className="checkbox-list">
            {shown.map((p) => (
              <label key={p.id}>
                <input type="checkbox" checked={chosen.has(p.id)} onChange={() => setChosen((c) => toggleOne(c, p.id))} /> {p.full_name} · {p.employee_code}
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

/* ---------- Add Employee: one by form, or many from a file ---------- */

function AddEmployeeDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<AddEmployeeMode | null>(null);
  if (mode === "single") return <NewEmployeeForm onBack={() => setMode(null)} onClose={onClose} />;
  if (mode === "bulk") return <BulkEmployees onBack={() => setMode(null)} onClose={onClose} />;
  return (
    <Modal title="Add employee" onClose={onClose}>
      <p>How would you like to add employees?</p>
      <div className="add-employee-choices" role="group" aria-label="How to add employees">
        <button type="button" className="add-employee-choice" onClick={() => setMode("single")}>
          <Icon name="person" />
          <strong>New Employee</strong>
          <span>Add one person with a short form.</span>
        </button>
        <button type="button" className="add-employee-choice" onClick={() => setMode("bulk")}>
          <Icon name="users" />
          <strong>Multiple Employees</strong>
          <span>Upload a CSV or Excel file, check the preview, then import.</span>
        </button>
      </div>
      <p className="small">{PASSWORD_RULE} Adding an employee does not assign any training.</p>
      <div className="dialog-actions">
        <Btn onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

function NewEmployeeForm({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const departments = useApi<OrgUnit[]>("/admin/departments");
  const choices = activeDepartments(departments.data);
  const toast = useToast();
  return (
    <DialogForm
      title="Add employee · New Employee"
      submitLabel="Add employee"
      onClose={onClose}
      submitBlockedReason={departments.error ? `Departments could not be loaded. ${departments.error.message}` : !departments.data ? "Loading departments…" : !choices.length ? "No active department exists. Add one in Departments & Functions first." : null}
      onSubmit={async (form) => {
        const result = await api.post<{ created: number; employee: { full_name: string; employee_code: string } }>("/admin/employees", {
          full_name: form.get("full_name"),
          employee_code: form.get("employee_code"),
          work_email: form.get("work_email"),
          joining_date: form.get("joining_date"),
          department_id: form.get("department_id"),
        });
        toast(`${result.employee.full_name} (${result.employee.employee_code}) added. They are now available in Assign Employees.`);
      }}
    >
      <Btn kind="text" onClick={onBack}>
        <Icon name="back" /> Choose another way
      </Btn>
      <TextField label="Full name *" name="full_name" required maxLength={160} autoComplete="off" />
      <div className="form-grid">
        <TextField label="Employee ID *" name="employee_code" required maxLength={40} autoComplete="off" />
        <TextField label="Work email *" name="work_email" type="email" required maxLength={254} autoComplete="off" />
      </div>
      <div className="form-grid">
        <TextField label="Joining date *" name="joining_date" type="date" required min="1900-01-01" max="2100-12-31" />
        <SelectField label="Department *" name="department_id" required placeholder={departments.data ? "Choose an active department" : "Loading departments…"} options={choices.map((d) => ({ value: d.id, label: `${d.name} (${d.code})` }))} />
      </div>
      <p className="small">{PASSWORD_RULE}</p>
    </DialogForm>
  );
}

function BulkEmployees({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<File | null>(null);
  const [preview, setPreview] = useState<EmployeePreview | null>(null);
  const [busy, setBusy] = useState<"validate" | "import" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<EmployeeImportResult | null>(null);
  const toast = useToast();
  const form = () => {
    const data = new FormData();
    if (file) data.set("file", file);
    return data;
  };
  const download = (format: "csv" | "xlsx") =>
    downloadFile(`/admin/employees/import/template${format === "xlsx" ? "?format=xlsx" : ""}`, `traincheck-employees-template.${format}`).catch((e: ApiError) => toast(e.message));
  const validate = async () => {
    if (!file) {
      setError("Choose a CSV or Excel file first.");
      return;
    }
    setBusy("validate");
    setError("");
    setPreview(null);
    try {
      setPreview(await api.upload<EmployeePreview>("/admin/employees/import/preview", form()));
      setChecked(file);
    } catch (e) {
      setError(fieldErrors(e));
    } finally {
      setBusy(null);
    }
  };
  const confirm = async () => {
    setBusy("import");
    setError("");
    try {
      const result = await api.upload<EmployeeImportResult>("/admin/employees/import", form());
      setDone(result);
      toast(createdMessage(result.created));
    } catch (e) {
      // Checked again on confirmation: show what changed (for example, someone added one of these employees meanwhile).
      if (e instanceof ApiError && e.code === "IMPORT_NOT_READY" && e.details) setPreview(e.details as EmployeePreview);
      setError(fieldErrors(e));
    } finally {
      setBusy(null);
    }
  };
  const blocked = confirmBlockedReason(preview, file !== checked);
  // Rows with problems first, so they are on the first page of the table; each keeps its file row number.
  const shown = preview ? [...preview.rows].sort((a, b) => Number(b.status === "INVALID") - Number(a.status === "INVALID")) : [];
  return (
    <Modal title="Add employees · Multiple Employees" onClose={onClose} wide>
      {done ? (
        <>
          <div className="notice" role="status">
            <strong>{createdMessage(done.created)}</strong> Imported from {done.file_name}. No training was assigned.
          </div>
          <DataTable all headers={["Employee ID", "Name"]} rows={done.employees.map((e) => [e.employee_code, e.full_name])} />
          <div className="dialog-actions">
            <Btn kind="primary" onClick={onClose}>
              Done
            </Btn>
          </div>
        </>
      ) : (
        <>
          <Btn kind="text" onClick={onBack} disabled={busy !== null}>
            <Icon name="back" /> Choose another way
          </Btn>
          <p className="small">
            Columns: {EMPLOYEE_COLUMNS.join(", ")}. Departments must already exist and be active (code or exact name). Dates of joining are read day first: 19 Nov 2026, 19/11/2026, 19-11-2026, 2026-11-19 or 19112026 (Excel date cells work too). Keep employee numbers as text so leading zeros stay.
          </p>
          <div className="row wrap">
            <Btn tone="data" onClick={() => void download("csv")}>
              Download CSV template
            </Btn>
            <Btn tone="data" onClick={() => void download("xlsx")}>
              Download Excel template
            </Btn>
          </div>
          <label className="field add-employee-file">
            Employee file (CSV or Excel) *
            <input
              type="file"
              name="file"
              accept={EMPLOYEE_FILE_TYPES}
              disabled={busy !== null}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setError("");
              }}
            />
          </label>
          <small className="small">Up to 5 MB. The first worksheet is read as plain values; formulas, macros and external links are rejected.</small>
          <div className="row wrap">
            <Btn kind="primary" onClick={() => void validate()} disabled={busy !== null || !file}>
              {busy === "validate" ? "Validating file…" : "Validate file"}
            </Btn>
          </div>
          <FormError message={error} />
          {preview ? (
            <div id="employee-preview">
              <Metrics
                items={[
                  ["Rows", preview.total_rows, "In the file"],
                  ["Ready", preview.valid_rows, "Passed validation"],
                  ["Need correcting", preview.invalid_rows, "Fix in the file"],
                ]}
              />
              <div className={`notice${preview.ready ? "" : " danger"}`} role="status">
                {previewSummary(preview)}
              </div>
              <DataTable
                headers={["Row", "Name", "Employee ID", "Email", "Joining date", "Department", "Status", "Problems"]}
                rows={shown.map((r) => [
                  r.row,
                  r.name || "—",
                  r.employee_code || "—",
                  r.email || "—",
                  joiningShown(r),
                  departmentShown(r),
                  <span key="s" className={`badge ${r.status === "VALID" ? "success" : "danger"}`} data-sort={r.status}>
                    {r.status === "VALID" ? "Ready" : "Needs correcting"}
                  </span>,
                  rowProblems(r),
                ])}
              />
            </div>
          ) : null}
          {blocked && preview ? (
            <p className="small" id="employee-confirm-blocked">
              {blocked}
            </p>
          ) : null}
          <div className="dialog-actions">
            <Btn onClick={onClose} disabled={busy === "import"}>
              Cancel
            </Btn>
            <Btn kind="primary" onClick={() => void confirm()} disabled={Boolean(blocked) || busy !== null} aria-describedby={blocked && preview ? "employee-confirm-blocked" : undefined}>
              {busy === "import" ? "Importing…" : preview?.ready && !blocked ? `Confirm Import (${plural(preview.total_rows, "employee")})` : "Confirm Import"}
            </Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

export function Assignments() {
  return (
    <Suspense fallback={<Loading />}>
      <AssignmentsInner />
    </Suspense>
  );
}

function AssignmentsInner() {
  // The address holds the page's state: ?search= (the employee search; also how the global search opens this page)
  // and ?employee=<id> (the selected employee, by ID only). Refresh, direct links and the browser's Back keep it.
  const params = useSearchParams();
  const selected = params.get("employee");
  const linkSearch = params.get("search") ?? "";
  const [search, setSearch] = useState(linkSearch);
  // Department and Status filters live only in the address (?department=, ?status=), so Back and refresh keep them.
  const filters = { department: params.get("department") ?? "", status: params.get("status") ?? "" };
  const employees = useApi<EmployeeListItem[]>("/admin/employees");
  const [assigning, setAssigning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<AssignmentResult | null>(null);
  // Where the list was scrolled when an employee was opened from it; null when the page opened on an employee.
  const listScroll = useRef<number | null>(null);

  // A new ?search= from a link (or the browser's Back) replaces the search box. Adjusted while rendering, as React
  // recommends for state that follows a changing value; typing keeps the address equal to the box, so it is untouched.
  const [seenLinkSearch, setSeenLinkSearch] = useState(linkSearch);
  if (linkSearch !== seenLinkSearch) {
    setSeenLinkSearch(linkSearch);
    if (search.trim() !== linkSearch.trim()) setSearch(linkSearch);
  }
  // Back on the list: return to where the person was. The list stays mounted, so its page and sort are kept.
  useEffect(() => {
    if (!selected && listScroll.current !== null) {
      window.scrollTo(0, listScroll.current);
      listScroll.current = null;
    }
  }, [selected]);

  const changeSearch = (value: string) => {
    setSearch(value);
    // Kept in the address without a new history entry, so Back and refresh return to the same search.
    window.history.replaceState(null, "", assignmentsHref({ search: value, ...filters }));
  };
  const changeFilter = (change: { department?: string; status?: string }) => window.history.replaceState(null, "", assignmentsHref({ search, ...filters, ...change }));
  const open = (id: string) => {
    listScroll.current = window.scrollY;
    window.history.pushState(null, "", assignmentsHref({ employee: id, search, ...filters }));
    window.scrollTo(0, 0);
  };
  const back = () => {
    // Opened from the list: step back to that entry. Opened from a link: go to the list with the same search.
    if (listScroll.current !== null) window.history.back();
    else window.history.pushState(null, "", assignmentsHref({ search, ...filters }));
  };

  return (
    <>
      <PageTitle
        eyebrow={EYEBROW}
        title="Employee Assignments"
        description="Training assignment and completion are independent records. Only active trainings and active employees in the audience can be assigned."
        action={
          <div className="page-actions">
            <Btn onClick={() => setAdding(true)}>
              <Icon name="plus" /> Add Employee
            </Btn>
            <Btn kind="primary" onClick={() => setAssigning(true)}>
              <Icon name="plus" /> Assign Employees
            </Btn>
          </div>
        }
      />
      {/* Hidden, not removed, while an employee is open, so Back to employees finds it exactly as it was left. */}
      <section className="panel" hidden={Boolean(selected)} aria-label="Employees">
        <div className="filters">
          <TextField label="Search" name="employee_search" type="search" placeholder="Employee name, ID or email" value={search} onChange={(e) => changeSearch(e.target.value)} />
          <SelectField label="Department" name="employee_department" placeholder="All departments" value={filters.department} onChange={(e) => changeFilter({ department: e.target.value })} options={departmentOptions(employees.data)} />
          <SelectField label="Status" name="employee_status" placeholder="All statuses" value={filters.status} onChange={(e) => changeFilter({ status: e.target.value })} options={STATUS_OPTIONS} />
          {search.trim() || filters.department || filters.status ? (
            <Btn
              onClick={() => {
                setSearch("");
                window.history.replaceState(null, "", assignmentsHref({}));
              }}
            >
              Clear filters
            </Btn>
          ) : null}
        </div>
        <Loaded state={employees}>
          {(list) => {
            const shown = filterEmployeeList(list, search, filters);
            const narrowed = Boolean(search.trim() || filters.department || filters.status);
            const ids = new Map<ReactNode[], string>();
            const rows = shown.map((p) => {
              const row: ReactNode[] = [
                <div key="n" data-sort={p.full_name}>
                  <Btn kind="text" className="employee-open" onClick={() => open(p.id)} aria-label={`Open ${p.full_name}'s trainings`}>
                    {p.full_name}
                  </Btn>
                  {isInactive(p) ? <span className="badge warning">Inactive</span> : null}
                </div>,
                p.employee_code,
                p.work_email,
                p.department ?? "Not recorded",
              ];
              ids.set(row, p.id);
              return row;
            });
            return (
              <>
                <p className="small" role="status">
                  {narrowed ? `${plural(shown.length, "employee")} of ${list.length.toLocaleString("en-IN")} match.` : `${plural(list.length, "employee")}.`} Select an employee to see their trainings.
                </p>
                <DataTable headers={["Name", "Employee ID", "Email", "Department"]} emptyTitle={narrowed ? "No employee matches this search and filters." : "No employees yet."} emptyHint={narrowed ? "Search by name, Employee ID or email, or clear the filters." : "Use Add Employee to add people."} rows={rows} onRowClick={(row) => open(ids.get(row)!)} />
              </>
            );
          }}
        </Loaded>
      </section>
      {selected ? <SelectedEmployee key={selected} id={selected} employees={employees} onBack={back} /> : null}
      {adding ? <AddEmployeeDialog onClose={() => setAdding(false)} /> : null}
      {assigning ? <AssignDialog onClose={() => setAssigning(false)} onSaved={(result) => setOutcome(result)} /> : null}
      {outcome ? <AssignmentOutcome result={outcome} onClose={() => setOutcome(null)} /> : null}
    </>
  );
}

/** One employee's details and assignments. Keyed by the employee ID, so switching people starts from a clean state
 *  and never shows the previous person's rows. Saved changes refresh it (and the list) through the shared cache. */
function SelectedEmployee({ id, employees, onBack }: { id: string; employees: { data: EmployeeListItem[] | null; error: ApiError | null; reload: () => Promise<void> }; onBack: () => void }) {
  const employee = findEmployee(employees.data, id);
  const state = useApi<EnrolmentRow[]>(employee ? `/admin/enrolments${toQuery({ employee_id: employee.id })}` : null);
  const [stage, setStage] = useState("");
  const [cancel, setCancel] = useState<EnrolmentRow | null>(null);
  const [retake, setRetake] = useState<EnrolmentRow | null>(null);
  const [retraining, setRetraining] = useState<EnrolmentRow | null>(null);
  const toast = useToast();
  const backButton = (
    <Btn onClick={onBack}>
      <Icon name="back" /> Back to employees
    </Btn>
  );
  if (!employee) {
    return (
      <section className="panel" aria-label="Selected employee">
        {backButton}
        {employees.error ? <ErrorPanel error={employees.error} retry={() => void employees.reload()} /> : !employees.data && isEmployeeId(id) ? <Loading label="Loading the employee…" /> : <Empty title="Employee not found." hint="This employee does not exist. Go back to the employees and choose one from the list." />}
      </section>
    );
  }
  const facts: [string, ReactNode][] = [
    ["Name", employee.full_name],
    ["Employee ID", employee.employee_code],
    ["Email", employee.work_email],
    ["Department", employee.department ?? "Not recorded"],
  ];
  return (
    <>
      <section className="panel" aria-label="Selected employee">
        {backButton}
        <h2 className="employee-heading">
          {employee.full_name} {isInactive(employee) ? <span className="badge warning">Inactive</span> : null}
        </h2>
        <div className="detail-grid">
          {facts.map(([label, value]) => (
            <div key={label}>
              <small>{label}</small>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="panel" aria-label={`${employee.full_name}'s trainings`}>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setStage(String(new FormData(e.currentTarget).get("stage") ?? ""));
          }}
        >
          <SelectField label="Stage" name="stage" placeholder="All assignments" options={[{ value: "pending", label: "Awaiting completion" }, { value: "completed", label: "Completed" }, { value: "approval", label: "Needs approval" }]} />
          <button className="btn secondary" type="submit">
            Apply filters
          </button>
        </form>
        <Loaded state={state}>
          {(all) => {
            const rows = stage === "pending" ? all.filter((e) => !e.completed_at) : stage === "completed" ? all.filter((e) => e.completed_at) : stage === "approval" ? all.filter(needsApproval) : all;
            const counts = assignmentCounts(all);
            return (
              <>
                <Metrics
                  items={[
                    ["Assigned", counts.assigned, "Live assignments"],
                    ["Awaiting completion", counts.pending, "Completion not yet recorded"],
                    ["Completed", counts.completed, "Completion recorded"],
                  ]}
                />
                {!all.length ? (
                  <Empty title={NO_TRAINING_ASSIGNED} hint="Use Assign Employees to assign a training." />
                ) : (
                  <DataTable
                    headers={["Employee", "Training / Batch", "Assigned", "Completion", "Assessment", "Attempts", "Re-trainings", "Result", ""]}
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
                      <div key="s" data-sort={e.assessment_state}>
                        {e.assessment_state}
                        {e.refresher_acknowledged_at ? <small>Refresher done {day(e.refresher_acknowledged_at)}</small> : null}
                      </div>,
                      e.max_attempts ? `${e.attempts_used} of ${e.max_attempts}` : "—",
                      e.retrainings,
                      resultOf(e),
                      <div className="row wrap" key="x">
                        {e.assessment_state === "Awaiting approval" && e.obligation_id ? (
                          <Btn kind="text" tone="attention" onClick={() => setRetake(e)}>
                            Approve re-attempt
                          </Btn>
                        ) : null}
                        {e.retraining_flag === "NEEDS_RETRAINING" && e.obligation_id ? (
                          <Btn kind="text" tone="attention" onClick={() => setRetraining(e)}>
                            Approve re-training
                          </Btn>
                        ) : null}
                        {e.completed_at ? null : (
                          <Btn kind="text" tone="danger" onClick={() => setCancel(e)}>
                            Cancel
                          </Btn>
                        )}
                      </div>,
                    ])}
                  />
                )}
              </>
            );
          }}
        </Loaded>
      </section>
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
      {retake ? (
        <ConfirmDialog
          title="Approve re-attempt?"
          confirmLabel="Approve re-attempt"
          body={
            <p>
              {retake.employee_name} · {retake.training_title}. Attempt {retake.attempts_used} of {retake.max_attempts} was not passed and the refresher is acknowledged. The next attempt opens for the employee now.
            </p>
          }
          onClose={() => setRetake(null)}
          onConfirm={async () => {
            await api.post(`/admin/obligations/${retake.obligation_id}/approve-retake`);
            toast("Re-attempt approved. The employee has been notified.");
            void state.reload();
          }}
        />
      ) : null}
      {retraining ? (
        <ConfirmDialog
          title="Approve re-training?"
          needsReason
          confirmLabel="Approve re-training"
          body={
            <p>
              {retraining.employee_name} · {retraining.training_title}. All {retraining.attempts_used} attempts were used. Approving opens a new assessment with fresh attempts. Earlier attempts and the failure record are kept.
            </p>
          }
          onClose={() => setRetraining(null)}
          onConfirm={async (reason) => {
            await api.post(`/admin/obligations/${retraining.obligation_id}/retraining-cycle`, { reason });
            toast("Re-training approved. The employee has been notified.");
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** Rows where L&D must decide: a re-attempt after the refresher, or re-training after the last failed attempt. */
const needsApproval = (e: EnrolmentRow) => e.assessment_state === "Awaiting approval" || e.retraining_flag === "NEEDS_RETRAINING";

const ATTENDANCE = ["PENDING", "PRESENT", "PARTIAL", "ABSENT", "EXCUSED"];
const today = () => todayInOrg();

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

/* Training Completion: training cards (/lnd/completion) → one training's assigned employees
   (/lnd/completion/[trainingId]). Card counts come from the one /admin/trainings request; the employee table is
   filtered by training on the server. Both searches are in the URL, so refresh, links and Back keep them. */

const completionDescription = (behaviour?: boolean) =>
  `Record attendance and completion. Only Present attendance counts as completion. Completion schedules the assessment when the training's configuration and question pool are ready${behaviour ? ", and the 30-day follow-up" : ""}.`;

const importAttendance = (
  <BtnLink href="/lnd/imports" tone="data">
    Import Attendance
  </BtnLink>
);

export function Completion() {
  return (
    <Suspense fallback={<Loading />}>
      <CompletionCards />
    </Suspense>
  );
}

function CompletionCards() {
  const [search, setSearch] = useState(useSearchParams().get("q") ?? "");
  const state = useApi<TrainingAdmin[]>("/admin/trainings");
  const changeSearch = (value: string) => {
    setSearch(value);
    // Replace, not push: typing is not navigation, so Back still leaves the page in one step. The native
    // History API (integrated with the Next.js router) updates the entry at once; router.replace would start a
    // navigation per keystroke, and opening a card mid-way could leave an older search in the history entry.
    window.history.replaceState(window.history.state, "", trainingsHref(value));
  };
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Training Completion" description="Choose a training to record its employees' attendance and completion. Training completion is separate from assessment results." action={importAttendance} />
      <form className="filters" role="search" aria-label="Trainings" onSubmit={(e) => e.preventDefault()}>
        <TextField label="Search trainings" name="q" type="search" placeholder="Training name" autoComplete="off" value={search} onChange={(e) => changeSearch(e.target.value)} />
      </form>
      <Loaded state={state}>
        {(all) => {
          const shown = filterTrainings(all, search);
          if (!all.length) return <Empty title="No trainings yet." hint="Create a training in Training Management, then assign employees to record their completion here." />;
          return (
            <>
              <p className="small" role="status" aria-live="polite">
                {search.trim() ? `${shown.length} of ${all.length} trainings match.` : `${all.length} trainings.`}
              </p>
              {shown.length ? (
                <section className="course-grid personal-courses completion-cards" aria-label="Trainings">
                  {shown.map((t, i) => {
                    const counts = completionCounts(t);
                    const attention = t.pending_scheduling_count + t.unavailable_count;
                    return (
                      <article className="panel course-card completion-card training-card" key={t.id} aria-labelledby={`completion-${t.id}`}>
                        <div className="training-card-head">
                          <Glyph index={i} />
                          <div className="training-card-title">
                            <Badge status={t.status} />
                            <h2 id={`completion-${t.id}`}>{t.title}</h2>
                            <p>{shortDescription(t.description) || "No description."}</p>
                          </div>
                        </div>
                        <h3 className="completion-counts-title">Training completion</h3>
                        <dl className="completion-counts">
                          <div>
                            <dt>Assigned</dt>
                            <dd>{counts.assigned}</dd>
                          </div>
                          <div className="recorded">
                            <dt>Completed</dt>
                            <dd>{counts.recorded}</dd>
                          </div>
                          <div>
                            <dt>Awaiting</dt>
                            <dd>{counts.awaiting}</dd>
                          </div>
                        </dl>
                        {counts.assigned ? (
                          <div className="training-card-progress">
                            <span>{counts.recorded} of {counts.assigned} completed</span>
                            <progress max={counts.assigned} value={counts.recorded} aria-label={`${counts.recorded} of ${counts.assigned} employees completed`} />
                          </div>
                        ) : null}
                        <small className="completion-note">Attendance-based. Assessment results are shown per employee.</small>
                        {attention ? (
                          <div className="course-next">
                            <strong>Assessment needs attention for {attention} employee(s)</strong>
                            <small>Open the training to see who is affected.</small>
                          </div>
                        ) : null}
                        <div className="row wrap training-card-foot">
                          <BtnLink href={trainingCompletionHref(t.id, search)} kind="primary">
                            View Employees<span className="sr-only"> for {t.title}</span> <Icon name="arrow" />
                          </BtnLink>
                        </div>
                      </article>
                    );
                  })}
                </section>
              ) : (
                <>
                  <Empty title={`No training name matches “${search.trim()}”.`} hint="Check the spelling, or clear the search to see every training." />
                  <div className="row">
                    <Btn onClick={() => changeSearch("")}>Clear search</Btn>
                  </div>
                </>
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}

export function TrainingCompletion() {
  return (
    <Suspense fallback={<Loading />}>
      <TrainingCompletionInner />
    </Suspense>
  );
}

function TrainingCompletionInner() {
  const { trainingId } = useParams<{ trainingId: string }>();
  const cardSearch = useSearchParams().get("q") ?? "";
  const valid = isTrainingId(trainingId);
  // The list is usually cached already (the cards page and sign-in prefetch it); it names the training and tells
  // an unknown ID apart from a training without employees. The employees load at the same time.
  const trainings = useApi<TrainingAdmin[]>(valid ? "/admin/trainings" : null);
  const training = valid ? trainings.data?.find((t) => t.id.toLowerCase() === trainingId.toLowerCase()) : undefined;
  const back = (
    <BtnLink href={trainingsHref(cardSearch)}>
      <Icon name="back" /> Back to Trainings
    </BtnLink>
  );
  const eyebrow = `${EYEBROW} · TRAINING COMPLETION`;
  if (!valid || (trainings.data && !training)) {
    return (
      <>
        <PageTitle eyebrow={eyebrow} title="Training not found" description="This training does not exist or was removed." action={back} />
        <Empty title="No training has this link." hint="Go back to the trainings and choose one from the list." />
      </>
    );
  }
  if (!trainings.data) {
    return (
      <>
        <PageTitle eyebrow={eyebrow} title="Training Completion" description={trainings.error ? "The training could not be loaded." : "Loading the training…"} action={back} />
        {trainings.error ? <ErrorPanel error={trainings.error} retry={() => void trainings.reload()} /> : <Loading />}
      </>
    );
  }
  return <TrainingEmployees key={training!.id} training={training!} eyebrow={eyebrow} back={back} />;
}

function TrainingEmployees({ training, eyebrow, back }: { training: TrainingAdmin; eyebrow: string; back: ReactNode }) {
  // Only this training's enrolments, filtered on the server.
  const state = useApi<EnrolmentRow[]>(`/admin/enrolments${toQuery({ training_id: training.id })}`);
  const { user } = useSession();
  const [search, setSearch] = useState("");
  const [completing, setCompleting] = useState<EnrolmentRow | null>(null);
  const [waiving, setWaiving] = useState<EnrolmentRow | null>(null);
  const [lastOutcome, setLastOutcome] = useState<SchedulingOutcome | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEmployees, setBulkEmployees] = useState<{ rows: EnrolmentRow[]; excludedCount: number } | null>(null);
  const [waiveEmployees, setWaiveEmployees] = useState<{ rows: EnrolmentRow[]; excludedCount: number } | null>(null);
  const [confirmedWaivers, setConfirmedWaivers] = useState<Record<string, string>>({});
  const [waiverErrors, setWaiverErrors] = useState<Record<string, string>>({});
  const [completionErrors, setCompletionErrors] = useState<Record<string, string>>({});
  const [confirmedCompletions, setConfirmedCompletions] = useState<Record<string, EnrolmentRow>>({});
  const toast = useToast();
  // An attendance change shows at once (and is what the completion dialog starts from), so nothing acts on
  // the attendance from before the change while it saves or while the list reloads (that takes seconds).
  // Kept only until the reloaded list, which already holds the change, replaces the list it was made on.
  const [updated, setUpdated] = useState<{ source: EnrolmentRow[] | null; rows: Record<string, EnrolmentRow> }>({ source: null, rows: {} });
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const latest = (e: EnrolmentRow) => {
    const current = updated.source === state.data ? (updated.rows[e.id] ?? e) : e;
    // Completion records cannot be undone. An older GET must not erase a confirmed save; use fresh
    // server fields again once the list includes that completion (including later assessment changes).
    const row = current.completed_at ? current : (confirmedCompletions[e.id] ?? current);
    // Keep an acknowledged waiver visible across older reads, without masking a later assessment cycle.
    return row.obligation_id && confirmedWaivers[e.id] === row.obligation_id ? { ...row, assessment_state: "Waived", assessment_issue: null } : row;
  };
  const rememberWaiver = (employee: WaiverEmployee) => {
    if (!employee.obligation_id) return;
    setConfirmedWaivers((saved) => ({ ...saved, [employee.id]: employee.obligation_id! }));
    setSelected((ids) => new Set([...ids].filter((id) => id !== employee.id)));
    setWaiverErrors((errors) => {
      const next = { ...errors };
      delete next[employee.id];
      return next;
    });
  };
  const rememberCompletion = (row: EnrolmentRow) => {
    setConfirmedCompletions((saved) => ({ ...saved, [row.id]: row }));
    setSelected((ids) => new Set([...ids].filter((id) => id !== row.id)));
    setCompletionErrors((errors) => {
      const next = { ...errors };
      delete next[row.id];
      return next;
    });
  };
  const remember = (row: EnrolmentRow) => setUpdated((u) => ({ source: state.data, rows: { ...(u.source === state.data ? u.rows : {}), [row.id]: row } }));
  const setAttendance = async (e: EnrolmentRow, status: string) => {
    setSelected((ids) => new Set([...ids].filter((id) => id !== e.id)));
    remember({ ...e, attendance_status: status });
    setSaving((s) => ({ ...s, [e.id]: true }));
    try {
      remember(await api.patch<EnrolmentRow>(`/admin/enrolments/${e.id}/attendance`, { attendance_status: status }));
      void state.reload();
    } catch (error) {
      remember(e); // Refused: show the attendance the server kept.
      toast((error as ApiError).message);
    } finally {
      setSaving((s) => ({ ...s, [e.id]: false }));
    }
  };
  return (
    <>
      <PageTitle
        eyebrow={eyebrow}
        title={training.title}
        description={completionDescription(user?.features?.behaviour)}
        action={
          <div className="row wrap">
            {back}
            {importAttendance}
          </div>
        }
      />
      {lastOutcome && lastOutcome.status === "NOT_SCHEDULED" ? (
        <div className="notice danger" role="alert">
          <div>
            <strong>Assessment not scheduled.</strong> {lastOutcome.message} {lastOutcome.action}
          </div>
        </div>
      ) : null}
      {state.data ? <SchedulingAttention rows={state.data.map(latest)} onChanged={() => void state.reload()} /> : null}
      <section className="panel">
        <Loaded state={state}>
          {(all) => {
            if (!all.length)
              return (
                <>
                  <Empty title="No employees are assigned to this training." hint="Assign employees in Employee Assignments. They appear here to record attendance and completion." />
                  <div className="row">
                    <BtnLink href="/lnd/assignments">Go to Employee Assignments</BtnLink>
                  </div>
                </>
              );
            const counts = rowCounts(all.map(latest));
            const rows = filterEmployees(all.map(latest), search);
            // Selection follows the individual action; the completion API validates training status on confirmation.
            const selectable = rows.filter((e) => (canSelectCompletion(e) || canWaiveAssessment(e)) && !saving[e.id]);
            const selectableIds = new Set(selectable.map((e) => e.id));
            const selectedRows = selectable.filter((e) => selected.has(e.id));
            const completionRows = selectedRows.filter(canSelectCompletion);
            const waiverRows = selectedRows.filter(canWaiveAssessment);
            const allSelected = selectable.length > 0 && selectable.every((e) => selected.has(e.id));
            return (
              <>
                <Metrics
                  items={[
                    ["Assigned employees", counts.assigned, "Live assignments for this training"],
                    ["Completion recorded", counts.recorded, "Training completion, not assessment"],
                    ["Completion awaiting", counts.awaiting, "Attendance not yet recorded as complete"],
                  ]}
                />
                <form className="filters" role="search" aria-label="Employees" onSubmit={(e) => e.preventDefault()}>
                  <TextField label="Search employees" name="employee_search" type="search" placeholder="Name or employee code" autoComplete="off" value={search} onChange={(e) => { setSearch(e.target.value); setSelected(new Set()); }} />
                </form>
                <p className="small" role="status" aria-live="polite">
                  {search.trim() ? `${rows.length} of ${all.length} employees match.` : `${all.length} employees assigned.`}
                </p>
                <div className="row wrap completion-bulk-actions" role="group" aria-label="Completion actions">
                  <Btn disabled={!selectable.length || allSelected} onClick={() => setSelected(new Set(selectable.map((e) => e.id)))}>Select All</Btn>
                  <Btn disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</Btn>
                  <span role="status" aria-live="polite">{selectedRows.length} {selectedRows.length === 1 ? "employee" : "employees"} selected</span>
                  <Btn tone="success" disabled={!completionRows.length} onClick={() => setBulkEmployees({ rows: completionRows, excludedCount: selectedRows.length - completionRows.length })}>Mark Selected Completed</Btn>
                  <Btn disabled={!waiverRows.length} onClick={() => setWaiveEmployees({ rows: waiverRows, excludedCount: selectedRows.length - waiverRows.length })}>Waive Selected</Btn>
                </div>
                <p className="small">Select All includes matching employees eligible for completion or an assessment waiver across all table pages. Each action applies to eligible selected employees. Changing the search clears selection.</p>
                {rows.length ? (
                  <DataTable
                    headers={["Employee", "Attendance", "Completion", "Assessment Due", "Assessment", "Result", ""]}
                    emptyTitle="No assignments yet."
                    rows={rows.map((e) => [
                      <div key="p" data-sort={e.employee_name}>
                        <label className="completion-select">
                          <input type="checkbox" aria-label={`Select ${e.employee_name} (${e.employee_code})`} checked={selectableIds.has(e.id) && selected.has(e.id)} disabled={!selectableIds.has(e.id)} onChange={() => setSelected((ids) => toggleOne(ids, e.id))} />
                          <span>{e.employee_name}<small>{e.employee_code}</small></span>
                        </label>
                      </div>,
                      <select key="a" aria-label={`Attendance for ${e.employee_name} (${e.employee_code})`} value={e.attendance_status} onChange={(ev) => void setAttendance(e, ev.target.value)}>
                        {ATTENDANCE.map((a) => (
                          <option key={a} value={a}>
                            {a.charAt(0) + a.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </select>,
                      <div key="c" data-sort={e.completed_at ?? ""}>
                        <span className={`badge ${e.completed_at ? "success" : "warning"}`}>{e.completed_at ? "Completed" : "Awaiting completion"}</span>
                        {e.completed_at ? <small>{day(e.completed_at)} ({e.completion_source === "IMPORT" ? "import" : "manual"})</small> : null}
                        {completionErrors[e.id] && !e.completed_at ? <small className="form-error" role="alert">{completionErrors[e.id]}</small> : null}
                      </div>,
                      day(e.due_at, e.completed_at ? "Not scheduled" : "After completion"),
                      <div key="s" data-sort={e.assessment_state}>
                        {e.assessment_state === "Waived" ? <span className="badge info">Waived</span> : e.assessment_state}
                        {e.assessment_issue ? <small className="form-error">{e.assessment_issue.code === "UNAVAILABLE" ? "Cannot start: question pool" : "No assessment scheduled"}</small> : null}
                        {waiverErrors[e.id] && e.assessment_state !== "Waived" ? <small className="form-error" role="alert">{waiverErrors[e.id]}</small> : null}
                      </div>,
                      resultOf(e),
                      <div className="row wrap" key="x">
                        {e.completed_at ? null : (
                          <Btn tone="success" disabled={saving[e.id]} onClick={() => setCompleting(e)}>
                            Mark Completed<span className="sr-only"> for {e.employee_name}</span>
                          </Btn>
                        )}
                        {canWaiveAssessment(e) ? (
                          <Btn kind="text" onClick={() => setWaiving(e)}>
                            Waive<span className="sr-only"> assessment for {e.employee_name}</span>
                          </Btn>
                        ) : null}
                      </div>,
                    ])}
                  />
                ) : (
                  <>
                    <Empty title={`No assigned employee matches “${search.trim()}”.`} hint="Search by employee name or employee code, or clear the search." />
                    <div className="row">
                      <Btn onClick={() => setSearch("")}>Clear search</Btn>
                    </div>
                  </>
                )}
              </>
            );
          }}
        </Loaded>
      </section>
      {bulkEmployees ? (
        <BulkCompletionDialog
          trainingTitle={training.title}
          employees={bulkEmployees.rows}
          excludedCount={bulkEmployees.excludedCount}
          onClose={() => setBulkEmployees(null)}
          onRecorded={rememberCompletion}
          onFinished={(results) => {
            setCompletionErrors((errors) => {
              const next = { ...errors };
              for (const result of results) {
                if (result.status === "FAILED" || result.status === "NOT_ATTEMPTED") next[result.employee.id] = result.message;
                else delete next[result.employee.id];
              }
              return next;
            });
            setBulkEmployees(null);
            const finished = new Set(results.filter((result) => result.status === "COMPLETED" || result.status === "ALREADY_COMPLETED").map((result) => result.employee.id));
            setSelected((ids) => new Set([...ids].filter((id) => !finished.has(id))));
            const recorded = results.filter((result) => result.status === "COMPLETED").length;
            const failed = results.filter((result) => result.status === "FAILED" || result.status === "NOT_ATTEMPTED").length;
            toast(`${recorded} completions recorded.${failed ? ` ${failed} not confirmed; check the employee rows.` : ""}`);
            void state.reload();
          }}
        />
      ) : null}
      {waiveEmployees ? (
        <WaiveSelectedDialog
          employees={waiveEmployees.rows}
          excludedCount={waiveEmployees.excludedCount}
          onClose={() => setWaiveEmployees(null)}
          onWaived={rememberWaiver}
          onFinished={(results) => {
            setWaiverErrors((errors) => {
              const next = { ...errors };
              for (const result of results) {
                if (result.status === "WAIVED") delete next[result.employee.id];
                else next[result.employee.id] = result.message;
              }
              return next;
            });
            setWaiveEmployees(null);
            const waived = results.filter((result) => result.status === "WAIVED").length;
            const failed = results.length - waived;
            toast(`${waived} assessments waived.${failed ? ` ${failed} not confirmed; check the employee rows.` : ""}`);
            void state.reload();
          }}
        />
      ) : null}
      {completing ? (
        <DialogForm
          title="Record training completion"
          submitLabel="Record completion"
          onClose={() => setCompleting(null)}
          onSubmit={async (form) => {
            const done = await api.post<EnrolmentRow & { assessment_scheduling: SchedulingOutcome }>(`/admin/enrolments/${completing.id}/completion`, { completion_date: form.get("completion_date"), attendance_status: form.get("attendance_status") });
            rememberCompletion(done);
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
            rememberWaiver(waiving);
            toast("Assessment waived.");
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
  /** test_type: the test of that training that may use the question; null is an unclassified link (both tests). */
  trainings: { id: string; title: string; code: string; test_type?: string | null }[];
  explanation?: string | null;
  options?: { id: string; text: string; is_correct: boolean }[];
}

function QuestionForm({ question, onClose, onSaved, defaultTrainingId, context }: { question: QuestionRow | null; onClose: () => void; onSaved: () => void; defaultTrainingId?: string; context?: { trainingId: string; testType: TestType; title: string } }) {
  // Added from a training's pre-test or post-test table: that training starts ticked and its link is for that test.
  const startTrainingId = context?.trainingId ?? defaultTrainingId;
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
          // New questions only: edits never change an existing link's test type.
          ...(question ? {} : { training_test_types: contextTestTypes(context, form.getAll("training_ids").map(String)) }),
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
        {context && !question ? <p className="small">While ticked, {context.title} uses this question for its {TEST_TYPE_LABEL[context.testType].toLowerCase()} only. Other trainings ticked here can use it for both of their tests.</p> : null}
        <div className="checkbox-list">
          {(trainings.data ?? []).map((t) => (
            <label key={t.id}>
              <input type="checkbox" name="training_ids" value={t.id} defaultChecked={question ? question.trainings.some((x) => x.id === t.id) : t.id === startTrainingId} /> {t.title}
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
      <QuestionCards />
    </Suspense>
  );
}

/** Opening the Question Bank: one card per training and test, each opening that test's question table. */
function QuestionCards() {
  const params = useSearchParams();
  // An older link (/lnd/questions?training_id=…) names a training but no test: the search starts as that
  // training's name once the cards are known (null until the user types).
  const linkedTraining = params.get("training_id");
  const [typed, setTyped] = useState<string | null>(null);
  const state = useApi<QuestionCard[]>("/admin/questions/summary");
  const linkedTitle = linkedTraining ? state.data?.find((c) => c.training_id === linkedTraining)?.title : undefined;
  const search = typed ?? (linkedTraining ? linkedTitle : params.get("q")) ?? "";
  const changeSearch = (value: string) => {
    setTyped(value);
    // Replace, not push: typing is not navigation (as on the Training Completion cards).
    window.history.replaceState(window.history.state, "", questionCardsHref(value));
  };
  useEffect(() => {
    // Rewrites the older link as the cards' own link, so refresh and Back to Trainings keep the same search.
    if (linkedTraining && typed === null && state.data) window.history.replaceState(window.history.state, "", questionCardsHref(linkedTitle ?? ""));
  }, [linkedTraining, linkedTitle, typed, state.data]);
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Question Bank" description="Choose a training and test to search, preview and maintain the reusable questions that verify learning." />
      <form className="filters" role="search" aria-label="Trainings" onSubmit={(e) => e.preventDefault()}>
        <TextField label="Search trainings" name="q" type="search" placeholder="Training name" autoComplete="off" value={search} onChange={(e) => changeSearch(e.target.value)} />
      </form>
      <Loaded state={state}>
        {(all) => {
          // Also ignore zero-count entries in an older cached summary while the API refreshes.
          const linked = all.filter((card) => card.question_count > 0);
          const shown = filterTrainings(linked, search);
          if (!linked.length) return (
            <Empty title="No questions linked yet." hint="Import questions and choose their training and test type. A card appears once questions are linked." />
          );
          return (
            <>
              <p className="small" role="status" aria-live="polite">
                {search.trim() ? `${new Set(shown.map((c) => c.training_id)).size} of ${plural(new Set(linked.map((c) => c.training_id)).size, "training")} match.` : `${plural(new Set(linked.map((c) => c.training_id)).size, "training")}.`}
              </p>
              {shown.length ? (
                <section className="question-cards" aria-label="Trainings and tests">
                  {shown.map((card) => {
                    const label = TEST_TYPE_LABEL[card.test_type];
                    const pre = card.test_type === "PRE_TEST";
                    const id = `questions-${card.training_id}-${card.test_type}`;
                    return (
                      <article className={`question-card ${pre ? "is-pre" : "is-post"}`} key={`${card.training_id}-${card.test_type}`} aria-labelledby={id}>
                        <div className="question-card-head">
                          <span className="question-card-icon">
                            <QuestionDocIcon />
                          </span>
                          <h2 id={id}>{card.title}</h2>
                          <span className="question-card-pill">{label}</span>
                        </div>
                        <div className="question-card-body">
                          <div>
                            <p className="question-card-count">
                              <strong>{card.question_count}</strong> {card.question_count === 1 ? "Question" : "Questions"}
                            </p>
                            <small>{pre ? "Before training" : "After training"}</small>
                          </div>
                          <QuestionSheetsArt />
                        </div>
                        <div className="question-card-foot">
                          <BtnLink href={questionTableHref(card.training_id, card.test_type, search)} kind="primary">
                            View Questions<span className="sr-only"> for {card.title} {label}</span> <Icon name="arrow" />
                          </BtnLink>
                          <span className="question-card-tag">Question Bank</span>
                        </div>
                      </article>
                    );
                  })}
                </section>
              ) : (
                <>
                  <Empty title={`No question sets match “${search.trim()}”.`} hint="Only trainings with linked questions are listed. Check the spelling, or clear the search." />
                  <div className="row">
                    <Btn onClick={() => changeSearch("")}>Clear search</Btn>
                  </div>
                </>
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}

export function QuestionBankTraining() {
  return (
    <Suspense fallback={<Loading />}>
      <QuestionBankTrainingInner />
    </Suspense>
  );
}

/** /lnd/questions/[trainingId]/[pre-test|post-test]: the training and test come from the URL, so refresh, direct
    links and Back/Forward keep them. */
function QuestionBankTrainingInner() {
  const { trainingId, test } = useParams<{ trainingId: string; test: string }>();
  const cardSearch = useSearchParams().get("q") ?? "";
  const testType = testTypeFromSlug(test);
  const valid = isTrainingId(trainingId) && testType !== null;
  const trainings = useApi<TrainingAdmin[]>(valid ? "/admin/trainings" : null);
  const training = valid ? trainings.data?.find((t) => t.id.toLowerCase() === trainingId.toLowerCase()) : undefined;
  const back = (
    <BtnLink href={questionCardsHref(cardSearch)}>
      <Icon name="back" /> Back to Trainings
    </BtnLink>
  );
  const eyebrow = `${EYEBROW} · QUESTION BANK`;
  if (!valid || (trainings.data && !training)) {
    return (
      <>
        <PageTitle eyebrow={eyebrow} title="Training not found" description="This training or test does not exist or was removed." action={back} />
        <Empty title="No training test has this link." hint="Go back to the trainings and choose a training and test from the list." />
      </>
    );
  }
  if (!trainings.data) {
    return (
      <>
        <PageTitle eyebrow={eyebrow} title="Question Bank" description={trainings.error ? "The training could not be loaded." : "Loading the training…"} action={back} />
        {trainings.error ? <ErrorPanel error={trainings.error} retry={() => void trainings.reload()} /> : <Loading />}
      </>
    );
  }
  return <QuestionBankInner key={`${training!.id}-${testType}`} training={training!} testType={testType!} trainings={trainings} eyebrow={eyebrow} back={back} />;
}

/** The question table, restricted on the server to one training's pre-test or post-test. Every filter narrows
    within that selection; the training and test cannot be removed. */
function QuestionBankInner({ training, testType, trainings, eyebrow, back }: { training: TrainingAdmin; testType: TestType; trainings: { data: TrainingAdmin[] | null }; eyebrow: string; back: ReactNode }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const state = useApi<QuestionRow[]>(`/admin/questions${toQuery({ ...filters, training_id: training.id, test_type: testType })}`);
  const c = useCatalogue();
  const [form, setForm] = useState<{ question: QuestionRow | null } | null>(null);
  const [preview, setPreview] = useState<QuestionRow | null>(null);
  const [toggling, setToggling] = useState<QuestionRow | null>(null);
  const toast = useToast();
  const load = async (id: string) => api.get<QuestionRow>(`/admin/questions/${id}`);
  const testLabel = TEST_TYPE_LABEL[testType];
  return (
    <>
      <PageTitle
        eyebrow={eyebrow}
        title={training.title}
        description={
          <>
            Test type: <strong>{testLabel}</strong>. Only the questions this training&apos;s {testLabel.toLowerCase()} can use are listed, including questions not yet classified (used by both tests).
          </>
        }
        action={
          <div className="row wrap">
            {back}
            <Btn kind="primary" onClick={() => setForm({ question: null })}>
              <Icon name="plus" /> Add Question
            </Btn>
          </div>
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
          {/* Locked to the training this table belongs to (the server filters by it on every request). */}
          <SelectField key={trainings.data ? "loaded" : "loading"} label="Training" name="training_id" options={[{ value: training.id, label: training.title }]} value={training.id} disabled title="This table shows one training. Use Back to Trainings to choose another." onChange={() => {}} />
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
          <BtnLink href={importQuestionsHref(training.id, testType)} kind="text" tone="data">
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
                  {q.trainings.map((t) => `${t.title} (${t.test_type ? TEST_TYPE_LABEL[t.test_type] : "both tests"})`).join(", ") || "Not linked"}
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
      {form ? <QuestionForm question={form.question} context={{ trainingId: training.id, testType, title: training.title }} onClose={() => setForm(null)} onSaved={() => void state.reload()} /> : null}
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
  /** PRE_TEST or POST_TEST for question imports; null for completions and for question imports made before test types. */
  test_type?: string | null;
  status: string;
  total_rows: number;
  accepted_rows: number;
  rejected_rows: number;
  created_at: string;
  rows?: { row: number; record: string; status: string; errors: { field: string; message: string }[] }[];
  assessments_not_scheduled?: number;
  assignments_created?: number;
  /** Rows by outcome: VALID (preview), IMPORTED, DUPLICATE, CONFLICT, INVALID. Present when the rows are loaded. */
  counts?: ImportCounts;
  /** A question preview validated with the old template: it must be validated again. */
  needs_revalidation?: boolean;
  /** Imported questions are Easy: set when the selected test's difficulty mix needs Medium or Hard questions it lacks. */
  difficulty_notice?: string | null;
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
  CONFLICT: ["Conflict · needs review", "danger"],
  INVALID: ["Rejected", "danger"],
};

/** Where a question import's questions go: the selected training and test type (older imports: the trainings named in the file). */
function ImportTrainingLinks({ job }: { job: ImportJob }) {
  const list = job.training ? [job.training] : (job.trainings ?? []);
  if (job.import_type !== "QUESTIONS") return null;
  return (
    <>
      {list.length ? (
        <p className="import-training">
          {job.training ? "Linked training: " : "Linked trainings (from the file): "}
          {list.map((t, i) => (
            <span key={t.id}>
              {i ? "; " : ""}
              <strong>{t.title}</strong> ({t.code}){t.status === "DRAFT" ? " · Draft" : ""} ·{" "}
              <Link href={questionBankHref(t, job.test_type)}>Open in Question Bank</Link>
            </span>
          ))}
        </p>
      ) : null}
      <p className="import-training">
        Test type: <strong>{testTypeLabel(job)}</strong>
        {job.test_type
          ? ` · used only for this training's ${TEST_TYPE_LABEL[job.test_type]?.toLowerCase() ?? "test"}`
          : job.status === "READY"
            ? " · validated before test types existed. Edit this import and choose the training and test type before importing."
            : " · imported before test types existed. Its questions stay eligible for both the pre-test and the post-test of their training."}
      </p>
      {job.needs_revalidation ? <p className="import-training">This preview was validated with the old question template. Edit this import and validate a file made from the new template before importing.</p> : null}
    </>
  );
}

export function ImportCentre() {
  return (
    <Suspense fallback={<Loading />}>
      <ImportCentreInner />
    </Suspense>
  );
}

function ImportCentreInner() {
  // Import Questions from a training's pre-test or post-test table arrives with that training and test chosen
  // (?type=QUESTIONS&training_id=…&test_type=…); L&D can still change either before validating.
  const linked = useSearchParams();
  const fromQuestionBank = (linked.get("type") ?? "QUESTIONS") === "QUESTIONS";
  const [kind, setKind] = useState("QUESTIONS");
  const [trainingId, setTrainingId] = useState(fromQuestionBank ? (linked.get("training_id") ?? "") : "");
  // No default otherwise: L&D chooses Pre-test or Post-test for every question import.
  const [testType, setTestType] = useState<string>(fromQuestionBank ? linkedTestType(linked.get("test_type")) : "");
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
    const sent = formSnapshot();
    const problem = selectionProblem(sent);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    setJob(null);
    try {
      const validated = await api.upload<ImportJob>("/admin/imports", form);
      if (selectionChanged(sent, formSnapshot())) {
        // The type, training, test type or file changed while validating: this preview no longer matches the form.
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
      // The server imports with the training and test type saved at validation; these are only compared with them.
      const done = await api.post<ImportJob>(`/admin/imports/${job.id}/commit`, commitSelection(job, formSnapshot()));
      setJob(done);
      toast(importSummary(done));
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
    setTestType(full.test_type ?? "");
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
  /** What the form holds now, read from the page itself so a change made while validating is seen. */
  const formSnapshot = (): ImportSelection => ({
    kind: document.querySelector<HTMLSelectElement>("#import-form select[name=import_type]")?.value ?? kind,
    trainingId: document.querySelector<HTMLSelectElement>("#import-form select[name=training_id]")?.value ?? "",
    testType: document.querySelector<HTMLSelectElement>("#import-form select[name=test_type]")?.value ?? "",
    file: fileInput()?.files?.[0] ?? null,
  });
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
      ? "Choose the training, the test type and a file, then select Validate file. Nothing is saved until step 3."
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
          {/* Import type, Select training, Test type: side by side on desktop, stacked in the same order on mobile. */}
          <div className="import-selections">
            {importFields(kind).map((field) =>
              field === "import_type" ? (
                <SelectField
                  key={field}
                  label="Import type"
                  name="import_type"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    if (job) discardPreview();
                  }}
                  options={[{ value: "QUESTIONS", label: "Question bank" }, { value: "COMPLETIONS", label: "Training completions" }]}
                />
              ) : field === "training_id" ? (
                <SelectField
                  key={field}
                  label="Select training *"
                  name="training_id"
                  required
                  aria-describedby="import-selection-help"
                  value={trainingId}
                  placeholder={trainings.data ? "Choose a draft or active training" : "Loading trainings…"}
                  onChange={(e) => {
                    setTrainingId(e.target.value);
                    if (job) discardPreview();
                  }}
                  options={importable.map((t) => ({ value: t.id, label: `${t.title} (${t.training_code})${t.status === "DRAFT" ? " · Draft" : ""}` }))}
                />
              ) : (
                <SelectField
                  key={field}
                  label="Test type *"
                  name="test_type"
                  required
                  aria-describedby="import-selection-help"
                  value={testType}
                  placeholder="Choose Pre-test or Post-test"
                  onChange={(e) => {
                    setTestType(e.target.value);
                    if (job) discardPreview();
                  }}
                  options={TEST_TYPE_OPTIONS}
                />
              ),
            )}
          </div>
          {kind === "QUESTIONS" ? (
            <div className="import-training-select" id="import-selection-help">
              <p className="small">{TEST_TYPE_HELP} The file does not name a training: every question goes to the training selected here.</p>
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
            <p>Drag and drop a {fileTypesLabel(kind)} file, or select one below. Up to 5 MB and 5,000 {kind === "QUESTIONS" ? "questions" : "rows"}.</p>
            <label className="field">
              Select {fileTypesLabel(kind)} file
              <input type="file" name="file" accept={acceptedFiles(kind)} required />
            </label>
            <small>The first worksheet is read as plain values. Formulas, macros and external links are rejected.</small>
            {kind === "QUESTIONS" ? <small>Question files have exactly these fields: question, option_a, option_b, option_c, option_d, correct, topic. Four different options and one correct letter (A, B, C or D). TrainCheck sets the ID, 1 mark, Easy difficulty and Single choice; there is no competency or explanation until you add one in the Question Bank.</small> : null}
            {kind === "QUESTIONS" ? <small>PDFs must use the TrainCheck PDF template: each question is a block of &quot;field: value&quot; lines starting with &quot;question:&quot;, separated by ---. Only text is read; scanned, free-form and password-protected PDFs cannot be imported.</small> : null}
          </div>
          <div className="row wrap">
            <Btn tone="data" onClick={() => void download(templatePath(kind, "csv"), "template.csv")}>
              Download CSV template
            </Btn>
            <Btn tone="data" onClick={() => void download(templatePath(kind, "xlsx"), "template.xlsx")}>
              Download Excel template
            </Btn>
            {kind === "QUESTIONS" ? (
              <Btn tone="data" onClick={() => void download(templatePath(kind, "pdf"), "template.pdf")}>
                Download PDF template
              </Btn>
            ) : null}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Validating file…" : "Validate file"}
            </button>
          </div>
          <FormError message={error} />
        </form>
        {job ? (
          <div id="import-preview">
            <div className="notice" id="import-summary" tabIndex={-1}>
              {importSummary(job)}
              {importNotes(job)}
              <ImportTrainingLinks job={job} />
              {job.difficulty_notice ? (
                <p className="import-training" id="import-difficulty-notice">
                  {job.difficulty_notice}
                </p>
              ) : null}
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
                <Btn kind="primary" id="import-commit" aria-describedby="import-confirm-summary" disabled={!job.accepted_rows || busy || needsRevalidation(job)} onClick={() => void commit()}>
                  Import {rows(job.accepted_rows, "valid row")}
                </Btn>
              ) : null}
            </div>
            {job.status === "READY" && job.import_type === "QUESTIONS" && job.accepted_rows && !needsRevalidation(job) ? (
              <p className="small" id="import-confirm-summary">
                Importing adds {rows(job.accepted_rows, "new question")} (the rows marked Valid) to <strong>{job.training?.title}</strong> ({job.training?.code}) for the <strong>{testTypeLabel(job).toLowerCase()}</strong> only, as Single choice questions worth 1 mark at Easy difficulty, with no competency or explanation. They are saved as Active, so they become eligible for this assessment as soon as you confirm; change their details or deactivate them in the Question Bank. Duplicate, conflict and rejected rows are skipped; existing questions, answer keys and links are not changed. Imported questions are recorded as English: correct the language of Hindi or Hinglish questions in the Question Bank.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="panel">
        <h2>Recent imports</h2>
        <Loaded state={recent}>
          {(rows) => (
            <DataTable
              headers={["File", "Type", "Training", "Test type", "Status", "Rows", "Accepted", "Rejected", "Uploaded", "Actions"]}
              emptyTitle="No imports yet."
              emptyHint="Validate a file above to begin."
              rows={rows.map((j) => [
                j.file_name,
                j.import_type === "QUESTIONS" ? "Question bank" : "Completions",
                j.training ? `${j.training.title} (${j.training.code})` : j.import_type === "QUESTIONS" ? "Named in file" : "—",
                testTypeLabel(j),
                j.status.replaceAll("_", " ").toLowerCase(),
                j.total_rows,
                j.accepted_rows,
                j.rejected_rows,
                dateTimeIn(j.created_at, ORG_TIMEZONE, "—"),
                <div className="row wrap" key="a">
                  <Btn kind="text" onClick={() => void api.get<ImportJob>(`/admin/imports/${j.id}`).then(showJob).catch((e: ApiError) => toast(e.message))}>
                    View
                  </Btn>
                  {UNAPPLIED_IMPORT.includes(j.status) ? (
                    <Btn kind="text" onClick={() => setEditing(j)}>
                      Edit
                    </Btn>
                  ) : null}
                  <Btn kind="text" tone="danger" onClick={() => setDeleting(j)}>
                    Delete
                  </Btn>
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
            {editing.file_name} · {rows(editing.total_rows)}. Choose a corrected file{editing.import_type === "QUESTIONS" ? ", the training and the test type" : ""}. Its rows replace the current ones in this import and are validated again; nothing is imported until you confirm.
          </p>
          {editing.import_type === "QUESTIONS" ? (
            <>
              <div className="form-grid">
                <SelectField
                  label="Select training *"
                  name="training_id"
                  required
                  aria-describedby="import-edit-help"
                  defaultValue={editing.training?.id ?? ""}
                  placeholder="Choose a draft or active training"
                  options={importable.map((t) => ({ value: t.id, label: `${t.title} (${t.training_code})${t.status === "DRAFT" ? " · Draft" : ""}` }))}
                />
                <SelectField label="Test type *" name="test_type" required aria-describedby="import-edit-help" defaultValue={editing.test_type ?? ""} placeholder="Choose Pre-test or Post-test" options={TEST_TYPE_OPTIONS} />
              </div>
              <p className="small" id="import-edit-help">
                {TEST_TYPE_HELP}
              </p>
            </>
          ) : null}
          <label className="field">
            Select {fileTypesLabel(editing.import_type)} file *
            <input type="file" name="file" accept={acceptedFiles(editing.import_type)} required />
          </label>
        </DialogForm>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete import?"
          danger
          confirmLabel="Delete import"
          body={<p>{deleting.file_name} · {rows(deleting.total_rows)}. This removes the entry from Recent imports. Imported questions, completions and assessment results are kept.</p>}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/admin/imports/${deleting.id}`);
            if (job?.id === deleting.id) setJob(null);
            toast("Import removed from Recent imports.");
            void recent.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** Only imports that never applied anything can be edited. Completed entries can be removed from Recent imports. */
const UNAPPLIED_IMPORT = ["READY", "CANCELLED", "FAILED"];

/* ---------- Assessment configuration ---------- */

/** Live question pool readiness inside the settings form. Counts come from the backend. */
function PoolPanel({ training, report, count, mix, check, reload, onUseEligible }: { training: TrainingAdmin; report: PoolReport; count: number | null; mix: Record<Difficulty, number> | null; check: PlanCheck; reload: () => void; onUseEligible: () => void }) {
  const exclusions = exclusionNotes(report);
  const bankHref = questionTableHref(training.id, report.assessment_type);
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
      <h3 id="pool-title">{report.assessment_type === "PRE_TEST" ? "Pre-test" : "Post-test"} question pool</h3>
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
  // Each test has its own pool: pre-test-only questions never count for the post-test, and the reverse.
  const pool = useApi<PoolReport>(`/admin/trainings/${training.id}/question-pool?assessment_type=${kind}`);
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
  // Dates and times are chosen in the organisation timezone (the backend's working calendar) and stored as UTC.
  const zone = training.timezone ?? current?.timezone ?? ORG_TIMEZONE;
  const today = nowIn(zone).date;
  // A saved date already passed stays selectable, so other settings can be changed without moving it.
  const minDate = current?.schedule_date && current.schedule_date < today ? current.schedule_date : today;

  const blocked = !pool.data ? null : pool.data.eligible === 0 ? "Add eligible questions to this training before saving." : !count ? "Enter the questions per attempt." : check && !check.ready ? "Fix the question pool problem shown above before saving." : null;

  return (
    <DialogForm
      title={`${post ? "Assessment" : "Pre-test"} settings · ${training.title}`}
      submitLabel="Save settings"
      wide
      submitBlockedReason={blocked}
      onClose={onClose}
      onSubmit={async (form) => {
        let applied: { scheduled: unknown[]; rescheduled: unknown[] } | null = null;
        try {
          ({ applied } = await api.post<{ applied: { scheduled: unknown[]; rescheduled: unknown[] } | null }>(`/admin/trainings/${training.id}/assessment-configs`, {
            assessment_type: kind,
            question_count: count,
            duration_minutes: Number(form.get("duration_minutes")),
            pass_mark_percent: Number(form.get("pass_mark_percent")),
            max_attempts: post ? Number(form.get("max_attempts")) : 1,
            schedule_mode: post ? form.get("schedule_mode") : "SAME_DAY",
            schedule_delay_days: post ? Number(form.get("schedule_delay_days") ?? 0) : 0,
            schedule_uses_working_days: form.has("schedule_uses_working_days"),
            schedule_date: post && mode === "FIXED_DATE" ? form.get("schedule_date") : null,
            schedule_time: post && mode === "FIXED_DATE" ? form.get("schedule_time") : null,
            apply_to_waiting: post && form.has("apply_to_waiting"),
            difficulty_mix: mix,
            show_explanations: form.has("show_explanations"),
            shuffle_questions: form.has("shuffle_questions"),
            shuffle_options: form.has("shuffle_options"),
            // Pre-tests run in the same secure environment as the post-training assessment.
            violation_limit: Number(form.get("violation_limit")),
            require_fullscreen: form.has("require_fullscreen"),
          }));
        } catch (e) {
          // The server is the authority. Its counts may be newer than ours, so refresh them; the form keeps every value.
          if (e instanceof ApiError && e.code === "QUESTION_POOL_INSUFFICIENT") void reloadPool();
          throw e;
        }
        const moved = applied ? applied.rescheduled.length + applied.scheduled.length : 0;
        toast(
          moved
            ? `Settings saved. ${moved} assessment${moved === 1 ? "" : "s"} not yet started now follow${moved === 1 ? "s" : ""} the new rules. Running and submitted attempts are unchanged.`
            : "Settings saved for new attempts. Existing attempts keep their original settings.",
        );
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
            {mode === "FIXED_DATE" ? <TextField label="Assessment date *" name="schedule_date" type="date" required min={minDate} defaultValue={current?.schedule_date ?? ""} /> : null}
            {mode === "FIXED_DATE" ? <TextField label={`Opening time (${zone}) *`} name="schedule_time" type="time" required defaultValue={current?.schedule_time ?? ""} /> : null}
          </div>
          {mode === "FIXED_DATE" ? (
            <p className="small">
              The date and time are in the organisation timezone, <strong>{zone}</strong>. The assessment opens then for everyone whose completion is recorded by then; if completion is recorded later, it is due straight away. It cannot start earlier.
              {current?.schedule_at ? ` Saved: opens ${dateTimeIn(current.schedule_at, zone)}.` : ""}
            </p>
          ) : null}
          {mode === "DELAY_DAYS" ? (
            <label className="checkline">
              <input type="checkbox" name="schedule_uses_working_days" defaultChecked={current?.schedule_uses_working_days} /> Count working days instead of calendar days
            </label>
          ) : null}
          <label className="checkline">
            <input type="checkbox" name="apply_to_waiting" defaultChecked /> Also apply to employees already waiting: assessments not yet started are rescheduled from their recorded completion, and completions not yet scheduled get an assessment. Running attempts and submitted results never change; employees whose completion is not recorded get theirs when it is.
          </label>
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
      {/* Pre-tests run in the same secure environment as the post-training assessment. */}
      <h3>Secure browser policy{post ? "" : " (pre-test)"}</h3>
      <label className="checkline">
        <input type="checkbox" name="require_fullscreen" defaultChecked={current?.require_fullscreen ?? true} /> Require full screen
      </label>
      <TextField label="Violations before automatic submission *" name="violation_limit" type="number" required min={1} max={10} defaultValue={current?.violation_limit ?? 3} />
      <div className="notice">Monitoring is browser-level and best-effort. A lost internet connection is never counted as a violation. The default policy awaits L&D, Security and HR approval.</div>
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
                <span key="q">
                  {t.eligible_questions} post-test
                  {t.pretest_enabled ? <small>{t.pre_test_eligible_questions ?? 0} pre-test</small> : null}
                </span>,
                <span key="r" className={`badge ${t.config_ready ? "success" : t.config ? "danger" : "info"}`}>
                  {t.config_ready ? "Ready" : t.config ? "Needs questions" : "Not configured"}
                </span>,
                t.config ? `${t.config.pass_mark_percent}%` : "Not configured",
                t.config?.question_count ?? "—",
                t.config ? `${t.config.duration_minutes} min` : "—",
                t.config?.max_attempts ?? "—",
                t.config ? (t.config.schedule_mode === "FIXED_DATE" && t.config.schedule_date ? `On ${t.config.schedule_at ? dateTimeIn(t.config.schedule_at, t.config.timezone) : day(t.config.schedule_date)}` : SCHEDULE_LABEL[t.config.schedule_mode]) : "—",
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

/* ---------- Scorecards and reports ---------- */

export const AdminScorecards = () => <ScorecardPage eyebrow={EYEBROW} />;

export function AdminReports() {
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Reports & Analytics" description="Select any report. Every export uses the same scope and filters." />
      <ReportsHub />
    </>
  );
}
