import { expect, test } from "@playwright/test";

/* The sign-in page fills in a remembered email once it has loaded. Someone who starts typing before that (a slow
   connection or device) must keep what they typed. Mocked API: no backend or database is involved.
   Run: npx playwright test tests/e2e/login-prefill.spec.ts */

test("an email typed before the page finished loading is not replaced by the remembered one", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { reset_enabled: false, reset: null }, meta: {} }) }));
  await page.addInitScript(() => window.localStorage.setItem("tc-remember-email", "remembered@example.test"));

  // Hold the page's scripts so the form is visible but not yet interactive, as on a slow connection.
  const held: (() => void)[] = [];
  await page.route("**/_next/static/**/*.js", (route) => {
    held.push(() => void route.continue());
  });
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const email = page.locator('input[name="email"]');
  await email.fill("typed@example.test");

  await page.unroute("**/_next/static/**/*.js");
  held.splice(0).forEach((release) => release());
  await expect(page.getByRole("button", { name: "Sign In" })).toBeEnabled();
  await page.waitForLoadState("networkidle");
  await expect(email).toHaveValue("typed@example.test");
});

test("with nothing typed, the remembered email is filled in", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { reset_enabled: false, reset: null }, meta: {} }) }));
  await page.addInitScript(() => window.localStorage.setItem("tc-remember-email", "remembered@example.test"));
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await expect(page.locator('input[name="email"]')).toHaveValue("remembered@example.test");
});
