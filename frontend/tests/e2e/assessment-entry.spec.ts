import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/* Entering an assessment from My Trainings: the card's action, the countdown before the opening time, the hand-over
   to the gate once the server confirms the assessment is due, resuming, re-syncing and rescheduling.
   Mocked API (no backend or database). The test drives two clocks separately: the server's (`world.now`) and the
   browser's (Playwright's clock), so a changed device clock can be simulated. The server still refuses early starts
   and enforces the gate on its own regardless (backend tests/test_assessment_entry.py).
   Run: npx playwright test tests/e2e/assessment-entry.spec.ts */

const ACCOUNT = "u0000000-0000-4000-8000-000000000003";
const T0 = new Date("2026-11-19T09:50:00Z");
const OPENS = "2026-11-19T10:00:00+00:00"; // 15:30 in Asia/Kolkata, ten minutes after T0.
const TITLE = "Synthetic KYC Basics";

interface World {
  now: number; // The server's clock.
  dueAt: string;
  entry: "AUTO" | "IN_PROGRESS" | "UNAVAILABLE";
  offline: boolean;
  starts: number; // Attempt-start requests: must stay 0 while waiting.
  detailCalls: number;
  /** While set, the assessment's details are held back, as on a slow connection. */
  holdDetail: Promise<void> | null;
}

const newWorld = (over: Partial<World> = {}): World => ({ now: T0.getTime(), dueAt: OPENS, entry: "AUTO", offline: false, starts: 0, detailCalls: 0, holdDetail: null, ...over });

function entryState(world: World) {
  if (world.entry === "IN_PROGRESS") return "IN_PROGRESS";
  if (world.entry === "UNAVAILABLE") return "UNAVAILABLE";
  return Date.parse(world.dueAt) <= world.now ? "OPEN" : "NOT_YET_OPEN";
}

function detail(world: World) {
  const state = entryState(world);
  return {
    obligation_id: "o1",
    training_id: "t1",
    training_title: TITLE,
    training_description: "Synthetic training for tests.",
    question_count: 10,
    duration_seconds: 900,
    pass_mark_percent: 70,
    max_attempts: 3,
    attempts_used: 0,
    due_at: world.dueAt,
    in_progress: state === "IN_PROGRESS",
    refresher_required: false,
    queue_order: 1,
    entry_state: state,
    entry_reason: state === "UNAVAILABLE" ? "QUESTION_POOL_INSUFFICIENT" : null,
    entry_message: state === "UNAVAILABLE" ? "This assessment cannot start yet because its question pool is incomplete. L&D has been notified, and you can keep using TrainCheck until it is ready." : null,
    server_now: new Date(world.now).toISOString(),
    timezone: "Asia/Kolkata",
    status: state === "IN_PROGRESS" ? "IN_PROGRESS" : "SCHEDULED",
    active_attempt_id: state === "IN_PROGRESS" ? "a1" : null,
    violation_limit: 3,
    require_fullscreen: true,
    refresher: { text: null, url: null },
  };
}

const card = (over: Record<string, unknown>) => ({
  enrolment_id: "e1",
  training_id: "t1",
  title: TITLE,
  category: null,
  description: "Synthetic training for tests.",
  trainer: null,
  batch: "Batch 1",
  assigned_at: "2026-11-01T00:00:00+00:00",
  completed_at: "2026-11-18T00:00:00+00:00",
  attendance_status: "PRESENT",
  result: "PENDING",
  assessment_state: "Scheduled",
  first_score: null,
  best_score: null,
  latest_score: null,
  attempts: 0,
  latest_attempt_id: null,
  obligation_id: "o1",
  due_at: OPENS,
  planned_at: null,
  timezone: "Asia/Kolkata",
  retake_pending: false,
  refresher_acknowledged: false,
  question_count: 10,
  duration_minutes: 15,
  pass_mark_percent: 70,
  max_attempts: 3,
  pre_test_available: false,
  pre_test_score: null,
  entry_state: "NOT_YET_OPEN",
  entry_reason: null,
  entry_message: null,
  pending_group: "UPCOMING",
  feedback_required: false,
  materials: [],
  ...over,
});

