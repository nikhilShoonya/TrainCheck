import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

/* Answer saving in the real exam page, against a mocked API: every /api/v1 request is answered in the browser,
   so no backend or database is involved and no seeded data is needed. The mock follows the backend's
   answer-save contract, including compare-and-set revisions.
   Run: npx playwright test tests/e2e/answer-saving.spec.ts */

const ATTEMPT = "a0000000-0000-4000-8000-000000000001";
const ENROLMENT = "e0000000-0000-4000-8000-000000000001";
const ACCOUNT = "u0000000-0000-4000-8000-000000000001";
const PREFIX = "traincheck.pending-answers.v1:";
const KEY = `${PREFIX}${ACCOUNT}:${ATTEMPT}`;
const QUESTIONS = ["q1", "q2"].map((id, i) => ({
  attempt_question_id: id,
  position: i + 1,
  question_text: `Synthetic question ${i + 1}`,
  question_type: "MCQ_SINGLE",
  topic: "Synthetic",
  language: "English",
  marks: 1,
  options: ["a", "b", "c"].map((o, j) => ({ option_id: `${id}-${o}`, label: "ABC"[j], text: `Option ${o.toUpperCase()}` })),
}));

type Hold = { release: () => void };

class MockApi {
  answers = new Map<string, { selected: string[]; revision: number }>();
  /** The operation ID of the save that wrote each answer, as the backend keeps it. */
  writers = new Map<string, string | null>();
  /** How the next answer saves are handled; "ok" follows the backend. */
  saveMode: "ok" | "html" | "hang" = "ok";
  submitMode: "ok" | "hang" = "ok";
  resultMode: "ok" | "hang" = "ok";
  saves: { question: string; body: { selected_option_ids: string[]; base_revision?: number; op_id?: string } }[] = [];
  held: Hold[] = [];
  expiresAt: number;
  serverNow: number;

  constructor(serverNow: number, durationMs = 15 * 60_000) {
    this.serverNow = serverNow;
    this.expiresAt = serverNow + durationMs;
  }

  attempt() {
    return {
      attempt_id: ATTEMPT,
      obligation_id: "o1",
      assessment_type: "PRE_TEST",
      training_title: "Synthetic training",
      attempt_number: 1,
      max_attempts: 1,
      status: "IN_PROGRESS",
      started_at: new Date(this.serverNow).toISOString(),
      expires_at: new Date(this.expiresAt).toISOString(),
      server_now: new Date(this.serverNow).toISOString(),
      remaining_seconds: Math.round((this.expiresAt - this.serverNow) / 1000),
      violation_count: 0,
      violation_limit: 3,
      require_fullscreen: false,
      monitored: false,
      questions: QUESTIONS.map((q) => ({ ...q, selected_option_ids: this.answers.get(q.attempt_question_id)?.selected ?? [], revision: this.answers.get(q.attempt_question_id)?.revision ?? 0, op_id: this.writers.get(q.attempt_question_id) ?? null, marked_for_review: false, saved_at: null })),
    };
  }

