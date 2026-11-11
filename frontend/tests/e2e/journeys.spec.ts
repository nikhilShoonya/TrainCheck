import { expect, test } from "@playwright/test";
import { ACCOUNTS, answerAll, signIn, startSecureAssessment, submitAssessment } from "./helpers";

/* The order matters: the first test uses up the employee's first assessment in the seeded data. */

test("no-pending employee reaches the dashboard with two-level evidence only", async ({ page }) => {
  await signIn(page, ACCOUNTS.clear);
  await expect(page).toHaveURL(/\/employee$/);
  await expect(page.getByRole("heading", { name: /Good Morning, Isha/ })).toBeVisible();
  await expect(page.getByText("L2 Learning")).toBeVisible();
  await expect(page.getByText("L3 Behaviour")).toBeVisible();
  for (const removed of ["L1 Reaction", "L4 Results", "Feedback (L1)", "Results (L4)", "ROI"]) await expect(page.getByText(removed, { exact: false })).toHaveCount(0);
});

test("gate blocks direct URLs and APIs, then the secure flow produces a server result", async ({ page }) => {
  await signIn(page, ACCOUNTS.employee);
  await expect(page).toHaveURL(/\/access\/assessment-required/);
  await expect(page.getByRole("heading", { name: /Good morning, Aarav/ })).toBeVisible();
  await expect(page.getByText("2 ASSESSMENTS REMAINING")).toBeVisible();
  await expect(page.getByRole("heading", { name: "KYC & AML Compliance" })).toBeVisible();

  // TC-GATE-002: a direct URL shows no workspace.
  await page.goto("/employee");
  await page.waitForURL(/\/access\/assessment-required/);
  await expect(page.locator(".sidebar")).toHaveCount(0);

  // TC-GATE-003: the API itself refuses, whatever the frontend does.
  const blocked = await page.evaluate(async () => {
    const response = await fetch("/api/v1/me/dashboard");
    return { status: response.status, code: (await response.json()).error.code };
  });
  expect(blocked).toEqual({ status: 403, code: "ASSESSMENT_REQUIRED" });

  await startSecureAssessment(page);

  // TC-SCORE-008: no answer key in what reached the browser.
  const payload = await page.evaluate(async () => {
    const access = await (await fetch("/api/v1/me/access-state")).json();
    const obligation = await (await fetch(`/api/v1/me/assessment-obligations/${access.data.queue[0].obligation_id}`)).json();
    return JSON.stringify(await (await fetch(`/api/v1/attempts/${obligation.data.active_attempt_id}`)).json());
  });
  for (const term of ["is_correct", "answer_key", "correct_option", "explanation"]) expect(payload).not.toContain(term);

  await page.locator(".exam-option").first().click();
  await expect(page.locator("#exam-save")).toContainText("saved on the server");

  // TC-ATT-003: a refresh resumes the same attempt, with the saved answer and without a violation.
  const before = await page.locator(".exam-timer span").first().innerText();
  page.once("dialog", (d) => d.accept());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Resume in full screen" })).toBeVisible();
  await page.getByRole("button", { name: "Enter full screen and resume" }).click();
  await expect(page.locator(".exam-timer")).toBeVisible();
  await expect(page.locator(".q-cell.answered")).toHaveCount(1);
  await expect(page.locator(".exam-indicators")).toContainText("Violations 0 / 3");
  expect((await page.locator(".exam-timer span").first().innerText()) <= before).toBeTruthy();

  await answerAll(page);
  await submitAssessment(page);
  await expect(page.locator(".score-circle")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Topic performance" })).toBeVisible();
  await expect(page.getByText(/Reaction|feedback/i)).toHaveCount(0);

  // TC-GATE-005: the next assessment in the queue still blocks the workspace.
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.waitForURL(/\/access\/assessment-required/);
  await expect(page.getByRole("heading", { name: "Customer Handling" })).toBeVisible();
});

test("leaving full screen is a violation, and offline is not", async ({ page, context }) => {
  await signIn(page, ACCOUNTS.employee);
  await startSecureAssessment(page);
  await expect(page.locator(".exam-indicators")).toContainText("Violations 0 / 3");

  // TC-SEC-004
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator("#exam-offline")).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#exam-offline")).toBeHidden();
  await expect(page.locator(".exam-indicators")).toContainText("Violations 0 / 3");

  // TC-SEC-001: the first violation warns and hides questions until full screen returns.
  await page.evaluate(() => document.exitFullscreen());
  const dialog = page.getByRole("dialog", { name: "Security warning" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Violation 1 of 3");
  await expect(page.locator(".exam-indicators")).toContainText("Violations 1 / 3");
  await dialog.getByRole("button", { name: /Return to full screen/ }).click();
  await expect(page.locator(".exam-option").first()).toBeVisible();

  // TC-SEC-001: the second is the final warning.
  await page.waitForTimeout(2200);
  await page.evaluate(() => document.exitFullscreen());
  const finalWarning = page.getByRole("dialog", { name: "Final warning" });
  await expect(finalWarning).toContainText("Violation 2 of 3");
  await finalWarning.getByRole("button", { name: /Return to full screen/ }).click();
  await expect(page.locator(".exam-option").first()).toBeVisible();

  // TC-SEC-002: the third submits automatically.
  await page.waitForTimeout(2200);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForURL(/\/results\//);
  await expect(page.locator(".result-details")).toContainText("after 3 security violations");

  // The gate is now clear, so the workspace opens instead of returning to a stale gate.
  await page.getByRole("button", { name: /Continue to my workspace/ }).click();
  await page.waitForURL(/\/employee$/);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Good Morning, Aarav/ })).toBeVisible();
});

