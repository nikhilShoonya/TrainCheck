import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, answerAll, giveFeedback, signIn, submitAssessment } from "./helpers";

/* Custom-date-and-time scheduling, from L&D's Assessment Rules to the employee's view and the gate.
   Like journeys.spec.ts this needs freshly seeded synthetic data (it changes "Data Privacy & Protection"'s rules
   and records a completion for the demo employee Anika Sood, E010, whom no other browser test uses, so the journeys
   in journeys.spec.ts still find Isha Rao with nothing due). Never run it against data that matters.
   The organisation timezone is the seeded working calendar's, Asia/Kolkata. */

const ZONE = "Asia/Kolkata";
const TRAINING = "Data Privacy & Protection";

/** Local date (YYYY-MM-DD) and time (HH:MM) in the organisation timezone, `minutes` from now. */
function localIn(minutes: number): { date: string; time: string } {
  const at = new Date(Date.now() + minutes * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function signOut(page: Page) {
  await page.context().clearCookies();
}

async function openRules(page: Page) {
  await page.goto("/lnd/assessment-config");
  await page.getByRole("row", { name: new RegExp(TRAINING) }).getByRole("button", { name: "Assessment Rules" }).click();
  return page.getByRole("dialog");
}

test("L&D schedules a custom date and time; the employee sees it, and the assessment opens at that moment", async ({ page }) => {
  test.setTimeout(9 * 60_000);
  const opens = localIn(4); // Today (or tomorrow just before midnight), a few minutes from now: inside the countdown at step 5.
  const [year, month, day] = opens.date.split("-");
  const [hour, minute] = opens.time.split(":");
  const shown = `${day}-${month}-${year} ${String(Number(hour) % 12 || 12).padStart(2, "0")}:${minute} ${Number(hour) < 12 ? "AM" : "PM"}`;

  // 1. L&D chooses "Custom date and time"; the form names the timezone.
  await signIn(page, ACCOUNTS.admin);
  let dialog = await openRules(page);
  await dialog.getByLabel("When the assessment becomes due").selectOption("FIXED_DATE");
  await expect(dialog.getByLabel("Opening time *")).toBeVisible();
  await expect(dialog).not.toContainText(ZONE);
  await dialog.getByLabel("Assessment date *").fill(opens.date);
  await dialog.getByLabel("Opening time *").fill(opens.time);
  await expect(dialog.getByRole("checkbox", { name: /Also apply to employees already waiting/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row", { name: new RegExp(TRAINING) })).toContainText(`On ${shown}`);

  // 2. Reopening shows exactly what was chosen.
  dialog = await openRules(page);
  await expect(dialog.getByLabel("When the assessment becomes due")).toHaveValue("FIXED_DATE");
  await expect(dialog.getByLabel("Assessment date *")).toHaveValue(opens.date);
  await expect(dialog.getByLabel("Opening time *")).toHaveValue(opens.time);
  await expect(dialog).toContainText(`Saved: opens ${shown}.`);
  await page.keyboard.press("Escape");

  // 3. Completion not recorded yet: the employee is told why, not "Not scheduled".
  await signOut(page);
  await signIn(page, ACCOUNTS.scheduled);
  await page.goto("/employee/assessments");
  const row = page.getByRole("row", { name: new RegExp(TRAINING) });
  await expect(row).toContainText(`Opens ${shown}, once your training completion is recorded`);
  await expect(row).toContainText("Awaiting training completion");
  await expect(row).not.toContainText("Not scheduled");

  // 4. L&D records the completion (through the API, as the Employee Assignments page does).
  await signOut(page);
  await signIn(page, ACCOUNTS.admin);
  const csrf = (await page.context().cookies()).find((c) => c.name === "tc_csrf")?.value ?? "";
  const enrolments = (await (await page.request.get("/api/v1/admin/enrolments")).json()).data as { id: string; employee_code: string; training_title: string }[];
  const enrolment = enrolments.find((e) => e.employee_code === "E010" && e.training_title === TRAINING);
  expect(enrolment, "the demo employee is assigned this training").toBeTruthy();
  const completed = await page.request.post(`/api/v1/admin/enrolments/${enrolment!.id}/completion`, { headers: { "X-CSRF-Token": csrf }, data: { completion_date: localIn(0).date } });
  expect(completed.status(), await completed.text()).toBe(200);

  // 5. Within five minutes of the moment: signing in opens the countdown by itself. Nothing blocks on the server yet,
  //    and nothing has started.
  await signOut(page);
  await signIn(page, ACCOUNTS.scheduled);
  await expect(page).toHaveURL(/\/assessment\/start\//);
  const state = (await (await page.request.get("/api/v1/me/access-state")).json()).data;
  expect(state.access_status).toBe("DASHBOARD_ALLOWED");
  expect(state.countdown.training_title).toBe(TRAINING);
  await expect(page.locator(".scheduled-banner")).toContainText(`Opens ${shown}`);
  await expect(page.locator(".scheduled-banner h2")).toHaveText(/opens in 0[0-4]:\d\d/);

  // 6. The employee prepares while waiting; at the moment the server confirms it and the test starts by itself, with
  //    no Start click. Then the existing completion flow: required feedback, result, workspace.
  await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
  const proceed = page.getByRole("button", { name: /^Continue/ });
  await expect(proceed).toBeEnabled({ timeout: 15_000 });
  await proceed.click();
  await page.getByRole("button", { name: "Enter full screen" }).click();
  await page.getByRole("checkbox", { name: /read and understood/ }).check();
  await expect(page.getByRole("button", { name: /Starts by itself at/ })).toBeDisabled();
  const due = new Date(`${opens.date}T${opens.time}:00+05:30`).getTime();
  await expect(page.locator(".exam-timer")).toBeVisible({ timeout: Math.max(0, due - Date.now()) + 30_000 });
  expect(Date.now()).toBeGreaterThanOrEqual(due - 2_000); // Not before the moment (allowing for clock skew).
  const running = (await (await page.request.get("/api/v1/me/access-state")).json()).data;
  expect(running.access_status).toBe("ASSESSMENT_REQUIRED");
  expect(running.queue[0].in_progress).toBe(true);
  expect(running.queue[0].attempts_used).toBe(1); // One attempt, started once.
  await answerAll(page);
  await submitAssessment(page);
  await giveFeedback(page);
  await page.getByRole("button", { name: "Continue to my workspace" }).click();
  await page.waitForURL(/\/employee$/);
});
