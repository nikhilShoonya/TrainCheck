import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Every API request is mocked; backend regressions check the counts and chronological ordering independently.
const emptySummary = {
  assignments: 0, employees: 0, completed: 0, trained_employees: 0, assessed: 0, passed: 0, not_passed: 0,
  not_passed_employees: 0, needs_retraining_employees: 0, pending_assessment: 0, awaiting_assessment: 0,
  in_progress: 0, pass_rate: null, completion_rate: null, mean_latest_score: null,
};
const recentTrainings = [
  { id: "new", title: "ZZZ Newest programme", status: "DRAFT", enrolled: 0, pass_rate: null },
  { id: "archived", title: "Archived programme", status: "ARCHIVED", enrolled: 1, pass_rate: null },
  { id: "active", title: "AAA Older active programme", status: "ACTIVE", enrolled: 1, pass_rate: 80 },
];

async function mockApi(context: BrowserContext, role: "admin" | "employee", assessed = false, behaviour = false) {
  const unknown: string[] = [];
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic-dashboard; path=/"; });
  await context.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    if (path === "/auth/me") return json({ user: { id: `synthetic-${role}`, employee_id: `e-${role}`, employee_code: "SYN-DASH", full_name: "Synthetic Person", email: "synthetic@example.test", roles: role === "admin" ? ["LD_ADMIN", "EMPLOYEE"] : ["EMPLOYEE"], primary_role: role === "admin" ? "LD_ADMIN" : "EMPLOYEE", features: { behaviour, password_change: role === "admin" } }, csrf_token: "synthetic-dashboard" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (path === "/admin/dashboard") return json({ total_employees: 2, training_programmes: 2, summary: emptySummary, departments: [], trend: [], recent_trainings: recentTrainings, completions_awaiting: 0, import_rows_need_review: 0, programmes_need_setup: 1 });
    if (path === "/reports/analytics") return json({ behaviour_trend: [] });
    if (path === "/me/dashboard") return json({
      summary: assessed ? { ...emptySummary, assignments: 1, employees: 1, completed: 1, assessed: 1, passed: 1, pass_rate: 100, completion_rate: 100, mean_latest_score: 80 } : emptySummary,
      overall_score: assessed ? 80 : null,
      trend_points: assessed ? [{ label: "Completed synthetic training", score: 80, date: "2026-11-01T09:00:00Z" }] : [],
      recent: assessed ? [{ enrolment_id: "enrolment-1", title: "Completed synthetic training", completed_at: "2026-11-01T09:00:00Z", latest_attempt_id: "attempt-1", latest_score: 80 }] : [],
      calendar: [], retake: null, upcoming: null, behaviour: null, reviews_due: 0,
    });
    if (["/admin/trainings", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies", "/me/trainings"].includes(path)) return json([]);
    unknown.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_MOCKED", message: "Unexpected dashboard API request" } }) });
  });
  return unknown;
}

const recentPanel = (page: Page) => page.locator("section.dashboard-panel").filter({ has: page.getByRole("heading", { name: "Recent Trainings", exact: true }) });

for (const behaviour of [false, true]) {
  test(`admin ${behaviour ? "enables" : "omits"} behaviour copy and analytics with the feature flag`, async ({ context, page }) => {
    const unknown = await mockApi(context, "admin", false, behaviour);
    const analytics: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/v1/reports/analytics") analytics.push(request.url());
    });
    await page.goto("/lnd");
    await expect(recentPanel(page)).toBeVisible();
    await expect(page.getByText(behaviour ? "Manage trainings, assessments, question bank and behaviour follow-ups." : "Manage trainings, assessments and question bank.", { exact: true })).toBeVisible();
    if (behaviour) await expect.poll(() => analytics.length).toBe(1);
    else expect(analytics).toEqual([]);
    expect(unknown).toEqual([]);
  });
}

test("admin displays archived status, draft/active programme count and server recency order", async ({ context, page }) => {
  const unknown = await mockApi(context, "admin");
  await page.goto("/lnd");
  await expect(recentPanel(page).locator(".recent-training-copy strong")).toHaveText(recentTrainings.map(training => training.title));
  const archived = recentPanel(page).locator(".recent-training").filter({ hasText: "Archived programme" });
  await expect(archived.locator("small")).toHaveText("Archived · 1 enrolled");
  const metric = page.locator(".image-metric").filter({ hasText: "Training Programmes" });
  await expect(metric.locator("strong")).toHaveText("2");
  await expect(metric.locator("small")).toHaveText("Draft and active programmes");
  await expect(page.getByText("1 Programmes Need Configuration", { exact: true })).toBeVisible();
  expect(unknown).toEqual([]);
});

for (const assessed of [false, true]) {
  test(`employee ${assessed ? "with results" : "without training evidence"} sees assessment status without a verification claim`, async ({ context, page }) => {
    const unknown = await mockApi(context, "employee", assessed);
    await page.goto("/employee");
    await expect(page.locator(".banner-status")).toHaveText("No assessments due");
    await expect(page.getByText("Learning verified", { exact: true })).toHaveCount(0);
    await expect(page.locator(".overall-score")).toHaveText(assessed ? "80%" : "—");
    if (!assessed) await expect(page.getByText("No training assigned.", { exact: true })).toBeVisible();
    expect(unknown).toEqual([]);
  });
}

for (const role of ["admin", "employee"] as const) {
  test(`${role} dashboard retains mobile layout after the status fixes`, async ({ context, page }) => {
    const unknown = await mockApi(context, role);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(role === "admin" ? "/lnd" : "/employee");
    await expect(page.locator(".reference-dashboard")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.locator("#sidebar a").first()).toBeVisible();
    expect(unknown).toEqual([]);
  });
}
