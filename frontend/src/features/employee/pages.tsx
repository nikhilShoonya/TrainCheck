"use client";

import { useParams } from "next/navigation";
import { Icon } from "@/components/icons";
import { Badge, Btn, BtnLink, DataTable, Empty, Loaded, Loading, PageTitle, useToast } from "@/components/ui";
import { ReviewFormPage, ReviewTable } from "@/features/behaviour/ReviewForm";
import { ScoreTrend, type ScorePoint } from "@/features/dashboard/charts";
import { cardEntry } from "@/features/exam/assessmentEntry";
import { EvidenceHelp, EvidenceTiles, Glyph, GoodMorning, Panel, RecentRow, ScoreTag, TrainingProgress, ViewAll, Welcome } from "@/features/dashboard/widgets";
import { ApiError, api } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import type { BehaviourMeans, ReviewSummary, Summary, TrainingCard } from "@/lib/types";
import { dateTimeIn, day, firstName, longDay, percent, ORG_TIMEZONE } from "@/lib/utils";

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
  const waiting = Boolean(data.retake?.refresher_acknowledged);
  const heading = data.retake ? (waiting ? "Waiting for L&D Approval" : "Your Next Step: Refresher & Retake") : data.upcoming ? "You Have an Upcoming Assessment" : "You’re Up to Date with Your Assessments";
  const text = data.retake ? (waiting ? "You acknowledged the refresher. Your re-attempt opens once L&D approves it." : "Review and acknowledge the refresher. L&D will then approve your re-attempt.") : data.upcoming ? `Your questionnaire opens ${dateTimeIn(data.upcoming.due_at, data.upcoming.timezone)}.` : "Keep building your skills and track how you apply them at work.";
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
  const behaviourOn = Boolean(user?.features?.behaviour); // Level 3 is outside the approved scope while off.
  return (
    <Loaded state={state}>
      {(d) => (
        <div className="reference-dashboard">
          <Welcome heading={<GoodMorning name={firstName(user?.full_name ?? "")} />} description="Continue your learning journey and track how you apply it at work." />
          <AssessmentBanner data={d} />
          <div className="dashboard-row dashboard-row-top">
            <Panel title={<>{behaviourOn ? "Learning & Behaviour" : "Learning"} <span className="heading-note">(Evidence)</span></>} action={<EvidenceHelp />} className="effectiveness-panel">
              <EvidenceTiles learning={d.summary.mean_latest_score} assessed={d.summary.assessed} behaviour={d.behaviour} behaviourEnabled={behaviourOn} />
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
                        <strong>{date.toLocaleDateString("en", { day: "numeric", timeZone: ORG_TIMEZONE })}</strong>
                        <span>{date.toLocaleDateString("en", { month: "short", timeZone: ORG_TIMEZONE })}</span>
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
                  ...(behaviourOn ? [["hourglass", d.reviews_due, "Reviews Due"]] : []),
                  // Only completed training has an assessment to take; unfinished training is counted above.
                  ["target", d.summary.awaiting_assessment ?? d.summary.pending_assessment, "Assessment Pending"],
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
                <h2>Learning Scorecard</h2>
                <p>View your own learning evidence.</p>
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
              {/* The server lists pending assessments first (due, then upcoming, then unfinished, then finished). */}
              {cards.map((c, i) => {
                const entry = cardEntry(c);
                return (
                <article className="panel course-card training-card" key={c.enrolment_id}>
                  <div className="training-card-head">
                    <Glyph index={i} />
                    <div className="training-card-title">
                      <Badge status={c.result} />
                      <h2>{c.title}</h2>
                      {c.description ? <p>{c.description}</p> : null}
                    </div>
                  </div>
                  {c.question_count || c.batch ? (
                    <div className="training-card-meta">
                      {c.question_count ? (
                        <>
                          <span className="questions"><Icon name="list" /> {c.question_count} questions</span>
                          <span><Icon name="clock" /> {c.duration_minutes} minutes</span>
                        </>
                      ) : null}
                      {c.batch ? <span><Icon name="users" /> {c.batch}</span> : null}
                    </div>
                  ) : null}
                  <dl className="training-card-scores">
                    {([["First score", c.first_score], ["Best score", c.best_score], ...(c.pre_test_score !== null ? [["Pre-test", c.pre_test_score]] : [])] as [string, number | null][]).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd className={value === null ? "missing" : undefined}>{percent(value, "Not collected")}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className={`training-card-done${c.completed_at ? " done" : ""}`}>
                    <Icon name={c.completed_at ? "checkCircle" : "hourglass"} />
                    {c.completed_at ? `Training completed · ${longDay(c.completed_at)}` : "Training assigned · completion not recorded"}
                  </p>
                  {c.materials.length ? (
                    <p className="training-card-materials">
                      {c.materials.map((m) => (
                        <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer">
                          {m.title}{" "}
                        </a>
                      ))}
                    </p>
                  ) : null}
                  <div className="training-card-foot">
                  {entry.status ? (
                    <div className={`training-card-status${c.entry_state === "UNAVAILABLE" && c.entry_reason === "COMPLETED" ? " finished" : ""}`}>
                      <strong>
                        {c.entry_state === "UNAVAILABLE" && c.entry_reason === "COMPLETED" ? <Icon name="check" /> : null}
                        {entry.status}
                      </strong>
                      {entry.note ? <small>{entry.note}</small> : null}
                    </div>
                  ) : null}
                  <div className="row wrap">
                    {entry.href ? (
                      <BtnLink href={entry.href} kind="primary">
                        {entry.label} <Icon name="arrow" />
                      </BtnLink>
                    ) : null}
                    {c.latest_attempt_id ? (
                      <BtnLink href={`/results/${c.latest_attempt_id}`} kind={entry.href ? "secondary" : "primary"}>
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
                  </div>
                </article>
                );
              })}
            </section>
          ) : (
            <Empty title="No training is assigned to you right now." hint="Assigned training will appear here." />
          )
        }
      </Loaded>
    </>
  );
}

/** The next step for one assessment. After a failure the next attempt waits for the refresher and L&D approval.
    Moments are shown as local date and time in the organisation timezone, which is named. */
function nextDue(c: TrainingCard): string {
  const when = (iso: string) => dateTimeIn(iso, c.timezone);
  if (["Refresher required", "Waiting for L&D approval"].includes(c.assessment_state)) return c.assessment_state;
  if (["Scheduled", "Due", "Overdue", "In progress"].includes(c.assessment_state)) return c.due_at ? when(c.due_at) : c.assessment_state;
  if (c.attempts) return "Submitted";
  if (c.due_at) return when(c.due_at);
  // No assessment yet. Say what it waits for instead of "Not scheduled".
  if (!c.completed_at) return c.planned_at ? `Opens ${when(c.planned_at)}, once your training completion is recorded` : "After your training completion is recorded";
  return "Being scheduled by L&D";
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
                nextDue(c),
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
      toast("Refresher acknowledged. L&D has been asked to approve your re-attempt.");
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
                      {c.refresher_acknowledged ? "Acknowledged · waiting for L&D approval" : "Acknowledge refresher"}
                    </Btn>
                  ) : c.result === "NEEDS_RETRAINING" ? (
                    <p className="notice">You have used all attempts. Waiting for L&amp;D approval of your re-training.</p>
                  ) : ["Due", "Overdue", "In progress"].includes(c.assessment_state) ? (
                    <p className="notice">L&amp;D has approved your re-attempt. Take it from My Assessments.</p>
                  ) : null}
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
  const state = useApi<{ training: string; result: string; pre_test: number | null; first_score: number | null; best_score: number | null; test_score: number | null; feedback_score: number | null }[]>("/me/scorecard");
  if (state.loading && !state.data) return <Loading />;
  return (
    <>
      <PageTitle eyebrow={EYEBROW} title="My Learning & Behaviour Scorecard" description="Your own evidence. Missing evidence stays visible." />
      <section className="panel">
        <Loaded state={state}>
          {(rows) => (
            <DataTable
              headers={["Training", "Result", "Pre-test", "First", "Best", "Test score", "Feedback score"]}
              emptyTitle="No evidence yet."
              rows={rows.map((r) => [
                r.training,
                r.result,
                percent(r.pre_test, "Not collected"),
                percent(r.first_score, "Not collected"),
                percent(r.best_score, "Not collected"),
                percent(r.test_score, "Not collected"),
                r.feedback_score === null ? "Not given" : `${r.feedback_score} / 5`,
              ])}
            />
          )}
        </Loaded>
      </section>
      <div className="notice">A passed quiz is evidence of learning, not proof of workplace behaviour change. Ratings do not determine an employment outcome.</div>
    </>
  );
}
