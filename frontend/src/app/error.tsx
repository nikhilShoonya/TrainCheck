"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main" className="assessment-main">
      <div className="gate-panel" role="alert">
        <h1 tabIndex={-1}>Something went wrong</h1>
        <p>Your saved work is safe. Try again, and contact support if this continues.</p>
        <button className="btn primary wide" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
