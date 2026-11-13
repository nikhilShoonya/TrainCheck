"use client";

import { useParams } from "next/navigation";
import { Icon } from "@/components/icons";
import { Badge, Btn, BtnLink, DataTable, Empty, Loaded, Loading, PageTitle, useToast } from "@/components/ui";
import { ReviewFormPage, ReviewTable } from "@/features/behaviour/ReviewForm";
import { ScoreTrend, type ScorePoint } from "@/features/dashboard/charts";
import { EvidenceHelp, EvidenceTiles, Glyph, GoodMorning, Panel, RecentRow, ScoreTag, TrainingProgress, ViewAll, Welcome } from "@/features/dashboard/widgets";
import { ApiError, api } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import type { BehaviourMeans, ReviewSummary, Summary, TrainingCard } from "@/lib/types";
import { day, firstName, percent } from "@/lib/utils";

const EYEBROW = "EMPLOYEE";

interface Dashboard {
  summary: Summary;
  overall_score: number | null;
  trend_points: ScorePoint[];
  recent: TrainingCard[];
  calendar: { date: string; title: string; tag: string; link: string }[];
  retake: TrainingCard | null;
  upcoming: TrainingCard | null;
  behaviour: BehaviourMeans;
  reviews_due: number;
}

function AssessmentBanner({ data }: { data: Dashboard }) {
  const target = data.retake ?? data.upcoming;
  const heading = data.retake ? "Your Next Step: Refresher & Retake" : data.upcoming ? "You Have an Upcoming Assessment" : "You’re Up to Date with Your Assessments";
  const text = data.retake ? "Revisit the material before your next eligible assessment." : data.upcoming ? `Your questionnaire opens on ${day(data.upcoming.due_at)}.` : "Keep building your skills and track how you apply them at work.";
  const href = data.retake ? "/employee/refresher" : data.upcoming ? "/employee/assessments" : "/employee/trainings";
  const label = data.retake ? "View Refresher" : data.upcoming ? "View Assessment" : "View My Training";
  return (
    <section className="assessment-banner">
      <span className="assessment-banner-icon">
        <Icon name={target ? "clipboard" : "check"} />
      </span>
      <div className="banner-copy">
        <h2>{heading}</h2>
        <p>{text}</p>
      </div>
      {target ? (
        <>
          <div className="banner-training">
            <small>Training</small>
            <strong>{target.title}</strong>
          </div>
          <div className="banner-fact">
            <Icon name="question" />
            <strong>{target.question_count ?? "—"}</strong>
            <small>Questions</small>
          </div>
          <div className="banner-fact">
            <Icon name="clock" />
            <strong>{target.duration_minutes ?? "—"}</strong>
            <small>Minutes</small>
          </div>
          <div className="banner-fact">
            <Icon name="target" />
            <strong>{target.pass_mark_percent ?? "—"}%</strong>
            <small>Pass Mark</small>
          </div>
        </>
      ) : (
        <span className="banner-status">
          <Icon name="shield" /> Learning verified
        </span>
      )}
      <BtnLink href={href} kind="primary">
        {label} <Icon name="arrow" />
      </BtnLink>
    </section>
  );
}

