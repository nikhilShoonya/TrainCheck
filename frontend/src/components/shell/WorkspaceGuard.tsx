"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { canOpen, HOME, landingPath } from "@/components/shell/nav";
import { BtnLink, ErrorPanel, Loading, PageTitle } from "@/components/ui";
import { useSession } from "@/lib/hooks";
import { ROLE_PREFETCH, prefetchPaths } from "@/lib/query";

const SESSION_RECHECK_MS = 30_000;
/** Returning to the tab re-checks at most this often. */
const RETURN_RECHECK_MS = 5_000;
/** Checked a moment after the opening time, so the server already counts the assessment as due. */
const OPENING_MARGIN_MS = 1_000;
/** setTimeout's upper bound (about 24.8 days); a later opening is re-armed by the check at that point. */
const MAX_TIMER_MS = 2_147_000_000;

/** Workspace content waits for the backend's gate decision. This is presentation only:
 *  every API behind it enforces the same gate on the server. */
export function WorkspaceGuard({ children }: { children: ReactNode }) {
  const { user, access, ready, error, refresh } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  // A due assessment or owed feedback closes the workspace until it is done (the server enforces the same).
  const blocked = access?.access_status === "ASSESSMENT_REQUIRED" || access?.access_status === "FEEDBACK_REQUIRED";

  useEffect(() => {
    if (!ready) return;
    if (!user && !error) router.replace("/login");
    else if (user && blocked) router.replace(landingPath(user, access));
  }, [ready, user, access, blocked, error, router]);

  // Cached pages open instantly, so a session that ended elsewhere (signed out, expired, password changed)
  // would otherwise go unnoticed until the next request. Navigation re-checks it at most every 30 seconds.
  const lastCheck = useRef(0);
  useEffect(() => {
    if (!ready || !user) return;
    const now = Date.now();
    if (!lastCheck.current) {
      lastCheck.current = now;
      return;
    }
    if (now - lastCheck.current < SESSION_RECHECK_MS) return;
    lastCheck.current = now;
    void refresh();
  }, [pathname, ready, user, refresh]);

  // A page left open must notice when a scheduled assessment opens, without the person navigating: re-check at the
  // opening moment the server reported, timed against the server's clock. Each check re-arms this with the new answer.
  const nextChange = access?.next_change_at ?? null;
  const serverNow = access?.server_now ?? null;
  useEffect(() => {
    if (!ready || !user || !nextChange) return;
    const reference = serverNow ? Date.parse(serverNow) : Date.now();
    const wait = Math.min(Math.max(0, Date.parse(nextChange) - reference) + OPENING_MARGIN_MS, MAX_TIMER_MS);
    if (Number.isNaN(wait)) return;
    const timer = window.setTimeout(() => {
      lastCheck.current = Date.now();
      void refresh();
    }, wait);
    return () => window.clearTimeout(timer);
  }, [ready, user, nextChange, serverNow, refresh]);

  // Timers are slowed or paused in background tabs and sleeping laptops, so re-check on return to the tab as well.
  useEffect(() => {
    if (!ready || !user) return;
    const onReturn = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck.current < RETURN_RECHECK_MS) return;
      lastCheck.current = Date.now();
      void refresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [ready, user, refresh]);

  // Once the first screen is usable, quietly load the role's likely next pages. It waits until the visible
  // page's own requests have finished, so it never delays them, and runs at most two requests at a time.
  const queryClient = useQueryClient();
  const userId = user?.id;
  const role = user?.primary_role;
  useEffect(() => {
    if (!ready || !userId || !role || blocked) return;
    let cancelled = false;
    let waited = 0;
    const start = () => {
      if (cancelled) return;
      if (queryClient.isFetching() > 0 && waited < 15_000) {
        waited += 300;
        timer = window.setTimeout(start, 300);
        return;
      }
      void prefetchPaths(queryClient, userId, ROLE_PREFETCH[role], () => cancelled);
    };
    let timer = window.setTimeout(start, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ready, userId, role, blocked, queryClient]);

  if (error) {
    // The gate decision is unknown, so the workspace stays closed (TC-GATE-010).
    return (
      <div className="assessment-layout">
        <main id="main" className="assessment-main">
          <ErrorPanel error={error} retry={() => window.location.reload()} />
        </main>
      </div>
    );
  }
  if (!ready || !user || blocked) return <Loading label="Checking your access…" />;
  if (!canOpen(pathname, user.roles)) {
    return (
      <AppShell>
        <PageTitle eyebrow="ACCESS" title="You do not have access to this page" description="Return to your permitted workspace." action={<BtnLink href={HOME[user.primary_role]} kind="primary">Open workspace</BtnLink>} />
      </AppShell>
    );
  }
  return <AppShell>{children}</AppShell>;
}
