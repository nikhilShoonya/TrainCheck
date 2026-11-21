import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* The automatic countdown with a manual assessment start, against a mocked API (no backend, no database, synthetic
   data only). The mock follows the backend's rules: access_state reports a countdown only within five minutes of the
   opening, a start before the opening is refused, and a repeated start returns the attempt already running.
   The server's clock (`world.now`) and the browser's (Playwright's clock) are moved forward together.
   The same rules are tested on the real backend in backend/tests/test_assessment_countdown.py.
   Run: npx playwright test tests/e2e/scheduled-start.spec.ts */

const ACCOUNT = "u0000000-0000-4000-8000-000000000007";
const OPENS = Date.parse("2026-11-19T10:00:00Z"); // 15:30 in Asia/Kolkata.
const TITLE = "Synthetic KYC Basics";
const OTHER = "Synthetic Data Protection";
const MIN = 60_000;
const QUESTIONS = ["q1", "q2"].map((id, i) => ({
  attempt_question_id: id,
  position: i + 1,
  question_text: `Synthetic question ${i + 1}`,
  question_type: "MCQ_SINGLE",
  topic: "Synthetic",
  language: "English",
  marks: 1,
  options: ["a", "b"].map((o, j) => ({ option_id: `${id}-${o}`, label: "AB"[j], text: `Option ${o.toUpperCase()}` })),
  selected_option_ids: [],
  revision: 0,
  op_id: null,
  marked_for_review: false,
  saved_at: null,
}));

interface World {
  now: number;
  dueAt: number;
  assigned: boolean;
  status: "SCHEDULED" | "CANCELLED";
  /** Another assessment, completed earlier, becomes due at the same moment: it comes first in the queue. */
  otherDueAt: number | null;
  admin: boolean;
  offline: boolean;
  attempt: boolean;
  /** Every POST that asked to start, and those that arrived before the opening (must stay 0). */
  starts: number;
  earlyStarts: number;
  /** When questions were first served (must be after the opening). */
  questionsAt: number | null;
  /** How the next start request is answered: "lost" creates the attempt but loses the answer; "lost-nothing" loses
      the request before anything is created. */
  startMode: "ok" | "lost" | "lost-nothing";
}

const newWorld = (over: Partial<World> = {}): World => ({
  now: OPENS - 3 * MIN,
  dueAt: OPENS,
  assigned: true,
  status: "SCHEDULED",
  otherDueAt: null,
  admin: false,
  offline: false,
  attempt: false,
  starts: 0,
  earlyStarts: 0,
  questionsAt: null,
  startMode: "ok",
  ...over,
});

const iso = (ms: number) => new Date(ms).toISOString();

function entry(world: World) {
  if (world.status === "CANCELLED") return { entry_state: "UNAVAILABLE", entry_reason: "CANCELLED", entry_message: "L&D cancelled this assessment. No action is needed." };
  if (world.attempt) return { entry_state: "IN_PROGRESS", entry_reason: null, entry_message: null };
  return { entry_state: world.dueAt <= world.now ? "OPEN" : "NOT_YET_OPEN", entry_reason: null, entry_message: null };
}

function item(world: World, id = "o1", title = TITLE, due = world.dueAt) {
  return {
    obligation_id: id,
    training_id: `t-${id}`,
    training_title: title,
    training_description: "Synthetic training for tests.",
    question_count: 2,
    duration_seconds: 900,
    pass_mark_percent: 70,
    max_attempts: 3,
    attempts_used: id === "o1" && world.attempt ? 1 : 0,
    due_at: iso(due),
    in_progress: id === "o1" && world.attempt,
    refresher_required: false,
    queue_order: 1,
  };
}

function detail(world: World) {
  return {
    ...item(world),
    ...entry(world),
    server_now: iso(world.now),
    timezone: "Asia/Kolkata",
    status: world.attempt ? "IN_PROGRESS" : world.status,
    active_attempt_id: world.attempt ? "a1" : null,
    violation_limit: 3,
    require_fullscreen: true,
    refresher: { text: null, url: null },
  };
}

function accessState(world: World) {
  const live = world.assigned && world.status === "SCHEDULED";
  const mineDue = live && (world.attempt || world.dueAt <= world.now);
  const otherDue = world.otherDueAt !== null && world.otherDueAt <= world.now;
  const queue = [...(otherDue ? [item(world, "o2", OTHER, world.otherDueAt!)] : []), ...(mineDue ? [item(world)] : [])];
  const left = world.dueAt - world.now;
  const waiting = live && !mineDue;
  return {
    access_status: queue.length ? "ASSESSMENT_REQUIRED" : "DASHBOARD_ALLOWED",
    pending_count: queue.length,
    next_action: queue.length ? "COMPLETE_ASSESSMENT" : "OPEN_DASHBOARD",
    queue,
    unavailable: [],
    feedback_due: null,
    countdown: !queue.length && waiting && left > 0 && left <= 5 * MIN ? { obligation_id: "o1", training_title: TITLE, due_at: iso(world.dueAt), timezone: "Asia/Kolkata" } : null,
    countdown_starts_at: waiting && left > 5 * MIN ? iso(world.dueAt - 5 * MIN) : null,
    next_change_at: waiting ? iso(world.dueAt) : null,
    server_now: iso(world.now),
  };
}

function attemptView(world: World) {
  world.questionsAt ??= world.now;
  return {
    attempt_id: "a1",
    obligation_id: "o1",
    assessment_type: "POST_TEST",
    training_title: TITLE,
    attempt_number: 1,
    max_attempts: 3,
    status: "IN_PROGRESS",
    started_at: iso(world.dueAt),
    expires_at: iso(world.dueAt + 15 * MIN),
    server_now: iso(world.now),
    remaining_seconds: Math.round((world.dueAt + 15 * MIN - world.now) / 1000),
    violation_count: 0,
    violation_limit: 3,
    require_fullscreen: true,
    monitored: true,
    questions: QUESTIONS,
  };
}

function user(world: World) {
  return {
    id: ACCOUNT,
    employee_id: "emp7",
    employee_code: "E7",
    full_name: "Synthetic Employee",
    email: "synthetic7@example.test",
    department: null,
    function: null,
    location: null,
    grade: null,
    roles: world.admin ? ["LD_ADMIN", "EMPLOYEE"] : ["EMPLOYEE"],
    primary_role: world.admin ? "LD_ADMIN" : "EMPLOYEE",
  };
}

async function mockApi(context: BrowserContext, world: World, signedIn = true) {
  if (signedIn) await context.addCookies([{ name: "tc_csrf", value: "synthetic", url: test.info().project.use.baseURL ?? "http://localhost:3000" }]);
  await context.route("**/api/v1/**", async (route: Route) => {
    if (world.offline) return route.abort("internetdisconnected");
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data, meta: {} } : data) });
    if (path === "/auth/login" && request.method() === "POST") {
      await context.addCookies([{ name: "tc_csrf", value: "synthetic", url: test.info().project.use.baseURL ?? "http://localhost:3000" }]);
      return json({ user: user(world), access_state: accessState(world), csrf_token: "synthetic" });
    }
    if (path === "/auth/me") return json({ user: user(world) });
    if (path === "/me/access-state") return json(accessState(world));
    if (path === "/system/ping") return json({ ok: true, server_now: iso(world.now) });
    if (path === "/me/assessment-obligations/o1") return world.assigned ? json(detail(world)) : json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    if (path === "/me/assessment-obligations/o2") return json({ ...item(world, "o2", OTHER, world.otherDueAt ?? world.dueAt), entry_state: "OPEN", entry_reason: null, entry_message: null, server_now: iso(world.now), timezone: "Asia/Kolkata", status: "DUE", active_attempt_id: null, violation_limit: 3, require_fullscreen: true, refresher: { text: null, url: null } });
    if (path === "/assessment-obligations/o1/attempts" && request.method() === "POST") {
      world.starts += 1;
      if (world.dueAt > world.now) {
        world.earlyStarts += 1;
        return json({ error: { code: "ASSESSMENT_NOT_DUE", message: "This assessment is not open yet." } }, 409);
      }
      if (world.otherDueAt !== null && world.otherDueAt <= world.now) return json({ error: { code: "ASSESSMENT_NOT_NEXT", message: "Complete your earlier assessment first." } }, 409);
      const mode = world.startMode;
      world.startMode = "ok";
      if (mode === "lost-nothing") return route.abort("connectionreset");
      world.attempt = true; // Idempotent, like the backend: a repeated start returns the attempt already running.
      if (mode === "lost") return route.abort("connectionreset");
      return json(attemptView(world));
    }
    if (path === "/attempts/a1") return json(attemptView(world));
    if (/^\/attempts\/a1\/security-events$/.test(path)) return json({ counted: false, violation_count: 0, violation_limit: 3, auto_submitted: false, status: "IN_PROGRESS" });
    if (/^\/attempts\/a1\/questions\/[^/]+\/answer$/.test(path)) return json({ saved_at: iso(world.now), selected_option_ids: [], revision: 1, op_id: null });
    if (path === "/notifications" || path.startsWith("/notifications?")) return json([]);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

