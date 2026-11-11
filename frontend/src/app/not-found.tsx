import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="assessment-main">
      <div className="gate-panel">
        <h1 tabIndex={-1}>This page does not exist</h1>
        <p>Check the address, or return to your workspace.</p>
        <Link className="btn primary wide" href="/">
          Open workspace
        </Link>
      </div>
    </main>
  );
}
