import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

/* Question Bank by training and test: Training + Test cards, the existing question table restricted to one
   training's pre-test or post-test, navigation that keeps the context, and add/import with count refresh.
   Uses its own timestamped synthetic trainings and questions (needs a disposable, freshly seeded stack). */

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )tc_csrf=([^;]*)/)?.[1] ?? "");
      const response = await fetch(`/api/v1${path}`, { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    },
    { method, path, body },
  );
}

async function addQuestion(page: Page, trainingId: string, code: string, testType: "PRE_TEST" | "POST_TEST" | null) {
  const result = await call(page, "POST", "/admin/questions", {
    question_code: code,
    topic: "Cards",
    question_type: "MCQ_SINGLE",
    question_text: `${code}?`,
    options: ["Right", "Wrong"],
    correct_option_indexes: [0],
    difficulty: "EASY",
    marks: 1,
    training_ids: [trainingId],
    training_test_types: testType ? { [trainingId]: testType } : {},
  });
  expect(result.status).toBe(200);
  return result.json.data.id as string;
}

/** The cards' training search (the header also has a global "Search trainings, reports or help" box). */
const cardSearch = (page: Page) => page.getByRole("searchbox", { name: "Search trainings", exact: true });

/** The card for one training's test, found by its accessible name. */
const card = (page: Page, title: string, test: "Pre-test" | "Post-test") => page.locator("article.question-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).filter({ hasText: test });

async function setup(page: Page) {
  const stamp = Date.now();
  const alpha = { title: `Cards Alpha ${stamp}`, code: `CA-${stamp}` };
  const beta = { title: `Cards Beta ${stamp}`, code: `CB-${stamp}` };
  const alphaId = (await call(page, "POST", "/admin/trainings", { title: alpha.title, training_code: alpha.code })).json.data.id as string;
  const betaId = (await call(page, "POST", "/admin/trainings", { title: beta.title, training_code: beta.code })).json.data.id as string;
  // Alpha: 1 pre-test, 2 post-test and 1 legacy (unclassified: both tests). Beta: 1 post-test of its own.
  await addQuestion(page, alphaId, `CA${stamp}-PRE1`, "PRE_TEST");
  await addQuestion(page, alphaId, `CA${stamp}-POST1`, "POST_TEST");
  await addQuestion(page, alphaId, `CA${stamp}-POST2`, "POST_TEST");
  await addQuestion(page, alphaId, `CA${stamp}-BOTH1`, null);
  await addQuestion(page, betaId, `CB${stamp}-POST1`, "POST_TEST");
  return { stamp, alpha: { ...alpha, id: alphaId }, beta: { ...beta, id: betaId } };
}

test("cards count each training's tests, and View Questions shows only that training and test", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, ACCOUNTS.admin);
  const { stamp, alpha, beta } = await setup(page);

  await page.goto("/lnd/questions");
  await expect(page.getByRole("heading", { name: "Question Bank", level: 1 })).toBeVisible();
  await cardSearch(page).fill(`Cards Alpha ${stamp}`);
  await expect(page).toHaveURL(new RegExp(`/lnd/questions\\?q=Cards\\+Alpha\\+${stamp}$`));
  await expect(page.locator("article.question-card")).toHaveCount(2);
  await expect(card(page, alpha.title, "Pre-test").locator(".question-card-count strong")).toHaveText("2"); // PRE1 + legacy BOTH1
  await expect(card(page, alpha.title, "Post-test").locator(".question-card-count strong")).toHaveText("3"); // POST1, POST2 + BOTH1

  // Post-test table: the existing table, restricted on the server.
  await card(page, alpha.title, "Post-test").getByRole("link", { name: /View Questions/ }).click();
  await expect(page).toHaveURL(new RegExp(`/lnd/questions/${alpha.id}/post-test\\?q=Cards\\+Alpha\\+${stamp}$`));
  await expect(page.getByRole("heading", { name: alpha.title, level: 1 })).toBeVisible();
  await expect(page.getByText("Test type:")).toContainText("Post-test");
  for (const header of ["Question / Topic", "Trainings / Competency", "Type / Difficulty", "Marks / Language", "Version / Status", "Actions"]) {
    await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
  }
  const table = page.locator("table tbody");
  await expect(table.locator("tr")).toHaveCount(3);
  for (const code of ["POST1", "POST2", "BOTH1"]) await expect(table).toContainText(`CA${stamp}-${code}`);
  await expect(table).not.toContainText(`CA${stamp}-PRE1`);
  await expect(table).not.toContainText(`CB${stamp}`);
  const trainingFilter = page.getByRole("combobox", { name: "Training", exact: true });
  await expect(trainingFilter).toBeDisabled();
  await expect(trainingFilter).toHaveValue(alpha.id);

  // Other filters narrow inside the selection and never widen it.
  await page.getByLabel("Search questions").fill(`CA${stamp}-POST2`);
  await page.getByRole("button", { name: "Apply Filters" }).click();
  await expect(table.locator("tr")).toHaveCount(1);
  await page.getByLabel("Search questions").fill(`CB${stamp}-POST1`);
  await page.getByRole("button", { name: "Apply Filters" }).click();
  await expect(page.getByText("No questions match.")).toBeVisible();
  await page.getByLabel("Search questions").fill("");
  await page.getByRole("button", { name: "Apply Filters" }).click();
  await expect(table.locator("tr")).toHaveCount(3);

  // Preview and Deactivate still work; an inactive question stays listed and counted.
  const post2 = table.locator("tr").filter({ hasText: `CA${stamp}-POST2` });
  await post2.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("dialog")).toContainText("Admin Preview");
  await page.keyboard.press("Escape");
  await post2.getByRole("button", { name: "Deactivate" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(post2).toContainText("Inactive");
  await expect(table.locator("tr")).toHaveCount(3);

  // Refresh keeps the training and test.
  await page.reload();
  await expect(page.getByRole("heading", { name: alpha.title, level: 1 })).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(3);

  // Pre-test table: the pre-test question and the legacy one only.
  await page.goto(`/lnd/questions/${alpha.id}/pre-test`);
  await expect(page.getByText("Test type:")).toContainText("Pre-test");
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table).toContainText(`CA${stamp}-PRE1`);
  await expect(table).toContainText(`CA${stamp}-BOTH1`);
  await expect(table).not.toContainText(`CA${stamp}-POST1`);

  // Beta never shows Alpha's questions.
  await page.goto(`/lnd/questions/${beta.id}/post-test`);
  await expect(table.locator("tr")).toHaveCount(1);
  await expect(table).toContainText(`CB${stamp}-POST1`);
  await page.goto(`/lnd/questions?q=${encodeURIComponent(beta.title)}`);
  await expect(card(page, beta.title, "Post-test")).toHaveCount(1);
  await expect(card(page, beta.title, "Pre-test")).toHaveCount(0);
  // Direct links to an empty test still render the existing empty question table.
  await page.goto(`/lnd/questions/${beta.id}/pre-test`);
  await expect(page.getByText("No questions match.")).toBeVisible();
});

