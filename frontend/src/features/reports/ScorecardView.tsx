"use client";

import { useState } from "react";
import { Badge, DataTable, Empty, Loaded, Metrics, PageTitle, SelectField } from "@/components/ui";
import { toQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Scorecard } from "@/lib/types";
import { percent } from "@/lib/utils";
import { ExportButtons, FilterBar } from "./ReportView";

const score = (value: number | null) => (value === null ? "Not collected" : `${value}%`);
const rating = (value: number | null) => (value === null ? "Not collected" : `${value} / 5`);
const signed = (value: number | null, unit = "") => (value === null ? "Not comparable" : `${value > 0 ? "+" : ""}${value}${unit}`);

function ScorecardBody({ card }: { card: Scorecard }) {
  const { learning: l, behaviour: b } = card;
  return (
    <>
      <section className="panel scorecard-header">
        <h2>{card.training.title}</h2>
        <p>
          {l.assigned} assignments · {card.training.batches.join(", ") || "No batch"} · Trainer {card.training.trainer ?? "not assigned"} · Owner {card.training.owner ?? "not assigned"}
        </p>
      </section>
      <div className="scorecard-grid two-level">
        <section className="panel level-panel" aria-labelledby="learning-section">
          <span className="level-number">L2</span>
          <h2 id="learning-section">Section 1 · Learning</h2>
          <Badge status={l.state} />
          <p className="small">Did the employee acquire the required knowledge?</p>
          <Metrics
            items={[
              ["Pre-test", score(l.pre_test_mean), l.pre_test_state],
              ["Post-test (latest)", score(l.post_test_mean), `${l.assessed} of ${l.completed} completed`],
              ["Learning gain", signed(l.learning_gain_mean, " pts"), `${l.matched_pairs} matched pair(s)`],
            ]}
          />
          <Metrics
            items={[
              ["Pass rate", percent(l.pass_rate, "Not collected"), `${l.needs_retraining} need re-training`],
              ["First-attempt score", score(l.first_attempt_mean), "Mean, kept separate"],
              ["Best score", score(l.best_score_mean), `${l.failed_attempts} failed attempt(s)`],
            ]}
          />
          <h3>Topic performance</h3>
          {l.topics.length ? (
            l.topics.map((t) => (
              <div className="topic-row" key={t.topic}>
                <span>{t.topic}</span>
                <progress value={t.score ?? 0} max={100} aria-label={t.topic} />
                <strong>{t.score === null ? "—" : `${t.score}%`}</strong>
              </div>
            ))
          ) : (
            <p>Not collected. No submitted responses yet.</p>
          )}
          <h3>Most-missed questions</h3>
          {l.questions.length ? (
            <DataTable all headers={["Question", "Responses", "Correct %"]} rows={l.questions.slice(0, 5).map((q) => [q.question, q.responses, q.correct_percent ?? "—"])} />
          ) : (
            <p>Not collected.</p>
          )}
        </section>
        <section className="panel level-panel" aria-labelledby="behaviour-section">
          <span className="level-number">L3</span>
          <h2 id="behaviour-section">Section 2 · Behaviour</h2>
          <Badge status={b.state} />
          <p className="small">Is the employee applying that knowledge in daily work?</p>
          <Metrics
            items={[
              ["Self-assessment", rating(b.self_mean), "Employee rating"],
              ["Manager observation", rating(b.manager_mean), "Manager rating"],
              ["Self-manager gap", signed(b.self_manager_gap), "Manager minus self"],
            ]}
          />
          <p>
            <strong>Follow-up:</strong> one self-assessment 30 days after training completion. {b.overdue ? `${b.overdue} review(s) overdue.` : "No overdue reviews."}
          </p>
          <h3>30-day follow-up</h3>
          {b.periods.length ? (
            <DataTable
              all
              headers={["Period", "Self /5", "Manager /5", "Submitted", "Overdue", "Not yet due"]}
              rows={b.periods.map((p) => [`${p.period_days} days`, p.self_mean ?? "Not collected", p.manager_mean ?? "Not collected", `${p.self_submitted + p.manager_submitted} of ${p.reviews_total}`, p.overdue, p.not_due])}
            />
          ) : (
            <p>{b.state}. No follow-up cycles exist yet.</p>
          )}
          <h3>Competency ratings</h3>
          {b.competencies.length ? (
            <DataTable all headers={["Competency", "Self /5", "Manager /5", "Gap"]} rows={b.competencies.map((c) => [c.competency, c.self_mean ?? "Not collected", c.manager_mean ?? "Not collected", c.gap ?? "Not comparable"])} />
          ) : (
            <p>Not collected. No submitted reviews yet.</p>
          )}
        </section>
      </div>
      <div className="notice">{card.interpretation} There is no combined effectiveness score or employee ranking.</div>
    </>
  );
}

export function ScorecardPage({ eyebrow, description = "Learning and Behaviour evidence for one training, kept separate. Missing evidence stays visible." }: { eyebrow: string; description?: string }) {
  const list = useApi<{ id: string; title: string; code: string }[]>("/scorecards");
  const [selected, setSelected] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const trainingId = selected || list.data?.[0]?.id || "";
  const card = useApi<Scorecard>(trainingId ? `/scorecards/${trainingId}${toQuery(filters)}` : null);
  return (
    <>
      <PageTitle eyebrow={eyebrow} title="Training Learning & Behaviour Scorecard" description={description} action={<div className="row wrap">{trainingId ? <ExportButtons code="scorecard" filters={{ ...filters, training_id: trainingId }} /> : null}</div>} />
      <Loaded state={list}>
        {(items) =>
          items.length ? (
            <>
              <section className="panel">
                <SelectField label="Training programme" value={trainingId} onChange={(e) => setSelected(e.target.value)} options={items.map((t) => ({ value: t.id, label: t.title }))} />
                <FilterBar filters={filters} onApply={setFilters} />
              </section>
              <Loaded state={card}>{(data) => <ScorecardBody card={data} />}</Loaded>
            </>
          ) : (
            <Empty title="No training records in your scope yet." hint="Scorecards appear once employees are assigned." />
          )
        }
      </Loaded>
    </>
  );
}
