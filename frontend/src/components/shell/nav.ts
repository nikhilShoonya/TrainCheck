import type { AccessState, RoleCode, User } from "@/lib/types";

/* Role navigation. A convenience only: the backend enforces every permission. */
export type NavItem = [href: string, label: string, icon: string];

export const NAV: Record<RoleCode, NavItem[]> = {
  EMPLOYEE: [
    ["/employee", "Dashboard", "home"],
    ["/employee/trainings", "My Trainings", "book"],
    ["/employee/assessments", "Assessments", "clipboard"],
    ["/employee/refresher", "Refresher Materials", "refresh"],
    ["/employee/scorecard", "Learning Scorecard", "award"],
    ["/employee/behaviour", "Self-Assessment (L3)", "users"],
  ],
  LD_ADMIN: [
    ["/lnd", "Dashboard", "home"],
    ["/lnd/trainings", "Training Management", "book"],
    ["/lnd/organisation", "Departments & Functions", "briefcase"],
    ["/lnd/assignments", "Employee Assignments", "users"],
    ["/lnd/completion", "Training Completion", "check"],
    ["/lnd/questions", "Question Bank", "file"],
    ["/lnd/imports", "Import Centre", "download"],
    ["/lnd/assessment-config", "Assessment Configuration", "settings"],
    ["/lnd/behaviour-templates", "Behaviour Questionnaires", "chat"],
    ["/lnd/scorecards", "Learning Scorecards", "award"],
    ["/lnd/feedback", "Training Feedback", "chat"],
    ["/lnd/reports", "Reports & Analytics", "chart"],
    ["/notifications", "Notifications", "bell"],
  ],
};

/* Level 3 Behaviour task and configuration pages. Hidden while the server reports Behaviour switched off
   (it is outside the approved scope); their history stays reachable by URL and read-only. */
const BEHAVIOUR_PATHS = new Set(["/employee/behaviour", "/lnd/behaviour-templates"]);

/** The navigation for a role, without workflows the server has switched off. */
export function navFor(role: RoleCode, features?: { behaviour: boolean }): NavItem[] {
  return features?.behaviour ? NAV[role] : NAV[role].filter(([href]) => !BEHAVIOUR_PATHS.has(href));
}

export const ROLE_LABEL: Record<RoleCode, string> = {
  EMPLOYEE: "Employee",
  LD_ADMIN: "L&D Admin",
};

export const HOME: Record<RoleCode, string> = {
  EMPLOYEE: "/employee",
  LD_ADMIN: "/lnd",
};

/** Where a signed-in person must go first: a due assessment, then owed feedback, then the countdown of a post-test
    opening within five minutes, then their workspace. The backend makes the same decision for the first two and
    refuses workspace APIs until they are met; the countdown is presentation only and opens nothing early. */
export function landingPath(user: User, access: AccessState | null): string {
  if (access?.access_status === "ASSESSMENT_REQUIRED") return "/access/assessment-required";
  if (access?.access_status === "FEEDBACK_REQUIRED" && access.feedback_due) return `/results/${access.feedback_due.attempt_id}`;
  const countdown = countdownTarget(access);
  if (countdown) return `/assessment/start/${countdown.obligation_id}`;
  return HOME[user.primary_role];
}

/** The scheduled post-test whose countdown should be showing, per the server's latest answer. */
export function countdownTarget(access: AccessState | null) {
  return access?.access_status === "DASHBOARD_ALLOWED" ? (access.countdown ?? null) : null;
}

const PREFIX: [string, RoleCode][] = [
  ["/lnd", "LD_ADMIN"],
  ["/employee", "EMPLOYEE"],
];

/** Whether the workspace is shown. L&D Admins also have employee records, so /employee stays open to them. */
export function canOpen(path: string, roles: RoleCode[]): boolean {
  const match = PREFIX.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return !match || roles.includes(match[1]);
}

export const SIDEBAR_COPY: Record<RoleCode, [string, string[]]> = {
  EMPLOYEE: ["Learn · Apply · Perform", ["Verify your learning", "and apply it at work"]],
  LD_ADMIN: ["Design · Deliver · Evaluate", ["Manage training, assessments", "and behaviour follow-ups"]],
};
