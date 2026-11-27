"use client";

/* The employee's induction (owner decision of 27 Nov 2026): required straight after sign-in, then the common induction
   feedback form, then the workspace. Reuses the secure start, the exam screen, the result styling and the feedback
   dialog; the attempt lives in the induction module's own tables (/me/induction). */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { FocusShell } from "@/components/shell/AppShell";
import { HOME, landingPath } from "@/components/shell/nav";
import { Badge, Btn, BtnLink, ErrorPanel, Loaded, Loading, Metrics, PageTitle, useToast } from "@/components/ui";
import { FeedbackDialog } from "@/features/exam/FeedbackForm";
import { SecureStart } from "@/features/exam/GateFlow";
import { VIOLATION_LABELS } from "@/features/exam/monitor";
import { ApiError, api } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import { browserStorage, clearPendingAnswers, countUnconfirmedAnswers } from "@/lib/pendingAnswers";
import type { AttemptView, InductionFeedbackView, InductionResult, MyInduction } from "@/lib/types";
import { dateTime, duration, firstName, greeting } from "@/lib/utils";
import { minutes, STATUS_LABEL } from "./inductionView";

const EXAM_PATHS = { api: "/me/induction/attempts", result: "/induction/result" };
const REASONS: Record<string, string> = { MANUAL: "Submitted by you", TIME_EXPIRED: "Submitted automatically when time ran out", VIOLATION_LIMIT: "Submitted automatically after security violations" };

/* ---------- /induction: the required assessment ---------- */

export function InductionGate() {
  const router = useRouter();
  const { user, ready, access } = useSession();
  const state = useApi<MyInduction>("/me/induction");
  const [secure, setSecure] = useState(false);
  const [running, setRunning] = useState<AttemptView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const mine = state.data;

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else if (access && access.access_status !== "INDUCTION_REQUIRED") router.replace(landingPath(user, access));
  }, [ready, user, access, router]);

  // A refresh or new tab during the attempt resumes it (full screen is entered again): never a second attempt.
  // Checked only while the start screens are not open: once the exam runs, a refreshed /me/induction (it reports the
  // attempt it just started) must not reopen the resume step over the running exam.
  const activeId = mine?.active_attempt_id ?? null;
  useEffect(() => {
    if (!activeId || secure) return;
    let current = true;
    api
      .get<AttemptView>(`${EXAM_PATHS.api}/${activeId}`)
      .then((attempt) => {
        if (!current) return;
        if (attempt.status === "IN_PROGRESS") {
          setRunning(attempt);
          setSecure(true);
        } else router.replace(EXAM_PATHS.result);
      })
      .catch((e) => current && setError(e as ApiError));
    return () => {
      current = false;
    };
  }, [activeId, secure, router]);

  if (!ready || !user || !access || state.loading && !mine) return <Loading label="Checking your induction…" />;
  if (state.error) {
    return (
      <FocusShell>
        <ErrorPanel error={state.error} retry={state.reload} />
      </FocusShell>
    );
  }
  if (!mine?.assigned || !mine.induction) return <Loading label="Opening your workspace…" />;
  const facts = mine.facts;

  if (secure && facts) {
    return (
      <SecureStart
        key={running ? "resume" : "new"}
        noun="induction assessment"
        trainingTitle={mine.induction.name}
        rules={{ require_fullscreen: facts.require_fullscreen, violation_limit: facts.violation_limit }}
        running={running}
        facts={[
          ["clipboard", "Assessment", "Common Induction Assessment"],
          ["file", "Questions", facts.question_count],
          ["clock", "Duration", minutes(facts.duration_seconds)],
          ["target", "Pass mark", `${facts.pass_mark_percent}% or higher`],
          ["refresh", "Attempt", "1 of 1"],
        ]}
        start={() => api.post<AttemptView>("/me/induction/attempt", { instructions_acknowledged: true })}
        onStartFailed={(e) => {
          setError(e);
          setSecure(false);
          void state.reload();
        }}
        examPaths={EXAM_PATHS}
      />
    );
  }

  return (
    <FocusShell>
      <div className="gate-panel">
        <div className="gate-icon">
          <Icon name="cap" />
        </div>
        <span className="eyebrow">WELCOME TO YOUR INDUCTION</span>
        <h1 tabIndex={-1}>
          {greeting()}, {firstName(user.full_name)}.
        </h1>
        <p className="lead">Your induction assessment is required.</p>
        <p>Complete the induction assessment and the short induction feedback form before opening your TrainCheck workspace. You take the assessment once.</p>
        {error ? <ErrorPanel error={error} /> : null}
        <div className="gate-training">
          <span className="eyebrow">{mine.batch_label?.toUpperCase()}</span>
          <h2>{mine.induction.name}</h2>
          <p>{mine.induction.description ?? "Common Induction Assessment"}</p>
          {facts ? (
            <Metrics
              items={[
                ["Questions", facts.question_count, "One at a time"],
                ["Time limit", minutes(facts.duration_seconds), "Continues on refresh"],
                ["Pass mark", `${facts.pass_mark_percent}%`, "Inclusive threshold"],
              ]}
            />
          ) : null}
        </div>
        <Btn
          kind="wide"
          disabled={!facts}
          onClick={() => {
            setError(null);
            setSecure(true);
          }}
        >
          {/* A running attempt is resumed with its server deadline; starting again never resets it. */}
          {mine.active_attempt_id ? "Resume induction assessment" : "Start induction assessment"} <Icon name="arrow" />
        </Btn>
        <p className="small">You can review your answers before submitting. Unanswered questions receive no marks. The induction feedback form opens straight after.</p>
      </div>
    </FocusShell>
  );
}

