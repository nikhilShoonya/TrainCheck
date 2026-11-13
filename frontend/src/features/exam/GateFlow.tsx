"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { FocusShell } from "@/components/shell/AppShell";
import { HOME } from "@/components/shell/nav";
import { Btn, ErrorPanel, Loading, Metrics } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import type { AccessState, AttemptView } from "@/lib/types";
import { clock, firstName, greeting } from "@/lib/utils";
import { ExamView } from "./ExamView";
import { enterFullscreen, isFullscreen, runSystemCheck, systemCheckPassed, type Check } from "./monitor";

const STEPS = ["System check", "Full screen", "Instructions", "Assessment"];
const STATUS: Record<Check["status"], [string, string]> = { pass: ["Ready", "check"], fail: ["Action needed", "x"], warn: ["Advisory", "alert"], info: ["Not applicable", "help"] };
const CHECK_ICONS: Record<string, string> = { browser: "globe", javascript: "code", internet: "wifi", application: "monitor", storage: "storage", fullscreen: "maximize", screen: "monitor", compatibility: "shield" };

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

type Item = AccessState["queue"][number];
type Screen = "gate" | "check" | "fullscreen" | "instructions" | "resume" | "exam";

interface Detail extends Item {
  active_attempt_id: string | null;
  violation_limit: number;
  require_fullscreen: boolean;
  refresher: { text: string | null; url: string | null };
}

