import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* Permanent training deletion (typed code, real counts, errors, repeat) and Unassigned Questions (card, table, preview,
   edit, single and bulk assignment). All API traffic is mocked with synthetic data; any request the mock does not know
   fails the test. Run against an isolated frontend (E2E_BASE_URL), never the real backend. */

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ARCHIVED = "33333333-3333-4333-8333-333333333333";

const training = (id: string, code: string, title: string, status = "ACTIVE") => ({
  id, training_code: code, title, description: null, category: "Synthetic", status, owner_name: null, owner_employee_id: null, trainer_name: null, trainer_id: null,
  target_scope: "COMMON", departments: [], functions: [], competencies: [], pretest_enabled: true, behaviour_enabled: false, followup_days: [30],
  item_minimum_sample: 10, refresher_text: null, refresher_url: null, assigned_count: 3, completed_count: 2, config: null, eligible_questions: 0,
  config_ready: false, assessment_readiness: { ready: false, reason: null, message: "", action: null }, pending_scheduling_count: 0, unavailable_count: 0,
});

const question = (id: string, code: string, status = "ACTIVE") => ({
  id, question_code: code, topic: "Synthetic topic", competency_id: null, competency: null, department_id: null, department: null, function_id: null, function: null,
  question_type: "MCQ_SINGLE", question_text: `Synthetic question ${code}?`, difficulty: "EASY", language: "English", marks: 1, status, version: 2, randomise_options: true, trainings: [],
});

const COUNTS = {
  assignments: 3, completions: 2, assessments: 3, attempts: 4, submitted_attempts: 4, attempt_answers: 40, violations: 1, feedback: 2, assessment_configs: 2, batches: 1, sessions: 0,
  materials: 1, behaviour_reviews: 0, behaviour_questionnaires: 0, question_links: 12, questions_becoming_unassigned: 10, question_imports: 1, report_exports: 0, report_schedules: 0, notifications: 6,
};

interface World {
  unknown: string[];
  trainings: ReturnType<typeof training>[];
  unassigned: ReturnType<typeof question>[];
  deletes: { path: string; body: unknown }[];
  assigns: unknown[];
  deleteFailures: number;
  assignGone: boolean;
}

const newWorld = (): World => ({
  unknown: [],
  trainings: [training(ALPHA, "ALPHA-1", "Alpha Compliance"), training(BETA, "BETA-1", "Beta Sales"), training(ARCHIVED, "OLD-1", "Old Archived", "ARCHIVED")],
  unassigned: [question("q-1", "UQ-001"), question("q-2", "UQ-002"), question("q-3", "UQ-003", "INACTIVE")],
  deletes: [],
  assigns: [],
  deleteFailures: 0,
  assignGone: false,
});