  async handle(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status < 400 ? { data, meta: {} } : { error: data }) });
    if (path === "/auth/me") return json({ user: { id: ACCOUNT, employee_id: "emp1", employee_code: "E1", full_name: "Synthetic Employee", email: "synthetic@example.test", department: null, function: null, location: null, grade: null, roles: ["EMPLOYEE"], primary_role: "EMPLOYEE" } });
    if (path === "/me/access-state") return json({ access_status: "DASHBOARD_ALLOWED", pending_count: 0, next_action: "", queue: [] });
    if (path === `/me/pre-tests/${ENROLMENT}`)
      return json({ enrolment_id: ENROLMENT, training_title: "Synthetic training", training_description: null, available: true, question_count: 2, duration_seconds: 900, violation_limit: 3, require_fullscreen: false, active_attempt_id: ATTEMPT });
    if (path === `/attempts/${ATTEMPT}` && request.method() === "GET") return json(this.attempt());
    const save = path.match(/^\/attempts\/[^/]+\/questions\/([^/]+)\/answer$/);
    if (save) {
      const body = request.postDataJSON();
      this.saves.push({ question: save[1], body });
      if (this.saveMode === "hang") return; // Never answered.
      if (this.saveMode === "html") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Proxy</title><p>Please sign in to the network.</p>" });
      return this.cas(save[1], body, json);
    }
    if (path === `/attempts/${ATTEMPT}/submit`) {
      if (this.submitMode === "hang") return;
      return json({ attempt_id: ATTEMPT });
    }
    if (path === `/attempts/${ATTEMPT}/result`) {
      if (this.resultMode === "hang") return;
      return json({ attempt_id: ATTEMPT });
    }
    if (path === "/system/ping") return json({ ok: true });
    return json({ code: "NOT_FOUND", message: "Not mocked." }, 404);
  }

  private cas(question: string, body: { selected_option_ids: string[]; base_revision?: number; op_id?: string }, json: (data: unknown, status?: number) => Promise<void>) {
    const current = this.answers.get(question) ?? { selected: [], revision: 0 };
    const clean = [...new Set(body.selected_option_ids)];
    const ack = () => {
      const a = this.answers.get(question)!;
      return json({ saved_at: new Date().toISOString(), selected_option_ids: a.selected, revision: a.revision, op_id: this.writers.get(question) ?? null });
    };
    if (this.answers.has(question) && current.selected.length === clean.length && clean.every((x) => current.selected.includes(x))) return ack();
    if (body.base_revision !== undefined && body.base_revision !== current.revision)
      return json({ code: "ANSWER_CONFLICT", message: "This answer was changed in another window or on another device. The newer answer is kept.", details: { selected_option_ids: current.selected, revision: current.revision, op_id: this.writers.get(question) ?? null } }, 409);
    this.answers.set(question, { selected: clean, revision: current.revision + 1 });
    this.writers.set(question, body.op_id ?? null);
    return ack();
  }
}

async function prepare(context: BrowserContext, mock: MockApi) {
  await context.addCookies([{ name: "tc_csrf", value: "synthetic", url: test.info().project.use.baseURL ?? "http://localhost:3000" }]);
  await context.route("**/api/v1/**", (route) => mock.handle(route));
}

/** Opens the running attempt and resumes it, as after a refresh or in a second tab. */
async function openExam(page: Page) {
  await page.bringToFront(); // Only the tab in front may enter full screen, as for a person switching tabs.
  await page.goto(`/assessment/pre-test/${ENROLMENT}`);
  await page.getByRole("button", { name: /resume/i }).click();
  await expect(page.locator(".exam-timer")).toBeVisible();
}

const saveLine = (page: Page) => page.locator("#exam-save");
const option = (page: Page, label: string) => page.locator(".exam-option").filter({ hasText: label }).locator("input");

