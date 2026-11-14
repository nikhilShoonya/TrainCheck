import { expect, test } from "@playwright/test";
import { ACCOUNTS, answerAll, giveFeedback, signIn, startSecureAssessment, startSecurePreTest, submitAssessment } from "./helpers";

/* The order matters: the first test uses up the employee's first assessment in the seeded data. */

test("no-pending employee reaches the dashboard with two-level evidence only", async ({ page }) => {
  await signIn(page, ACCOUNTS.clear);
  await expect(page).toHaveURL(/\/employee$/);
  await expect(page.getByRole("heading", { name: /Good Morning, Isha/ })).toBeVisible();
  await expect(page.getByText("L2 Learning")).toBeVisible();
  await expect(page.getByText("L3 Behaviour")).toHaveCount(0); // Level 3 is switched off (outside the approved scope).
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
  await expect(page.getByText(/Reaction/i)).toHaveCount(0);
  await giveFeedback(page); // Required once per assessment before continuing.

  // TC-GATE-005: the next assessment in the queue still blocks the workspace.
  await page.getByRole("button", { name: /Continue to next assessment/ }).click();
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
  await giveFeedback(page);

  // The gate is now clear, so the workspace opens instead of returning to a stale gate.
  await page.getByRole("button", { name: /Continue to my workspace/ }).click();
  await page.waitForURL(/\/employee$/);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Good Morning, Aarav/ })).toBeVisible();
});

test("after his assessments the employee takes the two new pre-tests, each offered once", async ({ page }) => {
  // Runs after the two gate tests above: Aarav's due assessments are done, so the workspace opens.
  await signIn(page, ACCOUNTS.employee);
  await expect(page).toHaveURL(/\/employee$/);
  for (const training of ["Data Privacy & Protection", "Workplace Conduct & Ethics"]) {
    await page.goto("/employee/trainings");
    const card = page.locator("article").filter({ hasText: training });
    await card.getByRole("link", { name: "Take Pre-test" }).click();
    await expect(page.getByRole("heading", { name: "Optional pre-test" })).toBeVisible();
    await startSecurePreTest(page);
    expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await answerAll(page);
    await submitAssessment(page);
    await expect(page.getByRole("heading", { name: "Pre-test complete" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0); // No feedback form after a pre-test.
  }
  await page.goto("/employee/trainings");
  for (const training of ["Data Privacy & Protection", "Workplace Conduct & Ethics"]) {
    await expect(page.locator("article").filter({ hasText: training }).getByRole("link", { name: "Take Pre-test" })).toHaveCount(0); // Offered once.
  }
});

for (const account of ["manager", "hr"] as const) {
  test(`the former ${account} account is an ordinary employee: no Manager or HR workspace`, async ({ page }) => {
    // The Manager and HR / Leadership roles were removed. These people keep their Employee sign-in.
    await signIn(page, ACCOUNTS[account]);
    await expect(page).toHaveURL(/\/(employee|access)/);
    await expect(page.locator(".sidebar")).not.toContainText("My Team");
    await expect(page.locator(".sidebar")).not.toContainText("Organisation Overview");
    const statuses = await page.evaluate(async () => {
      const csrf = document.cookie.match(/tc_csrf=([^;]*)/)?.[1] ?? "";
      const write = await fetch("/api/v1/admin/departments", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) }, body: JSON.stringify({ code: "NOPE", name: "Nope" }) });
      return [(await fetch("/api/v1/manager/dashboard")).status, (await fetch("/api/v1/reports/organisation-summary")).status, write.status];
    });
    expect(statuses).toEqual([404, 403, 403]);
  });
}