/** Moves the server's and the browser's clocks forward together. */
async function advance(page: Page, world: World, ms: number) {
  world.now += ms;
  await page.clock.fastForward(ms);
}

async function setUp(context: BrowserContext, page: Page, world: World, signedIn = true) {
  await mockApi(context, world, signedIn);
  await page.clock.install({ time: new Date(world.now) });
}

async function signInMocked(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("synthetic7@example.test");
  await page.locator('input[name="password"]').fill("Synthetic-password-1");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const banner = (page: Page) => page.locator(".assessment-waiting");

/** The system check, full screen and the acknowledgement, done only after the assessment opens. */
async function prepare(page: Page, { acknowledge = true } = {}) {
  await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
  const proceed = page.getByRole("button", { name: /^Continue/ });
  await expect(proceed).toBeEnabled({ timeout: 15_000 });
  await proceed.click();
  await page.getByRole("button", { name: "Enter full screen" }).click();
  await expect(page.getByRole("heading", { name: "Assessment instructions" })).toBeVisible();
  if (acknowledge) await page.getByRole("checkbox", { name: /read and understood/ }).check();
}

test.describe("automatic countdown with a manual assessment start (mocked API)", () => {
  test("signing in less than five minutes before opens the countdown with the real time left, and creates nothing", async ({ context, page }) => {
    const world = newWorld({ now: OPENS - 3 * MIN });
    await setUp(context, page, world, false);
    await signInMocked(page);
    await expect(page).toHaveURL(/\/assessment\/start\/o1$/);
    await expect(banner(page).getByRole("heading", { level: 1 })).toHaveText(/Your assessment opens in 0[23]:\d\d/);
    await expect(banner(page)).toContainText("Opens 2026-11-19 15:30 (Asia/Kolkata)");
    await advance(page, world, 60_000);
    await expect(banner(page).getByRole("heading", { level: 1 })).toHaveText(/opens in 0[12]:\d\d/);
    await expect(page.locator(".exam-option, .exam-timer")).toHaveCount(0);
    expect(world.starts).toBe(0);
    expect(world.questionsAt).toBeNull();
  });

  test("signing in exactly five minutes before opens the countdown at 05:00", async ({ context, page }) => {
    const world = newWorld({ now: OPENS - 5 * MIN });
    await setUp(context, page, world, false);
    await signInMocked(page);
    await expect(page).toHaveURL(/\/assessment\/start\/o1$/);
    await expect(banner(page).getByRole("heading", { level: 1 })).toHaveText(/opens in 0[45]:\d\d/);
    expect(world.starts).toBe(0);
  });

  test("more than five minutes before: the workspace opens, and the countdown opens by itself at five minutes", async ({ context, page }) => {
    const world = newWorld({ now: OPENS - 5 * MIN - 2_000 });
    await setUp(context, page, world, false);
    await signInMocked(page);
    await expect(page).toHaveURL(/\/employee$/);
    await advance(page, world, 3_000); // The page re-checks with the server at the window's start, then follows it.
    await page.waitForURL(/\/assessment\/start\/o1$/);
    await expect(banner(page).getByRole("heading", { level: 1 })).toHaveText(/opens in 0[45]:\d\d/);
    expect(world.starts).toBe(0);
  });

  test("no assessment: the workspace stays open; one assigned while signed in is noticed without navigating", async ({ context, page }) => {
    const world = newWorld({ now: OPENS - 3 * MIN, assigned: false });
    await setUp(context, page, world, false);
    await signInMocked(page);
    await expect(page).toHaveURL(/\/employee$/);
    world.assigned = true; // L&D records a completion with a custom opening three minutes away.
    await advance(page, world, 61_000);
    await page.waitForURL(/\/assessment\/start\/o1$/, { timeout: 15_000 });
    expect(world.starts).toBe(0);
  });

  test("unsaved form input is never discarded silently, and nothing typed is stored", async ({ context, page }) => {
    const world = newWorld({ now: OPENS - 4 * MIN, assigned: false, admin: true });
    await setUp(context, page, world, false);
    await signInMocked(page);
    await page.goto("/profile");
    const field = page.getByLabel("Current password");
    await field.fill("Synthetic-secret-9");
    world.assigned = true;
    await advance(page, world, 61_000);
    const dialog = page.getByRole("dialog", { name: "Your assessment opens soon" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/profile$/);
    await dialog.getByRole("button", { name: "Stay to save my changes" }).click();
    await expect(field).toHaveValue("Synthetic-secret-9");
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain("Synthetic-secret-9");
    await page.getByRole("link", { name: "Dashboard" }).first().click(); // Leaving the page: the countdown follows.
    await page.waitForURL(/\/assessment\/start\/o1$/);
  });

  test("countdown expiry opens normal preparation; even acknowledgement never starts an attempt without Start", async ({ context, page }) => {
    const world = newWorld();
    await setUp(context, page, world);
    await page.goto("/assessment/start/o1");
    await expect(banner(page)).toContainText("03:00");
    await expect(page.getByRole("heading", { name: "Assessment instructions" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "System check" })).toHaveCount(0);
    await advance(page, world, 3 * MIN + 1_000);
    await page.waitForURL(/\/access\/assessment-required\?fromCountdown=o1$/);
    await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
    expect(world.starts).toBe(0);
    await prepare(page);
    await expect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeEnabled();
    await advance(page, world, 30_000);
    expect(world.starts).toBe(0);
    expect(world.questionsAt).toBeNull();
    await expect(page.locator(".exam-timer")).toHaveCount(0);
    await expect(page.getByText(/starts by itself|Starts by itself/)).toHaveCount(0);
    await page.screenshot({ path: "test-results/countdown-manual-instructions.png", fullPage: true });
    await page.getByRole("button", { name: "Start assessment", exact: true }).click();
    await expect(page.locator(".exam-timer")).toBeVisible();
    expect(world.starts).toBe(1);
    expect(world.earlyStarts).toBe(0);
  });

  test("an opening moved later keeps waiting without opening instructions or starting an attempt", async ({ context, page }) => {
    const world = newWorld();
    await setUp(context, page, world);
    await page.goto("/assessment/start/o1");
    await expect(banner(page)).toContainText("03:00");
    world.dueAt = OPENS + 2 * 60 * MIN;
    await advance(page, world, 16_000);
    await expect(page.getByText("Opens 2026-11-19 17:30 (Asia/Kolkata)")).toBeVisible();
    await expect(page.getByRole("link", { name: /Back to My Trainings/ })).toBeVisible();
    await advance(page, world, 3 * MIN);
    await expect(page.getByRole("heading", { name: "Assessment instructions" })).toHaveCount(0);
    expect(world.starts).toBe(0);
  });

  test("a cancelled countdown shows the reason and never opens the start flow", async ({ context, page }) => {
    const world = newWorld();
    await setUp(context, page, world);
    await page.goto("/assessment/start/o1");
    await expect(banner(page)).toContainText("03:00");
    world.status = "CANCELLED";
    await advance(page, world, 16_000);
    await expect(page.getByText("L&D cancelled this assessment. No action is needed.")).toBeVisible();
    expect(world.starts).toBe(0);
  });

  test("offline at zero waits for backend confirmation, then opens preparation without starting", async ({ context, page }) => {
    const world = newWorld();
    await setUp(context, page, world);
    await page.goto("/assessment/start/o1");
    await expect(banner(page)).toContainText("03:00");
    world.offline = true;
    await context.setOffline(true);
    await advance(page, world, 3 * MIN + 2_000);
    await expect(page.getByText(/Waiting for a connection to confirm/)).toBeVisible();
    expect(world.starts).toBe(0);
    world.offline = false;
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
    expect(world.starts).toBe(0);
  });

  test("refresh preserves the wait and the opened instruction flow still requires acknowledgement and Start", async ({ context, page }) => {
    const world = newWorld();
    await setUp(context, page, world);
    await page.goto("/assessment/start/o1");
    await expect(banner(page)).toContainText("03:00");
    await page.reload();
    await expect(banner(page)).toContainText("03:00");
    await expect(page.getByRole("heading", { name: "Assessment instructions" })).toHaveCount(0);
    await advance(page, world, 3 * MIN + 1_000);
    await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
    await prepare(page, { acknowledge: false });
    await expect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
    expect(world.starts).toBe(0);
  });

  test("two countdown tabs make no start requests when the opening arrives", async ({ context, page }) => {
    const world = newWorld();
    await setUp(context, page, world);
    await page.goto("/assessment/start/o1");
    await expect(banner(page)).toContainText("03:00");
    const second = await context.newPage();
    await second.clock.install({ time: new Date(world.now) });
    await second.goto("/assessment/start/o1");
    await expect(banner(second)).toContainText("03:00");
    world.now += 3 * MIN + 1_000;
    await Promise.all([page.clock.fastForward(3 * MIN + 1_000), second.clock.fastForward(3 * MIN + 1_000)]);
    await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
    await expect(second.getByRole("heading", { name: "System check" })).toBeVisible();
    expect(world.starts).toBe(0);
    expect(world.questionsAt).toBeNull();
  });

  test("another due assessment retains queue priority at countdown expiry", async ({ context, page }) => {
    const world = newWorld({ otherDueAt: OPENS });
    await setUp(context, page, world);
    await page.goto("/assessment/start/o1");
    await expect(banner(page)).toContainText("03:00");
    await advance(page, world, 3 * MIN + 1_000);
    await page.waitForURL(/\/access\/assessment-required$/);
    await expect(page.getByRole("heading", { name: OTHER })).toBeVisible();
    expect(world.starts).toBe(0);
  });
});
