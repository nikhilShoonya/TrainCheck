"use client";

/* The one Back control at the top of workspace pages: a labelled link ("Back to Employees"), styled like the page's
   other secondary buttons. Where it leads is decided in backNav.ts. A page whose detail view changes within the same
   address can hand over its own way back (useBackHandler), for example to return to the list exactly as it was left;
   the link's address stays the fallback, so keyboard, middle-click and a page that has not registered still work. */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { backTarget, readTrail, trackPage, type Trail } from "@/components/shell/backNav";
import type { RoleCode } from "@/lib/types";

const TRAIL_KEY = "traincheck.back-trail";

type Handler = (() => void) | null;
const BackHandler = createContext<MutableRefObject<Handler> | null>(null);

export function BackHandlerProvider({ children }: { children: ReactNode }) {
  const handler = useRef<Handler>(null);
  return <BackHandler.Provider value={handler}>{children}</BackHandler.Provider>;
}

/** While `handler` is set, the Back control runs it instead of following its link. */
export function useBackHandler(handler: Handler) {
  const ref = useContext(BackHandler);
  useEffect(() => {
    if (!ref) return;
    ref.current = handler;
    return () => {
      if (ref.current === handler) ref.current = null;
    };
  }, [ref, handler]);
}

function storedTrail(): Trail | null {
  try {
    return readTrail(window.sessionStorage.getItem(TRAIL_KEY));
  } catch {
    return null; // Storage switched off: Back then leads to the Dashboard, the safe parent.
  }
}

export function PageBack({ userId, role, roles }: { userId: string; role: RoleCode; roles: RoleCode[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const handler = useContext(BackHandler);
  const query = params.toString();
  const address = `${pathname}${query ? `?${query}` : ""}`;
  // Worked out while rendering (the workspace renders in the browser only), so the label is right on first paint.
  const trail = useMemo(() => trackPage(storedTrail(), userId, address), [userId, address]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail));
    } catch {
      /* Storage switched off: nothing to remember. */
    }
  }, [trail]);

  const target = backTarget({ pathname, params, previous: trail.previous, role, roles });
  if (!target) return null;
  return (
    <Link
      href={target.href}
      className="btn secondary page-return"
      onClick={(event) => {
        const own = handler?.current;
        if (!own || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        own();
      }}
    >
      <Icon name="back" /> {target.label}
    </Link>
  );
}
