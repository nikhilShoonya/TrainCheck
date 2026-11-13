"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { FocusShell } from "@/components/shell/AppShell";
import { HOME } from "@/components/shell/nav";
import { Badge, Btn, ErrorPanel, Loading, Metrics, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import type { AccessState, FeedbackView, ResultView } from "@/lib/types";
import { dateTime, duration } from "@/lib/utils";
import { FeedbackDialog } from "./FeedbackForm";
import { VIOLATION_LABELS } from "./monitor";

const REASONS: Record<string, string> = { MANUAL: "Submitted by you", TIME_EXPIRED: "Submitted automatically when time ran out" };

export function ResultPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const state = useApi<ResultView>(`/attempts/${attemptId}/result`);
  const access = useApi<AccessState>("/me/access-state");
  const { user } = useSession();
  const toast = useToast();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // Feedback is asked once per post-training assessment; the form opens by itself when it is still owed.
  const feedbackState = useApi<FeedbackView>(`/attempts/${attemptId}/feedback`);
  const [savedFeedback, setSavedFeedback] = useState<FeedbackView | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const feedback = savedFeedback ?? feedbackState.data;
  const feedbackRequired = Boolean(feedback?.required);
  useEffect(() => {
    if (feedbackRequired && !autoOpened) {
      // Opening the form once the server says feedback is owed is the purpose of this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoOpened(true);
      setFeedbackOpen(true);
    }
  }, [feedbackRequired, autoOpened]);

  if (state.error) {
    return (
      <FocusShell>
        <ErrorPanel error={state.error} retry={state.reload} />
      </FocusShell>
    );
  }
  const r = state.data;
  if (!r) return <Loading label="Loading your result…" />;
  const passed = r.result_status === "PASSED";
  const more = access.data?.access_status === "ASSESSMENT_REQUIRED";

  const acknowledge = async () => {
    try {
      await api.post(`/assessment-obligations/${r.obligation_id}/refresher-acknowledgement`);
      setAcknowledged(true);
      toast("Refresher acknowledged. Your retake becomes due at your next sign-in.");
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const proceed = () => {
    if (feedbackRequired) {
      setFeedbackOpen(true);
      return;
    }
    // A full load, so the session re-reads the gate decision instead of acting on the one from before this result.
    window.location.assign(more ? "/access/assessment-required" : user ? HOME[user.primary_role] : "/login");
  };

  if (r.assessment_type === "PRE_TEST") {
    return (
      <FocusShell>
        <section className="result-panel">
          <span className="eyebrow">PRE-TRAINING BASELINE · {r.training_title}</span>
          <h1 tabIndex={-1}>Pre-test complete</h1>
          <div className="score-circle positive">
            <strong>
              {r.score_percent}
              <small>%</small>
            </strong>
          </div>
          <p>This score is a baseline, not a post-training pass. Training completion will create a separate post-training assessment.</p>
          <Btn kind="wide" onClick={proceed}>
            Return to my workspace <Icon name="arrow" />
          </Btn>
        </section>
      </FocusShell>
    );
  }

  const facts: [string, string][] = [
    ["Score", `${r.obtained_marks} / ${r.total_marks} marks`],
    ["Percentage", `${r.score_percent}%`],
    ["Attempt", `${r.attempt_number} of ${r.max_attempts}`],
    ["Submission", r.submission_reason === "VIOLATION_LIMIT" ? `Submitted automatically after ${r.violations.length} security violations` : REASONS[r.submission_reason]],
    ["Time taken", duration(r.time_taken_seconds)],
    ["Answered", `${r.answered_count} of ${r.question_count}`],
    ["Correct", `${r.correct_count} of ${r.question_count}`],
    ["Latest score", r.latest_score === null ? "—" : `${r.latest_score}%`],
  ];

  return (
    <FocusShell>
      <div className="result-panel">
        <span className="eyebrow">ASSESSMENT COMPLETE · {r.training_title}</span>
        <div className={`score-circle ${passed ? "positive" : "negative"}`}>
          <strong>
            {r.score_percent}
            <small>%</small>
          </strong>
        </div>
        <Badge status={r.result_status} />
        <h1 tabIndex={-1}>{passed ? "Knowledge demonstrated." : "A little more practice will help."}</h1>
        <p>{passed ? "You met the assessment pass mark. Keep applying what you learned." : "Review the refresher guidance and your topic breakdown before your next attempt."}</p>
        {r.attempt_status === "TIMED_OUT" ? <div className="notice">Time expired. Your saved answers were submitted automatically.</div> : null}
        <Metrics
          items={[
            ["Pass mark", `${r.pass_mark_percent}%`, "At time of attempt"],
            ["First score", r.first_score === null ? "—" : `${r.first_score}%`, "Original result retained"],
            ["Best score", r.best_score === null ? "—" : `${r.best_score}%`, `${r.attempt_number} attempt(s)`],
          ]}
        />
        <p className="small">
          Attempt {r.attempt_number} · Submitted {dateTime(r.submitted_at)} · {r.correct_count} / {r.question_count} correct. {r.explanations_enabled ? "Answer review is enabled for this attempt." : "Answer review is not enabled for this assessment."}
        </p>
        <section className="panel left result-details" aria-labelledby="result-details-title">
          <h2 id="result-details-title">Submission details</h2>
          {r.submission_reason === "VIOLATION_LIMIT" ? (
            <div className="notice danger">
              <Icon name="alert" />
              <div>The assessment was submitted automatically after {r.violations.length} security violations. Your saved answers were scored normally; violations do not change the score.</div>
            </div>
          ) : null}
          <dl className="result-facts">
            {facts.map(([k, v]) => (
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
                    <span>{new Date(v.occurred_at).toLocaleTimeString()}</span>
                    {VIOLATION_LABELS[v.type] ?? v.type}
                    {v.signals.length > 1 ? <small> ({v.signals.length} browser signals, counted once)</small> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
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
        {r.answer_review.length ? (
          <section className="panel left answer-review">
            <h2>Correct answers &amp; explanations</h2>
            {r.answer_review.map((q) => (
              <details key={q.position}>
                <summary>
                  Question {q.position} · {q.question_text}
                </summary>
                <p>
                  <strong>Your response:</strong> {q.your_answer.join("; ") || "Unanswered"}
                </p>
                <p>
                  <strong>Correct:</strong> {q.correct_answer.join("; ")}
                </p>
                <p>{q.explanation ?? "No explanation supplied."}</p>
              </details>
            ))}
          </section>
        ) : null}
        {!passed ? (
          <div className="notice left">
            {r.needs_retraining ? (
              <p>
                <strong>Needs Re-training.</strong> You have used all attempts. The L&amp;D team has been notified and will arrange your next learning step. This is a learning follow-up, not a disciplinary record.
              </p>
            ) : (
              <p>{r.attempts_remaining} attempt(s) remaining. Acknowledge the refresher, then your retake becomes due at your next sign-in. If you do not acknowledge it, the retake opens at your next sign-in from the next working day.</p>
            )}
            {r.refresher?.text ? <p>{r.refresher.text}</p> : null}
            {r.refresher?.url ? (
              <p>
                <a href={r.refresher.url} target="_blank" rel="noopener noreferrer">
                  Open refresher material
                </a>
              </p>
            ) : null}
            {r.retake_pending ? (
              <Btn tone="attention" disabled={acknowledged || r.refresher?.acknowledged} onClick={() => void acknowledge()}>
                {acknowledged || r.refresher?.acknowledged ? "Refresher acknowledged" : "Acknowledge refresher"}
              </Btn>
            ) : null}
            {error ? <ErrorPanel error={error} /> : null}
          </div>
        ) : null}
        {feedbackRequired ? (
          <div className="notice left feedback-thanks" role="status">
            <Icon name="chat" />
            <div>
              <strong>One last step: share your feedback.</strong> Five quick questions about this training and its assessment, needed before you continue.{" "}
              <Btn kind="text" onClick={() => setFeedbackOpen(true)}>
                Give feedback
              </Btn>
            </div>
          </div>
        ) : feedback?.submitted ? (
          <div className="notice left feedback-thanks" role="status">
            <Icon name="check" />
            <div>
              <strong>Thank you for your feedback.</strong> It has been shared with the L&amp;D team.
            </div>
          </div>
        ) : null}
        <Btn kind="wide" onClick={proceed}>
          {feedbackRequired ? "Give feedback to continue" : more ? "Continue to next assessment" : "Continue to my workspace"} <Icon name="arrow" />
        </Btn>
      </div>
      {feedbackOpen && feedback && feedbackRequired ? (
        <FeedbackDialog
          attemptId={attemptId}
          view={feedback}
          onClose={() => setFeedbackOpen(false)}
          onSubmitted={(saved) => {
            setSavedFeedback(saved);
            setFeedbackOpen(false);
            toast("Thank you. Your feedback has been sent to the L&D team.");
          }}
        />
      ) : null}
    </FocusShell>
  );
}
