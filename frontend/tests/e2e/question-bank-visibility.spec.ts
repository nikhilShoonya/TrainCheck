import { expect, test, type BrowserContext } from "@playwright/test";

// Synthetic responses only: run against an isolated frontend pointing BACKEND_URL at an unused port.
const ID = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const EMPTY_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const card = (test_type: "PRE_TEST" | "POST_TEST", question_count: number, training_id = ID, title = "Synthetic HR") => ({
  training_id, title, code: training_id === ID ? "SYNTHETIC" : "EMPTY", status: "DRAFT", test_type,
  question_count, active: question_count, inactive: 0, unclassified: 0,
});

async function mockApi(context: BrowserContext, cards: ReturnType<typeof card>[]) {
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic; path=/"; });
  await context.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", full_name: "Synthetic Admin", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false } } });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, next_change_at: null, countdown: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/admin/questions/summary") return json(cards);
    if (route.request().method() !== "GET") throw new Error(`Unexpected mutation: ${path}`);
    return json([]);
  });
}

for (const testType of ["PRE_TEST", "POST_TEST"] as const) {
  test(`only the linked ${testType} card appears; zero-count tests and trainings stay hidden`, async ({ context, page }) => {
    const cards = [card("PRE_TEST", testType === "PRE_TEST" ? 3 : 0), card("POST_TEST", testType === "POST_TEST" ? 3 : 0), card("PRE_TEST", 0, EMPTY_ID, "Empty training"), card("POST_TEST", 0, EMPTY_ID, "Empty training")];
    await mockApi(context, cards);
    await page.goto("/lnd/questions");
    const shown = page.locator("article.question-card");
    await expect(shown).toHaveCount(1);
    await expect(shown.locator(".question-card-pill")).toHaveText(testType === "PRE_TEST" ? "Pre-test" : "Post-test");
    await expect(shown.locator(".question-card-count strong")).toHaveText("3");
    await expect(shown.getByRole("link", { name: /View Questions/ })).toHaveAttribute("href", `/lnd/questions/${ID}/${testType === "PRE_TEST" ? "pre-test" : "post-test"}`);
    await expect(page.getByText("1 training.", { exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search trainings", exact: true }).fill("Empty training");
    await expect(shown).toHaveCount(0);
    await expect(page.getByText("No question sets match “Empty training”.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(shown).toHaveCount(1);
  });
}

test("empty Question Bank offers import, then shows only newly linked tests after refresh", async ({ context, page }) => {
  const cards: ReturnType<typeof card>[] = [];
  await mockApi(context, cards);
  await page.goto("/lnd/questions");
  await expect(page.getByText("No questions linked yet.", { exact: true })).toBeVisible();
  await expect(page.locator("article.question-card")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Import Questions", exact: true })).toHaveAttribute("href", "/lnd/imports?type=QUESTIONS");
  cards.push(card("POST_TEST", 2));
  await page.reload();
  await expect(page.locator("article.question-card")).toHaveCount(1);
  await expect(page.locator(".question-card-pill")).toHaveText("Post-test");
  cards.push(card("PRE_TEST", 4));
  await page.reload();
  await expect(page.locator("article.question-card")).toHaveCount(2);
  await expect(page.getByText("1 training.", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/question-bank-linked-cards.png", fullPage: true });
});

test("an older response with only zero-count cards shows the question-specific empty state", async ({ context, page }) => {
  await mockApi(context, [card("PRE_TEST", 0), card("POST_TEST", 0)]);
  await page.goto("/lnd/questions");
  await expect(page.locator("article.question-card")).toHaveCount(0);
  await expect(page.getByText("No questions linked yet.", { exact: true })).toBeVisible();
});