async function mockApi(context: BrowserContext, world: World) {
  await context.addCookies([{ name: "tc_csrf", value: "synthetic", url: test.info().project.use.baseURL ?? "http://localhost:3000" }]);
  await context.route("**/api/v1/**", async (route) => {
    if (world.offline) return route.abort("internetdisconnected");
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data, meta: {} } : data) });
    if (path === "/auth/me")
      return json({ user: { id: ACCOUNT, employee_id: "emp3", employee_code: "E3", full_name: "Synthetic Employee", email: "synthetic3@example.test", department: null, function: null, location: null, grade: null, roles: ["EMPLOYEE"], primary_role: "EMPLOYEE" } });
    if (path === "/me/access-state") {
      const state = entryState(world);
      const required = state === "OPEN" || state === "IN_PROGRESS";
      const d = detail(world);
      return json({
        access_status: required ? "ASSESSMENT_REQUIRED" : "DASHBOARD_ALLOWED",
        pending_count: required ? 1 : 0,
        next_action: required ? "COMPLETE_ASSESSMENT" : "OPEN_DASHBOARD",
        queue: required ? [d] : [],
        unavailable: [],
        feedback_due: null,
        next_change_at: required ? null : world.dueAt,
        server_now: new Date(world.now).toISOString(),
      });
    }
    if (path === "/me/assessment-obligations/o1") {
      world.detailCalls += 1;
      if (world.holdDetail) await world.holdDetail;
      return json(detail(world));
    }
    if (path === "/assessment-obligations/o1/attempts" && request.method() === "POST") {
      world.starts += 1;
      return json({ error: { code: "ASSESSMENT_NOT_DUE", message: "This assessment is not open yet." } }, 409);
    }
    if (path === "/attempts/a1")
      return json({ attempt_id: "a1", obligation_id: "o1", assessment_type: "POST_TEST", training_title: TITLE, attempt_number: 1, max_attempts: 3, status: "IN_PROGRESS", started_at: new Date(world.now - 600_000).toISOString(), expires_at: new Date(world.now + 300_000).toISOString(), server_now: new Date(world.now).toISOString(), remaining_seconds: 300, violation_count: 0, violation_limit: 3, require_fullscreen: true, monitored: true, questions: [] });
    if (path === "/me/trainings")
      return json([
        card({}),
        card({ enrolment_id: "e2", training_id: "t2", title: "Synthetic Data Protection", obligation_id: null, due_at: null, completed_at: null, planned_at: "2026-11-21T04:30:00+00:00", entry_state: "UNAVAILABLE", entry_reason: "AWAITING_COMPLETION", entry_message: "Awaiting training completion. Your assessment is created when L&D records that you completed the training.", pending_group: "UNFINISHED", assessment_state: "Awaiting training completion" }),
      ]);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

/** Moves the server's and the browser's clocks forward together. */
async function advance(page: Page, world: World, ms: number) {
  world.now += ms;
  await page.clock.fastForward(ms);
}

const countdownHeading = (page: Page) => page.getByRole("heading", { name: /Your assessment opens in/ });

async function openWaiting(context: BrowserContext, page: Page, world: World) {
  await mockApi(context, world);
  await page.clock.install({ time: T0 });
  await page.goto("/assessment/start/o1");
}

