/* Question Bank by training and test: the links between the cards, a training's pre-test or post-test table and
   the Import Centre, and the test type a new question is linked for. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { filterTrainings } from "@/features/admin/completionView";
import { contextTestTypes, importQuestionsHref, linkedTestType, questionBankHref, questionCardsHref, questionTableHref, testSlug, testTypeFromSlug } from "@/features/admin/questionBankView";

const ID = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

test("each test type has its own URL segment, and only those two are recognised", () => {
  assert.equal(testSlug("PRE_TEST"), "pre-test");
  assert.equal(testSlug("POST_TEST"), "post-test");
  assert.equal(testTypeFromSlug("pre-test"), "PRE_TEST");
  assert.equal(testTypeFromSlug("POST-TEST"), "POST_TEST");
  for (const unknown of ["", "pretest", "PRE_TEST", "mid-test", null, undefined]) assert.equal(testTypeFromSlug(unknown), null);
});

test("the cards page keeps the training search for Back to Trainings", () => {
  assert.equal(questionCardsHref(), "/lnd/questions");
  assert.equal(questionCardsHref("   "), "/lnd/questions");
  assert.equal(questionCardsHref(" Product & Sales "), "/lnd/questions?q=Product+%26+Sales");
});

test("a card opens that training's test, carrying the card search", () => {
  assert.equal(questionTableHref(ID, "PRE_TEST"), `/lnd/questions/${ID}/pre-test`);
  assert.equal(questionTableHref(ID, "POST_TEST", "hr"), `/lnd/questions/${ID}/post-test?q=hr`);
  assert.notEqual(questionTableHref(ID, "PRE_TEST"), questionTableHref(ID, "POST_TEST"));
});

test("Import Questions pre-selects the question import, training and test", () => {
  const url = new URL(importQuestionsHref(ID, "POST_TEST"), "http://x");
  assert.equal(url.pathname, "/lnd/imports");
  assert.deepEqual(Object.fromEntries(url.searchParams), { type: "QUESTIONS", training_id: ID, test_type: "POST_TEST" });
  assert.equal(linkedTestType("PRE_TEST"), "PRE_TEST");
  assert.equal(linkedTestType("post_test"), "");
  assert.equal(linkedTestType(null), "");
});

test("links from imports open the exact table, or the training's cards when the test is not recorded", () => {
  assert.equal(questionBankHref({ id: ID, title: "HR" }, "PRE_TEST"), `/lnd/questions/${ID}/pre-test`);
  assert.equal(questionBankHref({ id: ID, title: "HR" }, null), "/lnd/questions?q=HR");
});

test("a question added from a training's test is linked for that test only, if that training stays ticked", () => {
  const context = { trainingId: ID, testType: "PRE_TEST" };
  assert.deepEqual(contextTestTypes(context, [ID, OTHER]), { [ID]: "PRE_TEST" });
  assert.deepEqual(contextTestTypes(context, [OTHER]), {});
  assert.deepEqual(contextTestTypes(null, [ID]), {});
});

test("the card search matches training names, keeping both tests of a matching training", () => {
  const cards = [
    { training_id: ID, title: "HR Policies", test_type: "PRE_TEST" },
    { training_id: ID, title: "HR Policies", test_type: "POST_TEST" },
    { training_id: OTHER, title: "Product Basics", test_type: "PRE_TEST" },
  ];
  assert.deepEqual(filterTrainings(cards, "hr").map((c) => c.test_type), ["PRE_TEST", "POST_TEST"]);
  assert.equal(filterTrainings(cards, "").length, 3);
  assert.equal(filterTrainings(cards, "zzz").length, 0);
});
