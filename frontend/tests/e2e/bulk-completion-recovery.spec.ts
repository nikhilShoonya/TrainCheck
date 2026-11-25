import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* Mark Selected Completed / Waive Selected: failure, recovery, keyboard and validation cases.
   All API traffic is mocked (synthetic data only). Run against an isolated frontend whose BACKEND_URL points at an
   unused port, e.g. NEXT_DIST_DIR=.next-e2e PORT=3100 BACKEND_URL=http://127.0.0.1:8199 npm run dev
   and E2E_BASE_URL=http://localhost:3100. The server-side rules are covered by backend/tests/test_bulk_completion_waiver.py. */

const TRAINING = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const TITLE = "Synthetic recovery training";
const url = `/lnd/completion/${TRAINING}`;

/** How the mock answers one enrolment's completion (or one obligation's waiver). */
type Behaviour = "ok" | "500" | "500-after-commit" | "lost" | "lost-after-commit" | "429" | "403" | "401" | "in-progress";

function newWorld(count = 12) {
  return {
    signedOut: false,
    enrolmentReads: 0,
    calls: [] as { id: string; body: { completion_date: string; attendance_status?: string } }[],
    waiverCalls: [] as { id: string; body: { reason: string } }[],
    behaviour: new Map<string, Behaviour>(),
    hold: null as Promise<void> | null,
    rows: Array.from({ length: count }, (_, i) => ({
      id: `enrolment-${i}`, employee_id: `employee-${i}`, employee_name: `Synthetic ${String(i + 1).padStart(2, "0")}`, employee_code: `E${String(i + 1).padStart(3, "0")}`,
      department: "Synthetic department", training_id: TRAINING, training_title: TITLE, batch_name: null,
      assigned_at: "2026-11-01T00:00:00Z", attendance_status: "PENDING", completed_at: null as string | null, completion_source: null as string | null,
      due_at: null as string | null, assessment_state: "Awaiting completion", assessment_issue: null, outcome: null as string | null,
      retraining_flag: "NOT_REQUIRED", obligation_id: null as string | null, attempts_used: 0, max_attempts: null, retrainings: 0, refresher_acknowledged_at: null,
    })),
  };
}
type World = ReturnType<typeof newWorld>;

function completedWorld(count = 12) {
  const world = newWorld(count);
  for (const [i, row] of world.rows.entries()) Object.assign(row, { completed_at: "2026-11-19T00:00:00Z", completion_source: "MANUAL", attendance_status: "PRESENT", obligation_id: `obligation-${i}`, assessment_state: "Due", due_at: "2026-11-20T00:00:00Z" });
  return world;
}

const error = (route: Route, status: number, code: string, message: string) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message } }) });

