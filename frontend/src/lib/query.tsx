"use client";

/* Shared, in-memory API cache (TanStack Query). One client per browser tab, cleared on sign-in, sign-out
   and session loss. Nothing is persisted: no localStorage, and authenticated responses keep the API's
   Cache-Control: no-store. The backend still decides every permission and the assessment gate. */

import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError, api, onApiMutation } from "./api";
import type { RoleCode } from "./types";

/* ---------- Freshness and retry, by kind of data ---------- */

// Gate and exam state must always come from the server; never show a cached copy.
const ALWAYS_FRESH = [/^\/me\/access-state/, /^\/me\/assessment-queue/, /^\/me\/assessment-obligations\//, /^\/attempts\//];
// Reference lists that change rarely and are reused by many forms.
const CATALOGUE = [/^\/admin\/(departments|functions|trainers|competencies|locations|calendar)(\?|$)/, /^\/reports\/(filter-options|catalogue)(\?|$)/];
const REPORTS = [/^\/reports\//, /^\/scorecards/];

const matches = (rules: RegExp[], path: string) => rules.some((rule) => rule.test(path));
export const isCatalogue = (path: string) => matches(CATALOGUE, path);

export function policyFor(path: string): { staleTime: number; gcTime: number; retry: (count: number, error: Error) => boolean } {
  const retry = (count: number, error: Error) => {
    // Permission, validation and not-found answers will not change by asking again.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
    return count < 2; // Network failures and server errors: two quiet retries.
  };
  if (matches(ALWAYS_FRESH, path)) return { staleTime: 0, gcTime: 0, retry: () => false };
  if (isCatalogue(path)) return { staleTime: 5 * 60_000, gcTime: 30 * 60_000, retry };
  if (matches(REPORTS, path)) return { staleTime: 60_000, gcTime: 10 * 60_000, retry };
  return { staleTime: 30_000, gcTime: 10 * 60_000, retry }; // Lists, dashboards and personal pages.
}

/** Every key includes the signed-in account, so one person's data can never answer another's request. */
export const apiKey = (userId: string | null | undefined, path: string) => ["api", userId ?? "anonymous", path] as const;

export function apiQuery<T>(userId: string | null | undefined, path: string) {
  return { queryKey: apiKey(userId, path), queryFn: () => api.get<T>(path), ...policyFor(path) };
}

/* ---------- Provider and invalidation ---------- */

let activeClient: QueryClient | null = null;

/** Clears every cached response. Called on sign-in, sign-out and when the session ends. */
export function clearApiCache() {
  activeClient?.clear();
}

// Writes to reference lists, including sub-resources such as /admin/calendar/holidays/{id}.
const CATALOGUE_WRITES = /^\/admin\/(departments|functions|trainers|competencies|locations|calendar)(\/|\?|$)/;
// Requests that happen many times during a live assessment and change nothing other screens show.
const NO_INVALIDATION = [/^\/attempts\/[^/]+\/questions\//, /^\/attempts\/[^/]+\/security-events/, /^\/auth\//];

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const created = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, refetchOnReconnect: true } } });
    activeClient = created;
    onApiMutation((path) => {
      if (matches(NO_INVALIDATION, path)) return;
      // A change can affect lists, details, dashboard counts and reports. Mark them all stale: what is on
      // screen refreshes in the background, the rest refreshes when next opened. Reference lists are kept
      // unless the change was to one of them.
      const touchesCatalogue = CATALOGUE_WRITES.test(path);
      void created.invalidateQueries({ predicate: (q: Query) => q.queryKey[0] === "api" && (touchesCatalogue || !isCatalogue(String(q.queryKey[2]))) });
    });
    return created;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/* ---------- Selective prefetching ---------- */

/** Small, commonly next datasets per role, fetched after the first screen is ready. Never full reports,
    the whole question bank or every employee record. Paths equal the destination pages' requests. */
export const ROLE_PREFETCH: Record<RoleCode, string[]> = {
  EMPLOYEE: ["/me/trainings"],
  LD_ADMIN: ["/admin/trainings", "/admin/enrolments", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"],
};

/** What each sidebar page loads first, prefetched when the link is hovered or focused. */
export const NAV_PREFETCH: Record<string, string[]> = {
  "/lnd": ["/admin/dashboard"],
  "/lnd/trainings": ["/admin/trainings"],
  "/lnd/organisation": ["/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies", "/admin/calendar"],
  "/lnd/assignments": ["/admin/enrolments"],
  "/lnd/completion": ["/admin/enrolments"],
  "/lnd/questions": ["/admin/trainings"], // The bank itself is not preloaded.
  "/lnd/imports": ["/admin/imports", "/admin/trainings"],
  "/lnd/assessment-config": ["/admin/trainings"],
  "/notifications": ["/me/notifications"],
  "/employee": ["/me/dashboard"],
  "/employee/trainings": ["/me/trainings"],
  "/employee/assessments": ["/me/trainings"],
  "/employee/refresher": ["/me/refresher-materials"],
};

/** Prefetches a few paths, at most two at a time. Fresh cached data is not fetched again. */
export async function prefetchPaths(client: QueryClient, userId: string, paths: string[], isCancelled: () => boolean = () => false) {
  const queue = [...new Set(paths)];
  const worker = async () => {
    while (queue.length && !isCancelled()) {
      const path = queue.shift()!;
      await client.prefetchQuery(apiQuery(userId, path)).catch(() => {});
    }
  };
  await Promise.all([worker(), worker()]);
}
