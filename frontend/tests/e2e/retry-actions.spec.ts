import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/* Training Completion: the Attempts and Reattempt / Retraining columns (25 Nov 2026).
   All API traffic is mocked with synthetic rows; run against an isolated frontend whose BACKEND_URL is unused. */
const TRAINING = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const TITLE = "Synthetic retry training";
const url = `/lnd/completion/${TRAINING}`;

type Row = ReturnType<typeof row>;

function row(i: number, over: Partial<Record<string, unknown>>) {
  return {
    id: `enrolment-${i}`, employee_id: `employee-${i}`, employee_name: `Synthetic ${String(i + 1).padStart(2, "0")}`, employee_code: `R${String(i + 1).padStart(3, "0")}`,
    department: null, training_id: TRAINING, training_title: TITLE, batch_name: null, assigned_at: "2026-11-01T00:00:00Z", attendance_status: "PRESENT",
    completed_at: "2026-11-20T00:00:00Z" as string | null, completion_source: "MANUAL" as string | null, due_at: "2026-11-20T00:00:00Z" as string | null,
    assessment_state: "Due", assessment_issue: null, outcome: null as string | null, retraining_flag: "NOT_REQUIRED", obligation_id: `obligation-${i}` as string | null,
    attempts_used: 0, attempts_completed: 0, max_attempts: 3, training_cycle: 1, retrainings: 0, retry_action: null as string | null, refresher_acknowledged_at: null,
    ...over,
  };
}

function newWorld() {
  return {
    hold: null as Promise<void> | null,
    approveStatus: 200,
    calls: [] as { path: string; body: unknown }[],
    rows: [
      row(0, { completed_at: null, completion_source: null, due_at: null, assessment_state: "Awaiting completion", obligation_id: null, attendance_status: "PENDING" }),
      row(1, { assessment_state: "Awaiting approval", outcome: "NOT_PASSED", attempts_used: 1, attempts_completed: 1, retry_action: "REATTEMPT" }),
      row(2, { assessment_state: "Due", outcome: "NOT_PASSED", attempts_used: 1, attempts_completed: 1 }),
      row(3, { assessment_state: "In progress", outcome: "NOT_PASSED", attempts_used: 3, attempts_completed: 2 }),
      row(4, { assessment_state: "Submitted", outcome: "NOT_PASSED", retraining_flag: "NEEDS_RETRAINING", attempts_used: 3, attempts_completed: 3, retry_action: "RETRAINING" }),
      row(5, { assessment_state: "Submitted", outcome: "PASSED", attempts_used: 1, attempts_completed: 1 }),
    ] as Row[],
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
    if (path === "/admin/trainings") return json([{ id: TRAINING, title: TITLE, training_code: "SYNTHETIC-RETRY", status: "ACTIVE", description: "Synthetic test only", assigned_count: world.rows.length, completed_count: world.rows.filter((r) => r.completed_at).length, pending_scheduling_count: 0, unavailable_count: 0 }]);
    if (path === "/admin/enrolments") return json(world.rows);
    const retake = /^\/admin\/obligations\/([^/]+)\/approve-retake$/.exec(path);
    if (retake && request.method() === "POST") {
      world.calls.push({ path, body: null });
      if (world.hold) await world.hold;
      if (world.approveStatus !== 200) return json({ error: { code: "NO_RETAKE_PENDING", message: "A re-attempt is already authorised or in progress for this employee." } }, world.approveStatus);
      Object.assign(world.rows.find((r) => r.obligation_id === retake[1])!, { assessment_state: "Due", retry_action: null });
      return json({ status: "DUE" });
    }
    const retraining = /^\/admin\/obligations\/([^/]+)\/retraining-cycle$/.exec(path);
    if (retraining && request.method() === "POST") {
      world.calls.push({ path, body: request.postDataJSON() });
      const target = world.rows.find((r) => r.obligation_id === retraining[1])!;
      Object.assign(target, { completed_at: null, completion_source: null, due_at: null, assessment_state: "Awaiting completion", outcome: null, retraining_flag: "NOT_REQUIRED", obligation_id: null, attempts_used: 0, attempts_completed: 0, training_cycle: 2, retrainings: 1, retry_action: null, attendance_status: "PENDING" });
      return json({ ...target });
    }
    if (request.method() !== "GET") return json({ error: { code: "NOT_MOCKED", message: `Unexpected ${request.method()} ${path}` } }, 500);
    return json([]);
  });
}

const rowFor = (page: Page, name: string) => page.locator("tbody tr").filter({ hasText: name });
const cell = (page: Page, name: string, index: number) => rowFor(page, name).locator("td").nth(index);
const ATTEMPTS = 6;
const RETRY = 7;

