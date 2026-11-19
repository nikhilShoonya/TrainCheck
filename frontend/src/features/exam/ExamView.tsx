"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/icons";
import { Btn, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import { browserStorage, onPendingAnswersRevoked, pendingStore, STORAGE_PREFIX } from "@/lib/pendingAnswers";
import type { AttemptView } from "@/lib/types";
import { clock } from "@/lib/utils";
import { answerSender } from "./answerSave";
import { AnswerSync, loadFinalResult, RESULT_BUDGET_MS, type FlushOutcome, type SyncSnapshot } from "./answerSync";
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

interface Warning {
  number: number;
  limit: number;
  type: ViolationType;
  at: Date;
}

/** How long, after the deadline, the page waits for a save already on its way before asking for the result. */
const IN_FLIGHT_WAIT_MS = 10_000;
/** The whole of finishing after the deadline (the in-flight wait and loading the result) is bounded by this:
    after it the page offers "Try again" and "Go to my result" even if a request never settles. */
const EXPIRY_BOUND_MS = IN_FLIGHT_WAIT_MS + RESULT_BUDGET_MS + 5_000;
/** Submitting waits this long, at most, for answers to be confirmed, and then for the submission itself. */
const SUBMIT_SAVE_BOUND_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 20_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const answers = (n: number) => `${n} answer${n === 1 ? "" : "s"}`;

/** Why submission could not go ahead. Answers stay on the page and saving continues where it can. */
function flushProblem(outcome: Exclude<FlushOutcome, { ok: true }>): string {
  const n = answers(outcome.unsaved);
  switch (outcome.kind) {
    case "network":
      return `${n} could not be saved because TrainCheck cannot be reached. They are kept on this page and sent automatically when the connection returns. Submit again once they are saved.`;
    case "timeout":
      return `${n} could not be confirmed because TrainCheck did not reply in time. They are kept on this page and saving is retried automatically. Submit again once they are saved.`;
    case "invalid":
      return `${n} could not be confirmed because TrainCheck sent a reply this page could not read. They are kept on this page and saving is retried automatically. Submit again once they are saved.`;
    case "conflict":
      return "An answer was changed in another window or on another device while you were working here. The newer answer is now shown. Check your answers, then submit again.";
    case "stopped":
      return "Saving stopped on this page. Reload the page to continue the same attempt.";
    case "rate-limited":
      return `${n} are waiting to be saved: TrainCheck asked this page to slow down. They are sent automatically shortly. Submit again once they are saved.`;
    case "server":
      return `${n} could not be saved because of a temporary problem at TrainCheck. Saving is retried automatically. Submit again once they are saved.`;
    case "rejected":
      return `${n} could not be saved: ${outcome.message ?? "the server refused it."} Change or clear that answer, then submit again.`;
    case "signed-out":
      return "Your session has ended, so your answers could not be saved. Sign in again to continue the same attempt; unsaved answers are kept on this device where the browser allows it.";
    case "forbidden":
      return outcome.message ?? "TrainCheck refused to save your answers.";
    default:
      return "This assessment can no longer be changed.";
  }
}

export function ExamView({ initial }: { initial: AttemptView }) {
  const router = useRouter();
  const toast = useToast();
  const { user } = useSession();

  // The clock offset comes from the server, so changing the device clock changes nothing.
  const [offset] = useState(() => new Date(initial.server_now).getTime() - Date.now());
  const deadline = useMemo(() => new Date(initial.expires_at).getTime(), [initial.expires_at]);
  const remainingNow = useCallback(() => Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000)), [deadline, offset]);

  /* ---------- Saving: every choice stays queued (and stored on this device) until the server confirms it ---------- */

  const [saving] = useState(() => {
    const listeners = new Set<() => void>();
    const conflictListeners = new Set<(questionId: string, selected: string[]) => void>();
    let current: SyncSnapshot;
    const account = user?.id ?? null;
    const store = pendingStore(browserStorage(), account, initial.attempt_id, deadline);
    const engine = new AnswerSync({
      send: answerSender(initial.attempt_id), // Bounded, cancellable, and confirmed only by a valid acknowledgement.
      now: () => Date.now() + offset,
      deadline,
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      random: Math.random,
      store,
      onChange: (snapshot) => {
        current = snapshot;
        for (const listener of listeners) listener();
      },
      onConflict: (questionId, selected) => {
        for (const listener of conflictListeners) listener(questionId, selected);
      },
    });
    current = engine.snapshot();
    return {
      engine,
      store,
      account,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      read: () => current,
      /** A newer answer saved in another window or on another device replaces this page's choice on screen. */
      onConflict: (listener: (questionId: string, selected: string[]) => void) => {
        conflictListeners.add(listener);
        return () => void conflictListeners.delete(listener);
      },
    };
  });
  const sync = saving.engine;
  const save = useSyncExternalStore(saving.subscribe, saving.read, saving.read);

  // Choices this device kept after a refresh or a closed browser, reconciled with what the server holds: a choice
  // made against an answer that has since changed elsewhere is not restored over it.
  const [restored] = useState(() =>
    sync.restore(
      initial.questions.map((q) => ({ attempt_question_id: q.attempt_question_id, option_ids: q.options.map((o) => o.option_id), selected_option_ids: q.selected_option_ids, revision: q.revision, op_id: q.op_id })),
    ),
  );
  const [attempt, setAttempt] = useState(() => ({
    ...initial,
    questions: initial.questions.map((q) => (restored[q.attempt_question_id] ? { ...q, selected_option_ids: restored[q.attempt_question_id] } : q)),
  }));
  const [index, setIndex] = useState(() => {
    const firstOpen = initial.questions.findIndex((q) => !q.selected_option_ids.length);
    return firstOpen < 0 ? 0 : firstOpen;
  });
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<{ error: string | null } | null>(null);
  const [warning, setWarning] = useState<Warning | null>(null);
  const [fullscreen, setFullscreen] = useState(() => (typeof document === "undefined" ? true : isFullscreen()));
  const [online, setOnline] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [remaining, setRemaining] = useState(initial.remaining_seconds);
  const warned = useRef({ warning: false, critical: false });
  const finished = useRef(false);
  const submitBusy = useRef(false);
  const expiring = useRef(false);
  const timeUp = useRef(false);
  const interruptedAt = useRef<number | null>(null);
  // Each submission and each expiry run has a number; a continuation of an older run (after a timeout, a
  // retry, or leaving the page) changes nothing.
  const submitRun = useRef(0);
  const expiryRun = useRef(0);

  /* ---------- Lifecycle of the saving queue ---------- */

  // Running while this page is mounted. Leaving cancels the request on its way and every retry timer, keeping
  // unsaved choices on this device for the next visit. Under React Strict Mode the rehearsal unmount suspends and
  // the remount resumes the same queue.
  useEffect(() => {
    sync.start();
    const runs = { submitRun, expiryRun };
    return () => {
      sync.suspend();
      runs.submitRun.current++;
      runs.expiryRun.current++;
    };
  }, [sync]);

  // Sign-out (here or in another tab) or another account signing in ends this queue for good, so a reply arriving
  // later cannot write answers back to this device.
  useEffect(() => onPendingAnswersRevoked(() => saving.store.revoked && sync.dispose()), [saving, sync]);
  useEffect(() => {
    if (user && user.id !== saving.account) sync.dispose();
  }, [saving.account, sync, user]);

  // Another tab may rewrite the shared record: recheck whether this page's unsaved choices are still kept.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) sync.recheckDurability();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [sync]);

  useEffect(() => {
    const count = Object.keys(restored).length;
    if (count) toast(`${answers(count)} chosen before the page closed ${count === 1 ? "was" : "were"} not saved yet. Sending now.`);
    const stale = sync.superseded();
    if (stale) toast(`${answers(stale)} kept on this device ${stale === 1 ? "was" : "were"} not restored, because a newer answer was saved in another window or on another device.`);
  }, [restored, sync, toast]);

  /** Leaves for the result page. Unsaved choices stay recorded on this device so the result page can explain
      them; a fully saved attempt leaves nothing behind. The queue is then disposed: nothing it does later can
      write that record back or change this page. */
  const goToResult = useCallback(
    (message: string) => {
      if (finished.current) return;
      finished.current = true;
      if (!sync.unsaved()) sync.forget();
      sync.dispose();
      exitFullscreen();
      toast(message);
      router.replace(`/results/${attempt.attempt_id}`);
    },
    [attempt.attempt_id, router, sync, toast],
  );

  /** The server reports the attempt finished (time, violations, or another tab). */
  const closedByServer = useCallback(
    (message: string) => {
      sync.close("closed");
      const n = sync.unsaved();
      goToResult(n ? `${message} ${answers(n)} chosen on this page could not be confirmed as saved first and may not count.` : message);
    },
    [goToResult, sync],
  );

  const handleApiError = useCallback(
    (error: ApiError) => {
      if (error.code === "ATTEMPT_ALREADY_SUBMITTED") closedByServer(error.message);
    },
    [closedByServer],
  );

  // A save refused because the server already finished the attempt (its deadline, or another tab submitted).
  useEffect(() => {
    if (save.closed === "closed" && !expiring.current) closedByServer(save.message ?? "This assessment has already finished.");
  }, [closedByServer, save.closed, save.message]);

  useEffect(
    () =>
      saving.onConflict((questionId, selected) => {
        setAttempt((a) => ({ ...a, questions: a.questions.map((q) => (q.attempt_question_id === questionId ? { ...q, selected_option_ids: selected } : q)) }));
        const number = initial.questions.findIndex((q) => q.attempt_question_id === questionId) + 1;
        const text = `Question ${number} was answered in another window or on another device. That newer answer is kept and now shown here; choose again to change it.`;
        toast(text);
        setAnnouncement(text);
      }),
    [initial.questions, saving, toast],
  );

  /** At the deadline: accept no more changes, let a save already on its way finish, then fetch the server's
      final result. Nothing is backdated and the deadline is never extended. The whole process is bounded:
      after EXPIRY_BOUND_MS the page offers its recovery choices even if a request never settles. */
  const expire = useCallback(async () => {
    if (expiring.current || finished.current) return;
    expiring.current = true;
    const run = ++expiryRun.current;
    const current = () => run === expiryRun.current && !finished.current;
    const giveUp = (error: string) => {
      if (!current()) return;
      expiryRun.current++; // A late reply of this run is ignored; "Try again" starts a new one.
      expiring.current = false;
      setFinishing({ error });
    };
    sync.close("expired");
    setConfirming(false);
    setFinishing({ error: null });
    const watchdog = setTimeout(() => giveUp("TrainCheck is taking too long to reply."), EXPIRY_BOUND_MS);
    try {
      await Promise.race([sync.settled(), wait(IN_FLIGHT_WAIT_MS)]);
      if (!current()) return;
      const outcome = await loadFinalResult((signal) => api.get(`/attempts/${attempt.attempt_id}/result`, { signal: signal ?? undefined }), wait, Math.random);
      if (!current()) return;
      if (!outcome.ok) {
        giveUp(outcome.failure.message);
        return;
      }
      const n = sync.unsaved();
      goToResult(n ? `Time is up. ${answers(n)} could not be confirmed as saved before the deadline and may not count.` : "Time is up. All your answers were saved and your assessment was submitted.");
    } finally {
      clearTimeout(watchdog);
    }
  }, [attempt.attempt_id, goToResult, sync]);

  const saveAnswer = (questionId: string, selected: string[]) => {
    if (!sync.set(questionId, selected)) return; // After the deadline, once closed, or while submitting.
    setAttempt((a) => ({ ...a, questions: a.questions.map((q) => (q.attempt_question_id === questionId ? { ...q, selected_option_ids: selected } : q)) }));
  };

  /* ---------- Timer. The display only; the server decides when time is up. ---------- */

  useEffect(() => {
    const tick = () => {
      const left = remainingNow();
      setRemaining(left);
      if (left === 0) {
        if (!timeUp.current) {
          timeUp.current = true; // Once: after that, only "Try again" retries loading the result.
          void expire();
        }
      } else if (left <= CRITICAL_SECONDS && !warned.current.critical) {
        warned.current = { warning: true, critical: true };
        const text = "Less than 1 minute remains. Answers saved on the server by the deadline will be submitted automatically when time runs out.";
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
  }, [expire, remainingNow, toast]);

  /* ---------- Monitoring ---------- */

  useEffect(() => {
    if (!attempt.monitored) return;
    const report = async (type: ViolationType) => {
      try {
        const result = await api.post<{ counted: boolean; violation_count: number; violation_limit: number; auto_submitted: boolean; status: string }>(`/attempts/${attempt.attempt_id}/security-events`, { event_type: type });
        setAttempt((a) => ({ ...a, violation_count: result.violation_count }));
        if (result.auto_submitted || result.status !== "IN_PROGRESS") closedByServer(`Your assessment was submitted automatically after ${result.violation_count} security violations.`);
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
  }, [attempt.attempt_id, attempt.monitored, closedByServer]);

  /* ---------- Connection: an interruption is recorded, never counted as a violation ---------- */

  useEffect(() => {
    const onOffline = () => {
      setOnline(false);
      interruptedAt.current = Date.now();
      toast("You are offline. The timer keeps running. Answers not yet saved are kept on this page and sent when you reconnect, if the deadline has not passed.");
    };
    const onOnline = () => {
      setOnline(true);
      toast("Connection restored. You are continuing the same attempt; the timer was not paused.");
      if (interruptedAt.current !== null && attempt.monitored) {
        interruptedAt.current = null;
        void api.post(`/attempts/${attempt.attempt_id}/security-events`, { event_type: "NETWORK_INTERRUPTION" }).catch(() => {});
      }
      sync.retryNow();
    };
    const heartbeat = setInterval(async () => {
      try {
        const response = await fetch("/api/v1/system/ping", { cache: "no-store" });
        if (response.ok) {
          setOnline(true);
          sync.retryNow();
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
  }, [attempt.attempt_id, attempt.monitored, sync, toast]);

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

  /** Submits only once every chosen answer is confirmed by the server. One request at a time; no changes are
      accepted while it runs. If saving fails, the assessment stays open with the answers kept. */
  const submit = async () => {
    if (submitBusy.current || finished.current || expiring.current) return;
    const run = ++submitRun.current;
    const current = () => run === submitRun.current && !finished.current;
    submitBusy.current = true;
    setSubmitting(true);
    setSubmitError(null);
    sync.lock();
    const release = (problem: string) => {
      if (!current()) return;
      submitRun.current++; // Anything this run was still waiting for is ignored from now on.
      sync.unlock();
      submitBusy.current = false;
      setSubmitting(false);
      setSubmitError(problem);
    };
    // Bounded: saving that neither succeeds nor fails in time releases the dialog; answers stay queued and stored.
    const tooSlow = wait(SUBMIT_SAVE_BOUND_MS).then((): FlushOutcome => ({ ok: false, kind: "timeout", unsaved: sync.unsaved(), message: null }));
    const outcome = await Promise.race([sync.flush(), tooSlow]);
    if (!current()) return;
    if (!outcome.ok) {
      if (outcome.kind === "expired") {
        submitRun.current++;
        submitBusy.current = false;
        void expire();
      } else if (outcome.kind === "closed") closedByServer("This assessment has already been submitted.");
      else release(flushProblem(outcome));
      return;
    }
    try {
      // Idempotent on the server: a repeat returns the same result, so a submission whose reply was lost is safe
      // to send again.
      await api.post(`/attempts/${attempt.attempt_id}/submit`, {}, { timeoutMs: SUBMIT_TIMEOUT_MS });
      if (!current()) return;
      sync.close("submitted");
      sync.forget();
      goToResult("Assessment submitted. All your answers were saved.");
    } catch (error) {
      if (!current()) return;
      const failure = error as ApiError;
      if (failure.code === "ATTEMPT_ALREADY_SUBMITTED") closedByServer(failure.message);
      else if (failure.code === "TIMEOUT" || failure.code === "INVALID_RESPONSE")
        release("TrainCheck did not confirm the submission. It may already have been received: select Try again, which is safe and returns the same result. Your answers are saved.");
      else release(`${failure.message} Your answers are saved; submit again.`);
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

  const keptNote = save.durable ? " They are also kept on this device if the page closes." : " Keep this page open: this browser cannot keep them if the page closes.";
  const retryReason: Partial<Record<NonNullable<SyncSnapshot["failure"]>, string>> = {
    network: "TrainCheck cannot be reached; retrying automatically.",
    timeout: "TrainCheck did not reply in time; retrying automatically.",
    invalid: "TrainCheck sent a reply this page could not read, so nothing is confirmed; retrying automatically.",
    "rate-limited": "Retrying shortly, as TrainCheck asked.",
  };
  const savedLine =
    save.status === "saved" ? (
      <>
        <Icon name="check" /> Answers saved on the server
        {save.failure === "conflict" ? ". An answer changed in another window or on another device is shown as saved there." : null}
      </>
    ) : save.status === "saving" ? (
      <>
        <Icon name="clock" /> Saving…{save.unsaved && !save.durable ? keptNote : null}
      </>
    ) : save.status === "retrying" ? (
      <>
        <Icon name="alert" /> {answers(save.unsaved)} not saved yet. {(save.failure && retryReason[save.failure]) ?? "Temporary problem at TrainCheck; retrying automatically."}
        {keptNote}
      </>
    ) : save.status === "unsaved" ? (
      <>
        <Icon name="alert" /> {answers(save.unsaved)} not saved.{" "}
        {save.failure === "signed-out" ? "Your session has ended. Sign in again to continue this attempt." : save.failure === "forbidden" ? (save.message ?? "TrainCheck refused the change.") : `${save.message ?? "The server refused it."} Change or clear that answer.`}
      </>
    ) : (
      <>
        <Icon name="lock" /> Answers can no longer be changed.
        {save.unsaved ? ` ${answers(save.unsaved)} could not be saved in time.` : ""}
      </>
    );
  const locked = submitting || Boolean(finishing) || save.status === "closed";

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
                      <input type={question.question_type === "MCQ_MULTIPLE" ? "checkbox" : "radio"} name="exam-answer" value={option.option_id} checked={chosen} disabled={locked} onChange={(e) => toggle(option.option_id, e.target.checked)} />
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
                  <Btn kind="text" id="exam-clear" disabled={locked || !question.selected_option_ids.length} onClick={() => saveAnswer(question.attempt_question_id, [])}>
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
      {confirming && !finishing ? (
        <Modal
          title="Submit your assessment?"
          onClose={() => {
            if (submitting) return; // Cannot be dismissed half-way through submitting.
            setConfirming(false);
            setSubmitError(null);
          }}
        >
          <p>
            {stats.answered} of {stats.total} questions answered.{" "}
            {stats.unanswered ? (
              <strong>
                {stats.unanswered} unanswered question{stats.unanswered > 1 ? "s" : ""} will receive no marks.
              </strong>
            ) : null}{" "}
            {stats.marked ? `${stats.marked} still marked for review.` : ""}
          </p>
          <p>You cannot change your answers after submitting. Your answers are saved first; the assessment is submitted only once every answer is confirmed.</p>
          {submitError ? (
            <div className="notice danger" role="alert">
              <div>
                <strong>Not submitted.</strong> {submitError}
              </div>
            </div>
          ) : null}
          <div className="dialog-actions">
            <Btn
              disabled={submitting}
              onClick={() => {
                setConfirming(false);
                setSubmitError(null);
              }}
            >
              Keep working
            </Btn>
            <Btn kind="primary" disabled={submitting} onClick={() => void submit()}>
              {submitting ? "Saving and submitting…" : submitError ? "Try again" : "Submit assessment"}
            </Btn>
          </div>
        </Modal>
      ) : null}
      {finishing ? (
        <Modal title="Time is up" onClose={() => undefined}>
          {finishing.error ? (
            <>
              <p>No more changes are accepted. Your result could not be loaded yet: {finishing.error}</p>
              <p className="small">Your assessment is finished on the server; nothing more needs to be sent.</p>
              <div className="dialog-actions">
                <Btn onClick={() => goToResult(save.unsaved ? `Time is up. ${answers(save.unsaved)} could not be confirmed as saved before the deadline and may not count.` : "Time is up.")}>Go to my result</Btn>
                <Btn kind="primary" onClick={() => void expire()}>
                  Try again
                </Btn>
              </div>
            </>
          ) : (
            <p role="status">
              <Icon name="clock" /> No more changes are accepted. Finishing your assessment and loading your result…
            </p>
          )}
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
