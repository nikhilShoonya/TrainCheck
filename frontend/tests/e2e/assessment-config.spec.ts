import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

/* Assessment Configuration: question pool diagnostics, defaults, and server validation. */

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = decodeURIComponent(document.cookie.match(/tc_csrf=([^;]*)/)?.[1] ?? "");
      const response = await fetch(`/api/v1${path}`, { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    },
    { method, path, body },
  );
}

async function addQuestion(page: Page, trainingId: string, code: string) {
  const result = await call(page, "POST", "/admin/questions", { question_code: code, topic: "Pool", question_type: "MCQ_SINGLE", question_text: `${code}?`, options: ["Right", "Wrong"], correct_option_indexes: [0], difficulty: "EASY", marks: 1, training_ids: [trainingId] });
  expect(result.status).toBe(200);
  return result.json.data.id as string;
}

test("question pool problems are explained, fixable and still enforced by the server", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, ACCOUNTS.admin);
  const stamp = Date.now();
  const title = `Sales Pool ${stamp}`;
  const created = await call(page, "POST", "/admin/trainings", { title, training_code: `POOL-${stamp}` });
  const trainingId = created.json.data.id as string;

  const openSettings = async () => {
    await page.goto("/lnd/assessment-config");
    await page.getByRole("row", { name: new RegExp(title) }).getByRole("button", { name: "Assessment Rules" }).click();
    return page.getByRole("dialog");
  };
  const count = () => dialog.getByLabel("Questions per attempt *");
  const save = () => dialog.getByRole("button", { name: "Save settings" });

  // 1. No eligible questions: incomplete, no default, save disabled with a reason.
  let dialog = await openSettings();
  await expect(dialog.getByText("Configuration incomplete.")).toBeVisible();
  await expect(count()).toHaveValue("");
  await expect(save()).toBeDisabled();
  await expect(dialog.getByText("Add eligible questions to this training before saving.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Open Question Bank/ })).toHaveAttribute("href", `/lnd/questions?training_id=${trainingId}`);

  // 2. Five questions added elsewhere: refreshing suggests 5, not 10.
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await addQuestion(page, trainingId, `POOL-${stamp}-${i}`));
  await dialog.getByRole("button", { name: "Refresh counts" }).click();
  await expect(count()).toHaveValue("5");
  await expect(dialog.getByText(`Ready. ${title} has 5 eligible active questions`)).toBeVisible();
  await expect(save()).toBeEnabled();

  // 3. Asking for more than exist gives the actionable message and the fix.
  await dialog.getByLabel("Time limit (minutes) *").fill("25");
  await count().fill("8");
  await expect(dialog.getByText(`${title} has 5 eligible active questions, but your assessment requires 8. Please add 3 more questions or reduce questions per attempt to 5.`)).toBeVisible();
  await expect(save()).toBeDisabled();
  await dialog.getByRole("button", { name: "Set questions per attempt to 5" }).click();
  await expect(count()).toHaveValue("5");
  await expect(dialog.getByLabel("Time limit (minutes) *")).toHaveValue("25");

  // 4. Difficulty mix: every question is Easy, so Medium and Hard are short and named.
  await dialog.getByLabel("Use exact counts by difficulty").check();
  await expect(dialog.getByRole("row", { name: /Medium/ })).toContainText("Short by 2");
  await expect(dialog.getByRole("row", { name: /Hard/ })).toContainText("Short by 1");
  await expect(save()).toBeDisabled();
  await dialog.getByLabel("Use exact counts by difficulty").uncheck();
  await expect(save()).toBeEnabled();

  // 5. The server stays the authority: the pool shrinks before saving, the save is refused, values are kept.
  await call(page, "POST", `/admin/questions/${ids[0]}/status`, { status: "INACTIVE" });
  await save().click();
  await expect(dialog.getByRole("alert").filter({ hasText: "has 4 eligible active questions, but the assessment requires 5" })).toBeVisible();
  await expect(count()).toHaveValue("5");
  await expect(dialog.getByLabel("Time limit (minutes) *")).toHaveValue("25");
  await expect(dialog.getByText("1 inactive question not counted")).toBeVisible();

  // 6. Fix the pool, save, then activate.
  await call(page, "POST", `/admin/questions/${ids[0]}/status`, { status: "ACTIVE" });
  await dialog.getByRole("button", { name: "Refresh counts" }).click();
  await expect(save()).toBeEnabled();
  await save().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row).toContainText("Ready");
  await expect(row).toContainText("25 min");
  expect((await call(page, "POST", `/admin/trainings/${trainingId}/status`, { status: "ACTIVE" })).status).toBe(200);

  // 7. Reopening keeps the saved value instead of a new suggestion.
  dialog = await openSettings();
  await expect(count()).toHaveValue("5");

  // 8. The Question Bank link opens filtered, and a new question is pre-linked to this training.
  await page.goto(`/lnd/questions?training_id=${trainingId}`);
  await expect(page.getByRole("cell", { name: new RegExp(`POOL-${stamp}-0`) })).toBeVisible();
  await page.getByRole("button", { name: "Add Question" }).click();
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: title })).toBeChecked();
});
