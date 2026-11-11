"use client";

import { DataTable, Loaded, PageTitle } from "@/components/ui";
import { MonthlyTrend } from "@/features/dashboard/charts";
import { EvidenceHelp, EvidenceTiles, GoodMorning, ImageMetrics, Panel, ScorecardCta, ScoreTag, TrainingProgress, ViewAll, Welcome } from "@/features/dashboard/widgets";
import { ReportPanel, ReportsHub } from "@/features/reports/ReportView";
import { ScorecardPage } from "@/features/reports/ScorecardView";
import { useApi, useSession } from "@/lib/hooks";
import type { Summary, TrendPoint } from "@/lib/types";
import { firstName, percent } from "@/lib/utils";

const EYEBROW = "HR / LEADERSHIP";

type DepartmentRow = { department: string } & Summary;

interface Analytics {
  summary: Summary;
  departments: DepartmentRow[];
  functions: ({ function: string } & Summary)[];
  topics: { topic: string; score: number | null }[];
  weakest_questions: { question: string; topic: string; responses: number; correct_percent: number | null }[];
  behaviour_trend: { period_days: number; self_mean: number | null; manager_mean: number | null; self_count: number; manager_count: number }[];
  trend: TrendPoint[];
}

export function HrOverview() {
  const { user } = useSession();
  const state = useApi<Analytics>("/reports/analytics");
  return (
    <Loaded state={state}>
      {(d) => {
        const s = d.summary;
        const latest = d.behaviour_trend.at(-1);
        return (
          <div className="reference-dashboard image-role-dashboard hr-image-dashboard">
            <Welcome heading={<GoodMorning name={firstName(user?.full_name ?? "")} />} description="Organisation training insights: what employees learned and how they apply it." />
            <ImageMetrics
              cards={[
                ["users", "Employees in Scope", s.employees, "purple", "With training assigned"],
                ["cap", "Trained Employees", s.trained_employees, "blue", "Recorded training completion"],
                ["check", "Training Completion", percent(s.completion_rate), "green", "Completed / assigned records"],
                ["target", "Assessment Pass Rate", percent(s.pass_rate), "red", "Passed / assessed outcomes"],
                ["question", "Needs Re-training", s.needs_retraining_employees, "amber", "Employees with final-failure flags"],
              ]}
            />
            <div className="image-primary-grid hr-primary">
              <Panel title={<>Learning & Behaviour <span className="heading-note">(Evidence)</span></>} action={<EvidenceHelp />}>
                <EvidenceTiles learning={s.mean_latest_score} assessed={s.assessed} behaviour={latest ? { self_mean: latest.self_mean, manager_mean: latest.manager_mean, self_count: latest.self_count, manager_count: latest.manager_count } : null} />
              </Panel>
              <Panel title="Organisation Training Progress">
                <TrainingProgress summary={s} />
              </Panel>
              <Panel title={<>Training Trend <small>(Recorded Months)</small></>}>
                <MonthlyTrend points={d.trend} />
              </Panel>
            </div>
            <div className="hr-secondary-grid">
              <Panel title="Department Performance" action={<ViewAll href="/hr/departments" />}>
                <DataTable all headers={["Department", "Trained", "Completion", "Pass Rate"]} rows={d.departments.map((x) => [x.department, x.trained_employees, <ScoreTag key="c" value={x.completion_rate} />, <ScoreTag key="p" value={x.pass_rate} />])} />
              </Panel>
              <Panel title="Topic Learning Gaps" action={<ViewAll href="/hr/learning" />}>
                {d.topics.length ? (
                  d.topics.slice(0, 5).map((t) => (
                    <div className="topic-row" key={t.topic}>
                      <span>{t.topic}</span>
                      <progress value={t.score ?? 0} max={100} aria-label={t.topic} />
                      <strong>{t.score === null ? "—" : `${t.score}%`}</strong>
                    </div>
                  ))
                ) : (
                  <div className="quiet-empty">Not collected. No submitted responses yet.</div>
                )}
              </Panel>
              <Panel title="Behaviour Improvement" action={<ViewAll href="/hr/behaviour" />}>
                {d.behaviour_trend.length ? (
                  <DataTable all headers={["Follow-up", "Self /5", "Manager /5"]} rows={d.behaviour_trend.map((p) => [`${p.period_days} days`, p.self_mean ?? "Not collected", p.manager_mean ?? "Not collected"])} />
                ) : (
                  <div className="quiet-empty">Not yet due. Follow-ups start 30 days after completion.</div>
                )}
              </Panel>
            </div>
            <ScorecardCta heading="Training Learning & Behaviour Scorecard" description="View learning and behaviour evidence for all your authorised trainings." href="/hr/scorecards" label="View Scorecards" />
          </div>
        );
      }}
    </Loaded>
  );
}

