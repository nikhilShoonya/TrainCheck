import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* Employee Scorecard, opened from an employee row in Reports & Analytics. All API traffic is mocked with synthetic
   data; any request the mock does not know fails the test, so nothing reaches a backend. Run against an isolated
   frontend (BACKEND_URL on an unused port), as described in audit-fixes.spec.ts. */

const EMPLOYEE = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const OTHER_EMPLOYEE = "4a3c9d2f-0b5e-4f70-9c2b-3d4e5f6a7b8c";
const MISSING = "5b4d0e3a-1c6f-4a81-8d3c-4e5f6a7b8c9d";
const T = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

interface World {
  unknown: string[];
  requested: string[];
}

const training = (i: number, extra: Record<string, unknown> = {}) => ({
  enrolment_id: `enr-${i}`,
  training_id: T(i),
  training: `Synthetic Training ${i}`,
  assigned_at: `2026-11-${String(10 + i).padStart(2, "0")}T05:00:00Z`,
  completed_at: `2026-11-${String(11 + i).padStart(2, "0")}T00:00:00Z`,
  first_score: 50 + i,
  latest_score: 50 + i,
  highest_score: 50 + i,
  attempts: 1,
  assessment_timing: "Submitted",
  result: "PASSED",
  training_cycle: 1,
  ...extra,
});

function scorecard(trainingId: string | null) {
  // Eight trainings. The eighth (not in the first five) holds the best Highest Score: sorting must find it.
  let trainings = Array.from({ length: 8 }, (_, k) => training(k + 1));
  trainings[2] = training(3, { first_score: null, latest_score: null, highest_score: null, attempts: 0, assessment_timing: "Overdue", result: "PENDING", completed_at: null });
  trainings[7] = training(8, { first_score: 60, latest_score: 40, highest_score: 99, attempts: 3, result: "NOT_PASSED" });
  if (trainingId) trainings = trainings.filter((t) => t.training_id === trainingId);
  const ids = new Set(trainings.map((t) => t.training_id));
  const attempts = Array.from({ length: 8 }, (_, k) => ({
    id: `att-${k}`,
    training_id: T((k % 8) + 1),
    training: `Synthetic Training ${(k % 8) + 1}`,
    assessment_type: k === 7 ? "PRE_TEST" : "POST_TEST",
    attempt_number: 1,
    training_cycle: 1,
    show_cycle: false,
    score: 40 + k,
    result: k === 7 ? "BASELINE" : "PASSED",
    submitted_at: `2026-11-25T0${7 - k}:00:00Z`,
    submission: "By employee",
  })).filter((a) => ids.has(a.training_id));
  return {
    employee: { id: EMPLOYEE, name: "Synthetic Learner", employee_code: "SYN-001", department: "Synthetic Ops", location: null, grade: "G2", joining_date: "2024-06-10", email: "learner@example.test" },
    filters: trainingId ? { training_id: trainingId } : {},
    date_basis: "Dates filter by the training completion date (India time). Trainings not completed in the range are left out.",
    training_options: Array.from({ length: 8 }, (_, k) => ({ id: T(k + 1), name: `Synthetic Training ${k + 1}` })),
    summary: { assigned: trainings.length, completed: trainings.filter((t) => t.completed_at).length, passed: trainings.filter((t) => t.result === "PASSED").length, overdue: trainings.filter((t) => t.assessment_timing === "Overdue").length },
    trainings,
    learning_gain: trainings.map((t, k) => ({ training_id: t.training_id, training: t.training, pre_test: k === 0 ? 40 : null, first_post_test: t.first_score, gain: k === 0 ? (t.first_score as number) - 40 : null, comparable: k === 0, note: k === 0 ? null : "No pre-test score." })),
    // Two responses (newest first), then six trainings still without feedback: more than five, so View all shows.
    feedback: trainings.map((t, k) => ({ training_id: t.training_id, training: t.training, training_cycle: 1, show_cycle: false, status: k < 2 ? "SUBMITTED" : "NOT_SUBMITTED", ratings: k < 2 ? { relevance: 5, clarity: 4, alignment: 4, fairness: 5, confidence: 4 - k } : null, overall: k === 0 ? 4.4 : k === 1 ? 4.2 : null, comment: k === 0 ? "Clear examples and practical explanations." : null, submitted_at: k === 0 ? "2026-11-23T10:55:00Z" : k === 1 ? "2026-11-22T04:00:00Z" : null })),
    attempts,
    definitions: ["Synthetic definition."],
    generated_at: "2026-11-25T06:00:00Z",
  };
}

