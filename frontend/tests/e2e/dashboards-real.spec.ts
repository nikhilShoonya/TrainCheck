import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

// Mutates synthetic records only. Requires an explicitly enabled, freshly seeded disposable stack.
test.skip(process.env.E2E_DISPOSABLE_STACK !== "1" || process.env.E2E_BASE_URL !== "http://127.0.0.1:3100", "Requires disposable PostgreSQL, backend :8100 and frontend :3100.");

interface Training { id: string; title: string; status: string; config: unknown; config_ready: boolean }
interface Recent { enrolment_id: string; title: string; assigned_at: string }

async function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const token = (await page.context().cookies()).find(cookie => cookie.name === "tc_csrf")?.value ?? "";
  const response = await page.request.fetch(`/api/v1${path}`, { method, headers: { "X-CSRF-Token": token }, data });
  expect(response.status(), path).toBe(200);
  return (await response.json()).data as T;
}

const recentPanel = (page: Page) => page.locator("section.dashboard-panel").filter({ has: page.getByRole("heading", { name: "Recent Trainings", exact: true }) });

test("real admin dashboard excludes archived counts, labels archives correctly and shows newest creations", async ({ page }, testInfo) => {
  await signIn(page, ACCOUNTS.admin);
  const stamp = Date.now();
  const oldest = await call<Training>(page, "POST", "/admin/trainings", { title: `AAA Old dashboard ${stamp}` });
  const archived = await call<Training>(page, "POST", "/admin/trainings", { title: `Middle archived dashboard ${stamp}` });
  await call(page, "POST", `/admin/trainings/${archived.id}/status`, { status: "ARCHIVED" });
  const newest = await call<Training>(page, "POST", "/admin/trainings", { title: `ZZZ New dashboard ${stamp}` });
  const trainings = await call<Training[]>(page, "GET", "/admin/trainings");
  const eligible = trainings.filter(training => ["DRAFT", "ACTIVE"].includes(training.status));
  const expectedSetup = eligible.filter(training => training.status === "DRAFT" || !training.config || !training.config_ready).length;
  const dashboard = await call<{ training_programmes: number; programmes_need_setup: number; recent_trainings: { id: string; status: string }[] }>(page, "GET", "/admin/dashboard");
  expect(dashboard.training_programmes).toBe(eligible.length);
  expect(dashboard.programmes_need_setup).toBe(expectedSetup);
  expect(dashboard.recent_trainings.map(training => training.id)).toEqual([newest.id, archived.id, oldest.id]);

  await page.goto("/lnd");
  await expect(recentPanel(page).locator(".recent-training-copy strong")).toHaveText([newest.title, archived.title, oldest.title]);
  await expect(recentPanel(page).locator(".recent-training").filter({ hasText: archived.title }).locator("small")).toHaveText("Archived · 0 enrolled");
  await expect(page.locator(".image-metric").filter({ hasText: "Training Programmes" }).locator("strong")).toHaveText(String(eligible.length));
  await page.screenshot({ path: testInfo.outputPath("admin-dashboard-fixed.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("real employee dashboard shows own newest assignments and retains its learning score", async ({ page }, testInfo) => {
  await signIn(page, ACCOUNTS.clear);
  const trainings = await call<Recent[]>(page, "GET", "/me/trainings");
  const expected = [...trainings].sort((a, b) => b.assigned_at.localeCompare(a.assigned_at) || b.enrolment_id.localeCompare(a.enrolment_id)).slice(0, 3);
  const data = await call<{ recent: Recent[]; overall_score: number }>(page, "GET", "/me/dashboard");
  expect(data.recent.map(row => row.enrolment_id)).toEqual(expected.map(row => row.enrolment_id));
  await expect(recentPanel(page).locator(".recent-training-copy strong")).toHaveText(expected.map(row => row.title));
  await expect(page.locator(".overall-score")).toHaveText(`${data.overall_score}%`);
  await expect(page.locator(".banner-status")).toHaveText("No assessments due");
  await expect(page.getByText("Learning verified", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("employee-dashboard-fixed.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("real employee with no assignments sees missing evidence and no verification claim", async ({ page, browser }, testInfo) => {
  await signIn(page, ACCOUNTS.admin);
  const stamp = Date.now();
  const email = `dashboard.${stamp}@example.com`;
  const departments = await call<{ id: string }[]>(page, "GET", "/admin/departments");
  await call(page, "POST", "/admin/employees", { full_name: `Synthetic empty dashboard ${stamp}`, employee_code: `DASH-${stamp}`, work_email: email, joining_date: "2026-01-05", department_id: departments[0].id });
  const context = await browser.newContext();
  try {
    const employee = await context.newPage();
    await employee.goto("/login");
    await employee.locator('input[name="email"]').fill(email);
    await employee.locator('input[name="password"]').fill("Fin@05012026");
    await employee.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(employee).toHaveURL(/\/employee$/);
    const data = await call<{ summary: { assignments: number }; overall_score: number | null }>(employee, "GET", "/me/dashboard");
    expect(data.summary.assignments).toBe(0);
    expect(data.overall_score).toBeNull();
    await expect(employee.locator(".overall-score")).toHaveText("—");
    await expect(employee.getByText("No training assigned.", { exact: true })).toBeVisible();
    await expect(employee.locator(".banner-status")).toHaveText("No assessments due");
    await expect(employee.getByText("Learning verified", { exact: true })).toHaveCount(0);
    await employee.screenshot({ path: testInfo.outputPath("employee-empty-fixed.png"), fullPage: true });
  } finally {
    await context.close();
  }
});

test("real employee upcoming banner uses earliest opening and removes waived and archived assessments", async ({ page, browser }) => {
  await signIn(page, ACCOUNTS.admin);
  const stamp = Date.now();
  const email = `upcoming.${stamp}@example.com`;
  const departments = await call<{ id: string }[]>(page, "GET", "/admin/departments");
  const { employee: person } = await call<{ employee: { id: string } }>(page, "POST", "/admin/employees", { full_name: `Synthetic upcoming ${stamp}`, employee_code: `UP-${stamp}`, work_email: email, joining_date: "2026-01-05", department_id: departments[0].id });
  const completionDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const created: { training: Training; obligation_id: string }[] = [];
  for (const [prefix, delay] of [["AAA Later", 3], ["ZZZ Earlier", 1]] as const) {
    const training = await call<Training>(page, "POST", "/admin/trainings", { title: `${prefix} upcoming ${stamp}` });
    await call(page, "POST", "/admin/questions", {
      question_code: `UP-${stamp}-${delay}`, topic: "Synthetic dashboard regression", question_type: "MCQ_SINGLE", question_text: `Synthetic upcoming ${delay}?`,
      options: ["Right", "Wrong"], correct_option_indexes: [0], difficulty: "EASY", marks: 1,
      training_ids: [training.id], training_test_types: { [training.id]: "POST_TEST" },
    });
    await call(page, "POST", `/admin/trainings/${training.id}/assessment-configs`, { question_count: 1, duration_minutes: 5, pass_mark_percent: 70, max_attempts: 3, schedule_mode: "DELAY_DAYS", schedule_delay_days: delay });
    await call(page, "POST", `/admin/trainings/${training.id}/status`, { status: "ACTIVE" });
    await call(page, "POST", "/admin/enrolments", { training_id: training.id, employee_ids: [person.id] });
    const enrolments = await call<{ id: string }[]>(page, "GET", `/admin/enrolments?training_id=${training.id}`);
    const completion = await call<{ obligation_id: string }>(page, "POST", `/admin/enrolments/${enrolments[0].id}/completion`, { completion_date: completionDate });
    created.push({ training, obligation_id: completion.obligation_id });
  }

  const context = await browser.newContext();
  try {
    const employee = await context.newPage();
    await employee.goto("/login");
    await employee.locator('input[name="email"]').fill(email);
    await employee.locator('input[name="password"]').fill("Fin@05012026");
    await employee.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(employee).toHaveURL(/\/employee$/);
    const pending = employee.locator(".dashboard-statistics > div").filter({ hasText: "Assessment Pending" }).locator("strong");
    await expect(employee.locator(".banner-training strong")).toHaveText(created[1].training.title);
    await expect(pending).toHaveText("2");

    await call(page, "POST", `/admin/obligations/${created[1].obligation_id}/waive`, { reason: "Synthetic upcoming regression" });
    await employee.reload();
    await expect(employee.locator(".banner-training strong")).toHaveText(created[0].training.title);
    await expect(pending).toHaveText("1");

    await call(page, "POST", `/admin/trainings/${created[0].training.id}/status`, { status: "ARCHIVED" });
    await employee.reload();
    await expect(employee.locator(".banner-status")).toHaveText("No assessments due");
    await expect(pending).toHaveText("0");
    const data = await call<{ upcoming: unknown; calendar: { tag: string }[]; summary: { completed: number } }>(employee, "GET", "/me/dashboard");
    expect(data.upcoming).toBeNull();
    expect(data.calendar.filter(event => event.tag === "Assessment")).toEqual([]);
    expect(data.summary.completed).toBe(2);
  } finally {
    await context.close();
  }
});
