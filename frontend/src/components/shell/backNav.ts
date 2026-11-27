/* The one Back control at the top of workspace pages (27 Nov 2026). Pure functions, so the unit tests load them directly.

   - A detail view with a known parent always returns to that parent, keeping its return state from the address:
     an employee → Back to Employees, a training's completion or question list → Back to Trainings, an employee
     scorecard → Back to Reports, a behaviour review → Back to Self-Assessment.
   - Any other page returns to the previous TrainCheck page this tab showed, named after it ("Back to Reports &
     Analytics"); with none (a direct link, or a new tab), to the Dashboard.
   - The role's Dashboard has no Back control.
   Only TrainCheck workspace pages are ever targets: never another site, never sign-in or an assessment. */

import { trainingsHref } from "@/features/admin/completionView";
import { assignmentsHref } from "@/features/admin/employeeView";
import { questionCardsHref } from "@/features/admin/questionBankView";
import { reportsHref } from "@/features/reports/employeeScorecardView";
import { canOpen, HOME, NAV } from "@/components/shell/nav";
import type { RoleCode } from "@/lib/types";

export interface BackTarget {
  label: string;
  href: string;
}

type Params = { get(name: string): string | null };

const ORIGIN = "https://traincheck.invalid";
const OUTSIDE_WORKSPACE = /^\/(login|access|assessment|results)(\/|$)/;
const ID_SEGMENT = /^[^/]+$/;

/** A same-site workspace address ("/lnd/reports?report=x"), or null for anything else (another site, "//host",
    a backslash trick, sign-in, an assessment). */
export function internalUrl(value: string | null | undefined): URL | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || OUTSIDE_WORKSPACE.test(url.pathname)) return null;
  return url;
}

const segments = (pathname: string) => pathname.split("/").filter(Boolean);

/** The parent of a detail view, with the return state its address carries. Null for other pages. */
export function parentTarget(pathname: string, params: Params): BackTarget | null {
  const s = segments(pathname);
  if (pathname === "/lnd/assignments" && params.get("employee"))
    return { label: "Back to Employees", href: assignmentsHref({ search: params.get("search"), department: params.get("department") ?? "", status: params.get("status") ?? "" }) };
  if (s[0] === "lnd" && s[1] === "completion" && s.length === 3) return { label: "Back to Trainings", href: trainingsHref(params.get("q") ?? "") };
  if (s[0] === "lnd" && s[1] === "questions" && (pathname === "/lnd/questions/unassigned" || s.length === 4)) return { label: "Back to Trainings", href: questionCardsHref(params.get("q") ?? "") };
  if (s[0] === "lnd" && s[1] === "reports" && s[2] === "employees" && s.length === 4) return { label: "Back to Reports", href: reportsHref(params.get("back")) };
  if (s[0] === "employee" && s[1] === "behaviour" && s.length === 3 && ID_SEGMENT.test(s[2])) return { label: "Back to Self-Assessment", href: "/employee/behaviour" };
  return null;
}

/** What a workspace page is called in a Back label, or null when it is not a known TrainCheck page. */
export function pageName(value: string, role: RoleCode): string | null {
  const url = internalUrl(value);
  if (!url) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const s = segments(path);
  if (path === HOME[role]) return "Dashboard";
  if (path === "/employee") return "My Own Training"; // An L&D Admin's own learner workspace (the profile menu's name).
  if (path === "/profile") return "My Profile";
  if (path === "/notifications") return "Notifications";
  if (path === "/lnd/questions/unassigned") return "Unassigned Questions";
  if (s[0] === "lnd" && s[1] === "completion" && s.length === 3) return "Training Completion";
  if (s[0] === "lnd" && s[1] === "questions" && s.length === 4) return "Question Bank";
  if (s[0] === "lnd" && s[1] === "reports" && s[2] === "employees" && s.length === 4) return "Employee Scorecard";
  if (s[0] === "employee" && s[1] === "behaviour" && s.length === 3) return "Self-Assessment";
  for (const items of [NAV[role], ...Object.values(NAV)]) {
    const item = items.find(([href]) => href === path);
    if (item) return item[1];
  }
  return null;
}

/** The Back control for the page at `pathname`, or null on the role's Dashboard. `previous` is the last other
    TrainCheck page this tab showed (see trackPage); it is used only when it is a page this person can open. */
export function backTarget({ pathname, params, previous, role, roles }: { pathname: string; params: Params; previous: string | null; role: RoleCode; roles: RoleCode[] }): BackTarget | null {
  const home = HOME[role];
  if (pathname === home) return null;
  const parent = parentTarget(pathname, params);
  if (parent) return parent;
  const url = internalUrl(previous);
  const name = previous ? pageName(previous, role) : null;
  if (url && name && url.pathname !== pathname && canOpen(url.pathname, roles)) return { label: `Back to ${name}`, href: `${url.pathname}${url.search}` };
  return { label: "Back to Dashboard", href: home };
}

/* ---------- The previous page, per browser tab ---------- */

export interface Trail {
  user: string;
  current: string;
  previous: string | null;
}

/** The trail after showing `url`: a new page makes the one before it `previous`; a change of the same page's
    address (its search or filters) only updates `current`, so its own filters never become "the previous page".
    Another signed-in person starts a fresh trail. */
export function trackPage(trail: Trail | null, user: string, url: string): Trail {
  const next = internalUrl(url);
  if (!next) return trail && trail.user === user ? trail : { user, current: "", previous: null };
  const address = `${next.pathname}${next.search}`;
  if (!trail || trail.user !== user || !trail.current) return { user, current: address, previous: null };
  const before = internalUrl(trail.current);
  if (before && before.pathname === next.pathname) return { ...trail, current: address };
  return { user, current: address, previous: trail.current };
}

export function readTrail(raw: string | null): Trail | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Trail>;
    return typeof value.user === "string" && typeof value.current === "string" ? { user: value.user, current: value.current, previous: typeof value.previous === "string" ? value.previous : null } : null;
  } catch {
    return null;
  }
}
