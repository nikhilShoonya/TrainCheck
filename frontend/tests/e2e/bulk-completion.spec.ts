import { expect, test, type BrowserContext } from "@playwright/test";

// All API traffic is mocked. Run against an isolated frontend with BACKEND_URL pointing at an unused port.
const TRAINING = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const TITLE = "Synthetic bulk completion training";
const url = `/lnd/completion/${TRAINING}`;

function newWorld() {
  return {
    trainingStatus: "ACTIVE",
    staleReads: false,
    enrolmentReads: 0,
    calls: [] as { id: string; body: { completion_date: string; attendance_status?: string } }[],
    waiverCalls: [] as { id: string; body: { reason: string } }[],
    waiverFailures: new Map<string, { status: number; code: string; message: string }>(),
    failures: new Map<string, string>(),
    unscheduled: new Set<string>(),
    hold: null as Promise<void> | null,
    rows: Array.from({ length: 12 }, (_, i) => ({
      id: `enrolment-${i}`, employee_id: `employee-${i}`, employee_name: `Synthetic ${String(i + 1).padStart(2, "0")}`, employee_code: `E${String(i + 1).padStart(3, "0")}`,
      department: "Synthetic department", training_id: TRAINING, training_title: TITLE, batch_name: null,
      assigned_at: "2026-11-01T00:00:00Z", attendance_status: i === 1 ? "ABSENT" : i === 2 ? "EXCUSED" : i === 3 ? "PARTIAL" : i === 0 ? "PRESENT" : "PENDING",
      completed_at: i === 0 ? "2026-11-19T00:00:00Z" : null as string | null,
      completion_source: i === 0 ? "MANUAL" : null as string | null,
      due_at: null as string | null, assessment_state: i === 0 ? "Submitted" : "Awaiting completion", assessment_issue: null,
      outcome: i === 0 ? "PASSED" : null, retraining_flag: "NOT_REQUIRED", obligation_id: null as string | null,
      attempts_used: 0, max_attempts: null, retrainings: 0, refresher_acknowledged_at: null,
    })),
  };
}

async function mockApi(context: BrowserContext, world: ReturnType<typeof newWorld>) {
  const initialRows = structuredClone(world.rows);
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic-test; path=/"; });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data } : data) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "admin-employee", employee_code: "ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false } } });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, next_change_at: null, server_now: new Date().toISOString() });
    if (path === "/admin/trainings") return json([{ id: TRAINING, title: TITLE, training_code: "SYNTHETIC", status: world.trainingStatus, description: "Synthetic test only", assigned_count: world.rows.length, completed_count: world.rows.filter((row) => row.completed_at).length, pending_scheduling_count: 0, unavailable_count: 0 }]);
    if (path === "/admin/enrolments") {
      world.enrolmentReads++;
      return json(world.staleReads ? initialRows : world.rows);
    }
    const waiver = /^\/admin\/obligations\/([^/]+)\/waive$/.exec(path);
    if (waiver && request.method() === "POST") {
      const id = waiver[1];
      world.waiverCalls.push({ id, body: request.postDataJSON() });
      if (world.hold) await world.hold;
      const failure = world.waiverFailures.get(id);
      if (failure) return json({ error: { code: failure.code, message: failure.message } }, failure.status);
      const row = world.rows.find((entry) => entry.obligation_id === id)!;
      if (["Waived", "Submitted", "In progress"].includes(row.assessment_state)) return json({ error: { code: "OBLIGATION_CLOSED", message: "This assessment cannot be waived." } }, 409);
      row.assessment_state = "Waived";
      return json({ status: "WAIVED" });
    }
    const completion = /^\/admin\/enrolments\/([^/]+)\/completion$/.exec(path);
    if (completion && request.method() === "POST") {
      const id = completion[1];
      const body = request.postDataJSON();
      world.calls.push({ id, body });
      if (world.hold) await world.hold;
      if (world.trainingStatus !== "ACTIVE") return json({ error: { code: "TRAINING_NOT_ACTIVE", message: "Activate this training in Training Management before recording completion." } }, 409);
      const failure = world.failures.get(id);
      if (failure) return json({ error: { code: "ATTENDANCE_NOT_COMPLETABLE", message: failure } }, 409);
      const row = world.rows.find((entry) => entry.id === id)!;
      if (row.completed_at) return json({ error: { code: "COMPLETION_EXISTS", message: "Completion already recorded." } }, 409);
      row.completed_at = `${body.completion_date}T00:00:00Z`;
      row.completion_source = "MANUAL";
      row.attendance_status = body.attendance_status ?? (row.attendance_status === "PENDING" ? "PRESENT" : row.attendance_status);
      row.assessment_state = world.unscheduled.has(id) ? "Not scheduled" : "Due";
      row.due_at = world.unscheduled.has(id) ? null : row.completed_at;
      return json({ ...row, assessment_scheduling: { status: world.unscheduled.has(id) ? "NOT_SCHEDULED" : "SCHEDULED", message: world.unscheduled.has(id) ? "Add questions before scheduling this assessment." : "Assessment scheduled.", action: null } });
    }
    if (request.method() !== "GET") return json({ error: { code: "NOT_MOCKED", message: "Unexpected mutation." } }, 500);
    return json([]);
  });
}

