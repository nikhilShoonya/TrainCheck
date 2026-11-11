"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { Art } from "@/components/shell/Art";
import { FormError } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import type { AccessState, RoleCode, User } from "@/lib/types";
import { HOME } from "@/components/shell/nav";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? "";
const ROLES: [RoleCode, string, string, string][] = [
  ["EMPLOYEE", "Employee", "person", "employee@traincheck.demo"],
  ["MANAGER", "Manager", "users", "manager@traincheck.demo"],
  ["LD_ADMIN", "L&D Admin", "settings", "admin@traincheck.demo"],
  ["HR_READ_ONLY", "HR / Leadership", "chart", "hr@traincheck.demo"],
];
const REMEMBER_KEY = "tc-remember-email";

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
  const [dialog, setDialog] = useState<"recovery" | "Google" | "Microsoft" | null>(null);
  const selected = ROLES.find((r) => r[3] === email)?.[0];

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
      // A full navigation, so the session loads cleanly and nothing protected flashes first.
      const blocked = result.access_state.access_status === "ASSESSMENT_REQUIRED";
      window.location.assign(blocked ? "/access/assessment-required" : HOME[result.user.primary_role]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign-in failed. Please try again.");
      setBusy(false);
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
          <FormError message={error} />
          <button className="btn primary wide login-sign-in" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign In"} <Icon name="arrow" />
          </button>
        </form>
        <div className="login-divider">
          <span>Or continue with</span>
        </div>
        <div className="login-sso">
          <button type="button" aria-describedby="sso-description" onClick={() => setDialog("Google")}>
            <span className="google-g">G</span>Continue with Google
          </button>
          <button type="button" aria-describedby="sso-description" onClick={() => setDialog("Microsoft")}>
            <span className="microsoft-mark">
              <i />
              <i />
              <i />
              <i />
            </span>
            Continue with Microsoft
          </button>
        </div>
        <p id="sso-description" className="sr-only">
          Single sign-on is not connected yet. These buttons explain what is needed.
        </p>
        {DEMO_MODE ? (
          <>
            <div className="login-demo-disclosure">
              <Icon name="shield" />
              <div>
                <strong>Demo Workspace</strong>
                <p>This environment uses fictional data. Single sign-on is not connected.</p>
              </div>
            </div>
            <details className="login-demo-help">
              <summary>Demo accounts & help</summary>
              <p>
                Use <strong>clear@traincheck.demo</strong> to view an employee dashboard without due work. <strong>employee@traincheck.demo</strong> opens the mandatory assessment first. <strong>manager2@traincheck.demo</strong> is a second manager.
              </p>
            </details>
          </>
        ) : null}
      </section>
      {dialog === "recovery" ? (
        <Modal title="Forgot your password?" onClose={() => setDialog(null)}>
          <p>Ask your TrainCheck system administrator for a one-time password, then change it in My profile. Self-service recovery by email will be added once Finvasia approves an email provider.</p>
        </Modal>
      ) : null}
      {dialog === "Google" || dialog === "Microsoft" ? (
        <Modal title={`${dialog} sign-in is not connected`} onClose={() => setDialog(null)}>
          <p>{dialog} sign-in needs an approved identity provider and identity mapping from Finvasia IT. Please use your email and password for now.</p>
        </Modal>
      ) : null}
    </main>
  );
}
