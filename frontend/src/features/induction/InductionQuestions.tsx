"use client";

/* Manage Questions: the one common induction question paper, in the order every employee receives it. Reached from
   the main Induction page's Common Assessment tab. Separate from the Training Question Bank. */

import { useState } from "react";
import { Icon } from "@/components/icons";
import { Btn, DataTable, Field, FormError, Loaded, Metrics, PageTitle, SelectField, TextField, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { DialogForm } from "@/features/admin/pages";
import { templatePath } from "@/features/admin/importView";
import { ApiError, api, downloadFile } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { InductionQuestion, InductionQuestionPreview, InductionReadiness } from "@/lib/types";
import { ReadinessBadge } from "./InductionHome";

const TYPE_LABEL: Record<string, string> = { MCQ_SINGLE: "Single choice", MCQ_MULTIPLE: "Multiple choice", TRUE_FALSE: "True / False", SCENARIO: "Scenario" };
const ROW_STATUS: Record<string, [string, string]> = { VALID: ["Ready", "success"], INVALID: ["Needs correcting", "danger"], DUPLICATE: ["Already in paper", "info"], CONFLICT: ["Conflict", "warning"] };

export function InductionQuestions() {
  const state = useApi<{ questions: InductionQuestion[]; readiness: InductionReadiness }>("/admin/induction/questions");
  const toast = useToast();
  const [editing, setEditing] = useState<InductionQuestion | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, run: () => Promise<unknown>, message?: string) => {
    setBusy(id);
    try {
      await run();
      if (message) toast(message);
      await state.reload();
    } catch (e) {
      toast((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="L&D ADMIN · INDUCTION"
        title="Induction Questions"
        description="The one common question paper. Every assigned employee receives every active question, in this order, whichever induction or batch they belong to."
        action={
          <div className="row wrap">
            <Btn onClick={() => setImporting(true)}>
              <Icon name="upload" /> Import questions
            </Btn>
            <Btn kind="primary" onClick={() => setEditing("new")}>
              <Icon name="plus" /> Add question
            </Btn>
          </div>
        }
      />
      <Loaded state={state}>
        {({ questions, readiness }) => {
          const active = questions.filter((q) => q.status === "ACTIVE");
          return (
            <>
              <Metrics
                items={[
                  ["Active questions", active.length, "In every employee's paper"],
                  ["Total marks", active.reduce((sum, q) => sum + q.marks, 0), "Score is marks earned ÷ total"],
                  ["Readiness", <ReadinessBadge key="r" ready={readiness.assessment.ready} />, readiness.assessment.ready ? "Employees can start" : readiness.assessment.problems[0] ?? ""],
                ]}
              />
              <DataTable
                all
                emptyTitle="No induction questions yet."
                emptyHint="Add the approved questions one at a time, or import them with the question template."
                headers={["Order", "Question", "Topic", "Type", "Marks", "Status", "Actions"]}
                rows={questions.map((q, i) => [
                  i + 1,
                  <div key="q">
                    <strong>{q.question_text}</strong>
                    <br />
                    <small>
                      {q.question_code} · v{q.version} · Correct: {q.options.filter((o) => o.is_correct).map((o) => o.text).join("; ")}
                    </small>
                  </div>,
                  q.topic,
                  TYPE_LABEL[q.question_type] ?? q.question_type,
                  q.marks,
                  <span key="s" className={`badge ${q.status === "ACTIVE" ? "success" : "info"}`}>
                    {q.status === "ACTIVE" ? "Active" : "Inactive"}
                  </span>,
                  <div className="row wrap" key="a">
                    <Btn kind="text" aria-label={`Move question ${i + 1} up`} disabled={i === 0 || busy !== null} onClick={() => void act(q.id, () => api.post(`/admin/induction/questions/${q.id}/move`, { direction: "up" }))}>
                      Up
                    </Btn>
                    <Btn kind="text" aria-label={`Move question ${i + 1} down`} disabled={i === questions.length - 1 || busy !== null} onClick={() => void act(q.id, () => api.post(`/admin/induction/questions/${q.id}/move`, { direction: "down" }))}>
                      Down
                    </Btn>
                    <Btn kind="text" onClick={() => setEditing(q)}>
                      Edit
                    </Btn>
                  </div>,
                ])}
              />
              <p className="small">Edits create a new version. Attempts already started keep the questions exactly as they were shown. Inactive questions are left out of new attempts.</p>
            </>
          );
        }}
      </Loaded>
      {editing ? <QuestionForm question={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void state.reload()} /> : null}
      {importing ? <ImportQuestions onClose={() => setImporting(false)} onImported={() => void state.reload()} /> : null}
    </>
  );
}

/** The Question Bank form's fields that apply to a common paper (no training links, department or difficulty). */
function QuestionForm({ question, onClose, onSaved }: { question: InductionQuestion | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [type, setType] = useState(question?.question_type ?? "MCQ_SINGLE");
  const optionsDefault = type === "TRUE_FALSE" ? "True\nFalse" : (question?.options.map((o) => o.text).join("\n") ?? "");
  const correctDefault = (question?.options ?? []).map((o, i) => (o.is_correct ? i + 1 : 0)).filter(Boolean).join(",");
  return (
    <DialogForm
      title={question ? `Edit induction question ${question.question_code}` : "Add induction question"}
      submitLabel="Save question"
      wide
      onClose={onClose}
      onSubmit={async (form) => {
        const body = {
          topic: form.get("topic"),
          question_type: type,
          question_text: form.get("question_text"),
          options: String(form.get("options")).split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          correct_option_indexes: String(form.get("correct")).split(",").map((x) => Number(x.trim()) - 1),
          explanation: form.get("explanation") || null,
          marks: Number(form.get("marks")),
          status: form.get("status"),
          ...(question ? { expected_version: question.version } : {}),
        };
        if (question) await api.patch(`/admin/induction/questions/${question.id}`, body);
        else await api.post("/admin/induction/questions", body);
        toast("Induction question saved. Started attempts are unchanged.");
        onSaved();
      }}
    >
      <SelectField label="Question type" value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
      <Field label="Question text *">
        <textarea name="question_text" required minLength={3} maxLength={4000} defaultValue={question?.question_text} />
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
        <TextField label="Marks *" name="marks" type="number" min={0.01} max={100} step="any" required defaultValue={question?.marks ?? 1} />
        <SelectField label="Status" name="status" defaultValue={question?.status ?? "ACTIVE"} options={[{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }]} />
      </div>
      <p className="small">Options are shown in this order to every employee. The topic appears in the employee&apos;s topic performance.</p>
    </DialogForm>
  );
}

/** The Import Centre's seven-field question format (CSV, Excel or PDF): validate, check the preview, then import. */
function ImportQuestions({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<File | null>(null);
  const [preview, setPreview] = useState<InductionQuestionPreview | null>(null);
  const [done, setDone] = useState<InductionQuestionPreview | null>(null);
  const [busy, setBusy] = useState<"validate" | "import" | null>(null);
  const [error, setError] = useState("");
  const form = () => {
    const data = new FormData();
    if (file) data.set("file", file);
    return data;
  };
  const run = async (kind: "validate" | "import") => {
    setBusy(kind);
    setError("");
    try {
      if (kind === "validate") {
        setPreview(await api.upload<InductionQuestionPreview>("/admin/induction/questions/import/preview", form()));
        setChecked(file);
      } else {
        const result = await api.upload<InductionQuestionPreview>("/admin/induction/questions/import", form());
        setDone(result);
        toast(`${result.created ?? 0} question${result.created === 1 ? "" : "s"} added to the induction paper.`);
        onImported();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "IMPORT_NOT_READY" && e.details) setPreview(e.details as InductionQuestionPreview);
      setError(e instanceof ApiError ? e.message : "The file could not be checked. Please try again.");
    } finally {
      setBusy(null);
    }
  };
  const shown = done ?? preview;
  return (
    <Modal title="Import induction questions" onClose={onClose} wide>
      <p className="small">Use the existing question template: question, option_a, option_b, option_c, option_d, correct (A–D) and topic. Each row becomes a Single choice question worth 1 mark, added at the end of the paper. Rows already in the paper are skipped.</p>
      <div className="row wrap">
        {(["csv", "xlsx", "pdf"] as const).map((f) => (
          <Btn key={f} tone="data" onClick={() => downloadFile(templatePath("QUESTIONS", f), `traincheck-questions-template.${f}`).catch((e: ApiError) => toast(e.message))}>
            Download {f === "xlsx" ? "Excel" : f.toUpperCase()} template
          </Btn>
        ))}
      </div>
      {done ? null : (
        <>
          <label className="field">
            Question file (CSV, Excel or PDF) *
            <input
              type="file"
              accept=".csv,.xlsx,.pdf"
              disabled={busy !== null}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setError("");
              }}
            />
          </label>
          <div className="row wrap">
            <Btn kind="primary" disabled={!file || busy !== null} onClick={() => void run("validate")}>
              {busy === "validate" ? "Validating file…" : "Validate file"}
            </Btn>
          </div>
        </>
      )}
      <FormError message={error} />
      {shown ? (
        <>
          <Metrics
            items={[
              ["Rows", shown.total_rows, "In the file"],
              [done ? "Added" : "Ready", done ? (done.created ?? 0) : shown.valid_rows, done ? "Now in the paper" : "Will be added"],
              ["Skipped", shown.invalid_rows + shown.duplicate_rows + shown.conflict_rows, `${shown.invalid_rows} to correct · ${shown.duplicate_rows + shown.conflict_rows} already present`],
            ]}
          />
          <DataTable
            headers={["Row", "Question", "Topic", "Correct", "Status", "Notes"]}
            rows={shown.rows.map((r) => [
              r.row,
              r.question,
              r.topic || "—",
              r.correct || "—",
              <span key="s" className={`badge ${ROW_STATUS[r.status][1]}`}>
                {ROW_STATUS[r.status][0]}
              </span>,
              r.errors.map((e) => e.message).join(" ") || "—",
            ])}
          />
        </>
      ) : null}
      <div className="dialog-actions">
        <Btn onClick={onClose} disabled={busy === "import"}>
          {done ? "Close" : "Cancel"}
        </Btn>
        {done ? null : (
          <Btn kind="primary" disabled={!preview?.ready || file !== checked || busy !== null} onClick={() => void run("import")}>
            {busy === "import" ? "Importing…" : preview?.ready ? `Import ${preview.valid_rows} question${preview.valid_rows === 1 ? "" : "s"}` : "Import"}
          </Btn>
        )}
      </div>
    </Modal>
  );
}
