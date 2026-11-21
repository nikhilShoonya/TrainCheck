"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** "off": not requested. "pending": asking. "held": this tab has it. "elsewhere": another tab or window has it. */
export type TabLockState = "off" | "pending" | "held" | "elsewhere";

/** One tab at a time, per name, across every tab and window of this browser profile (Web Locks API).
    Used so only one tab prepares and automatically starts a scheduled assessment. The server is still what prevents
    a second attempt: a repeated start returns the attempt already running. Without the API (very old browsers) each
    tab acts alone and that server rule is the only guard. A lock taken over by another tab is waited for again. */
export function useTabLock(name: string | null): { state: TabLockState; takeOver: () => void } {
  const [state, setState] = useState<TabLockState>("off");
  const takeOverRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!name) return;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    let alive = true;
    if (!locks) {
      // Setting the lock state once the page knows the API is missing is the purpose of this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState("held");
      return () => {
        alive = false;
        setState("off");
      };
    }
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const abort = new AbortController();
    const hold = async (lock: Lock | null) => {
      if (!lock) return false;
      if (alive) setState("held");
      await released; // Kept until this page closes or stops needing it.
      return true;
    };
    const waitForIt = () => {
      void locks.request(name, { signal: abort.signal }, hold).catch(() => {
        // Taken over by another tab: wait for it again, unless this page is closing.
        if (alive && !abort.signal.aborted) {
          setState("elsewhere");
          waitForIt();
        }
      });
    };
    setState("pending");
    void locks
      .request(name, { ifAvailable: true }, hold)
      .then((got) => {
        if (got === false && alive) {
          setState("elsewhere");
          waitForIt();
        }
      })
      .catch(() => {
        if (alive && !abort.signal.aborted) {
          setState("elsewhere");
          waitForIt();
        }
      });
    takeOverRef.current = () => {
      void locks.request(name, { steal: true }, hold).catch(() => {
        if (alive && !abort.signal.aborted) {
          setState("elsewhere");
          waitForIt();
        }
      });
    };
    return () => {
      alive = false;
      takeOverRef.current = null;
      abort.abort();
      release();
      setState("off");
    };
  }, [name]);

  const takeOver = useCallback(() => takeOverRef.current?.(), []);
  return { state, takeOver };
}