export function GateFlow() {
  const router = useRouter();
  const { user, ready, access, refresh } = useSession();
  const [screen, setScreen] = useState<Screen>("gate");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const item = access?.queue[0];

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else if (access && access.access_status !== "ASSESSMENT_REQUIRED") router.replace(HOME[user.primary_role]);
  }, [ready, user, access, router]);

  useEffect(() => {
    if (!item) return;
    let current = true;
    api
      .get<Detail>(`/me/assessment-obligations/${item.obligation_id}`)
      .then((d) => {
        if (!current) return;
        setDetail(d);
        // A refresh or new tab during an attempt must re-enter full screen to resume (BR §6.5).
        if (d.active_attempt_id) {
          return api.get<AttemptView>(`/attempts/${d.active_attempt_id}`).then((a) => {
            if (!current) return;
            setAttempt(a);
            if (a.status === "IN_PROGRESS") setScreen("resume");
            else router.replace(`/results/${a.attempt_id}`);
          });
        }
      })
      .catch((e) => current && setError(e as ApiError));
    return () => {
      current = false;
    };
  }, [item, router]);

  const loadChecks = useCallback(async () => {
    setChecks(null);
    setChecks(await runSystemCheck(detail?.require_fullscreen ?? true));
  }, [detail?.require_fullscreen]);

  const goFullscreen = async (next: Screen) => {
    setFullscreenError("");
    const problem = await enterFullscreen();
    if (problem) setFullscreenError(problem);
    else setScreen(next);
  };

  const begin = async () => {
    if (!item) return;
    if (detail?.require_fullscreen && !isFullscreen()) {
      setFullscreenError("Full screen was turned off before the assessment started. Enter full screen again.");
      setScreen("fullscreen");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setAttempt(await api.post<AttemptView>(`/assessment-obligations/${item.obligation_id}/attempts`, { instructions_acknowledged: true }));
      setScreen("exam");
    } catch (e) {
      setError(e as ApiError);
      setScreen("gate");
    } finally {
      setBusy(false);
    }
  };

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
  if (screen === "exam" && attempt) return <ExamView initial={attempt} />;
  if (!item) return <Loading label="Opening your workspace…" />;

  if (screen === "check") {
    const passed = systemCheckPassed(checks);
    const failed = checks?.filter((c) => c.essential && c.status !== "pass") ?? [];
    return (
      <Stage step={0}>
        <h1 tabIndex={-1}>System check</h1>
        <p className="lead">Before the timer starts, we confirm that this browser can run the assessment and reach TrainCheck to save your answers.</p>
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
          <Btn onClick={() => void loadChecks()}>
            <Icon name="refresh" /> Retry check
          </Btn>
          <Btn kind="primary" disabled={!passed} onClick={() => setScreen(detail?.require_fullscreen ? "fullscreen" : "instructions")}>
            Continue <Icon name="arrow" />
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
              Your <strong>{item.training_title}</strong> attempt is still in progress. The timer kept running and {clock(attempt.remaining_seconds)} remain. Your saved answers are waiting.
            </>
          ) : (
            "This assessment must be taken in full-screen mode. Select the button below; your browser may ask you to confirm."
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
        <p className="small centered">Leaving full screen during the assessment is recorded as a security violation. {detail?.violation_limit ?? 3} violations submit the assessment automatically.</p>
      </Stage>
    );
  }

  if (screen === "instructions") {
    const limit = detail?.violation_limit ?? 3;
    const facts: [string, string, string | number][] = [
      ["clipboard", "Assessment", item.training_title],
      ["file", "Questions", item.question_count],
      ["clock", "Duration", `${Math.round(item.duration_seconds / 60)} minutes`],
      ["target", "Pass mark", `${item.pass_mark_percent}% or higher`],
      ["refresh", "Attempt", `${item.attempts_used + 1} of ${item.max_attempts}`],
    ];
    const rules: [string, string][] = [
      ["Navigation", "Questions appear one at a time. Use Previous, Next or the question navigator. You can change answers until you submit."],
      ["Mark for review", "Flag any question to revisit later. Marking does not affect your score."],
      ["Saving", "Each answer is saved to the server as soon as you select it. A refresh or lost connection does not lose saved answers."],
      ["Timer", "The timer starts when you select Start assessment. It keeps running if you refresh, close the tab or lose connection. When time runs out, saved answers are submitted automatically."],
      ["Full screen", "Stay in full screen until you submit. Questions are hidden while full screen is off."],
      ["Tabs and windows", "Do not switch tabs, open other windows or move focus away from this window."],
      ["Restricted actions", "Copy, cut, paste, the right-click menu and browser back navigation are disabled during the assessment."],
      ["Violation policy", `Each security event is a violation. Violation 1 shows a warning, violation ${limit - 1} a final warning, and violation ${limit} submits the assessment automatically. Losing your internet connection is not a violation.`],
      ["Automatic submission", "The assessment is submitted automatically when time expires or the violation limit is reached. Unanswered questions receive no marks. Violations do not change your score."],
      ["Monitoring", "Browser-level, best-effort monitoring records only the event type and time. No camera, screen recording or keystroke capture is used."],
    ];
    return (
      <Stage step={2}>
        <h1 tabIndex={-1}>Assessment instructions</h1>
        <p className="lead">Read these rules before you start. The timer begins only when you select Start assessment.</p>
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
              {rules.map(([label, text]) => (
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
            {busy ? "Starting…" : "Start assessment"} <Icon name="arrow" />
          </Btn>
        </div>
      </Stage>
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
              setAck(false);
              setScreen("check");
              void loadChecks();
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

/** Optional pre-test. Records a baseline, is not monitored and never blocks login. */
export function PreTestFlow({ enrolmentId }: { enrolmentId: string }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      setAttempt(await api.post<AttemptView>(`/me/pre-tests/${enrolmentId}/attempts`, { instructions_acknowledged: true }));
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  if (attempt) return <ExamView initial={attempt} />;
  return (
    <FocusShell>
      <section className="gate-panel">
        <span className="eyebrow">PRE-TRAINING BASELINE</span>
        <h1 tabIndex={-1}>Optional pre-test</h1>
        <p>This records what you know before training so your learning gain can be measured. It does not count as your post-training assessment, and you can take it once. The timer starts when you begin.</p>
        {error ? <ErrorPanel error={error} /> : null}
        <Btn kind="wide" disabled={busy} onClick={() => void start()}>
          Begin pre-test <Icon name="arrow" />
        </Btn>
        <Btn kind="text" onClick={() => router.back()}>
          Not now
        </Btn>
      </section>
    </FocusShell>
  );
}
