import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

/* Training Completion: training cards → one training's employees, at a URL of its own (SCR-LND-006).
   Runs on freshly seeded synthetic data. It changes no seeded record for good: dialogs are cancelled, and the
   empty training it creates is deleted. */

interface TrainingRow {
  id: string;
  title: string;
  assigned_count: number;
  completed_count: number;
}
interface EnrolmentRow {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  training_id: string;
  attendance_status: string;
  completed_at: string | null;
  assessment_state: string;
  obligation_id: string | null;
}

const api = async <T,>(page: Page, path: string): Promise<T> => {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.status(), path).toBe(200);
  return (await response.json()).data as T;
};
const csrf = async (page: Page) => (await page.context().cookies()).find((c) => c.name === "tc_csrf")?.value ?? "";
const card = (page: Page, title: string) => page.getByRole("article", { name: title, exact: true });
const searchTrainings = (page: Page) => page.getByRole("searchbox", { name: "Search trainings" });

test("L&D opens a training from its card; refresh, direct links and Back keep the place", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const trainings = await api<TrainingRow[]>(page, "/admin/trainings");
  const target = trainings.find((t) => t.title === "Customer Handling")!;
  expect(target).toBeTruthy();

  await page.goto("/lnd/completion");
  await expect(page.getByRole("heading", { level: 1, name: "Training Completion" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import Attendance" })).toBeVisible();
  // Every training has a card, and each card's counts are the server's.
  await expect(page.locator(".completion-card")).toHaveCount(trainings.length);
  for (const t of trainings) {
    const counts = card(page, t.title).locator(".completion-counts dd");
    await expect(counts).toHaveText([String(t.assigned_count), String(t.completed_count), String(t.assigned_count - t.completed_count)]);
  }

  // Search by training name, kept in the URL.
  await searchTrainings(page).fill("kyc");
  await expect(page).toHaveURL(/\/lnd\/completion\?q=kyc$/);
  await expect(page.locator(".completion-card")).toHaveCount(1);
  await expect(card(page, "KYC & AML Compliance")).toBeVisible();
  await searchTrainings(page).fill("no such training");
  await expect(page.getByText("No training name matches “no such training”.")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator(".completion-card")).toHaveCount(trainings.length);

  // Open a card with the keyboard.
  await searchTrainings(page).fill("customer");
  const view = page.getByRole("link", { name: "View Employees for Customer Handling" });
  await view.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/lnd/completion/${target.id}\\?q=customer$`));
  await expect(page.getByRole("heading", { level: 1, name: "Customer Handling" })).toBeVisible();

  // Only this training's employees are listed.
  const rows = await api<EnrolmentRow[]>(page, `/admin/enrolments?training_id=${target.id}`);
  expect(rows.length).toBeGreaterThan(0);
  const table = page.locator("table");
  await expect(page.getByRole("status").filter({ hasText: `${rows.length} employees assigned.` })).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText(["Employee", "Completion", "Assessment Due", "Assessment", "Result", "", "Attempts", "Reattempt / Retraining"]);
  await expect(page.getByRole("combobox", { name: /^Attendance for / })).toHaveCount(0); // Attendance is not edited here.
  const shown = await table.locator("tbody tr td:first-child small").allInnerTexts();
  expect(shown.length).toBe(Math.min(rows.length, 8)); // Eight rows per page.
  for (const code of shown) expect(rows.map((r) => r.employee_code)).toContain(code);

  // Employee search by code, then by name.
  const someone = rows[0];
  await page.getByRole("searchbox", { name: "Search employees" }).fill(someone.employee_code);
  await expect(table.locator("tbody tr")).toHaveCount(rows.filter((r) => r.employee_code.toLowerCase().includes(someone.employee_code.toLowerCase())).length);
  await expect(table.locator("tbody tr").first()).toContainText(someone.employee_code);
  await page.getByRole("searchbox", { name: "Search employees" }).fill(someone.employee_name);
  await expect(table.locator("tbody tr").first()).toContainText(someone.employee_name);

  // Refresh keeps the training.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Customer Handling" })).toBeVisible();
  await expect(page.locator("table tbody tr").first()).toBeVisible();

  // Browser Back returns to the cards with the search restored; Forward reopens the training.
  await page.goBack();
  await expect(page).toHaveURL(/\/lnd\/completion\?q=customer$/);
  await expect(searchTrainings(page)).toHaveValue("customer");
  await expect(page.locator(".completion-card")).toHaveCount(1);
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "Customer Handling" })).toBeVisible();

  // Back to Trainings restores the card search too.
  await page.getByRole("link", { name: "Back to Trainings" }).click();
  await expect(page).toHaveURL(/\/lnd\/completion\?q=customer$/);
  await expect(searchTrainings(page)).toHaveValue("customer");

  // A direct link opens the training without passing through the cards.
  await page.goto(`/lnd/completion/${target.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Customer Handling" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Trainings" }).click();
  await expect(page).toHaveURL(/\/lnd\/completion$/);
  await expect(page.locator(".completion-card")).toHaveCount(trainings.length);
});

test("an employee assigned to two trainings appears in each, and actions reach only the selected enrolment", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const trainings = await api<TrainingRow[]>(page, "/admin/trainings");
  const all = await api<EnrolmentRow[]>(page, "/admin/enrolments");
  // An employee with one training awaiting completion and at least one other training.
  const open = all.find((e) => !e.completed_at && all.some((o) => o.employee_id === e.employee_id && o.training_id !== e.training_id))!;
  expect(open, "the seed has an employee assigned to several trainings").toBeTruthy();
  const other = all.find((o) => o.employee_id === open.employee_id && o.training_id !== open.training_id)!;
  const title = (id: string) => trainings.find((t) => t.id === id)!.title;

  for (const enrolment of [open, other]) {
    await page.goto(`/lnd/completion/${enrolment.training_id}`);
    await expect(page.getByRole("heading", { level: 1, name: title(enrolment.training_id) })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search employees" }).fill(enrolment.employee_code);
    await expect(page.locator("tbody tr").filter({ hasText: enrolment.employee_code }).first()).toContainText(enrolment.completed_at ? "Completed" : "Awaiting completion");
  }

  await page.goto(`/lnd/completion/${open.training_id}`);
  await page.getByRole("searchbox", { name: "Search employees" }).fill(open.employee_code);

  // Mark Completed opens for this employee and this training (cancelled: the seed is kept).
  await page.getByRole("button", { name: `Mark Completed for ${open.employee_name}` }).click();
  const dialog = page.getByRole("dialog", { name: "Record training completion" });
  await expect(dialog).toContainText(`${open.employee_name} · ${title(open.training_id)}`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Waive, where offered, names the selected enrolment's training.
  const waivable = all.find((e) => e.obligation_id && ["Due", "Scheduled"].includes(e.assessment_state));
  if (waivable) {
    await page.goto(`/lnd/completion/${waivable.training_id}`);
    await page.getByRole("searchbox", { name: "Search employees" }).fill(waivable.employee_code);
    await page.getByRole("button", { name: `Waive assessment for ${waivable.employee_name}` }).click();
    const waive = page.getByRole("dialog", { name: "Waive this assessment?" });
    await expect(waive).toContainText(`${waivable.employee_name} · ${title(waivable.training_id)}`);
    await waive.getByRole("button", { name: "Cancel" }).click();
  }
});

test("a training without employees, and unknown training links, have clear states", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const name = `E2E empty training ${Date.now()}`;
  const created = await page.request.post("/api/v1/admin/trainings", { headers: { "X-CSRF-Token": await csrf(page) }, data: { title: name, description: "Synthetic training with no assignments." } });
  expect(created.status(), await created.text()).toBe(200);
  const id = (await created.json()).data.id as string;
  try {
    await page.goto("/lnd/completion");
    await searchTrainings(page).fill(name);
    await expect(card(page, name).locator(".completion-counts dd")).toHaveText(["0", "0", "0"]);
    await page.getByRole("link", { name: `View Employees for ${name}` }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText("No employees are assigned to this training.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Employee Assignments" })).toBeVisible();
  } finally {
    await page.request.delete(`/api/v1/admin/trainings/${id}`, { headers: { "X-CSRF-Token": await csrf(page) } });
  }

  for (const path of ["/lnd/completion/00000000-0000-4000-8000-000000000000", "/lnd/completion/not-a-training"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Training not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Trainings" })).toHaveAttribute("href", "/lnd/completion");
  }
});

test("an employee cannot open Training Completion or its data", async ({ page }) => {
  await signIn(page, ACCOUNTS.clear);
  for (const path of ["/lnd/completion", "/lnd/completion/00000000-0000-4000-8000-000000000000"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "You do not have access to this page" })).toBeVisible();
    await expect(page.locator(".completion-card")).toHaveCount(0);
  }
  // The server refuses the data whatever the page does.
  expect((await page.request.get("/api/v1/admin/trainings")).status()).toBe(403);
  expect((await page.request.get("/api/v1/admin/enrolments?training_id=00000000-0000-4000-8000-000000000000")).status()).toBe(403);
});

test("Training Completion works at phone size without sideways scrolling", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/lnd/completion");
  await expect(page.locator(".completion-card").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.locator(".completion-card").first().getByRole("link", { name: /View Employees/ }).click();
  await expect(page.getByRole("link", { name: "Back to Trainings" })).toBeVisible();
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await context.close();
});
