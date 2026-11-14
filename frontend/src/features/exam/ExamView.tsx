"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Btn, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import type { AttemptView } from "@/lib/types";
import { clock } from "@/lib/utils";
import { enterFullscreen, exitFullscreen, isFullscreen, startMonitor, VIOLATION_LABELS, type ViolationType } from "./monitor";

const WARN_SECONDS = 300;
const CRITICAL_SECONDS = 60;
const TYPE_LABEL: Record<string, string> = { MCQ_SINGLE: "Single choice", MCQ_MULTIPLE: "Multiple choice", TRUE_FALSE: "True or false", SCENARIO: "Scenario" };
const HINT: Record<string, string> = {
  MCQ_SINGLE: "Select one answer.",
  MCQ_MULTIPLE: "Select all that apply. Every correct option must be selected to earn the mark.",
  TRUE_FALSE: "Select True or False.",
  SCENARIO: "Read the scenario and select the best response.",
};

type SaveState = "saved" | "saving" | "waiting";

interface Warning {
  number: number;
  limit: number;
  type: ViolationType;
  at: Date;
}

export function ExamView({ initial }: { initial: AttemptView }) {
  const router = useRouter();
  const toast = useToast();
  const [attempt, setAttempt] = useState(initial);
  const [index, setIndex] = useState(() => {
    const firstOpen = initial.questions.findIndex((q) => !q.selected_option_ids.length);
    return firstOpen < 0 ? 0 : firstOpen;
  });
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<Warning | null>(null);
  const [fullscreen, setFullscreen] = useState(() => (typeof document === "undefined" ? true : isFullscreen()));
  const [online, setOnline] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [announcement, setAnnouncement] = useState("");

  // The clock offset comes from the server, so changing the device clock changes nothing.
  const [offset] = useState(() => new Date(initial.server_now).getTime() - Date.now());
  const deadline = useMemo(() => new Date(initial.expires_at).getTime(), [initial.expires_at]);
  const remainingNow = useCallback(() => Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000)), [deadline, offset]);
  const [remaining, setRemaining] = useState(initial.remaining_seconds);
  const warned = useRef({ warning: false, critical: false });
  const finished = useRef(false);
  const unsaved = useRef(new Map<string, string[]>());
  const interruptedAt = useRef<number | null>(null);

  const goToResult = useCallback(
    (message?: string) => {
      if (finished.current) return;
      finished.current = true;
      exitFullscreen();
      if (message) toast(message);
      router.replace(`/results/${attempt.attempt_id}`);
    },
    [attempt.attempt_id, router, toast],
  );

  const handleApiError = useCallback(
    (error: ApiError) => {
      if (error.code === "ATTEMPT_ALREADY_SUBMITTED") goToResult(error.message);
    },
    [goToResult],
  );

  /* ---------- Saving, with retry after an interruption ---------- */

  // One save at a time, always the latest choice. Overlapping requests for the same question could reach
  // the server in either order and leave an older answer stored (and scored) while the screen shows the
  // newer one, so a second call only joins the loop that is already running.
  const flushing = useRef<Promise<void> | null>(null);
  const flush = useCallback((): Promise<void> => {
    if (flushing.current) return flushing.current;
    const run = (async () => {
      try {
        while (unsaved.current.size) {
          const [questionId, selected] = unsaved.current.entries().next().value as [string, string[]];
          try {
            await api.put(`/attempts/${attempt.attempt_id}/questions/${questionId}/answer`, { selected_option_ids: selected });
            // A newer choice made while this one was sending stays queued and is sent next.
            if (unsaved.current.get(questionId) === selected) unsaved.current.delete(questionId);
          } catch (error) {
            const failure = error as ApiError;
            if (failure.status === 0) {
              setSaveState("waiting"); // Only a real connection failure says "not saved yet".
              return;
            }
            if (unsaved.current.get(questionId) === selected) unsaved.current.delete(questionId);
            handleApiError(failure);
            if (failure.status === 400) toast(failure.message);
          }
        }
        setSaveState("saved");
      } finally {
        flushing.current = null;
      }
    })();
    flushing.current = run;
    return run;
  }, [attempt.attempt_id, handleApiError, toast]);

  const saveAnswer = (questionId: string, selected: string[]) => {
    setAttempt((a) => ({ ...a, questions: a.questions.map((q) => (q.attempt_question_id === questionId ? { ...q, selected_option_ids: selected } : q)) }));
    unsaved.current.set(questionId, selected);
    setSaveState("saving");
    void flush();
  };

  /* ---------- Timer. The display only; the server decides when time is up. ---------- */

  useEffect(() => {
    const tick = () => {
      const left = remainingNow();
      setRemaining(left);
      if (left === 0) {
        goToResult("Time is up. Your saved answers were submitted automatically.");
      } else if (left <= CRITICAL_SECONDS && !warned.current.critical) {
        warned.current = { warning: true, critical: true };
        const text = "Less than 1 minute remains. Your saved answers will be submitted automatically when time runs out.";
        toast(text);
        setAnnouncement(text);
      } else if (left <= WARN_SECONDS && !warned.current.warning) {
        warned.current.warning = true;
        const text = "5 minutes remain. Check any unanswered or marked questions.";
        toast(text);
        setAnnouncement(text);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [goToResult, remainingNow, toast]);

  /* ---------- Monitoring ---------- */

  useEffect(() => {
    if (!attempt.monitored) return;
    const report = async (type: ViolationType) => {
      try {
        const result = await api.post<{ counted: boolean; violation_count: number; violation_limit: number; auto_submitted: boolean; status: string }>(`/attempts/${attempt.attempt_id}/security-events`, { event_type: type });
        setAttempt((a) => ({ ...a, violation_count: result.violation_count }));
        if (result.auto_submitted || result.status !== "IN_PROGRESS") goToResult(`Your assessment was submitted automatically after ${result.violation_count} security violations.`);
        else if (result.counted) {
          setWarning({ number: result.violation_count, limit: result.violation_limit, type, at: new Date() });
          setAnnouncement(`Security warning. Violation ${result.violation_count} of ${result.violation_limit}.`);
        }
      } catch {
        // The server could not be reached. A lost connection is never counted against the employee.
      }
    };
    return startMonitor(
      (type) => void report(type),
      () => setFullscreen(isFullscreen()),
    );
  }, [attempt.attempt_id, attempt.monitored, goToResult]);

  /* ---------- Connection: an interruption is recorded, never counted as a violation ---------- */

  useEffect(() => {
    const onOffline = () => {
      setOnline(false);
      interruptedAt.current = Date.now();
      toast("You are offline. The timer keeps running. Your latest answers will be sent when you reconnect.");
    };
    const onOnline = () => {
      setOnline(true);
      toast("Connection restored. You are continuing the same attempt; the timer was not paused.");
      if (interruptedAt.current !== null && attempt.monitored) {
        interruptedAt.current = null;
        void api.post(`/attempts/${attempt.attempt_id}/security-events`, { event_type: "NETWORK_INTERRUPTION" }).catch(() => {});
      }
      void flush();
    };
    const heartbeat = setInterval(async () => {
      try {
        const response = await fetch("/api/v1/system/ping", { cache: "no-store" });
        if (response.ok) {
          setOnline(true);
          if (unsaved.current.size) void flush();
        } else if (!response.ok) setOnline(false);
      } catch {
        setOnline(false);
      }
    }, 15000);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [attempt.attempt_id, attempt.monitored, flush, toast]);

  /* ---------- Actions ---------- */

  const question = attempt.questions[Math.min(index, attempt.questions.length - 1)];
  const stats = useMemo(() => {
    const answered = attempt.questions.filter((q) => q.selected_option_ids.length).length;
    return { total: attempt.questions.length, answered, unanswered: attempt.questions.length - answered, marked: attempt.questions.filter((q) => q.marked_for_review).length };
  }, [attempt.questions]);
  const pct = Math.round((stats.answered / stats.total) * 100);
  const timerState = remaining <= CRITICAL_SECONDS ? "critical" : remaining <= WARN_SECONDS ? "warning" : "normal";
  const blocked = attempt.monitored && attempt.require_fullscreen && !fullscreen;

  const toggle = (optionId: string, checked: boolean) => {
    const multiple = question.question_type === "MCQ_MULTIPLE";
    const next = multiple ? [...question.selected_option_ids.filter((o) => o !== optionId), ...(checked ? [optionId] : [])] : checked ? [optionId] : [];
    saveAnswer(question.attempt_question_id, next);
  };

  const toggleMark = async () => {
    const marked = !question.marked_for_review;
    setAttempt((a) => ({ ...a, questions: a.questions.map((q) => (q.attempt_question_id === question.attempt_question_id ? { ...q, marked_for_review: marked } : q)) }));
    setAnnouncement(marked ? "Marked for review." : "Review mark removed.");
    try {
      await api.post(`/attempts/${attempt.attempt_id}/questions/${question.attempt_question_id}/mark`, { marked });
    } catch (error) {
      handleApiError(error as ApiError);
    }
  };

  const goto = (i: number) => {
    setIndex(Math.max(0, Math.min(i, stats.total - 1)));
    setReviewing(false);
  };

  const submit = async () => {
    setSubmitting(true);
    await flush();
    try {
      await api.post(`/attempts/${attempt.attempt_id}/submit`);
      goToResult("Assessment submitted.");
    } catch (error) {
      setSubmitting(false);
      setConfirming(false);
      toast((error as ApiError).message);
    }
  };

  const returnToFullscreen = async () => {
    setWarning(null);
    if (attempt.require_fullscreen && !isFullscreen()) {
      const problem = await enterFullscreen();
      if (problem) toast(problem);
    }
    setFullscreen(isFullscreen());
  };

  const savedLine =
    saveState === "saved" ? (
      <>
        <Icon name="check" /> Answers saved on the server
      </>
    ) : saveState === "saving" ? (
      <>
        <Icon name="clock" /> Saving…
      </>
    ) : (
      <>
        <Icon name="alert" /> Your latest answer is not saved yet. It will be sent when you reconnect.
      </>
    );

  return (
    <div className={`exam-shell${attempt.monitored ? " no-select" : ""}`} data-timer={timerState}>
      <header className="exam-header">
        <div className="exam-brand">
          <span className="exam-mark">
            <Icon name="check" />
          </span>
          <span>TrainCheck</span>
          <i aria-hidden="true" />
          <span className="exam-org">Finvasia</span>
        </div>
        <div className="exam-title">
          <span className="exam-mode">
            <Icon name={attempt.monitored ? "lock" : "file"} />
            {attempt.monitored ? (attempt.assessment_type === "PRE_TEST" ? "Secure pre-test mode" : "Secure assessment mode") : "Pre-test · baseline"}
          </span>
          <strong>{attempt.training_title}</strong>
        </div>
        <ul className="exam-indicators" aria-label="Live status">
          <li id="exam-net" className={`pill ${online ? "ok" : "bad"}`}>
            <Icon name="wifi" />
            <span>{online ? "Online" : "Offline"}</span>
          </li>
          {attempt.monitored ? (
            <>
              <li className={`pill ${fullscreen ? "ok" : "bad"}`}>
                <Icon name="maximize" />
                <span>Full screen {fullscreen ? "on" : "off"}</span>
              </li>
              <li className={`pill ${attempt.violation_count ? (attempt.violation_count >= attempt.violation_limit - 1 ? "bad" : "warn") : "ok"}`}>
                <Icon name="shield" />
                <span>
                  Violations {attempt.violation_count} / {attempt.violation_limit}
                </span>
              </li>
            </>
          ) : null}
        </ul>
        <div className="exam-timer" role="timer" aria-label="Time remaining" data-state={timerState}>
          <Icon name="clock" />
          <span>{clock(remaining)}</span>
          <small>{{ normal: "remaining", warning: "5 min warning", critical: "under 1 min" }[timerState]}</small>
        </div>
        <button className="btn exam-end-btn tone-danger" onClick={() => setConfirming(true)}>
          End test
        </button>
      </header>
      <div id="exam-offline" className="exam-banner offline" role="status" hidden={online}>
        <Icon name="wifi" />
        <span>You&apos;re offline. The timer keeps running. Answers already marked as saved are safe. The same attempt continues when the connection returns.</span>
      </div>
      <div className="exam-body">
        <aside className="exam-panel exam-navigator" aria-labelledby="navigator-title">
          <h2 id="navigator-title">Question navigator</h2>
          <ul className="nav-legend">
            <li>
              <i className="swatch answered" />
              Answered <b>{stats.answered}</b>
            </li>
            <li>
              <i className="swatch marked" />
              Marked for review <b>{stats.marked}</b>
            </li>
            <li>
              <i className="swatch" />
              Not answered <b>{stats.unanswered}</b>
            </li>
          </ul>
          <div className="q-grid">
            {attempt.questions.map((q, i) => {
              const answered = q.selected_option_ids.length > 0;
              return (
                <button
                  key={q.attempt_question_id}
                  className={`q-cell${i === index && !reviewing ? " current" : ""}${answered ? " answered" : ""}${q.marked_for_review ? " marked" : ""}`}
                  aria-label={`Question ${i + 1}: ${answered ? "answered" : "not answered"}${q.marked_for_review ? ", marked for review" : ""}${i === index ? ", current question" : ""}`}
                  aria-current={i === index ? "step" : undefined}
                  onClick={() => goto(i)}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
        </aside>
        <main id="main" className="exam-main">
          {blocked ? (
            <section className="question-card blocker" role="alert">
              <div className="fs-visual" aria-hidden="true">
                <Icon name="maximize" />
              </div>
              <h1 tabIndex={-1}>Full screen is off</h1>
              <p>Questions are hidden until you return to full screen. The timer is still running and your saved answers are safe.</p>
              <Btn kind="primary" large onClick={() => void returnToFullscreen()}>
                <Icon name="maximize" /> Return to full screen
              </Btn>
              <p className="small">
                Violations recorded: {attempt.violation_count} of {attempt.violation_limit}.
              </p>
            </section>
          ) : reviewing ? (
            <section className="question-card review-card">
              <h1 tabIndex={-1}>Review &amp; submit</h1>
              <p>
                {stats.unanswered ? (
                  <strong>
                    {stats.unanswered} question{stats.unanswered > 1 ? "s are" : " is"} not answered and will receive no marks.
                  </strong>
                ) : (
                  "All questions are answered."
                )}{" "}
                {stats.marked ? `${stats.marked} marked for review.` : ""} Select any question to return to it.
              </p>
              <ul className="review-list">
                {attempt.questions.map((q, i) => (
                  <li key={q.attempt_question_id}>
                    <button onClick={() => goto(i)}>
                      <span className="review-num">{i + 1}</span>
                      <span className="review-text">{q.question_text}</span>
                      <span className={`badge ${q.selected_option_ids.length ? "success" : "warning"}`}>{q.selected_option_ids.length ? "Answered" : "Not answered"}</span>
                      {q.marked_for_review ? <span className="badge info">Marked</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="q-actions">
                <div>
                  <Btn onClick={() => goto(index)}>
                    <Icon name="back" /> Back to question {index + 1}
                  </Btn>
                </div>
                <div>
                  <Btn kind="primary" onClick={() => setConfirming(true)}>
                    Submit assessment
                  </Btn>
                </div>
              </div>
            </section>
          ) : (
            <section className="question-card">
              <div className="q-head">
                <span className="q-number">
                  Question {index + 1} of {stats.total}
                </span>
                <span>
                  <b>{pct}</b>% answered
                </span>
              </div>
              <div className="q-progress" aria-hidden="true">
                <span id="exam-bar" style={{ width: `${pct}%` }} />
              </div>
              <div className="q-meta">
                <span className="chip">{TYPE_LABEL[question.question_type]}</span>
                <span className="chip">
                  {question.marks} mark{question.marks === 1 ? "" : "s"}
                </span>
                <span className="chip">{question.topic}</span>
                {question.marked_for_review ? (
                  <span className="chip amber">
                    <Icon name="flag" /> Marked for review
                  </span>
                ) : null}
              </div>
              <h1 tabIndex={-1} className="q-text" lang={question.language === "Hindi" ? "hi" : "en"}>
                {question.question_text}
              </h1>
              <p className="q-hint">{HINT[question.question_type]}</p>
              <fieldset className="exam-options">
                <legend className="sr-only">Answer choices for question {index + 1}</legend>
                {question.options.map((option) => {
                  const chosen = question.selected_option_ids.includes(option.option_id);
                  return (
                    <label key={option.option_id} className={`exam-option${chosen ? " chosen" : ""}`}>
                      <input type={question.question_type === "MCQ_MULTIPLE" ? "checkbox" : "radio"} name="exam-answer" value={option.option_id} checked={chosen} onChange={(e) => toggle(option.option_id, e.target.checked)} />
                      <span className="opt-letter" aria-hidden="true">
                        {option.label}
                      </span>
                      <span className="opt-text">{option.text}</span>
                    </label>
                  );
                })}
              </fieldset>
              <div className="q-actions">
                <div>
                  <Btn tone="attention" className={question.marked_for_review ? "is-marked" : ""} onClick={() => void toggleMark()}>
                    <Icon name="flag" /> {question.marked_for_review ? "Unmark review" : "Mark for review"}
                  </Btn>
                  <Btn kind="text" id="exam-clear" disabled={!question.selected_option_ids.length} onClick={() => saveAnswer(question.attempt_question_id, [])}>
                    <Icon name="eraser" /> Clear response
                  </Btn>
                </div>
                <div>
                  <Btn disabled={index === 0} onClick={() => goto(index - 1)}>
                    <Icon name="back" /> Previous
                  </Btn>
                  {index < stats.total - 1 ? (
                    <Btn kind="primary" onClick={() => goto(index + 1)}>
                      Next <Icon name="arrow" />
                    </Btn>
                  ) : null}
                  <Btn kind={index === stats.total - 1 ? "primary" : "secondary"} onClick={() => setReviewing(true)}>
                    Review &amp; submit
                  </Btn>
                </div>
              </div>
              <p className="save-line" id="exam-save" role="status">
                {savedLine}
              </p>
            </section>
          )}
        </main>
        <aside className="exam-panel exam-status" aria-labelledby="status-title">
          <h2 id="status-title">Assessment status</h2>
          <dl className="status-list">
            <div>
              <dt>Time remaining</dt>
              <dd>{clock(remaining)}</dd>
            </div>
            <div>
              <dt>Total questions</dt>
              <dd>{stats.total}</dd>
            </div>
            <div>
              <dt>Answered</dt>
              <dd>{stats.answered}</dd>
            </div>
            <div>
              <dt>Not answered</dt>
              <dd>{stats.unanswered}</dd>
            </div>
            <div>
              <dt>Marked for review</dt>
              <dd>{stats.marked}</dd>
            </div>
          </dl>
          <h2>Monitoring</h2>
          {attempt.monitored ? (
            <>
              <dl className="status-list">
                <div>
                  <dt>Full screen</dt>
                  <dd className={fullscreen ? "ok" : "bad"}>{fullscreen ? "On" : "Off"}</dd>
                </div>
                <div>
                  <dt>Tab monitoring</dt>
                  <dd className="ok">Active</dd>
                </div>
                <div>
                  <dt>Focus monitoring</dt>
                  <dd className="ok">Active</dd>
                </div>
                <div>
                  <dt>Violations</dt>
                  <dd className={attempt.violation_count ? "bad" : "ok"}>
                    {attempt.violation_count} of {attempt.violation_limit}
                  </dd>
                </div>
                <div>
                  <dt>Connection</dt>
                  <dd>{online ? "Online" : "Offline"}</dd>
                </div>
              </dl>
              <p className="small">Browser-level, best-effort monitoring. Only event type and time are recorded.</p>
            </>
          ) : (
            <p className="small">Pre-tests are a practice baseline and are not monitored.</p>
          )}
        </aside>
      </div>
      <div id="exam-live" className="sr-only" aria-live="assertive">
        {announcement}
      </div>
      {confirming ? (
        <Modal title="Submit your assessment?" onClose={() => setConfirming(false)}>
          <p>
            {stats.answered} of {stats.total} questions answered.{" "}
            {stats.unanswered ? (
              <strong>
                {stats.unanswered} unanswered question{stats.unanswered > 1 ? "s" : ""} will receive no marks.
              </strong>
            ) : null}{" "}
            {stats.marked ? `${stats.marked} still marked for review.` : ""}
          </p>
          <p>You cannot change your answers after submitting.</p>
          <div className="dialog-actions">
            <Btn onClick={() => setConfirming(false)}>Keep working</Btn>
            <Btn kind="primary" disabled={submitting} onClick={() => void submit()}>
              {submitting ? "Submitting…" : "Submit assessment"}
            </Btn>
          </div>
        </Modal>
      ) : null}
      {warning ? (
        <Modal title={warning.number === warning.limit - 1 ? "Final warning" : "Security warning"} onClose={() => void returnToFullscreen()}>
          <div className={`violation-alert${warning.number === warning.limit - 1 ? " final" : ""}`}>
            <p className="violation-count">
              <Icon name="alert" /> Violation {warning.number} of {warning.limit}
            </p>
            <p>
              <strong>{VIOLATION_LABELS[warning.type]}</strong> at {warning.at.toLocaleTimeString()}.
            </p>
            <p>{warning.number === warning.limit - 1 ? "One more violation will submit your assessment automatically with the answers saved so far." : "Stay on this tab in full screen until you submit. Each further violation is counted."}</p>
            <p className="small">Your saved answers are safe. Violations do not change your score.</p>
          </div>
          <div className="dialog-actions">
            <Btn kind="primary" onClick={() => void returnToFullscreen()}>
              {fullscreen ? "Continue assessment" : (
                <>
                  <Icon name="maximize" /> Return to full screen
                </>
              )}
            </Btn>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
