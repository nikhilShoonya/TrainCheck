"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { canOpen, HOME } from "@/components/shell/nav";
import { BtnLink, ErrorPanel, Loading, PageTitle } from "@/components/ui";
import { useSession } from "@/lib/hooks";

/** Workspace content waits for the backend's gate decision. This is presentation only:
 *  every API behind it enforces the same gate on the server. */
export function WorkspaceGuard({ children }: { children: ReactNode }) {
  const { user, access, ready, error } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const blocked = access?.access_status === "ASSESSMENT_REQUIRED";

  useEffect(() => {
    if (!ready) return;
    if (!user && !error) router.replace("/login");
    else if (blocked) router.replace("/access/assessment-required");
  }, [ready, user, blocked, error, router]);

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
