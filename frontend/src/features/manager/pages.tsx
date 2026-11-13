"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { Badge, Btn, BtnLink, DataTable, Loaded, Metrics, PageTitle, Person, SelectField, TextField } from "@/components/ui";
import { ReviewFormPage, ReviewTable } from "@/features/behaviour/ReviewForm";
import { MonthlyTrend } from "@/features/dashboard/charts";
import { ActionItem, EvidenceHelp, EvidenceTiles, GoodMorning, ImageMetrics, Panel, ScorecardCta, ScoreTag, TrainingProgress, ViewAll, Welcome } from "@/features/dashboard/widgets";
import { ScorecardPage } from "@/features/reports/ScorecardView";
import { toQuery } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import type { BehaviourMeans, ReviewSummary, Summary, TeamRow, TrendPoint } from "@/lib/types";
import { day, firstName, percent } from "@/lib/utils";

const EYEBROW = "MANAGER";

interface Dashboard {
  summary: Summary;
  trend: TrendPoint[];
  team_status: TeamRow[];
  behaviour: BehaviourMeans;
  reviews_due: number;
  reviews_overdue: number;
  reviews_due_soon: number;
  assessments_due_this_week: number;
}

export function ManagerDashboard() {
  const { user } = useSession();
  const state = useApi<Dashboard>("/manager/dashboard");
  return (
    <Loaded state={state}>
      {(d) => {
        return (
          <div className="reference-dashboard image-role-dashboard manager-image-dashboard">
            <Welcome heading={<GoodMorning name={firstName(user?.full_name ?? "")} />} description="Here’s your team’s training and performance summary." />
            <ImageMetrics
              cards={[
                ["users", "Team Size", d.summary.employees, "purple", "Authorised employees"],
                ["check", "Completed", d.summary.assessed, "green", "Submitted assessments"],
                ["clock", "Pending", d.summary.pending_assessment, "amber", "No submitted assessment"],
                ["cross", "Not Passed", d.summary.not_passed, "red", "Assessment outcomes"],
                ["cap", "Team Pass Rate", percent(d.summary.pass_rate), "blue", "Passed / assessed outcomes"],
              ]}
            />
            <div className="image-primary-grid manager-primary">
              <Panel title={<>Team Learning & Behaviour <span className="heading-note">(Evidence)</span></>} action={<EvidenceHelp />}>
                <EvidenceTiles learning={d.summary.mean_latest_score} assessed={d.summary.assessed} behaviour={d.behaviour} />
              </Panel>
              <Panel title="Team Training Progress">
                <TrainingProgress summary={d.summary} />
              </Panel>
              <Panel title="Team Performance Trend">
                <MonthlyTrend points={d.trend} />
              </Panel>
            </div>
            <div className="manager-secondary-grid">
              <Panel title="Action Items for You" action={<ViewAll href="/manager/reviews" />}>
                <ActionItem icon="clipboard" heading={`${d.reviews_due} Behaviour Reviews Pending`} description="Complete L3 observations for your team." href="/manager/reviews" label="Review" />
                <ActionItem icon="users" heading={`${d.summary.not_passed_employees} Employees Not Passed`} description="Support with refresher and retake guidance." href="/manager/assessments?result=NOT_PASSED" label="Take Action" tone="attention" />
                <ActionItem icon="calendar" heading="Assessments Due This Week" description={`${d.assessments_due_this_week} team assessment(s) due by the end of the next 7 days.`} href="/manager/assessments" label="Follow Up" tone="attention" />
              </Panel>
            </div>
            <div className="manager-bottom-grid">
              <section className="review-count-strip">
                <span className="course-glyph">
                  <Icon name="calendar" />
                </span>
                <div>
                  <h2>Upcoming & Overdue Reviews</h2>
                  <div className="review-counts">
                    <span>
                      <strong>{d.reviews_due_soon}</strong>
                      <small>Due in 7 Days</small>
                    </span>
                    <span>
                      <strong>{d.reviews_overdue}</strong>
                      <small>Overdue</small>
                    </span>
                  </div>
                </div>
              </section>
              <ScorecardCta heading="Learning & Behaviour Scorecard" description="View your team’s learning and behaviour evidence." href="/manager/scorecards" />
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}

function teamColumns(r: TeamRow, open: (id: string) => void) {
  return [
    <Person key="p" name={r.employee_name} />,
    r.employee_code,
    r.department ?? "—",
    r.training_title,
    r.latest_score === null ? "Not collected" : `${r.latest_score}%`,
    r.attempts,
    r.result,
    day(r.last_submitted_at, "Not submitted"),
    <Btn key="v" kind="text" onClick={() => open(r.employee_id)}>
      View Details
    </Btn>,
  ];
}

function AssessmentsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [filters, setFilters] = useState({ search: "", training_id: "", result: params.get("result") ?? "" });
  const state = useApi<TeamRow[]>(`/manager/team-assessments${toQuery(filters)}`);
  const trainings = useApi<{ training_id: string; title: string }[]>("/manager/team-trainings");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const v = new FormData(event.currentTarget);
    setFilters({ search: String(v.get("search") ?? ""), training_id: String(v.get("training_id") ?? ""), result: String(v.get("result") ?? "") });
  };
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Assessment Performance" description="Only employees in your current authorised reporting team appear here." />
      <section className="panel">
        <form className="filters" onSubmit={submit}>
          <TextField label="Search" name="search" placeholder="Name, employee ID or training" defaultValue={filters.search} />
          <SelectField label="Training" name="training_id" placeholder="All training" options={(trainings.data ?? []).map((t) => ({ value: t.training_id, label: t.title }))} defaultValue={filters.training_id} />
          <SelectField label="Result" name="result" placeholder="All results" options={[["PENDING", "Pending"], ["PASSED", "Passed"], ["NOT_PASSED", "Not Passed"], ["NEEDS_RETRAINING", "Needs Re-training"]].map(([value, label]) => ({ value, label }))} defaultValue={filters.result} />
          <button className="btn secondary" type="submit">
            Apply filters
          </button>
        </form>
        <Loaded state={state}>{(rows) => <DataTable headers={["Employee", "Employee ID", "Department", "Training", "Latest Score", "Attempts", "Status", "Last Assessment", ""]} rows={rows.map((r) => teamColumns(r, (id) => router.push(`/manager/team/${id}`)))} />}</Loaded>
      </section>
    </>
  );
}

export function ManagerAssessments() {
  return (
    <Suspense>
      <AssessmentsInner />
    </Suspense>
  );
}

export function MyTeam() {
  const state = useApi<(Summary & { employee_id: string; employee_name: string; employee_code: string; department: string | null; function: string | null; grade: string | null })[]>("/manager/team-employees");
  const router = useRouter();
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="My Team" description="Only employees in your current authorised reporting team appear here." />
      <section className="panel">
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Employee", "Employee ID", "Department", "Function", "Grade", "Assigned", "Completed", "Pass Rate", ""]}
              emptyTitle="No employees are currently assigned to you."
              rows={rows.map((p) => [
                <Person key="p" name={p.employee_name} />,
                p.employee_code,
                p.department ?? "—",
                p.function ?? "—",
                p.grade ?? "—",
                p.assignments,
                p.completed,
                <ScoreTag key="s" value={p.pass_rate} />,
                <Btn key="v" kind="text" onClick={() => router.push(`/manager/team/${p.employee_id}`)}>
                  View Details
                </Btn>,
              ])}
            />
          )}
        </Loaded>
      </section>
    </>
  );
}