test("Add Question and Import Questions keep the training and test, and the card counts refresh", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, ACCOUNTS.admin);
  const { stamp, alpha } = await setup(page);
  const search = `Cards Alpha ${stamp}`;
  await page.goto(`/lnd/questions?q=${encodeURIComponent(search)}`);
  await expect(card(page, alpha.title, "Pre-test").locator(".question-card-count strong")).toHaveText("2");
  await card(page, alpha.title, "Pre-test").getByRole("link", { name: /View Questions/ }).click();
  await expect(page.getByText("Test type:")).toContainText("Pre-test");

  // Add Question: the training starts ticked and the new question is linked for the pre-test only.
  await page.getByRole("button", { name: "Add Question" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox", { name: alpha.title })).toBeChecked();
  await dialog.getByLabel("Question ID (optional)").fill(`CA${stamp}-NEWPRE`);
  await dialog.getByLabel("Question text *").fill(`CA${stamp} added from the pre-test?`);
  await dialog.getByLabel(/Options \*/).fill("Right\nWrong");
  await dialog.getByLabel(/Correct option number/).fill("1");
  await dialog.getByLabel("Topic *").fill("Cards");
  await dialog.getByRole("button", { name: "Save question" }).click();
  const table = page.locator("table tbody");
  await expect(table).toContainText(`CA${stamp}-NEWPRE`);
  await expect(table.locator("tr").filter({ hasText: `CA${stamp}-NEWPRE` })).toContainText("(Pre-test)");
  await page.goto(`/lnd/questions/${alpha.id}/post-test`);
  await expect(table).not.toContainText(`CA${stamp}-NEWPRE`);
  await page.goBack();
  await expect(page.getByText("Test type:")).toContainText("Pre-test");

  // Import Questions arrives with the question import, training and test chosen.
  await page.getByRole("link", { name: "Import Questions" }).click();
  await expect(page).toHaveURL(/\/lnd\/imports\?/);
  await expect(page.getByLabel("Import type")).toHaveValue("QUESTIONS");
  await expect(page.getByLabel("Select training *")).toHaveValue(alpha.id);
  await expect(page.getByLabel("Test type *")).toHaveValue("PRE_TEST");
  const header = "question,option_a,option_b,option_c,option_d,correct,topic";
  const rows = [1, 2].map((n) => `CA${stamp} imported ${n}?,Right,Wrong,Maybe,Never,A,Topic`);
  await page.locator('input[type="file"]').setInputFiles({ name: "questions.csv", mimeType: "text/csv", buffer: Buffer.from([header, ...rows].join("\n")) });
  await page.getByRole("button", { name: "Validate file" }).click();
  await page.getByRole("button", { name: "Import 2 valid rows" }).click();
  const back = page.locator("#import-preview, #import-summary").getByRole("link", { name: "Open in Question Bank" }).first();
  await expect(back).toHaveAttribute("href", `/lnd/questions/${alpha.id}/pre-test`);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/lnd/questions/${alpha.id}/pre-test$`));
  await expect(table).toContainText(`CA${stamp} imported 1?`);
  await expect(table.locator("tr")).toHaveCount(5); // PRE1, BOTH1, NEWPRE + 2 imported

  // Back to Trainings: the cards show the new counts (pre-test 2 → 5, post-test unchanged at 3).
  await page.goto(`/lnd/questions/${alpha.id}/pre-test?q=${encodeURIComponent(search)}`);
  await page.getByRole("link", { name: "Back to Trainings" }).click();
  await expect(cardSearch(page)).toHaveValue(search);
  await expect(card(page, alpha.title, "Pre-test").locator(".question-card-count strong")).toHaveText("5");
  await expect(card(page, alpha.title, "Post-test").locator(".question-card-count strong")).toHaveText("3");
});

test("navigation keeps the context, and unknown links and searches show clear empty states", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, ACCOUNTS.admin);
  const { stamp, alpha } = await setup(page);
  const search = `Cards Alpha ${stamp}`;

  await page.goto("/lnd/questions");
  await cardSearch(page).fill(search);
  await card(page, alpha.title, "Post-test").getByRole("link", { name: /View Questions/ }).click();
  await expect(page.getByText("Test type:")).toContainText("Post-test");
  // Browser Back returns to the cards with the search kept; Forward reopens the same table.
  await page.goBack();
  await expect(cardSearch(page)).toHaveValue(search);
  await expect(page.locator("article.question-card")).toHaveCount(2);
  await page.goForward();
  await expect(page.getByRole("heading", { name: alpha.title, level: 1 })).toBeVisible();
  await expect(page.getByText("Test type:")).toContainText("Post-test");

  // An older link with only a training shows that training's cards.
  await page.goto(`/lnd/questions?training_id=${alpha.id}`);
  await expect(cardSearch(page)).toHaveValue(alpha.title);
  await expect(page).toHaveURL(/\/lnd\/questions\?q=/);

  await cardSearch(page).fill(`no training ${stamp}`);
  await expect(page.getByText(`No question sets match “no training ${stamp}”.`)).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(cardSearch(page)).toHaveValue("");

  await page.goto("/lnd/questions/00000000-0000-4000-8000-000000000000/post-test");
  await expect(page.getByRole("heading", { name: "Training not found" })).toBeVisible();
  await page.goto(`/lnd/questions/${alpha.id}/mid-test`);
  await expect(page.getByRole("heading", { name: "Training not found" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Trainings" }).click();
  await expect(page).toHaveURL(/\/lnd\/questions$/);
});

test("the cards and the restricted list are for L&D Admin only", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const { alpha } = await setup(page);
  await page.context().clearCookies();
  await signIn(page, ACCOUNTS.employee);
  expect((await call(page, "GET", "/admin/questions/summary")).status).toBe(403);
  expect((await call(page, "GET", `/admin/questions?training_id=${alpha.id}&test_type=PRE_TEST`)).status).toBe(403);
  await page.goto("/lnd/questions");
  await expect(page.getByRole("link", { name: /View Questions/ })).toHaveCount(0);
});