export function EmployeeDashboard() {
  const { user } = useSession();
  const state = useApi<Dashboard>("/me/dashboard");
  return (
    <Loaded state={state}>
      {(d) => (
        <div className="reference-dashboard">
          <Welcome heading={<GoodMorning name={firstName(user?.full_name ?? "")} />} description="Continue your learning journey and track how you apply it at work." />
          <AssessmentBanner data={d} />
          <div className="dashboard-row dashboard-row-top">
            <Panel title={<>Learning & Behaviour <span className="heading-note">(Evidence)</span></>} action={<EvidenceHelp />} className="effectiveness-panel">
              <EvidenceTiles learning={d.summary.mean_latest_score} assessed={d.summary.assessed} behaviour={d.behaviour} />
            </Panel>
            <Panel title="My Training Progress" className="progress-panel">
              <TrainingProgress summary={d.summary} />
            </Panel>
            <Panel title={<>Overall Learning Score <small>(Last 90 Days)</small></>} className="overall-panel">
              <div className="overall-score">{percent(d.overall_score)}</div>
              <ScoreTrend points={d.trend_points} spark />
              <p className="card-footnote">Mean latest L2 score per training.</p>
            </Panel>
          </div>
          <div className="dashboard-row dashboard-row-middle">
            <Panel title="Recent Trainings" action={<ViewAll href="/employee/trainings" />}>
              {d.recent.length ? (
                d.recent.map((c, i) => <RecentRow key={c.enrolment_id} index={i} href={c.latest_attempt_id ? `/results/${c.latest_attempt_id}` : "/employee/trainings"} title={c.title} sub={c.completed_at ? `Completed · ${day(c.completed_at)}` : "Assigned"} dot={c.completed_at ? "green" : "amber"} trailing={c.latest_score !== null ? <ScoreTag value={c.latest_score} /> : <Badge status="PENDING" />} />)
              ) : (
                <Empty title="No training assigned." hint="Your assigned training will appear here." />
              )}
            </Panel>
            <Panel title="My Performance Trend">
              <ScoreTrend points={d.trend_points} />
            </Panel>
            <Panel title="Training Calendar">
              {d.calendar.length ? (
                d.calendar.slice(0, 3).map((event) => {
                  const date = new Date(event.date);
                  return (
                    <a className="calendar-event" href={event.link} key={event.title + event.date}>
                      <time dateTime={event.date}>
                        <strong>{date.getUTCDate()}</strong>
                        <span>{date.toLocaleDateString("en", { month: "short", timeZone: "UTC" })}</span>
                      </time>
                      <span>
                        <strong>{event.title}</strong>
                        <small>{event.tag}</small>
                      </span>
                    </a>
                  );
                })
              ) : (
                <div className="quiet-empty">No upcoming events in your current assignments.</div>
              )}
            </Panel>
          </div>
          <div className="dashboard-row dashboard-row-bottom">
            <section className="dashboard-statistics">
              {(
                [
                  ["book", d.summary.assignments, "Total Trainings"],
                  ["check", d.summary.completed, "Completed"],
                  ["hourglass", d.reviews_due, "Reviews Due"],
                  ["target", d.summary.pending_assessment, "Assessment Pending"],
                ] as [string, number, string][]
              ).map(([icon, value, text]) => (
                <div key={text}>
                  <Icon name={icon} />
                  <span>
                    <strong>{value}</strong>
                    <small>{text}</small>
                  </span>
                </div>
              ))}
            </section>
            <section className="scorecard-cta">
              <span className="scorecard-medal">
                <Icon name="award" />
              </span>
              <div>
                <h2>Learning & Behaviour Scorecard</h2>
                <p>View your own learning and behaviour evidence.</p>
              </div>
              <BtnLink href="/employee/scorecard">
                View Scorecard <Icon name="arrow" />
              </BtnLink>
            </section>
          </div>
          <p className="dashboard-data-note">Missing evidence is never replaced by zero.</p>
        </div>
      )}
    </Loaded>
  );
}

export function MyTrainings() {
  const state = useApi<TrainingCard[]>("/me/trainings");
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="My Trainings" description="Your assigned learning, completion and assessment outcomes." />
      <Loaded state={state}>
        {(cards) =>
          cards.length ? (
            <section className="course-grid personal-courses">
              {cards.map((c, i) => (
                <article className="panel course-card" key={c.enrolment_id}>
                  <div className="row between">
                    <Glyph index={i} />
                    <Badge status={c.result} />
                  </div>
                  <h2>{c.title}</h2>
                  <p>{c.description}</p>
                  <div className="course-meta">
                    <span>{c.batch ?? "No batch"}</span>
                    {c.question_count ? (
                      <span>
                        {c.question_count} questions · {c.duration_minutes} minutes
                      </span>
                    ) : null}
                  </div>
                  <p>
                    <small>
                      Training: {c.completed_at ? `Completed ${day(c.completed_at)}` : "Assigned · completion not recorded"}
                      <br />
                      First score {percent(c.first_score, "Not collected")} · Best {percent(c.best_score, "Not collected")}
                      {c.pre_test_score !== null ? ` · Pre-test ${c.pre_test_score}%` : ""}
                    </small>
                  </p>
                  {c.materials.length ? (
                    <p>
                      {c.materials.map((m) => (
                        <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer">
                          {m.title}{" "}
                        </a>
                      ))}
                    </p>
                  ) : null}
                  <div className="row wrap">
                    {c.latest_attempt_id ? (
                      <BtnLink href={`/results/${c.latest_attempt_id}`} kind="primary">
                        View Result
                      </BtnLink>
                    ) : null}
                    {c.retake_pending ? (
                      <BtnLink href="/employee/refresher" tone="attention">
                        Refresher
                      </BtnLink>
                    ) : null}
                    {c.pre_test_available ? <BtnLink href={`/assessment/pre-test/${c.enrolment_id}`}>Take Pre-test</BtnLink> : null}
                  </div>
                </article>
              ))}
            </section>
          ) : (
            <Empty title="No training is assigned to you right now." hint="Assigned training will appear here." />
          )
        }
      </Loaded>
    </>
  );
}

