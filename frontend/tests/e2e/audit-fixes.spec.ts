import { expect, test, type BrowserContext, type Route } from "@playwright/test";

/* Browser checks for the Phase 2 audit fixes (B3/P2, B8, B9, B10, B14, B20, B21, P5). All API traffic is mocked with synthetic
   data; any request the mock does not know fails the test, so nothing reaches a backend. Run against an isolated
   frontend whose BACKEND_URL points at an unused port, e.g.
   NEXT_DIST_DIR=.next-e2e PORT=3100 BACKEND_URL=http://127.0.0.1:8199 NEXT_PUBLIC_DEMO_MODE=false npm run dev
   and E2E_BASE_URL=http://localhost:3100. */

const ATTEMPT = "synthetic-attempt";

interface World {
  unknown: string[];
  posts: { path: string; body: unknown }[];
  requested: string[];
  trainers: { id: string; name: string; email: string | null; is_active: boolean }[];
  notifications: { id: string; type: string; title: string; message: string; link: string | null; read: boolean; created_at: string }[];
  /** When set, "Load older" replies are computed when requested but sent only once released (a slow network). */
  hold: { released: Promise<void>; release: () => void } | null;
  held: number;
}

const newWorld = (): World => ({ unknown: [], posts: [], requested: [], trainers: [], notifications: [], hold: null, held: 0 });

function holdOlderPages(world: World) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  world.hold = { released, release };
}

