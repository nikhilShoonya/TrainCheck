import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/* L&D Admin dashboard: Assessment Completion Rate card (between Training Completion and Assessment Pass Rate) and the
   Assessment Completion by Department panel (between Learning and Training Completion by Department). The figures come
   from the server; these checks cover placement, wording, "—" for an empty denominator and the responsive layout.
   All API traffic is mocked with synthetic data; run against an isolated frontend (BACKEND_URL on an unused port). */

const summary = {
  assignments: 40, employees: 32, completed: 30, trained_employees: 26, assessed: 18, passed: 14, not_passed: 4,
  not_passed_employees: 3, needs_retraining_employees: 1, pending_assessment: 22, awaiting_assessment: 8,
  in_progress: 1, pass_rate: 77.8, completion_rate: 75, mean_latest_score: 74.5,
};
const dept = (department: string, completion_rate: number | null) => ({ department, ...summary, completion_rate });

async function mockApi(context: BrowserContext, empty = false) {
  const unknown: string[] = [];
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic-dashboard; path=/"; });
  await context.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "e-admin", employee_code: "SYN-ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-dashboard" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (["/admin/trainings", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"].includes(path)) return json([]);
    if (path === "/admin/dashboard")
      return json({
        total_employees: 48, training_programmes: 5, summary,
        departments: [dept("Customer Support", 82.5), dept("Human Resource", 100), dept("Operations", 60)],
        assessment_completion: empty ? { required: 0, completed: 0, rate: null } : { required: 24, completed: 18, rate: 75 },
        assessment_departments: empty
          ? [{ department: "Customer Support", required: 0, completed: 0, rate: null }]
          : [
              { department: "Customer Support", required: 12, completed: 8, rate: 66.7 },
              { department: "Human Resource", required: 10, completed: 10, rate: 100 },
              { department: "Operations", required: 0, completed: 0, rate: null },
            ],
        trend: [
          { month: "2026-09", completion_rate: 55, pass_rate: 70 },
          { month: "2026-10", completion_rate: 68, pass_rate: 75 },
          { month: "2026-11", completion_rate: 75, pass_rate: 77.8 },
        ],
        recent_trainings: [{ id: "t1", title: "Synthetic product awareness", status: "ACTIVE", enrolled: 49, pass_rate: 80 }],
        completions_awaiting: 10, import_rows_need_review: 0, programmes_need_setup: 1,
      });
    unknown.push(path);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
  return unknown;
}

const card = (page: Page, label: string) => page.locator(".image-metric").filter({ has: page.getByRole("heading", { name: label, exact: true }) });

test("the card and panel sit in the requested order with percentages and counts", async ({ context, page }) => {
  const unknown = await mockApi(context);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/lnd");
  await expect(card(page, "Assessment Completion Rate")).toBeVisible();

  const labels = await page.locator(".image-metric h2").allInnerTexts();
  expect(labels).toEqual(["Total Employees", "Training Programmes", "Training Completion", "Assessment Completion Rate", "Assessment Pass Rate", "Red-Flag Employees"]);
  await expect(card(page, "Assessment Completion Rate")).toContainText("75%");
  await expect(card(page, "Assessment Completion Rate")).toContainText("18 / 24 required assessments completed");

  const panels = await page.locator(".admin-primary > .panel h2").allInnerTexts();
  expect(panels.map((t) => t.replace(/\s+/g, " ").trim())).toEqual(["Learning (Evidence)", "Assessment Completion by Department", "Training Completion by Department", "Training Trend"]);
  const assessmentPanel = page.locator(".admin-primary > .panel").nth(1);
  await expect(assessmentPanel.locator(".image-department-bar")).toHaveCount(3);
  await expect(assessmentPanel.locator(".image-department-bar").nth(0)).toContainText("66.7%");
  await expect(assessmentPanel.locator(".image-department-bar").nth(0)).toContainText("8/12");
  await expect(assessmentPanel.locator(".image-department-bar").nth(2)).toContainText("—");
  await expect(assessmentPanel.locator(".image-department-bar").nth(2)).toContainText("0/0");
  // The Training Completion panel is unchanged: percentages only.
  await expect(page.locator(".admin-primary > .panel").nth(2).locator(".image-department-bar").nth(0)).toHaveText(/Customer Support\s*82\.5%/);

  for (const [width, name] of [[1920, "desktop-1920"], [1440, "laptop-1440"], [1024, "tablet-1024"], [390, "phone-390"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card(page, "Assessment Completion Rate")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `no sideways scroll at ${width}px`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/admin-dashboard-${name}.png`, fullPage: true });
  }
  expect(unknown).toEqual([]);
});

test("nothing required yet shows a dash, not 0%", async ({ context, page }) => {
  const unknown = await mockApi(context, true);
  await page.goto("/lnd");
  await expect(card(page, "Assessment Completion Rate")).toContainText("—");
  await expect(card(page, "Assessment Completion Rate")).toContainText("No post-test assessments required yet");
  await expect(page.locator(".admin-primary > .panel").nth(1).locator(".image-department-bar")).toContainText("—");
  expect(unknown).toEqual([]);
});
