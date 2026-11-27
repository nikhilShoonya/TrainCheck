"use client";

import { useState } from "react";
import { Badge, DataTable, Empty, Loaded, Metrics, PageTitle, SelectField } from "@/components/ui";
import { toQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { FeedbackAdmin } from "@/lib/types";
import { dateTime } from "@/lib/utils";

const score = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toFixed(1));

/** L&D Admin: what employees said after their post-training assessments. */
export function TrainingFeedback() {
  const [trainingId, setTrainingId] = useState("");
  const state = useApi<FeedbackAdmin>(`/admin/feedback${toQuery({ training_id: trainingId })}`);
  return (
    <>
      <PageTitle
        eyebrow="L&D ADMIN"
        title="Training Feedback"
        description="Employees complete the official 10-question Training Feedback Form after a post-training assessment. Ratings run from 1 (lowest) to 5 (highest). Previous responses retain their original question labels."
      />
      <Loaded state={state}>
        {(data) => (
          <>
            <div className="filters">
              <SelectField
                label="Training"
                value={trainingId}
                onChange={(e) => setTrainingId(e.target.value)}
                placeholder="All trainings"
                options={data.training_options.map((t) => ({ value: t.id, label: t.name }))}
              />
            </div>
            <Metrics
              items={[
                ["Responses", data.summary.responses, "Feedback forms submitted"],
                ["Trainings", data.summary.trainings, "With at least one response"],
                ["Average rating", score(data.summary.overall), "Across submitted ratings"],
                ["Training satisfaction", score(data.summary.averages.satisfaction), "Overall satisfaction, out of 5"],
              ]}
            />
            {data.summary.responses === 0 ? (
              <section className="panel">
                <Empty title="No feedback yet." hint="Feedback appears here after employees finish a post-training assessment and complete the Training Feedback Form." />
              </section>
            ) : (
              <>
                <section className="panel" aria-labelledby="feedback-averages-title">
                  <div className="section-heading">
                    <h2 id="feedback-averages-title">Average rating per question</h2>
                    <span>out of 5</span>
                  </div>
                  <div className="feedback-averages">
                    {data.questions.map((q) => (
                      <div className="feedback-average" key={q.key}>
                        <span>{q.text}</span>
                        <progress value={data.summary.averages[q.key] ?? 0} max={5} aria-label={`${q.short_label} average`} />
                        <strong>{score(data.summary.averages[q.key])}</strong>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="panel" aria-labelledby="feedback-trainings-title">
                  <div className="section-heading">
                    <h2 id="feedback-trainings-title">By training</h2>
                  </div>
                  <DataTable
                    headers={["Training", "Responses", ...data.questions.map((q) => q.short_label), "Overall", "Latest"]}
                    rows={data.trainings.map((t) => [
                      <div key="t" data-sort={t.training_title}>
                        {t.training_title}
                        <small>{t.training_code}</small>
                      </div>,
                      t.responses,
                      ...data.questions.map((q) => score(t.averages[q.key])),
                      <strong key="o">{score(t.overall)}</strong>,
                      dateTime(t.latest_at),
                    ])}
                  />
                </section>
                <section className="panel" aria-labelledby="feedback-responses-title">
                  <div className="section-heading">
                    <h2 id="feedback-responses-title">All responses</h2>
                    <span>{data.responses.length} shown, newest first</span>
                  </div>
                  <DataTable
                    headers={["Employee", "Training", "Assessment", ...data.questions.map((q) => q.short_label), "Average", "Comment", "Submitted"]}
                    rows={data.responses.map((r) => [
                      <div key="e" data-sort={r.employee_name}>
                        {r.employee_name}
                        <small>
                          {r.employee_code}
                          {r.department ? ` · ${r.department}` : ""}
                        </small>
                      </div>,
                      r.training_title,
                      <div key="a" data-sort={r.score_percent ?? -1}>
                        {r.result_status ? <Badge status={r.result_status} /> : null}
                        <small>{r.score_percent === null ? "—" : `${r.score_percent}%`}</small>
                      </div>,
                      ...data.questions.map((q) => (
                        <span key={q.key} className="feedback-rating-cell" data-sort={r.ratings[q.key] ?? -1}>
                          {r.ratings[q.key] == null ? "—" : `${r.ratings[q.key]} / 5`}
                        </span>
                      )),
                      <strong key="avg" data-sort={r.average ?? 0}>
                        {score(r.average)}
                      </strong>,
                      <p key="c" className="feedback-comment" data-sort={r.comment ?? ""}>
                        {r.comment ?? <span className="muted">No comment</span>}
                      </p>,
                      dateTime(r.submitted_at),
                    ])}
                  />
                </section>
              </>
            )}
          </>
        )}
      </Loaded>
    </>
  );
}