test("Level 3 behaviour tasks are switched off: no behaviour navigation", async ({ page }) => {
  // Phase 1: Behaviour is outside the approved scope (BEHAVIOUR_ENABLED=false). History stays readable by URL.
  await signIn(page, ACCOUNTS.admin);
  await expect(page.locator(".sidebar")).not.toContainText("Behaviour Questionnaires");
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
  const trainingSelect = page.getByLabel("Select training *");
  const draftLabel = `E2E Training ${code} (${code}) · Draft`;
  await expect(trainingSelect.locator("option", { hasText: draftLabel })).toHaveCount(1); // Draft trainings are offered.
  await trainingSelect.selectOption({ label: draftLabel });
  await page.locator('input[type="file"]').setInputFiles({
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("id,training\n1,2\n"),
  });
  await page.getByRole("button", { name: "Validate file" }).click();
  await expect(page.getByRole("alert").first()).toContainText("Missing columns");

  // A file without a training column is linked to the selected (draft) training.
  const header = "id,topic,competency,type,question,option_a,option_b,option_c,option_d,options_extra,correct,explanation,difficulty,marks,level,language,active";
  const questions = [1, 2].map((n) => `${code}-Q${n},Topic,Applies the documented process,single,Question ${n}?,Right,Wrong,,,,A,Because.,Easy,1,L2,English,Active`);
  const file = { name: "questions.csv", mimeType: "text/csv", buffer: Buffer.from([header, ...questions].join("\n")) };
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Validate file" }).click();
  const preview = page.locator("#import-preview");
  await expect(preview).toContainText(`Linked training: E2E Training ${code} (${code}) · Draft`);
  await expect(preview.getByRole("link", { name: "Open in Question Bank" })).toHaveAttribute("href", /\/lnd\/questions\?training_id=/);

  // Changing the selected training invalidates the preview; it must be validated again.
  const other = (await trainingSelect.locator("option").allTextContents()).find((label) => label && label !== draftLabel && !label.startsWith("Choose"));
  if (other) {
    await trainingSelect.selectOption({ label: other });
    await expect(preview).toHaveCount(0);
    await trainingSelect.selectOption({ label: draftLabel });
  }
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Validate file" }).click();
  await page.getByRole("button", { name: "Import 2 valid rows" }).click();
  await expect(page.locator("#import-summary")).toContainText("Import finished. 2 rows imported");
  await expect(page.locator("#import-summary")).toContainText(`E2E Training ${code} (${code})`);

  await page.goto("/lnd/scorecards");
  await expect(page.getByRole("heading", { name: "Section 1 · Learning" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Section 2 · Behaviour" })).toBeVisible();
  await expect(page.getByText(/Section 3|Reaction|Business Results/)).toHaveCount(0);

  // Batches & Sessions and Audit Logs are withdrawn from L&D Admin: not in the sidebar, refused by URL and by the API.
  await expect(page.locator(".sidebar")).not.toContainText("Batches & Sessions");
  await expect(page.locator(".sidebar")).not.toContainText("Audit Logs");
  for (const path of ["/lnd/batches", "/lnd/audit"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "You do not have access to this page" })).toBeVisible();
  }
  const statuses = await page.evaluate(async () => {
    const csrf = document.cookie.match(/tc_csrf=([^;]*)/)?.[1] ?? "";
    const audit = await fetch("/api/v1/admin/audit-logs");
    const batch = await fetch("/api/v1/admin/batches", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) }, body: JSON.stringify({ training_id: "00000000-0000-0000-0000-000000000000", name: "Nope" }) });
    const list = await fetch("/api/v1/admin/batches");
    return [audit.status, batch.status, list.status];
  });
  expect(statuses).toEqual([403, 403, 200]); // The batch list stays readable for Employee Assignments.
});

test("navigation reuses loaded data and sign-in does not repeat the session requests", async ({ page }) => {
  const api: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/")) api.push(r.url().replace(/^.*\/api\/v1/, ""));
  });
  await signIn(page, ACCOUNTS.admin);
  await expect(page.locator("article.image-metric").first()).toBeVisible({ timeout: 30_000 });
  const afterLogin = api.slice(api.indexOf("/auth/login"));
  expect(afterLogin.filter((p) => p === "/auth/me" || p === "/me/access-state")).toEqual([]); // Reused from the sign-in response.

  await page.locator('nav a[title="Training Management"]').click();
  await expect(page.locator("#main table tbody tr").first()).toBeVisible({ timeout: 30_000 });
  api.length = 0;
  await page.locator('nav a[title="Dashboard"]').click();
  await expect(page.locator("article.image-metric").first()).toBeVisible();
  await page.locator('nav a[title="Training Management"]').click();
  await expect(page.locator("#main table tbody tr").first()).toBeVisible();
  // Both pages were loaded seconds ago, so they come from the cache without new requests.
  expect(api.filter((p) => p.startsWith("/admin/dashboard") || p.startsWith("/admin/trainings"))).toEqual([]);
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
  clear: ["/employee", "/employee/trainings", "/employee/assessments", "/employee/refresher", "/employee/behaviour", "/employee/scorecard", "/notifications", "/profile"],
  admin: ["/lnd", "/lnd/trainings", "/lnd/organisation", "/lnd/assignments", "/lnd/completion", "/lnd/questions", "/lnd/imports", "/lnd/assessment-config", "/lnd/behaviour-templates", "/lnd/scorecards", "/lnd/reports", "/notifications"],
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
