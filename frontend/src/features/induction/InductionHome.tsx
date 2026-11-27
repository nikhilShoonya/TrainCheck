"use client";

/* The main Induction page (L&D Admin): induction cards, Create Induction, and the common configuration shared by every
   card: the Common Assessment (questions and rules) and the Common Feedback Form. Records live inside each selected
   induction, never here. */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Icon } from "@/components/icons";
import { Badge, Btn, BtnLink, DataTable, Empty, Field, Loaded, Loading, PageTitle, SelectField, TextField, useToast } from "@/components/ui";
import { DialogForm } from "@/features/admin/pages";
import { Glyph } from "@/features/dashboard/widgets";
import { FeedbackDialog } from "@/features/exam/FeedbackForm";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { InductionCard, InductionForm, InductionFormQuestion, InductionOverview, InductionSettings, OrgUnit, Named } from "@/lib/types";
import { asMainTab, CONTROL_LABEL, inductionDetailHref, inductionHref, MAIN_TABS, minutes, type MainTab } from "./inductionView";

export const INDUCTION_EYEBROW = "L&D ADMIN";

/** Tabs drawn with the existing filled (current) and outlined buttons, as in the reference screens. */
export function Tabs<T extends string>({ tabs, current, onChange, label, small }: { tabs: [T, string][]; current: T; onChange: (tab: T) => void; label: string; small?: boolean }) {
  return (
    <div className={`row wrap induction-tabs${small ? " induction-subtabs" : ""}`} role="tablist" aria-label={label}>
      {tabs.map(([value, text]) => (
        <Btn
          key={value}
          kind={value === current ? "primary" : "secondary"}
          role="tab"
          aria-selected={value === current}
          tabIndex={value === current ? 0 : -1}
          onClick={() => onChange(value)}
          onKeyDown={(e) => {
            // Arrow keys move between tabs, as for any tab list.
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const index = tabs.findIndex(([v]) => v === current);
            const next = tabs[(index + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
            onChange(next);
            const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]");
            buttons?.[tabs.findIndex(([v]) => v === next)]?.focus();
          }}
        >
          {text}
        </Btn>
      ))}
    </div>
  );
}

export function ReadinessBadge({ ready }: { ready: boolean }) {
  return <span className={`badge ${ready ? "success" : "warning"}`}>{ready ? "Ready" : "Not ready"}</span>;
}

export function InductionHome() {
  return (
    <Suspense fallback={<Loading />}>
      <InductionHomeInner />
    </Suspense>
  );
}

function InductionHomeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = asMainTab(params.get("tab"));
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [creating, setCreating] = useState(false);
  const overview = useApi<InductionOverview>("/admin/induction/overview");
  const go = (next: MainTab) => router.replace(inductionHref(next, next === "inductions" ? search : null), { scroll: false });
  return (
    <>
      <PageTitle
        eyebrow={INDUCTION_EYEBROW}
        title={tab === "assessment" ? "Induction Assessment Configuration" : tab === "feedback" ? "Induction Feedback Form" : "Induction"}
        description={
          tab === "assessment"
            ? "One common question paper and one set of rules for every induction and batch."
            : tab === "feedback"
              ? "One common feedback form for every induction, separate from Training Feedback."
              : "Manage new-joiner induction programmes, batches and records. Each employee completes the induction assessment and feedback only once."
        }
        action={
          tab === "inductions" ? (
            <Btn kind="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Create Induction
            </Btn>
          ) : undefined
        }
      />
      <Tabs tabs={MAIN_TABS} current={tab} onChange={go} label="Induction" />
      {overview.data && !overview.data.readiness.ready ? (
        <div className="notice left" role="status">
          <Icon name="alert" />
          <div>
            <strong>The induction assessment is not ready yet.</strong> Employees assigned meanwhile are not asked to take it until the{" "}
            {!overview.data.readiness.assessment.ready ? "Common Assessment" : null}
            {!overview.data.readiness.assessment.ready && !overview.data.readiness.feedback.ready ? " and the " : null}
            {!overview.data.readiness.feedback.ready ? "Common Feedback Form" : null} {(!overview.data.readiness.assessment.ready ? 1 : 0) + (!overview.data.readiness.feedback.ready ? 1 : 0) > 1 ? "are" : "is"} complete.
          </div>
        </div>
      ) : null}
      {tab === "inductions" ? (
        <InductionCards
          search={search}
          onSearch={(value) => {
            setSearch(value);
            window.history.replaceState(window.history.state, "", inductionHref("inductions", value));
          }}
        />
      ) : tab === "assessment" ? (
        <CommonAssessment overview={overview} />
      ) : (
        <CommonFeedbackForm overview={overview} />
      )}
      {creating ? <InductionForm induction={null} onClose={() => setCreating(false)} onSaved={(id) => router.push(inductionDetailHref(id, "batches", { cards: search }))} /> : null}
    </>
  );
}