test("Select All respects incomplete attendance, includes other pages, and search clears selection", async ({ context, page }) => {
  const world = newWorld();
  await mockApi(context, world);
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  for (const i of [0, 1, 2]) await expect(page.getByRole("checkbox", { name: `Select ${world.rows[i].employee_name} (${world.rows[i].employee_code})`, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await expect(page.getByText("9 employees selected", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/bulk-completion-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select Synthetic 12 (E012)", exact: true })).toBeChecked();
  await page.getByRole("searchbox", { name: "Search employees" }).fill("E012");
  await expect(page.getByText("0 employees selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await expect(dialog.getByRole("list", { name: "Selected employees" }).getByRole("listitem")).toHaveCount(1);
  await expect(dialog).toContainText("Synthetic 12 (E012)");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(world.calls).toHaveLength(0);
  // The individual action is still available and opens the existing dialog.
  await page.getByRole("button", { name: "Mark Completed for Synthetic 12", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Record training completion" })).toBeVisible();
});

function waiverWorld() {
  const world = newWorld();
  for (const [index, row] of world.rows.entries()) {
    row.completed_at = "2026-11-19T00:00:00Z";
    row.attendance_status = "PRESENT";
    row.obligation_id = `obligation-${index}`;
    row.assessment_state = index === 0 ? "Submitted" : index === 1 ? "In progress" : index === 2 ? "Waived" : "Due";
  }
  return world;
}

test("select all waives eligible assessments across pages with one required reason and immediate row updates", async ({ context, page }) => {
  const world = waiverWorld();
  let release!: () => void;
  world.hold = new Promise<void>((resolve) => { release = resolve; });
  await mockApi(context, world);
  await page.goto(url);
  for (const i of [0, 1, 2]) await expect(page.getByRole("checkbox", { name: `Select ${world.rows[i].employee_name} (${world.rows[i].employee_code})`, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await expect(page.getByText("9 employees selected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark Selected Completed", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Waive Selected", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Waive selected assessments" });
  await expect(dialog.getByRole("listitem")).toHaveCount(9);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(world.waiverCalls).toHaveLength(0);
  await page.getByRole("button", { name: "Waive Selected", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Waive selected assessments" });
  await dialog.getByRole("button", { name: "Confirm waiver", exact: true }).click();
  expect(world.waiverCalls).toHaveLength(0);
  await dialog.getByLabel("Reason *", { exact: true }).fill("Approved exemption for this training");
  world.staleReads = true;
  await dialog.getByRole("button", { name: "Confirm waiver", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Waiving assessments…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("0 employees selected", { exact: true })).toBeVisible();
  const row = page.locator("tbody tr").filter({ hasText: "Synthetic 05" });
  await expect(row.locator("td").nth(3)).toHaveText("Waived");
  await expect(row.locator("td").nth(1)).toContainText("Completed");
  await expect(row.locator("td").nth(6)).toHaveText("Pending");
  await expect(row.getByRole("checkbox")).toBeDisabled();
  await expect(page.locator(".metrics")).toHaveCount(1);
  expect(world.waiverCalls).toHaveLength(9);
  expect(new Set(world.waiverCalls.map((call) => call.id)).size).toBe(9);
  expect(world.waiverCalls.every((call) => call.body.reason === "Approved exemption for this training")).toBe(true);
  expect(world.calls).toHaveLength(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 12" }).locator("td").nth(3)).toHaveText("Waived");
  await page.screenshot({ path: "test-results/waive-selected-updated.png", fullPage: true });
  world.staleReads = false;
  await page.reload();
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 05" }).locator("td").nth(3)).toHaveText("Waived");
});

test("mixed selection scopes each action and waiver failures remain on their employee row", async ({ context, page }) => {
  const world = waiverWorld();
  world.rows[5].completed_at = null;
  world.rows[5].obligation_id = null;
  world.rows[5].assessment_state = "Awaiting completion";
  world.waiverFailures.set("obligation-4", { status: 409, code: "ATTEMPT_IN_PROGRESS", message: "An attempt is in progress. Wait for it to finish." });
  await mockApi(context, world);
  await page.goto(url);
  for (const i of [3, 4, 5]) await page.getByRole("checkbox", { name: `Select ${world.rows[i].employee_name} (${world.rows[i].employee_code})`, exact: true }).check();
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const completionDialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await expect(completionDialog.getByRole("listitem")).toHaveCount(1);
  await expect(completionDialog).toContainText("2 other selected employee(s)");
  await completionDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Waive Selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Waive selected assessments" });
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog).toContainText("1 other selected employee(s)");
  await dialog.getByLabel("Reason *", { exact: true }).fill("Approved waiver by L&D");
  await dialog.getByRole("button", { name: "Confirm waiver", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 04" }).locator("td").nth(3)).toContainText("Waived");
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 05" }).getByRole("alert")).toContainText("An attempt is in progress");
  await expect(page.getByText("2 employees selected", { exact: true })).toBeVisible();
  expect(world.waiverCalls.map((call) => call.id)).toEqual(["obligation-3", "obligation-4"]);
  expect(world.rows[5].completed_at).toBeNull();
});

test("individual Waive still works and refreshes the same employee row", async ({ context, page }) => {
  const world = waiverWorld();
  await mockApi(context, world);
  await page.goto(url);
  const row = page.locator("tbody tr").filter({ hasText: "Synthetic 05" });
  await row.getByRole("button", { name: "Waive assessment for Synthetic 05", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Waive this assessment?" });
  await dialog.getByLabel("Reason *", { exact: true }).fill("Authorised training exemption");
  world.staleReads = true;
  await dialog.getByRole("button", { name: "Waive assessment", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.locator("td").nth(3)).toHaveText("Waived");
  expect(world.waiverCalls).toHaveLength(1);
});

for (const status of ["DRAFT", "ARCHIVED"]) {
  test(`selection remains usable for ${status} training and server refusals are displayed`, async ({ context, page }) => {
    const world = newWorld();
    world.trainingStatus = status;
    await mockApi(context, world);
    await page.goto(url);
    const checkbox = page.getByRole("checkbox", { name: "Select Synthetic 05 (E005)", exact: true });
    await checkbox.check();
    await expect(page.getByText("1 employee selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await page.getByRole("button", { name: "Select All", exact: true }).click();
    await expect(page.getByText("9 employees selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
    await page.getByRole("dialog", { name: "Complete selected employees" }).getByRole("button", { name: "Confirm completion", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Complete selected employees" })).toBeHidden();
    await expect(page.locator(".metrics")).toHaveCount(1);
    const row = page.locator("tbody tr").filter({ hasText: "Synthetic 05" });
    await expect(row.getByRole("alert")).toContainText("Activate this training in Training Management before recording completion.");
    await expect(row.locator("td").nth(1)).toContainText("Awaiting completion");
    expect(world.rows.filter((row) => row.completed_at)).toHaveLength(1);
    expect(world.calls).toHaveLength(9);
  });
}

test("bulk confirmation uses the shared date, preserves recorded attendance, reports refusals and unscheduled assessments", async ({ context, page }) => {
  const world = newWorld();
  world.failures.set("enrolment-3", "Partial attendance does not count under the current policy.");
  world.unscheduled.add("enrolment-4");
  let release!: () => void;
  world.hold = new Promise<void>((resolve) => { release = resolve; });
  await mockApi(context, world);
  await page.goto(url);
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await dialog.getByLabel("Completion date *", { exact: true }).fill("2026-11-18");
  await expect(dialog.getByRole("combobox", { name: "Attendance", exact: true })).toHaveCount(0); // Attendance is not changed here.
  await dialog.getByRole("button", { name: "Confirm completion", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Recording completion…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Bulk completion result" })).toHaveCount(0);
  await expect(page.locator(".metrics")).toHaveCount(1);
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 04" }).getByRole("alert")).toContainText("Partial attendance does not count under the current policy.");
  const unscheduled = page.locator("tbody tr").filter({ hasText: "Synthetic 05" });
  await expect(unscheduled.locator("td").nth(1)).toContainText("Completed");
  await expect(unscheduled.locator("td").nth(3)).toContainText("Not scheduled");
  await expect(page.locator(".metrics > div").filter({ has: page.locator("span", { hasText: /^Completion recorded$/ }) }).locator("strong")).toHaveText("9");
  expect(world.calls).toHaveLength(9);
  expect(new Set(world.calls.map((call) => call.id)).size).toBe(9);
  expect(world.calls.every((call) => call.body.completion_date === "2026-11-18" && !("attendance_status" in call.body))).toBe(true);
  expect(world.rows[1].completed_at).toBeNull();
  expect(world.rows[2].completed_at).toBeNull();
  await expect(page.getByRole("checkbox", { name: "Select Synthetic 05 (E005)", exact: true })).toBeDisabled();
  await expect(page.getByText("1 employee selected", { exact: true })).toBeVisible();
});

test("individual selection works at phone size and keeps each recorded attendance", async ({ context, page }) => {
  const world = newWorld();
  await mockApi(context, world);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.getByRole("checkbox", { name: "Select Synthetic 04 (E004)", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select Synthetic 05 (E005)", exact: true }).check();
  await expect(page.getByText("2 employees selected", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/bulk-completion-phone.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await dialog.getByRole("button", { name: "Confirm completion", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".metrics")).toHaveCount(1);
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 05" }).locator("td").nth(1)).toContainText("Completed");
  expect(world.calls).toHaveLength(2);
  expect(world.calls.every((call) => !("attendance_status" in call.body))).toBe(true);
});

test("bulk completion immediately updates rows and counts even when a background read returns older data", async ({ context, page }) => {
  const world = newWorld();
  await mockApi(context, world);
  await page.goto(url);
  await page.getByRole("checkbox", { name: "Select Synthetic 04 (E004)", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select Synthetic 05 (E005)", exact: true }).check();
  world.staleReads = true;
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  await page.getByRole("dialog", { name: "Complete selected employees" }).getByRole("button", { name: "Confirm completion", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Complete selected employees" })).toBeHidden();
  await expect(page.locator(".metrics")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Bulk completion result" })).toHaveCount(0);
  await expect.poll(() => world.enrolmentReads).toBeGreaterThan(1);
  const row = page.locator("tbody tr").filter({ hasText: "Synthetic 05" });
  await expect(row.getByRole("checkbox")).toBeDisabled();
  await expect(row.locator("td").nth(1)).toContainText("Completed");
  await expect(row.getByRole("button", { name: "Mark Completed for Synthetic 05", exact: true })).toHaveCount(0);
  await expect(row.locator("td").nth(6)).toContainText("Pending"); // Training completion never claims an assessment pass.
  await expect(page.locator(".metrics > div").filter({ has: page.locator("span", { hasText: /^Completion recorded$/ }) }).locator("strong")).toHaveText("3");
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 06" }).locator("td").nth(1)).toContainText("Awaiting completion");
  await page.screenshot({ path: "test-results/completion-status-updated.png", fullPage: true });
  world.staleReads = false;
  await page.reload();
  await expect(page.locator("tbody tr").filter({ hasText: "Synthetic 05" }).locator("td").nth(1)).toContainText("Completed");
});

test("single completion stays visible across an older background read and a later page refresh", async ({ context, page }) => {
  const world = newWorld();
  await mockApi(context, world);
  await page.goto(url);
  const row = page.locator("tbody tr").filter({ hasText: "Synthetic 05" });
  await row.getByRole("button", { name: "Mark Completed for Synthetic 05", exact: true }).click();
  world.staleReads = true;
  const dialog = page.getByRole("dialog", { name: "Record training completion" });
  await dialog.getByRole("button", { name: "Record completion", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => world.enrolmentReads).toBeGreaterThan(1);
  await expect(row.getByRole("checkbox")).toBeDisabled();
  await expect(row.locator("td").nth(1)).toContainText("Completed");
  expect(world.calls[0].body).toEqual({ completion_date: expect.any(String) }); // Attendance is not changed here.
  await expect(page.locator(".metrics > div").filter({ has: page.locator("span", { hasText: /^Completion recorded$/ }) }).locator("strong")).toHaveText("2");
  world.staleReads = false;
  await page.reload();
  await expect(row.locator("td").nth(1)).toContainText("Completed");
  expect(world.calls).toHaveLength(1);
});
