"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, reloadAt } from "./api";
import { apiQuery, clearApiCache } from "./query";
import type { AccessState, User } from "./types";

/** Data, error and loading state for one GET, from the shared cache.

    Cached data is shown at once and refreshed in the background when stale; simultaneous requests for
    the same data are made once. `loading` is true whenever a request is running; `refreshing` only when
    earlier data is already on screen. The cache key includes the signed-in account. */
export function useApi<T>(path: string | null) {
  const { user } = useSession();
  const query = useQuery({ ...apiQuery<T>(user?.id, path ?? ""), enabled: Boolean(path) });
  const { refetch } = query;
  const reload = useCallback(async () => {
    await refetch({ cancelRefetch: false }); // Joins a request already in flight instead of starting another.
  }, [refetch]);
  return {
    data: (query.data ?? null) as T | null,
    error: (query.error as ApiError | null) ?? null,
    loading: Boolean(path) && (query.isPending || query.isFetching),
    refreshing: query.isFetching && query.data !== undefined,
    reload,
  };
}

interface SessionValue {
  user: User | null;
  access: AccessState | null;
  ready: boolean;
  error: ApiError | null;
  refresh: () => Promise<void>;
  /** Starts the workspace from a successful sign-in response, without asking the server again. */
  adopt: (user: User, access: AccessState) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const SESSION_RETRY_DELAYS_MS = [700, 2000];

/** Loads identity and the gate decision. Nothing protected renders until both are known. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<AccessState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const generation = useRef(0); // A sign-in during an older check wins over that check's result.

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    // A signed-in browser has the readable CSRF cookie, so identity and gate state load together.
    const signedIn = typeof document !== "undefined" && document.cookie.includes("tc_csrf=");
    if (!signedIn) {
      // Both session cookies are set and removed together, so without the readable one there is no session:
      // asking the server would only produce a 401 (and a console error) on every visit to the sign-in page.
      clearApiCache();
      setUser(null);
      setAccess(null);
      setError(null);
      setReady(true);
      return;
    }
    const load = async () => {
      const [me, state] = signedIn
        ? await Promise.all([api.get<{ user: User }>("/auth/me"), api.get<AccessState>("/me/access-state")])
        : [await api.get<{ user: User }>("/auth/me"), null];
      return { me, gate: state ?? (await api.get<AccessState>("/me/access-state")) };
    };
    try {
      // A momentary database or network hiccup (5xx, no answer) is retried quietly, as page data is,
      // instead of replacing the whole workspace with an error. Answers like UNAUTHENTICATED are final.
      let loaded: Awaited<ReturnType<typeof load>> | undefined;
      for (let attempt = 0; loaded === undefined; attempt++) {
        try {
          loaded = await load();
        } catch (e) {
          const transient = e instanceof ApiError && (e.status === 0 || e.status >= 500);
          if (!transient || attempt >= SESSION_RETRY_DELAYS_MS.length || mine !== generation.current) throw e;
          await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_DELAYS_MS[attempt]));
        }
      }
      const { me, gate } = loaded;
      if (mine !== generation.current) return;
      setUser((previous) => {
        if (previous?.id !== me.user.id) clearApiCache(); // Another account: nothing cached may carry over.
        return me.user;
      });
      setAccess(gate);
      setError(null);
    } catch (e) {
      if (mine !== generation.current) return;
      const failure = e as ApiError;
      if (failure.code === "UNAUTHENTICATED") {
        clearApiCache();
        setUser(null);
        setAccess(null);
      } else {
        setError(failure);
      }
    } finally {
      if (mine === generation.current) setReady(true);
    }
  }, []);

  const adopt = useCallback((next: User, state: AccessState) => {
    generation.current += 1;
    clearApiCache();
    setUser(next);
    setAccess(state);
    setError(null);
    setReady(true);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      clearApiCache();
      reloadAt("/login"); // A full load, so nothing from the signed-in session stays in memory.
    }
  }, []);

  useEffect(() => {
    // Fetching on mount is the purpose of this provider.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return <SessionContext.Provider value={{ user, access, ready, error, refresh, adopt, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
