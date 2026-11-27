import { expect, test, type BrowserContext } from "@playwright/test";

// Every API is intercepted: these tests never submit anything to an application database.
const standard = ["Very Poor", "Poor", "Neutral", "Good", "Excellent"].map((label, i) => ({ value: i + 1, label }));
const trainer = [{ value: 2, label: "Fair" }, { value: 4, label: "Very good" }, { value: 5, label: "Exceptional" }, { value: 3, label: "Average" }, { value: 1, label: "Below average" }];
const fields = [
  ["satisfaction", "Overall Training Satisfaction", "How satisfied are you with the training quality and effectiveness?"],
  ["role_relevance", "Training Content Relevance & Clarity", "The training content was directly relevant to my role and responsibilities."],
  ["objectives", "Training Content Relevance & Clarity", "The learning objectives were clearly defined from the start."],
  ["applicability", "Training Content Relevance & Clarity", "The topics covered were applicable to real-world scenarios in my job."],
  ["interaction", "Training Delivery & Engagement", "Interactive elements (e.g., discussions, Q&A) kept me involved throughout the session."],
  ["pace", "Training Delivery & Engagement", "The session's pace and structure held my attention effectively."],
  ["trainer_preparation", "Trainer Expertise & Preparation", "The session was well-prepared and organized."],
  ["materials", "Training Materials & Resources", "The overall quality of the materials met or exceeded my expectations."],
  ["environment", "Training Environment & Logistics", "The training environment (physical or virtual) was conducive to learning."],
  ["logistics", "Training Environment & Logistics", "Any technical or logistical issues were minimal and quickly resolved."],
];
const questions = fields.map(([key, section, text], i) => ({ key, section, text, short_label: section, stars: i === 0, options: i === 0 ? standard.map((o) => ({ ...o, label: `${o.value} star${o.value === 1 ? "" : "s"}` })) : key.startsWith("trainer_") ? trainer : standard, low_label: i === 0 ? "1 star" : key.startsWith("trainer_") ? "Below average" : "Very Poor", high_label: i === 0 ? "5 stars" : key.startsWith("trainer_") ? "Exceptional" : "Excellent" }));
const AT = "2026-11-27T06:00:00Z";

async function mockApi(context: BrowserContext, { failFirst = false, pretest = false, admin = false } = {}) {
  let submitted: { ratings: Record<string, number>; comment: string | null; submitted_at: string } | null = null;
  let attempts = 0;
  const posts: { ratings: Record<string, number>; comment: string | null }[] = [];
  const unknown: string[] = [];
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic; path=/"; });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-user", employee_id: "synthetic-employee", full_name: "Synthetic Employee", roles: admin ? ["LD_ADMIN", "EMPLOYEE"] : ["EMPLOYEE"], primary_role: admin ? "LD_ADMIN" : "EMPLOYEE", features: { behaviour: false } } });
    if (path === "/me/access-state") return json({ access_status: !submitted && !pretest && !admin ? "FEEDBACK_REQUIRED" : "DASHBOARD_ALLOWED", queue: [], pending_count: 0, feedback_due: { attempt_id: "synthetic-result", obligation_id: "synthetic-obligation" } });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (["/admin/trainings", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"].includes(path)) return json([]);
    if (path === "/attempts/synthetic-result/result") return json({ attempt_id: "synthetic-result", assessment_type: pretest ? "PRE_TEST" : "POST_TEST", training_title: "Synthetic Training", attempt_status: "SUBMITTED", attempt_number: 1, max_attempts: 3, attempts_remaining: 2, score_percent: 80, result_status: "PASSED", pass_mark_percent: 70, obtained_marks: 8, total_marks: 10, submitted_at: AT, submission_reason: "MANUAL", time_taken_seconds: 120, question_count: 10, answered_count: 10, correct_count: 8, first_score: 80, best_score: 80, latest_score: 80, topics: [], explanations_enabled: false, answer_review: [], needs_retraining: false, retake_pending: false, refresher: null, interruptions: 0, violations: [] });
    if (path === "/attempts/synthetic-result/feedback") {
      if (request.method() === "POST") {
        attempts++;
        if (failFirst && attempts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Please try again." } }) });
        const body = request.postDataJSON();
        posts.push(body);
        submitted = { ...body, submitted_at: AT };
      }
      return json({ required: !submitted && !pretest, training_title: "Synthetic Training", questions, submitted });
    }
    if (path === "/admin/feedback") {
      const ratings = Object.fromEntries(fields.map(([key]) => [key, 5]));
      return json({ questions, training_options: [], summary: { responses: 1, trainings: 1, averages: ratings, overall: 5 }, trainings: [{ training_id: "synthetic-training", training_title: "Synthetic Training", training_code: "SYN", responses: 1, averages: ratings, overall: 5, latest_at: AT }], responses: [{ id: "synthetic-response", employee_name: "Synthetic Employee", employee_code: "SYN", department: "Operations", training_title: "Synthetic Training", score_percent: 80, result_status: "PASSED", ratings, average: 5, comment: "Useful training.", submitted_at: AT }] });
    }
    unknown.push(path);
    return route.fulfill({ status: 404, body: "Unmocked API" });
  });
  return { posts, unknown };
}

