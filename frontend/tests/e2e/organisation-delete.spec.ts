import { expect, test, type BrowserContext, type Route } from "@playwright/test";

/* Departments & Functions page: Edit dialogs offer Delete (with a confirmation), and Trainers / Competencies can be
   edited, switched inactive and deleted. A record in use is refused by the server and stays. All API traffic is
   mocked with synthetic data; any request the mock does not know fails the test. Run against an isolated frontend. */

interface Row {
  id: string;
  code?: string;
  name: string;
  email?: string | null;
  description?: string | null;
  is_active: boolean;
}
interface World {
  unknown: string[];
  deletes: string[];
  patches: { path: string; body: unknown }[];
  data: Record<string, Row[]>;
}

export const newWorld = (): World => ({
  unknown: [],
  deletes: [],
  patches: [],
  data: {
    departments: [
      { id: "dep-hr", code: "HR", name: "Human Resource", is_active: true },
      { id: "dep-tmp", code: "TMP", name: "Temporary", is_active: true },
    ],
    functions: [{ id: "fn-hr", code: "FUNC-1", name: "Human Resource", is_active: true }],
    trainers: [{ id: "tr-1", name: "Synthetic Trainer", email: "trainer@example.test", is_active: true }],
    competencies: [{ id: "co-1", code: "C1", name: "Listens actively", description: "Old description", is_active: true }],
  },
});

export async function mockApi(context: BrowserContext, world: World) {
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
    if (path === "/admin/trainings") return json([]);
    if (path === "/admin/calendar") return json({ name: "Synthetic calendar", timezone: "Asia/Kolkata", working_weekdays: [0, 1, 2, 3, 4], holidays: [], policy_note: "Synthetic." });
    const match = /^\/admin\/(departments|functions|trainers|competencies)(?:\/([^/]+))?$/.exec(path);
    if (match) {
      const [, kind, id] = match;
      const rows = world.data[kind];
      if (!id && method === "GET") return json(rows);
      if (id && method === "DELETE") {
        world.deletes.push(path);
        if (id === "dep-hr") return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "IN_USE", message: "Human Resource cannot be deleted because it is used by 3 employees and 1 training. Mark it inactive instead: it stops being offered and existing records are kept.", details: { usage: ["3 employees", "1 training"] } } }) });
        world.data[kind] = rows.filter((r) => r.id !== id);
        return json({ deleted: true });
      }
      if (id && method === "PATCH") {
        const body = request.postDataJSON();
        world.patches.push({ path, body });
        const row = rows.find((r) => r.id === id)!;
        Object.assign(row, body);
        return json(row);
      }
    }
    world.unknown.push(`${method} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Not mocked." } }) });
  });
}

const section = (page: import("@playwright/test").Page, title: string) => page.locator("section.panel").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test.describe("Departments & Functions: delete from Edit (mocked API)", () => {
  let world: World;
  test.beforeEach(async ({ context }) => {
    world = newWorld();
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("Edit shows Delete; it asks first, then deletes an unused department", async ({ page }) => {
    await page.goto("/lnd/organisation");
    const departments = section(page, "Departments");
    await departments.getByRole("row", { name: /Temporary/ }).getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit department" });
    await expect(edit.getByRole("button", { name: "Delete Temporary" })).toBeVisible();
    await edit.getByRole("button", { name: "Delete Temporary" }).click();

    const confirm = page.getByRole("dialog", { name: "Delete department" });
    await expect(confirm).toContainText("Delete Temporary? This cannot be undone.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect(world.deletes).toEqual([]); // Cancelling deletes nothing.

    await departments.getByRole("row", { name: /Temporary/ }).getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog", { name: "Edit department" }).getByRole("button", { name: "Delete Temporary" }).click();
    await page.getByRole("dialog", { name: "Delete department" }).getByRole("button", { name: "Delete department" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.deletes).toEqual(["/admin/departments/dep-tmp"]);
    await expect(departments.getByRole("row", { name: /Temporary/ })).toHaveCount(0);
    await expect(departments.getByRole("row", { name: /Human Resource/ })).toHaveCount(1);
  });

  test("a department in use is refused, the reason is shown and the row stays", async ({ page }) => {
    await page.goto("/lnd/organisation");
    const departments = section(page, "Departments");
    await departments.getByRole("row", { name: /Human Resource/ }).getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog", { name: "Edit department" }).getByRole("button", { name: "Delete Human Resource" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete department" });
    await confirm.getByRole("button", { name: "Delete department" }).click();
    await expect(confirm.getByRole("alert")).toContainText("used by 3 employees and 1 training. Mark it inactive instead");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(departments.getByRole("row", { name: /Human Resource/ })).toHaveCount(1);
  });

  test("Add dialogs never offer Delete", async ({ page }) => {
    await page.goto("/lnd/organisation");
    await section(page, "Departments").getByRole("button", { name: "Add department" }).click();
    await expect(page.getByRole("dialog", { name: "Add department" }).getByRole("button", { name: /Delete/ })).toHaveCount(0);
  });

  test("trainers and competencies: Status column, Active in Edit, and Delete", async ({ page }) => {
    await page.goto("/lnd/organisation");
    const trainers = section(page, "Trainers");
    await expect(trainers.getByRole("row", { name: /Synthetic Trainer/ })).toContainText("Active");
    await trainers.getByRole("button", { name: "Edit Synthetic Trainer" }).click();
    const edit = page.getByRole("dialog", { name: "Edit trainer" });
    await edit.getByLabel("Active").uncheck();
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.patches[0]).toEqual({ path: "/admin/trainers/tr-1", body: { name: "Synthetic Trainer", email: "trainer@example.test", is_active: false } });
    await expect(trainers.getByRole("row", { name: /Synthetic Trainer/ })).toContainText("Inactive");

    const competencies = section(page, "Competencies and skills");
    await competencies.getByRole("button", { name: "Edit Listens actively" }).click();
    const competency = page.getByRole("dialog", { name: "Edit competency" });
    await competency.getByLabel("Name *").fill("Listens carefully");
    await competency.getByLabel("Behaviour description").fill("");
    await competency.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.patches[1]).toEqual({ path: "/admin/competencies/co-1", body: { name: "Listens carefully", description: null, is_active: true } });

    await competencies.getByRole("button", { name: "Edit Listens carefully" }).click();
    await page.getByRole("dialog", { name: "Edit competency" }).getByRole("button", { name: "Delete Listens carefully" }).click();
    await page.getByRole("dialog", { name: "Delete competency" }).getByRole("button", { name: "Delete competency" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.deletes).toEqual(["/admin/competencies/co-1"]);
    await expect(competencies).toContainText("No competencies and skills yet.");
  });
});
