"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { FocusShell } from "@/components/shell/AppShell";
import { countdownTarget, landingPath } from "@/components/shell/nav";
import { Btn, BtnLink, ErrorPanel, Loading, Metrics } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import type { QueueItem, TrainingCard } from "@/lib/types";
import { dateTimeIn } from "@/lib/utils";
import { countdown, milestone, PREPARE_WINDOW_MS, serverClock, shortCountdown, waitingStep } from "./assessmentEntry";

/** What GET /me/assessment-obligations/{id} returns: rules and entry state, never questions. */
interface EntryDetail extends QueueItem {
  entry_state: NonNullable<TrainingCard["entry_state"]>;
  entry_reason: string | null;
  entry_message: string | null;
  server_now: string;
  timezone: string | null;
}

const TICK_MS = 1_000;
/** Re-synced with the server this often while waiting: schedule changes, and drift after sleep. */
const RESYNC_MS = 60_000;
const WINDOW_RESYNC_MS = 15_000;
/** Returning to the tab re-syncs at most this often. */
const RETURN_RESYNC_MS = 5_000;
/** After the opening, a server answer of "not yet" is asked again no sooner than this. */
const RECHECK_MS = 5_000;
const GATE = "/access/assessment-required";
const TRAININGS = "/employee/trainings";

/** Opened by Start Test on a My Trainings card. Before the opening time it shows a countdown and creates nothing:
    no attempt, no questions, no timer. At the opening time it asks the server again; only when the server's gate
    says the assessment is due does the usual gate take over, with its system check, instructions and confirmation.
    The countdown is timed against the server's clock; the device clock is never trusted. */