/** 250 synthetic notifications, newest first, several sharing one timestamp. */
const manyNotifications = () =>
  Array.from({ length: 250 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(1000 - i).padStart(12, "0")}`,
    type: "SYNTHETIC",
    title: `Synthetic notification ${i + 1}`,
    message: "Synthetic message",
    link: null,
    read: false,
    created_at: new Date(Date.UTC(2026, 10, 20, 12, 0) - Math.floor(i / 3) * 60_000).toISOString(),
  }));

async function mockApi(context: BrowserContext, world: World) {
  await context.addInitScript(() => {
    document.cookie = "tc_csrf=synthetic-test; path=/";
  });
  await context.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    world.requested.push(`${method} ${path}${url.search}`);
    const json = (data: unknown, meta: Record<string, unknown> = {}) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta }) });
    if (path === "/auth/me")
      // A001 is a demo portrait code: with demo mode off the header must show initials, not the stock portrait (B10).
      return json({ user: { id: "synthetic-admin", employee_id: "e-admin", employee_code: "A001", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-test" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 73 });
    if (path === "/me/notifications") {
      // The server's paging contract: newest first, at most `limit`, strictly after `before`, with has_more.
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 100);
      const before = url.searchParams.get("before");
      const start = before ? world.notifications.findIndex((n) => n.id === before) + 1 : 0;
      const items = world.notifications.slice(start, start + limit).map((n) => ({ ...n })); // The state when asked.
      const hasMore = start + limit < world.notifications.length;
      if (before && world.hold) {
        world.held++;
        await world.hold.released;
      }
      return json(items, { unread: 73, has_more: hasMore, next_before: hasMore ? items[items.length - 1].id : null });
    }
    if (path === "/me/notifications/mark-all-read" && method === "POST") {
      for (const n of world.notifications) n.read = true;
      return json({ marked: true });
    }
    const notification = /^\/me\/notifications\/([^/]+)$/.exec(path);
    if (notification && method === "PATCH") {
      const item = world.notifications.find((n) => n.id === notification[1]);
      if (item) {
        item.read = request.postDataJSON().read;
        return json({ ...item });
      }
    }
    if (["/admin/departments", "/admin/functions", "/admin/competencies", "/admin/trainings", "/admin/employees"].includes(path)) return json([]);
    // Focusing a sidebar link prefetches that page's first data (lib/query NAV_PREFETCH); it is not rendered here.
    if (path === "/admin/dashboard") return json({});
    if (path === "/admin/trainers" && method === "GET") return json(world.trainers);
    if (path === "/admin/trainers" && method === "POST") {
      const body = request.postDataJSON();
      world.posts.push({ path, body });
      const trainer = { id: `trainer-${world.trainers.length}`, name: body.name, email: body.email, is_active: true };
      world.trainers.push(trainer);
      return json(trainer);
    }
    if (path === "/admin/calendar") return json({ name: "Synthetic calendar", timezone: "Asia/Kolkata", working_weekdays: [0, 1, 2, 3, 4], holidays: [], policy_note: "Synthetic." });
    if (path === `/attempts/${ATTEMPT}/result`)
      return json({ attempt_id: ATTEMPT, obligation_id: "o1", assessment_type: "PRE_TEST", training_title: "Synthetic training", attempt_status: "SUBMITTED", attempt_number: 1, max_attempts: 1, attempts_remaining: 0, score_percent: 40, result_status: "NOT_PASSED", pass_mark_percent: 70, obtained_marks: 4, total_marks: 10, submitted_at: "2026-11-20T06:00:00Z", submission_reason: "TRAINING_COMPLETED", time_taken_seconds: 120, question_count: 10, answered_count: 4, correct_count: 4, first_score: null, best_score: null, latest_score: null, topics: [], explanations_enabled: false, answer_review: [], needs_retraining: false, retake_pending: false, refresher: null, violations: [], interruptions: 0 });
    if (path === `/attempts/${ATTEMPT}/feedback`) return json({ required: false, training_title: "Synthetic training", questions: [], submitted: null });
    world.unknown.push(`${method} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

test.describe("audit fixes (mocked API)", () => {
  let world: World;
  test.beforeEach(async ({ context }) => {
    world = newWorld();
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("navigation is English even with an old Hindi choice saved, and there is no language picker (B3, P2)", async ({ context, page }) => {
    await context.addInitScript(() => localStorage.setItem("tc-language", "Hindi"));
    await page.goto("/lnd/organisation");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Training Management" })).toBeVisible();
    await expect(nav).not.toContainText("प्रशिक्षण");
    await expect(page.locator("#ui-language, .language-control")).toHaveCount(0);
    await expect(page.locator("#global-query")).toHaveAttribute("placeholder", "Search trainings, reports, or help…");
    await expect(nav).not.toContainText("Batches & Sessions");
    await expect(nav).not.toContainText("Audit Logs");
  });

  test("the bell shows the exact unread count from the count endpoint (B9)", async ({ page }) => {
    await page.goto("/lnd/organisation");
    await expect(page.getByRole("link", { name: "Notifications, 73 unread" })).toBeVisible();
    expect(world.requested).toContain("GET /me/notifications/unread-count");
    expect(world.requested.some((r) => r.includes("unread_only=true"))).toBe(false);
  });

  test("a real employee with a demo code sees initials, not a stock portrait (B10)", async ({ page }) => {
    await page.goto("/lnd/organisation");
    const avatar = page.locator(".profile-menu .reference-avatar");
    await expect(avatar).toHaveText("SA");
    await expect(avatar.locator("svg.profile-portrait")).toHaveCount(0);
  });

  test("adding a trainer without an email sends null, and the table shows a dash (B8)", async ({ page }) => {
    await page.goto("/lnd/organisation");
    await page.getByRole("button", { name: "Add trainer" }).click();
    const dialog = page.getByRole("dialog", { name: "Add trainer" });
    await dialog.getByLabel("Name *").fill("  Synthetic Trainer  ");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => world.posts.length).toBe(1);
    expect(world.posts[0].body).toEqual({ name: "Synthetic Trainer", email: null, is_active: true });
    await expect(page.getByRole("row", { name: /Synthetic Trainer/ })).toContainText("—");
  });

  test("the removed Batches & Sessions and Audit Logs pages do not exist (P5)", async ({ page }) => {
    for (const path of ["/lnd/batches", "/lnd/audit"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
    }
  });

  test("a pre-test submitted when completion was recorded says so (B14)", async ({ page }) => {
    await page.goto(`/results/${ATTEMPT}`);
    await expect(page.getByRole("heading", { name: "Pre-test complete" })).toBeVisible();
    await expect(page.getByText("Submitted automatically when your training completion was recorded. Your saved answers were scored.")).toBeVisible();
  });

  test("notifications beyond the newest 100 can be reached, each once and in order (B21)", async ({ page }) => {
    world.notifications = manyNotifications();
    await page.goto("/notifications");
    const items = page.locator("article.notification-item");
    await expect(items).toHaveCount(100);
    const more = page.getByRole("button", { name: "Load older notifications" });
    await more.click();
    await expect(items).toHaveCount(200);
    await expect(page.getByRole("status").filter({ hasText: "Loaded 100 older notifications." })).toHaveCount(1);
    await more.click();
    await expect(items).toHaveCount(250);
    await expect(more).toHaveCount(0);
    const titles = await items.locator("h3").allTextContents();
    expect(titles).toEqual(world.notifications.map((n) => n.title));
    expect(world.requested.filter((r) => r.startsWith("GET /me/notifications?before="))).toEqual([
      `GET /me/notifications?before=${world.notifications[99].id}&limit=100`,
      `GET /me/notifications?before=${world.notifications[199].id}&limit=100`,
    ]);
    // Marking an older notification read keeps the expanded list.
    await items.nth(220).getByRole("button", { name: "Mark read" }).click();
    await expect(items.nth(220).getByRole("button", { name: "Mark unread" })).toBeVisible();
    await expect(items).toHaveCount(250);
  });

  test("the closed mobile navigation has no keyboard stops, and focus moves in and out of it (B20)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/lnd/organisation");
    const sidebar = page.locator("#sidebar");
    const menu = page.getByRole("button", { name: "Open navigation" });
    await expect(menu).toBeVisible();
    await expect(sidebar).toHaveAttribute("inert", "");
    await page.locator("body").focus();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest("#sidebar")))).toBe(false);
    }

    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link").first()).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("#sidebar")))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await expect(sidebar).toHaveAttribute("inert", "");

    await menu.click();
    await page.getByRole("button", { name: "Close navigation" }).click({ position: { x: 370, y: 400 } });
    await expect(menu).toBeFocused();
    await expect(sidebar).toHaveAttribute("inert", "");
  });

  test("the desktop sidebar stays in the keyboard order (B20)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/lnd/organisation");
    await expect(page.locator("#sidebar")).not.toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Training Management" }).focus();
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Training Management" })).toBeFocused();
  });

  test("a delayed older page cannot undo a Mark All Read made while it was loading (notification race)", async ({ page }) => {
    world.notifications = manyNotifications();
    await page.goto("/notifications");
    const items = page.locator("article.notification-item");
    await expect(items).toHaveCount(100);
    holdOlderPages(world);
    await page.getByRole("button", { name: "Load older notifications" }).click();
    await expect.poll(() => world.held).toBe(1); // The page was read on the server while everything was unread...
    await page.getByRole("button", { name: "Mark All Read" }).click();
    await expect(items.nth(0).getByRole("button", { name: "Mark unread" })).toBeVisible(); // ...then all were marked read.
    world.hold?.release();
    await expect(items).toHaveCount(200);
    await expect(page.locator("article.notification-item").getByRole("button", { name: "Mark read" })).toHaveCount(0);
    expect(await items.locator(".badge").allTextContents()).toEqual(Array(200).fill("Read"));
  });

  test("a delayed older page cannot undo a Mark Read made on an older notification while it was loading", async ({ page }) => {
    world.notifications = manyNotifications();
    await page.goto("/notifications");
    const items = page.locator("article.notification-item");
    await page.getByRole("button", { name: "Load older notifications" }).click();
    await expect(items).toHaveCount(200);
    holdOlderPages(world);
    await page.getByRole("button", { name: "Load older notifications" }).click();
    await expect.poll(() => world.held).toBe(1);
    await items.nth(150).getByRole("button", { name: "Mark read" }).click();
    await expect(items.nth(150).getByRole("button", { name: "Mark unread" })).toBeVisible();
    world.hold?.release();
    await expect(items).toHaveCount(250);
    await expect(items.nth(150).getByRole("button", { name: "Mark unread" })).toBeVisible();
    const titles = await items.locator("h3").allTextContents();
    expect(titles).toEqual(world.notifications.map((n) => n.title)); // Order kept, nothing repeated or missing.
  });
});
