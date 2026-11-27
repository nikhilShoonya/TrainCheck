import { expect, test, type BrowserContext } from "@playwright/test";

/* Training completion > Remove employees: for employees assigned by mistake, even completed ones. The dialog searches by
   name, code or department, selects all matching, needs a reason, sends one request and the rows leave the list.
   The page's completion selection is not affected. All API traffic is mocked with synthetic data; run against an
   isolated frontend with BACKEND_URL on an unused port. */
const TRAINING = "7a1c2e3d-4b5f-4a6b-8c7d-9e0f1a2b3c4d";
const TITLE = "Synthetic product awareness";

function newWorld() {
  const row = (i: number, department: string, tested = false) => ({
    id: `enrolment-${i}`, employee_id: `employee-${i}`, employee_name: `Synthetic ${String(i).padStart(2, "0")}`, employee_code: `E${String(i).padStart(3, "0")}`,
    department, training_id: TRAINING, training_title: TITLE, batch_name: null, assigned_at: "2026-11-27T07:52:00Z", attendance_status: "PRESENT",
    completed_at: "2026-11-27T00:00:00Z", completion_source: "MANUAL", due_at: "2026-11-28T00:00:00Z", assessment_state: tested ? "Submitted" : "Due",
    assessment_issue: null, outcome: tested ? "PASSED" : null, retraining_flag: "NOT_REQUIRED", obligation_id: `obligation-${i}`,
    attempts_used: tested ? 1 : 0, attempts_completed: tested ? 1 : 0, max_attempts: 3, training_cycle: 1, retrainings: 0, retry_action: null, refresher_acknowledged_at: null,
  });
  return {
    removals: [] as { reason: string; enrolment_ids: string[] }[],
    refuse: null as null | { status: number; code: string; message: string },
    rows: [
      row(1, "Human Resource", true), row(2, "Human Resource"),
      row(3, "Synthetic Support"), row(4, "Synthetic Support"), row(5, "Synthetic Support"),
    ],
    unknown: [] as string[],
  };
}

async function mockApi(context: BrowserContext, world: ReturnType<typeof newWorld>) {
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic-test; path=/"; });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data } : data) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "admin-employee", employee_code: "ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false } } });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, next_change_at: null, server_now: new Date().toISOString() });
    if (path === "/admin/trainings") return json([{ id: TRAINING, title: TITLE, training_code: "SYN-1", status: "ACTIVE", description: "Synthetic", assigned_count: world.rows.length, completed_count: world.rows.length, pending_scheduling_count: 0, unavailable_count: 0 }]);
    if (path === "/admin/enrolments") return json(world.rows);
    if (path === `/admin/trainings/${TRAINING}/assignments/remove` && request.method() === "POST") {
      const body = request.postDataJSON();
      world.removals.push(body);
      if (world.refuse) return json({ error: { code: world.refuse.code, message: world.refuse.message } }, world.refuse.status);
      world.rows = world.rows.filter((r) => !body.enrolment_ids.includes(r.id));
      return json({ removed: body.enrolment_ids.length, completions: body.enrolment_ids.length, assessments: body.enrolment_ids.length, attempts: 0, notifications: 0 });
    }
    if (request.method() !== "GET") {
      world.unknown.push(`${request.method()} ${path}`);
      return json({ error: { code: "NOT_MOCKED", message: "Unexpected mutation." } }, 500);
    }
    return json([]);
  });
}

test.describe("Remove employees from a training (mocked API)", () => {
  let world: ReturnType<typeof newWorld>;
  test.beforeEach(async ({ context }) => {
    world = newWorld();
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "no unexpected mutation").toEqual([]);
  });

  test("search by department, select all matching, give a reason, and the rows leave the list", async ({ page }) => {
    await page.goto(`/lnd/completion/${TRAINING}`);
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
    // The header: Remove employees, then Import Attendance. The page's one Back control is at the top.
    await expect(page.getByRole("link", { name: "Back to Trainings" })).toHaveCount(1);
    await page.getByRole("button", { name: "Remove employees", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove employees from this training" });
    await expect(dialog.getByRole("button", { name: "Remove 0 employees" })).toBeDisabled();

    await dialog.getByRole("searchbox", { name: "Search assigned employees" }).fill("synthetic support");
    await expect(dialog.getByRole("checkbox")).toHaveCount(3);
    await dialog.getByRole("button", { name: "Select all matching (3)" }).click();
    await expect(dialog.getByText("3 employees chosen", { exact: true })).toBeVisible();
    await expect(dialog).toContainText("None of them has taken the test.");
    await page.screenshot({ path: "test-results/remove-assignments-dialog.png" });

    // A reason is required.
    await dialog.getByRole("button", { name: "Remove 3 employees" }).click();
    expect(world.removals).toEqual([]);
    await dialog.getByRole("textbox", { name: "Reason *" }).fill("Assigned to this training by mistake");
    await dialog.getByRole("button", { name: "Remove 3 employees" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.removals).toEqual([{ reason: "Assigned to this training by mistake", enrolment_ids: ["enrolment-3", "enrolment-4", "enrolment-5"] }]);
    await expect(page.getByText("3 employees removed from Synthetic product awareness.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Select Synthetic 03 (E003)" })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Select Synthetic 01 (E001)" })).toBeVisible();
  });

  test("an employee who took the test is flagged, Cancel removes nothing, and a refusal is shown", async ({ page }) => {
    await page.goto(`/lnd/completion/${TRAINING}`);
    await page.getByRole("button", { name: "Remove employees", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Remove employees from this training" });
    await dialog.getByRole("checkbox", { name: "Remove Synthetic 01 (E001)" }).check();
    await expect(dialog).toContainText("1 of them has already taken the test");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.removals).toEqual([]);

    world.refuse = { status: 409, code: "ATTEMPT_IN_PROGRESS", message: "1 of these employees is taking this training's test right now. Nothing was removed." };
    await page.getByRole("button", { name: "Remove employees", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Remove employees from this training" });
    await dialog.getByRole("checkbox", { name: "Remove Synthetic 02 (E002)" }).check();
    await dialog.getByRole("textbox", { name: "Reason *" }).fill("Assigned to this training by mistake");
    await dialog.getByRole("button", { name: "Remove 1 employee" }).click();
    await expect(dialog).toContainText("Nothing was removed.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("checkbox", { name: "Select Synthetic 02 (E002)" })).toHaveCount(1);
  });
});