/* ---------- /induction/result: result, then the required feedback ---------- */

export function InductionResultPage() {
  const router = useRouter();
  const { user, ready } = useSession();
  const toast = useToast();
  const mine = useApi<MyInduction>("/me/induction");
  const attemptId = mine.data?.attempt?.status && mine.data.attempt.status !== "IN_PROGRESS" ? mine.data.attempt.id : null;
  const result = useApi<InductionResult>(attemptId ? `${EXAM_PATHS.api}/${attemptId}/result` : null);
  const feedbackState = useApi<InductionFeedbackView>(attemptId ? "/me/induction/feedback" : null);
  const [saved, setSaved] = useState<InductionFeedbackView | null>(null);
  const [open, setOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const feedback = saved ?? feedbackState.data;
  const required = Boolean(feedback?.required) && !saved;

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else if (mine.data && (!mine.data.assigned || !mine.data.attempt || mine.data.attempt.status === "IN_PROGRESS")) router.replace(mine.data.assigned ? "/induction" : HOME[user.primary_role]);
  }, [ready, user, mine.data, router]);

  useEffect(() => {
    if (required && !autoOpened) {
      // The feedback form opens by itself once the server says it is still owed (a reload restores it).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoOpened(true);
      setOpen(true);
    }
  }, [required, autoOpened]);

  // Answers chosen on this device but never confirmed before the attempt finished: shown once, then removed.
  const accountId = user?.id ?? null;
  const unconfirmed = useMemo(() => (accountId && attemptId ? countUnconfirmedAnswers(browserStorage(), accountId, attemptId) : null), [accountId, attemptId]);
  const loaded = Boolean(result.data);
  useEffect(() => {
    if (accountId && attemptId && loaded) clearPendingAnswers(browserStorage(), accountId, attemptId);
  }, [accountId, attemptId, loaded]);

  const proceed = () => {
    if (required) {
      setOpen(true);
      return;
    }
    // A full load, so the session re-reads the gate decision instead of acting on the one from before.
    window.location.assign(user ? HOME[user.primary_role] : "/login");
  };

  if (mine.error || result.error) {
    return (
      <FocusShell>
        <ErrorPanel error={(mine.error ?? result.error) as ApiError} retry={() => window.location.reload()} />
      </FocusShell>
    );
  }
  const r = result.data;
  if (!r || !feedback) return <Loading label="Loading your induction result…" />;
  const passed = r.result_status === "PASSED";
  const completed = Boolean(saved) || r.induction_status === "COMPLETED";
  const feedbackDone = Boolean(saved) || r.feedback_submitted;
  const details: [string, string][] = [
    ["Score", `${r.obtained_marks} / ${r.total_marks} marks`],
    ["Percentage", `${r.score_percent}%`],
    ["Attempt", "1 of 1"],
    ["Submission", r.submission_reason === "VIOLATION_LIMIT" ? `Submitted automatically after ${r.violations.length} security violations` : (REASONS[r.submission_reason ?? ""] ?? "Submitted")],
    ["Time taken", r.time_taken_seconds !== null ? duration(r.time_taken_seconds) : "—"],
    ["Answered", `${r.answered_count} of ${r.question_count}`],
    ["Correct", `${r.correct_count} of ${r.question_count}`],
    ["Pass mark", `${r.pass_mark_percent}%`],
  ];
  return (
    <FocusShell>
      <div className="result-panel">
        <span className="eyebrow">INDUCTION ASSESSMENT COMPLETE · {r.induction_name}</span>
        <div className={`score-circle ${passed ? "positive" : "negative"}`}>
          <strong>
            {r.score_percent}
            <small>%</small>
          </strong>
        </div>
        <Badge status={r.result_status ?? "PENDING"} />
        <h1 tabIndex={-1}>{completed ? "Induction completed." : "One last step: share your feedback."}</h1>
        <p>{completed ? "Your assessment and feedback are saved." : "Your assessment is saved. Complete the induction feedback form to finish your induction and open your workspace."}</p>
        {r.attempt_status === "TIMED_OUT" ? <div className="notice">Time expired. Your saved answers were submitted automatically.</div> : null}
        {unconfirmed ? (
          <div className="notice danger left" role="alert">
            <Icon name="alert" />
            <div>
              {unconfirmed} answer{unconfirmed === 1 ? "" : "s"} chosen on this device {unconfirmed === 1 ? "was" : "were"} not confirmed as saved before the assessment finished and may not count. Only answers the server received in time were scored.
            </div>
          </div>
        ) : null}
        <Metrics
          items={[
            ["Assessment score", `${r.score_percent}%`, passed ? "Passed" : "Not passed"],
            ["Attempt", "1 of 1", "Taken once"],
            ["Feedback", feedbackDone ? "Submitted" : "Pending", feedbackDone ? "Thank you" : "Required to finish"],
          ]}
        />
        <p>{r.batch_label}</p>
        <p className="small">
          Attempt 1 · Submitted {dateTime(r.submitted_at)} · {r.correct_count} / {r.question_count} correct. Answer review is not enabled for this assessment. Completing the induction does not change the assessment result.
        </p>
        <section className="panel left result-details" aria-labelledby="induction-details-title">
          <h2 id="induction-details-title">Submission details</h2>
          <dl className="result-facts">
            {details.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {r.violations.length ? (
            <details className="violation-log">
              <summary>Security events recorded ({r.violations.length})</summary>
              <ol>
                {r.violations.map((v) => (
                  <li key={v.number}>
                    <span>{dateTime(v.occurred_at)}</span>
                    {VIOLATION_LABELS[v.type as keyof typeof VIOLATION_LABELS] ?? v.type}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
        {r.topics.length ? (
          <section className="panel left">
            <h2>Topic performance</h2>
            {r.topics.map((t) => (
              <div className="topic-row" key={t.name}>
                <span>{t.name}</span>
                <progress value={t.score ?? 0} max={100} aria-label={t.name} />
                <strong>{t.score === null ? "—" : `${Math.round(t.score)}%`}</strong>
              </div>
            ))}
          </section>
        ) : null}
        {required ? (
          <div className="notice left feedback-thanks" role="status">
            <Icon name="chat" />
            <div>
              <strong>One last step: share your feedback.</strong> Complete the Induction Feedback Form before you continue.{" "}
              <Btn kind="text" onClick={() => setOpen(true)}>
                Give feedback
              </Btn>
            </div>
          </div>
        ) : feedbackDone ? (
          <div className="notice left feedback-thanks" role="status">
            <Icon name="check" />
            <div>
              <strong>Thank you for your feedback.</strong> It has been shared with the L&amp;D team.
            </div>
          </div>
        ) : null}
        <Btn kind="wide" onClick={proceed}>
          {required ? "Give feedback to continue" : "Continue to my workspace"} <Icon name="arrow" />
        </Btn>
      </div>
      {open && required && feedback ? (
        <FeedbackDialog<InductionFeedbackView>
          attemptId={attemptId ?? ""}
          submitPath="/me/induction/feedback"
          title="Induction Feedback Form"
          intro="Tell us about your induction experience. Your answers help L&D improve the induction."
          comment={{ enabled: feedback.comment_enabled, label: feedback.comment_label }}
          view={feedback}
          onClose={() => setOpen(false)}
          onSubmitted={(view) => {
            setSaved(view);
            setOpen(false);
            toast("Thank you. Your induction is complete.");
          }}
        />
      ) : null}
    </FocusShell>
  );
}

/* ---------- /employee/induction: the employee's own induction page in the workspace ---------- */

export function MyInductionPage() {
  const state = useApi<MyInduction>("/me/induction");
  return (
    <>
      <PageTitle eyebrow="MY LEARNING" title="Induction" description="Your new-joiner induction: one assessment and one feedback form, taken once." />
      <Loaded state={state}>
        {(m) =>
          !m.assigned || !m.induction ? (
            <div className="panel">
              <p>No induction is assigned to you.</p>
            </div>
          ) : (
            <section className="panel" aria-labelledby="my-induction">
              <span className="eyebrow">{m.batch_label}</span>
              <h2 id="my-induction">{m.induction.name}</h2>
              <p>{m.induction.description ?? ""}</p>
              <Metrics
                items={[
                  ["Induction status", m.status ? STATUS_LABEL[m.status] : "—", m.completed_at ? `Completed ${dateTime(m.completed_at)}` : "Assessment, then feedback"],
                  ["Assessment", m.attempt ? (m.attempt.result_status === "PASSED" ? "Passed" : m.attempt.result_status === "NOT_PASSED" ? "Not passed" : "In progress") : "Not started", m.attempt?.submitted_at ? `Submitted ${dateTime(m.attempt.submitted_at)}` : "Taken once"],
                  ["Feedback", m.status === "COMPLETED" ? "Submitted" : "Pending", "Common induction form"],
                ]}
              />
              {!m.ready && !m.attempt ? <div className="notice left">Your induction assessment is not ready yet. L&amp;D has been notified; you will be asked to take it when it is.</div> : null}
              <div className="row wrap">
                {m.attempt && m.attempt.status !== "IN_PROGRESS" ? (
                  <BtnLink href="/induction/result" kind="primary">
                    View my induction result <Icon name="arrow" />
                  </BtnLink>
                ) : m.ready ? (
                  <BtnLink href="/induction" kind="primary">
                    {m.attempt ? "Resume induction assessment" : "Start induction assessment"} <Icon name="arrow" />
                  </BtnLink>
                ) : null}
              </div>
            </section>
          )
        }
      </Loaded>
    </>
  );
}
