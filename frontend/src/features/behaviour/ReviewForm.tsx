"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge, BtnLink, DataTable, ErrorPanel, Field, Loaded, PageTitle, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ReviewForm as ReviewFormData, ReviewSummary } from "@/lib/types";
import { day } from "@/lib/utils";

// Sample wording. L&D and HR have not yet approved the final rating anchors (OD-BRD-015).
const ANCHORS = ["Not demonstrated", "Rarely demonstrated", "Partially demonstrated", "Consistently demonstrated", "Role-model demonstration"];

/** The employee's own Level 3 self-assessment. Manager observations were removed with the Manager role. */
export function ReviewFormPage({ reviewId }: { reviewId: string }) {
  const base = "/me/behaviour-reviews";
  const back = "/employee/behaviour";
  const state = useApi<ReviewFormData>(`${base}/${reviewId}`);
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>, form: ReviewFormData) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/${reviewId}/submit`, {
        responses: form.questions.map((q) => ({
          template_question_id: q.template_question_id,
          rating: Number(values.get(`rating-${q.template_question_id}`)),
          example_text: values.get(`example-${q.template_question_id}`),
          comment_text: values.get(`comment-${q.template_question_id}`),
        })),
      });
      toast("Behaviour review submitted.");
      router.push(back);
    } catch (e) {
      setError(e as ApiError); // What was typed stays in the form so nothing is lost.
      setBusy(false);
    }
  };

  return (
    <Loaded state={state}>
      {(form) => {
        const done = form.status === "SUBMITTED";
        const editable = form.status === "PENDING" || form.status === "OVERDUE";
        return (
          <>
            <PageTitle
              eyebrow="LEVEL 3 · SELF-ASSESSMENT"
              title="My behaviour self-assessment"
              description={`${form.training_title} · ${form.period_days}-day follow-up · Due ${day(form.due_at)}`}
              action={<Badge status={form.status} />}
            />
            {done ? (
              <section className="panel">
                <p>
                  Submitted {day(form.submitted_at)}
                  {form.submitted_by ? ` by ${form.submitted_by}` : ""}.
                </p>
                <DataTable all headers={["Competency", "Rating /5", "Example", "Comments"]} rows={form.questions.map((q) => [q.competency, q.rating ?? "—", q.example_text ?? "—", q.comment_text ?? "—"])} />
                {form.self_assessment ? (
                  <>
                    <h3>Employee self-assessment for comparison</h3>
                    <DataTable all headers={["Competency", "Self /5", "Example"]} rows={form.self_assessment.map((q) => [q.competency, q.rating ?? "Not collected", q.example_text ?? "Not collected"])} />
                  </>
                ) : null}
                <p className="small">Ratings are one person&apos;s observation, compared only for the same competency and period. They do not determine an employment outcome.</p>
                <BtnLink href={back}>Back to the list</BtnLink>
              </section>
            ) : !editable ? (
              <section className="panel">
                <p>This review is not due yet. It opens on {day(form.due_at)}.</p>
                <BtnLink href={back}>Back to the list</BtnLink>
              </section>
            ) : (
              <form className="panel" onSubmit={(e) => void submit(e, form)}>
                <p>
                  Rate how often you apply each competency in your daily work.
                </p>
                {form.questions.map((q) => (
                  <fieldset className="competency-field" key={q.template_question_id}>
                    <legend>{q.competency}</legend>
                    {q.competency_description ? <p>{q.competency_description}</p> : null}
                    <p>
                      <strong>{q.prompt}</strong>
                    </p>
                    <fieldset className="rating-field">
                      <legend className="sr-only">Rating from 1 to 5 for {q.competency}</legend>
                      <div className="rating-scale">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <label key={n} title={ANCHORS[n - 1]}>
                            <input type="radio" name={`rating-${q.template_question_id}`} value={n} required />
                            <span>{n}</span>
                          </label>
                        ))}
                      </div>
                      <div className="scale-anchors" aria-hidden="true">
                        <span>1 · {ANCHORS[0]}</span>
                        <span>5 · {ANCHORS[4]}</span>
                      </div>
                    </fieldset>
                    <Field label={`Specific workplace example${q.example_required ? " *" : ""}`}>
                      <textarea name={`example-${q.template_question_id}`} required={q.example_required} minLength={q.example_required ? 10 : undefined} maxLength={1500} placeholder="Describe the situation, the action and what happened." />
                    </Field>
                    <Field label="Comments (optional)">
                      <textarea name={`comment-${q.template_question_id}`} maxLength={1500} />
                    </Field>
                  </fieldset>
                ))}
                <p className="small">Rating wording is sample text awaiting L&D and HR approval. These ratings do not determine an employment outcome.</p>
                {error ? <ErrorPanel error={error} /> : null}
                <div className="dialog-actions">
                  <BtnLink href={back}>Cancel</BtnLink>
                  <button className="btn primary" type="submit" disabled={busy}>
                    {busy ? "Submitting…" : "Submit review"}
                  </button>
                </div>
              </form>
            )}
          </>
        );
      }}
    </Loaded>
  );
}

export function ReviewTable({ rows, base, showEmployee, emptyTitle }: { rows: ReviewSummary[]; base: string; showEmployee: boolean; emptyTitle: string }) {
  return (
    <DataTable
      headers={[...(showEmployee ? ["Employee"] : []), "Training", "Cycle", "Due", "Status", ""]}
      emptyTitle={emptyTitle}
      emptyHint="The follow-up appears 30 days after training completion."
      rows={rows.map((r) => [
        ...(showEmployee ? [r.employee_name] : []),
        r.training_title,
        `${r.period_days} days`,
        day(r.due_at),
        <Badge key="s" status={r.status} />,
        r.status === "NOT_DUE" ? (
          <span key="a" className="muted">
            Not yet due
          </span>
        ) : (
          <BtnLink key="a" href={`${base}/${r.review_id}`} kind={r.status === "SUBMITTED" ? "text" : "secondary"} tone={r.status === "SUBMITTED" ? undefined : "success"}>
            {r.status === "SUBMITTED" ? "View review" : "Complete review"}
          </BtnLink>
        ),
      ])}
    />
  );
}