async function mockApi(context: BrowserContext, world: World) {
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic-test; path=/"; });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    if (path === "/auth/me") {
      if (world.signedOut) return error(route, 401, "UNAUTHENTICATED", "Please sign in again.");
      return json({ user: { id: "synthetic-admin", employee_id: "admin-employee", employee_code: "ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false } } });
    }
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, next_change_at: null, server_now: new Date().toISOString() });
    if (path === "/admin/trainings") return json([{ id: TRAINING, title: TITLE, training_code: "SYNTHETIC", status: "ACTIVE", description: "Synthetic test only", assigned_count: world.rows.length, completed_count: world.rows.filter((r) => r.completed_at).length, pending_scheduling_count: 0, unavailable_count: 0 }]);
    if (path === "/admin/enrolments") {
      world.enrolmentReads++;
      return json(structuredClone(world.rows));
    }
    const completion = /^\/admin\/enrolments\/([^/]+)\/completion$/.exec(path);
    const waiver = /^\/admin\/obligations\/([^/]+)\/waive$/.exec(path);
    if ((completion || waiver) && request.method() === "POST") {
      const id = (completion ?? waiver)![1];
      if (completion) world.calls.push({ id, body: request.postDataJSON() });
      else world.waiverCalls.push({ id, body: request.postDataJSON() });
      if (world.hold) await world.hold;
      const behaviour = world.behaviour.get(id) ?? "ok";
      const row = world.rows.find((r) => (completion ? r.id : r.obligation_id) === id)!;
      const commit = () => {
        if (completion) {
          if (row.completed_at) return false;
          const body = request.postDataJSON();
          Object.assign(row, { completed_at: `${body.completion_date}T00:00:00Z`, completion_source: "MANUAL", attendance_status: body.attendance_status ?? (row.attendance_status === "PENDING" ? "PRESENT" : row.attendance_status), assessment_state: "Due", obligation_id: `obligation-${row.id}`, due_at: `${body.completion_date}T00:00:00Z` });
        } else {
          if (["Waived", "Submitted", "In progress"].includes(row.assessment_state)) return false;
          row.assessment_state = "Waived";
        }
        return true;
      };
      if (behaviour === "500") return error(route, 500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
      if (behaviour === "500-after-commit") { commit(); return error(route, 500, "INTERNAL_ERROR", "Something went wrong. Please try again."); }
      if (behaviour === "lost") return route.abort("connectionreset");
      if (behaviour === "lost-after-commit") { commit(); return route.abort("connectionreset"); }
      if (behaviour === "429") return error(route, 429, "RATE_LIMITED", "Too many requests. Please wait a moment.");
      if (behaviour === "403") return error(route, 403, "FORBIDDEN", "You do not have permission to do this.");
      if (behaviour === "401") { world.signedOut = true; return error(route, 401, "UNAUTHENTICATED", "Please sign in again."); }
      if (behaviour === "in-progress") { row.assessment_state = "In progress"; return error(route, 409, "ATTEMPT_IN_PROGRESS", "An attempt is in progress. Wait for it to finish."); }
      if (!commit()) return completion ? error(route, 409, "COMPLETION_EXISTS", "Completion is already recorded.") : error(route, 409, "OBLIGATION_CLOSED", "This assessment is already closed.");
      return json(completion ? { ...row, assessment_scheduling: { status: "SCHEDULED", reason: null, message: "Assessment scheduled.", action: null, due_at: row.due_at } } : { status: "WAIVED" });
    }
    if (request.method() !== "GET") return error(route, 500, "NOT_MOCKED", "Unexpected mutation.");
    return json([]);
  });
}

const rowFor = (page: Page, name: string) => page.locator("tbody tr").filter({ hasText: name });
const selectedText = (page: Page, n: number) => page.getByText(`${n} ${n === 1 ? "employee" : "employees"} selected`, { exact: true });
const completedMetric = (page: Page) => page.locator(".metrics > div").filter({ has: page.locator("span", { hasText: /^Completion recorded$/ }) }).locator("strong");

async function open(page: Page, context: BrowserContext, world: World) {
  await mockApi(context, world);
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
}

async function confirmCompletion(page: Page) {
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await dialog.getByRole("button", { name: "Confirm completion", exact: true }).click();
  return dialog;
}

/** Every row is visible on one page when the table has 10 or fewer rows. */
async function statusOf(page: Page, name: string) {
  return (await rowFor(page, name).locator("td").nth(1).innerText()).trim();
}

test("a server error mid-batch keeps the saved employees, flags the rest, never retries, and a retry skips saved rows", async ({ context, page }) => {
  const world = newWorld(8);
  world.behaviour.set("enrolment-4", "500");
  await open(page, context, world);
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await expect(selectedText(page, 8)).toBeVisible();
  const dialog = await confirmCompletion(page);
  await expect(dialog).toBeHidden();

  const firstIds = world.calls.map((c) => c.id);
  expect(new Set(firstIds).size).toBe(firstIds.length); // No automatic retry of anything.
  expect(firstIds).toContain("enrolment-4");
  expect(firstIds.length).toBeLessThan(8); // Unsent rows were stopped.
  const saved = world.rows.filter((r) => r.completed_at).map((r) => r.employee_name);
  for (const name of saved) await expect(rowFor(page, name).locator("td").nth(1)).toContainText("Completed");
  await expect(rowFor(page, "Synthetic 05").getByRole("alert")).toContainText("server may have recorded completion");
  for (const r of world.rows.filter((row) => !row.completed_at && row.id !== "enrolment-4")) {
    await expect(rowFor(page, r.employee_name).getByRole("alert")).toContainText("Not attempted");
  }
  await expect(completedMetric(page)).toHaveText(String(saved.length));
  await expect(page.locator("#toast")).toContainText(`${saved.length} completions recorded. ${8 - saved.length} not confirmed`);
  await expect(selectedText(page, 8 - saved.length)).toBeVisible(); // Only the unconfirmed rows stay selected.

  // Refresh as instructed, then retry: only the unconfirmed employees are sent again.
  world.behaviour.clear();
  await page.reload();
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const retry = page.getByRole("dialog", { name: "Complete selected employees" });
  await expect(retry.getByRole("listitem")).toHaveCount(8 - saved.length);
  await retry.getByRole("button", { name: "Confirm completion", exact: true }).click();
  await expect(retry).toBeHidden();
  const retried = world.calls.slice(firstIds.length).map((c) => c.id);
  expect(retried.sort()).toEqual(world.rows.filter((r) => !firstIds.includes(r.id) || r.id === "enrolment-4").map((r) => r.id).sort());
  await expect(completedMetric(page)).toHaveText("8");
});