export function PendingReviews() {
  const state = useApi<ReviewSummary[]>("/manager/behaviour-reviews");
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Pending Behaviour Reviews" description="Level 3 observation tasks for your current team. Self and manager reviews use the same competencies." />
      <section className="panel">
        <Loaded state={state}>{(rows) => <ReviewTable rows={rows.filter((r) => r.status !== "SUBMITTED")} base="/manager/reviews" showEmployee emptyTitle="No behaviour reviews are open." />}</Loaded>
      </section>
    </>
  );
}

export function Questionnaires() {
  const state = useApi<ReviewSummary[]>("/manager/behaviour-reviews");
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Behaviour Questionnaires" description="Observations you have submitted. They stay with you if an employee later moves team." />
      <section className="panel">
        <Loaded state={state}>{(rows) => <ReviewTable rows={rows.filter((r) => r.status === "SUBMITTED")} base="/manager/reviews" showEmployee emptyTitle="No observations submitted yet." />}</Loaded>
      </section>
    </>
  );
}

export function ManagerReview() {
  const { reviewId } = useParams<{ reviewId: string }>();
  return <ReviewFormPage reviewId={reviewId} kind="MANAGER" />;
}

interface MemberDetail {
  employee: { id: string; name: string; code: string; department: string | null; function: string | null; location: string | null; grade: string | null };
  summary: Summary;
  trainings: (TeamRow & { attempts_detail: { number: number; score: number; result: string; submitted_at: string }[] })[];
  follow_ups: { training: string; period_days: number; due_at: string; self: number | null; manager: number | null; manager_status: string; manager_review_id: string }[];
}

