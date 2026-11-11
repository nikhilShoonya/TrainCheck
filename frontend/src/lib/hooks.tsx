"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import type { AccessState, User } from "./types";

/** Loading, data and error for one GET. Every screen shows all three honestly. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const result = await api.get<T>(path);
      if (ticket === latest.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (ticket === latest.current) setError(e as ApiError);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    // Fetching on mount is the purpose of this hook.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

interface SessionValue {
  user: User | null;
  access: AccessState | null;
  ready: boolean;
  error: ApiError | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Loads identity and the gate decision. Nothing protected renders until both are known. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<AccessState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ user: User }>("/auth/me");
      const state = await api.get<AccessState>("/me/access-state");
      setUser(me.user);
      setAccess(state);
      setError(null);
    } catch (e) {
      const failure = e as ApiError;
      if (failure.code === "UNAUTHENTICATED") {
        setUser(null);
        setAccess(null);
      } else {
        setError(failure);
      }
    } finally {
      setReady(true);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      window.location.assign("/login");
    }
  }, []);

  useEffect(() => {
    // Fetching on mount is the purpose of this provider.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return <SessionContext.Provider value={{ user, access, ready, error, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