for (const behaviour of ["500-after-commit", "lost-after-commit"] as const) {
  test(`an uncertain outcome (${behaviour}) is shown as unconfirmed, and the reload reveals the saved completion`, async ({ context, page }) => {
    const world = newWorld(4);
    world.behaviour.set("enrolment-0", behaviour);
    await open(page, context, world);
    await page.getByRole("checkbox", { name: "Select Synthetic 01 (E001)", exact: true }).check();
    await confirmCompletion(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.calls.map((c) => c.id)).toEqual(["enrolment-0"]);
    // The automatic list refresh after the batch shows what the server actually holds; the warning is not left on a completed row.
    await expect(rowFor(page, "Synthetic 01").locator("td").nth(1)).toContainText("Completed");
    await expect(rowFor(page, "Synthetic 01").getByRole("alert")).toHaveCount(0);
    await expect(page.locator("#toast")).toContainText("0 completions recorded. 1 not confirmed");
    // Retrying without a manual refresh cannot complete it twice: the action is no longer offered for this row.
    await expect(page.getByRole("button", { name: "Mark Selected Completed", exact: true })).toBeDisabled();
    expect(world.calls).toHaveLength(1);
    // Observation: the row stays selected (it is now waiver-eligible), so Waive Selected would include it.
    await expect(selectedText(page, 1)).toBeVisible();
  });
}

