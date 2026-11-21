"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { AppShell } from "@/components/shell/AppShell";
import { canOpen, countdownTarget, HOME, landingPath } from "@/components/shell/nav";
import { Btn, BtnLink, ErrorPanel, Loading, PageTitle } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { useSession } from "@/lib/hooks";
import { ROLE_PREFETCH, prefetchPaths } from "@/lib/query";
import { useUnsavedInput } from "@/lib/unsavedInput";
import { dateTimeIn } from "@/lib/utils";

const SESSION_RECHECK_MS = 30_000;
/** Returning to the tab re-checks at most this often. */
const RETURN_RECHECK_MS = 5_000;
/** A page left open re-checks this often, so an assessment assigned or rescheduled meanwhile is noticed. */
const IDLE_RECHECK_MS = 60_000;
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
  // A post-test opening within five minutes opens its countdown, unless that would discard what is being typed here:
  // then the person is asked first. The server keeps the workspace open until the opening moment.
  const countdown = countdownTarget(access);
  const unsaved = useUnsavedInput(pathname);
  const [stayedFor, setStayedFor] = useState<string | null>(null);
  const toCountdown = Boolean(user && countdown && !unsaved);

  useEffect(() => {
    if (!ready) return;
    if (!user && !error) router.replace("/login");
    else if (user && (blocked || toCountdown)) router.replace(landingPath(user, access));
  }, [ready, user, access, blocked, toCountdown, error, router]);

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

  // The same for the moment a countdown begins (five minutes before an opening). The redirect follows only from the
  // server's new answer, never from this timer alone, so a cancelled or moved assessment opens no countdown.
  const countdownStarts = access?.countdown_starts_at ?? null;
  useEffect(() => {
    if (!ready || !user || !countdownStarts) return;
    const reference = serverNow ? Date.parse(serverNow) : Date.now();
    const wait = Math.min(Math.max(0, Date.parse(countdownStarts) - reference) + OPENING_MARGIN_MS, MAX_TIMER_MS);
    if (Number.isNaN(wait)) return;
    const timer = window.setTimeout(() => {
      lastCheck.current = Date.now();
      void refresh();
    }, wait);
    return () => window.clearTimeout(timer);
  }, [ready, user, countdownStarts, serverNow, refresh]);

  // An assessment assigned, scheduled or moved by L&D while this page is open changes no timer here, so a visible,
  // connected page asks again every minute.
  useEffect(() => {
    if (!ready || !user) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || !navigator.onLine || Date.now() - lastCheck.current < IDLE_RECHECK_MS / 2) return;
      lastCheck.current = Date.now();
      void refresh();
    }, IDLE_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [ready, user, refresh]);

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
  if (toCountdown) return <Loading label="Opening your assessment countdown…" />;
  if (!canOpen(pathname, user.roles)) {
    return (
      <AppShell>
        <PageTitle eyebrow="ACCESS" title="You do not have access to this page" description="Return to your permitted workspace." action={<BtnLink href={HOME[user.primary_role]} kind="primary">Open workspace</BtnLink>} />
      </AppShell>
    );
  }
  return (
    <AppShell>
      {children}
      {countdown && unsaved && stayedFor !== countdown.obligation_id ? (
        <Modal title="Your assessment opens soon" onClose={() => setStayedFor(countdown.obligation_id)}>
          <p>
            <strong>{countdown.training_title}</strong> opens at {dateTimeIn(countdown.due_at, countdown.timezone)}. You have changes on this page that may not be saved yet.
          </p>
          <p>Save what you need first, then go to the countdown to prepare. At the opening time the assessment is required and the workspace closes until it is done.</p>
          <div className="dialog-actions">
            <Btn onClick={() => setStayedFor(countdown.obligation_id)}>Stay to save my changes</Btn>
            <Btn kind="primary" onClick={() => router.replace(landingPath(user, access))}>
              Go to the countdown <Icon name="arrow" />
            </Btn>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}
