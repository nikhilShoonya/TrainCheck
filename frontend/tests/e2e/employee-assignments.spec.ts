import { expect, test, type Locator, type Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

/* Employee Assignments: the employee list (from employee records, one row each) and the selected employee's
   assignments, opened by ID in the address. Synthetic demo data only. */

const tag = String(Date.now()).slice(-6);
const listPanel = (page: Page) => page.getByRole("region", { name: "Employees" });
const trainingsPanel = (page: Page) => page.locator('section[aria-label$="trainings"]');
// A summary card's number. Anchored, so "Assigned" does not also match "Already assigned".
const metric = (panel: Locator, label: string) => panel.locator(".metrics > div", { hasText: new RegExp(`^${label}`) }).locator("strong");

async function openList(page: Page) {
  await page.goto("/lnd/assignments");
  await expect(listPanel(page).locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
}

async function search(page: Page, text: string) {
  await listPanel(page).getByLabel("Search").fill(text);
}

test("the list shows each employee once, and opening one shows only their assignments", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await openList(page);
  await expect(listPanel(page).locator("thead th")).toHaveText(["Name", "Employee ID", "Email", "Department"]);
  // The old all-assignments table is gone from the first view.
  await expect(page.getByRole("button", { name: "Sort by Training / Batch" })).toHaveCount(0);

  // Aarav Mehta (E001) has several assignments but appears once; search works by email too.
  await search(page, "employee@traincheck.demo");
  await expect(listPanel(page).locator("tbody tr")).toHaveCount(1);
  await expect(listPanel(page).locator("tbody tr")).toContainText("E001");

  // Clicking the row (not just the name) opens the employee by ID.
  await listPanel(page).locator("tbody tr td").nth(2).click();
  await expect(page).toHaveURL(/\?employee=[0-9a-f-]{36}&search=employee%40traincheck\.demo$/);
  await expect(listPanel(page)).toBeHidden();
  const header = page.getByRole("region", { name: "Selected employee" });
  await expect(header.getByRole("heading", { name: "Aarav Mehta" })).toBeVisible();
  await expect(header.locator(".detail-grid")).toContainText("E001");
  await expect(header.locator(".detail-grid")).toContainText("employee@traincheck.demo");
  await expect(header.locator(".detail-grid")).toContainText("Operations");

  const trainings = trainingsPanel(page);
  await expect(trainings.locator("thead th")).toHaveText(["Employee", "Training / Batch", "Assigned", "Completion", "Assessment", "Attempts", "Re-trainings", "Result", ""]);
  const rows = trainings.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  const assigned = Number(await metric(trainings, "Assigned").textContent());
  const completed = Number(await metric(trainings, "Completed").textContent());
  const pending = Number(await metric(trainings, "Awaiting completion").textContent());
  expect(assigned).toBeGreaterThan(1);
  expect(pending + completed).toBe(assigned);
  // Every row is this employee's. (Eight rows per page.)
  await expect(rows).toHaveCount(Math.min(assigned, 8));
  for (const cell of await rows.locator("td:first-child").all()) await expect(cell).toContainText("E001");
  // Pending rows offer Cancel; completed rows do not.
  if (pending) await expect(trainings.getByRole("button", { name: "Cancel" }).first()).toBeVisible();

  // The Stage filter narrows this employee's rows; the cards keep counting all of them.
  await trainings.getByLabel("Stage").selectOption({ label: "Completed" });
  await trainings.getByRole("button", { name: "Apply filters" }).click();
  await expect(rows).toHaveCount(Math.min(completed, 8));
  await expect(trainings.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(metric(trainings, "Assigned")).toHaveText(String(assigned));

  // An ID that names nobody is not found; a name is never used to select.
  await page.goto("/lnd/assignments?employee=Aarav%20Mehta");
  await expect(page.getByText("Employee not found.")).toBeVisible();
});

test("Back to Employees keeps the search, the table page and the scroll position", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.setViewportSize({ width: 1280, height: 600 });
  await openList(page);
  await search(page, "@");
  await expect(page).toHaveURL(/search=%40/);
  const pager = listPanel(page).locator(".table-pagination");
  await expect(pager).toContainText("Page 1 of");
  await pager.getByRole("button", { name: "Next" }).click();
  await expect(pager).toContainText("Page 2 of");
  const firstOnPage2 = (await listPanel(page).locator("tbody tr").first().locator("td").nth(1).textContent())!.trim();
  await pager.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);

  await listPanel(page).locator("tbody tr").first().getByRole("button").click();
  await expect(page.getByRole("region", { name: "Selected employee" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Employees" }).click();
  await expect(listPanel(page)).toBeVisible();
  await expect(listPanel(page).getByLabel("Search")).toHaveValue("@");
  await expect(pager).toContainText("Page 2 of");
  await expect(listPanel(page).locator("tbody tr").first().locator("td").nth(1)).toHaveText(firstOnPage2);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolled);

  // The browser's own Back and Forward work the same way.
  await listPanel(page).locator("tbody tr").first().getByRole("button").click();
  await expect(page.getByRole("region", { name: "Selected employee" })).toBeVisible();
  await page.goBack();
  await expect(listPanel(page)).toBeVisible();
  await expect(pager).toContainText("Page 2 of");
  await page.goForward();
  await expect(page.getByRole("region", { name: "Selected employee" })).toBeVisible();
});

test("Department and Status filters narrow the list, combine with search and survive Back", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await openList(page);
  const list = listPanel(page);
  await list.locator('select[name="employee_department"]').selectOption({ label: "Human Resources" });
  await expect(page).toHaveURL(/department=Human\+Resources/);
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(list.locator("tbody tr")).toContainText("H001");
  await expect(list.getByRole("status")).toContainText("1 employee of");

  // Search and filters combine: nobody in Human Resources matches E001.
  await search(page, "E001");
  await expect(list.getByText("No employee matches this search and filters.")).toBeVisible();
  await search(page, "");
  await list.locator('select[name="employee_status"]').selectOption({ label: "Inactive" });
  await expect(list.getByText("No employee matches this search and filters.")).toBeVisible();
  await list.locator('select[name="employee_status"]').selectOption({ label: "Active" });
  await expect(list.locator("tbody tr")).toHaveCount(1);

  // Opening an employee and coming back keeps the filters.
  await list.locator("tbody tr").getByRole("button").click();
  await expect(page.getByRole("region", { name: "Selected employee" })).toContainText("H001");
  await page.getByRole("link", { name: "Back to Employees" }).click();
  await expect(list.locator('select[name="employee_department"]')).toHaveValue("Human Resources");
  await expect(list.locator('select[name="employee_status"]')).toHaveValue("active");
  await expect(list.locator("tbody tr")).toHaveCount(1);

  // Clear filters shows everyone again.
  await list.getByRole("button", { name: "Clear filters" }).click();
  await expect(list.locator('select[name="employee_department"]')).toHaveValue("");
  await expect(list.locator("tbody tr")).toHaveCount(8);
});

test("a new employee appears at once, with no training, and assigning or cancelling refreshes their table", async ({ page }) => {
  const code = `0${tag}`;
  await signIn(page, ACCOUNTS.admin);
  await openList(page);
  await search(page, code);
  await expect(listPanel(page).getByText("No employee matches this search and filters.")).toBeVisible();

  // Add Employee: the list refreshes by itself.
  await page.getByRole("button", { name: "Add Employee" }).click();
  await page.getByRole("dialog", { name: "Add employee" }).getByRole("button", { name: /New Employee/ }).click();
  const form = page.getByRole("dialog", { name: "Add employee · New Employee" });
  await form.getByLabel("Full name *").fill(`Kiran Joshi ${tag}`);
  await form.getByLabel("Employee ID *").fill(code);
  await form.getByLabel("Work email *").fill(`kiran.${tag}@example.com`);
  await form.getByLabel("Joining date *").fill("2026-11-19");
  await form.getByLabel("Department *").selectOption({ label: "Operations (OPS)" });
  await form.getByRole("button", { name: "Add employee" }).click();
  await expect(listPanel(page).locator("tbody tr")).toHaveCount(1);
  await expect(listPanel(page).locator("tbody tr")).toContainText(`kiran.${tag}@example.com`);

  // Opening them assigns nothing.
  await listPanel(page).locator("tbody tr").getByRole("button", { name: /Kiran Joshi/ }).click();
  const trainings = trainingsPanel(page);
  await expect(trainings.getByText("No training assigned to this employee yet.")).toBeVisible();
  await expect(metric(trainings, "Assigned")).toHaveText("0");

  // Assign Employees from here: their table refreshes by itself.
  await page.getByRole("button", { name: "Assign Employees" }).click();
  const assign = page.getByRole("dialog", { name: "Assign employees" });
  await assign.getByLabel("Training (active only) *").selectOption({ label: "KYC & AML Compliance" });
  await assign.getByLabel("Find by name, ID, department or function").fill(code);
  await assign.locator(".checkbox-list input[type=checkbox]").first().check();
  await assign.getByRole("button", { name: "Assign selected employees" }).click();
  const outcome = page.getByRole("dialog", { name: "Assignment result" });
  await expect(metric(outcome, "Assigned")).toHaveText("1");
  await outcome.locator(".dialog-actions").getByRole("button", { name: "Close" }).click();
  await expect(trainings.locator("tbody tr")).toHaveCount(1);
  await expect(trainings.locator("tbody tr")).toContainText("KYC & AML Compliance");
  await expect(metric(trainings, "Assigned")).toHaveText("1");
  await expect(metric(trainings, "Awaiting completion")).toHaveText("1");

  // Cancel (existing action, unchanged rules): the cancelled assignment leaves the table.
  await trainings.getByRole("button", { name: "Cancel" }).click();
  const confirm = page.getByRole("dialog", { name: "Cancel this assignment?" });
  await confirm.getByLabel("Reason *").fill("Assigned by mistake in a test");
  await confirm.getByRole("button", { name: "Cancel assignment" }).click();
  await expect(trainings.getByText("No training assigned to this employee yet.")).toBeVisible();
});

test("employees cannot use the employee list or another person's assignments", async ({ page }) => {
  await signIn(page, ACCOUNTS.employee);
  expect((await page.request.get("/api/v1/admin/employees")).status()).toBe(403);
  expect((await page.request.get("/api/v1/admin/enrolments?employee_id=00000000-0000-4000-8000-000000000000")).status()).toBe(403);
  const anonymous = await page.context().browser()!.newContext();
  const status = (await anonymous.request.get(`${new URL(page.url()).origin}/api/v1/admin/employees`)).status();
  expect(status).toBe(401);
  await anonymous.close();
});
