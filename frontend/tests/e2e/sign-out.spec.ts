import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* Signing out leaves the workspace only once the server confirms the session is over. All API traffic is mocked
   with synthetic data; any request the mock does not know fails the test, so nothing reaches a backend. Run against an
   isolated frontend (BACKEND_URL on an unused port), as described in audit-fixes.spec.ts. */

const ACCOUNT = "synthetic-admin";
const PENDING_KEY = `traincheck.pending-answers.v1:${ACCOUNT}:synthetic-attempt`;

type Logout = { status: number; code?: string };

interface World {
  unknown: string[];
  logouts: Logout[];
  logoutCalls: number;
  signedOut: boolean;
}

async function mockApi(context: BrowserContext, world: World) {
  await context.addInitScript(() => {
    document.cookie = "tc_csrf=synthetic-test; path=/";
  });
  await context.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    const error = (status: number, code: string, message: string) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message } }) });
    if (path === "/auth/me") {
      if (world.signedOut) return error(401, "UNAUTHENTICATED", "Please sign in again.");
      return json({ user: { id: ACCOUNT, employee_id: "e-admin", employee_code: "SYN-ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-test" });
    }
    if (path === "/auth/logout" && method === "POST") {
      const next = world.logouts[Math.min(world.logoutCalls, world.logouts.length - 1)];
      world.logoutCalls++;
      if (next.status === 200) {
        world.signedOut = true;
        return json({ signed_out: true });
      }
      if (next.status === 401) world.signedOut = true; // The session had already ended.
      return error(next.status, next.code ?? "SERVICE_UNAVAILABLE", next.status === 401 ? "Please sign in again." : "TrainCheck is temporarily unavailable. Please try again shortly.");
    }
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (["/admin/trainings", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies", "/admin/employees"].includes(path)) return json([]);
    if (path === "/admin/calendar") return json({ name: "Synthetic calendar", timezone: "Asia/Kolkata", working_weekdays: [0, 1, 2, 3, 4], holidays: [], policy_note: "Synthetic." });
    if (path === "/admin/dashboard") return json({});
    world.unknown.push(`${method} ${path}`);
    return error(404, "NOT_FOUND", "Not mocked.");
  });
}

/** A synthetic unsaved answer of the signed-in account, as the exam page keeps it on the device. */
async function seedPendingAnswer(page: Page) {
  await page.evaluate(
    ([key, account]) => localStorage.setItem(key, JSON.stringify({ v: 1, account, attempt: "synthetic-attempt", expiresAt: Date.now() + 3_600_000, entries: [{ q: "q1", s: ["o1"], n: 1 }] })),
    [PENDING_KEY, ACCOUNT],
  );
}
const pendingAnswer = (page: Page) => page.evaluate((key) => localStorage.getItem(key), PENDING_KEY);

async function signOut(page: Page) {
  await page.locator(".profile-menu summary").click();
  await page.getByRole("button", { name: "Sign out" }).click();
}

test.describe("sign-out (mocked API)", () => {
  let world: World;
  const start = async (context: BrowserContext, page: Page, logouts: Logout[]) => {
    world = { unknown: [], logouts, logoutCalls: 0, signedOut: false };
    await mockApi(context, world);
    await page.goto("/lnd/organisation");
    await expect(page.getByRole("heading", { name: "Department and Function Management" })).toBeVisible();
    await seedPendingAnswer(page);
  };
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("a failed sign-out keeps the person signed in, says so, keeps their answers, and can be retried", async ({ context, page }) => {
    await start(context, page, [{ status: 503 }, { status: 200 }]);
    await signOut(page);
    const dialog = page.getByRole("dialog", { name: "Sign-out did not complete" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("You are still signed in.");
    await expect(page).toHaveURL(/\/lnd\/organisation$/);
    expect(await pendingAnswer(page)).not.toBeNull(); // Nothing cleared: the session may still be valid.

    await dialog.getByRole("button", { name: "Try again" }).click();
    await page.waitForURL(/\/login$/);
    expect(world.logoutCalls).toBe(2);
    expect(await pendingAnswer(page)).toBeNull(); // Cleared once the sign-out was confirmed.
  });

  test("staying signed in after a failure closes the message and leaves the page as it was", async ({ context, page }) => {
    await start(context, page, [{ status: 503 }]);
    await signOut(page);
    await page.getByRole("dialog", { name: "Sign-out did not complete" }).getByRole("button", { name: "Stay signed in" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/lnd\/organisation$/);
    await expect(page.getByRole("heading", { name: "Department and Function Management" })).toBeVisible();
  });

  test("a successful sign-out opens the sign-in page and removes this device's saved answers", async ({ context, page }) => {
    await start(context, page, [{ status: 200 }]);
    await signOut(page);
    await page.waitForURL(/\/login$/);
    expect(await pendingAnswer(page)).toBeNull();
  });

  test("a session that had already ended is treated as signed out", async ({ context, page }) => {
    await start(context, page, [{ status: 401, code: "UNAUTHENTICATED" }]);
    await signOut(page);
    // The API client's own "session ended" handling also opens the sign-in page, so two navigations race to the same
    // address; only where the page ends up matters.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("dialog", { name: "Sign-out did not complete" })).toHaveCount(0);
    expect(await pendingAnswer(page)).toBeNull();
  });
});