export function TeamMember() {
  const { employeeId } = useParams<{ employeeId: string }>();
  const state = useApi<MemberDetail>(`/manager/team/${employeeId}`);
  return (
    <Loaded state={state}>
      {(d) => (
        <>
          <PageTitle eyebrow={EYEBROW} title={d.employee.name} description={`${d.employee.code} · ${d.employee.department ?? "No department"} · ${d.employee.function ?? "No function"} · ${d.employee.grade ?? "No grade"}`} />
          <Metrics
            items={[
              ["Assigned", d.summary.assignments, "Training records"],
              ["Pass rate", percent(d.summary.pass_rate, "Not collected"), "Passed / assessed"],
              ["Needs Re-training", d.summary.needs_retraining_employees ? "Yes" : "No", "Learning follow-up"],
            ]}
          />
          <section className="panel">
            <h2>Training and assessment</h2>
            <DataTable
              headers={["Training", "Completed", "Result", "First", "Best", "Latest", "Attempts"]}
              emptyTitle="No training assigned."
              rows={d.trainings.map((t) => [t.training_title, day(t.completed_at), t.result, percent(t.first_score, "Not collected"), percent(t.best_score, "Not collected"), percent(t.latest_score, "Not collected"), t.attempts])}
            />
            <p className="small">Results are read-only. First and best scores remain distinct. Individual answers are not shown in manager views.</p>
          </section>
          <section className="panel">
            <h2>Behaviour follow-ups</h2>
            <DataTable
              headers={["Training", "Period", "Due", "Self /5", "Manager /5", "Gap", "Status", ""]}
              emptyTitle="No follow-ups yet."
              rows={d.follow_ups.map((f) => [
                f.training,
                `${f.period_days} days`,
                day(f.due_at),
                f.self ?? "Not collected",
                f.manager ?? "Not collected",
                f.self !== null && f.manager !== null ? Number((f.manager - f.self).toFixed(2)) : "Not comparable",
                <Badge key="b" status={f.manager_status} />,
                f.manager_status === "NOT_DUE" ? null : (
                  <BtnLink key="l" href={`/manager/reviews/${f.manager_review_id}`} kind="text">
                    {f.manager_status === "SUBMITTED" ? "View" : "Complete"}
                  </BtnLink>
                ),
              ])}
            />
          </section>
        </>
      )}
    </Loaded>
  );
}

export function ManagerScorecards() {
  return <ScorecardPage eyebrow={EYEBROW} description="Only your team’s learning and behaviour evidence." />;
}
