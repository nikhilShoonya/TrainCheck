import type { RoleCode } from "@/lib/types";

/* Role navigation. A convenience only: the backend enforces every permission. */
export type NavItem = [href: string, label: string, icon: string];

export const NAV: Record<RoleCode, NavItem[]> = {
  EMPLOYEE: [
    ["/employee", "Dashboard", "home"],
    ["/employee/trainings", "My Trainings", "book"],
    ["/employee/assessments", "Assessments", "clipboard"],
    ["/employee/history", "Assessment History", "file"],
    ["/employee/refresher", "Refresher Materials", "refresh"],
    ["/employee/behaviour", "Self-Assessment (L3)", "users"],
    ["/employee/behaviour-history", "Behaviour History", "clock"],
    ["/employee/certificates", "Certificates", "shield"],
  ],
  MANAGER: [
    ["/manager", "Dashboard", "home"],
    ["/manager/team", "My Team", "users"],
    ["/manager/team-trainings", "Team Training Status", "clipboard"],
    ["/manager/assessments", "Assessment Performance", "file"],
    ["/manager/reviews", "Pending Behaviour Reviews", "clock"],
    ["/manager/questionnaires", "Behaviour Questionnaires", "chat"],
    ["/manager/scorecards", "Team Scorecards", "award"],
    ["/manager/reports", "Team Reports", "chart"],
    ["/manager/certificates", "Certificates", "shield"],
  ],
  LD_ADMIN: [
    ["/lnd", "Dashboard", "home"],
    ["/lnd/trainings", "Training Management", "book"],
    ["/lnd/organisation", "Departments & Functions", "briefcase"],
    ["/lnd/batches", "Batches & Sessions", "calendar"],
    ["/lnd/assignments", "Employee Assignments", "users"],
    ["/lnd/completion", "Training Completion", "check"],
    ["/lnd/questions", "Question Bank", "file"],
    ["/lnd/imports", "Import Centre", "download"],
    ["/lnd/assessment-config", "Assessment Configuration", "settings"],
    ["/lnd/behaviour-templates", "Behaviour Questionnaires", "chat"],
    ["/lnd/scorecards", "Learning & Behaviour Scorecards", "award"],
    ["/lnd/reports", "Reports & Analytics", "chart"],
    ["/notifications", "Notifications", "bell"],
    ["/lnd/audit", "Audit Logs", "shield"],
  ],
  HR_READ_ONLY: [
    ["/hr", "Organisation Overview", "home"],
    ["/hr/learning", "Learning Performance", "cap"],
    ["/hr/departments", "Department Performance", "briefcase"],
    ["/hr/pass-fail", "Assessment Pass/Fail", "target"],
    ["/hr/learning-gain", "Learning Gain", "chart"],
    ["/hr/behaviour", "Behaviour Improvement", "users"],
    ["/hr/managers", "Manager Evaluation", "clipboard"],
    ["/hr/scorecards", "Effectiveness Scorecards", "award"],
    ["/hr/reports", "Reports & Exports", "file"],
  ],
};

export const ROLE_LABEL: Record<RoleCode, string> = {
  EMPLOYEE: "Employee",
  MANAGER: "Manager",
  LD_ADMIN: "L&D Admin",
  HR_READ_ONLY: "HR / Leadership",
};

export const HOME: Record<RoleCode, string> = {
  EMPLOYEE: "/employee",
  MANAGER: "/manager",
  LD_ADMIN: "/lnd",
  HR_READ_ONLY: "/hr",
};

const PREFIX: [string, RoleCode][] = [
  ["/manager", "MANAGER"],
  ["/lnd", "LD_ADMIN"],
  ["/hr", "HR_READ_ONLY"],
  ["/employee", "EMPLOYEE"],
];

/** Whether the workspace is shown. Managers, L&D and HR also have employee records, so /employee stays open to them. */
export function canOpen(path: string, roles: RoleCode[]): boolean {
  const match = PREFIX.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return !match || roles.includes(match[1]);
}

export const SIDEBAR_COPY: Record<RoleCode, [string, string[]]> = {
  EMPLOYEE: ["Learn · Apply · Perform", ["Verify your learning", "and apply it at work"]],
  MANAGER: ["Lead · Coach · Enable", ["Drive your team’s learning", "and how it shows at work"]],
  LD_ADMIN: ["Design · Deliver · Evaluate", ["Manage training, assessments", "and behaviour follow-ups"]],
  HR_READ_ONLY: ["People · Learning · Behaviour", ["Organisation-wide learning", "and workplace application"]],
};

export const HINDI: Record<string, string> = {
  Dashboard: "डैशबोर्ड",
  "My Trainings": "मेरे प्रशिक्षण",
  Assessments: "आकलन",
  "Assessment History": "आकलन इतिहास",
  "Refresher Materials": "पुनश्चर्या सामग्री",
  "Self-Assessment (L3)": "स्व-मूल्यांकन (L3)",
  "Behaviour History": "व्यवहार इतिहास",
  Certificates: "प्रमाणपत्र",
  "My Team": "मेरी टीम",
  "Team Training Status": "टीम प्रशिक्षण स्थिति",
  "Assessment Performance": "आकलन प्रदर्शन",
  "Pending Behaviour Reviews": "लंबित व्यवहार समीक्षा",
  "Behaviour Questionnaires": "व्यवहार प्रश्नावली",
  "Team Scorecards": "टीम स्कोरकार्ड",
  "Team Reports": "टीम रिपोर्ट",
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
  Notifications: "सूचनाएं",
  "Audit Logs": "बदलाव का इतिहास",
  "Organisation Overview": "संगठन अवलोकन",
  "Learning Performance": "सीखने का प्रदर्शन",
  "Department Performance": "विभाग प्रदर्शन",
  "Assessment Pass/Fail": "आकलन उत्तीर्ण/अनुत्तीर्ण",
  "Learning Gain": "सीखने में वृद्धि",
  "Behaviour Improvement": "व्यवहार में सुधार",
  "Manager Evaluation": "प्रबंधक मूल्यांकन",
  "Effectiveness Scorecards": "प्रभावशीलता स्कोरकार्ड",
  "Reports & Exports": "रिपोर्ट और निर्यात",
};