export function AssessmentWaiting({ obligationId }: { obligationId: string }) {
  const router = useRouter();
  const { user, ready, access, error: sessionError, refresh } = useSession();
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  // Not shown before the first server answer, so reading it here cannot cause a hydration mismatch.
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const timing = useRef<{ clock: ReturnType<typeof serverClock>; due: string } | null>(null);
  const generation = useRef(0); // Answers to older requests (before a newer sync or after leaving) are ignored.
  const lastSync = useRef(0);
  const lastRecheck = useRef(-Infinity);
  const previousRemaining = useRef<number | null>(null);
  const previousDue = useRef<string | null>(null);
  const waited = useRef(false);
  const sessionCountdown = useRef(false);
  const showingHere = countdownTarget(access)?.obligation_id === obligationId;
  useEffect(() => { sessionCountdown.current = showingHere; }, [showingHere]);

  const remainingNow = () => (timing.current ? timing.current.clock.remainingMs(timing.current.due, performance.now()) : null);

  /** Asks the server for the assessment's state and clock. With `gate`, the access decision is re-checked too. */
  const sync = useCallback(
    async (gate = false) => {
      const mine = ++generation.current;
      lastSync.current = performance.now();
      try {
        const [d] = await Promise.all([api.get<EntryDetail>(`/me/assessment-obligations/${obligationId}`), gate ? refresh() : Promise.resolve()]);
        if (mine !== generation.current) return;
        const received = performance.now();
        if (previousDue.current && previousDue.current !== d.due_at && d.entry_state === "NOT_YET_OPEN")
          setAnnouncement(`The opening time changed to ${dateTimeIn(d.due_at, d.timezone)}.`);
        previousDue.current = d.due_at;
        timing.current = d.due_at ? { clock: serverClock(d.server_now, received), due: d.due_at } : null;
        const left = remainingNow();
        previousRemaining.current = left;
        setRemaining(left);
        setDetail(d);
        setLoadError(null);
        setUnreachable(false);
        // A cancelled/rescheduled countdown must not reopen from a stale session answer.
        if (!gate && sessionCountdown.current && (d.entry_state !== "NOT_YET_OPEN" || left === null || left > PREPARE_WINDOW_MS)) void refresh();
      } catch (e) {
        if (mine !== generation.current) return;
        const failure = e as ApiError;
        if (failure.status === 0 || failure.status >= 500) setUnreachable(true);
        else setLoadError(failure); // 404 and other final answers. An ended session goes to sign-in by itself.
      }
    },
    [obligationId, refresh],
  );

  useEffect(() => {
    const requests = generation;
    // Loading on mount is the purpose of this effect, as in SessionProvider.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sync();
    return () => {
      requests.current++;
    };
  }, [sync]);

  const step = waitingStep(detail, access);
  const inWindow = remaining !== null && remaining <= PREPARE_WINDOW_MS;
  useEffect(() => { if (step === "wait") waited.current = true; }, [step]);

  useEffect(() => {
    if (!ready) return;
    if (!user && !sessionError) router.replace("/login");
    else if (user && step === "gate") {
      const first = access?.queue[0];
      const prepare = waited.current && first?.obligation_id === obligationId && !first.in_progress;
      router.replace(prepare ? `${GATE}?fromCountdown=${encodeURIComponent(obligationId)}` : GATE);
    }
    else if (user && step === "workspace") router.replace(landingPath(user, access));
  }, [ready, user, sessionError, step, access, router, obligationId]);

  /** At (or after) the opening: confirm with the server, at most every few seconds, never while offline. */
  const recheck = useCallback(() => {
    if (!navigator.onLine || performance.now() - lastRecheck.current < RECHECK_MS) return;
    lastRecheck.current = performance.now();
    setAnnouncement("Checking with TrainCheck that your assessment is open.");
    void sync(true);
  }, [sync]);

  // The server says it is open but the access decision on this page is older: re-check it, never open anything.
  useEffect(() => {
    if (step === "confirm") recheck();
  }, [step, recheck]);

  // The countdown, from the server's clock and a monotonic timer. Milestones are announced, seconds are not.
  useEffect(() => {
    if (step !== "wait") return;
    const timer = window.setInterval(() => {
      const left = remainingNow();
      if (left === null) return;
      const said = previousRemaining.current === null ? null : milestone(previousRemaining.current, left);
      if (said) setAnnouncement(said);
      previousRemaining.current = left;
      setRemaining(left);
      if (left <= 0) recheck();
      else if (performance.now() - lastSync.current >= (inWindow ? WINDOW_RESYNC_MS : RESYNC_MS)) void sync();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [step, inWindow, sync, recheck]);

  // Returning to the tab, waking from sleep or reconnecting re-syncs with the server.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== "visible" || performance.now() - lastSync.current < RETURN_RESYNC_MS) return;
      const left = remainingNow();
      if (left !== null && left <= 0) recheck();
      else void sync();
    };
    const goOnline = () => {
      setOnline(true);
      lastSync.current = 0;
      lastRecheck.current = -Infinity;
      const left = remainingNow();
      void sync(left !== null && left <= 0);
    };
    const goOffline = () => setOnline(false);
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [sync, recheck]);

  if (sessionError) {
    // The gate decision is unknown, so nothing opens (TC-GATE-010).
    return (
      <FocusShell>
        <section className="gate-panel">
          <ErrorPanel error={sessionError} retry={() => window.location.reload()} />
        </section>
      </FocusShell>
    );
  }

  if (loadError) {
    const missing = loadError.status === 404;
    return (
      <FocusShell>
        <section className="gate-panel">
          <span className="eyebrow">ASSESSMENT</span>
          {missing ? <h1 tabIndex={-1}>This assessment is not available</h1> : <ErrorPanel error={loadError} retry={() => void sync()} />}
          {missing ? <p>The link may be wrong. My Trainings shows every assessment you can take.</p> : null}
          <BtnLink href={TRAININGS} kind="primary">
            Back to My Trainings <Icon name="arrow" />
          </BtnLink>
        </section>
      </FocusShell>
    );
  }

  if (!ready || !user || !detail || step === "loading" || step === "gate" || step === "workspace") {
    if (unreachable && !detail)
      return (
        <FocusShell>
          <section className="gate-panel">
            <ErrorPanel error={new ApiError(0, "NETWORK_ERROR", "TrainCheck cannot be reached right now. Check your connection, then try again.")} retry={() => void sync()} />
          </section>
        </FocusShell>
      );
    return <Loading label={step === "gate" ? "Opening your assessment…" : "Checking your assessment…"} />;
  }

  const facts = (
    <div className="gate-training">
      <span className="eyebrow">POST-TRAINING ASSESSMENT</span>
      <h2>{detail.training_title}</h2>
      {detail.training_description ? <p>{detail.training_description}</p> : null}
      <Metrics
        items={[
          ["Questions", detail.question_count, "One at a time"],
          ["Time limit", `${Math.round(detail.duration_seconds / 60)} min`, "Starts only when you begin"],
          ["Pass mark", `${detail.pass_mark_percent}%`, "Inclusive threshold"],
        ]}
      />
    </div>
  );
  const back = (
    <BtnLink href={TRAININGS}>
      <Icon name="back" /> Back to My Trainings
    </BtnLink>
  );
  const status = (
    <p className="sr-only" role="status" aria-atomic="true">
      {announcement}
    </p>
  );

  if (step === "unavailable") {
    return (
      <FocusShell>
        <section className="gate-panel">
          <div className="gate-icon">
            <Icon name="alert" />
          </div>
          <span className="eyebrow">ASSESSMENT NOT AVAILABLE</span>
          <h1 tabIndex={-1}>This assessment cannot be taken now</h1>
          <p className="lead">{detail.entry_message ?? "TrainCheck did not give a reason. Please contact L&D."}</p>
          {facts}
          {back}
          {status}
        </section>
      </FocusShell>
    );
  }

  const open = remaining !== null && remaining <= 0;
  const waitingForConnection = (open || step === "confirm") && (!online || unreachable);
  const checking = (open || step === "confirm") && !waitingForConnection;
  return (
    <FocusShell footer="Your assessment has not started. No timer is running and no questions are shown.">
      <section className="gate-panel assessment-waiting">
        <div className="gate-icon">
          <Icon name="clock" />
        </div>
        <span className="eyebrow">{checking ? "CONFIRMING WITH TRAINCHECK" : "YOUR ASSESSMENT IS SCHEDULED"}</span>
        {checking ? (
          <h1 tabIndex={-1}>Checking that your assessment is open…</h1>
        ) : (
          // Plain text inside the heading, so the time is part of its accessible name. Not a live region: seconds
          // are never announced; milestones go to the status message below.
          <h1 tabIndex={-1}>
            Your assessment opens in <span className="waiting-countdown">{inWindow ? shortCountdown(remaining ?? 0) : countdown(remaining ?? 0)}</span>
          </h1>
        )}
        {detail.due_at ? <p className="lead">Opens {dateTimeIn(detail.due_at, detail.timezone)}</p> : null}
        <p>
          When the countdown ends, TrainCheck confirms the opening and takes you to the system check and instructions. Your assessment starts only when you select Start assessment.
        </p>
        {waitingForConnection ? (
          <div className="notice danger left" role="alert">
            <Icon name="wifi" />
            <div>
              <strong>Waiting for a connection to confirm your assessment is open.</strong> It opens here as soon as TrainCheck can be reached.
            </div>
          </div>
        ) : !online || unreachable ? (
          <div className="notice left">
            <Icon name="wifi" />
            <div>
              <strong>{online ? "TrainCheck cannot be reached right now." : "You are offline."}</strong> The countdown continues. TrainCheck confirms the opening time when you reconnect.
            </div>
          </div>
        ) : null}
        {checking && step === "confirm" ? (
          <Btn onClick={() => { lastRecheck.current = -Infinity; recheck(); }}>
            <Icon name="refresh" /> Check again
          </Btn>
        ) : null}
        {facts}
        {inWindow ? null : back}
        {status}
      </section>
    </FocusShell>
  );
}