async function mockApi(context: BrowserContext, world: World) {
  await context.addInitScript(() => {
    document.cookie = "tc_csrf=synthetic-test; path=/";
  });
  await context.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta: {} }) });
    const fail = (status: number, code: string, message: string) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message, request_id: "synthetic" } }) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-admin", employee_id: "e-admin", employee_code: "SYN-ADMIN", full_name: "Synthetic Admin", email: "admin@example.test", roles: ["LD_ADMIN", "EMPLOYEE"], primary_role: "LD_ADMIN", features: { behaviour: false, password_change: true } }, csrf_token: "synthetic-test" });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "OPEN_DASHBOARD", queue: [], unavailable: [], feedback_due: null, countdown: null, next_change_at: null, countdown_starts_at: null, server_now: new Date().toISOString() });
    if (path === "/me/notifications/unread-count") return json({ unread: 0 });
    if (["/admin/departments", "/admin/functions", "/admin/trainers", "/admin/competencies"].includes(path)) return json([]);
    if (path === "/admin/trainings" && method === "GET") return json(world.trainings);
    const preview = /^\/admin\/trainings\/([^/]+)\/deletion-preview$/.exec(path);
    if (preview && method === "GET") {
      const t = world.trainings.find((x) => x.id === preview[1]);
      if (!t) return fail(404, "NOT_FOUND", "This training no longer exists. It may already have been deleted.");
      return json({ training: { id: t.id, code: t.training_code, title: t.title, status: t.status }, counts: COUNTS });
    }
    const removal = /^\/admin\/trainings\/([^/]+)$/.exec(path);
    if (removal && method === "DELETE") {
      const body = request.postDataJSON();
      world.deletes.push({ path, body });
      const t = world.trainings.find((x) => x.id === removal[1]);
      if (!t) return fail(404, "NOT_FOUND", "This training no longer exists. It may already have been deleted.");
      if (world.deleteFailures > 0) {
        world.deleteFailures -= 1;
        return fail(409, "TRAINING_BUSY", "This training is being changed by requests that are still running. Nothing was deleted. Try again in a moment.");
      }
      world.trainings = world.trainings.filter((x) => x.id !== t.id);
      return json({ deleted: true, training: { id: t.id, code: t.training_code, title: t.title, status: t.status }, counts: COUNTS, files_pending_removal: 0 });
    }
    if (path === "/admin/questions/summary") return json(world.trainings.filter((t) => t.id === BETA).map((t) => ({ training_id: t.id, title: t.title, code: t.training_code, status: t.status, test_type: "POST_TEST", question_count: 4, active: 4, inactive: 0, unclassified: 0 })));
    if (path === "/admin/questions/unassigned-summary") {
      const active = world.unassigned.filter((q) => q.status === "ACTIVE").length;
      return json({ question_count: world.unassigned.length, active, inactive: world.unassigned.length - active });
    }
    if (path === "/admin/questions" && method === "GET") {
      if (url.searchParams.get("unassigned") !== "true") return fail(400, "VALIDATION_ERROR", "The unassigned view must ask the server for unassigned questions.");
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      return json(world.unassigned.filter((q) => !search || q.question_code.toLowerCase().includes(search)));
    }
    if (path === "/admin/questions/assign" && method === "POST") {
      const body = request.postDataJSON() as { question_ids: string[]; training_id: string; test_type: string };
      world.assigns.push(body);
      if (world.assignGone) return fail(404, "NOT_FOUND", "The selected training no longer exists. Choose another training.");
      const t = world.trainings.find((x) => x.id === body.training_id)!;
      const results = body.question_ids.map((id) => {
        const q = world.unassigned.find((x) => x.id === id)!;
        return { question_id: id, question_code: q.question_code, status: "ASSIGNED", test_type: body.test_type, warning: q.status === "ACTIVE" ? null : "Inactive: it will not be drawn until it is activated.", message: "Assigned." };
      });
      world.unassigned = world.unassigned.filter((q) => !body.question_ids.includes(q.id));
      const notDrawn = results.filter((r) => r.warning).length;
      return json({ training: { id: t.id, title: t.title, code: t.training_code }, test_type: body.test_type, summary: { ASSIGNED: results.length, ALREADY_ASSIGNED: 0, OTHER_TEST: 0, NOT_FOUND: 0, NOT_DRAWN: notDrawn }, results });
    }
    const one = /^\/admin\/questions\/(q-\d)$/.exec(path);
    if (one && method === "GET") {
      const q = world.unassigned.find((x) => x.id === one[1])!;
      return json({ ...q, explanation: "Synthetic explanation.", options: [{ id: "o1", text: "Synthetic right", is_correct: true }, { id: "o2", text: "Synthetic wrong", is_correct: false }] });
    }
    world.unknown.push(`${method} ${path}${url.search}`);
    return fail(404, "NOT_FOUND", "Not mocked.");
  });
}

async function openDelete(page: Page, title: string) {
  await page.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  return page.getByRole("dialog", { name: "Permanently delete training?" });
}

