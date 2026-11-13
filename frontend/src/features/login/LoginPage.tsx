"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { Art } from "@/components/shell/Art";
import { FormError } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import type { AccessState, RoleCode, User } from "@/lib/types";
import { HOME } from "@/components/shell/nav";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? "";
const ROLES: [RoleCode, string, string, string][] = [
  ["EMPLOYEE", "Employee", "person", "employee@traincheck.demo"],
  ["LD_ADMIN", "L&D Admin", "settings", "admin@traincheck.demo"],
];
const REMEMBER_KEY = "tc-remember-email";
const RESET_POLL_MS = 3000;

interface ResetJob {
  state: "IDLE" | "RUNNING" | "DONE" | "FAILED";
  elapsed_seconds: number | null;
  error: string | null;
}
interface DemoStatus {
  reset_enabled: boolean;
  reset: ResetJob | null;
}

const minutes = (seconds: number | null) => {
  const s = Math.max(0, seconds ?? 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function rememberedEmail(): string {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function LoginPage() {
  // The first render must match the server's HTML, which cannot see browser storage.
  // The remembered email is applied after mount, so the server and browser agree (no hydration mismatch).
  const [email, setEmail] = useState(DEMO_MODE ? ROLES[0][3] : "");
  useEffect(() => {
    const saved = rememberedEmail();
    // Reading browser storage after mount is the purpose of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setEmail(saved);
  }, []);
  const [password, setPassword] = useState(DEMO_MODE ? DEMO_PASSWORD : "");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"recovery" | "reset" | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [notice, setNotice] = useState("");
  // The backend decides whether reset is allowed here (DEMO_RESET_ENABLED); the button only appears when it is.
  const [resetAvailable, setResetAvailable] = useState(false);
  // A reset runs in the background on the server (it takes minutes); this page follows its progress.
  const [resetJob, setResetJob] = useState<ResetJob | null>(null);
  const resetRunning = resetJob?.state === "RUNNING";
  useEffect(() => {
    if (!DEMO_MODE) return;
    api
      .get<DemoStatus>("/demo/status")
      .then((status) => {
        setResetAvailable(status.reset_enabled);
        if (status.reset?.state === "RUNNING") setResetJob(status.reset); // Started earlier, e.g. before a reload.
      })
      .catch(() => setResetAvailable(false));
  }, []);
  useEffect(() => {
    if (!resetRunning) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      api
        .get<DemoStatus>("/demo/status")
        .then((status) => {
          if (stopped || !status.reset) return;
          setResetJob(status.reset);
          if (status.reset.state === "DONE") {
            setError("");
            setEmail(ROLES[0][3]);
            setPassword(DEMO_PASSWORD);
            setNotice(`Demo data has been reset (took ${minutes(status.reset.elapsed_seconds)}). Every account, training and result is back to its starting state. You can sign in now.`);
          } else if (status.reset.state === "FAILED") {
            setNotice("");
            setError(status.reset.error ?? "The reset failed, so the previous data was kept. Please try again.");
          }
        })
        .catch(() => {
          /* A missed poll is retried on the next tick. */
        });
    }, RESET_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [resetRunning]);
  const selected = ROLES.find((r) => r[3] === email)?.[0];
  const router = useRouter();
  const { adopt } = useSession();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ user: User; access_state: AccessState }>("/auth/login", { email: email.trim(), password });
      try {
        if (remember) localStorage.setItem(REMEMBER_KEY, email.trim().toLowerCase());
        else localStorage.removeItem(REMEMBER_KEY);
      } catch {
        /* Signing in still works without this preference. */
      }
      // The sign-in response already holds identity and the gate decision, so the workspace starts from it
      // (no second /auth/me and /me/access-state round). Nothing protected can show before this point.
      const blocked = result.access_state.access_status === "ASSESSMENT_REQUIRED";
      adopt(result.user, result.access_state);
      router.replace(blocked ? "/access/assessment-required" : HOME[result.user.primary_role]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign-in failed. Please try again.");
      setBusy(false);
    }
  };

  const resetDemoData = async () => {
    setResetting(true);
    setResetError("");
    try {
      const started = await api.post<{ started: boolean; reset: ResetJob }>("/demo/reset", { confirm: "RESET" });
      setDialog(null);
      setError("");
      setNotice("");
      setResetJob(started.reset);
    } catch (e) {
      setResetError(e instanceof ApiError ? e.message : "The demo data could not be reset. Please try again.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <main id="main" className="impact-login green-impact-login">
      <Art file="green-login" box="0 650 845 291" className="login-office-scene" />
      <Art file="green-login" box="1360 0 312 135" className="login-canopy" />
      <svg className="green-login-wave" viewBox="0 0 620 310" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 310C160 170 285 300 413 206C515 134 524 62 620 0V310Z" fill="#076346" />
        <path d="M25 310C190 175 285 313 420 218C530 140 536 70 620 18V310Z" fill="#073f3c" stroke="#419447" strokeWidth="2" />
      </svg>
      <section className="impact-login-story">
        <header className="login-brand-head">
          <span className="login-traincheck-logo">
            <Art file="green-login" box="90 52 285 70" />
            <span className="sr-only">TrainCheck · Finvasia L&D Evaluation</span>
          </span>
          <i />
          <span className="login-finvasia-logo">
            <Art file="green-login" box="462 52 196 52" />
            <span className="sr-only">Finvasia</span>
          </span>
        </header>
        <div className="login-positioning">
          <div className="eyebrow">TRAIN · ASSESS · APPLY · VERIFY</div>
          <h1>
            Measure Learning.
            <br />
            Verify <span>Real Application.</span>
          </h1>
          <p>An integrated training evaluation platform that confirms employees learn after training and apply that learning in their actual work.</p>
        </div>
        <div className="login-levels two-level">
          {[
            ["cap", "Learning", "Did the employee acquire the required knowledge?"],
            ["users", "Behaviour", "Is the employee applying it in daily work?"],
          ].map(([icon, label, description]) => (
            <div key={label}>
              <span>
                <Icon name={icon} />
              </span>
              <section>
                <h2>{label}</h2>
                <p>{description}</p>
              </section>
            </div>
          ))}
        </div>
      </section>
      <section className="impact-login-card" aria-labelledby="welcome-title">
        <h2 id="welcome-title">Welcome to TrainCheck</h2>
        <p className="login-subtitle">Sign in to your learning & evaluation workspace</p>
        {DEMO_MODE ? (
          <div className="demo-roles">
            {ROLES.map(([id, label, icon, demoEmail]) => (
              <button
                type="button"
                key={id}
                className={`role-choice${selected === id ? " selected" : ""}`}
                aria-pressed={selected === id}
                onClick={() => {
                  setEmail(demoEmail);
                  setPassword(DEMO_PASSWORD);
                }}
              >
                <Icon name={icon} />
                <strong>{label}</strong>
              </button>
            ))}
          </div>
        ) : null}
        <form id="login-form" onSubmit={submit}>
          <label className="login-input-field">
            Email address
            <span>
              <Icon name="mail" />
              <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
            </span>
          </label>
          <label className="login-input-field">
            Password
            <span>
              <Icon name="lock" />
              <input name="password" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
              <button type="button" className="password-toggle" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} onClick={() => setShow((s) => !s)}>
                <Icon name={show ? "eyeOff" : "eye"} />
              </button>
            </span>
          </label>
          <div className="login-options">
            <label>
              <input name="remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my email
            </label>
            <button type="button" onClick={() => setDialog("recovery")}>
              Forgot password?
            </button>
          </div>
          {resetRunning ? (
            <p className="login-reset-notice running" role="status">
              <Icon name="refresh" />
              <span>
                <strong>Resetting demo data… {minutes(resetJob?.elapsed_seconds ?? 0)}</strong> This usually takes a few minutes. Sign-in opens again as soon as it finishes; this page updates by itself.
              </span>
            </p>
          ) : notice ? (
            <p className="login-reset-notice" role="status">
              {notice}
            </p>
          ) : null}
          <FormError message={error} />
          <button className="btn primary wide login-sign-in" type="submit" disabled={busy || resetRunning}>
            {busy ? "Signing in…" : "Sign In"} <Icon name="arrow" />
          </button>
        </form>
        {DEMO_MODE && resetAvailable ? (
          <button
            type="button"
            className="btn secondary wide login-reset-demo"
            disabled={resetRunning}
            onClick={() => {
              setResetError("");
              setDialog("reset");
            }}
          >
            <Icon name="refresh" /> {resetRunning ? "Reset in progress…" : "Reset demo data"}
          </button>
        ) : null}
      </section>
      {dialog === "recovery" ? (
        <Modal title="Forgot your password?" onClose={() => setDialog(null)}>
          <p>Ask your TrainCheck system administrator for a one-time password, then change it in My profile. Self-service recovery by email will be added once Finvasia approves an email provider.</p>
        </Modal>
      ) : null}
      {dialog === "reset" ? (
        <Modal title="Reset demo data?" onClose={() => !resetting && setDialog(null)}>
          <p>This erases everything done in this demo, for every employee and admin account: assessment attempts, results, enrolments, trainings, questions, imports and changed passwords. The original demo data is then loaded again, as on a fresh install.</p>
          <p>It takes a few minutes. Anyone signed in is signed out when it finishes. This cannot be undone.</p>
          <FormError message={resetError} />
          <div className="dialog-actions">
            <button type="button" className="btn secondary" onClick={() => setDialog(null)} disabled={resetting}>
              Cancel
            </button>
            <button type="button" className="btn danger-btn" onClick={() => void resetDemoData()} disabled={resetting}>
              {resetting ? "Starting…" : "Reset demo data"}
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
