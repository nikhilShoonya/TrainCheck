import { expect, test } from "@playwright/test";
import { ACCOUNTS, signIn } from "./helpers";

/* Assign employees: no batch field; "Select all" picks everyone the search shows and keeps earlier picks. */

test("Select all assigns everyone matching the search, without a batch field", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/lnd/assignments");
  await page.getByRole("button", { name: "Assign Employees" }).click();
  const dialog = page.getByRole("dialog", { name: "Assign employees" });
  await expect(dialog.getByLabel("Training (active only) *")).toBeVisible();
  await expect(dialog.getByLabel("Batch")).toHaveCount(0);

  const status = dialog.getByRole("status");
  await expect(status).toHaveText("0 selected");
  await expect(dialog.getByRole("button", { name: "Assign selected employees" })).toBeDisabled();

  await dialog.getByLabel("Find by name, ID, department or function").fill("Human Resources");
  const shown = await dialog.locator(".checkbox-list input[type=checkbox]").count();
  expect(shown).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: `Select all ${shown} matching` }).click();
  await expect(status).toHaveText(`${shown} selected`);
  await expect(dialog.getByRole("button", { name: `Clear ${shown} matching` })).toBeVisible();

  // Another search shows other people; the earlier picks stay selected.
  await dialog.getByLabel("Find by name, ID, department or function").fill("E001");
  await dialog.locator(".checkbox-list input[type=checkbox]").first().check();
  await expect(status).toHaveText(`${shown + 1} selected`);
  await dialog.getByLabel("Find by name, ID, department or function").fill("");
  await expect(dialog.locator(".checkbox-list input[type=checkbox]:checked")).toHaveCount(shown + 1);

  await dialog.getByRole("button", { name: "Assign selected employees" }).click();
  const outcome = page.getByRole("dialog", { name: "Assignment result" });
  await expect(outcome).toBeVisible();
});
