import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* The Batch filter was removed from the shared report filter bar on purpose. Admin Learning Scorecards and
   Reports & Analytics must show no Batch dropdown, while their other controls keep working. All API traffic is mocked
   with synthetic data; any request the mock does not know fails the test, so nothing reaches a backend. Run against an
   isolated frontend (BACKEND_URL on an unused port), as described in audit-fixes.spec.ts. */

const TRAINING = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

interface World {
  unknown: string[];
  requested: string[];
  exports: unknown[];
}

const scorecard = (id: string, title: string) => ({
  training: { id, code: "SYN", title, category: null, trainer: null, owner: null, batches: ["Historical cohort"], followup_days: [] },
  generated_at: "2026-11-20T06:00:00Z",
  learning: { state: "Available", assigned: 4, completed: 3, assessed: 2, pre_test_state: "Not configured", pre_test_mean: null, post_test_mean: 80, first_attempt_mean: 75, best_score_mean: 85, pass_rate: 50, failed_attempts: 1, needs_retraining: 0, matched_pairs: 0, learning_gain_mean: null, normalised_gain_mean: null, topics: [], questions: [] },
  behaviour: { state: "Not collected", self_mean: null, manager_mean: null, self_manager_gap: null, overdue: 0, improvement_status: "Not collected", periods: [], competencies: [] },
  interpretation: "Synthetic interpretation.",
});

async function mockApi(context: BrowserContext, world: World) {
  await context.addInitScript(() => {
    document.cookie = "tc_csrf=synthetic-test; path=/";
  });
  await context.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    world.requested.push(`${method} ${path}${url.search}`);
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "e-admin", employee_code: "SYN-ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-test" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    // Reference lists the app prefetches for an L&D Admin after the first screen (lib/query ROLE_PREFETCH).
    if (["/admin/trainings", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"].includes(path)) return json([]);
    // The server still offers batches (backend reporting support is kept); the page must not show them.
    if (path === "/reports/filter-options") return json({ departments: [{ id: "dep-1", name: "Synthetic Ops" }], locations: [{ id: "loc-1", name: "Synthetic City" }], trainings: [{ id: TRAINING, name: "Synthetic training" }], trainers: [{ id: "tr-1", name: "Synthetic Trainer" }], batches: [{ id: "batch-1", name: "Synthetic batch" }], grades: ["G1"] });
    if (path === "/scorecards") return json([{ id: TRAINING, title: "Synthetic training", code: "SYN" }, { id: OTHER, title: "Second synthetic training", code: "SYN2" }]);
    if (path === `/scorecards/${TRAINING}`) return json(scorecard(TRAINING, "Synthetic training"));
    if (path === `/scorecards/${OTHER}`) return json(scorecard(OTHER, "Second synthetic training"));
    const report = /^\/reports\/(compliance|pass-fail)$/.exec(path);
    if (report) return json({ code: report[1], title: report[1] === "compliance" ? "Training Completion and Compliance" : "Pass/Fail and Red-Flag Employees", description: "Synthetic report.", columns: ["Employee", "Training"], rows: [["Synthetic Person", "Synthetic training"]], definitions: [], filters: {}, generated_at: "2026-11-20T06:00:00Z" });
    if (path === "/reports/exports" && method === "GET") return json([]);
    if (path === "/reports/exports" && method === "POST") {
      world.exports.push(request.postDataJSON());
      return json({ id: "export-1", file_name: "synthetic.csv" });
    }
    if (path === "/reports/exports/export-1/download") return route.fulfill({ status: 200, contentType: "text/csv", headers: { "Content-Disposition": 'attachment; filename="synthetic.csv"' }, body: "Employee\nSynthetic Person\n" });
    if (path === "/reports/schedules") return json([]);
    world.unknown.push(`${method} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

/* The page's form controls by visible label. Labels wrap their controls, so the accessible name also contains the
   selected option; the controls are therefore found by their form name, inside the page content (not the sidebar). */
const NAMES: Record<string, string> = {
  "Completed from": "date_from",
  "Completed to": "date_to",
  Department: "department_id",
  Location: "location_id",
  Training: "training_id",
  Trainer: "trainer_id",
  "Employee grade": "grade",
};
const field = (page: Page, label: string) => {
  if (label in NAMES) return page.locator(`#main [name="${NAMES[label]}"]`);
  return page.locator("#main label.field").filter({ has: page.locator("select") }).filter({ hasText: new RegExp(`^${label}`) }).locator("select");
};

async function expectNoBatchFilter(page: Page) {
  await expect(field(page, "Department")).toBeVisible();
  await expect(page.locator("#main label.field").filter({ hasText: /^Batch/ })).toHaveCount(0);
  await expect(page.locator('select[name="batch_id"]')).toHaveCount(0);
  await expect(page.getByRole("option", { name: "All batches" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Synthetic batch" })).toHaveCount(0);
  for (const label of ["Completed from", "Completed to", "Department", "Location", "Training", "Trainer", "Employee grade"]) await expect(field(page, label)).toBeVisible();
}

test.describe("report filters without Batch (mocked API)", () => {
  let world: World;
  test.beforeEach(async ({ context }) => {
    world = { unknown: [], requested: [], exports: [] };
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("Learning Scorecards: no Batch dropdown; training, filters and export still work", async ({ page }) => {
    await page.goto("/lnd/scorecards");
    await expect(page.getByRole("heading", { name: "Synthetic training", exact: true })).toBeVisible();
    await expectNoBatchFilter(page);

    await field(page, "Department").selectOption("dep-1");
    await field(page, "Employee grade").selectOption("G1");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect.poll(() => world.requested.some((r) => r.startsWith(`GET /scorecards/${TRAINING}?`) && r.includes("department_id=dep-1") && r.includes("grade=G1"))).toBe(true);
    expect(world.requested.some((r) => r.includes("batch_id"))).toBe(false);

    await field(page, "Training programme").selectOption(OTHER);
    await expect(page.getByRole("heading", { name: "Second synthetic training", exact: true })).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("synthetic.csv");
    expect(world.exports).toEqual([{ report_code: "scorecard", export_format: "CSV", filters: { department_id: "dep-1", grade: "G1", training_id: OTHER }, own_record: false }]);
  });

  test("Reports & Analytics: no Batch dropdown; report choice, filters and export still work", async ({ page }) => {
    await page.goto("/lnd/reports");
    await expect(page.getByRole("heading", { name: "Training Completion and Compliance" })).toBeVisible();
    await expectNoBatchFilter(page);

    await field(page, "Location").selectOption("loc-1");
    await field(page, "Trainer").selectOption("tr-1");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect.poll(() => world.requested.some((r) => r.startsWith("GET /reports/compliance?") && r.includes("location_id=loc-1") && r.includes("trainer_id=tr-1"))).toBe(true);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("synthetic.csv");
    expect(world.exports).toEqual([{ report_code: "compliance", export_format: "CSV", filters: { location_id: "loc-1", trainer_id: "tr-1" }, own_record: false }]);

    await field(page, "Report").selectOption("pass-fail");
    await expect(page.getByRole("heading", { name: "Pass/Fail and Red-Flag Employees" })).toBeVisible();
    await expectNoBatchFilter(page);
    expect(world.requested.some((r) => r.includes("batch_id"))).toBe(false);
  });
});