/* ---------- Induction cards ---------- */

function InductionCards({ search, onSearch }: { search: string; onSearch: (value: string) => void }) {
  const state = useApi<InductionCard[]>("/admin/inductions");
  return (
    <>
      <form className="filters" role="search" aria-label="Inductions" onSubmit={(e) => e.preventDefault()}>
        <TextField label="Search inductions" name="q" type="search" placeholder="Induction name" autoComplete="off" value={search} onChange={(e) => onSearch(e.target.value)} />
      </form>
      <Loaded state={state}>
        {(all) => {
          // Create Induction stays in the page heading only, so the empty list does not repeat it.
          if (!all.length) return <Empty title="No inductions yet." hint="Use Create Induction above to add one for a department, then add batches and employees to it." />;
          const term = search.trim().toLowerCase();
          const shown = term ? all.filter((i) => `${i.name} ${i.category ?? ""} ${i.department.name}`.toLowerCase().includes(term)) : all;
          return (
            <>
              <p className="small" role="status" aria-live="polite">
                {term ? `${shown.length} of ${all.length} inductions match.` : `${all.length} induction${all.length === 1 ? "" : "s"}.`}
              </p>
              {shown.length ? (
                <section className="course-grid personal-courses completion-cards" aria-label="Inductions">
                  {shown.map((i, n) => {
                    const c = i.counts ?? { assigned: 0, completed: 0, pending: 0, batches: 0, members: 0, assessment_submitted: 0 };
                    return (
                      <article className="panel course-card completion-card training-card" key={i.id} aria-labelledby={`induction-${i.id}`}>
                        <div className="training-card-head">
                          <Glyph index={n} icon={n % 2 ? "headphones" : "shield"} />
                          <div className="training-card-title">
                            <Badge status={i.status} />
                            <h2 id={`induction-${i.id}`}>{i.name}</h2>
                            <p>{i.description || "No description."}</p>
                          </div>
                        </div>
                        <h3 className="completion-counts-title">Induction</h3>
                        <dl className="completion-counts">
                          <div>
                            <dt>Employees assigned</dt>
                            <dd>{c.assigned}</dd>
                          </div>
                          <div className="recorded">
                            <dt>Completed induction</dt>
                            <dd>{c.completed}</dd>
                          </div>
                          <div>
                            <dt>Pending</dt>
                            <dd>{c.pending}</dd>
                          </div>
                        </dl>
                        {c.assigned ? (
                          <div className="training-card-progress">
                            <span>
                              {c.completed} of {c.assigned} completed
                            </span>
                            <progress max={c.assigned} value={c.completed} aria-label={`${c.completed} of ${c.assigned} employees completed`} />
                          </div>
                        ) : null}
                        <small className="completion-note">
                          {i.department.name} department · {c.batches} batch{c.batches === 1 ? "" : "es"}. Assessment and feedback are recorded once per employee.
                        </small>
                        <div className="row wrap training-card-foot">
                          <BtnLink href={inductionDetailHref(i.id, "batches", { cards: search })} kind="primary">
                            View Employees<span className="sr-only"> for {i.name}</span> <Icon name="arrow" />
                          </BtnLink>
                        </div>
                      </article>
                    );
                  })}
                </section>
              ) : (
                <>
                  <Empty title={`No induction name matches “${search.trim()}”.`} hint="Check the spelling, or clear the search to see every induction." />
                  <div className="row">
                    <Btn onClick={() => onSearch("")}>Clear search</Btn>
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

/** Create or edit an induction card. Its department decides who can be assigned; it cannot change once anyone joined. */
export function InductionForm({ induction, onClose, onSaved }: { induction: InductionCard | null; onClose: () => void; onSaved: (id: string) => void }) {
  const departments = useApi<OrgUnit[]>("/admin/departments");
  const trainers = useApi<(Named & { is_active?: boolean })[]>("/admin/trainers");
  const toast = useToast();
  const active = (departments.data ?? []).filter((d) => d.is_active || d.id === induction?.department.id);
  const [status, setStatus] = useState(false);
  return (
    <DialogForm
      title={induction ? "Edit induction" : "Create induction"}
      submitLabel={induction ? "Save changes" : "Create induction"}
      onClose={onClose}
      submitBlockedReason={departments.error ? `Departments could not be loaded. ${departments.error.message}` : !departments.data ? "Loading departments…" : !active.length ? "No active department exists. Add one in Departments & Functions first." : null}
      extraAction={
        induction ? (
          <Btn
            tone={induction.status === "ACTIVE" ? "danger" : "success"}
            disabled={status}
            onClick={async () => {
              setStatus(true);
              try {
                await api.post(`/admin/inductions/${induction.id}/status`, { status: induction.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE" });
                toast(induction.status === "ACTIVE" ? `${induction.name} archived. Its records are kept.` : `${induction.name} reactivated.`);
                onSaved(induction.id);
                onClose();
              } catch (e) {
                toast((e as Error).message);
                setStatus(false);
              }
            }}
          >
            {induction.status === "ACTIVE" ? "Archive" : "Reactivate"}
          </Btn>
        ) : null
      }
      onSubmit={async (form) => {
        const body = {
          name: form.get("name"),
          category: form.get("category") || null,
          description: form.get("description") || null,
          department_id: form.get("department_id"),
          trainer_id: form.get("trainer_id") || null,
        };
        const saved = induction ? await api.patch<InductionCard>(`/admin/inductions/${induction.id}`, body) : await api.post<InductionCard>("/admin/inductions", body);
        toast(induction ? "Induction saved." : `${saved.name} created. Add a batch next.`);
        onSaved(saved.id);
      }}
    >
      <TextField label="Induction code" name="code" value={induction?.induction_code ?? "Generated automatically when saved"} readOnly disabled />
      <TextField label="Induction name *" name="name" required minLength={2} maxLength={200} defaultValue={induction?.name} placeholder="For example IT Induction" />
      <TextField label="Category / topic" name="category" maxLength={120} defaultValue={induction?.category ?? ""} />
      <Field label="Description">
        <textarea name="description" maxLength={4000} defaultValue={induction?.description ?? ""} />
      </Field>
      <SelectField
        label="Department *"
        name="department_id"
        required
        defaultValue={induction?.department.id}
        placeholder={departments.data ? "Choose the department this induction is for" : "Loading departments…"}
        options={active.map((d) => ({ value: d.id, label: `${d.name} (${d.code})` }))}
      />
      <p className="small">Only active employees of this department can be added to its batches and assigned.</p>
      <SelectField label="Trainer" name="trainer_id" placeholder="None" defaultValue={induction?.trainer?.id ?? ""} options={(trainers.data ?? []).filter((t) => t.is_active !== false || t.id === induction?.trainer?.id).map((t) => ({ value: t.id, label: t.name }))} />
    </DialogForm>
  );
}

/* ---------- Common Assessment ---------- */

function CommonAssessment({ overview }: { overview: ReturnType<typeof useApi<InductionOverview>> }) {
  const [rules, setRules] = useState(false);
  return (
    <Loaded state={overview}>
      {(o) => (
        <>
          <section className="panel" aria-label="Common Induction Assessment">
            <DataTable
              all
              headers={["Assessment", "Eligible questions", "Readiness", "Pass mark", "Duration", "Attempts", "Actions"]}
              rows={[
                [
                  <strong key="n">Common Induction Assessment</strong>,
                  o.readiness.assessment.question_count,
                  <ReadinessBadge key="r" ready={o.readiness.assessment.ready} />,
                  o.settings ? `${o.settings.pass_mark_percent}%` : "Not set",
                  o.settings ? minutes(o.settings.duration_seconds) : "Not set",
                  "1",
                  <div className="row wrap" key="a">
                    <Btn onClick={() => setRules(true)}>Assessment Rules</Btn>
                    <BtnLink href="/lnd/induction/questions">Manage Questions</BtnLink>
                  </div>,
                ],
              ]}
            />
          </section>
          <p className="small">
            Each employee takes this assessment once, across every induction. Every employee gets every active question, in the same order.
            {o.settings ? ` Rules version ${o.settings.version}: ${o.settings.violation_limit} security violations submit automatically; full screen ${o.settings.require_fullscreen ? "required" : "not required"}.` : ""}
          </p>
          {o.readiness.assessment.problems.length ? (
            <div className="notice left" role="status">
              <strong>Needed before employees can start:</strong>
              <ul>
                {o.readiness.assessment.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {rules ? <RulesForm settings={o.settings} onClose={() => setRules(false)} /> : null}
        </>
      )}
    </Loaded>
  );
}

function RulesForm({ settings, onClose }: { settings: InductionSettings | null; onClose: () => void }) {
  const toast = useToast();
  return (
    <DialogForm
      title="Induction assessment rules"
      submitLabel="Save rules"
      onClose={onClose}
      onSubmit={async (form) => {
        await api.put("/admin/induction/assessment/settings", {
          duration_minutes: Number(form.get("duration_minutes")),
          pass_mark_percent: Number(form.get("pass_mark_percent")),
          violation_limit: Number(form.get("violation_limit")),
          require_fullscreen: form.has("require_fullscreen"),
        });
        toast("Rules saved as a new version. Attempts already started keep the rules they started with.");
      }}
    >
      <p className="small">These rules apply to every induction and batch. Enter the approved values; nothing is filled in for you.</p>
      <div className="form-grid">
        <TextField label="Duration (minutes) *" name="duration_minutes" type="number" min={1} max={600} required defaultValue={settings ? Math.round(settings.duration_seconds / 60) : ""} />
        <TextField label="Pass mark (%) *" name="pass_mark_percent" type="number" min={0} max={100} step="0.01" required defaultValue={settings?.pass_mark_percent ?? ""} />
        <TextField label="Security violations before automatic submission *" name="violation_limit" type="number" min={1} max={20} required defaultValue={settings?.violation_limit ?? ""} />
        <TextField label="Attempts" name="attempts" value="1 (fixed: each employee takes the induction assessment once)" readOnly disabled />
      </div>
      <label className="checkline">
        <input type="checkbox" name="require_fullscreen" defaultChecked={settings?.require_fullscreen ?? true} /> Require full-screen mode
      </label>
    </DialogForm>
  );
}

/* ---------- Common Feedback Form ---------- */

function CommonFeedbackForm({ overview }: { overview: ReturnType<typeof useApi<InductionOverview>> }) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<InductionForm | null>(null);
  return (
    <Loaded state={overview}>
      {(o) => {
        const form = o.feedback_form;
        const sections = form ? [...new Set(form.questions.map((q) => q.section))] : [];
        return (
          <>
            <section className="panel" aria-labelledby="induction-form-title">
              <div className="row wrap between">
                <div>
                  <h2 id="induction-form-title">Common Induction Feedback Form</h2>
                  <p className="small">
                    {form ? `Version ${form.version} · ${form.questions.length} rating question${form.questions.length === 1 ? "" : "s"} · comments ${form.comment_enabled ? "on" : "off"}.` : "No form yet."} Opens automatically after an employee submits the induction assessment.
                  </p>
                </div>
                <div className="row wrap">
                  <ReadinessBadge ready={o.readiness.feedback.ready} />
                  {form ? <Btn onClick={() => setPreview(form)}>Preview</Btn> : null}
                  <Btn kind="primary" onClick={() => setEditing(true)}>
                    {form ? "Edit form" : "Create form"}
                  </Btn>
                </div>
              </div>
              {form ? (
                sections.map((section, i) => (
                  <div key={section} className="induction-form-section">
                    <h3>
                      {i + 1}. {section}
                    </h3>
                    <ol>
                      {form.questions
                        .filter((q) => q.section === section)
                        .map((q) => (
                          <li key={q.key}>
                            {q.text} <small>({CONTROL_LABEL[q.control]})</small>
                          </li>
                        ))}
                    </ol>
                  </div>
                ))
              ) : (
                <Empty title="The induction feedback form has not been created." hint="Add the approved induction feedback questions. Training Feedback questions are not used here." />
              )}
              {form?.comment_enabled ? <p className="small">Comment box: {form.comment_label || "Additional comments or suggestions"} (optional).</p> : null}
            </section>
            <p className="small">Saving creates a new version. Employees who already started their assessment keep the version they started with, and submitted answers keep their original question wording.</p>
            {editing ? <FeedbackFormEditor form={form} onClose={() => setEditing(false)} /> : null}
            {preview ? (
              <FeedbackDialog
                attemptId=""
                preview
                title="Induction Feedback Form"
                intro="Tell us about your induction experience. Your answers help L&D improve the induction."
                comment={{ enabled: preview.comment_enabled, label: preview.comment_label }}
                view={{ training_title: "Induction", questions: previewQuestions(preview.questions) }}
                onClose={() => setPreview(null)}
                onSubmitted={() => setPreview(null)}
              />
            ) : null}
          </>
        );
      }}
    </Loaded>
  );
}

const SCALE = [
  [1, "Very Poor"],
  [2, "Poor"],
  [3, "Neutral"],
  [4, "Good"],
  [5, "Excellent"],
] as const;

/** The same shape the employee receives, built locally for L&D's preview. */
function previewQuestions(questions: InductionFormQuestion[]) {
  return questions.map((q) => {
    const stars = q.control === "STARS";
    const options = stars ? [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} star${n === 1 ? "" : "s"}` })) : SCALE.map(([value, label]) => ({ value, label }));
    return { key: q.key, text: q.text, section: q.section, options, stars, low_label: options[0].label, high_label: options[4].label };
  });
}

interface Draft {
  id: number;
  section: string;
  text: string;
  control: "STARS" | "SCALE";
}

function FeedbackFormEditor({ form, onClose }: { form: InductionForm | null; onClose: () => void }) {
  const toast = useToast();
  const [next, setNext] = useState(form?.questions.length ?? 1);
  const [rows, setRows] = useState<Draft[]>(() => (form?.questions.length ? form.questions.map((q, i) => ({ id: i, section: q.section, text: q.text, control: q.control })) : [{ id: 0, section: "", text: "", control: "SCALE" }]));
  const [commentEnabled, setCommentEnabled] = useState(form?.comment_enabled ?? true);
  const update = (id: number, patch: Partial<Draft>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const move = (index: number, by: number) =>
    setRows((r) => {
      const copy = [...r];
      const [item] = copy.splice(index, 1);
      copy.splice(index + by, 0, item);
      return copy;
    });
  return (
    <DialogForm
      title={form ? `Edit induction feedback form (version ${form.version})` : "Create induction feedback form"}
      submitLabel="Save as new version"
      wide
      onClose={onClose}
      submitBlockedReason={!rows.length ? "Add at least one question." : null}
      onSubmit={async (data) => {
        await api.put("/admin/induction/feedback-form", {
          questions: rows.map((r) => ({ section: r.section.trim(), text: r.text.trim(), control: r.control })),
          comment_enabled: commentEnabled,
          comment_label: commentEnabled ? String(data.get("comment_label") ?? "").trim() || null : null,
          expected_version: form?.version ?? 0,
        });
        toast("Induction feedback form saved as a new version.");
      }}
    >
      <p className="small">Enter the approved induction questions. Each is rated with an existing control: 1–5 stars, or the Very Poor … Excellent scale. Employees answer every question; their identity comes from their employee record.</p>
      <ol className="induction-form-editor">
        {rows.map((r, i) => (
          <li key={r.id}>
            <fieldset>
              <legend>Question {i + 1}</legend>
              <div className="form-grid">
                <TextField label="Section *" required maxLength={160} value={r.section} onChange={(e) => update(r.id, { section: e.target.value })} />
                <SelectField label="Rating control" value={r.control} onChange={(e) => update(r.id, { control: e.target.value as Draft["control"] })} options={(Object.keys(CONTROL_LABEL) as Draft["control"][]).map((value) => ({ value, label: CONTROL_LABEL[value] }))} />
              </div>
              <TextField label="Question *" required minLength={3} maxLength={400} value={r.text} onChange={(e) => update(r.id, { text: e.target.value })} />
              <div className="row wrap">
                <Btn kind="text" disabled={i === 0} onClick={() => move(i, -1)}>
                  Move up
                </Btn>
                <Btn kind="text" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  Move down
                </Btn>
                <Btn kind="text" tone="danger" disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}>
                  Remove
                </Btn>
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      <Btn
        onClick={() => {
          setRows((r) => [...r, { id: next, section: r[r.length - 1]?.section ?? "", text: "", control: "SCALE" }]);
          setNext((n) => n + 1);
        }}
        disabled={rows.length >= 30}
      >
        <Icon name="plus" /> Add question
      </Btn>
      <label className="checkline">
        <input type="checkbox" checked={commentEnabled} onChange={(e) => setCommentEnabled(e.target.checked)} /> Offer an optional comment box
      </label>
      {commentEnabled ? <TextField label="Comment box label" name="comment_label" maxLength={300} defaultValue={form?.comment_label ?? ""} placeholder="Additional comments or suggestions" /> : null}
    </DialogForm>
  );
}
