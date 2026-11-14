import type { AccessState, RoleCode, User } from "@/lib/types";

/* Role navigation. A convenience only: the backend enforces every permission. */
export type NavItem = [href: string, label: string, icon: string];

export const NAV: Record<RoleCode, NavItem[]> = {
  EMPLOYEE: [
    ["/employee", "Dashboard", "home"],
    ["/employee/trainings", "My Trainings", "book"],
    ["/employee/assessments", "Assessments", "clipboard"],
    ["/employee/refresher", "Refresher Materials", "refresh"],
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
    ["/lnd/scorecards", "Learning & Behaviour Scorecards", "award"],
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

/** Where a signed-in person must go first: a due assessment, then owed feedback, then their workspace.
    The backend makes the same decision and refuses workspace APIs until it is met. */
export function landingPath(user: User, access: AccessState | null): string {
  if (access?.access_status === "ASSESSMENT_REQUIRED") return "/access/assessment-required";
  if (access?.access_status === "FEEDBACK_REQUIRED" && access.feedback_due) return `/results/${access.feedback_due.attempt_id}`;
  return HOME[user.primary_role];
}

const PREFIX: [string, RoleCode][] = [
  ["/lnd", "LD_ADMIN"],
  ["/employee", "EMPLOYEE"],
];

/* Pages withdrawn from the L&D Admin interface. Their routes stay in the codebase but no role opens them,
   and the backend refuses the matching APIs (batch/session creation, the audit log reader). */
const WITHDRAWN_PATHS = ["/lnd/batches", "/lnd/audit"];

/** Whether the workspace is shown. L&D Admins also have employee records, so /employee stays open to them. */
export function canOpen(path: string, roles: RoleCode[]): boolean {
  if (WITHDRAWN_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  const match = PREFIX.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return !match || roles.includes(match[1]);
}

export const SIDEBAR_COPY: Record<RoleCode, [string, string[]]> = {
  EMPLOYEE: ["Learn · Apply · Perform", ["Verify your learning", "and apply it at work"]],
  LD_ADMIN: ["Design · Deliver · Evaluate", ["Manage training, assessments", "and behaviour follow-ups"]],
};

/** Hindi in Latin script, as it is commonly typed. Same keys as HINDI. */
export const HINGLISH: Record<string, string> = {
  Dashboard: "Dashboard",
  "My Trainings": "Meri Trainings",
  Assessments: "Aakalan",
  "Refresher Materials": "Refresher Saamagri",
  "Self-Assessment (L3)": "Swa-Mulyankan (L3)",
  "Behaviour Questionnaires": "Vyavhaar Prashnavali",
  "Training Management": "Training Prabandhan",
  "Departments & Functions": "Vibhaag aur Kaarya",
  "Batches & Sessions": "Batch aur Session",
  "Employee Assignments": "Karmachari Aavantan",
  "Training Completion": "Training Poornata",
  "Question Bank": "Prashn Bank",
  "Import Centre": "Import Kendra",
  "Assessment Configuration": "Aakalan Setting",
  "Learning & Behaviour Scorecards": "Seekhne aur Vyavhaar ke Scorecard",
  "Reports & Analytics": "Report aur Vishleshan",
  "Training Feedback": "Training Pratikriya",
  Notifications: "Soochnaayein",
  "Audit Logs": "Badlaav ka Itihaas",
  "Search trainings, reports, or help…": "Training, report ya madad khojein…",
  "Collapse sidebar": "Sidebar chhota karein",
  "Expand sidebar": "Sidebar bada karein",
};

export const HINDI: Record<string, string> = {
  "Search trainings, reports, or help…": "प्रशिक्षण, रिपोर्ट या सहायता खोजें…",
  "Collapse sidebar": "साइडबार छोटा करें",
  "Expand sidebar": "साइडबार बड़ा करें",
  Dashboard: "डैशबोर्ड",
  "My Trainings": "मेरे प्रशिक्षण",
  Assessments: "आकलन",
  "Refresher Materials": "पुनश्चर्या सामग्री",
  "Self-Assessment (L3)": "स्व-मूल्यांकन (L3)",
  "Behaviour Questionnaires": "व्यवहार प्रश्नावली",
  "Training Management": "प्रशिक्षण प्रबंधन",
  "Departments & Functions": "विभाग और कार्य",
  "Batches & Sessions": "बैच और सत्र",
  "Employee Assignments": "कर्मचारी आवंटन",
  "Training Completion": "प्रशिक्षण पूर्णता",
  "Question Bank": "प्रश्न बैंक",
  "Import Centre": "आयात केंद्र",
  "Assessment Configuration": "आकलन सेटिंग",
  "Learning & Behaviour Scorecards": "सीखने और व्यवहार के स्कोरकार्ड",
  "Reports & Analytics": "रिपोर्ट और विश्लेषण",
  "Training Feedback": "प्रशिक्षण प्रतिक्रिया",
  Notifications: "सूचनाएं",
  "Audit Logs": "बदलाव का इतिहास",
};