for (const mobile of [false, true]) {
  test(`official training feedback submits all 10 answers on ${mobile ? "mobile" : "desktop"}`, async ({ page, context }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const world = await mockApi(context);
    await page.goto("/results/synthetic-result");
    const dialog = page.getByRole("dialog", { name: "Training Feedback Form" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".feedback-section")).toHaveCount(6);
    await expect(dialog.getByRole("radiogroup")).toHaveCount(10);
    await expect(dialog.getByRole("radiogroup", { name: "The session was well-prepared and organized.", exact: true })).toHaveCount(1);
    await expect(dialog.getByRole("textbox")).toHaveCount(1); // No employee-detail fields.
    await expect(dialog.getByRole("button", { name: "Submit feedback" })).toBeDisabled();
    await expect(dialog.locator(".feedback-stars svg")).toHaveCount(5);
    await page.screenshot({ path: testInfo.outputPath("training-feedback.png"), fullPage: true });
    if (!mobile) {
      // A tall desktop viewport captures all seven sections without changing the application styles.
      await page.setViewportSize({ width: 1280, height: 2800 });
      await dialog.screenshot({ path: testInfo.outputPath("full-training-feedback.png") });
      await dialog.locator(".feedback-section").nth(3).screenshot({ path: testInfo.outputPath("trainer-section.png") });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    const groups = dialog.getByRole("radiogroup");
    for (let i = 0; i < 9; i++) await groups.nth(i).getByRole("radio", { name: i === 0 ? "5 stars" : i === 6 ? "Exceptional" : "Excellent", exact: true }).check();
    await expect(dialog).toContainText("9 of 10 rated");
    await expect(dialog.getByRole("button", { name: "Submit feedback" })).toBeDisabled();
    await groups.nth(9).getByRole("radio", { name: "Excellent", exact: true }).check();
    const dimensions = await dialog.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    await dialog.getByRole("textbox").fill("  Useful training.  ");
    await dialog.getByRole("button", { name: "Submit feedback" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Thank you for your feedback.", { exact: true })).toBeVisible();
    expect(world.posts).toEqual([{ ratings: Object.fromEntries(fields.map(([key]) => [key, 5])), comment: "Useful training." }]);
    expect(world.unknown).toEqual([]);
  });
}

test("submission failure keeps the 10 answers for retry; comments stay optional", async ({ page, context }) => {
  const world = await mockApi(context, { failFirst: true });
  await page.goto("/results/synthetic-result");
  const dialog = page.getByRole("dialog", { name: "Training Feedback Form" });
  await expect(dialog.getByRole("radiogroup")).toHaveCount(10);
  for (const group of await dialog.getByRole("radiogroup").all()) await group.getByRole("radio").first().check();
  await dialog.getByRole("button", { name: "Submit feedback" }).click();
  await expect(dialog).toContainText("Please try again.");
  await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(10);
  await dialog.getByRole("button", { name: "Submit feedback" }).click();
  await expect(dialog).toHaveCount(0);
  expect(world.posts[0].comment).toBeNull();
  expect(world.unknown).toEqual([]);
});

test("pre-tests still show no feedback form", async ({ page, context }) => {
  await mockApi(context, { pretest: true });
  await page.goto("/results/synthetic-result");
  await expect(page.getByRole("heading", { name: "Pre-test complete" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("L&D feedback report displays the official question ratings", async ({ page, context }) => {
  const world = await mockApi(context, { admin: true });
  await page.goto("/lnd/feedback");
  await expect(page.getByRole("heading", { name: "Training Feedback", exact: true })).toBeVisible();
  await expect(page.locator(".feedback-average")).toHaveCount(10);
  await expect(page.locator(".feedback-rating-cell")).toHaveCount(10);
  await expect(page.getByRole("row", { name: /Synthetic Employee/ })).toContainText("Useful training.");
  expect(world.unknown).toEqual([]);
});