test.describe("assessment entry from My Trainings (mocked API)", () => {
  test("the card shows the opening time, a Start Test action and why there is no action before completion", async ({ context, page }) => {
    await mockApi(context, newWorld());
    await page.clock.install({ time: T0 });
    await page.goto("/employee/trainings");
    const titles = page.locator("article.course-card h2");
    await expect(titles).toHaveText([TITLE, "Synthetic Data Protection"]); // The server's pending-first order is kept.

    const scheduled = page.locator("article.course-card", { hasText: TITLE });
    await expect(scheduled).toContainText("Assessment opens 2026-11-19 15:30 (Asia/Kolkata)");
    await expect(scheduled).toContainText("Selecting Start Test before the opening time shows a countdown");
    await expect(scheduled.getByRole("link", { name: "Start Test" })).toHaveAttribute("href", "/assessment/start/o1");

    const awaiting = page.locator("article.course-card", { hasText: "Synthetic Data Protection" });
    await expect(awaiting).toContainText("Awaiting training completion");
    await expect(awaiting).toContainText("Planned opening 2026-11-21 10:00 (Asia/Kolkata), only once your completion is recorded");
    await expect(awaiting.getByRole("link", { name: /Start Test|Resume Test/ })).toHaveCount(0);
  });

  test("before the opening time: a live countdown, no attempt and no questions", async ({ context, page }) => {
    const world = newWorld();
    await openWaiting(context, page, world);
    await expect(countdownHeading(page)).toContainText("00:10:00");
    await expect(page.getByText("Opens 2026-11-19 15:30 (Asia/Kolkata)")).toBeVisible();
    // The time is part of the heading's accessible name, not only its visible text.
    await expect(page.getByRole("heading", { name: "Your assessment opens in 00:10:00", exact: true })).toBeVisible();
    await advance(page, world, 60_000);
    await expect(countdownHeading(page)).toContainText("00:09:00");
    await advance(page, world, 4 * 60_000 + 500);
    await expect(page.locator(".assessment-waiting").getByRole("status")).toContainText("Your assessment opens in 5 minutes.");
    await expect(page.locator(".exam-option, .exam-timer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Start assessment/ })).toHaveCount(0);
    expect(world.starts).toBe(0);
  });

  test("at the opening time the backend is asked again and the usual Start flow follows", async ({ context, page }) => {
    const world = newWorld();
    await openWaiting(context, page, world);
    await expect(countdownHeading(page)).toContainText("00:10:00");
    const before = world.detailCalls;
    await advance(page, world, 9 * 60_000 + 58_000);
    await expect(page).toHaveURL(/\/assessment\/start\/o1/); // Not before the moment.
    await advance(page, world, 3_000);
    await page.waitForURL(/\/access\/assessment-required/);
    expect(world.detailCalls).toBeGreaterThan(before); // Re-checked with the server, not decided by the device.
    await expect(page.getByRole("button", { name: /Start assessment/ })).toBeVisible();
    expect(world.starts).toBe(0); // The employee still goes through the system check and instructions.
  });

  test("an already-due assessment goes straight to the assessment entry", async ({ context, page }) => {
    const world = newWorld({ now: Date.parse(OPENS) + 60_000 });
    await mockApi(context, world);
    await page.clock.install({ time: new Date(world.now) });
    await page.goto("/assessment/start/o1");
    await page.waitForURL(/\/access\/assessment-required/);
    await expect(page.getByRole("button", { name: /Start assessment/ })).toBeVisible();
    expect(world.starts).toBe(0);
  });

  test("a running attempt resumes with the server's remaining time", async ({ context, page }) => {
    const world = newWorld({ now: Date.parse(OPENS) + 600_000, entry: "IN_PROGRESS" });
    await mockApi(context, world);
    await page.clock.install({ time: new Date(world.now) });
    await page.goto("/assessment/start/o1");
    await page.waitForURL(/\/access\/assessment-required/);
    await expect(page.getByRole("heading", { name: "Resume in full screen" })).toBeVisible();
    await expect(page.getByText("05:00 remain")).toBeVisible();
    expect(world.starts).toBe(0);
  });

  test("the gate names the action Resume for a running attempt, even before its details arrive", async ({ context, page }) => {
    let release = () => {};
    const world = newWorld({ now: Date.parse(OPENS) + 600_000, entry: "IN_PROGRESS", holdDetail: new Promise<void>((resolve) => (release = resolve)) });
    await mockApi(context, world);
    await page.goto("/access/assessment-required");
    await expect(page.getByRole("button", { name: /Resume assessment/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start assessment/ })).toHaveCount(0);
    release();
    await expect(page.getByRole("heading", { name: "Resume in full screen" })).toBeVisible();
    expect(world.starts).toBe(0);
  });

  test("a changed device clock neither opens it early nor changes the countdown", async ({ context, page }) => {
    const world = newWorld();
    await openWaiting(context, page, world);
    await expect(countdownHeading(page)).toContainText("00:10:00");
    await page.clock.setSystemTime(new Date(Date.parse(OPENS) + 3_600_000)); // The device now claims an hour after opening.
    await advance(page, world, 2_000);
    await expect(countdownHeading(page)).toContainText("00:09:58");
    await expect(page).toHaveURL(/\/assessment\/start\/o1/);
    expect(world.starts).toBe(0);
  });

  test("returning to the tab re-syncs, and a rescheduled opening is shown and announced", async ({ context, page }) => {
    const world = newWorld();
    await openWaiting(context, page, world);
    await expect(countdownHeading(page)).toContainText("00:10:00");
    world.dueAt = "2026-11-20T04:30:00+00:00"; // L&D moved it to 10:00 the next day.
    await advance(page, world, 6_000);
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByText("Opens 2026-11-20 10:00 (Asia/Kolkata)")).toBeVisible();
    await expect(countdownHeading(page)).toContainText("18:39:54");
    await expect(page.locator(".assessment-waiting").getByRole("status")).toContainText("The opening time changed");
  });

  test("a refresh keeps waiting, timed by the server again", async ({ context, page }) => {
    const world = newWorld();
    await openWaiting(context, page, world);
    await expect(countdownHeading(page)).toContainText("00:10:00");
    await advance(page, world, 120_000);
    await page.reload();
    await expect(countdownHeading(page)).toContainText("00:08:00");
    expect(world.starts).toBe(0);
  });

  test("offline at the opening time: it waits for the server instead of opening", async ({ context, page }) => {
    const world = newWorld();
    await openWaiting(context, page, world);
    await expect(countdownHeading(page)).toContainText("00:10:00");
    world.offline = true;
    await context.setOffline(true);
    await expect(page.getByText(/You are offline/)).toBeVisible();
    await advance(page, world, 10 * 60_000 + 2_000);
    await expect(page.getByText(/Waiting for a connection to confirm/)).toBeVisible();
    await expect(page).toHaveURL(/\/assessment\/start\/o1/);
    world.offline = false;
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForURL(/\/access\/assessment-required/);
    expect(world.starts).toBe(0);
  });

  test("an unavailable assessment shows the server's reason and no start action", async ({ context, page }) => {
    const world = newWorld({ now: Date.parse(OPENS) + 60_000, entry: "UNAVAILABLE" });
    await mockApi(context, world);
    await page.clock.install({ time: new Date(world.now) });
    await page.goto("/assessment/start/o1");
    await expect(page.getByText(/question pool is incomplete/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Start/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /My Trainings/ })).toBeVisible();
  });
});