for (const behaviour of ["429", "403", "lost"] as const) {
  test(`${behaviour} stops unsent completions and waivers without retrying`, async ({ context, page }) => {
    const world = newWorld(8); // One table page (8 rows), so every row's message is visible.
    world.behaviour.set("enrolment-0", behaviour);
    await open(page, context, world);
    await page.getByRole("button", { name: "Select All", exact: true }).click();
    await confirmCompletion(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.calls.length).toBeLessThanOrEqual(3); // Only requests already in flight when the refusal arrived.
    expect(new Set(world.calls.map((c) => c.id)).size).toBe(world.calls.length);
    const notAttempted = world.rows.filter((r) => !world.calls.some((c) => c.id === r.id));
    expect(notAttempted.length).toBeGreaterThanOrEqual(5);
    for (const r of notAttempted) await expect(rowFor(page, r.employee_name).getByRole("alert")).toContainText("Not attempted");
    await expect(rowFor(page, "Synthetic 01").getByRole("alert")).toBeVisible();

    const waivers = completedWorld(4);
    waivers.behaviour.set("obligation-0", behaviour);
    const second = await context.newPage();
    world.rows = waivers.rows;
    world.behaviour = waivers.behaviour;
    await second.goto(url);
    await second.getByRole("button", { name: "Select All", exact: true }).click();
    await second.getByRole("button", { name: "Waive Selected", exact: true }).click();
    const dialog = second.getByRole("dialog", { name: "Waive selected assessments" });
    await dialog.getByLabel("Reason *", { exact: true }).fill("Approved synthetic exemption");
    await dialog.getByRole("button", { name: "Confirm waiver", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(world.waiverCalls.map((c) => c.id)).toEqual(["obligation-0"]); // Sequential: nothing after the stop.
    for (const name of ["Synthetic 02", "Synthetic 03", "Synthetic 04"]) await expect(rowFor(second, name).getByRole("alert")).toContainText("Not attempted");
  });
}

test("session expiry mid-batch sends the user to sign in and no further requests are sent", async ({ context, page }) => {
  const world = newWorld(9);
  world.behaviour.set("enrolment-0", "401");
  await open(page, context, world);
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await confirmCompletion(page);
  await page.waitForURL(/\/login/);
  const sent = world.calls.length;
  expect(sent).toBeLessThanOrEqual(3);
  await page.waitForTimeout(1000);
  expect(world.calls.length).toBe(sent);
});

test("leaving the page during a batch prevents the queued requests", async ({ context, page }) => {
  const world = newWorld(9);
  let release!: () => void;
  world.hold = new Promise<void>((resolve) => { release = resolve; });
  await mockApi(context, world);
  await page.goto("/lnd/completion");
  await page.getByRole("link", { name: `View Employees for ${TITLE}` }).click(); // Client-side navigation.
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await confirmCompletion(page);
  await expect.poll(() => world.calls.length).toBe(3);
  await page.evaluate(() => window.history.back()); // Client-side, so the page component unmounts without a reload.
  await expect(page).toHaveURL(/\/lnd\/completion$/);
  release();
  await page.waitForTimeout(1500);
  expect(world.calls).toHaveLength(3);
});

test("double-clicking Confirm sends each employee once", async ({ context, page }) => {
  const world = newWorld(5);
  await open(page, context, world);
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await dialog.getByRole("button", { name: "Confirm completion", exact: true }).dblclick();
  await expect(dialog).toBeHidden();
  expect(world.calls.map((c) => c.id).sort()).toEqual(world.rows.map((r) => r.id).sort());

  const waivers = completedWorld(5);
  world.rows = waivers.rows;
  await page.reload();
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await page.getByRole("button", { name: "Waive Selected", exact: true }).click();
  const waive = page.getByRole("dialog", { name: "Waive selected assessments" });
  await waive.getByLabel("Reason *", { exact: true }).fill("Approved synthetic exemption");
  await waive.getByRole("button", { name: "Confirm waiver", exact: true }).dblclick();
  await expect(waive).toBeHidden();
  expect(world.waiverCalls.map((c) => c.id).sort()).toEqual(world.rows.map((r) => r.obligation_id).sort());
});

test("completion date must be a valid date that is not in the future", async ({ context, page }) => {
  const world = newWorld(3);
  await open(page, context, world);
  await page.getByRole("checkbox", { name: "Select Synthetic 01 (E001)", exact: true }).check();
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  const date = dialog.getByLabel("Completion date *", { exact: true });
  await date.fill("2099-01-01");
  await dialog.getByRole("button", { name: "Confirm completion", exact: true }).click();
  expect(await date.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow)).toBe(true);
  await date.fill("");
  await dialog.getByRole("button", { name: "Confirm completion", exact: true }).click();
  expect(await date.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await expect(dialog).toBeVisible();
  expect(world.calls).toHaveLength(0);
  const bulkMax = await date.getAttribute("max");
  // The single-employee dialog applies the same limits (required, max = today in the organisation timezone).
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(world.calls).toHaveLength(0);
  await page.getByRole("button", { name: "Mark Completed for Synthetic 01", exact: true }).click();
  const singleDate = page.getByRole("dialog", { name: "Record training completion" }).getByLabel("Completion date *", { exact: true });
  expect(bulkMax).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(await singleDate.getAttribute("max")).toBe(bulkMax);
  expect(await singleDate.getAttribute("required")).not.toBeNull();
});

test("waiver reason: empty, whitespace-only and too-short reasons are blocked; long input is capped", async ({ context, page }) => {
  const world = completedWorld(3);
  await open(page, context, world);
  await page.getByRole("checkbox", { name: "Select Synthetic 01 (E001)", exact: true }).check();
  await page.getByRole("button", { name: "Waive Selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Waive selected assessments" });
  const reason = dialog.getByLabel("Reason *", { exact: true });
  const confirm = dialog.getByRole("button", { name: "Confirm waiver", exact: true });
  for (const value of ["", "          ", "  abcd  ", "abcd"]) {
    await reason.fill(value);
    await confirm.click();
    expect(await reason.evaluate((input: HTMLTextAreaElement) => input.validity.valid)).toBe(false);
  }
  expect(world.waiverCalls).toHaveLength(0);
  await reason.fill("z".repeat(1200));
  expect((await reason.inputValue()).length).toBe(1000);
  await reason.fill("   Approved synthetic exemption   ");
  await confirm.click();
  await expect(dialog).toBeHidden();
  expect(world.waiverCalls.map((c) => c.body.reason)).toEqual(["Approved synthetic exemption"]);
});

test("an assessment started after selection is refused, shown on its row, and no longer selectable", async ({ context, page }) => {
  const world = completedWorld(3);
  world.behaviour.set("obligation-1", "in-progress");
  await open(page, context, world);
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await page.getByRole("button", { name: "Waive Selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Waive selected assessments" });
  await dialog.getByLabel("Reason *", { exact: true }).fill("Approved synthetic exemption");
  await dialog.getByRole("button", { name: "Confirm waiver", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(rowFor(page, "Synthetic 01").locator("td").nth(3)).toHaveText("Waived");
  await expect(rowFor(page, "Synthetic 03").locator("td").nth(3)).toHaveText("Waived");
  const running = rowFor(page, "Synthetic 02");
  await expect(running.locator("td").nth(3)).toContainText("In progress");
  await expect(running.getByRole("checkbox")).toBeDisabled();
  await expect(running.locator("td").nth(1)).toContainText("Completed"); // Completion untouched.
  await expect(selectedText(page, 0)).toBeVisible();
});

test("keyboard: checkboxes toggle with Space, dialogs take and trap focus, Escape closes without saving", async ({ context, page }) => {
  const world = completedWorld(3);
  world.rows[2].completed_at = null;
  world.rows[2].obligation_id = null;
  world.rows[2].assessment_state = "Awaiting completion";
  world.rows[2].attendance_status = "PENDING";
  await open(page, context, world);
  const box = page.getByRole("checkbox", { name: "Select Synthetic 03 (E003)", exact: true });
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  await expect(selectedText(page, 1)).toBeVisible();
  const trigger = page.getByRole("button", { name: "Mark Selected Completed", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(world.calls).toHaveLength(0);

  await page.getByRole("button", { name: "Select All", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(selectedText(page, 3)).toBeVisible();
  const waive = page.getByRole("button", { name: "Waive Selected", exact: true });
  await waive.focus();
  await page.keyboard.press("Enter");
  const waiveDialog = page.getByRole("dialog", { name: "Waive selected assessments" });
  await expect(waiveDialog.getByRole("listitem")).toHaveCount(2);
  await expect(waiveDialog).toContainText("1 other selected employee(s)");
  await page.keyboard.press("Escape");
  await expect(waiveDialog).toBeHidden();
  expect(world.waiverCalls).toHaveLength(0);
});

// Known issue (shared Modal, also affects the existing single-row dialogs): closing a dialog leaves focus on <body>
// instead of the button that opened it. Marked as an expected failure so a fix is noticed; remove test.fail() then.
test("closing a selection dialog returns focus to the button that opened it", async ({ context, page }) => {
  test.fail();
  const world = newWorld(3);
  await open(page, context, world);
  await page.getByRole("checkbox", { name: "Select Synthetic 01 (E001)", exact: true }).check();
  const trigger = page.getByRole("button", { name: "Mark Selected Completed", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused({ timeout: 2000 });
});

// Known issue: every successful POST invalidates the cached list (onApiMutation), so a batch of N employees re-reads the
// whole training list about N times (measured 30 reads for 30 completions). Expected failure until fixed.
test("one batch reloads the employee list a bounded number of times", async ({ context, page }) => {
  test.fail();
  const world = newWorld(30);
  await open(page, context, world);
  await page.waitForTimeout(500);
  const before = world.enrolmentReads;
  await page.getByRole("button", { name: "Select All", exact: true }).click();
  await confirmCompletion(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(1500);
  const reads = world.enrolmentReads - before;
  test.info().annotations.push({ type: "enrolment-list-reads", description: `${reads} GET /admin/enrolments for ${world.calls.length} completions` });
  console.log(`enrolment-list-reads: ${reads} for ${world.calls.length} completions`);
  expect(world.calls).toHaveLength(30);
  expect(reads).toBeLessThanOrEqual(3);
});