export async function mockApi(context: BrowserContext, world: World) {
  await context.addInitScript(() => {
    document.cookie = "tc_csrf=synthetic-test; path=/";
  });
  await context.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    world.requested.push(`${method} ${path}${url.search}`);
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data, meta: {} } : data) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "e-admin", employee_code: "SYN-ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-test" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (["/admin/trainings", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"].includes(path)) return json([]);
    if (path === "/reports/filter-options") return json({ departments: [{ id: "dep-1", name: "Synthetic Ops" }], locations: [], trainings: [], trainers: [], batches: [], grades: ["G2"] });
    const report = /^\/reports\/(compliance|pass-fail)$/.exec(path);
    if (report) return json({ code: report[1], title: report[1] === "compliance" ? "Training Completion and Compliance" : "Pass/Fail and Red-Flag Employees", description: "Synthetic report.", columns: ["Employee", "Training"], rows: [["Synthetic Learner", "Synthetic Training 1"], ["Second Learner", "Synthetic Training 2"]], employee_ids: [EMPLOYEE, OTHER_EMPLOYEE], definitions: [], filters: {}, generated_at: "2026-11-25T06:00:00Z" });
    if (path === "/reports/exports" && method === "GET") return json([]);
    if (path === "/reports/schedules") return json([]);
    if (path === `/reports/employees/${EMPLOYEE}/scorecard`) return json(scorecard(url.searchParams.get("training_id")));
    if (path === `/reports/employees/${OTHER_EMPLOYEE}/scorecard`) return json({ ...scorecard(null), employee: { ...scorecard(null).employee, id: OTHER_EMPLOYEE, name: "Second Learner", employee_code: "SYN-002" } });
    if (path === `/reports/employees/${MISSING}/scorecard`) return json({ error: { code: "NOT_FOUND", message: "This employee was not found." } }, 404);
    if (path === `/reports/employees/${EMPLOYEE}/scorecard/pdf`) return route.fulfill({ status: 200, contentType: "application/pdf", headers: { "Content-Disposition": 'attachment; filename="traincheck-employee-scorecard-SYN-001.pdf"' }, body: "%PDF-1.4 synthetic" });
    world.unknown.push(`${method} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

const card = (page: Page, title: string) => page.locator("section.esc-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const bodyRows = (page: Page, title: string) => card(page, title).locator("tbody tr");
const listRows = (page: Page, title: string) => card(page, title).locator("ul.esc-list > li");

test.describe("Employee Scorecard (mocked API)", () => {
  let world: World;
  test.beforeEach(async ({ context }) => {
    world = { unknown: [], requested: [] };
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("an employee row opens that employee's scorecard by ID, and Back to Reports restores the report and filters", async ({ page }) => {
    await page.goto("/lnd/reports");
    await page.locator('#main select').first().selectOption("pass-fail");
    await expect(page).toHaveURL(/report=pass-fail/);
    await page.locator('#main [name="department_id"]').selectOption("dep-1");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/department_id=dep-1/);

    // A click anywhere on the row opens the scorecard of that row's employee (by ID).
    await page.getByRole("cell", { name: "Synthetic Training 2" }).click();
    await expect(page).toHaveURL(new RegExp(`/lnd/reports/employees/${OTHER_EMPLOYEE}\\?back=`));
    await expect(page.getByRole("heading", { name: "Second Learner" })).toBeVisible();
    // One Back control, at the top (the breadcrumb is wayfinding, not a second Back button).
    await expect(page.locator("#main").getByRole("link", { name: /^Back to / })).toHaveCount(1);
    await page.screenshot({ path: "test-results/back-employee-scorecard.png", fullPage: true });
    await page.getByRole("link", { name: "Back to Reports" }).click();
    await expect(page).toHaveURL(/\/lnd\/reports\?report=pass-fail&department_id=dep-1$/);
    await expect(page.locator('#main [name="department_id"]')).toHaveValue("dep-1");

    // Keyboard: the explicit name link is reachable and opens with Enter.
    const link = page.getByRole("link", { name: "Open the employee scorecard of Synthetic Learner" });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/lnd/reports/employees/${EMPLOYEE}`));
    await expect(page.getByRole("heading", { name: "Synthetic Learner" })).toBeVisible();
    expect(world.requested.some((r) => r.startsWith(`GET /reports/employees/${EMPLOYEE}/scorecard`))).toBe(true);
  });

  test("profile, summary and the five-row tables with independent View all, sorting before truncation", async ({ page }) => {
    await page.goto(`/lnd/reports/employees/${EMPLOYEE}?back=report%3Dcompliance`);
    await expect(page.getByRole("heading", { name: "Employee Scorecard" })).toBeVisible();
    const profile = page.getByLabel("Employee profile");
    await expect(profile).toContainText("SYN-001");
    await expect(profile).toContainText("10-06-2024");
    await expect(profile).toContainText("Not recorded"); // Location is missing.
    await expect(profile).not.toContainText(/password/i);
    const summary = page.getByRole("list", { name: "Summary" });
    await expect(summary).toContainText("Assigned trainings8");
    await expect(summary).toContainText("Overdue assessments1");

    // Every table: five rows, "View all (N)" and "Showing 5 of N".
    await expect(bodyRows(page, "Training record")).toHaveCount(5);
    await expect(card(page, "Training record")).toContainText("Showing 5 of 8 trainings · all time");
    await expect(card(page, "Assessment attempt history")).toContainText("Showing 5 of 8 attempts · every attempt is retained");
    await expect(bodyRows(page, "Assessment attempt history")).toHaveCount(5);
    await expect(listRows(page, "Learning gain")).toHaveCount(5);

    // Feedback: one response at a time, chosen by training; below, trainings without feedback (five, then View all).
    const feedback = card(page, "Training feedback");
    await expect(feedback.locator(".esc-feedback-missing li")).toHaveCount(5);
    await expect(feedback.locator(".esc-feedback-missing li").first()).toContainText("Not submitted");
    await feedback.getByRole("button", { name: "View all (6)" }).click();
    await expect(feedback.locator(".esc-feedback-missing li")).toHaveCount(6);
    await expect(feedback).toContainText("Clear examples and practical explanations.");
    await expect(feedback).toContainText("Relevance 5");
    await feedback.getByLabel("Feedback for training").selectOption({ label: "Synthetic Training 2" });
    await expect(feedback).toContainText("4.2 / 5");
    await expect(feedback).toContainText("22-11-2026 09:30 AM");
    await expect(feedback).toContainText("No comment");
    await feedback.getByLabel("Feedback for training").selectOption({ label: "Synthetic Training 1" });

    // Missing scores read "—", never 0.
    const missingRow = bodyRows(page, "Training record").filter({ hasText: "Synthetic Training 3" });
    await expect(missingRow).toContainText("—");
    await expect(missingRow).toContainText("Overdue");
    // The best score is in the eighth row: sorting by Highest Score (descending) must bring it into the first five.
    await expect(card(page, "Training record")).not.toContainText("99%");
    const sort = card(page, "Training record").getByRole("button", { name: "Sort by Highest Score %" });
    await sort.click();
    await sort.click();
    await expect(bodyRows(page, "Training record").first()).toContainText("99%");
    await expect(bodyRows(page, "Training record")).toHaveCount(5);

    // Expanding one table leaves the others at five.
    await card(page, "Training record").getByRole("button", { name: "View all (8)" }).click();
    await expect(bodyRows(page, "Training record")).toHaveCount(8);
    await expect(card(page, "Training record")).toContainText("Showing 8 of 8 trainings");
    await expect(card(page, "Training record").getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    await expect(bodyRows(page, "Assessment attempt history")).toHaveCount(5);
    await expect(listRows(page, "Learning gain")).toHaveCount(5);
    await card(page, "Learning gain").getByRole("button", { name: "View all (8)" }).click();
    await expect(listRows(page, "Learning gain")).toHaveCount(8);
    await card(page, "Training record").getByRole("button", { name: "Show less" }).click();
    await expect(bodyRows(page, "Training record")).toHaveCount(5);
    await expect(listRows(page, "Learning gain")).toHaveCount(8);

    // Dates: DD-MM-YYYY, India time with AM/PM, no zone suffix. Newest attempt first.
    await expect(bodyRows(page, "Assessment attempt history").first()).toContainText("25-11-2026 12:30 PM");
    await expect(feedback).toContainText("23-11-2026 04:25 PM");
    await expect(feedback).toContainText("4.4 / 5");
    await expect(page.locator("#main")).not.toContainText(/\b(UTC|IST)\b/);
    await expect(card(page, "Learning gain")).toContainText("Gain +11 points");
    await expect(card(page, "Learning gain")).toContainText("Not comparable");
  });

  test("filters apply everywhere, reset expansion, survive a refresh and go into the PDF", async ({ page }) => {
    await page.goto(`/lnd/reports/employees/${EMPLOYEE}?back=report%3Dpass-fail`);
    await card(page, "Assessment attempt history").getByRole("button", { name: "View all (8)" }).click();
    await expect(bodyRows(page, "Assessment attempt history")).toHaveCount(8);

    // Training applies as soon as it is chosen (no Apply button, as in the design).
    await page.locator('#main [name="training_id"]').selectOption(T(8));
    await expect(page).toHaveURL(new RegExp(`training_id=${T(8)}`));
    await expect(bodyRows(page, "Training record")).toHaveCount(1);
    await expect(card(page, "Training record")).toContainText("Showing 1 of 1 training");
    await expect(card(page, "Training record").getByRole("button", { name: /View all|Show less/ })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Summary" })).toContainText("Assigned trainings1");
    await expect(bodyRows(page, "Assessment attempt history")).toHaveCount(1);

    await page.reload();
    await expect(page.locator('#main [name="training_id"]')).toHaveValue(T(8));
    await expect(bodyRows(page, "Training record")).toHaveCount(1);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export PDF" }).click();
    expect((await download).suggestedFilename()).toBe("traincheck-employee-scorecard-SYN-001.pdf");
    expect(world.requested).toContain(`GET /reports/employees/${EMPLOYEE}/scorecard/pdf?training_id=${T(8)}`);

    // Date: a preset is a completion-date range ending today, kept in the URL across a refresh.
    const date = page.locator('#main [name="date_preset"]');
    await expect(date).toHaveValue("all");
    await expect(date).toHaveAttribute("title", /training completion date/);
    await date.selectOption("30");
    await expect(page).toHaveURL(/date_from=\d{4}-\d{2}-\d{2}&date_to=\d{4}-\d{2}-\d{2}/);
    await expect(page).toHaveURL(new RegExp(`training_id=${T(8)}`));
    await expect(card(page, "Training record")).toContainText(/· completed \d{2}-\d{2}-\d{4} to \d{2}-\d{2}-\d{4}/);
    await page.reload();
    await expect(date).toHaveValue("30");

    // Custom range: a range the wrong way round is refused before any request.
    await date.selectOption("custom");
    await page.locator('#main [name="date_to"]').fill("2026-11-01");
    await expect(page).toHaveURL(/date_to=2026-11-01/);
    await page.locator('#main [name="date_from"]').fill("2026-11-30");
    await expect(page.locator("#main .form-error")).toContainText("start date must be on or before the end date");
    expect(world.requested.some((r) => r.includes("date_from=2026-11-30"))).toBe(false);

    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/lnd/reports/employees/${EMPLOYEE}\\?back=report%3Dpass-fail$`));
    await expect(bodyRows(page, "Training record")).toHaveCount(5);
    await page.getByRole("link", { name: "Back to Reports" }).click();
    await expect(page).toHaveURL(/\/lnd\/reports\?report=pass-fail$/);
  });

  test("unknown and malformed employee links show Employee not found", async ({ page }) => {
    await page.goto(`/lnd/reports/employees/${MISSING}`);
    await expect(page.getByRole("heading", { name: "Employee not found" })).toBeVisible();
    await page.goto("/lnd/reports/employees/Synthetic%20Learner");
    await expect(page.getByRole("heading", { name: "Employee not found" })).toBeVisible();
    expect(world.requested.some((r) => r.includes("Synthetic"))).toBe(false);
    await expect(page.getByRole("link", { name: "Back to Reports" })).toHaveAttribute("href", "/lnd/reports");
  });
});
