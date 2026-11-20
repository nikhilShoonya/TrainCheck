import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ACCOUNTS, signIn } from "./helpers";

/* Import Centre: Import type, Select training and Test type. Synthetic data only. */

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = decodeURIComponent(document.cookie.match(/tc_csrf=([^;]*)/)?.[1] ?? "");
      const response = await fetch(`/api/v1${path}`, { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    },
    { method, path, body },
  );
}

const HEADER = "id,topic,competency,type,question,option_a,option_b,option_c,option_d,options_extra,correct,explanation,difficulty,marks,level,language,active";
const questionFile = (name: string, codes: string[]) => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from([HEADER, ...codes.map((c) => `${c},Topic,Applies the documented process,single,${c}?,Right,Wrong,,,,A,Because.,Easy,1,L2,English,Active`)].join("\n")),
});

async function draftTraining(page: Page) {
  const stamp = Date.now();
  const created = await call(page, "POST", "/admin/trainings", { title: `Pools ${stamp}`, training_code: `POOLS-${stamp}` });
  expect(created.status).toBe(200);
  return { stamp, label: `Pools ${stamp} (POOLS-${stamp}) · Draft` };
}

const fields = (page: Page) => [page.getByLabel("Import type"), page.getByLabel("Select training *"), page.getByLabel("Test type *")];

test("desktop shows Import type, Select training and Test type side by side, in that order", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/lnd/imports");
  const boxes = await Promise.all(fields(page).map((f) => f.boundingBox()));
  expect(boxes.every(Boolean)).toBe(true);
  const [a, b, c] = boxes as { x: number; y: number }[];
  expect(Math.abs(a.y - b.y)).toBeLessThan(4);
  expect(Math.abs(b.y - c.y)).toBeLessThan(4);
  expect(a.x).toBeLessThan(b.x);
  expect(b.x).toBeLessThan(c.x);
  await expect(page.getByText("These questions will be linked to the selected training and used only for the selected test type.")).toBeVisible();
  await expect(page.getByLabel("Test type *")).toHaveValue(""); // No default.
  await expect(page.getByLabel("Test type *").locator("option")).toHaveText(["Choose Pre-test or Post-test", "Pre-test", "Post-test"]);
});

test("mobile stacks the same fields in the same order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/lnd/imports");
  const boxes = (await Promise.all(fields(page).map((f) => f.boundingBox()))) as { x: number; y: number; height: number }[];
  expect(boxes[0].y + boxes[0].height).toBeLessThanOrEqual(boxes[1].y);
  expect(boxes[1].y + boxes[1].height).toBeLessThanOrEqual(boxes[2].y);
  expect(Math.abs(boxes[0].x - boxes[2].x)).toBeLessThan(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // No sideways scrolling.
});

test("a question file needs an explicit training and test type; completion imports are unchanged", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const { label } = await draftTraining(page);
  await page.goto("/lnd/imports");
  await page.getByLabel("Select training *").selectOption({ label });
  await page.locator('input[type="file"]').setInputFiles(questionFile("q.csv", ["REQ-1"]));
  await page.getByRole("button", { name: "Validate file" }).click();
  expect(await page.getByLabel("Test type *").evaluate((el: HTMLSelectElement) => el.validity.valueMissing)).toBe(true);
  await expect(page.locator("#import-preview")).toHaveCount(0);

  // Training completions: no training or test type to choose, and the completion workflow still validates.
  await page.getByLabel("Import type").selectOption("COMPLETIONS");
  await expect(page.getByLabel("Select training *")).toHaveCount(0);
  await expect(page.getByLabel("Test type *")).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles({ name: "c.csv", mimeType: "text/csv", buffer: Buffer.from("employee,training,completion_date\nNOPE,NOPE,2026-11-01\n") });
  await page.getByRole("button", { name: "Validate file" }).click();
  await expect(page.locator("#import-summary")).toContainText("c.csv validated");
  await expect(page.locator("#import-summary")).not.toContainText("Test type");
});