test("Attempts and Reattempt / Retraining are the last two columns and follow each employee's state", async ({ context, page }) => {
  await mockApi(context, newWorld());
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page.locator("table").getByRole("columnheader")).toHaveText(["Employee", "Completion", "Assessment Due", "Assessment", "Result", "", "Attempts", "Reattempt / Retraining"]);
  await expect(page.getByRole("combobox", { name: /^Attendance for / })).toHaveCount(0);
  const expected: [string, string, string][] = [
    ["Synthetic 01", "0/3", "—"],
    ["Synthetic 02", "1/3", "Reattempt"],
    ["Synthetic 03", "1/3", "Reattempt authorised"],
    ["Synthetic 04", "2/3", "Attempt in progress"],
    ["Synthetic 05", "3/3", "Retraining"],
    ["Synthetic 06", "1/3", "—"],
  ];
  for (const [name, attempts, action] of expected) {
    await expect(cell(page, name, ATTEMPTS)).toHaveText(attempts);
    await expect(cell(page, name, RETRY)).toContainText(action);
  }
  await expect(page.getByRole("button", { name: /^Reattempt for / })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Retraining for / })).toHaveCount(1);
  await page.screenshot({ path: "test-results/retry-actions-desktop.png", fullPage: true });
});

test("Reattempt authorises once, keeps the dialog busy until the row refreshes, and never sends a second request", async ({ context, page }) => {
  const world = newWorld();
  let release!: () => void;
  world.hold = new Promise<void>((resolve) => { release = resolve; });
  await mockApi(context, world);
  await page.goto(url);
  await page.getByRole("button", { name: "Reattempt for Synthetic 02", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Authorise a reattempt?" });
  await expect(dialog).toContainText("Attempt 1 of 3 was not passed");
  const confirm = dialog.getByRole("button", { name: "Authorise reattempt", exact: true });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await confirm.click({ force: true }); // A second click while the first is pending does nothing.
  release();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Reattempt authorised for Synthetic 02. The employee has been notified.")).toBeVisible();
  await expect(cell(page, "Synthetic 02", RETRY)).toHaveText("Reattempt authorised");
  await expect(cell(page, "Synthetic 02", ATTEMPTS)).toHaveText("1/3"); // Authorising does not count an attempt.
  expect(world.calls.filter((c) => c.path.endsWith("/approve-retake"))).toHaveLength(1);
});

test("a refused Reattempt shows the server's reason in the dialog", async ({ context, page }) => {
  const world = newWorld();
  world.approveStatus = 409;
  await mockApi(context, world);
  await page.goto(url);
  await page.getByRole("button", { name: "Reattempt for Synthetic 02", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Authorise a reattempt?" });
  await dialog.getByRole("button", { name: "Authorise reattempt", exact: true }).click();
  await expect(dialog).toContainText("A re-attempt is already authorised or in progress for this employee.");
  await expect(dialog.getByRole("button", { name: "Authorise reattempt", exact: true })).toBeEnabled();
});

test("Retraining needs a reason and returns the employee to awaiting completion with 0/3", async ({ context, page }) => {
  const world = newWorld();
  await mockApi(context, world);
  await page.goto(url);
  await page.getByRole("button", { name: "Retraining for Synthetic 05", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Assign retraining?" });
  await expect(dialog).toContainText("All 3 attempts were used");
  await dialog.getByRole("button", { name: "Assign retraining", exact: true }).click();
  expect(world.calls).toHaveLength(0); // The reason is required.
  await dialog.getByLabel("Reason *").fill("Attended the refresher workshop");
  await dialog.getByRole("button", { name: "Assign retraining", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Retraining assigned to Synthetic 05.", { exact: false })).toBeVisible();
  expect(world.calls).toEqual([{ path: "/admin/obligations/obligation-4/retraining-cycle", body: { reason: "Attended the refresher workshop" } }]);
  await expect(cell(page, "Synthetic 05", 1)).toContainText("Awaiting completion");
  await expect(cell(page, "Synthetic 05", ATTEMPTS)).toHaveText("0/3");
  await expect(cell(page, "Synthetic 05", RETRY)).toHaveText("—");
  await expect(page.getByRole("button", { name: "Mark Completed for Synthetic 05", exact: true })).toBeVisible();
});

test("the completion dialog no longer changes attendance", async ({ context, page }) => {
  await mockApi(context, newWorld());
  await page.goto(url);
  await page.getByRole("button", { name: "Mark Completed for Synthetic 01", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Record training completion" });
  await expect(dialog.getByLabel("Completion date *")).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});
