import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/* One Back control at the top of each workspace page (27 Nov 2026): labelled with its destination, no duplicates
   lower down, return state kept, a parent (or the Dashboard) after a direct link, the previous TrainCheck page
   otherwise, and nothing on the Dashboard. All API traffic is mocked with synthetic data; run against an isolated
   frontend (BACKEND_URL on an unused port). */

const TRAINING = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const employees = Array.from({ length: 14 }, (_, i) => ({
  id: `${String(i + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
  employee_code: `SYN${String(i + 1).padStart(3, "0")}`,
  full_name: `Synthetic Person ${String(i + 1).padStart(2, "0")}`,
  work_email: `person${i + 1}@example.test`,
  department: i % 2 ? "Synthetic Support" : "Synthetic Operations",
  employment_status: "ACTIVE",
}));
const training = { id: TRAINING, title: "Synthetic Product Awareness", training_code: "SYN-1", status: "ACTIVE", description: "Synthetic", assigned_count: 1, completed_count: 0, pending_scheduling_count: 0, unavailable_count: 0, target_scope: "COMMON", departments: [], functions: [], competencies: [], followup_days: [], materials: [] };
const summary = { assignments: 0, employees: 0, completed: 0, trained_employees: 0, assessed: 0, passed: 0, not_passed: 0, not_passed_employees: 0, needs_retraining_employees: 0, pending_assessment: 0, awaiting_assessment: 0, in_progress: 0, pass_rate: null, completion_rate: null, mean_latest_score: null };

async function mockApi(context: BrowserContext) {
  const unknown: string[] = [];
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic-back; path=/"; });
  await context.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "e-admin", employee_code: "SYN-ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-back" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (path === "/admin/dashboard") return json({ total_employees: 14, training_programmes: 1, summary, departments: [], assessment_completion: { required: 0, completed: 0, rate: null }, assessment_departments: [], trend: [], recent_trainings: [], completions_awaiting: 0, import_rows_need_review: 0, programmes_need_setup: 0 });
    if (path === "/admin/employees") return json(employees);
    if (path === "/admin/trainings") return json([training]);
    if (path === "/admin/questions/unassigned-summary") return json({ question_count: 0 });
    if (path === "/reports/filter-options") return json({ departments: [], locations: [], trainings: [], trainers: [], batches: [], grades: [] });
    if (path === "/reports/compliance") return json({ code: "compliance", title: "Training Completion and Compliance", description: "Synthetic.", columns: ["Employee"], rows: [], definitions: [], filters: {}, generated_at: "2026-11-20T06:00:00Z" });
    if (request.method() === "GET" && ["/admin/enrolments", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies", "/admin/questions", "/admin/questions/summary", "/reports/exports", "/reports/schedules", "/me/notifications", "/admin/imports"].includes(path)) return json([]);
    unknown.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
  return unknown;
}

/** Every Back-style control on the page: links and buttons named "Back…", and the old unlabelled arrow. */
const backControls = (page: Page) => page.locator("#main").getByRole("link", { name: /^Back\b/ }).or(page.locator("#main").getByRole("button", { name: /^Back\b|previous page/ }));
const listPanel = (page: Page) => page.getByRole("region", { name: "Employees" });
let unknown: string[] = [];

test.beforeEach(async ({ context }) => {
  unknown = await mockApi(context);
});
test.afterEach(() => {
  expect(unknown, "every API request must be mocked").toEqual([]);
});

test("Employee Assignments: one Back to Employees at the top restores search, page and scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/lnd/assignments");
  await expect(listPanel(page)).toBeVisible();
  // The list is a sidebar page opened directly: its Back leads to the Dashboard.
  await expect(backControls(page)).toHaveCount(1);
  await expect(backControls(page)).toHaveText("Back to Dashboard");

  await listPanel(page).getByLabel("Search").fill("Synthetic");
  await expect(page).toHaveURL(/search=Synthetic/);
  const pager = listPanel(page).locator(".table-pagination");
  await pager.getByRole("button", { name: "Next" }).click();
  await expect(pager).toContainText("Page 2 of");
  await pager.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);

  await listPanel(page).locator("tbody tr").first().getByRole("button").click();
  const selected = page.getByRole("region", { name: "Selected employee" });
  await expect(selected).toBeVisible();
  await expect(backControls(page)).toHaveCount(1);
  await expect(backControls(page)).toHaveText("Back to Employees");
  await expect(selected.getByRole("button", { name: /Back/ })).toHaveCount(0); // No duplicate inside the panel.
  // The Back control comes before the page heading.
  const [backTop, headingTop] = await Promise.all([backControls(page).boundingBox(), page.getByRole("heading", { level: 1 }).boundingBox()]);
  expect(backTop!.y).toBeLessThan(headingTop!.y);
  await page.screenshot({ path: "test-results/back-assignments-employee.png", fullPage: true });

  await backControls(page).click();
  await expect(listPanel(page)).toBeVisible();
  await expect(listPanel(page).getByLabel("Search")).toHaveValue("Synthetic");
  await expect(pager).toContainText("Page 2 of");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolled);
  await expect(page).not.toHaveURL(/employee=/);
});

test("Employee Assignments: a direct link to an employee falls back to the filtered list", async ({ page }) => {
  await page.goto(`/lnd/assignments?employee=${employees[3].id}&search=Person&department=Synthetic%20Support`);
  await expect(page.getByRole("region", { name: "Selected employee" })).toContainText(employees[3].full_name);
  await expect(backControls(page)).toHaveCount(1);
  await expect(backControls(page)).toHaveAttribute("href", "/lnd/assignments?department=Synthetic+Support&search=Person");
  await backControls(page).click();
  await expect(listPanel(page)).toBeVisible();
  await expect(page).toHaveURL(/\/lnd\/assignments\?department=Synthetic\+Support&search=Person$/);
  await expect(listPanel(page).getByLabel("Search")).toHaveValue("Person");
  await expect(listPanel(page).locator('select[name="employee_department"]')).toHaveValue("Synthetic Support");
  // Keyboard: the control is a link, reachable and opened with Enter.
  await page.goto(`/lnd/assignments?employee=${employees[3].id}`);
  await backControls(page).focus();
  await page.keyboard.press("Enter");
  await expect(listPanel(page)).toBeVisible();
});

test("detail pages show only Back to their parent, keeping the card search", async ({ page }) => {
  await page.goto(`/lnd/completion/${TRAINING}?q=awareness`);
  await expect(page.getByRole("heading", { level: 1, name: training.title })).toBeVisible();
  await expect(backControls(page)).toHaveCount(1);
  await expect(backControls(page)).toHaveText("Back to Trainings");
  await expect(backControls(page)).toHaveAttribute("href", "/lnd/completion?q=awareness");
  await page.screenshot({ path: "test-results/back-completion-training.png", fullPage: true });

  // Not found: still one control, to the parent.
  await page.goto("/lnd/completion/not-a-training");
  await expect(page.getByRole("heading", { level: 1, name: "Training not found" })).toBeVisible();
  await expect(backControls(page)).toHaveCount(1);
  await expect(backControls(page)).toHaveAttribute("href", "/lnd/completion");

  await page.goto("/lnd/questions/unassigned?q=awareness");
  await expect(page.getByRole("heading", { level: 1, name: "Unassigned Questions" })).toBeVisible();
  await expect(backControls(page)).toHaveCount(1);
  await expect(backControls(page)).toHaveAttribute("href", "/lnd/questions?q=awareness");
});

test("sidebar pages return to the previous TrainCheck page by name, the Dashboard after a direct link, and none on the Dashboard", async ({ page }) => {
  await page.goto("/lnd");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(backControls(page)).toHaveCount(0);

  await page.goto("/lnd/trainings");
  await expect(backControls(page)).toHaveText("Back to Dashboard");
  await expect(backControls(page)).toHaveAttribute("href", "/lnd");

  await page.getByRole("link", { name: "Reports & Analytics" }).click();
  await expect(page).toHaveURL(/\/lnd\/reports/);
  await expect(backControls(page)).toHaveCount(1);
  await expect(backControls(page)).toHaveText("Back to Training Management");
  await page.screenshot({ path: "test-results/back-reports.png", fullPage: true });

  // A refresh keeps the previous page; the report's own address changes do not replace it.
  await page.reload();
  await expect(backControls(page)).toHaveText("Back to Training Management");
  await backControls(page).click();
  await expect(page).toHaveURL(/\/lnd\/trainings$/);
  await expect(backControls(page)).toHaveText("Back to Reports & Analytics");

  // A new tab has no previous page: the Dashboard.
  const fresh = await page.context().newPage();
  await fresh.setViewportSize({ width: 390, height: 844 });
  await fresh.goto("/notifications");
  await expect(backControls(fresh)).toHaveText("Back to Dashboard");
  await expect(fresh.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await fresh.screenshot({ path: "test-results/back-notifications-phone.png" });
  expect(await fresh.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await fresh.close();
});

test("a crafted previous page outside TrainCheck is never offered", async ({ page }) => {
  await page.goto("/lnd");
  await page.evaluate(() => sessionStorage.setItem("traincheck.back-trail", JSON.stringify({ user: "synthetic-admin", current: "//example.com/lnd", previous: "https://example.com/" })));
  await page.goto("/lnd/imports");
  await expect(backControls(page)).toHaveText("Back to Dashboard");
  await expect(backControls(page)).toHaveAttribute("href", "/lnd");
});