test.describe("Permanent training deletion (mocked API)", () => {
  let world: World;
  test.beforeEach(async ({ context }) => {
    world = newWorld();
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("shows the real counts, needs the typed code, survives an error, and deletes only after the server confirms", async ({ page }) => {
    await page.goto("/lnd/trainings");
    await expect(page.getByRole("row", { name: /Alpha Compliance/ })).toBeVisible();

    // Cancel sends nothing.
    let dialog = await openDelete(page, "Alpha Compliance");
    await expect(dialog).toContainText("Alpha Compliance (ALPHA-1)");
    await expect(dialog).toContainText("3 employee assignments");
    await expect(dialog).toContainText("4 assessment attempts with their answers and scores");
    await expect(dialog).toContainText("2 feedback responses");
    await expect(dialog).toContainText("assignments, completion records, scores and assessment history");
    await expect(dialog).toContainText("Employees and their accounts, departments");
    await expect(dialog).toContainText("10 questions are linked only to this training and will be listed under Unassigned Questions");
    const confirm = dialog.getByRole("button", { name: "Permanently delete training" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(world.deletes).toEqual([]);

    // The wrong code keeps the button disabled; the server's refusal is shown and the training stays.
    dialog = await openDelete(page, "Alpha Compliance");
    const code = dialog.getByLabel(/Type the training code/);
    await code.fill("BETA-1");
    await expect(dialog.getByRole("button", { name: "Permanently delete training" })).toBeDisabled();
    await code.fill("alpha-1");
    world.deleteFailures = 1;
    await dialog.getByRole("button", { name: "Permanently delete training" }).click();
    await expect(dialog.getByRole("alert").last()).toContainText("Nothing was deleted");
    await expect(dialog).toBeVisible(); // Still open for a retry (the page behind it is hidden from the a11y tree).
    expect(world.trainings.map((t) => t.id)).toContain(ALPHA);

    // Confirmed again: success only after the server answers, then the list refreshes.
    await dialog.getByRole("button", { name: "Permanently delete training" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Alpha Compliance was permanently deleted.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Alpha Compliance/ })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /Beta Sales/ })).toBeVisible();
    expect(world.deletes).toEqual([
      { path: `/admin/trainings/${ALPHA}`, body: { confirmation_code: "alpha-1" } },
      { path: `/admin/trainings/${ALPHA}`, body: { confirmation_code: "alpha-1" } },
    ]);
  });

  test("a training already deleted elsewhere closes the dialog and refreshes the list", async ({ page }) => {
    await page.goto("/lnd/trainings");
    const dialog = await openDelete(page, "Beta Sales");
    await dialog.getByLabel(/Type the training code/).fill("BETA-1");
    world.trainings = world.trainings.filter((t) => t.id !== BETA); // Someone else deleted it meanwhile.
    await dialog.getByRole("button", { name: "Permanently delete training" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("This training was already deleted. The list has been refreshed.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Beta Sales/ })).toHaveCount(0);
  });
});

test.describe("Unassigned Questions (mocked API)", () => {
  let world: World;
  test.beforeEach(async ({ context }) => {
    world = newWorld();
    await mockApi(context, world);
  });
  test.afterEach(() => {
    expect(world.unknown, "every API request must be mocked").toEqual([]);
  });

  test("the card opens the server-filtered table; preview, edit, refresh and Back work", async ({ page }) => {
    await page.goto("/lnd/questions");
    const card = page.getByRole("article", { name: "Unassigned Questions" });
    await expect(card).toContainText("3 Questions");
    await expect(card).toContainText("Not linked to any training");
    await expect(page.getByRole("article", { name: "Beta Sales" })).toBeVisible();
    await card.getByRole("link", { name: /View Questions/ }).click();
    await expect(page).toHaveURL(/\/lnd\/questions\/unassigned$/);
    await expect(page.getByRole("heading", { name: "Unassigned Questions" })).toBeVisible();
    await expect(page.getByText("3 unassigned questions.")).toBeVisible();

    await page.getByRole("row", { name: /UQ-001/ }).getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: "Question Preview" });
    await expect(preview).toContainText("Synthetic right");
    await preview.getByRole("button", { name: "Close dialog" }).click();

    await page.getByRole("row", { name: /UQ-002/ }).getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    await page.reload();
    await expect(page.getByText("3 unassigned questions.")).toBeVisible();
    await page.getByRole("link", { name: "Back to Trainings" }).click();
    await expect(page).toHaveURL(/\/lnd\/questions$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/lnd\/questions\/unassigned$/);
  });

  test("bulk and single assignment: training and test chosen, outcomes shown, list and count refreshed", async ({ page }) => {
    await page.goto("/lnd/questions/unassigned");
    const actions = page.getByRole("group", { name: "Question actions" });
    await expect(actions.getByRole("button", { name: "Assign to Training" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Select UQ-001" }).check();
    await page.getByRole("checkbox", { name: "Select UQ-003" }).check();
    await expect(actions).toContainText("2 questions selected");
    await actions.getByRole("button", { name: "Assign to Training" }).click();

    const dialog = page.getByRole("dialog", { name: "Assign to Training" });
    await expect(dialog).toContainText("2 questions selected");
    await expect(dialog).toContainText("1 selected question is inactive");
    const trainingSelect = dialog.getByLabel("Training *");
    await expect(trainingSelect.locator("option", { hasText: "Old Archived" })).toHaveCount(0); // Archived trainings cannot receive questions.
    await trainingSelect.selectOption({ label: "Beta Sales (BETA-1)" });
    await expect(dialog.getByRole("button", { name: "Assign questions" })).toBeDisabled();
    await dialog.getByLabel("Test type *").selectOption("POST_TEST");
    await expect(dialog).toContainText("Assign 2 questions to Beta Sales · Post-test");
    await dialog.getByRole("button", { name: "Assign questions" }).click();

    const result = page.getByRole("dialog", { name: "Assignment result" });
    await expect(result).toContainText("2 assigned to Beta Sales · Post-test, 1 will not be drawn until fixed or activated.");
    await expect(result.getByRole("row", { name: /UQ-003/ })).toContainText("not be drawn until it is activated");
    await result.getByRole("button", { name: "Done" }).click();
    expect(world.assigns).toEqual([{ question_ids: ["q-1", "q-3"], training_id: BETA, test_type: "POST_TEST" }]);
    await expect(page.getByText("1 unassigned question.")).toBeVisible();
    await expect(page.getByRole("row", { name: /UQ-001/ })).toHaveCount(0);
    await expect(actions).toContainText("0 questions selected");

    // A single question, from its row, to the pre-test.
    await page.getByRole("row", { name: /UQ-002/ }).getByRole("button", { name: /^Assign/ }).click();
    const single = page.getByRole("dialog", { name: "Assign to Training" });
    await expect(single).toContainText("1 question selected");
    await single.getByLabel("Training *").selectOption({ label: "Alpha Compliance (ALPHA-1)" });
    await single.getByLabel("Test type *").selectOption("PRE_TEST");
    await single.getByRole("button", { name: "Assign questions" }).click();
    await page.getByRole("dialog", { name: "Assignment result" }).getByRole("button", { name: "Done" }).click();
    expect(world.assigns[1]).toEqual({ question_ids: ["q-2"], training_id: ALPHA, test_type: "PRE_TEST" });
    await expect(page.getByText("No unassigned questions.")).toBeVisible();

    // With nothing unassigned, the card is gone.
    await page.getByRole("link", { name: "Back to Trainings" }).click();
    await expect(page.getByRole("article", { name: "Beta Sales" })).toBeVisible();
    await expect(page.getByRole("article", { name: "Unassigned Questions" })).toHaveCount(0);
  });

  test("a destination deleted meanwhile is reported and the selection is kept for a retry", async ({ page }) => {
    await page.goto("/lnd/questions/unassigned");
    await page.getByRole("checkbox", { name: "Select UQ-001" }).check();
    await page.getByRole("group", { name: "Question actions" }).getByRole("button", { name: "Assign to Training" }).click();
    const dialog = page.getByRole("dialog", { name: "Assign to Training" });
    await dialog.getByLabel("Training *").selectOption({ label: "Beta Sales (BETA-1)" });
    await dialog.getByLabel("Test type *").selectOption("POST_TEST");
    world.assignGone = true;
    await dialog.getByRole("button", { name: "Assign questions" }).click();
    await expect(dialog.getByRole("alert").last()).toContainText("no longer exists");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("group", { name: "Question actions" })).toContainText("1 question selected");
    await expect(page.getByText("3 unassigned questions.")).toBeVisible();
  });
});
