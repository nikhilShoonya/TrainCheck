import { expect, type Page } from "@playwright/test";

/* Synthetic demo accounts from backend/app/seed_data.py. Tests must run against freshly seeded data. */
export const PASSWORD = "TrainCheck123!";
export const ACCOUNTS = {
  employee: "employee@traincheck.demo",
  clear: "clear@traincheck.demo",
  manager: "manager@traincheck.demo",
  manager2: "manager2@traincheck.demo",
  admin: "admin@traincheck.demo",
  hr: "hr@traincheck.demo",
};

export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Walks from the gate to the live assessment. */
export async function startSecureAssessment(page: Page) {
  await page.getByRole("button", { name: /Start assessment/ }).click();
  await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
  const proceed = page.getByRole("button", { name: /^Continue/ });
  await expect(proceed).toBeEnabled({ timeout: 15_000 });
  await proceed.click();
  await page.getByRole("button", { name: "Enter full screen" }).click();
  await expect(page.getByRole("heading", { name: "Assessment instructions" })).toBeVisible();
  await page.getByRole("checkbox", { name: /read and understood/ }).check();
  await page.getByRole("button", { name: /Start assessment/ }).click();
  await expect(page.locator(".exam-timer")).toBeVisible();
}

/** Walks from a pre-test's intro to the live, monitored pre-test (same secure steps as the assessment). */
export async function startSecurePreTest(page: Page) {
  await page.getByRole("button", { name: /Begin pre-test/ }).click();
  await expect(page.getByRole("heading", { name: "System check" })).toBeVisible();
  const proceed = page.getByRole("button", { name: /^Continue/ });
  await expect(proceed).toBeEnabled({ timeout: 15_000 });
  await proceed.click();
  await page.getByRole("button", { name: "Enter full screen" }).click();
  await expect(page.getByRole("heading", { name: "Pre-test instructions" })).toBeVisible();
  await page.getByRole("checkbox", { name: /read and understood/ }).check();
  await page.getByRole("button", { name: /Start pre-test/ }).click();
  await expect(page.locator(".exam-timer")).toBeVisible();
  await expect(page.locator(".exam-mode")).toContainText("Secure pre-test mode");
}

/** The five-question feedback, required once after each post-training assessment. */
export async function giveFeedback(page: Page) {
  const form = page.getByRole("dialog", { name: "Training & assessment feedback" });
  await expect(form).toBeVisible();
  for (let i = 0; i < 5; i++) await form.locator(".feedback-scale").nth(i).locator("label").nth(3).click();
  await form.getByRole("button", { name: "Submit feedback" }).click();
  await expect(page.getByText("Thank you for your feedback")).toBeVisible();
}

export async function answerAll(page: Page) {
  const total = await page.locator(".q-cell").count();
  for (let i = 0; i < total; i++) {
    await page.locator(".q-cell").nth(i).click();
    await page.locator(".exam-option").first().click();
    await expect(page.locator("#exam-save")).toContainText("saved on the server");
  }
}

export async function submitAssessment(page: Page) {
  await page.getByRole("button", { name: "Review & submit" }).click();
  await page.getByRole("button", { name: "Submit assessment" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Submit assessment" }).click();
  await page.waitForURL(/\/results\//);
}
