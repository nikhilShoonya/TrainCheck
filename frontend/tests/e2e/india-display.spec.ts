import { expect, test, type BrowserContext } from "@playwright/test";

/* Synthetic API only. Even a forgotten mock returns 404 rather than reaching a backend. */
const AT = "2026-11-23T20:55:00Z";
const SHOWN = "24-11-2026 02:25 AM";
const TRAINING = "11111111-1111-4111-8111-111111111111";
const ratings = { relevance: 4, clarity: 4, alignment: 4, fairness: 4, confidence: 4 };
const config = { question_count: 10, duration_minutes: 20, duration_seconds: 1200, pass_mark_percent: 70, max_attempts: 3, schedule_mode: "FIXED_DATE", schedule_date: "2026-11-23", schedule_time: "20:55", schedule_at: AT, timezone: "UTC", difficulty_mix: null, show_explanations: false, shuffle_questions: true, shuffle_options: true, violation_limit: 3, require_fullscreen: true };
const training = { id: TRAINING, title: "Synthetic India schedule", timezone: "UTC", config, config_ready: true, eligible_questions: 10, pretest_enabled: false };

async function mockApi(context: BrowserContext, unknown: string[], posts: Record<string, unknown>[]) {
  await context.addInitScript(() => { document.cookie = "tc_csrf=synthetic; path=/"; });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "synthetic-employee", employee_code: "SYN", full_name: "Synthetic Admin", email: "synthetic@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", queue: [], unavailable: [], pending_count: 0, feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: "2026-11-23T10:05:00Z" });
    if (path === "/me/notifications/unread-count") return json({ unread: 1 });
    if (path === "/me/notifications") return json([{ id: "synthetic-notification", title: "Synthetic notification", type: "SYNTHETIC", message: "Synthetic message", created_at: AT, read: false, link: null }]);
    if (path === "/me/trainings") return json([
      { training_id: "later", title: "Later opening", completed_at: null, due_at: "2026-11-02T07:30:00Z", planned_at: null, timezone: "UTC", assessment_state: "Scheduled", result: "PENDING", attempts: 0, latest_attempt_id: null },
      { training_id: "earlier", title: "Earlier opening", completed_at: null, due_at: "2026-10-30T10:55:00Z", planned_at: null, timezone: "UTC", assessment_state: "Scheduled", result: "PENDING", attempts: 0, latest_attempt_id: null },
    ]);
    if (path === "/admin/trainings") return json([training]);
    if (["/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"].includes(path)) return json([]);
    if (path === `/admin/trainings/${TRAINING}`) return json(training);
    if (path === `/admin/trainings/${TRAINING}/question-pool`) return json({ training_id: TRAINING, assessment_type: "POST_TEST", linked_total: 10, active: 10, inactive: 0, missing_answer_key: 0, missing_answer_key_codes: [], insufficient_options: 0, insufficient_options_codes: [], eligible: 10, eligible_by_difficulty: { EASY: 10, MEDIUM: 0, HARD: 0 }, suggested_question_count: 10, required: 10, shortfall: 0, difficulty_mix: null, mix_total: null, difficulty_shortfalls: [], reason: null, ready: true });
    if (path === `/admin/trainings/${TRAINING}/assessment-configs` && request.method() === "POST") {
      posts.push(request.postDataJSON());
      return json({ ...config, applied: null });
    }
    if (path === "/admin/feedback") return json({ questions: [], training_options: [], summary: { responses: 1, trainings: 1, averages: ratings, overall: 4 }, trainings: [{ training_id: TRAINING, training_code: "SYN", training_title: "Synthetic feedback", responses: 1, averages: ratings, overall: 4, latest_at: AT }], responses: [{ id: "synthetic-response", employee_name: "Synthetic Person", employee_code: "SYN-1", department: null, training_title: "Synthetic feedback", score_percent: 80, result_status: "PASSED", ratings, average: 4, comment: null, submitted_at: AT }] });
    if (path === "/reports/filter-options") return json({ departments: [], locations: [], trainings: [], trainers: [], grades: [] });
    if (path === "/reports/compliance") return json({ title: "Synthetic report", description: "Synthetic", columns: ["Employee"], rows: [["Synthetic Person"]], definitions: [] });
    if (path === "/reports/exports") return json([
      { id: "a", report_code: "Nov afternoon", export_format: "CSV", row_count: 1, created_at: "2026-11-02T07:30:00Z" },
      { id: "b", report_code: "October", export_format: "CSV", row_count: 1, created_at: "2026-10-30T10:55:00Z" },
      { id: "c", report_code: "Nov morning", export_format: "CSV", row_count: 1, created_at: "2026-11-02T05:30:00Z" },
    ]);
    if (path === "/reports/schedules") return json([{ id: "schedule", report_code: "Synthetic", cadence: "WEEKLY", export_format: "CSV", next_run_at: AT, is_active: true, deliveries: [] }]);
    if (path === "/attempts/synthetic-result/feedback") return json({ required: false, submitted: false, questions: [], feedback: null });
    if (path === "/attempts/synthetic-result/result") return json({ attempt_id: "synthetic-result", obligation_id: "synthetic-obligation", assessment_type: "POST_TEST", training_title: "Synthetic result", attempt_status: "SUBMITTED", attempt_number: 1, max_attempts: 3, attempts_remaining: 2, score_percent: 80, result_status: "PASSED", pass_mark_percent: 70, obtained_marks: 8, total_marks: 10, submitted_at: AT, submission_reason: "MANUAL", time_taken_seconds: 120, question_count: 10, answered_count: 10, correct_count: 8, first_score: 80, best_score: 80, latest_score: 80, topics: [], explanations_enabled: false, answer_review: [], needs_retraining: false, retake_pending: false, refresher: null, interruptions: 0, violations: [{ number: 1, type: "TAB_HIDDEN", signals: ["blur"], occurred_at: AT }] });
    unknown.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_MOCKED", message: "Synthetic mock missing." } }) });
  });
}