test("the preview follows the selection, and the saved test type survives reload and file replacement", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const { stamp, label } = await draftTraining(page);
  await page.goto("/lnd/imports");
  await page.getByLabel("Select training *").selectOption({ label });
  await page.getByLabel("Test type *").selectOption("PRE_TEST");
  await page.locator('input[type="file"]').setInputFiles(questionFile("pre.csv", [`PRE-${stamp}-1`, `PRE-${stamp}-2`]));
  await page.getByRole("button", { name: "Validate file" }).click();
  const preview = page.locator("#import-preview");
  await expect(preview).toContainText("Test type: Pre-test");
  await expect(page.locator("#import-confirm-summary")).toContainText("for the pre-test only");

  // Changing the test type drops the preview: it must be validated again.
  await page.getByLabel("Test type *").selectOption("POST_TEST");
  await expect(preview).toHaveCount(0);
  await page.getByLabel("Test type *").selectOption("PRE_TEST");
  await page.locator('input[type="file"]').setInputFiles(questionFile("pre.csv", [`PRE-${stamp}-1`, `PRE-${stamp}-2`]));
  await page.getByRole("button", { name: "Validate file" }).click();
  await expect(preview).toContainText("Test type: Pre-test");

  // After a reload, history and the reopened preview keep the saved test type.
  await page.reload();
  const row = page.getByRole("row", { name: /pre\.csv/ }).first();
  await expect(row).toContainText("Pre-test");
  await row.getByRole("button", { name: "View" }).click();
  await expect(page.getByLabel("Test type *")).toHaveValue("PRE_TEST");
  await expect(preview).toContainText("Test type: Pre-test");

  // Replacing the file: the edit form shows the saved test type, which can be changed deliberately.
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Test type *")).toHaveValue("PRE_TEST");
  await dialog.getByLabel("Test type *").selectOption("POST_TEST");
  await dialog.locator('input[type="file"]').setInputFiles(questionFile("post.csv", [`POST-${stamp}-1`]));
  await dialog.getByRole("button", { name: "Validate file" }).click();
  await expect(preview).toContainText("Test type: Post-test");
  await expect(page.getByRole("row", { name: /post\.csv/ }).first()).toContainText("Post-test");

  await page.getByRole("button", { name: "Import 1 valid row" }).click();
  await expect(page.locator("#import-summary")).toContainText("Import finished. 1 row imported");
  await expect(page.locator("#import-summary")).toContainText("Test type: Post-test");
});

test("a question PDF in the TrainCheck template is validated and imported like a spreadsheet", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const { label } = await draftTraining(page);
  await page.goto("/lnd/imports");
  await expect(page.locator('input[type="file"]')).toHaveAttribute("accept", ".csv,.xlsx,.pdf");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF template" }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("traincheck-questions-template.pdf");
  // Playwright stores downloads without their extension, so upload the bytes under the downloaded name.
  const pdf = { name: saved.suggestedFilename(), mimeType: "application/pdf", buffer: await readFile(await saved.path()) };

  await page.getByLabel("Select training *").selectOption({ label });
  await page.getByLabel("Test type *").selectOption("POST_TEST");
  await page.locator('input[type="file"]').setInputFiles(pdf);
  await page.getByRole("button", { name: "Validate file" }).click();
  await expect(page.locator("#import-summary")).toContainText("1 valid, 0 rejected");
  await expect(page.locator("#import-preview")).toContainText("Test type: Post-test");
  await page.getByRole("button", { name: "Import 1 valid row" }).click();
  await expect(page.locator("#import-summary")).toContainText("Import finished. 1 row imported");

  // Completion imports keep to CSV and Excel.
  await page.getByLabel("Import type").selectOption("COMPLETIONS");
  await expect(page.locator('input[type="file"]')).toHaveAttribute("accept", ".csv,.xlsx");
  await expect(page.getByRole("button", { name: "Download PDF template" })).toHaveCount(0);
});