export function MyAssessments() {
  const state = useApi<TrainingCard[]>("/me/trainings");
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="My Assessments" description="Results, scheduled questionnaires and the next learning step." />
      <section className="panel">
        <Loaded state={state}>
          {(cards) => (
            <DataTable
              headers={["Training", "Completion", "Next due date", "Result", "Attempts", ""]}
              emptyTitle="No assessments yet."
              emptyHint="An assessment is scheduled when your training completion is recorded."
              rows={cards.map((c) => [
                c.title,
                day(c.completed_at),
                c.retake_pending ? "Next eligible sign-in after refresher" : c.attempts ? "Submitted" : c.due_at ? day(c.due_at) : "Not scheduled",
                c.result,
                c.attempts,
                c.latest_attempt_id ? (
                  <BtnLink key="r" href={`/results/${c.latest_attempt_id}`} kind="text">
                    View Result
                  </BtnLink>
                ) : (
                  <span key="r" className="muted">
                    {c.assessment_state}
                  </span>
                ),
              ])}
            />
          )}
        </Loaded>
      </section>
    </>
  );
}

export function MyRefresher() {
  const state = useApi<TrainingCard[]>("/me/refresher-materials");
  const toast = useToast();
  const acknowledge = async (obligationId: string) => {
    try {
      await api.post(`/assessment-obligations/${obligationId}/refresher-acknowledgement`);
      toast("Refresher acknowledged. Your retake becomes due at your next sign-in.");
      void state.reload();
    } catch (e) {
      toast((e as ApiError).message);
    }
  };
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Refresher Materials" description="Guidance for assessments you have not yet passed. Acknowledging records that you reviewed it; it is not proof of learning." />
      <Loaded state={state}>
        {(cards) =>
          cards.length ? (
            <>
              {cards.map((c) => (
                <section className="panel" key={c.enrolment_id}>
                  <div className="row between">
                    <h2>{c.title}</h2>
                    <Badge status={c.result} />
                  </div>
                  <p>{c.refresher_text ?? "L&D has not added refresher guidance for this training."}</p>
                  {c.refresher_url ? (
                    <p>
                      <a href={c.refresher_url} target="_blank" rel="noopener noreferrer">
                        Open refresher material
                      </a>
                    </p>
                  ) : null}
                  {c.materials.map((m) => (
                    <p key={m.id}>
                      <a href={m.url} target="_blank" rel="noopener noreferrer">
                        {m.title}
                      </a>
                    </p>
                  ))}
                  {c.retake_pending ? (
                    <Btn tone="attention" disabled={c.refresher_acknowledged} onClick={() => void acknowledge(c.obligation_id!)}>
                      {c.refresher_acknowledged ? "Acknowledged · sign in again for your retake" : "Acknowledge refresher"}
                    </Btn>
                  ) : (
                    <p className="notice">No further automatic retake is scheduled. L&D will arrange your next learning step.</p>
                  )}
                </section>
              ))}
            </>
          ) : (
            <Empty title="No refresher is needed right now." hint="Refresher guidance appears here after a Not Passed result." />
          )
        }
      </Loaded>
    </>
  );
}

function Reviews({ submitted }: { submitted: boolean }) {
  const state = useApi<ReviewSummary[]>("/me/behaviour-reviews");
  return (
    <section className="panel">
      <Loaded state={state}>{(rows) => <ReviewTable rows={rows.filter((r) => (r.status === "SUBMITTED") === submitted)} base="/employee/behaviour" showEmployee={false} emptyTitle={submitted ? "No self-assessments submitted yet." : "No self-assessments are open."} />}</Loaded>
    </section>
  );
}

export function MyBehaviour() {
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="Level 3 Self-Assessment" description="Rate how you apply the learned competencies in your daily work." />
      <Reviews submitted={false} />
    </>
  );
}

export function MyReview() {
  const { reviewId } = useParams<{ reviewId: string }>();
  return <ReviewFormPage reviewId={reviewId} />;
}

export function MyScorecard() {
  const state = useApi<{ training: string; result: string; pre_test: number | null; first_score: number | null; best_score: number | null; gain: number | null; gain_note: string | null; self_mean: number | null; manager_mean: number | null; self_reviews_due: number; self_reviews_done: number; behaviour_cycles: number }[]>("/me/scorecard");
  if (state.loading && !state.data) return <Loading />;
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="My Learning & Behaviour Scorecard" description="Your own evidence. Missing evidence stays visible." />
      <section className="panel">
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Training", "Result", "Pre-test", "First", "Best", "Gain", "Self /5", "Manager /5", "Self-assessments"]}
              emptyTitle="No evidence yet."
              rows={rows.map((r) => [
                r.training,
                r.result,
                percent(r.pre_test, "Not collected"),
                percent(r.first_score, "Not collected"),
                percent(r.best_score, "Not collected"),
                r.gain === null ? (r.gain_note ?? "Not comparable") : `${r.gain > 0 ? "+" : ""}${r.gain} pts`,
                r.self_mean ?? "Not collected",
                r.manager_mean ?? "Not collected",
                r.behaviour_cycles ? `${r.self_reviews_done} of ${r.self_reviews_due} due` : "Not yet due",
              ])}
            />
          )}
        </Loaded>
      </section>
      <div className="notice">A passed quiz is evidence of learning, not proof of workplace behaviour change. Ratings do not determine an employment outcome.</div>
    </>
  );
}
