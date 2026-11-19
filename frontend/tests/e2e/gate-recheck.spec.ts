import { expect, test, type BrowserContext } from "@playwright/test";

/* An employee page left open must notice when an assessment becomes due: at the opening moment the server reports,
   and when the person returns to the tab. Mocked API (no backend or database); the server still blocks every API
   request on its own regardless.
   Run: npx playwright test tests/e2e/gate-recheck.spec.ts */

const ACCOUNT = "u0000000-0000-4000-8000-000000000002";
const T0 = new Date("2026-11-19T09:00:00Z");

interface Gate {
  status: "DASHBOARD_ALLOWED" | "ASSESSMENT_REQUIRED";
  next: string | null;
  checks: number;
}

async function mockApi(context: BrowserContext, gate: Gate) {
  await context.addCookies([{ name: "tc_csrf", value: "synthetic", url: test.info().project.use.baseURL ?? "http://localhost:3000" }]);
  await context.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    if (path === "/auth/me")
      return json({ user: { id: ACCOUNT, employee_id: "emp2", employee_code: "E2", full_name: "Synthetic Employee", email: "synthetic2@example.test", department: null, function: null, location: null, grade: null, roles: ["EMPLOYEE"], primary_role: "EMPLOYEE" } });
    if (path === "/me/access-state") {
      gate.checks += 1;
      const required = gate.status === "ASSESSMENT_REQUIRED";
      return json({
        access_status: gate.status,
        pending_count: required ? 1 : 0,
        next_action: required ? "COMPLETE_ASSESSMENT" : "OPEN_DASHBOARD",
        queue: required ? [{ obligation_id: "o1", training_title: "Synthetic training", position: 1 }] : [],
        unavailable: [],
        feedback_due: null,
        next_change_at: required ? null : gate.next,
        server_now: T0.toISOString(),
      });
    }
    if (path === "/me/trainings") return json([]);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

test.describe("an open employee page re-checks the gate (mocked API)", () => {
  test("at the next opening moment the server reported", async ({ context, page }) => {
    const gate: Gate = { status: "DASHBOARD_ALLOWED", next: new Date(T0.getTime() + 60_000).toISOString(), checks: 0 };
    await mockApi(context, gate);
    await page.clock.install({ time: T0 });
    await page.goto("/employee/assessments");
    await expect(page.getByRole("heading", { name: "My Assessments" })).toBeVisible();
    gate.status = "ASSESSMENT_REQUIRED"; // The assessment opens at T0 + 60 s.
    await page.clock.fastForward(59_000);
    await expect(page).toHaveURL(/\/employee\/assessments/); // Not before the moment.
    await page.clock.fastForward(3_000);
    await page.waitForURL(/\/access\/assessment-required/);
  });

  test("when the person returns to the tab", async ({ context, page }) => {
    const gate: Gate = { status: "DASHBOARD_ALLOWED", next: null, checks: 0 };
    await mockApi(context, gate);
    await page.clock.install({ time: T0 });
    await page.goto("/employee/assessments");
    await expect(page.getByRole("heading", { name: "My Assessments" })).toBeVisible();
    gate.status = "ASSESSMENT_REQUIRED"; // Became due while the tab was in the background.
    await page.clock.fastForward(10_000);
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForURL(/\/access\/assessment-required/);
  });
});