export function LearningPerformance({ eyebrow = EYEBROW }: { eyebrow?: string }) {
  const state = useApi<Analytics>("/reports/analytics");
  return (
    <>
      <PageTitle eyebrow={eyebrow} title="Learning Performance" description="Function comparison, topic-wise gaps and the questions employees miss most." />
      <Loaded state={state}>
        {(d) => (
          <>
            <section className="panel">
              <h2>By function</h2>
              <DataTable headers={["Function", "Employees", "Completion", "Assessed", "Pass Rate", "Mean Latest Score", "Needs Re-training"]} rows={d.functions.map((f) => [f.function, f.employees, <ScoreTag key="c" value={f.completion_rate} />, f.assessed, <ScoreTag key="p" value={f.pass_rate} />, percent(f.mean_latest_score, "Not collected"), f.needs_retraining_employees])} />
            </section>
            <section className="panel">
              <h2>Topic-wise learning gaps</h2>
              <p className="small">Lowest scores first. Calculated from marks in submitted post-test attempts.</p>
              <DataTable headers={["Topic", "Score"]} emptyTitle="Not collected." rows={d.topics.map((t) => [t.topic, <ScoreTag key="s" value={t.score} />])} />
            </section>
            <section className="panel">
              <h2>Most-missed questions</h2>
              <DataTable headers={["Question", "Topic", "Responses", "Correct %"]} emptyTitle="Not collected." rows={d.weakest_questions.map((q) => [q.question, q.topic, q.responses, q.correct_percent ?? "—"])} />
            </section>
          </>
        )}
      </Loaded>
    </>
  );
}

export function DepartmentPerformance() {
  const state = useApi<Analytics>("/reports/analytics");
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Department-wise Training Performance" description="Assignment, completion and assessment results by department." />
      <section className="panel">
        <Loaded state={state}>
          {(d) => (
            <DataTable
              headers={["Department", "Employees", "Assigned", "Completed", "Completion", "Assessed", "Pass Rate", "Not Passed", "Needs Re-training"]}
              rows={d.departments.map((x) => [x.department, x.employees, x.assignments, x.completed, <ScoreTag key="c" value={x.completion_rate} />, x.assessed, <ScoreTag key="p" value={x.pass_rate} />, x.not_passed, x.needs_retraining_employees])}
            />
          )}
        </Loaded>
      </section>
    </>
  );
}

function ReportPage({ title, description, code }: { title: string; description: string; code: string }) {
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title={title} description={description} />
      <ReportPanel code={code} />
    </>
  );
}

export const PassFail = () => <ReportPage title="Assessment Pass/Fail" description="Results, first and best scores, attempts and red-flag employees." code="pass-fail" />;
export const LearningGain = () => <ReportPage title="Learning Gain" description="Matched pre-test and first post-test scores. A missing pre-test is never treated as zero." code="learning-gain" />;
export const BehaviourImprovement = () => <ReportPage title="Behaviour Improvement" description="Self and manager ratings by competency and 30/60/90-day period." code="behaviour" />;

export function ManagerEvaluation() {
  const state = useApi<{ manager: string; employee_code: string; team_size: number; observations_due: number; observations_submitted: number; observations_overdue: number; completion_rate: number | null; mean_rating_given: number | null }[]>("/reports/manager-evaluation");
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Manager Evaluation Performance" description="How far each manager has completed assigned behaviour observations. This describes task completion, not the manager's own performance rating." />
      <section className="panel">
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Manager", "Team Size", "Observations Due", "Submitted", "Overdue", "Completion", "Mean Rating Given"]}
              emptyTitle="No managers with teams yet."
              rows={rows.map((m) => [m.manager, m.team_size, m.observations_due, m.observations_submitted, m.observations_overdue, m.completion_rate === null ? "Not yet due" : <ScoreTag key="c" value={m.completion_rate} />, m.mean_rating_given ?? "Not collected"])}
            />
          )}
        </Loaded>
      </section>
    </>
  );
}

export const HrScorecards = () => <ScorecardPage eyebrow={EYEBROW} />;

export function HrReports({ eyebrow = EYEBROW }: { eyebrow?: string }) {
  return (
    <>
      <PageTitle eyebrow={eyebrow} title="Reports & Exports" description="Select any report. Every export uses the same scope and filters as the screen." />
      <ReportsHub />
    </>
  );
}