test.describe("answer saving (mocked API)", () => {
  test("an HTTP 200 HTML reply is not a confirmation: the choice stays unsaved until a valid acknowledgement", async ({ context, page }) => {
    const mock = new MockApi(Date.now());
    await prepare(context, mock);
    mock.saveMode = "html";
    await openExam(page);
    await option(page, "Option B").check();
    await expect(saveLine(page)).toContainText("could not read");
    await expect(saveLine(page)).not.toContainText("saved on the server");
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toContain("q1-b");
    mock.saveMode = "ok";
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); // Retry now.
    await expect(saveLine(page)).toContainText("saved on the server");
    expect(mock.answers.get("q1")?.selected).toEqual(["q1-b"]);
  });

  test("full storage: a recovered answer is restored and sent, and not shown as saved before the server confirms it", async ({ context, page }) => {
    const mock = new MockApi(Date.now());
    await prepare(context, mock);
    await page.addInitScript(
      ({ key, account, attempt, expiresAt }) => {
        localStorage.setItem(key, JSON.stringify({ v: 1, account, attempt, expiresAt, entries: [{ q: "q1", s: ["q1-c"], n: 1, b: 0 }] }));
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k: string, v: string) {
          if (k.startsWith("traincheck.")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
          return setItem.call(this, k, v);
        };
      },
      { key: KEY, account: ACCOUNT, attempt: ATTEMPT, expiresAt: mock.expiresAt },
    );
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    await context.route(`**/api/v1/attempts/${ATTEMPT}/questions/q1/answer`, async (route) => {
      await answered; // Held until the page has been checked.
      await mock.handle(route);
    });
    await openExam(page);
    await expect(option(page, "Option C")).toBeChecked();
    await expect(saveLine(page)).toContainText("Saving");
    await expect(saveLine(page)).not.toContainText("saved on the server");
    release();
    await expect(saveLine(page)).toContainText("saved on the server");
    expect(mock.saves[0].body).toMatchObject({ selected_option_ids: ["q1-c"], base_revision: 0 });
    expect(mock.saves[0].body.op_id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull(); // Cleaned up although writes fail.
  });

  test("a save that never replies times out, stays unconfirmed, and is retried", async ({ context, page }) => {
    const mock = new MockApi(Date.now());
    await prepare(context, mock);
    await page.clock.install();
    mock.saveMode = "hang";
    await openExam(page);
    await option(page, "Option A").check();
    await expect(saveLine(page)).toContainText("Saving");
    await page.clock.fastForward(15_200); // Past the 15 s save timeout, before the backoff retry.
    await expect(saveLine(page)).toContainText("did not reply in time");
    await expect(saveLine(page)).not.toContainText("saved on the server");
    // A retry may already be hanging too (the connection heartbeat triggers one); it times out the same way.
    mock.saveMode = "ok";
    await page.clock.fastForward(16_000);
    await expect(saveLine(page)).toContainText("saved on the server");
    expect(mock.saves.length).toBeGreaterThanOrEqual(2);
    expect(mock.answers.get("q1")).toEqual({ selected: ["q1-a"], revision: 1 });
  });

  test("timeout during submission: the dialog leaves its loading state, keeps the answers, and Try again is safe", async ({ context, page }) => {
    const mock = new MockApi(Date.now());
    await prepare(context, mock);
    await page.clock.install();
    await openExam(page);
    await option(page, "Option A").check();
    await expect(saveLine(page)).toContainText("saved on the server");
    mock.submitMode = "hang";
    await page.getByRole("button", { name: "Review & submit" }).click();
    await page.getByRole("button", { name: "Submit assessment" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Submit assessment" }).click();
    await expect(dialog.getByRole("button", { name: /Saving and submitting/ })).toBeVisible();
    await page.clock.fastForward(21_000);
    await expect(dialog).toContainText("did not confirm the submission");
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeEnabled();
    mock.submitMode = "ok";
    await dialog.getByRole("button", { name: "Try again" }).click();
    await page.waitForURL(/\/results\//);
  });

  test("timeout during result loading: recovery controls appear although the request never settles", async ({ context, page }) => {
    const mock = new MockApi(Date.now(), 20_000);
    await prepare(context, mock);
    await page.clock.install();
    mock.resultMode = "hang";
    await openExam(page);
    await page.clock.fastForward(21_000);
    const dialog = page.getByRole("dialog", { name: "Time is up" });
    await expect(dialog).toContainText("loading your result");
    await page.clock.fastForward(61_000);
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Go to my result" })).toBeVisible();
    expect(mock.saves).toHaveLength(0); // Nothing was sent after the deadline.
  });

  test("two tabs: the older tab cannot overwrite the newer answer and shows it instead", async ({ context }) => {
    const mock = new MockApi(Date.now());
    await prepare(context, mock);
    const older = await context.newPage();
    const newer = await context.newPage();
    await openExam(older);
    await openExam(newer);
    await option(newer, "Option B").check();
    await expect(saveLine(newer)).toContainText("saved on the server");
    // Chosen without seeing the other tab's answer. A click, not check(): the page replaces it at once.
    await option(older, "Option A").click();
    await expect(option(older, "Option B")).toBeChecked();
    await expect(older.getByText(/answered in another window or on another device/).first()).toBeVisible();
    expect(mock.answers.get("q1")).toEqual({ selected: ["q1-b"], revision: 1 });
    await option(older, "Option C").check(); // A deliberate new choice after seeing it is accepted.
    await expect(saveLine(older)).toContainText("saved on the server");
    expect(mock.answers.get("q1")).toEqual({ selected: ["q1-c"], revision: 2 });
  });
});
