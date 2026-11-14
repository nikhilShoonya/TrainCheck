"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { FocusShell } from "@/components/shell/AppShell";
import { landingPath } from "@/components/shell/nav";
import { Btn, ErrorPanel, Loading, Metrics } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import type { AccessState, AttemptView } from "@/lib/types";
import { clock, firstName, greeting } from "@/lib/utils";
import { ExamView } from "./ExamView";
import { enterFullscreen, isFullscreen, runSystemCheck, systemCheckPassed, type Check } from "./monitor";

const STEPS = ["System check", "Full screen", "Instructions", "Assessment"];
const DETAIL_RETRY_DELAYS_MS = [700, 2000, 4000];
const minutesLabel = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
};
const STATUS: Record<Check["status"], [string, string]> = { pass: ["Ready", "check"], fail: ["Action needed", "x"], warn: ["Advisory", "alert"], info: ["Not applicable", "help"] };
const CHECK_ICONS: Record<string, string> = { browser: "globe", javascript: "code", internet: "wifi", application: "monitor", storage: "storage", fullscreen: "maximize", screen: "monitor", compatibility: "shield" };

/** Retries a load quietly after a momentary database or network hiccup (status 0 or 5xx). */
async function withRetry<T>(load: () => Promise<T>, alive: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (e) {
      const failure = e as ApiError;
      const transient = failure.status === 0 || failure.status >= 500;
      if (!transient || attempt >= DETAIL_RETRY_DELAYS_MS.length || !alive()) throw failure;
      await new Promise((resolve) => setTimeout(resolve, DETAIL_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function Stage({ step, children }: { step: number; children: React.ReactNode }) {
  return (
    <FocusShell>
      <div className="exam-stage">
        <ol className="exam-steps" aria-label="Assessment steps">
          {STEPS.map((label, i) => (
            <li key={label} className={i < step ? "done" : i === step ? "current" : ""} aria-current={i === step ? "step" : undefined}>
              <span className="step-dot">{i < step ? <Icon name="check" /> : i + 1}</span>
              <span>
                {label}
                {i < step ? <span className="sr-only"> (completed)</span> : null}
              </span>
            </li>
          ))}
        </ol>
        <section className="exam-stage-card">{children}</section>
      </div>
    </FocusShell>
  );
}

/* ---------- The secure start, shared by post-training assessments and pre-tests ---------- */

type SecureScreen = "check" | "fullscreen" | "instructions" | "resume" | "exam";

interface SecureRules {
  require_fullscreen: boolean;
  violation_limit: number;
}

interface SecureStartProps {
  /** "assessment" or "pre-test": used in headings and rules. */
  noun: string;
  trainingTitle: string;
  facts: [string, string, string | number][];
  /** Null while the rules are loading: Continue waits, so the full-screen step can never be skipped. */
  rules: SecureRules | null;
  /** An attempt already running (refresh, second tab): resumed in full screen instead of starting again. */
  running: AttemptView | null;
  start: () => Promise<AttemptView>;
  onStartFailed: (error: ApiError) => void;
}

/** System check → full screen (when required) → acknowledged instructions → the monitored exam. */
function SecureStart({ noun, trainingTitle, facts, rules, running, start, onStartFailed }: SecureStartProps) {
  const [screen, setScreen] = useState<SecureScreen>(running ? "resume" : "check");
  const [attempt, setAttempt] = useState<AttemptView | null>(running);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const requireFullscreen = rules?.require_fullscreen ?? true; // Assumed until the rules are known.
  const limit = rules?.violation_limit ?? 3;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  useEffect(() => {
    if (running) return;
    let alive = true;
    void runSystemCheck(true).then((result) => alive && setChecks(result));
    return () => {
      alive = false;
    };
  }, [running]);

  const retryChecks = async () => {
    setChecks(null);
    setChecks(await runSystemCheck(requireFullscreen));
  };

  const goFullscreen = async (next: SecureScreen) => {
    setFullscreenError("");
    const problem = await enterFullscreen();
    if (problem) setFullscreenError(problem);
    else setScreen(next);
  };

  const begin = async () => {
    if (requireFullscreen && !isFullscreen()) {
      setFullscreenError(`Full screen was turned off before the ${noun} started. Enter full screen again.`);
      setScreen("fullscreen");
      return;
    }
    setBusy(true);
    try {
      setAttempt(await start());
      setScreen("exam");
    } catch (e) {
      onStartFailed(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (screen === "exam" && attempt) return <ExamView initial={attempt} />;

  if (screen === "check") {
    const passed = systemCheckPassed(checks);
    const failed = checks?.filter((c) => c.essential && c.status !== "pass") ?? [];
    return (
      <Stage step={0}>
        <h1 tabIndex={-1}>System check</h1>
        <p className="lead">Before the timer starts, we confirm that this browser can run the {noun} and reach TrainCheck to save your answers.</p>
        <ul className="check-list" aria-busy={!checks} aria-live="polite">
          {checks
            ? checks.map((c) => (
                <li className="check-row" key={c.id}>
                  <span className="check-icon">
                    <Icon name={CHECK_ICONS[c.id] ?? "shield"} />
                  </span>
                  <div>
                    <strong>
                      {c.label}
                      {c.essential ? "" : " "}
                      {c.essential ? null : <small>(optional)</small>}
                    </strong>
                    <small>{c.detail}</small>
                  </div>
                  <span className={`check-status ${c.status}`}>
                    <Icon name={STATUS[c.status][1]} />
                    {STATUS[c.status][0]}
                  </span>
                </li>
              ))
            : Array.from({ length: 7 }, (_, i) => (
                <li className="check-row loading" key={i}>
                  <span className="check-icon" />
                  <div>
                    <strong>Checking…</strong>
                    <small>&nbsp;</small>
                  </div>
                </li>
              ))}
        </ul>
        {failed.length ? (
          <div className="notice danger" role="alert">
            <Icon name="alert" />
            <div>
              <strong>
                {failed.length} required check{failed.length > 1 ? "s" : ""} need attention.
              </strong>{" "}
              Fix {failed.map((c) => c.label.toLowerCase()).join(", ")}, then select Retry check.
            </div>
          </div>
        ) : null}
        <div className="exam-stage-actions">
          <Btn onClick={() => void retryChecks()}>
            <Icon name="refresh" /> Retry check
          </Btn>
          {/* Waits for the rules: before they arrive, the full-screen step could be skipped by mistake. */}
          <Btn kind="primary" disabled={!passed || !rules} onClick={() => rules && setScreen(rules.require_fullscreen ? "fullscreen" : "instructions")}>
            {rules ? "Continue" : `Loading ${noun}…`} <Icon name="arrow" />
          </Btn>
        </div>
        <p className="small">Checks use this browser&apos;s own capabilities and a request to TrainCheck only. No speed test is run.</p>
      </Stage>
    );
  }

  if (screen === "fullscreen" || screen === "resume") {
    const resume = screen === "resume" && attempt;
    return (
      <Stage step={resume ? 3 : 1}>
        <div className="fs-visual" aria-hidden="true">
          <Icon name="maximize" />
        </div>
        <h1 tabIndex={-1}>{resume ? "Resume in full screen" : "Enable full screen"}</h1>
        <p className="lead">
          {resume ? (
            <>
              Your <strong>{trainingTitle}</strong> {noun} is still in progress. The timer kept running and {clock(attempt.remaining_seconds)} remain. Your saved answers are waiting.
            </>
          ) : (
            `This ${noun} must be taken in full-screen mode. Select the button below; your browser may ask you to confirm.`
          )}
        </p>
        {fullscreenError ? (
          <div className="notice danger" role="alert">
            <Icon name="alert" />
            <div>
              <strong>Full screen did not start.</strong> {fullscreenError}
            </div>
          </div>
        ) : null}
        <div className="exam-stage-actions center">
          <Btn kind="primary" large onClick={() => void goFullscreen(resume ? "exam" : "instructions")}>
            <Icon name="maximize" /> {resume ? "Enter full screen and resume" : "Enter full screen"}
          </Btn>
        </div>
        <p className="small centered">
          Leaving full screen during the {noun} is recorded as a security violation. {limit} violations submit the {noun} automatically.
        </p>
      </Stage>
    );
  }

  const rulesList: [string, string][] = [
    ["Navigation", "Questions appear one at a time. Use Previous, Next or the question navigator. You can change answers until you submit."],
    ["Mark for review", "Flag any question to revisit later. Marking does not affect your score."],
    ["Saving", "Each answer is saved to the server as soon as you select it. A refresh or lost connection does not lose saved answers."],
    ["Timer", `The timer starts when you select Start ${noun}. It keeps running if you refresh, close the tab or lose connection. When time runs out, saved answers are submitted automatically.`],
    ...(requireFullscreen ? ([["Full screen", "Stay in full screen until you submit. Questions are hidden while full screen is off."]] as [string, string][]) : []),
    ["Tabs and windows", "Do not switch tabs, open other windows or move focus away from this window."],
    ["Restricted actions", `Copy, cut, paste, the right-click menu and browser back navigation are disabled during the ${noun}.`],
    ["Violation policy", `Each security event is a violation. Violation 1 shows a warning, violation ${limit - 1} a final warning, and violation ${limit} submits the ${noun} automatically. Losing your internet connection is not a violation.`],
    ["Automatic submission", `The ${noun} is submitted automatically when time expires or the violation limit is reached. Unanswered questions receive no marks. Violations do not change your score.`],
    ["Monitoring", "Browser-level, best-effort monitoring records only the event type and time. No camera, screen recording or keystroke capture is used."],
  ];
  return (
    <Stage step={2}>
      <h1 tabIndex={-1}>{Noun} instructions</h1>
      <p className="lead">Read these rules before you start. The timer begins only when you select Start {noun}.</p>
      <div className="instructions-grid">
        <dl className="instruction-facts">
          {facts.map(([icon, label, value]) => (
            <div key={label}>
              <dt>
                <Icon name={icon} />
                {label}
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <section className="instruction-rules" aria-labelledby="rules-title">
          <h2 id="rules-title">
            <Icon name="shield" /> Important rules
          </h2>
          <ul>
            {rulesList.map(([label, text]) => (
              <li key={label}>
                <strong>{label}.</strong> {text}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="exam-stage-actions split">
        <label className="ack-line">
          <input type="checkbox" name="exam-ack" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read and understood the instructions.
        </label>
        <Btn kind="primary" large id="exam-begin" disabled={!ack || busy} onClick={() => void begin()}>
          {busy ? "Starting…" : `Start ${noun}`} <Icon name="arrow" />
        </Btn>
      </div>
    </Stage>
  );
}

/* ---------- Post-training assessment gate ---------- */

type Item = AccessState["queue"][number];

interface Detail extends Item {
  active_attempt_id: string | null;
  violation_limit: number;
  require_fullscreen: boolean;
  refresher: { text: string | null; url: string | null };
}

export function GateFlow() {
  const router = useRouter();
  const { user, ready, access, refresh } = useSession();
  const [secure, setSecure] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [running, setRunning] = useState<AttemptView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const item = access?.queue[0];

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else if (access && access.access_status !== "ASSESSMENT_REQUIRED") router.replace(landingPath(user, access));
  }, [ready, user, access, router]);

  useEffect(() => {
    if (!item) return;
    let current = true;
    // Without the detail the screen cannot know whether an attempt is already running, so a hiccup is retried
    // quietly instead of falling back to the start screen.
    withRetry(async () => {
      const d = await api.get<Detail>(`/me/assessment-obligations/${item.obligation_id}`);
      // A refresh or new tab during an attempt must re-enter full screen to resume (BR §6.5).
      const attempt = d.active_attempt_id ? await api.get<AttemptView>(`/attempts/${d.active_attempt_id}`) : null;
      return { d, attempt };
    }, () => current)
      .then(({ d, attempt }) => {
        if (!current) return;
        setDetail(d);
        if (attempt) {
          if (attempt.status === "IN_PROGRESS") {
            setRunning(attempt);
            setSecure(true);
          } else router.replace(`/results/${attempt.attempt_id}`);
        }
      })
      .catch((e) => current && setError(e as ApiError));
    return () => {
      current = false;
    };
  }, [item, router]);

  const acknowledge = async () => {
    if (!item) return;
    setBusy(true);
    try {
      await api.post(`/assessment-obligations/${item.obligation_id}/refresher-acknowledgement`);
      await refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (!ready || !user || !access) return <Loading label="Checking your access…" />;
  if (!item) return <Loading label="Opening your workspace…" />;

  if (secure) {
    return (
      <SecureStart
        key={running?.attempt_id ?? "new"}
        noun="assessment"
        trainingTitle={item.training_title}
        rules={detail}
        running={running}
        facts={[
          ["clipboard", "Assessment", item.training_title],
          ["file", "Questions", item.question_count],
          ["clock", "Duration", minutesLabel(item.duration_seconds)],
          ["target", "Pass mark", `${item.pass_mark_percent}% or higher`],
          ["refresh", "Attempt", `${item.attempts_used + 1} of ${item.max_attempts}`],
        ]}
        start={() => api.post<AttemptView>(`/assessment-obligations/${item.obligation_id}/attempts`, { instructions_acknowledged: true })}
        onStartFailed={(e) => {
          setError(e);
          setSecure(false);
        }}
      />
    );
  }

  return (
    <FocusShell>
      <div className="gate-panel">
        <div className="gate-icon">
          <Icon name="shield" />
        </div>
        <span className="eyebrow">A MOMENT TO CHECK YOUR LEARNING</span>
        <h1 tabIndex={-1}>{greeting()}, {firstName(user.full_name)}.</h1>
        <p className="lead">Your training assessment is due.</p>
        <p>Complete your due assessments before opening your TrainCheck workspace.</p>
        {error ? <ErrorPanel error={error} /> : null}
        <div className="gate-training">
          <span className="eyebrow">
            UP NEXT · {access.pending_count} ASSESSMENT{access.pending_count > 1 ? "S" : ""} REMAINING
          </span>
          <h2>{item.training_title}</h2>
          <p>{item.training_description}</p>
          <Metrics
            items={[
              ["Questions", item.question_count, "One at a time"],
              ["Time limit", `${Math.round(item.duration_seconds / 60)} min`, "Continues on refresh"],
              ["Pass mark", `${item.pass_mark_percent}%`, "Inclusive threshold"],
            ]}
          />
        </div>
        {item.refresher_required ? (
          <div className="notice left">
            <strong>Refresher first.</strong>
            <p>{detail?.refresher.text ?? "Review the training material before your retake."}</p>
            {detail?.refresher.url ? (
              <p>
                <a href={detail.refresher.url} target="_blank" rel="noopener noreferrer">
                  Open refresher material
                </a>
              </p>
            ) : null}
            <Btn tone="success" disabled={busy} onClick={() => void acknowledge()}>
              Acknowledge refresher
            </Btn>
            <p className="small">This records that you reviewed the guidance. It is not proof of learning.</p>
          </div>
        ) : (
          <Btn
            kind="wide"
            onClick={() => {
              setError(null);
              setSecure(true);
            }}
          >
            Start assessment <Icon name="arrow" />
          </Btn>
        )}
        <p className="small">You can review your answers before submitting. Unanswered questions receive no marks.</p>
        {access.queue.length > 1 ? (
          <details>
            <summary>View assessment queue</summary>
            <ol>
              {access.queue.map((q) => (
                <li key={q.obligation_id}>{q.training_title}</li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
    </FocusShell>
  );
}

/* ---------- Pre-test ---------- */

interface PreTestInfo {
  enrolment_id: string;
  training_title: string;
  training_description: string | null;
  available: boolean;
  question_count: number | null;
  duration_seconds: number | null;
  violation_limit: number | null;
  require_fullscreen: boolean;
  active_attempt_id: string | null;
}

/** Optional pre-test before training. Records a baseline and never blocks sign-in, but it is taken in the same
 *  secure environment as the post-training assessment: system check, full screen, instructions, monitoring. */
export function PreTestFlow({ enrolmentId }: { enrolmentId: string }) {
  const router = useRouter();
  const [info, setInfo] = useState<PreTestInfo | null>(null);
  const [running, setRunning] = useState<AttemptView | null>(null);
  const [secure, setSecure] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [attemptLoad, setAttemptLoad] = useState(0);

  useEffect(() => {
    let current = true;
    withRetry(async () => {
      const pre = await api.get<PreTestInfo>(`/me/pre-tests/${enrolmentId}`);
      const attempt = pre.active_attempt_id ? await api.get<AttemptView>(`/attempts/${pre.active_attempt_id}`) : null;
      return { pre, attempt };
    }, () => current)
      .then(({ pre, attempt }) => {
        if (!current) return;
        setInfo(pre);
        setLoadError(null);
        if (attempt?.status === "IN_PROGRESS") {
          // A refresh or a second tab during the pre-test resumes it in full screen.
          setRunning(attempt);
          setSecure(true);
        } else if (attempt) router.replace(`/results/${attempt.attempt_id}`);
      })
      .catch((e) => current && setLoadError(e as ApiError));
    return () => {
      current = false;
    };
  }, [enrolmentId, router, attemptLoad]);

  if (loadError) {
    const missing = loadError.status === 404;
    return (
      <FocusShell>
        <section className="gate-panel">
          <span className="eyebrow">PRE-TRAINING BASELINE</span>
          {missing ? <h1 tabIndex={-1}>This pre-test is not available</h1> : <ErrorPanel error={loadError} retry={() => setAttemptLoad((n) => n + 1)} />}
          {missing ? <p>The link may be wrong. Your trainings show every pre-test you can take.</p> : null}
          <Btn kind="wide" onClick={() => router.push("/employee/trainings")}>
            Open my trainings <Icon name="arrow" />
          </Btn>
        </section>
      </FocusShell>
    );
  }
  if (!info) return <Loading label="Opening the pre-test…" />;

  if (!info.available) {
    return (
      <FocusShell>
        <section className="gate-panel">
          <span className="eyebrow">PRE-TRAINING BASELINE · {info.training_title}</span>
          <h1 tabIndex={-1}>This pre-test is not available</h1>
          <p>It may already be taken or the training may be completed. Your trainings show every pre-test you can take.</p>
          <Btn kind="wide" onClick={() => router.push("/employee/trainings")}>
            Open my trainings <Icon name="arrow" />
          </Btn>
        </section>
      </FocusShell>
    );
  }

  if (secure) {
    return (
      <SecureStart
        key={running?.attempt_id ?? "new"}
        noun="pre-test"
        trainingTitle={info.training_title}
        rules={{ require_fullscreen: info.require_fullscreen, violation_limit: info.violation_limit ?? 3 }}
        running={running}
        facts={[
          ["clipboard", "Pre-test", info.training_title],
          ["file", "Questions", info.question_count ?? "—"],
          ["clock", "Duration", info.duration_seconds ? minutesLabel(info.duration_seconds) : "—"],
          ["target", "Purpose", "Baseline before training, not pass or fail"],
          ["refresh", "Attempts", "One"],
        ]}
        start={() => api.post<AttemptView>(`/me/pre-tests/${enrolmentId}/attempts`, { instructions_acknowledged: true })}
        onStartFailed={(e) => {
          setError(e);
          setSecure(false);
        }}
      />
    );
  }

  return (
    <FocusShell>
      <section className="gate-panel">
        <span className="eyebrow">PRE-TRAINING BASELINE · {info.training_title}</span>
        <h1 tabIndex={-1}>Optional pre-test</h1>
        <p>This records what you know before training so your learning gain can be measured. It does not count as your post-training assessment, and you can take it once.</p>
        {error ? <ErrorPanel error={error} /> : null}
        <div className="gate-training">
          <Metrics
            items={[
              ["Questions", info.question_count ?? "—", "One at a time"],
              ["Time limit", info.duration_seconds ? `${Math.round(info.duration_seconds / 60)} min` : "—", "Continues on refresh"],
              ["Environment", info.require_fullscreen ? "Full screen" : "Monitored", "Secure, like the assessment"],
            ]}
          />
        </div>
        <Btn
          kind="wide"
          onClick={() => {
            setError(null);
            setSecure(true);
          }}
        >
          Begin pre-test <Icon name="arrow" />
        </Btn>
        <Btn kind="text" onClick={() => router.push("/employee/trainings")}>
          Not now
        </Btn>
      </section>
    </FocusShell>
  );
}
