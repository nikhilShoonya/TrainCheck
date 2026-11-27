import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* Reports & Analytics > Downloads: every row has Download and Delete; Delete asks first, Cancel keeps the file, and a
   confirmed delete removes the row. A server refusal is shown in the dialog. All API traffic is mocked with synthetic
   data; any request the mock does not know fails the test. Run against an isolated frontend (BACKEND_URL on an unused
   port), as described in audit-fixes.spec.ts. */

interface Export {
  id: string;
  report_code: string;
  export_format: string;
  row_count: number;
  file_name: string;
  created_at: string;
}
interface World {
  unknown: string[];
  deletes: string[];
  refuse: boolean;
  exports: Export[];
}

const newWorld = (): World => ({
  unknown: [],
  deletes: [],
  refuse: false,
  exports: [
    { id: "exp-1", report_code: "compliance", export_format: "PDF", row_count: 10, file_name: "synthetic-compliance-1.pdf", created_at: "2026-11-23T11:59:00Z" },
    { id: "exp-2", report_code: "compliance", export_format: "CSV", row_count: 4, file_name: "synthetic-compliance-2.csv", created_at: "2026-11-23T07:17:00Z" },
  ],
});

async function mockApi(context: BrowserContext, world: World) {
  await context.addInitScript(() => {
    document.cookie = "tc_csrf=synthetic-test; path=/";
  });
  await context.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "e-admin", employee_code: "SYN-ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-test" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (["/admin/trainings", "/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"].includes(path)) return json([]);
    if (path === "/reports/filter-options") return json({ departments: [], locations: [], trainings: [], trainers: [], batches: [], grades: [] });
    if (path === "/reports/compliance") return json({ code: "compliance", title: "Training Completion and Compliance", description: "Synthetic report.", columns: ["Employee", "Training"], rows: [["Synthetic Person", "Synthetic training"]], definitions: [], filters: {}, generated_at: "2026-11-20T06:00:00Z" });
    if (path === "/reports/schedules") return json([]);
    if (path === "/reports/exports" && method === "GET") return json(world.exports);
    const match = /^\/reports\/exports\/([^/]+)$/.exec(path);
    if (match && method === "DELETE") {
      world.deletes.push(match[1]);
      if (world.refuse) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "This export no longer exists." } }) });
      world.exports = world.exports.filter((e) => e.id !== match[1]);
      return json({ deleted: true });
    }
    world.unknown.push(`${method} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

const downloads = (page: Page) => page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Downloads", exact: true }) });

test.describe("Reports Downloads: Delete (mocked API)", () => {
  let world: World;
  test.beforeEach(async ({ context }) => {
    world = newWorld();
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("every row has Download and Delete; Cancel keeps the file, confirming deletes it", async ({ page }) => {
    await page.goto("/lnd/reports");
    const card = downloads(page);
    for (const name of ["synthetic-compliance-1.pdf", "synthetic-compliance-2.csv"]) {
      await expect(card.getByRole("button", { name: `Delete ${name}` })).toBeVisible();
    }
    await expect(card.getByRole("button", { name: "Download", exact: true })).toHaveCount(2);

    await card.getByRole("button", { name: "Delete synthetic-compliance-1.pdf" }).click();
    let dialog = page.getByRole("dialog", { name: "Delete file" });
    await expect(dialog).toContainText("synthetic-compliance-1.pdf");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.deletes).toEqual([]);

    await card.getByRole("button", { name: "Delete synthetic-compliance-1.pdf" }).click();
    dialog = page.getByRole("dialog", { name: "Delete file" });
    await dialog.getByRole("button", { name: "Delete file" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.deletes).toEqual(["exp-1"]);
    await expect(card.getByRole("button", { name: "Delete synthetic-compliance-1.pdf" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Delete synthetic-compliance-2.csv" })).toBeVisible();
  });

  test("a refused delete shows the server's message and keeps the row", async ({ page }) => {
    world.refuse = true;
    await page.goto("/lnd/reports");
    const card = downloads(page);
    await card.getByRole("button", { name: "Delete synthetic-compliance-2.csv" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete file" });
    await dialog.getByRole("button", { name: "Delete file" }).click();
    await expect(dialog).toContainText("This export no longer exists.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(card.getByRole("button", { name: "Delete synthetic-compliance-2.csv" })).toBeVisible();
  });
});
