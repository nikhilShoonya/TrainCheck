import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, answerAll, signIn, startSecureAssessment, submitAssessment } from "./helpers";

// Requires the operator-created throwaway PostgreSQL/uvicorn :8100/Next :3100 stack.
// No API routes are mocked. Never enable this against a database containing real records.
test.skip(process.env.E2E_DISPOSABLE_STACK !== "1" || process.env.E2E_BASE_URL !== "http://127.0.0.1:3100", "Requires the explicitly enabled disposable stack on :3100.");

interface Training { id: string; title: string; training_code: string }

async function call(page: Page, method: string, path: string, data?: unknown) {
  const token = (await page.context().cookies()).find((cookie) => cookie.name === "tc_csrf")?.value ?? "";
  return page.request.fetch(`/api/v1${path}`, { method, headers: { "X-CSRF-Token": token }, data });
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await call(page, "GET", path);
  expect(response.status(), path).toBe(200);
  return (await response.json()).data as T;
}

async function createTraining(page: Page, title: string): Promise<Training> {
  await page.goto("/lnd/trainings");
  await page.getByRole("button", { name: "Create Training", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create training", exact: true });
  await dialog.getByLabel("Training name *").fill(title);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/trainings") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Save training" }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  await expect(dialog).toBeHidden();
  return (await response.json()).data as Training;
}

test("real proxy and browser: assessed training deletion preserves questions, supports reassignment and clears employee access", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page, ACCOUNTS.admin);
  const stamp = Date.now();
  const source = await createTraining(page, `Deletion source ${stamp}`);
  const destination = await createTraining(page, `Deletion destination ${stamp}`);
  const codes = [`DEL-${stamp}-1`, `DEL-${stamp}-2`];
  // Synthetic setup through the same real proxy; the employee actions and destructive confirmation use the UI.
  for (const [training, questionCodes] of [[source, codes], [destination, [`DEST-${stamp}`]]] as const) {
    for (const code of questionCodes) {
      const response = await call(page, "POST", "/admin/questions", {
        question_code: code, topic: "Disposable deletion check", question_type: "MCQ_SINGLE", question_text: `Synthetic ${code}?`,
        options: ["Synthetic right", "Synthetic wrong"], correct_option_indexes: [0], difficulty: "EASY", marks: 1,
        training_ids: [training.id], training_test_types: { [training.id]: "POST_TEST" },
      });
      expect(response.status()).toBe(200);
    }
  }
  expect((await call(page, "POST", `/admin/trainings/${source.id}/assessment-configs`, {
    question_count: 1, duration_minutes: 5, pass_mark_percent: 70, max_attempts: 3, schedule_mode: "SAME_DAY",
  })).status()).toBe(200);
  expect((await call(page, "POST", `/admin/trainings/${source.id}/status`, { status: "ACTIVE" })).status()).toBe(200);

  await page.goto("/lnd/assignments");
  await page.getByRole("button", { name: "Assign Employees", exact: true }).click();
  const assignment = page.getByRole("dialog", { name: "Assign employees", exact: true });
  await assignment.getByLabel("Training (active only) *").selectOption(source.id);
  await assignment.getByLabel("Find by name, ID, department or function").fill("E002");
  await expect(assignment.locator('.checkbox-list input[type="checkbox"]')).toHaveCount(1);
  await assignment.locator('.checkbox-list input[type="checkbox"]').check();
  await assignment.getByRole("button", { name: "Assign selected employees" }).click();
  await expect(page.getByRole("dialog", { name: "Assignment result" })).toBeVisible();
  const enrolments = await read<{ employee_name: string; employee_code: string }[]>(page, `/admin/enrolments?training_id=${source.id}`);
  expect(enrolments).toHaveLength(1);

  await page.goto(`/lnd/completion/${source.id}`);
  await page.getByRole("button", { name: `Mark Completed for ${enrolments[0].employee_name}`, exact: true }).click();
  const completion = page.getByRole("dialog", { name: "Record training completion" });
  await completion.getByRole("button", { name: "Record completion", exact: true }).click();
  await expect(completion).toBeHidden();

  const employeeContext = await browser.newContext();
  try {
    const employee = await employeeContext.newPage();
    await signIn(employee, ACCOUNTS.clear);
    await expect(employee).toHaveURL(/\/access\/assessment-required/);
    await startSecureAssessment(employee);
    await answerAll(employee);
    await submitAssessment(employee);
    await expect(employee.getByRole("dialog", { name: "Training & assessment feedback" })).toBeVisible();
    const before = await read<{ access_status: string; feedback_due: unknown }>(employee, "/me/access-state");
    expect(before.feedback_due).toBeTruthy(); // Deletion must remove this actual access blocker as well.

    const preview = await read<{ counts: Record<string, number> }>(page, `/admin/trainings/${source.id}/deletion-preview`);
    expect(preview.counts).toMatchObject({ assignments: 1, completions: 1, assessments: 1, attempts: 1, submitted_attempts: 1, attempt_answers: 1, question_links: 2, questions_becoming_unassigned: 2 });
    const missing = await call(page, "DELETE", `/admin/trainings/${source.id}`);
    expect(missing.status()).toBe(400);
    const mismatch = await call(page, "DELETE", `/admin/trainings/${source.id}`, { confirmation_code: "WRONG-CODE" });
    expect(mismatch.status()).toBe(400);
    expect((await mismatch.json()).error.code).toBe("CONFIRMATION_MISMATCH");

    await page.goto("/lnd/trainings");
    await page.getByLabel("Search programmes").fill(source.title);
    await page.getByRole("button", { name: "Apply Filters" }).click();
    await page.getByRole("button", { name: `More actions for ${source.title}` }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const deletion = page.getByRole("dialog", { name: "Permanently delete training?" });
    for (const line of ["1 employee assignment", "1 training completion record", "1 assessment attempt with its answers and score", "2 questions are linked only to this training"]) await expect(deletion).toContainText(line);
    await deletion.getByLabel(/Type the training code/).fill(source.training_code);
    await deletion.screenshot({ path: testInfo.outputPath("deletion-counts.png") });
    const removed = page.waitForResponse((response) => response.url().endsWith(`/api/v1/admin/trainings/${source.id}`) && response.request().method() === "DELETE");
    await deletion.getByRole("button", { name: "Permanently delete training", exact: true }).click();
    const response = await removed;
    expect(response.status()).toBe(200);
    expect((await response.json()).data.counts).toEqual(preview.counts);
    await expect(deletion).toBeHidden();
    await expect(page.getByText(`${source.title} was permanently deleted.`, { exact: true })).toBeVisible();

    await page.goto("/lnd/questions");
    await page.getByRole("article", { name: "Unassigned Questions" }).getByRole("link", { name: /View Questions/ }).click();
    for (const code of codes) await expect(page.getByRole("row").filter({ hasText: code })).toBeVisible();
    await page.getByRole("row").filter({ hasText: codes[0] }).getByRole("button", { name: /^Assign/ }).click();
    const assignQuestion = page.getByRole("dialog", { name: "Assign to Training", exact: true });
    await assignQuestion.getByLabel("Training *").selectOption(destination.id);
    await assignQuestion.getByLabel("Test type *").selectOption("POST_TEST");
    await assignQuestion.getByRole("button", { name: "Assign questions" }).click();
    const result = page.getByRole("dialog", { name: "Assignment result" });
    await expect(result).toContainText(`1 assigned to ${destination.title} · Post-test`);
    await result.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("row").filter({ hasText: codes[0] })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: codes[1] })).toBeVisible();
    await page.getByRole("link", { name: "Back to Trainings" }).click();
    const card = page.locator("article.question-card").filter({ has: page.getByRole("heading", { name: destination.title, exact: true }) }).filter({ hasText: "Post-test" });
    await expect(card.locator(".question-card-count strong")).toHaveText("2");
    await page.reload();
    await expect(card.locator(".question-card-count strong")).toHaveText("2");
    const after = await read<{ access_status: string; pending_count: number; feedback_due: unknown }>(employee, "/me/access-state");
    expect(after).toMatchObject({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, feedback_due: null });
    await employee.goto("/employee");
    await expect(employee).toHaveURL(/\/employee$/);
    await expect(employee.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
    console.log(JSON.stringify({ deletion_counts: preview.counts, proxy_delete_status: response.status(), destination_post_test_questions: 2, employee_access: after.access_status }));
  } finally {
    await employeeContext.close();
  }
});