for (const timezoneId of ["UTC", "America/New_York"]) {
  test.describe(`India display on a ${timezoneId} device`, () => {
    test.use({ timezoneId });
    let unknown: string[], posts: Record<string, unknown>[];
    test.beforeEach(async ({ context, page }) => {
      unknown = []; posts = [];
      await mockApi(context, unknown, posts);
      await page.clock.setFixedTime(new Date("2026-11-23T10:05:00Z"));
    });
    test.afterEach(() => expect(unknown).toEqual([]));

    test("feedback and notifications show the India date and AM/PM without timezone suffixes", async ({ page }) => {
      await page.goto("/lnd/feedback");
      await expect(page.getByRole("row", { name: /Synthetic Person/ })).toContainText(SHOWN);
      await expect(page.locator('section[aria-labelledby="feedback-trainings-title"] tbody tr')).toContainText(SHOWN);
      await expect(page.locator("#main")).not.toContainText("UTC");
      await page.goto("/notifications");
      await expect(page.locator(".notification-item")).toContainText(SHOWN);
      await expect(page.locator(".notification-item")).not.toContainText("Asia/Kolkata");
    });

    test("report timestamps are India time and sort across months and AM/PM", async ({ page }) => {
      await page.goto("/lnd/reports");
      const downloads = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Downloads", exact: true }) });
      await downloads.getByRole("button", { name: "Sort by Generated", exact: true }).click();
      await expect(downloads.locator("tbody tr")).toHaveText([/October.*30-10-2026 04:25 PM/, /Nov morning.*02-11-2026 11:00 AM/, /Nov afternoon.*02-11-2026 01:00 PM/]);
      await downloads.getByRole("button", { name: "Sort by Generated", exact: true }).click();
      await expect(downloads.locator("tbody tr").first()).toContainText("Nov afternoon");
      const schedules = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Scheduled delivery", exact: true }) });
      await expect(schedules).toContainText(SHOWN);
      await expect(page.locator("#main")).not.toContainText("UTC");
    });

    test("result submission and violation log use the same India timestamp", async ({ page }) => {
      await page.goto("/results/synthetic-result");
      await expect(page.locator(".result-panel")).toContainText(`Submitted ${SHOWN}`);
      await page.getByText("Security events recorded (1)").click();
      await expect(page.locator(".violation-log li")).toContainText(SHOWN);
    });

    test("My Assessments keeps chronological sort keys separately from India display text", async ({ context, page }) => {
      await context.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { user: { id: "synthetic-employee", employee_id: "synthetic-employee", employee_code: "SYN", full_name: "Synthetic Employee", email: "synthetic@example.test", roles: ["EMPLOYEE"], primary_role: "EMPLOYEE", features: { behaviour: false, password_change: false } } }, meta: {} }) }));
      await page.goto("/employee/assessments");
      await page.getByRole("button", { name: "Sort by Next due date", exact: true }).click();
      await expect(page.locator("#main tbody tr")).toHaveText([/Earlier opening.*30-10-2026 04:25 PM/, /Later opening.*02-11-2026 01:00 PM/]);
    });

    test("scheduling reopens the same instant as India wall-clock input and submits ISO values", async ({ page }) => {
      await page.goto("/lnd/assessment-config");
      await page.getByRole("button", { name: "Assessment Rules", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Assessment date *", { exact: true })).toHaveValue("2026-11-24");
      await expect(dialog.getByLabel("Opening time *", { exact: true })).toHaveValue("02:25");
      await expect(dialog).toContainText(`Saved: opens ${SHOWN}`);
      await expect(dialog).not.toContainText("UTC");
      await expect(dialog).not.toContainText("Asia/Kolkata");
      await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0]).toMatchObject({ schedule_date: "2026-11-24", schedule_time: "02:25", schedule_timezone: "Asia/Kolkata" });
    });
  });
}
