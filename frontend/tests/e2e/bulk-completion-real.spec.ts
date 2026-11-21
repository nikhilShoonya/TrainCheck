import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

/* Mark Selected Completed / Waive Selected against a REAL, disposable backend with freshly seeded synthetic data.
   It records completions and waivers for good, so it refuses to run unless E2E_DISPOSABLE_STACK=1 is set and
   E2E_BASE_URL points at an isolated frontend whose BACKEND_URL is a throwaway backend (never the real database). */
test.skip(process.env.E2E_DISPOSABLE_STACK !== "1" || !process.env.E2E_BASE_URL, "Needs a disposable seeded stack (E2E_DISPOSABLE_STACK=1, E2E_BASE_URL).");

interface Training { id: string; title: string; status: string }
interface Row { id: string; employee_name: string; employee_code: string; attendance_status: string; completed_at: string | null; assessment_state: string; obligation_id: string | null; outcome: string | null; completion_source: string | null }

const api = async <T,>(page: Page, path: string): Promise<T> => {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.status(), path).toBe(200);
  return (await response.json()).data as T;
};
const rows = (page: Page, trainingId: string) => api<Row[]>(page, `/admin/enrolments?training_id=${trainingId}`);
const rowFor = (page: Page, row: Row) => page.locator("tbody tr").filter({ hasText: row.employee_code });
const box = (page: Page, row: Row) => page.getByRole("checkbox", { name: `Select ${row.employee_name} (${row.employee_code})`, exact: true });

test("real backend: mixed selection completes eligible employees, reports the refusal, then waives; all persisted", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const trainings = await api<Training[]>(page, "/admin/trainings");
  let chosen: { training: Training; first: Row[] } | null = null;
  for (const training of trainings.filter((t) => t.status === "ACTIVE")) {
    const first = (await rows(page, training.id)).slice(0, 8); // The first table page (rows are sorted by name, as in the UI).
    if (first.filter((r) => !r.completed_at && ["PENDING", "PRESENT"].includes(r.attendance_status)).length >= 3) { chosen = { training, first }; break; }
  }
  expect(chosen, "a seeded ACTIVE training with three employees awaiting completion on its first page").toBeTruthy();
  const { training, first } = chosen!;
  const [a, b, partial] = first.filter((r) => !r.completed_at && ["PENDING", "PRESENT"].includes(r.attendance_status));
  const untouched = (await rows(page, training.id)).filter((r) => ![a.id, b.id, partial.id].includes(r.id));

  await page.goto(`/lnd/completion/${training.id}`);
  await expect(page.getByRole("heading", { level: 1, name: training.title })).toBeVisible();
  // Partial attendance with the policy off (the default) must be refused by the server, per employee.
  await page.getByRole("combobox", { name: `Attendance for ${partial.employee_name} (${partial.employee_code})`, exact: true }).selectOption("PARTIAL");
  await expect.poll(async () => (await rows(page, training.id)).find((r) => r.id === partial.id)!.attendance_status).toBe("PARTIAL");
  for (const row of [a, b, partial]) await box(page, row).check();
  await expect(page.getByText("3 employees selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark Selected Completed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Complete selected employees" });
  await expect(dialog.getByRole("listitem")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Confirm completion", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  for (const row of [a, b]) await expect(rowFor(page, row).locator("td").nth(2)).toContainText("Completed");
  await expect(rowFor(page, partial).getByRole("alert")).toContainText(/partial/i);
  await expect(rowFor(page, partial).locator("td").nth(2)).toContainText("Awaiting completion");
  await expect(page.getByRole("heading", { name: "Bulk completion result" })).toHaveCount(0);

  const afterCompletion = await rows(page, training.id);
  const get = (row: Row) => afterCompletion.find((r) => r.id === row.id)!;
  for (const row of [a, b]) {
    expect(get(row).completed_at).toBeTruthy();
    expect(get(row).completion_source).toBe("MANUAL");
    expect(get(row).attendance_status).toBe("PRESENT"); // Pending became Present; Present stayed Present.
    expect(get(row).outcome).toBeNull(); // Completion never marks an assessment passed.
  }
  expect(get(partial).completed_at).toBeNull();
  expect(get(partial).attendance_status).toBe("PARTIAL");
  for (const row of untouched) expect(afterCompletion.find((r) => r.id === row.id)!.completed_at).toBe(row.completed_at);

  // Refresh shows the persisted data.
  await page.reload();
  for (const row of [a, b]) await expect(rowFor(page, row).locator("td").nth(2)).toContainText("Completed");

  // Waive the two new assessments (only if the training scheduled them).
  const waivable = [get(a), get(b)].filter((r) => r.obligation_id && ["Due", "Scheduled", "Unavailable"].includes(r.assessment_state));
  test.skip(!waivable.length, "The chosen training did not schedule assessments, so there is nothing to waive.");
  const clear = page.getByRole("button", { name: "Clear selection", exact: true });
  if (await clear.isEnabled()) await clear.click();
  await expect(page.getByText("0 employees selected", { exact: true })).toBeVisible();
  for (const row of waivable) await box(page, row).check();
  await page.getByRole("button", { name: "Waive Selected", exact: true }).click();
  const waive = page.getByRole("dialog", { name: "Waive selected assessments" });
  await expect(waive.getByRole("listitem")).toHaveCount(waivable.length);
  await waive.getByLabel("Reason *", { exact: true }).fill("Synthetic E2E exemption on a disposable database");
  await waive.getByRole("button", { name: "Confirm waiver", exact: true }).click();
  await expect(waive).toBeHidden({ timeout: 30_000 });
  for (const row of waivable) await expect(rowFor(page, row).locator("td").nth(4)).toHaveText("Waived");

  const afterWaiver = await rows(page, training.id);
  for (const row of waivable) {
    const now = afterWaiver.find((r) => r.id === row.id)!;
    expect(now.assessment_state).toBe("Waived");
    expect([now.completed_at, now.attendance_status, now.outcome]).toEqual([row.completed_at, row.attendance_status, row.outcome]);
  }
  // A repeat waiver through the API is refused, not duplicated.
  const csrf = (await page.context().cookies()).find((c) => c.name === "tc_csrf")!.value;
  const again = await page.request.post(`/api/v1/admin/obligations/${waivable[0].obligation_id}/waive`, { headers: { "X-CSRF-Token": csrf }, data: { reason: "Second attempt at the same waiver" } });
  expect(again.status()).toBe(409);
  await page.reload();
  for (const row of waivable) await expect(rowFor(page, row).locator("td").nth(4)).toHaveText("Waived");
});
