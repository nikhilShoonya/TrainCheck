import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

/* Employee Assignments > Add Employee: one employee by form, many from a file (Validate -> Preview -> Confirm Import),
   the Fin@DDMMYYYY password, and no Change password for employees. Synthetic data only. */

const tag = String(Date.now()).slice(-6);

async function openAddEmployee(page: Page) {
  await page.goto("/lnd/assignments");
  await expect(page.getByRole("button", { name: "Assign Employees" })).toBeVisible();
  await page.getByRole("button", { name: "Add Employee" }).click();
  const choice = page.getByRole("dialog", { name: "Add employee" });
  await expect(choice.getByRole("button", { name: /New Employee/ })).toBeVisible();
  await expect(choice.getByRole("button", { name: /Multiple Employees/ })).toBeVisible();
  return choice;
}

function csv(rows: string[][]): { name: string; mimeType: string; buffer: Buffer } {
  // Finvasia's HR headings (Employee Number first); each row below is given in the same order.
  const lines = [["Employee Number", "Full Name", "Email", "Date of Joining", "Department"], ...rows.map(([name, code, ...rest]) => [code, name, ...rest])];
  return { name: "employees.csv", mimeType: "text/csv", buffer: Buffer.from(lines.map((l) => l.join(",")).join("\n"), "utf-8") };
}

test("an L&D Admin adds one employee, who signs in with Fin@DDMMYYYY and cannot change it", async ({ page, browser }) => {
  const code = `0${tag}`;
  const email = `new.${tag}@example.com`;
  await signIn(page, ACCOUNTS.admin);
  const choice = await openAddEmployee(page);
  await choice.getByRole("button", { name: /New Employee/ }).click();

  const form = page.getByRole("dialog", { name: "Add employee · New Employee" });
  await form.getByLabel("Full name *").fill(`Asha Verma ${tag}`);
  await form.getByLabel("Employee ID *").fill(code);
  await form.getByLabel("Work email *").fill(email);
  await form.getByLabel("Joining date *").fill("2026-01-05");
  await form.getByLabel("Department *").selectOption({ label: "Operations (OPS)" });
  await expect(form.getByLabel("Department *").locator("option", { hasText: "Learning & Development" })).toHaveCount(1);
  await form.getByRole("button", { name: "Add employee" }).click();
  await expect(page.locator("#toast")).toContainText(`Asha Verma ${tag} (${code}) added.`);
  await expect(form).toHaveCount(0);

  // The same ID again is refused with a clear message; nothing is overwritten.
  await (await openAddEmployee(page)).getByRole("button", { name: /New Employee/ }).click();
  const again = page.getByRole("dialog", { name: "Add employee · New Employee" });
  await again.getByLabel("Full name *").fill("Someone Else");
  await again.getByLabel("Employee ID *").fill(code);
  await again.getByLabel("Work email *").fill(`other.${tag}@example.com`);
  await again.getByLabel("Joining date *").fill("2026-11-19");
  await again.getByLabel("Department *").selectOption({ label: "Operations (OPS)" });
  await again.getByRole("button", { name: "Add employee" }).click();
  await expect(again.getByRole("alert")).toContainText("already exists");
  await again.getByRole("button", { name: "Cancel" }).click();

  // Offered straight away in Assign Employees.
  await page.getByRole("button", { name: "Assign Employees" }).click();
  const assign = page.getByRole("dialog", { name: "Assign employees" });
  await assign.getByLabel("Find by name, ID, department or function").fill(code);
  await expect(assign.locator(".checkbox-list label", { hasText: code })).toHaveCount(1);

  // The new employee signs in with Fin@05012026 and sees no Change password form.
  const employee = await browser.newPage();
  await employee.goto("/login");
  await employee.locator('input[name="email"]').fill(email);
  await employee.locator('input[name="password"]').fill("Fin@05012026");
  await employee.getByRole("button", { name: "Sign In" }).click();
  await employee.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await employee.goto("/profile");
  await expect(employee.getByRole("heading", { name: "My profile" })).toBeVisible();
  await expect(employee.getByText("Your password is managed by L&D")).toBeVisible();
  await expect(employee.getByRole("button", { name: "Change password" })).toHaveCount(0);
  await expect(employee.getByLabel("Current password")).toHaveCount(0);
  // Asking the API directly is refused as well.
  const refused = await employee.evaluate(async () => {
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )tc_csrf=([^;]*)/)?.[1] ?? "");
    const response = await fetch("/api/v1/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ current_password: "Fin@05012026", new_password: "BrandNewPass123" }) });
    return response.status;
  });
  expect(refused).toBe(403);
  await employee.close();
});

test("an L&D Admin imports many employees: errors block the file, a clean file imports whole", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await (await openAddEmployee(page)).getByRole("button", { name: /Multiple Employees/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add employees · Multiple Employees" });
  const confirm = dialog.getByRole("button", { name: /Confirm Import/ });
  await expect(confirm).toBeDisabled();

  const good = [
    [`Rohan Iyer ${tag}`, `00${tag}1`, `rohan.${tag}@example.com`, "19 Nov 2026", " cx "],
    [`Meera Nair ${tag}`, `00${tag}2`, `meera.${tag}@example.com`, "19112026", "Operations"],
  ];
  // One bad row: unknown department and an impossible date. Nothing can be imported until it is fixed.
  await dialog.locator('input[type="file"]').setInputFiles(csv([...good, [`Bad Row ${tag}`, `00${tag}3`, `bad.${tag}@example.com`, "31/02/2026", "Marketing"]]));
  await dialog.getByRole("button", { name: "Validate file" }).click();
  await expect(dialog.locator("#employee-preview")).toContainText("1 row of 3 need correcting");
  await expect(dialog.locator("#employee-preview")).toContainText("Unknown department 'Marketing'");
  await expect(dialog.locator("#employee-preview")).toContainText("Customer Experience (CX)");
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByText("Every row must pass validation")).toBeVisible();

  // The corrected file previews cleanly and imports both employees.
  await dialog.locator('input[type="file"]').setInputFiles(csv(good));
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Validate file" }).click();
  await expect(dialog.locator("#employee-preview")).toContainText("all 2 rows passed validation");
  await expect(dialog.locator("#employee-preview")).toContainText(`00${tag}1`); // Leading zeros kept.
  await expect(dialog.locator("#employee-preview")).not.toContainText("Fin@");
  await expect(confirm).toHaveText("Confirm Import (2 employees)");
  await confirm.click();
  await expect(dialog.getByRole("status")).toContainText("2 employees added.");
  await dialog.getByRole("button", { name: "Done" }).click();

  // Importing the same file again is stopped: those employees already exist.
  await (await openAddEmployee(page)).getByRole("button", { name: /Multiple Employees/ }).click();
  const again = page.getByRole("dialog", { name: "Add employees · Multiple Employees" });
  await again.locator('input[type="file"]').setInputFiles(csv(good));
  await again.getByRole("button", { name: "Validate file" }).click();
  await expect(again.locator("#employee-preview")).toContainText("2 rows of 2 need correcting");
  await expect(again.locator("#employee-preview")).toContainText("already exists");
  await expect(again.getByRole("button", { name: /Confirm Import/ })).toBeDisabled();
});

test("L&D Admins keep Change password; the template downloads", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/profile");
  await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
  await (await openAddEmployee(page)).getByRole("button", { name: /Multiple Employees/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add employees · Multiple Employees" });
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download CSV template" }).click()]);
  expect(download.suggestedFilename()).toBe("traincheck-employees-template.csv");
});