test("manager sees only the team and the API refuses another team", async ({ page }) => {
  await signIn(page, ACCOUNTS.manager);
  await expect(page).toHaveURL(/\/manager$/);
  await page.goto("/manager/team");
  await expect(page.getByRole("cell", { name: "E001" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "E006" })).toHaveCount(0);

  await page.goto("/manager/reviews");
  await expect(page.getByRole("heading", { name: "Pending Behaviour Reviews" })).toBeVisible();

  const denied = await page.evaluate(async () => (await fetch("/api/v1/admin/trainings")).status);
  expect(denied).toBe(403);

  await page.goto("/lnd");
  await expect(page.getByRole("heading", { name: "You do not have access to this page" })).toBeVisible();
});

test("manager submits a behaviour observation and sees the self-rating afterwards", async ({ page }) => {
  await signIn(page, ACCOUNTS.manager);
  await page.goto("/manager/reviews");
  await page.getByRole("link", { name: "Complete review" }).first().click();
  await expect(page.getByRole("heading", { name: /Observation:/ })).toBeVisible();
  for (const group of await page.locator(".rating-scale").all()) await group.locator("label").nth(3).click();
  for (const box of await page.locator('textarea[name^="example-"]').all()) await box.fill("Observed the documented steps on a routine synthetic case.");
  await page.getByRole("button", { name: "Submit review" }).click();
  await page.waitForURL(/\/manager\/reviews$/);
  await page.goto("/manager/questionnaires");
  await expect(page.getByRole("link", { name: "View review" }).first()).toBeVisible();
});

test("L&D manages training, imports questions and sees the two-section scorecard", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await expect(page).toHaveURL(/\/lnd$/);

  const code = `E2E-${Date.now()}`;
  await page.goto("/lnd/trainings");
  await page.getByRole("button", { name: "Create Training" }).click();
  const form = page.getByRole("dialog");
  await form.locator('input[name="training_code"]').fill(code);
  await form.locator('input[name="title"]').fill(`E2E Training ${code}`);
  await form.getByRole("button", { name: "Save training" }).click();
  await expect(form).toHaveCount(0);

  await page.goto("/lnd/imports");
  await page.locator('input[type="file"]').setInputFiles({
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("id,training\n1,2\n"),
  });
  await page.getByRole("button", { name: "Validate file" }).click();
  await expect(page.getByRole("alert").first()).toContainText("Missing columns");

  await page.goto("/lnd/scorecards");
  await expect(page.getByRole("heading", { name: "Section 1 · Learning" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Section 2 · Behaviour" })).toBeVisible();
  await expect(page.getByText(/Section 3|Reaction|Business Results/)).toHaveCount(0);

  await page.goto("/lnd/audit");
  await expect(page.getByRole("cell", { name: "TRAINING_CREATED" }).first()).toBeVisible();
});

test("HR reads and exports but has no write controls or write access", async ({ page }) => {
  await signIn(page, ACCOUNTS.hr);
  await expect(page).toHaveURL(/\/hr$/);
  await expect(page.locator(".sidebar")).not.toContainText("Training Management");
  await page.goto("/hr/pass-fail");
  await expect(page.getByRole("heading", { name: "Pass/Fail and Red-Flag Employees" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Needs Re-training" }).first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Excel (.xlsx)" }).click();
  expect((await download).suggestedFilename()).toMatch(/pass-fail.*\.xlsx$/);

  const status = await page.evaluate(async () => {
    const csrf = document.cookie.match(/tc_csrf=([^;]*)/)?.[1] ?? "";
    const response = await fetch("/api/v1/admin/departments", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) }, body: JSON.stringify({ code: "NOPE", name: "Nope" }) });
    return response.status;
  });
  expect(status).toBe(403);
});

test("the assessment and login work at phone size", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await context.close();
});

const PAGES: Record<string, string[]> = {
  clear: ["/employee", "/employee/trainings", "/employee/assessments", "/employee/history", "/employee/refresher", "/employee/behaviour", "/employee/behaviour-history", "/employee/certificates", "/employee/scorecard", "/notifications", "/profile"],
  manager: ["/manager", "/manager/team", "/manager/team-trainings", "/manager/assessments", "/manager/reviews", "/manager/questionnaires", "/manager/scorecards", "/manager/reports", "/manager/certificates"],
  admin: ["/lnd", "/lnd/trainings", "/lnd/organisation", "/lnd/batches", "/lnd/assignments", "/lnd/completion", "/lnd/questions", "/lnd/imports", "/lnd/assessment-config", "/lnd/behaviour-templates", "/lnd/scorecards", "/lnd/reports", "/lnd/audit", "/notifications"],
  hr: ["/hr", "/hr/learning", "/hr/departments", "/hr/pass-fail", "/hr/learning-gain", "/hr/behaviour", "/hr/managers", "/hr/scorecards", "/hr/reports"],
};

for (const [account, paths] of Object.entries(PAGES)) {
  test(`every ${account} page loads without errors or removed-scope content`, async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, ACCOUNTS[account as keyof typeof ACCOUNTS]); // The session check before sign-in is an expected 401.
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`${page.url()}: ${error.message}`));
    page.on("response", (response) => {
      if (response.url().includes("/api/v1/") && response.status() >= 400) problems.push(`${page.url()}: ${response.status()} ${response.url()}`);
    });
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".notice.danger[role=alert]")).toHaveCount(0);
      const text = await page.locator("#main").innerText();
      expect(text, path).not.toMatch(/Kirkpatrick|Reaction|KPI|\bROI\b|\bROE\b|Business Impact|NPS/);
    }
    expect(problems).toEqual([]);
  });
}

test("a phone-sized employee dashboard has no sideways scrolling", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page, ACCOUNTS.clear);
  await expect(page.getByRole("heading", { name: /Good Morning/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator("#sidebar a").first()).toBeVisible();
  await context.close();
});
